#!/usr/bin/env python3
"""Quick SMTP auth + send probe using production env vars."""

from __future__ import annotations

import argparse
import os
import smtplib
import ssl
import sys
from email.message import EmailMessage


def env_flag(name: str, default: bool) -> bool:
    raw = os.getenv(name)
    if raw is None:
        return default
    return raw.strip().lower() in {"1", "true", "yes", "on"}


def resolve_smtp_config(overrides: dict[str, object]) -> dict[str, object]:
    smtp_host = str(overrides.get("host") or os.getenv("SMTP_HOST", "").strip())
    smtp_use_ssl = bool(overrides.get("use_ssl")) if overrides.get("use_ssl") is not None else env_flag("SMTP_USE_SSL", False)
    raw_port = str(overrides.get("port") or os.getenv("SMTP_PORT", "").strip())
    if raw_port:
        try:
            smtp_port = int(raw_port)
        except ValueError:
            smtp_port = 465 if smtp_use_ssl else 587
    else:
        smtp_port = 465 if smtp_use_ssl else 587

    smtp_use_tls = bool(overrides.get("use_tls")) if overrides.get("use_tls") is not None else env_flag("SMTP_USE_TLS", True)
    smtp_username = str(overrides.get("username") or os.getenv("SMTP_USERNAME", "").strip())
    smtp_password = str(overrides.get("password") or os.getenv("SMTP_PASSWORD", "").strip())
    smtp_from = str(overrides.get("from_email") or os.getenv("SMTP_FROM", "").strip() or smtp_username or "noreply@40bingo.local")

    return {
        "host": smtp_host,
        "port": smtp_port,
        "use_ssl": smtp_use_ssl,
        "use_tls": smtp_use_tls,
        "username": smtp_username,
        "password": smtp_password,
        "from_email": smtp_from,
    }


def main() -> int:
    parser = argparse.ArgumentParser(description="SMTP probe for Ethio-Bingo backend env config.")
    parser.add_argument("--to", required=True, help="Recipient email for live delivery test.")
    parser.add_argument("--subject", default="40Bingo SMTP probe", help="Email subject.")
    parser.add_argument("--host", help="SMTP host override (else SMTP_HOST env).")
    parser.add_argument("--port", type=int, help="SMTP port override (else SMTP_PORT env/default).")
    parser.add_argument("--username", help="SMTP username override (else SMTP_USERNAME env).")
    parser.add_argument("--password", help="SMTP password override (else SMTP_PASSWORD env).")
    parser.add_argument("--from-email", help="From address override (else SMTP_FROM env).")
    parser.add_argument("--ssl", action="store_true", help="Use implicit SSL (SMTPS).")
    parser.add_argument("--no-ssl", action="store_true", help="Disable implicit SSL.")
    parser.add_argument("--tls", action="store_true", help="Use STARTTLS (plain SMTP only).")
    parser.add_argument("--no-tls", action="store_true", help="Disable STARTTLS.")
    args = parser.parse_args()

    if args.ssl and args.no_ssl:
        print("SMTP_FAIL: cannot pass both --ssl and --no-ssl")
        return 1
    if args.tls and args.no_tls:
        print("SMTP_FAIL: cannot pass both --tls and --no-tls")
        return 1

    use_ssl_override: bool | None = None
    if args.ssl:
        use_ssl_override = True
    elif args.no_ssl:
        use_ssl_override = False

    use_tls_override: bool | None = None
    if args.tls:
        use_tls_override = True
    elif args.no_tls:
        use_tls_override = False

    cfg = resolve_smtp_config(
        {
            "host": args.host,
            "port": args.port,
            "username": args.username,
            "password": args.password,
            "from_email": args.from_email,
            "use_ssl": use_ssl_override,
            "use_tls": use_tls_override,
        }
    )

    missing = [key for key in ("host", "username", "password", "from_email") if not cfg[key]]
    if missing:
        print(f"SMTP_FAIL: missing required env vars: {', '.join(missing)}")
        return 1

    print(
        "SMTP_CONFIG: "
        f"host={cfg['host']} port={cfg['port']} ssl={cfg['use_ssl']} tls={cfg['use_tls']} "
        f"user={cfg['username']} from={cfg['from_email']}"
    )

    msg = EmailMessage()
    msg["From"] = str(cfg["from_email"])
    msg["To"] = args.to
    msg["Subject"] = args.subject
    msg.set_content("SMTP probe from Ethio-Bingo backend.")

    try:
        tls_context = ssl.create_default_context()
        if bool(cfg["use_ssl"]):
            with smtplib.SMTP_SSL(str(cfg["host"]), int(cfg["port"]), timeout=20) as smtp:
                smtp.ehlo()
                smtp.login(str(cfg["username"]), str(cfg["password"]))
                refused = smtp.send_message(msg)
        else:
            with smtplib.SMTP(str(cfg["host"]), int(cfg["port"]), timeout=20) as smtp:
                smtp.ehlo()
                if bool(cfg["use_tls"]):
                    smtp.starttls(context=tls_context)
                    smtp.ehlo()
                smtp.login(str(cfg["username"]), str(cfg["password"]))
                refused = smtp.send_message(msg)

        if isinstance(refused, dict) and refused:
            print(f"SMTP_FAIL: recipient(s) refused: {', '.join(refused.keys())}")
            return 1

        print("SMTP_OK: auth + send succeeded")
        return 0
    except Exception as exc:  # pragma: no cover - runtime probe path
        print(f"SMTP_FAIL: {type(exc).__name__}: {exc}")
        return 1


if __name__ == "__main__":
    sys.exit(main())
