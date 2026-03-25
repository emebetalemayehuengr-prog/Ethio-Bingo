from __future__ import annotations

import json
import sqlite3
from datetime import datetime, timezone
import hashlib
from pathlib import Path
from typing import Any

try:
    import psycopg
    from psycopg.rows import dict_row
    from psycopg.types.json import Jsonb
except Exception:  # pragma: no cover - optional dependency unless DATABASE_URL is set
    psycopg = None
    dict_row = None
    Jsonb = None


def _split_sql_statements(sql: str) -> list[str]:
    statements: list[str] = []
    current: list[str] = []
    in_single = False
    in_double = False
    escape = False

    for ch in sql:
        if escape:
            current.append(ch)
            escape = False
            continue
        if ch == "\\":
            current.append(ch)
            escape = True
            continue
        if ch == "'" and not in_double:
            in_single = not in_single
            current.append(ch)
            continue
        if ch == '"' and not in_single:
            in_double = not in_double
            current.append(ch)
            continue
        if ch == ";" and not in_single and not in_double:
            statement = "".join(current).strip()
            if statement:
                statements.append(statement)
            current = []
            continue
        current.append(ch)

    tail = "".join(current).strip()
    if tail:
        statements.append(tail)
    return statements


def _utc_now_iso() -> str:
    return datetime.now(timezone.utc).replace(microsecond=0).isoformat()


