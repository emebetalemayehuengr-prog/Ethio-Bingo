import os
import sys
import asyncio
import traceback
from http import HTTPStatus
from pathlib import Path
from urllib.parse import quote

# Startup-safe defaults for HahuCloud
os.environ.setdefault("APP_ENV", "production")
os.environ.setdefault("ALLOW_EPHEMERAL_DB", "true")
os.environ.setdefault("PERSISTENT_SQLITE_ROOTS", "/var/data,/home")
os.environ.setdefault("ENABLE_SIMULATED_ACTIVITY", "false")

ROOT = Path(__file__).resolve().parent
if str(ROOT) not in sys.path:
    sys.path.insert(0, str(ROOT))

from app.main import app as asgi_app


def _headers_from_environ(environ):
    headers = []
    for k, v in environ.items():
        if k.startswith("HTTP_"):
            name = k[5:].replace("_", "-").lower().encode("latin-1")
            headers.append((name, str(v).encode("latin-1")))
    if environ.get("CONTENT_TYPE"):
        headers.append((b"content-type", environ["CONTENT_TYPE"].encode("latin-1")))
    if environ.get("CONTENT_LENGTH"):
        headers.append((b"content-length", environ["CONTENT_LENGTH"].encode("latin-1")))
    return headers


async def _run_asgi(scope, body):
    started = {"status": 500, "headers": []}
    chunks = []
    sent = False

    async def receive():
        nonlocal sent
        if sent:
            return {"type": "http.disconnect"}
        sent = True
        return {"type": "http.request", "body": body, "more_body": False}

    async def send(message):
        if message["type"] == "http.response.start":
            started["status"] = int(message["status"])
            started["headers"] = message.get("headers", [])
        elif message["type"] == "http.response.body":
            chunk = message.get("body", b"")
            if chunk:
                chunks.append(chunk)

    await asgi_app(scope, receive, send)
    return started["status"], started["headers"], b"".join(chunks)


def application(environ, start_response):
    try:
        try:
            length = int(environ.get("CONTENT_LENGTH") or "0")
        except ValueError:
            length = 0
        body = environ["wsgi.input"].read(length) if length > 0 else b""

        path = environ.get("PATH_INFO") or "/"
        scope = {
            "type": "http",
            "asgi": {"version": "3.0"},
            "http_version": (environ.get("SERVER_PROTOCOL", "HTTP/1.1").replace("HTTP/", "")),
            "method": environ.get("REQUEST_METHOD", "GET"),
            "scheme": environ.get("wsgi.url_scheme", "https"),
            "path": path,
            "raw_path": quote(path, safe="/%").encode("ascii", "ignore"),
            "query_string": (environ.get("QUERY_STRING", "") or "").encode("ascii", "ignore"),
            "headers": _headers_from_environ(environ),
            "client": (environ.get("REMOTE_ADDR", ""), int(environ.get("REMOTE_PORT") or "0")),
            "server": (environ.get("SERVER_NAME", ""), int(environ.get("SERVER_PORT") or "443")),
        }

        status_code, asgi_headers, response_body = asyncio.run(_run_asgi(scope, body))
        reason = HTTPStatus(status_code).phrase if status_code in HTTPStatus._value2member_map_ else "OK"
        headers = [(k.decode("latin-1"), v.decode("latin-1")) for k, v in asgi_headers]
        if not any(k.lower() == "content-length" for k, _ in headers):
            headers.append(("Content-Length", str(len(response_body))))

        start_response(f"{status_code} {reason}", headers)
        return [response_body]

    except Exception:
        err = traceback.format_exc().encode("utf-8", "replace")
        start_response(
            "500 Internal Server Error",
            [("Content-Type", "text/plain; charset=utf-8"), ("Content-Length", str(len(err)))],
        )
        return [err]