class PostgresStateStore:
    def __init__(self, dsn: str) -> None:
        self.dsn = dsn.strip()

    def enabled(self) -> bool:
        return bool(self.dsn)

    def ensure_schema(self) -> None:
        if not self.enabled():
            return
        if psycopg is None:
            raise RuntimeError(
                "psycopg is not installed. Install backend requirements in the app virtualenv."
            )
        with psycopg.connect(self.dsn, prepare_threshold=None) as conn:
            with conn.cursor() as cur:
                schema_sql = """
                    CREATE TABLE IF NOT EXISTS users (
                        phone_number TEXT PRIMARY KEY,
                        user_name TEXT NOT NULL,
                        password_hash TEXT NOT NULL,
                        referral_code TEXT NOT NULL,
                        is_admin BOOLEAN NOT NULL DEFAULT FALSE,
                        telegram_id BIGINT UNIQUE NULL,
                        telegram_username TEXT NULL
                    );
                    CREATE TABLE IF NOT EXISTS wallets (
                        phone_number TEXT PRIMARY KEY REFERENCES users(phone_number) ON DELETE CASCADE,
                        main_balance NUMERIC(18,2) NOT NULL DEFAULT 0,
                        bonus_balance NUMERIC(18,2) NOT NULL DEFAULT 0
                    );
                    CREATE TABLE IF NOT EXISTS sessions (
                        token TEXT PRIMARY KEY,
                        phone_number TEXT NOT NULL REFERENCES users(phone_number) ON DELETE CASCADE,
                        created_at TEXT NULL,
                        expires_at TEXT NULL
                    );
                    CREATE TABLE IF NOT EXISTS transactions (
                        id BIGSERIAL PRIMARY KEY,
                        phone_number TEXT NOT NULL REFERENCES users(phone_number) ON DELETE CASCADE,
                        type TEXT NOT NULL,
                        amount NUMERIC(18,2) NOT NULL,
                        status TEXT NOT NULL,
                        created_at TEXT NOT NULL
                    );
                    CREATE TABLE IF NOT EXISTS bet_history (
                        id TEXT PRIMARY KEY,
                        phone_number TEXT NOT NULL REFERENCES users(phone_number) ON DELETE CASCADE,
                        stake INTEGER NOT NULL,
                        game_winning NUMERIC(18,2) NOT NULL,
                        winner_cards JSONB NOT NULL,
                        your_cards JSONB NOT NULL,
                        date TEXT NOT NULL,
                        result TEXT NOT NULL,
                        payout NUMERIC(18,2) NOT NULL DEFAULT 0,
                        called_numbers JSONB NOT NULL,
                        preview_card JSONB NULL
                    );
                    CREATE TABLE IF NOT EXISTS rooms (
                        stake_id TEXT PRIMARY KEY,
                        room_id TEXT NOT NULL,
                        stake INTEGER NOT NULL,
                        card_price INTEGER NOT NULL,
                        players_seed INTEGER NOT NULL,
                        started_at TEXT NOT NULL,
                        called_sequence JSONB NOT NULL,
                        ended_at TEXT NULL,
                        winner_phone TEXT NULL,
                        winner_cartella INTEGER NULL,
                        winner_payout NUMERIC(18,2) NULL,
                        house_commission NUMERIC(18,2) NULL,
                        claim_window_ends_at TEXT NULL,
                        claim_window_reference_time TEXT NULL,
                        result_until TEXT NULL
                    );
                    CREATE TABLE IF NOT EXISTS room_cards (
                        id BIGSERIAL PRIMARY KEY,
                        stake_id TEXT NOT NULL REFERENCES rooms(stake_id) ON DELETE CASCADE,
                        queue TEXT NOT NULL,
                        cartella_no INTEGER NOT NULL,
                        phone_number TEXT NULL REFERENCES users(phone_number) ON DELETE SET NULL,
                        held_updated_at TEXT NULL
                    );
                    CREATE UNIQUE INDEX IF NOT EXISTS uq_room_cards_slot ON room_cards(stake_id, queue, cartella_no);
                    CREATE TABLE IF NOT EXISTS room_marks (
                        id BIGSERIAL PRIMARY KEY,
                        stake_id TEXT NOT NULL REFERENCES rooms(stake_id) ON DELETE CASCADE,
                        phone_number TEXT NOT NULL REFERENCES users(phone_number) ON DELETE CASCADE,
                        cartella_no INTEGER NOT NULL,
                        marks JSONB NOT NULL
                    );
                    CREATE UNIQUE INDEX IF NOT EXISTS uq_room_marks_owner_card ON room_marks(stake_id, phone_number, cartella_no);
                    CREATE TABLE IF NOT EXISTS room_claims (
                        id BIGSERIAL PRIMARY KEY,
                        stake_id TEXT NOT NULL REFERENCES rooms(stake_id) ON DELETE CASCADE,
                        phone_number TEXT NOT NULL REFERENCES users(phone_number) ON DELETE CASCADE,
                        cartella_no INTEGER NOT NULL,
                        claimed_at TEXT NOT NULL
                    );
                    CREATE TABLE IF NOT EXISTS room_winners (
                        id BIGSERIAL PRIMARY KEY,
                        stake_id TEXT NOT NULL REFERENCES rooms(stake_id) ON DELETE CASCADE,
                        phone_number TEXT NOT NULL REFERENCES users(phone_number) ON DELETE CASCADE,
                        user_name TEXT NOT NULL,
                        cartella_no INTEGER NOT NULL,
                        payout NUMERIC(18,2) NOT NULL,
                        card JSONB NOT NULL,
                        position INTEGER NOT NULL DEFAULT 0
                    );
                    CREATE TABLE IF NOT EXISTS receipt_reservations (
                        tx_number TEXT PRIMARY KEY,
                        phone_number TEXT NOT NULL REFERENCES users(phone_number) ON DELETE CASCADE
                    );
                    CREATE TABLE IF NOT EXISTS receipt_links (
                        link_key TEXT PRIMARY KEY,
                        phone_number TEXT NOT NULL REFERENCES users(phone_number) ON DELETE CASCADE
                    );
                    CREATE TABLE IF NOT EXISTS withdraw_requests (
                        id TEXT PRIMARY KEY,
                        phone_number TEXT NOT NULL REFERENCES users(phone_number) ON DELETE CASCADE,
                        user_name TEXT NOT NULL,
                        bank TEXT NOT NULL,
                        account_number TEXT NOT NULL,
                        account_holder TEXT NOT NULL,
                        amount NUMERIC(18,2) NOT NULL,
                        status TEXT NOT NULL,
                        created_at TEXT NOT NULL,
                        reviewed_at TEXT NULL,
                        reviewed_by TEXT NULL,
                        processing_at TEXT NULL,
                        processing_by TEXT NULL,
                        paid_at TEXT NULL,
                        paid_by TEXT NULL,
                        payout_reference TEXT NULL,
                        admin_note TEXT NULL
                    );
                    CREATE TABLE IF NOT EXISTS deposit_methods (
                        code TEXT PRIMARY KEY,
                        label TEXT NOT NULL,
                        logo_url TEXT NULL,
                        instruction_steps JSONB NOT NULL,
                        receipt_example TEXT NOT NULL
                    );
                    CREATE TABLE IF NOT EXISTS deposit_accounts (
                        id BIGSERIAL PRIMARY KEY,
                        method_code TEXT NOT NULL REFERENCES deposit_methods(code) ON DELETE CASCADE,
                        phone_number TEXT NOT NULL,
                        owner_name TEXT NOT NULL,
                        position INTEGER NOT NULL DEFAULT 0
                    );
                    CREATE UNIQUE INDEX IF NOT EXISTS uq_deposit_accounts_method_position ON deposit_accounts(method_code, position);
                    CREATE TABLE IF NOT EXISTS audit_events (
                        id TEXT PRIMARY KEY,
                        event_type TEXT NOT NULL,
                        created_at TEXT NOT NULL,
                        phone_number TEXT NOT NULL,
                        amount NUMERIC(18,2) NOT NULL,
                        status TEXT NOT NULL,
                        method TEXT NULL,
                        transaction_number TEXT NULL,
                        withdraw_ticket_id TEXT NULL,
                        bank TEXT NULL,
                        account_number TEXT NULL,
                        account_holder TEXT NULL,
                        actor_phone TEXT NULL,
                        note TEXT NULL
                    );
                """
                for stmt in _split_sql_statements(schema_sql):
                    cur.execute(stmt)
                cur.execute("ALTER TABLE withdraw_requests ADD COLUMN IF NOT EXISTS processing_at TEXT NULL")
                cur.execute("ALTER TABLE withdraw_requests ADD COLUMN IF NOT EXISTS processing_by TEXT NULL")
                cur.execute("ALTER TABLE withdraw_requests ADD COLUMN IF NOT EXISTS paid_at TEXT NULL")
                cur.execute("ALTER TABLE withdraw_requests ADD COLUMN IF NOT EXISTS paid_by TEXT NULL")
                cur.execute("ALTER TABLE withdraw_requests ADD COLUMN IF NOT EXISTS payout_reference TEXT NULL")
                cur.execute("ALTER TABLE withdraw_requests ADD COLUMN IF NOT EXISTS admin_note TEXT NULL")
                cur.execute("ALTER TABLE sessions ADD COLUMN IF NOT EXISTS created_at TEXT NULL")
                cur.execute("ALTER TABLE sessions ADD COLUMN IF NOT EXISTS expires_at TEXT NULL")
            conn.commit()

    def is_empty(self) -> bool:
        if not self.enabled():
            return True
        with psycopg.connect(self.dsn, row_factory=dict_row, prepare_threshold=None) as conn:
            with conn.cursor() as cur:
                row = cur.execute("SELECT COUNT(*) AS cnt FROM users").fetchone()
                return int(row["cnt"]) == 0 if row else True

    def load_all(self) -> dict[str, Any]:
        if not self.enabled():
            return {
                "users": None,
                "sessions": None,
                "rooms": None,
                "used_deposit_tx": None,
                "used_receipt_links": None,
                "withdraw_tickets": None,
                "deposit_methods": None,
                "audit_events": None,
            }

        state: dict[str, Any] = {
            "users": {},
            "sessions": {},
            "rooms": {},
            "used_deposit_tx": {},
            "used_receipt_links": {},
            "withdraw_tickets": [],
            "deposit_methods": [],
            "audit_events": [],
        }

        with psycopg.connect(self.dsn, row_factory=dict_row, prepare_threshold=None) as conn:
            with conn.cursor() as cur:
                users = cur.execute("SELECT * FROM users ORDER BY phone_number ASC").fetchall()
                for row in users:
                    phone = str(row["phone_number"])
                    wallet = cur.execute(
                        "SELECT main_balance, bonus_balance FROM wallets WHERE phone_number = %s",
                        (phone,),
                    ).fetchone()
                    tx_rows = cur.execute(
                        "SELECT type, amount, status, created_at FROM transactions WHERE phone_number = %s ORDER BY id DESC",
                        (phone,),
                    ).fetchall()
                    bet_rows = cur.execute(
                        """
                        SELECT id, stake, game_winning, winner_cards, your_cards, date, result, payout, called_numbers, preview_card
                        FROM bet_history
                        WHERE phone_number = %s
                        ORDER BY date DESC
                        """,
                        (phone,),
                    ).fetchall()
                    state["users"][phone] = {
                        "user_name": str(row["user_name"]),
                        "phone_number": phone,
                        "password_hash": str(row["password_hash"]),
                        "referral_code": str(row["referral_code"]),
                        "is_admin": bool(row["is_admin"]),
                        "telegram_id": int(row["telegram_id"]) if row["telegram_id"] is not None else None,
                        "telegram_username": str(row["telegram_username"]) if row["telegram_username"] is not None else None,
                        "wallet": {
                            "main_balance": float(wallet["main_balance"]) if wallet else 0.0,
                            "bonus_balance": float(wallet["bonus_balance"]) if wallet else 0.0,
                            "currency": "ETB",
                        },
                        "history": [
                            {
                                "type": str(tx["type"]),
                                "amount": float(tx["amount"]),
                                "status": str(tx["status"]),
                                "created_at": str(tx["created_at"]),
                            }
                            for tx in tx_rows
                        ],
                        "bet_history": [
                            {
                                "id": str(bet["id"]),
                                "stake": int(bet["stake"]),
                                "game_winning": float(bet["game_winning"]),
                                "winner_cards": list(bet["winner_cards"] or []),
                                "your_cards": list(bet["your_cards"] or []),
                                "date": str(bet["date"]),
                                "result": str(bet["result"]),
                                "payout": float(bet["payout"]),
                                "called_numbers": list(bet["called_numbers"] or []),
                                "preview_card": bet["preview_card"],
                            }
                            for bet in bet_rows
                        ],
                        "joined_rooms": {},
                    }

                for session in cur.execute("SELECT token, phone_number, created_at, expires_at FROM sessions").fetchall():
                    phone = str(session["phone_number"])
                    if phone in state["users"]:
                        state["sessions"][str(session["token"])] = {
                            "phone_number": phone,
                            "created_at": str(session["created_at"]) if session["created_at"] is not None else None,
                            "expires_at": str(session["expires_at"]) if session["expires_at"] is not None else None,
                        }

                for row in cur.execute("SELECT tx_number, phone_number FROM receipt_reservations").fetchall():
                    state["used_deposit_tx"][str(row["tx_number"])] = str(row["phone_number"])

                for row in cur.execute("SELECT link_key, phone_number FROM receipt_links").fetchall():
                    state["used_receipt_links"][str(row["link_key"])] = str(row["phone_number"])

                state["withdraw_tickets"] = [
                    {
                        "id": str(row["id"]),
                        "phone_number": str(row["phone_number"]),
                        "user_name": str(row["user_name"]),
                        "bank": str(row["bank"]),
                        "account_number": str(row["account_number"]),
                        "account_holder": str(row["account_holder"]),
                        "amount": float(row["amount"]),
                        "status": str(row["status"]),
                        "created_at": str(row["created_at"]),
                        "reviewed_at": str(row["reviewed_at"]) if row["reviewed_at"] is not None else None,
                        "reviewed_by": str(row["reviewed_by"]) if row["reviewed_by"] is not None else None,
                        "processing_at": str(row["processing_at"]) if row["processing_at"] is not None else None,
                        "processing_by": str(row["processing_by"]) if row["processing_by"] is not None else None,
                        "paid_at": str(row["paid_at"]) if row["paid_at"] is not None else None,
                        "paid_by": str(row["paid_by"]) if row["paid_by"] is not None else None,
                        "payout_reference": str(row["payout_reference"]) if row["payout_reference"] is not None else None,
                        "admin_note": str(row["admin_note"]) if row["admin_note"] is not None else None,
                    }
                    for row in cur.execute("SELECT * FROM withdraw_requests ORDER BY created_at DESC").fetchall()
                ]
                methods = cur.execute("SELECT * FROM deposit_methods ORDER BY code ASC").fetchall()
                for method in methods:
                    accounts = cur.execute(
                        "SELECT phone_number, owner_name FROM deposit_accounts WHERE method_code = %s ORDER BY position ASC",
                        (method["code"],),
                    ).fetchall()
                    state["deposit_methods"].append(
                        {
                            "code": str(method["code"]),
                            "label": str(method["label"]),
                            "logo_url": str(method["logo_url"]) if method["logo_url"] is not None else None,
                            "instruction_steps": [str(x) for x in (method["instruction_steps"] or [])],
                            "receipt_example": str(method["receipt_example"]),
                            "transfer_accounts": [
                                {
                                    "phone_number": str(account["phone_number"]),
                                    "owner_name": str(account["owner_name"]),
                                }
                                for account in accounts
                            ],
                        }
                    )
                state["audit_events"] = [
                    {
                        "id": str(row["id"]),
                        "event_type": str(row["event_type"]),
                        "created_at": str(row["created_at"]),
                        "phone_number": str(row["phone_number"]),
                        "amount": float(row["amount"]),
                        "status": str(row["status"]),
                        "method": str(row["method"]) if row["method"] is not None else None,
                        "transaction_number": str(row["transaction_number"]) if row["transaction_number"] is not None else None,
                        "withdraw_ticket_id": str(row["withdraw_ticket_id"]) if row["withdraw_ticket_id"] is not None else None,
                        "bank": str(row["bank"]) if row["bank"] is not None else None,
                        "account_number": str(row["account_number"]) if row["account_number"] is not None else None,
                        "account_holder": str(row["account_holder"]) if row["account_holder"] is not None else None,
                        "actor_phone": str(row["actor_phone"]) if row["actor_phone"] is not None else None,
                        "note": str(row["note"]) if row["note"] is not None else None,
                    }
                    for row in cur.execute("SELECT * FROM audit_events ORDER BY created_at DESC").fetchall()
                ]

                rooms = cur.execute("SELECT * FROM rooms ORDER BY stake_id ASC").fetchall()
                for room in rooms:
                    stake_id = str(room["stake_id"])
                    cards = cur.execute(
                        "SELECT queue, cartella_no, phone_number, held_updated_at FROM room_cards WHERE stake_id = %s",
                        (stake_id,),
                    ).fetchall()
                    marks = cur.execute(
                        "SELECT phone_number, cartella_no, marks FROM room_marks WHERE stake_id = %s",
                        (stake_id,),
                    ).fetchall()
                    claims = cur.execute(
                        "SELECT phone_number, cartella_no, claimed_at FROM room_claims WHERE stake_id = %s ORDER BY id ASC",
                        (stake_id,),
                    ).fetchall()
                    winners = cur.execute(
                        "SELECT phone_number, user_name, cartella_no, payout, card FROM room_winners WHERE stake_id = %s ORDER BY position ASC",
                        (stake_id,),
                    ).fetchall()

                    taken_cartellas: dict[int, str] = {}
                    held_cartellas: dict[int, str] = {}
                    held_updated_at: dict[int, str] = {}
                    next_taken_cartellas: dict[int, str] = {}
                    next_held_cartellas: dict[int, str] = {}
                    next_held_updated_at: dict[int, str] = {}

                    for card in cards:
                        queue = str(card["queue"])
                        cno = int(card["cartella_no"])
                        owner = str(card["phone_number"]) if card["phone_number"] is not None else ""
                        hold_at = str(card["held_updated_at"]) if card["held_updated_at"] is not None else None
                        if queue == "current_paid" and owner:
                            taken_cartellas[cno] = owner
                        elif queue == "current_held" and owner:
                            held_cartellas[cno] = owner
                            if hold_at:
                                held_updated_at[cno] = hold_at
                        elif queue == "next_paid" and owner:
                            next_taken_cartellas[cno] = owner
                        elif queue == "next_held" and owner:
                            next_held_cartellas[cno] = owner
                            if hold_at:
                                next_held_updated_at[cno] = hold_at

                    state["rooms"][stake_id] = {
                        "id": str(room["room_id"]),
                        "stake_id": stake_id,
                        "stake": int(room["stake"]),
                        "card_price": int(room["card_price"]),
                        "players_seed": int(room["players_seed"]),
                        "started_at": str(room["started_at"]),
                        "called_sequence": [int(x) for x in (room["called_sequence"] or [])],
                        "taken_cartellas": taken_cartellas,
                        "held_cartellas": held_cartellas,
                        "held_updated_at": held_updated_at,
                        "next_taken_cartellas": next_taken_cartellas,
                        "next_held_cartellas": next_held_cartellas,
                        "next_held_updated_at": next_held_updated_at,
                        "marked_by_user_card": {
                            f"{row['phone_number']}:{int(row['cartella_no'])}": [int(v) for v in (row["marks"] or [])]
                            for row in marks
                        },
                        "ended_at": str(room["ended_at"]) if room["ended_at"] is not None else None,
                        "winner_phone": str(room["winner_phone"]) if room["winner_phone"] is not None else None,
                        "winner_cartella": int(room["winner_cartella"]) if room["winner_cartella"] is not None else None,
                        "winner_payout": float(room["winner_payout"]) if room["winner_payout"] is not None else None,
                        "house_commission": float(room["house_commission"]) if room["house_commission"] is not None else None,
                        "pending_claims": [
                            {
                                "phone_number": str(claim["phone_number"]),
                                "cartella_no": int(claim["cartella_no"]),
                                "claimed_at": str(claim["claimed_at"]),
                            }
                            for claim in claims
                        ],
                        "claim_window_ends_at": str(room["claim_window_ends_at"]) if room["claim_window_ends_at"] is not None else None,
                        "claim_window_reference_time": str(room["claim_window_reference_time"]) if room["claim_window_reference_time"] is not None else None,
                        "winners": [
                            {
                                "phone_number": str(winner["phone_number"]),
                                "user_name": str(winner["user_name"]),
                                "cartella_no": int(winner["cartella_no"]),
                                "payout": float(winner["payout"]),
                                "card": winner["card"],
                            }
                            for winner in winners
                        ],
                        "result_until": str(room["result_until"]) if room["result_until"] is not None else None,
                    }

        return state

    def load_user(
        self,
        phone_number: str,
        include_history: bool = True,
        include_bet_history: bool = True,
    ) -> dict[str, Any] | None:
        if not self.enabled():
            return None

        phone = str(phone_number).strip()
        if not phone:
            return None

        with psycopg.connect(self.dsn, row_factory=dict_row, prepare_threshold=None) as conn:
            with conn.cursor() as cur:
                row = cur.execute("SELECT * FROM users WHERE phone_number = %s", (phone,)).fetchone()
                if not row:
                    return None
                wallet = cur.execute(
                    "SELECT main_balance, bonus_balance FROM wallets WHERE phone_number = %s",
                    (phone,),
                ).fetchone()
                tx_rows = []
                if include_history:
                    tx_rows = cur.execute(
                        "SELECT type, amount, status, created_at FROM transactions WHERE phone_number = %s ORDER BY id DESC",
                        (phone,),
                    ).fetchall()
                bet_rows = []
                if include_bet_history:
                    bet_rows = cur.execute(
                        """
                        SELECT id, stake, game_winning, winner_cards, your_cards, date, result, payout, called_numbers, preview_card
                        FROM bet_history
                        WHERE phone_number = %s
                        ORDER BY date DESC
                        """,
                        (phone,),
                    ).fetchall()

        return {
            "user_name": str(row["user_name"]),
            "phone_number": phone,
            "password_hash": str(row["password_hash"]),
            "referral_code": str(row["referral_code"]),
            "is_admin": bool(row["is_admin"]),
            "telegram_id": int(row["telegram_id"]) if row["telegram_id"] is not None else None,
            "telegram_username": str(row["telegram_username"]) if row["telegram_username"] is not None else None,
            "wallet": {
                "main_balance": float(wallet["main_balance"]) if wallet else 0.0,
                "bonus_balance": float(wallet["bonus_balance"]) if wallet else 0.0,
                "currency": "ETB",
            },
            "history": [
                {
                    "type": str(tx["type"]),
                    "amount": float(tx["amount"]),
                    "status": str(tx["status"]),
                    "created_at": str(tx["created_at"]),
                }
                for tx in tx_rows
            ],
            "bet_history": [
                {
                    "id": str(bet["id"]),
                    "stake": int(bet["stake"]),
                    "game_winning": float(bet["game_winning"]),
                    "winner_cards": list(bet["winner_cards"] or []),
                    "your_cards": list(bet["your_cards"] or []),
                    "date": str(bet["date"]),
                    "result": str(bet["result"]),
                    "payout": float(bet["payout"]),
                    "called_numbers": list(bet["called_numbers"] or []),
                    "preview_card": bet["preview_card"],
                }
                for bet in bet_rows
            ],
            "joined_rooms": {},
        }

    def load_user_history(self, phone_number: str, limit: int = 50) -> list[dict[str, Any]]:
        if not self.enabled():
            return []

        phone = str(phone_number).strip()
        if not phone:
            return []

        with psycopg.connect(self.dsn, row_factory=dict_row, prepare_threshold=None) as conn:
            with conn.cursor() as cur:
                rows = cur.execute(
                    "SELECT type, amount, status, created_at FROM transactions WHERE phone_number = %s ORDER BY id DESC LIMIT %s",
                    (phone, int(limit)),
                ).fetchall()
        return [
            {
                "type": str(tx["type"]),
                "amount": float(tx["amount"]),
                "status": str(tx["status"]),
                "created_at": str(tx["created_at"]),
            }
            for tx in rows
        ]

    def load_user_bet_history(self, phone_number: str, limit: int = 100) -> list[dict[str, Any]]:
        if not self.enabled():
            return []

        phone = str(phone_number).strip()
        if not phone:
            return []

        with psycopg.connect(self.dsn, row_factory=dict_row, prepare_threshold=None) as conn:
            with conn.cursor() as cur:
                rows = cur.execute(
                    """
                    SELECT id, stake, game_winning, winner_cards, your_cards, date, result, payout, called_numbers, preview_card
                    FROM bet_history
                    WHERE phone_number = %s
                    ORDER BY date DESC
                    LIMIT %s
                    """,
                    (phone, int(limit)),
                ).fetchall()
        return [
            {
                "id": str(bet["id"]),
                "stake": int(bet["stake"]),
                "game_winning": float(bet["game_winning"]),
                "winner_cards": list(bet["winner_cards"] or []),
                "your_cards": list(bet["your_cards"] or []),
                "date": str(bet["date"]),
                "result": str(bet["result"]),
                "payout": float(bet["payout"]),
                "called_numbers": list(bet["called_numbers"] or []),
                "preview_card": bet["preview_card"],
            }
            for bet in rows
        ]

    def load_session(self, token: str) -> dict[str, str] | None:
        if not self.enabled():
            return None

        clean_token = str(token).strip()
        if not clean_token:
            return None

        with psycopg.connect(self.dsn, row_factory=dict_row, prepare_threshold=None) as conn:
            with conn.cursor() as cur:
                row = cur.execute(
                    "SELECT token, phone_number, created_at, expires_at FROM sessions WHERE token = %s",
                    (clean_token,),
                ).fetchone()
                if not row:
                    return None

        return {
            "phone_number": str(row["phone_number"]),
            "created_at": str(row["created_at"]) if row["created_at"] is not None else None,
            "expires_at": str(row["expires_at"]) if row["expires_at"] is not None else None,
        }

    def adjust_wallet_and_record_transaction(
        self,
        phone_number: str,
        delta: float,
        tx_type: str,
        status: str,
    ) -> float:
        if not self.enabled():
            raise RuntimeError("Postgres store is not enabled")

        phone = str(phone_number).strip()
        amount = round(abs(float(delta)), 2)
        signed_delta = round(float(delta), 2)
        if not phone:
            raise ValueError("invalid_phone")
        if amount <= 0:
            raise ValueError("invalid_amount")

        now_iso = _utc_now_iso()
        with psycopg.connect(self.dsn, prepare_threshold=None) as conn:
            with conn.cursor() as cur:
                cur.execute(
                    """
                    INSERT INTO wallets(phone_number, main_balance, bonus_balance)
                    VALUES (%s, 0, 0)
                    ON CONFLICT(phone_number) DO NOTHING
                    """,
                    (phone,),
                )
                if signed_delta < 0:
                    row = cur.execute(
                        """
                        UPDATE wallets
                        SET main_balance = ROUND(main_balance + %s, 2)
                        WHERE phone_number = %s
                          AND main_balance + %s >= 0
                        RETURNING main_balance
                        """,
                        (signed_delta, phone, signed_delta),
                    ).fetchone()
                    if not row:
                        raise ValueError("insufficient_balance")
                else:
                    row = cur.execute(
                        """
                        UPDATE wallets
                        SET main_balance = ROUND(main_balance + %s, 2)
                        WHERE phone_number = %s
                        RETURNING main_balance
                        """,
                        (signed_delta, phone),
                    ).fetchone()

                cur.execute(
                    """
                    INSERT INTO transactions(phone_number, type, amount, status, created_at)
                    VALUES (%s, %s, %s, %s, %s)
                    """,
                    (phone, tx_type, amount, status, now_iso),
                )
            conn.commit()
        return float(row[0]) if row else 0.0

    def transfer_wallet_balance(self, sender_phone: str, receiver_phone: str, amount: float) -> tuple[float, float]:
        if not self.enabled():
            raise RuntimeError("Postgres store is not enabled")

        sender = str(sender_phone).strip()
        receiver = str(receiver_phone).strip()
        transfer_amount = round(float(amount), 2)
        if not sender or not receiver or sender == receiver:
            raise ValueError("invalid_transfer")
        if transfer_amount <= 0:
            raise ValueError("invalid_amount")

        now_iso = _utc_now_iso()
        lock_first, lock_second = sorted([sender, receiver])

        with psycopg.connect(self.dsn, prepare_threshold=None) as conn:
            with conn.cursor() as cur:
                for phone in (sender, receiver):
                    cur.execute(
                        """
                        INSERT INTO wallets(phone_number, main_balance, bonus_balance)
                        VALUES (%s, 0, 0)
                        ON CONFLICT(phone_number) DO NOTHING
                        """,
                        (phone,),
                    )
                cur.execute(
                    """
                    SELECT phone_number
                    FROM wallets
                    WHERE phone_number IN (%s, %s)
                    ORDER BY phone_number
                    FOR UPDATE
                    """,
                    (lock_first, lock_second),
                )

                sender_row = cur.execute(
                    """
                    UPDATE wallets
                    SET main_balance = ROUND(main_balance - %s, 2)
                    WHERE phone_number = %s
                      AND main_balance >= %s
                    RETURNING main_balance
                    """,
                    (transfer_amount, sender, transfer_amount),
                ).fetchone()
                if not sender_row:
                    raise ValueError("insufficient_balance")

                receiver_row = cur.execute(
                    """
                    UPDATE wallets
                    SET main_balance = ROUND(main_balance + %s, 2)
                    WHERE phone_number = %s
                    RETURNING main_balance
                    """,
                    (transfer_amount, receiver),
                ).fetchone()

                cur.execute(
                    """
                    INSERT INTO transactions(phone_number, type, amount, status, created_at)
                    VALUES (%s, %s, %s, %s, %s)
                    """,
                    (sender, "Transfer", transfer_amount, "Completed", now_iso),
                )
                cur.execute(
                    """
                    INSERT INTO transactions(phone_number, type, amount, status, created_at)
                    VALUES (%s, %s, %s, %s, %s)
                    """,
                    (receiver, "Deposit", transfer_amount, "Completed", now_iso),
                )
            conn.commit()

        sender_balance = float(sender_row[0]) if sender_row else 0.0
        receiver_balance = float(receiver_row[0]) if receiver_row else 0.0
        return sender_balance, receiver_balance

    def update_latest_pending_withdraw(self, phone_number: str, amount: float, next_status: str) -> bool:
        if not self.enabled():
            raise RuntimeError("Postgres store is not enabled")

        phone = str(phone_number).strip()
        rounded_amount = round(float(amount), 2)
        if not phone:
            raise ValueError("invalid_phone")

        with psycopg.connect(self.dsn, prepare_threshold=None) as conn:
            with conn.cursor() as cur:
                row = cur.execute(
                    """
                    UPDATE transactions
                    SET status = %s
                    WHERE id = (
                        SELECT id
                        FROM transactions
                        WHERE phone_number = %s
                          AND type = 'Withdraw'
                          AND status = 'Pending'
                          AND amount = %s
                        ORDER BY id DESC
                        LIMIT 1
                    )
                    RETURNING id
                    """,
                    (next_status, phone, rounded_amount),
                ).fetchone()
            conn.commit()
        return bool(row)

    def refund_withdraw(self, phone_number: str, amount: float) -> float:
        if not self.enabled():
            raise RuntimeError("Postgres store is not enabled")

        phone = str(phone_number).strip()
        refund_amount = round(float(amount), 2)
        if not phone:
            raise ValueError("invalid_phone")
        if refund_amount <= 0:
            raise ValueError("invalid_amount")

        now_iso = _utc_now_iso()
        with psycopg.connect(self.dsn, prepare_threshold=None) as conn:
            with conn.cursor() as cur:
                cur.execute(
                    """
                    INSERT INTO wallets(phone_number, main_balance, bonus_balance)
                    VALUES (%s, 0, 0)
                    ON CONFLICT(phone_number) DO NOTHING
                    """,
                    (phone,),
                )
                balance_row = cur.execute(
                    """
                    UPDATE wallets
                    SET main_balance = ROUND(main_balance + %s, 2)
                    WHERE phone_number = %s
                    RETURNING main_balance
                    """,
                    (refund_amount, phone),
                ).fetchone()
                cur.execute(
                    """
                    UPDATE transactions
                    SET status = 'Failed'
                    WHERE id = (
                        SELECT id
                        FROM transactions
                        WHERE phone_number = %s
                          AND type = 'Withdraw'
                          AND status = 'Pending'
                          AND amount = %s
                        ORDER BY id DESC
                        LIMIT 1
                    )
                    """,
                    (phone, refund_amount),
                )
                cur.execute(
                    """
                    INSERT INTO transactions(phone_number, type, amount, status, created_at)
                    VALUES (%s, 'Deposit', %s, 'Completed', %s)
                    """,
                    (phone, refund_amount, now_iso),
                )
            conn.commit()

        return float(balance_row[0]) if balance_row else 0.0

    def persist_users(self, users: dict[str, Any]) -> None:
        if not users:
            return
        with psycopg.connect(self.dsn, prepare_threshold=None) as conn:
            with conn.cursor() as cur:
                for phone, user in users.items():
                    cur.execute(
                        """
                        INSERT INTO users(phone_number, user_name, password_hash, referral_code, is_admin, telegram_id, telegram_username)
                        VALUES (%s, %s, %s, %s, %s, %s, %s)
                        ON CONFLICT(phone_number) DO UPDATE SET
                            user_name = EXCLUDED.user_name,
                            password_hash = EXCLUDED.password_hash,
                            referral_code = EXCLUDED.referral_code,
                            is_admin = EXCLUDED.is_admin,
                            telegram_id = EXCLUDED.telegram_id,
                            telegram_username = EXCLUDED.telegram_username
                        """,
                        (
                            phone,
                            user.get("user_name", ""),
                            user.get("password_hash", ""),
                            user.get("referral_code", ""),
                            bool(user.get("is_admin", False)),
                            user.get("telegram_id"),
                            user.get("telegram_username"),
                        ),
                    )
                    wallet = user.get("wallet", {})
                    cur.execute(
                        """
                        INSERT INTO wallets(phone_number, main_balance, bonus_balance)
                        VALUES (%s, %s, %s)
                        ON CONFLICT(phone_number) DO NOTHING
                        """,
                        (
                            phone,
                            round(float(wallet.get("main_balance", 0.0)), 2),
                            round(float(wallet.get("bonus_balance", 0.0)), 2),
                        ),
                    )
                    for bet in list(user.get("bet_history", [])):
                        cur.execute(
                            """
                            INSERT INTO bet_history(
                                id, phone_number, stake, game_winning, winner_cards, your_cards, date, result, payout, called_numbers, preview_card
                            )
                            VALUES (%s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s)
                            ON CONFLICT(id) DO UPDATE SET
                                phone_number = EXCLUDED.phone_number,
                                stake = EXCLUDED.stake,
                                game_winning = EXCLUDED.game_winning,
                                winner_cards = EXCLUDED.winner_cards,
                                your_cards = EXCLUDED.your_cards,
                                date = EXCLUDED.date,
                                result = EXCLUDED.result,
                                payout = EXCLUDED.payout,
                                called_numbers = EXCLUDED.called_numbers,
                                preview_card = EXCLUDED.preview_card
                            """,
                            (
                                str(bet.get("id", "")),
                                phone,
                                int(bet.get("stake", 0)),
                                round(float(bet.get("game_winning", 0.0)), 2),
                                Jsonb(list(bet.get("winner_cards", []))),
                                Jsonb(list(bet.get("your_cards", []))),
                                bet.get("date", ""),
                                bet.get("result", "Lost"),
                                round(float(bet.get("payout", 0.0)), 2),
                                Jsonb(list(bet.get("called_numbers", []))),
                                Jsonb(bet.get("preview_card")) if bet.get("preview_card") is not None else None,
                            ),
                        )
            conn.commit()

    def persist_sessions(self, sessions: dict[str, dict[str, str]]) -> None:
        with psycopg.connect(self.dsn, prepare_threshold=None) as conn:
            with conn.cursor() as cur:
                cur.execute("DELETE FROM sessions")
                for token, record in sessions.items():
                    cur.execute(
                        "INSERT INTO sessions(token, phone_number, created_at, expires_at) VALUES (%s, %s, %s, %s)",
                        (
                            token,
                            record.get("phone_number"),
                            record.get("created_at"),
                            record.get("expires_at"),
                        ),
                )
            conn.commit()

    def _persist_room(
        self,
        cur,
        stake_id: str,
        room: dict[str, Any],
        *,
        clear_existing: bool,
    ) -> None:
        if clear_existing:
            cur.execute("DELETE FROM room_winners WHERE stake_id = %s", (stake_id,))
            cur.execute("DELETE FROM room_claims WHERE stake_id = %s", (stake_id,))
            cur.execute("DELETE FROM room_marks WHERE stake_id = %s", (stake_id,))
            cur.execute("DELETE FROM room_cards WHERE stake_id = %s", (stake_id,))
            cur.execute("DELETE FROM rooms WHERE stake_id = %s", (stake_id,))

        cur.execute(
            """
            INSERT INTO rooms(
                stake_id, room_id, stake, card_price, players_seed, started_at, called_sequence, ended_at,
                winner_phone, winner_cartella, winner_payout, house_commission, claim_window_ends_at,
                claim_window_reference_time, result_until
            )
            VALUES (%s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s)
            """,
            (
                stake_id,
                room.get("id", f"room-{stake_id}"),
                int(room.get("stake", 0)),
                int(room.get("card_price", 0)),
                int(room.get("players_seed", 0)),
                room.get("started_at"),
                Jsonb(list(room.get("called_sequence", []))),
                room.get("ended_at"),
                room.get("winner_phone"),
                room.get("winner_cartella"),
                round(float(room.get("winner_payout", 0.0)), 2) if room.get("winner_payout") is not None else None,
                round(float(room.get("house_commission", 0.0)), 2) if room.get("house_commission") is not None else None,
                room.get("claim_window_ends_at"),
                room.get("claim_window_reference_time"),
                room.get("result_until"),
            ),
        )

        def insert_map(queue: str, owner_map: dict[Any, Any], hold_map: dict[Any, Any] | None = None) -> None:
            for cartella_raw, owner in owner_map.items():
                cartella_no = int(cartella_raw)
                held_updated_at = None
                if hold_map is not None:
                    held_updated_at = hold_map.get(cartella_raw)
                    if held_updated_at is None:
                        held_updated_at = hold_map.get(str(cartella_raw))
                cur.execute(
                    """
                    INSERT INTO room_cards(stake_id, queue, cartella_no, phone_number, held_updated_at)
                    VALUES (%s, %s, %s, %s, %s)
                    """,
                    (stake_id, queue, cartella_no, owner, held_updated_at),
                )

        insert_map("current_paid", dict(room.get("taken_cartellas", {})))
        insert_map("current_held", dict(room.get("held_cartellas", {})), dict(room.get("held_updated_at", {})))
        insert_map("next_paid", dict(room.get("next_taken_cartellas", {})))
        insert_map("next_held", dict(room.get("next_held_cartellas", {})), dict(room.get("next_held_updated_at", {})))

        for key, marks in dict(room.get("marked_by_user_card", {})).items():
            parts = str(key).split(":", maxsplit=1)
            if len(parts) != 2:
                continue
            phone_number, cartella_raw = parts
            try:
                cartella_no = int(cartella_raw)
            except Exception:
                continue
            cur.execute(
                """
                INSERT INTO room_marks(stake_id, phone_number, cartella_no, marks)
                VALUES (%s, %s, %s, %s)
                """,
                (stake_id, phone_number, cartella_no, Jsonb(list(marks))),
            )

        for claim in list(room.get("pending_claims", [])):
            cur.execute(
                """
                INSERT INTO room_claims(stake_id, phone_number, cartella_no, claimed_at)
                VALUES (%s, %s, %s, %s)
                """,
                (
                    stake_id,
                    claim.get("phone_number"),
                    int(claim.get("cartella_no", 0)),
                    claim.get("claimed_at"),
                ),
            )

        for idx, winner in enumerate(list(room.get("winners", []))):
            cur.execute(
                """
                INSERT INTO room_winners(stake_id, phone_number, user_name, cartella_no, payout, card, position)
                VALUES (%s, %s, %s, %s, %s, %s, %s)
                """,
                (
                    stake_id,
                    winner.get("phone_number"),
                    winner.get("user_name"),
                    int(winner.get("cartella_no", 0)),
                    round(float(winner.get("payout", 0.0)), 2),
                    Jsonb(winner.get("card", {})),
                    idx,
                ),
            )

    def _advisory_key(self, stake_id: str) -> int:
        digest = hashlib.sha256(str(stake_id).encode("utf-8")).digest()[:8]
        key = int.from_bytes(digest, "big", signed=False)
        if key >= 2**63:
            key -= 2**64
        return key

    def persist_rooms(self, rooms: dict[str, Any]) -> None:
        with psycopg.connect(self.dsn, prepare_threshold=None) as conn:
            with conn.cursor() as cur:
                cur.execute("DELETE FROM room_winners")
                cur.execute("DELETE FROM room_claims")
                cur.execute("DELETE FROM room_marks")
                cur.execute("DELETE FROM room_cards")
                cur.execute("DELETE FROM rooms")

                for stake_id, room in rooms.items():
                    self._persist_room(cur, stake_id, room, clear_existing=False)
            conn.commit()

    def persist_room(self, stake_id: str, room: dict[str, Any]) -> None:
        with psycopg.connect(self.dsn, prepare_threshold=None) as conn:
            with conn.cursor() as cur:
                cur.execute("SELECT pg_advisory_xact_lock(%s)", (self._advisory_key(stake_id),))
                self._persist_room(cur, stake_id, room, clear_existing=True)
            conn.commit()

    def persist_receipts(self, used_deposit_tx: dict[str, str], used_receipt_links: dict[str, str]) -> None:
        with psycopg.connect(self.dsn, prepare_threshold=None) as conn:
            with conn.cursor() as cur:
                cur.execute("DELETE FROM receipt_links")
                cur.execute("DELETE FROM receipt_reservations")
                for tx_number, phone in used_deposit_tx.items():
                    cur.execute(
                        "INSERT INTO receipt_reservations(tx_number, phone_number) VALUES (%s, %s)",
                        (tx_number, phone),
                    )
                for link_key, phone in used_receipt_links.items():
                    cur.execute(
                        "INSERT INTO receipt_links(link_key, phone_number) VALUES (%s, %s)",
                        (link_key, phone),
                    )
            conn.commit()

    def persist_withdraw_tickets(self, tickets: list[dict[str, Any]]) -> None:
        with psycopg.connect(self.dsn, prepare_threshold=None) as conn:
            with conn.cursor() as cur:
                cur.execute("DELETE FROM withdraw_requests")
                for ticket in tickets:
                    cur.execute(
                        """
                        INSERT INTO withdraw_requests(
                            id, phone_number, user_name, bank, account_number, account_holder,
                            amount, status, created_at, reviewed_at, reviewed_by,
                            processing_at, processing_by, paid_at, paid_by, payout_reference, admin_note
                        )
                        VALUES (%s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s)
                        """,
                        (
                            ticket.get("id"),
                            ticket.get("phone_number"),
                            ticket.get("user_name"),
                            ticket.get("bank"),
                            ticket.get("account_number"),
                            ticket.get("account_holder"),
                            round(float(ticket.get("amount", 0.0)), 2),
                            ticket.get("status"),
                            ticket.get("created_at"),
                            ticket.get("reviewed_at"),
                            ticket.get("reviewed_by"),
                            ticket.get("processing_at"),
                            ticket.get("processing_by"),
                            ticket.get("paid_at"),
                            ticket.get("paid_by"),
                            ticket.get("payout_reference"),
                            ticket.get("admin_note"),
                        ),
                    )
            conn.commit()

    def persist_deposit_methods(self, methods: list[dict[str, Any]]) -> None:
        with psycopg.connect(self.dsn, prepare_threshold=None) as conn:
            with conn.cursor() as cur:
                cur.execute("DELETE FROM deposit_accounts")
                cur.execute("DELETE FROM deposit_methods")
                for method in methods:
                    cur.execute(
                        """
                        INSERT INTO deposit_methods(code, label, logo_url, instruction_steps, receipt_example)
                        VALUES (%s, %s, %s, %s, %s)
                        """,
                        (
                            method.get("code"),
                            method.get("label"),
                            method.get("logo_url"),
                            Jsonb(list(method.get("instruction_steps", []))),
                            method.get("receipt_example"),
                        ),
                    )
                    for idx, account in enumerate(list(method.get("transfer_accounts", []))):
                        cur.execute(
                            """
                            INSERT INTO deposit_accounts(method_code, phone_number, owner_name, position)
                            VALUES (%s, %s, %s, %s)
                            """,
                            (
                                method.get("code"),
                                account.get("phone_number"),
                                account.get("owner_name"),
                                idx,
                            ),
                        )
            conn.commit()

    def persist_audit_events(self, events: list[dict[str, Any]]) -> None:
        with psycopg.connect(self.dsn, prepare_threshold=None) as conn:
            with conn.cursor() as cur:
                cur.execute("DELETE FROM audit_events")
                for event in events:
                    cur.execute(
                        """
                        INSERT INTO audit_events(
                            id, event_type, created_at, phone_number, amount, status, method, transaction_number,
                            withdraw_ticket_id, bank, account_number, account_holder, actor_phone, note
                        )
                        VALUES (%s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s)
                        """,
                        (
                            event.get("id"),
                            event.get("event_type"),
                            event.get("created_at"),
                            event.get("phone_number"),
                            round(float(event.get("amount", 0.0)), 2),
                            event.get("status"),
                            event.get("method"),
                            event.get("transaction_number"),
                            event.get("withdraw_ticket_id"),
                            event.get("bank"),
                            event.get("account_number"),
                            event.get("account_holder"),
                            event.get("actor_phone"),
                            event.get("note"),
                        ),
                    )
            conn.commit()


def read_sqlite_state(sqlite_path: Path) -> dict[str, Any]:
    if not sqlite_path.exists():
        return {}
    keys = [
        "users",
        "sessions",
        "rooms",
        "used_deposit_tx",
        "used_receipt_links",
        "withdraw_tickets",
        "deposit_methods",
        "audit_events",
    ]
    output: dict[str, Any] = {}
    with sqlite3.connect(str(sqlite_path)) as conn:
        rows = conn.execute(
            "SELECT state_key, state_value FROM app_state WHERE state_key IN (?,?,?,?,?,?,?,?)",
            tuple(keys),
        ).fetchall()
    for key, value in rows:
        output[str(key)] = json.loads(str(value))
    return output
