from __future__ import annotations

import asyncio
import json
import hashlib
import hmac
import math
import os
import re
import secrets
import smtplib
import socket
import ssl
import sqlite3
import threading
from datetime import datetime, timedelta, timezone
from email.message import EmailMessage
from email.utils import getaddresses
from html import escape
from pathlib import Path
from random import Random, randint, sample, shuffle
from typing import Iterable, Literal
from urllib.parse import parse_qsl, unquote, unquote_plus, urlencode, urlparse
from urllib.request import Request as UrlRequest, urlopen

try:
    import psycopg
    from psycopg.rows import dict_row
    from psycopg.types.json import Jsonb
except Exception:  # pragma: no cover - optional dependency for postgres runtime
    psycopg = None
    dict_row = None
    Jsonb = None

from fastapi import Depends, FastAPI, Header, HTTPException, Request, status
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import HTMLResponse
from pydantic import BaseModel, Field

from .postgres_store import PostgresStateStore, read_sqlite_state

try:
    from dotenv import load_dotenv
except Exception:  # pragma: no cover - optional in constrained environments
    def load_dotenv(*args, **kwargs) -> bool:
        # Minimal fallback loader when python-dotenv is unavailable.
        path_arg = args[0] if args else ".env"
        path = Path(path_arg)
        if not path.exists():
            return False
        override = bool(kwargs.get("override", False))
        loaded_any = False
        for raw_line in path.read_text(encoding="utf-8").splitlines():
            line = raw_line.strip()
            if not line or line.startswith("#"):
                continue
            if line.startswith("export "):
                line = line[len("export ") :].strip()
            if "=" not in line:
                continue
            key, value = line.split("=", 1)
            key = key.strip()
            value = value.strip()
            if not key:
                continue
            if (value.startswith('"') and value.endswith('"')) or (
                value.startswith("'") and value.endswith("'")
            ):
                value = value[1:-1]
            if override or key not in os.environ or os.environ.get(key, "") == "":
                os.environ[key] = value
                loaded_any = True
        return loaded_any


# Some cPanel Python app setups define DATABASE_URL as an empty app-level env var.
# When that happens, python-dotenv treats it as "already set" and won't load .env value.
if "DATABASE_URL" in os.environ and not os.environ.get("DATABASE_URL", "").strip():
    os.environ.pop("DATABASE_URL", None)

# Load local .env without overriding real environment (e.g., cPanel).
# This lets cPanel/prod env win while still supporting local dev defaults.
load_dotenv(Path(__file__).resolve().parent.parent / ".env", override=False)


def env_flag(name: str, default: bool = False) -> bool:
    raw = os.getenv(name)
    if raw is None:
        return default
    return raw.strip().lower() in {"1", "true", "yes", "on"}


def env_list(name: str, default: str = "") -> list[str]:
    raw = os.getenv(name, default)
    if not raw:
        return []
    return [item.strip() for item in re.split(r"[,\n;]+", raw) if item.strip()]


def env_csv_tokens(raw: str) -> list[str]:
    if not raw:
        return []
    tokens: list[str] = []
    for item in re.split(r"[,\n;]+", raw):
        candidate = item.strip()
        if not candidate:
            continue
        candidate = candidate.strip("\"'")
        if candidate.startswith("<") and candidate.endswith(">"):
            candidate = candidate[1:-1].strip()
        if candidate:
            tokens.append(candidate)
    return tokens


def env_int(name: str, default: int) -> int:
    raw = os.getenv(name)
    if raw is None:
        return default
    try:
        return int(raw.strip())
    except ValueError:
        return default


APP_ENV = os.getenv("APP_ENV", os.getenv("ENVIRONMENT", "development")).strip().lower()
IS_PRODUCTION_ENV = APP_ENV in {"prod", "production", "live"}

DEV_CORS_ORIGINS = [
    "http://localhost:5173",
    "http://127.0.0.1:5173",
    "http://localhost:5188",
    "http://127.0.0.1:5188",
    "http://localhost:5192",
    "http://127.0.0.1:5192",
]

CORS_ALLOWED_ORIGINS = env_list("CORS_ALLOWED_ORIGINS")
if not CORS_ALLOWED_ORIGINS and APP_ENV in {"dev", "development", "local", "test"}:
    CORS_ALLOWED_ORIGINS = DEV_CORS_ORIGINS

PROD_CORS_FALLBACK_ORIGINS = env_list(
    "PROD_CORS_FALLBACK_ORIGINS",
    "https://40bingo.com,https://www.40bingo.com,http://40bingo.com,http://www.40bingo.com",
)
if IS_PRODUCTION_ENV:
    for origin in PROD_CORS_FALLBACK_ORIGINS:
        if origin not in CORS_ALLOWED_ORIGINS:
            CORS_ALLOWED_ORIGINS.append(origin)

CORS_ALLOWED_ORIGIN_REGEX = os.getenv("CORS_ALLOWED_ORIGIN_REGEX", "").strip()
if not CORS_ALLOWED_ORIGIN_REGEX and APP_ENV in {"dev", "development", "local", "test"}:
    CORS_ALLOWED_ORIGIN_REGEX = (
        r"^https?://(localhost|127\.0\.0\.1|192\.168\.\d+\.\d+|10\.\d+\.\d+\.\d+|"
        r"172\.(1[6-9]|2\d|3[0-1])\.\d+\.\d+)(:\d+)?$"
    )

app = FastAPI(title="40bingo API", version="2.0.0")

app.add_middleware(
    CORSMiddleware,
    allow_origins=CORS_ALLOWED_ORIGINS,
    allow_origin_regex=CORS_ALLOWED_ORIGIN_REGEX or None,
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)


class StakeOption(BaseModel):
    id: str
    stake: int
    status: Literal["countdown", "playing", "none"]
    countdown_seconds: int | None = None
    possible_win: int | None = None
    bonus: bool = False
    room_phase: Literal["selecting", "playing", "finished"] | None = None
    my_cards_current: int = 0
    my_cards_next: int = 0
    open_available: bool = False


class DepositAccount(BaseModel):
    phone_number: str = Field(pattern=r"^(09\d{8}|\+2519\d{8})$")
    owner_name: str = Field(min_length=2, max_length=60)


class DepositMethod(BaseModel):
    code: Literal["telebirr", "cbebirr"]
    label: str
    logo_url: str | None = None
    transfer_accounts: list[DepositAccount]
    instruction_steps: list[str]
    receipt_example: str


class WalletState(BaseModel):
    currency: str = "ETB"
    main_balance: float
    bonus_balance: float


class TransactionRecord(BaseModel):
    type: Literal["Deposit", "Withdraw", "Transfer", "Bet", "Win"]
    amount: float
    status: Literal["Completed", "Pending", "Failed"]
    created_at: str


class BetHistoryRecord(BaseModel):
    id: str
    stake: int
    game_winning: float
    winner_cards: list[int]
    your_cards: list[int]
    date: str
    result: Literal["Won", "Lost"]
    payout: float = 0.0
    called_numbers: list[int] = Field(default_factory=list)
    preview_card: BingoCardResponse | None = None


class UserPublic(BaseModel):
    user_name: str
    phone_number: str
    referral_code: str
    is_admin: bool = False


class SignupRequest(BaseModel):
    user_name: str = Field(min_length=2, max_length=40)
    phone_number: str = Field(pattern=r"^(09\d{8}|\+2519\d{8})$")
    password: str = Field(min_length=6, max_length=64)


class LoginRequest(BaseModel):
    phone_number: str = Field(pattern=r"^(09\d{8}|\+2519\d{8})$")
    password: str = Field(min_length=6, max_length=64)


class TelegramAuthRequest(BaseModel):
    init_data: str = Field(min_length=10, max_length=5000)
    phone_number: str | None = Field(default=None, pattern=r"^(09\d{8}|\+2519\d{8})$")
    password: str | None = Field(default=None, min_length=6, max_length=64)


class DepositRequest(BaseModel):
    method: Literal["telebirr", "cbebirr"]
    amount: float = Field(gt=0, le=20000)
    transaction_number: str | None = Field(default=None, min_length=3, max_length=120)
    receipt_message: str | None = Field(default=None, max_length=1000)


class AdminUpdateDepositAccountsRequest(BaseModel):
    transfer_accounts: list[DepositAccount] = Field(min_length=1, max_length=6)


class TransferRequest(BaseModel):
    phone_number: str = Field(pattern=r"^(09\d{8}|\+2519\d{8})$")
    amount: int = Field(gt=0, le=5000)
    otp: str = Field(pattern=r"^\d{4,6}$")


class WithdrawRequest(BaseModel):
    bank: str = Field(min_length=2, max_length=40)
    account_number: str = Field(min_length=6, max_length=20)
    account_holder: str = Field(min_length=2, max_length=60)
    amount: int = Field(gt=2, le=50000)


class CasinoGameItem(BaseModel):
    id: str
    title: str
    description: str
    min_bet: float
    max_bet: float
    max_multiplier: float
    volatility: Literal["low", "medium", "high"]
    provider: str = "OpenSource Casino 8.5"


class CasinoPlayRequest(BaseModel):
    game_id: str = Field(min_length=2, max_length=80)
    stake: float = Field(gt=0, le=10000)


class CasinoLaunchRequest(BaseModel):
    game_id: str = Field(min_length=2, max_length=80)
    device: Literal["mobile", "desktop", "auto"] = "auto"
    locale: str = Field(default="en", min_length=2, max_length=16)
    return_url: str | None = Field(default=None, max_length=500)


class CasinoLaunchPlayRequest(BaseModel):
    launch_id: str = Field(min_length=8, max_length=120)
    stake: float = Field(gt=0, le=10000)


class WithdrawTicket(BaseModel):
    id: str
    phone_number: str
    user_name: str
    bank: str
    account_number: str
    account_holder: str
    amount: float
    status: Literal["Pending", "Processing", "Paid", "Rejected", "Approved"] = "Pending"
    created_at: str
    reviewed_at: str | None = None
    reviewed_by: str | None = None
    processing_at: str | None = None
    processing_by: str | None = None
    paid_at: str | None = None
    paid_by: str | None = None
    payout_reference: str | None = None
    admin_note: str | None = None


class AuditEvent(BaseModel):
    id: str
    event_type: Literal["deposit_confirmed", "withdraw_requested", "withdraw_paid", "withdraw_rejected"]
    created_at: str
    phone_number: str
    amount: float
    status: str
    method: str | None = None
    transaction_number: str | None = None
    withdraw_ticket_id: str | None = None
    bank: str | None = None
    account_number: str | None = None
    account_holder: str | None = None
    actor_phone: str | None = None
    note: str | None = None


class AdminMarkPaidRequest(BaseModel):
    payout_reference: str = Field(min_length=3, max_length=120)
    admin_note: str | None = Field(default=None, max_length=300)


class PreviewCardRequest(BaseModel):
    stake_id: str
    cartella_no: int = Field(ge=1, le=200)


class JoinStakeRequest(BaseModel):
    stake_id: str
    cartella_no: int = Field(ge=1, le=200)


class MarkNumberRequest(BaseModel):
    room_id: str
    number: int = Field(ge=1, le=75)
    marked: bool
    cartella_no: int | None = Field(default=None, ge=1, le=200)


class ClaimBingoRequest(BaseModel):
    room_id: str
    cartella_no: int | None = Field(default=None, ge=1, le=200)


class RoomState(BaseModel):
    id: str
    stake: int
    card_price: int
    players: int
    phase: Literal["selecting", "playing", "finished"]
    countdown_seconds: int
    call_countdown_seconds: int = 0
    cartella_total: int
    paid_cartellas: list[int]
    simulated_paid_cartellas: list[int] = Field(default_factory=list)
    display_paid_count: int = 0
    current_paid_count: int = 0
    current_total_sales: float = 0.0
    current_house_commission: float = 0.0
    current_distributable: float = 0.0
    held_cartellas: list[int]
    unavailable_cartellas: list[int]
    my_cartella: int | None = None
    my_cartellas: list[int] = Field(default_factory=list)
    next_my_cartellas: list[int] = Field(default_factory=list)
    my_held_cartella: int | None = None
    active_queue: Literal["current", "next"] = "current"
    called_numbers: list[int]
    latest_number: int | None = None
    my_marked_numbers: list[int] = Field(default_factory=list)
    my_marked_numbers_by_card: dict[str, list[int]] = Field(default_factory=dict)
    winner_name: str | None = None
    winner_cartella: int | None = None
    winner_payout: float | None = None
    house_commission: float | None = None
    winners: list["WinnerEntry"] = Field(default_factory=list)
    claim_window_seconds: int = 0
    announcement_seconds: int = 0


class BingoCardResponse(BaseModel):
    card_no: int
    grid: list[list[int | str]]


class ClaimEntry(BaseModel):
    phone_number: str
    cartella_no: int
    claimed_at: datetime


class WinnerEntry(BaseModel):
    phone_number: str
    user_name: str
    cartella_no: int
    payout: float
    card: BingoCardResponse


class UserStore(BaseModel):
    user_name: str
    phone_number: str
    password_hash: str
    referral_code: str
    is_admin: bool = False
    telegram_id: int | None = None
    telegram_username: str | None = None
    wallet: WalletState
    history: list[TransactionRecord] = Field(default_factory=list)
    bet_history: list[BetHistoryRecord] = Field(default_factory=list)
    joined_rooms: dict[str, list[int]] = Field(default_factory=dict)


class RoomStore(BaseModel):
    id: str
    stake_id: str
    stake: int
    card_price: int
    players_seed: int
    started_at: datetime
    called_sequence: list[int]
    taken_cartellas: dict[int, str] = Field(default_factory=dict)
    held_cartellas: dict[int, str] = Field(default_factory=dict)
    held_updated_at: dict[int, datetime] = Field(default_factory=dict)
    next_taken_cartellas: dict[int, str] = Field(default_factory=dict)
    next_held_cartellas: dict[int, str] = Field(default_factory=dict)
    next_held_updated_at: dict[int, datetime] = Field(default_factory=dict)
    marked_by_user_card: dict[str, list[int]] = Field(default_factory=dict)
    ended_at: datetime | None = None
    winner_phone: str | None = None
    winner_cartella: int | None = None
    winner_payout: float | None = None
    house_commission: float | None = None
    pending_claims: list[ClaimEntry] = Field(default_factory=list)
    claim_window_ends_at: datetime | None = None
    claim_window_reference_time: datetime | None = None
    winners: list[WinnerEntry] = Field(default_factory=list)
    result_until: datetime | None = None


BRAND = {
    "name": "40bingo",
    "tagline": "Play smart. Win fair.",
    "primary": "#391066",
    "accent": "#ffd400",
    "surface": "#a693c8",
}

DEFAULT_DEPOSIT_LOGOS: dict[str, str] = {
    "telebirr": "https://tse3.mm.bing.net/th/id/OIP.4yqd3lozkEImH0fgytD6RgHaD4?rs=1&pid=ImgDetMain&o=7&rm=3",
    "cbebirr": "/providers/cbebirr.png",
}

DEPOSIT_METHODS = [
    DepositMethod(
        code="telebirr",
        label="Telebirr Deposit",
        logo_url=DEFAULT_DEPOSIT_LOGOS["telebirr"],
        transfer_accounts=[
            DepositAccount(phone_number="+251945811613", owner_name="ERGO"),
            DepositAccount(phone_number="0923794255", owner_name="KIYA"),
        ],
        instruction_steps=[
            "Open Telebirr app and dial *127#.",
            "Transfer to one of the listed account numbers.",
            "Copy the transaction number from your receipt.",
            "Submit it in 40bingo Transaction Checker.",
        ],
        receipt_example="CA999DASAD",
    ),
    DepositMethod(
        code="cbebirr",
        label="CBE Birr Deposit",
        logo_url=DEFAULT_DEPOSIT_LOGOS["cbebirr"],
        transfer_accounts=[
            DepositAccount(phone_number="+251945811613", owner_name="ERGO"),
            DepositAccount(phone_number="0923794255", owner_name="KIYA"),
        ],
        instruction_steps=[
            "Open CBE Birr app and dial *847#.",
            "Transfer to one of the listed account numbers.",
            "Copy the transaction number from your receipt.",
            "Submit it in 40bingo Transaction Checker.",
        ],
        receipt_example="CAA2K819ZY",
    ),
]

STAKE_OPTIONS: list[StakeOption] = [
    StakeOption(id="stake-10", stake=10, status="countdown", countdown_seconds=43, possible_win=134, bonus=True),
    StakeOption(id="stake-20", stake=20, status="playing", possible_win=666),
    StakeOption(id="stake-30", stake=30, status="countdown", countdown_seconds=28, possible_win=123),
    StakeOption(id="stake-50", stake=50, status="playing", possible_win=170),
    StakeOption(id="stake-80", stake=80, status="none", possible_win=None),
    StakeOption(id="stake-100", stake=100, status="countdown", countdown_seconds=14, possible_win=2158, bonus=True),
    StakeOption(id="stake-150", stake=150, status="none", possible_win=None),
    StakeOption(id="stake-200", stake=200, status="none", possible_win=None),
    StakeOption(id="stake-300", stake=300, status="none", possible_win=None),
]

FAQ_ITEMS = [
    {
        "id": "faq-1",
        "question": "How does playing work?",
        "answer": "Choose a stake, pick one cartella number from 1 to 200, confirm card, and wait for live calls.",
    },
    {
        "id": "faq-2",
        "question": "How do I deposit?",
        "answer": "Open Deposit, choose Telebirr or CBE Birr, transfer to the listed account, then submit the transaction number.",
    },
    {
        "id": "faq-3",
        "question": "How do I withdraw?",
        "answer": "Use Withdraw, add your bank details, request amount, verify OTP, then submit your withdrawal.",
    },
]

CASINO_GAMES: list[CasinoGameItem] = [
    CasinoGameItem(
        id="slots-megaways",
        title="Slots Megaways",
        description="Fast reel spins with stacked symbols and jackpot swings.",
        min_bet=5.0,
        max_bet=500.0,
        max_multiplier=10.0,
        volatility="high",
    ),
    CasinoGameItem(
        id="roulette-euro",
        title="European Roulette",
        description="Single-zero roulette with high-risk payout spikes.",
        min_bet=10.0,
        max_bet=1000.0,
        max_multiplier=20.0,
        volatility="medium",
    ),
    CasinoGameItem(
        id="blackjack-classic",
        title="Blackjack Classic",
        description="Classic 21 flow with steady medium volatility returns.",
        min_bet=10.0,
        max_bet=800.0,
        max_multiplier=8.0,
        volatility="low",
    ),
    CasinoGameItem(
        id="baccarat-royal",
        title="Baccarat Royal",
        description="Banker versus player quick rounds with balanced odds.",
        min_bet=10.0,
        max_bet=900.0,
        max_multiplier=9.0,
        volatility="low",
    ),
    CasinoGameItem(
        id="crash-orbit",
        title="Crash Orbit",
        description="Multiplier rush mode with explosive top-end payouts.",
        min_bet=5.0,
        max_bet=400.0,
        max_multiplier=20.0,
        volatility="high",
    ),
    CasinoGameItem(
        id="mines-grid",
        title="Mines Grid",
        description="Reveal safe tiles and cash out before the mine hits.",
        min_bet=5.0,
        max_bet=350.0,
        max_multiplier=12.0,
        volatility="medium",
    ),
    CasinoGameItem(
        id="hilo-cards",
        title="Hi-Lo Cards",
        description="Predict high or low swings for quick multiplier jumps.",
        min_bet=5.0,
        max_bet=300.0,
        max_multiplier=6.0,
        volatility="medium",
    ),
    CasinoGameItem(
        id="lucky-dice",
        title="Lucky Dice",
        description="Two-dice instant rounds with frequent outcomes.",
        min_bet=5.0,
        max_bet=300.0,
        max_multiplier=6.0,
        volatility="low",
    ),
]

CASINO_PAYOUT_TABLES: dict[str, list[tuple[float, float]]] = {
    "slots-megaways": [(0.56, 0.0), (0.26, 1.4), (0.12, 2.2), (0.05, 4.0), (0.01, 10.0)],
    "roulette-euro": [(0.64, 0.0), (0.26, 2.0), (0.08, 3.0), (0.018, 8.0), (0.002, 20.0)],
    "blackjack-classic": [(0.52, 0.0), (0.32, 1.8), (0.13, 2.2), (0.025, 3.5), (0.005, 8.0)],
    "baccarat-royal": [(0.57, 0.0), (0.31, 1.9), (0.10, 2.4), (0.018, 4.0), (0.002, 9.0)],
    "crash-orbit": [(0.70, 0.0), (0.17, 2.0), (0.09, 3.0), (0.03, 5.0), (0.009, 10.0), (0.001, 20.0)],
    "mines-grid": [(0.62, 0.0), (0.24, 1.7), (0.10, 2.6), (0.035, 5.0), (0.005, 12.0)],
    "hilo-cards": [(0.56, 0.0), (0.36, 1.9), (0.07, 2.5), (0.01, 6.0)],
    "lucky-dice": [(0.53, 0.0), (0.39, 1.85), (0.07, 2.8), (0.01, 6.0)],
}

CARTELLA_TOTAL = 200
CALL_INTERVAL_SECONDS = 5.0
SELECT_PHASE_SECONDS = 43
HOLD_TTL_SECONDS = 20
DEMO_START_BALANCE = 700.0
HOUSE_COMMISSION_RATE = 0.15
RESULT_ANNOUNCE_SECONDS = 5
MAX_CARDS_PER_USER = 10
CLAIM_GRACE_SECONDS = 2
ENABLE_DEMO_SEED = env_flag("ENABLE_DEMO_SEED", False)
ENABLE_SIMULATED_ACTIVITY = env_flag("ENABLE_SIMULATED_ACTIVITY", True)
SIMULATED_SELECTING_MAX_PAID = max(0, env_int("SIMULATED_SELECTING_MAX_PAID", 60))
SIMULATED_PLAYING_MAX_PAID = max(SIMULATED_SELECTING_MAX_PAID, env_int("SIMULATED_PLAYING_MAX_PAID", 120))
SIMULATED_SELECTING_STEP_SECONDS = max(1, env_int("SIMULATED_SELECTING_STEP_SECONDS", 3))
SIMULATED_SELECTING_CARDS_PER_STEP = max(1, env_int("SIMULATED_SELECTING_CARDS_PER_STEP", 2))
SIMULATED_PLAYING_CARDS_PER_CALL = max(1, env_int("SIMULATED_PLAYING_CARDS_PER_CALL", 1))
SIMULATED_BOT_POOL_SIZE = max(120, env_int("SIMULATED_BOT_POOL_SIZE", 220))
SIMULATED_PHONE_START = max(10000000, min(99999999, env_int("SIMULATED_PHONE_START", 96000000)))
SIMULATED_USER_TAG = "__simulated_bot__"
SIMULATED_PASSWORD_HASH = "simbot$disabled"
SIMULATED_HIGH_TRAFFIC_ROUND_PERCENT = max(0, min(100, env_int("SIMULATED_HIGH_TRAFFIC_ROUND_PERCENT", 35)))
SIMULATED_HIGH_TRAFFIC_TARGET = max(100, min(CARTELLA_TOTAL, env_int("SIMULATED_HIGH_TRAFFIC_TARGET", 100)))
SIMULATED_FIRST_NAMES = [
    "Abebe",
    "Abel",
    "Alemu",
    "Amanuel",
    "Aschalew",
    "Assefa",
    "Ayele",
    "Bereket",
    "Bekele",
    "Biniam",
    "Birhanu",
    "Daniel",
    "Dawit",
    "Demissie",
    "Dereje",
    "Elias",
    "Endale",
    "Eshetu",
    "Eyob",
    "Fasil",
    "Fekadu",
    "Fikru",
    "Getachew",
    "Getahun",
    "Haile",
    "Henok",
    "Kedir",
    "Kassahun",
    "Kebede",
    "Kidus",
    "Lidetu",
    "Mekonnen",
    "Merga",
    "Mesfin",
    "Mohammed",
    "Mulugeta",
    "Nebiyu",
    "Natnael",
    "Nega",
    "Nigatu",
    "Seifu",
    "Solomon",
    "Tamirat",
    "Yohannes",
    "Teshome",
    "Yared",
]
SIMULATED_LAST_NAMES = [
    "Abate",
    "Abebe",
    "Alemayehu",
    "Amanuel",
    "Asfaw",
    "Assefa",
    "Ayalew",
    "Belay",
    "Bekele",
    "Birhane",
    "Demeke",
    "Desta",
    "Fikre",
    "Getachew",
    "Getahun",
    "Girma",
    "Hailemariam",
    "Kassa",
    "Kebede",
    "Legesse",
    "Mamo",
    "Mekuria",
    "Molla",
    "Negash",
    "Tadesse",
    "Tekle",
    "Wolde",
    "Yilma",
    "Yohannes",
    "Zerihun",
]
ADMIN_BOOTSTRAP_PHONES = env_list("ADMIN_BOOTSTRAP_PHONES", os.getenv("ADMIN_PHONE_NUMBERS", ""))
TELEGRAM_BOT_TOKEN = os.getenv("TELEGRAM_BOT_TOKEN", "").strip()
DEFAULT_ADMIN_ALERT_EMAILS = [
    "emebetalemayehuengr@gmail.com",
    "fisahaworabo9@gmail.com",
]
ADMIN_ALERT_EMAIL_ENV_KEYS = ("ADMIN_ALERT_EMAILS", "WITHDRAW_ALERT_EMAILS", "ADMIN_GMAIL_ACCOUNTS", "ADMIN_ALERT_EMAIL")
ADMIN_ALERT_EMAILS: list[str] = []
for env_key in ADMIN_ALERT_EMAIL_ENV_KEYS:
    raw_value = os.getenv(env_key, "").strip()
    if not raw_value:
        continue
    ADMIN_ALERT_EMAILS = env_csv_tokens(raw_value)
    if ADMIN_ALERT_EMAILS:
        break
if not ADMIN_ALERT_EMAILS:
    ADMIN_ALERT_EMAILS = list(DEFAULT_ADMIN_ALERT_EMAILS)
DEFAULT_WITHDRAW_ALERT_PHONES = "0969801746,0913218501"
WITHDRAW_ALERT_PHONES = env_csv_tokens(os.getenv("WITHDRAW_ALERT_PHONES", DEFAULT_WITHDRAW_ALERT_PHONES).strip())
ADMIN_ALERT_SMS_RECIPIENTS = env_csv_tokens(os.getenv("ADMIN_ALERT_SMS_RECIPIENTS", "").strip())
SMTP_SMS_GATEWAY_DOMAIN = os.getenv("SMTP_SMS_GATEWAY_DOMAIN", "").strip().lstrip("@")
SMTP_HOST = os.getenv("SMTP_HOST", "").strip()
SMTP_USE_SSL = os.getenv("SMTP_USE_SSL", "false").strip().lower() in {"1", "true", "yes", "on"}
raw_smtp_port = os.getenv("SMTP_PORT", "").strip()
if not raw_smtp_port:
    SMTP_PORT = 465 if SMTP_USE_SSL else 587
else:
    try:
        SMTP_PORT = int(raw_smtp_port)
    except ValueError:
        SMTP_PORT = 465 if SMTP_USE_SSL else 587
SMTP_USERNAME = os.getenv("SMTP_USERNAME", "").strip()
SMTP_PASSWORD = os.getenv("SMTP_PASSWORD", "").strip()
SMTP_FROM = os.getenv("SMTP_FROM", "").strip() or SMTP_USERNAME or "noreply@40bingo.local"
SMTP_USE_TLS = os.getenv("SMTP_USE_TLS", "true").strip().lower() in {"1", "true", "yes", "on"}
try:
    SESSION_TTL_SECONDS = max(300, int(os.getenv("SESSION_TTL_SECONDS", "86400").strip() or "86400"))
except ValueError:
    SESSION_TTL_SECONDS = 86400
ENABLE_INTERNAL_TRANSFER = env_flag("ENABLE_INTERNAL_TRANSFER", False)
TRANSFER_OTP_VERIFY_URL = os.getenv("TRANSFER_OTP_VERIFY_URL", "").strip()
try:
    TRANSFER_OTP_VERIFY_TIMEOUT_SECONDS = float(os.getenv("TRANSFER_OTP_VERIFY_TIMEOUT_SECONDS", "6").strip() or "6")
except ValueError:
    TRANSFER_OTP_VERIFY_TIMEOUT_SECONDS = 6.0
try:
    SIGNUP_INITIAL_MAIN_BALANCE = float(os.getenv("SIGNUP_INITIAL_MAIN_BALANCE", "0").strip() or "0")
except ValueError:
    SIGNUP_INITIAL_MAIN_BALANCE = 0.0
try:
    SIGNUP_INITIAL_BONUS_BALANCE = float(os.getenv("SIGNUP_INITIAL_BONUS_BALANCE", "0").strip() or "0")
except ValueError:
    SIGNUP_INITIAL_BONUS_BALANCE = 0.0

CASINO_PROVIDER_NAME = os.getenv("CASINO_PROVIDER_NAME", "Booming").strip() or "Booming"
CASINO_PROVIDER_MODE = os.getenv("CASINO_PROVIDER_MODE", "selfhosted").strip().lower()
CASINO_LAUNCH_API_URL = os.getenv("CASINO_LAUNCH_API_URL", "").strip()
CASINO_PROVIDER_OPERATOR_ID = os.getenv("CASINO_PROVIDER_OPERATOR_ID", "40bingo").strip() or "40bingo"
CASINO_PROVIDER_API_KEY = os.getenv("CASINO_PROVIDER_API_KEY", "").strip()
CASINO_PROVIDER_SECRET = os.getenv("CASINO_PROVIDER_SECRET", "").strip()
CASINO_WEBHOOK_SECRET = os.getenv("CASINO_WEBHOOK_SECRET", "").strip()
CASINO_LAUNCH_MODE = os.getenv("CASINO_LAUNCH_MODE", "redirect").strip().lower()
CASINO_ALLOWED_RETURN_HOSTS = {host.lower() for host in env_list("CASINO_ALLOWED_RETURN_HOSTS")}
CASINO_LAUNCH_SESSION_SECONDS = max(120, env_int("CASINO_LAUNCH_SESSION_SECONDS", 900))

USERS: dict[str, UserStore] = {}
SESSIONS: dict[str, dict[str, str]] = {}
ROOMS: dict[str, RoomStore] = {}
GAME_TICKER_TASK: asyncio.Task | None = None
USED_DEPOSIT_TX: dict[str, str] = {}
USED_RECEIPT_LINKS: dict[str, str] = {}
WITHDRAW_TICKETS: list[WithdrawTicket] = []
AUDIT_EVENTS: list[AuditEvent] = []
CASINO_LAUNCH_SESSIONS: dict[str, dict[str, str]] = {}
USER_REFRESH_AT: dict[str, datetime] = {}

DEPOSIT_SOURCE_DOMAINS: dict[str, set[str]] = {
    "telebirr": {"telebirr.et", "telebirr.com.et", "ethiotelecom.et"},
    "cbebirr": {"cbebirr.com.et", "commercialbankofethiopia.com", "cbe.com.et"},
}

DEFAULT_SQLITE_PATH = (
    Path("/var/data/40bingo.db")
    if IS_PRODUCTION_ENV
    else (Path(__file__).resolve().parent.parent / "data" / "40bingo.db")
)
PRIMARY_DB_ENV_KEYS = ("FORTY_BINGO_DB_PATH", "ETHIO_BINGO_DB_PATH")
FALLBACK_DB_ENV_KEYS = ("FORTY_BINGO_FALLBACK_DB_PATH", "ETHIO_BINGO_FALLBACK_DB_PATH")
PERSISTENT_SQLITE_ROOTS = env_list("PERSISTENT_SQLITE_ROOTS", "/var/data,/home")
USER_REFRESH_TTL_SECONDS = max(1, env_int("USER_REFRESH_TTL_SECONDS", 5))


def get_env_first(keys: tuple[str, ...], default: str = "") -> str:
    for key in keys:
        raw = os.getenv(key, "").strip()
        if raw:
            return raw
    return default


DB_PATH = Path(
    get_env_first(PRIMARY_DB_ENV_KEYS, str(DEFAULT_SQLITE_PATH))
).expanduser()


def normalize_database_url(raw: str) -> str:
    if not raw:
        return ""
    updated = raw
    if "supabase.co" in updated and not re.search(r"[?&]sslmode=", updated, flags=re.IGNORECASE):
        separator = "&" if "?" in updated else "?"
        updated = f"{updated}{separator}sslmode=require"
    try:
        parsed = urlparse(updated)
        if parsed.scheme.startswith("postgres") and parsed.hostname:
            query_pairs = parse_qsl(parsed.query, keep_blank_values=True)
            query = {key: value for key, value in query_pairs}
            if "hostaddr" not in query:
                hostaddr = os.getenv("PG_HOSTADDR", "").strip()
                if not hostaddr:
                    try:
                        infos = socket.getaddrinfo(
                            parsed.hostname,
                            parsed.port or 5432,
                            socket.AF_INET,
                            socket.SOCK_STREAM,
                        )
                        if infos:
                            hostaddr = infos[0][4][0]
                    except OSError:
                        hostaddr = ""
                if hostaddr:
                    query["hostaddr"] = hostaddr
                    updated = parsed._replace(query=urlencode(query)).geturl()
    except Exception:
        return updated
    return updated


DATABASE_URL = normalize_database_url(os.getenv("DATABASE_URL", "").strip())
PG_STORE = PostgresStateStore(DATABASE_URL)
DB_LOCK = threading.Lock()
ALLOW_EPHEMERAL_DB = env_flag("ALLOW_EPHEMERAL_DB", False)


def sqlite_path_looks_persistent(path: Path) -> bool:
    if os.name == "nt":
        # Linux mount checks are not relevant on Windows.
        return True
    normalized = path.expanduser().resolve(strict=False).as_posix().lower()
    for raw_root in PERSISTENT_SQLITE_ROOTS:
        root = raw_root.strip()
        if not root:
            continue
        root_norm = Path(root).expanduser().resolve(strict=False).as_posix().lower()
        if normalized == root_norm or normalized.startswith(f"{root_norm}/"):
            return True
    return False


def normalize_phone_for_smtp_gateway(phone_number: str) -> str | None:
    digits = re.sub(r"\D", "", phone_number or "")
    if digits.startswith("2519") and len(digits) == 12:
        return digits
    if digits.startswith("09") and len(digits) == 10:
        return "251" + digits[1:]
    if digits.startswith("9") and len(digits) == 9:
        return "251" + digits
    return None


def build_alert_recipients() -> list[str]:
    recipients: list[str] = []

    def add(value: str) -> None:
        candidate = value.strip()
        if candidate and candidate not in recipients:
            recipients.append(candidate)

    for email in ADMIN_ALERT_EMAILS:
        if "@" in email:
            add(email)

    for sms_email in ADMIN_ALERT_SMS_RECIPIENTS:
        if "@" in sms_email:
            add(sms_email)

    if SMTP_SMS_GATEWAY_DOMAIN:
        for phone in WITHDRAW_ALERT_PHONES:
            normalized = normalize_phone_for_smtp_gateway(phone)
            if normalized:
                add(f"{normalized}@{SMTP_SMS_GATEWAY_DOMAIN}")

    return recipients


def is_email_alerts_configured() -> bool:
    return bool(build_alert_recipients() and SMTP_HOST and SMTP_USERNAME and SMTP_PASSWORD and SMTP_FROM)


def ensure_runtime_config_ready() -> None:
    # In production we fail fast on partial/missing SMTP setup because withdraw alerts are operationally required.
    if IS_PRODUCTION_ENV and not is_email_alerts_configured():
        raise RuntimeError(
            "Email alert config is incomplete. Set at least one recipient via ADMIN_ALERT_EMAILS, "
            "ADMIN_ALERT_SMS_RECIPIENTS, or WITHDRAW_ALERT_PHONES + SMTP_SMS_GATEWAY_DOMAIN, and configure "
            "SMTP_HOST, SMTP_USERNAME, SMTP_PASSWORD, and SMTP_FROM."
        )


def ensure_db_ready() -> None:
    global DB_PATH
    if PG_STORE.enabled():
        PG_STORE.ensure_schema()
        return
    if IS_PRODUCTION_ENV and not ALLOW_EPHEMERAL_DB and not sqlite_path_looks_persistent(DB_PATH):
        raise RuntimeError(
            f"APP_ENV=production requires persistent storage. Current FORTY_BINGO_DB_PATH '{DB_PATH}' is not under "
            f"allowed persistent roots {PERSISTENT_SQLITE_ROOTS}. Set FORTY_BINGO_DB_PATH (or legacy "
            "ETHIO_BINGO_DB_PATH), set PERSISTENT_SQLITE_ROOTS, attach persistent storage, or set DATABASE_URL."
        )
    try:
        DB_PATH.parent.mkdir(parents=True, exist_ok=True)
    except PermissionError:
        fallback_raw = get_env_first(FALLBACK_DB_ENV_KEYS)
        if not fallback_raw:
            raise RuntimeError(
                f"DB path '{DB_PATH}' is not writable. Attach a persistent disk, set DATABASE_URL, "
                "or set FORTY_BINGO_FALLBACK_DB_PATH (legacy ETHIO_BINGO_FALLBACK_DB_PATH is also supported)."
            ) from None
        fallback_path = Path(fallback_raw).expanduser()
        if IS_PRODUCTION_ENV and not ALLOW_EPHEMERAL_DB and not sqlite_path_looks_persistent(fallback_path):
            raise RuntimeError(
                f"Fallback DB path '{fallback_path}' is not under allowed persistent roots "
                f"{PERSISTENT_SQLITE_ROOTS} for production. Set PERSISTENT_SQLITE_ROOTS or set DATABASE_URL."
            ) from None
        print(
            f"DB path '{DB_PATH}' is not writable. Falling back to '{fallback_path}'."
        )
        DB_PATH = fallback_path
        DB_PATH.parent.mkdir(parents=True, exist_ok=True)
    with DB_LOCK:
        with sqlite3.connect(DB_PATH) as conn:
            conn.execute(
                """
                CREATE TABLE IF NOT EXISTS app_state (
                    state_key TEXT PRIMARY KEY,
                    state_value TEXT NOT NULL,
                    updated_at TEXT NOT NULL
                )
                """
            )


def db_read_state(state_key: str) -> object | None:
    ensure_db_ready()
    with DB_LOCK:
        with sqlite3.connect(DB_PATH) as conn:
            row = conn.execute(
                "SELECT state_value FROM app_state WHERE state_key = ?",
                (state_key,),
            ).fetchone()
    if not row:
        return None
    try:
        return json.loads(str(row[0]))
    except json.JSONDecodeError:
        return None


def db_write_state(state_key: str, value: object) -> None:
    ensure_db_ready()
    payload = json.dumps(value, separators=(",", ":"), ensure_ascii=False)
    now = utc_now().replace(microsecond=0).isoformat()
    with DB_LOCK:
        with sqlite3.connect(DB_PATH) as conn:
            conn.execute(
                """
                INSERT INTO app_state (state_key, state_value, updated_at)
                VALUES (?, ?, ?)
                ON CONFLICT(state_key) DO UPDATE SET
                    state_value = excluded.state_value,
                    updated_at = excluded.updated_at
                """,
                (state_key, payload, now),
            )


def db_merge_users_state(changed_users: dict[str, dict[str, object]]) -> None:
    if not changed_users:
        return
    ensure_db_ready()
    now = utc_now().replace(microsecond=0).isoformat()
    with DB_LOCK:
        with sqlite3.connect(DB_PATH) as conn:
            conn.execute("BEGIN IMMEDIATE")
            row = conn.execute(
                "SELECT state_value FROM app_state WHERE state_key = ?",
                ("users",),
            ).fetchone()
            current_users: dict[str, object] = {}
            if row and row[0]:
                try:
                    loaded = json.loads(str(row[0]))
                    if isinstance(loaded, dict):
                        current_users = loaded
                except json.JSONDecodeError:
                    current_users = {}
            current_users.update(changed_users)
            payload = json.dumps(current_users, separators=(",", ":"), ensure_ascii=False)
            conn.execute(
                """
                INSERT INTO app_state (state_key, state_value, updated_at)
                VALUES (?, ?, ?)
                ON CONFLICT(state_key) DO UPDATE SET
                    state_value = excluded.state_value,
                    updated_at = excluded.updated_at
                """,
                ("users", payload, now),
            )


def persist_users(phone_numbers: Iterable[str] | None = None) -> None:
    payload: dict[str, dict[str, object]]
    if phone_numbers is None:
        payload = {phone: user.model_dump(mode="json") for phone, user in USERS.items()}
    else:
        unique_phones = {str(phone).strip() for phone in phone_numbers if str(phone).strip()}
        payload = {
            phone: USERS[phone].model_dump(mode="json")
            for phone in unique_phones
            if phone in USERS
        }

    if PG_STORE.enabled():
        PG_STORE.persist_users(payload)
        return
    if phone_numbers is not None:
        db_merge_users_state(payload)
        return
    db_write_state("users", {phone: user.model_dump(mode="json") for phone, user in USERS.items()})


def persist_sessions() -> None:
    normalized: dict[str, dict[str, str]] = {}
    for token, raw_record in list(SESSIONS.items()):
        record = normalize_session_record(raw_record)
        if record is None:
            continue
        normalized[token] = record
    SESSIONS.clear()
    SESSIONS.update(normalized)

    if PG_STORE.enabled():
        PG_STORE.persist_sessions(SESSIONS)
        return
    db_write_state("sessions", SESSIONS)


def persist_rooms() -> None:
    if PG_STORE.enabled():
        PG_STORE.persist_rooms({stake_id: room.model_dump(mode="json") for stake_id, room in ROOMS.items()})
        return
    db_write_state("rooms", {stake_id: room.model_dump(mode="json") for stake_id, room in ROOMS.items()})


def persist_receipt_cache() -> None:
    if PG_STORE.enabled():
        PG_STORE.persist_receipts(USED_DEPOSIT_TX, USED_RECEIPT_LINKS)
        return
    db_write_state("used_deposit_tx", USED_DEPOSIT_TX)
    db_write_state("used_receipt_links", USED_RECEIPT_LINKS)


def persist_withdraw_tickets() -> None:
    if PG_STORE.enabled():
        PG_STORE.persist_withdraw_tickets([ticket.model_dump(mode="json") for ticket in WITHDRAW_TICKETS])
        return
    db_write_state("withdraw_tickets", [ticket.model_dump(mode="json") for ticket in WITHDRAW_TICKETS])


def persist_audit_events() -> None:
    if PG_STORE.enabled():
        PG_STORE.persist_audit_events([event.model_dump(mode="json") for event in AUDIT_EVENTS])
        return
    db_write_state("audit_events", [event.model_dump(mode="json") for event in AUDIT_EVENTS])


def persist_deposit_methods() -> None:
    if PG_STORE.enabled():
        PG_STORE.persist_deposit_methods([method.model_dump(mode="json") for method in DEPOSIT_METHODS])
        return
    db_write_state("deposit_methods", [method.model_dump(mode="json") for method in DEPOSIT_METHODS])


def load_persisted_state() -> None:
    global DEPOSIT_METHODS

    if PG_STORE.enabled():
        # One-time migration helper: if Postgres is empty and a SQLite snapshot exists, copy it first.
        if PG_STORE.is_empty() and DB_PATH.exists():
            sqlite_snapshot = read_sqlite_state(DB_PATH)
            users_snapshot = sqlite_snapshot.get("users")
            users_loaded = isinstance(users_snapshot, dict) and bool(users_snapshot)
            if users_loaded:
                PG_STORE.persist_users(dict(users_snapshot))
            if users_loaded and isinstance(sqlite_snapshot.get("sessions"), dict):
                PG_STORE.persist_sessions(dict(sqlite_snapshot.get("sessions", {})))
            if users_loaded and isinstance(sqlite_snapshot.get("rooms"), dict):
                PG_STORE.persist_rooms(dict(sqlite_snapshot.get("rooms", {})))
            if users_loaded and (
                isinstance(sqlite_snapshot.get("used_deposit_tx"), dict)
                or isinstance(sqlite_snapshot.get("used_receipt_links"), dict)
            ):
                PG_STORE.persist_receipts(
                    dict(sqlite_snapshot.get("used_deposit_tx", {})),
                    dict(sqlite_snapshot.get("used_receipt_links", {})),
                )
            if users_loaded and isinstance(sqlite_snapshot.get("withdraw_tickets"), list):
                PG_STORE.persist_withdraw_tickets(list(sqlite_snapshot.get("withdraw_tickets", [])))
            if isinstance(sqlite_snapshot.get("deposit_methods"), list):
                PG_STORE.persist_deposit_methods(list(sqlite_snapshot.get("deposit_methods", [])))
            if isinstance(sqlite_snapshot.get("audit_events"), list):
                PG_STORE.persist_audit_events(list(sqlite_snapshot.get("audit_events", [])))
        persisted = PG_STORE.load_all()
    else:
        persisted = {
            "users": db_read_state("users"),
            "sessions": db_read_state("sessions"),
            "rooms": db_read_state("rooms"),
            "used_deposit_tx": db_read_state("used_deposit_tx"),
            "used_receipt_links": db_read_state("used_receipt_links"),
            "withdraw_tickets": db_read_state("withdraw_tickets"),
            "deposit_methods": db_read_state("deposit_methods"),
            "audit_events": db_read_state("audit_events"),
        }

    persisted_users = persisted.get("users")
    if isinstance(persisted_users, dict):
        USERS.clear()
        for phone, raw in persisted_users.items():
            try:
                USERS[str(phone)] = UserStore.model_validate(raw)
            except Exception:
                continue

    persisted_sessions = persisted.get("sessions")
    if isinstance(persisted_sessions, dict):
        SESSIONS.clear()
        for token, raw_record in persisted_sessions.items():
            if not isinstance(token, str):
                continue
            normalized_record = normalize_session_record(raw_record)
            if normalized_record is None:
                continue
            SESSIONS[token] = normalized_record
        prune_expired_sessions(persist=False)

    persisted_rooms = persisted.get("rooms")
    if isinstance(persisted_rooms, dict):
        ROOMS.clear()
        for stake_id, raw in persisted_rooms.items():
            try:
                ROOMS[str(stake_id)] = RoomStore.model_validate(raw)
            except Exception:
                continue

    persisted_tx = persisted.get("used_deposit_tx")
    if isinstance(persisted_tx, dict):
        USED_DEPOSIT_TX.clear()
        for tx, owner in persisted_tx.items():
            if isinstance(tx, str) and isinstance(owner, str):
                USED_DEPOSIT_TX[tx] = owner

    persisted_links = persisted.get("used_receipt_links")
    if isinstance(persisted_links, dict):
        USED_RECEIPT_LINKS.clear()
        for link, owner in persisted_links.items():
            if isinstance(link, str) and isinstance(owner, str):
                USED_RECEIPT_LINKS[link] = owner

    persisted_tickets = persisted.get("withdraw_tickets")
    if isinstance(persisted_tickets, list):
        WITHDRAW_TICKETS.clear()
        for raw in persisted_tickets:
            try:
                ticket = WithdrawTicket.model_validate(raw)
                normalize_withdraw_ticket_status(ticket)
                WITHDRAW_TICKETS.append(ticket)
            except Exception:
                continue

    persisted_methods = persisted.get("deposit_methods")
    if isinstance(persisted_methods, list):
        methods: list[DepositMethod] = []
        for raw in persisted_methods:
            try:
                methods.append(DepositMethod.model_validate(raw))
            except Exception:
                continue
        if methods:
            DEPOSIT_METHODS = methods

    persisted_audit_events = persisted.get("audit_events")
    if isinstance(persisted_audit_events, list):
        AUDIT_EVENTS.clear()
        for raw in persisted_audit_events:
            try:
                AUDIT_EVENTS.append(AuditEvent.model_validate(raw))
            except Exception:
                continue


def utc_now() -> datetime:
    return datetime.now(tz=timezone.utc)


def normalize_phone(phone_number: str) -> str:
    value = re.sub(r"[\s\-\(\)]", "", phone_number.strip())
    if value.startswith("2519") and len(value) == 12:
        return "0" + value[3:]
    if value.startswith("9") and len(value) == 9:
        return "0" + value
    if value.startswith("+2519") and len(value) == 13:
        return "0" + value[4:]
    return value


def phone_variants(phone_number: str) -> list[str]:
    cleaned = re.sub(r"[\s\-\(\)]", "", phone_number.strip())
    variants: list[str] = []

    def add(value: str) -> None:
        if value and value not in variants:
            variants.append(value)

    add(cleaned)
    add(normalize_phone(cleaned))

    normalized = normalize_phone(cleaned)
    if normalized.startswith("09") and len(normalized) == 10:
        add("+251" + normalized[1:])
    if cleaned.startswith("+2519") and len(cleaned) == 13:
        add(cleaned[1:])  # 2519...
    if cleaned.startswith("2519") and len(cleaned) == 12:
        add("+2519" + cleaned[4:])
    if cleaned.startswith("9") and len(cleaned) == 9:
        add("+251" + cleaned)
    return variants


def find_user_by_phone(phone_number: str) -> UserStore | None:
    matched: UserStore | None = None
    for candidate in phone_variants(phone_number):
        user = USERS.get(candidate)
        if user is not None:
            matched = user
            break

    if matched is None:
        normalized = normalize_phone(phone_number)
        for user in USERS.values():
            if normalize_phone(user.phone_number) == normalized:
                matched = user
                break

    if matched is None:
        return None

    if IS_PRODUCTION_ENV:
        latest_user = refresh_user_from_primary_store(matched.phone_number)
        if latest_user is not None:
            return latest_user

    return matched


def parse_iso_datetime(value: str | None) -> datetime | None:
    if not value:
        return None
    try:
        parsed = datetime.fromisoformat(value)
    except ValueError:
        return None
    if parsed.tzinfo is None:
        return parsed.replace(tzinfo=timezone.utc)
    return parsed.astimezone(timezone.utc)


def is_bootstrap_admin_phone(phone_number: str) -> bool:
    if not ADMIN_BOOTSTRAP_PHONES:
        return False
    normalized = normalize_phone(phone_number)
    return normalized in {normalize_phone(candidate) for candidate in ADMIN_BOOTSTRAP_PHONES}


def apply_admin_bootstrap() -> None:
    if not ADMIN_BOOTSTRAP_PHONES:
        return
    changed_phones: set[str] = set()
    for raw_phone in ADMIN_BOOTSTRAP_PHONES:
        phone = normalize_phone(raw_phone)
        user = USERS.get(phone)
        if user and not user.is_admin:
            user.is_admin = True
            changed_phones.add(phone)
    if changed_phones:
        persist_users(changed_phones)


def apply_default_deposit_logos() -> None:
    changed = False
    for method in DEPOSIT_METHODS:
        desired_logo = DEFAULT_DEPOSIT_LOGOS.get(method.code)
        if not desired_logo:
            continue
        if method.logo_url != desired_logo:
            method.logo_url = desired_logo
            changed = True
    if changed:
        persist_deposit_methods()


def create_session_record(phone_number: str) -> dict[str, str]:
    now = utc_now()
    expires_at = now + timedelta(seconds=SESSION_TTL_SECONDS)
    return {
        "phone_number": phone_number,
        "created_at": now.replace(microsecond=0).isoformat(),
        "expires_at": expires_at.replace(microsecond=0).isoformat(),
    }


def normalize_session_record(record: object) -> dict[str, str] | None:
    # Backward compatibility: old snapshots stored token -> phone_number as a plain string.
    if isinstance(record, str):
        return create_session_record(record)
    if isinstance(record, dict):
        phone = record.get("phone_number")
        if not isinstance(phone, str) or not phone:
            return None
        expires_at = record.get("expires_at")
        created_at = record.get("created_at")
        if not isinstance(expires_at, str) or parse_iso_datetime(expires_at) is None:
            expires_at = (utc_now() + timedelta(seconds=SESSION_TTL_SECONDS)).replace(microsecond=0).isoformat()
        if not isinstance(created_at, str) or parse_iso_datetime(created_at) is None:
            created_at = utc_now().replace(microsecond=0).isoformat()
        return {
            "phone_number": phone,
            "created_at": created_at,
            "expires_at": expires_at,
        }
    return None


def prune_expired_sessions(persist: bool = True) -> None:
    now = utc_now()
    expired_tokens: list[str] = []
    for token, record in list(SESSIONS.items()):
        normalized = normalize_session_record(record)
        if normalized is None:
            expired_tokens.append(token)
            continue
        expires_at = parse_iso_datetime(normalized.get("expires_at"))
        if expires_at is None or now >= expires_at:
            expired_tokens.append(token)
            continue
        SESSIONS[token] = normalized

    if expired_tokens:
        for token in expired_tokens:
            SESSIONS.pop(token, None)
        if persist:
            persist_sessions()


def verify_transfer_otp(phone_number: str, otp: str) -> bool:
    if not TRANSFER_OTP_VERIFY_URL:
        return False

    payload = json.dumps(
        {
            "phone_number": normalize_phone(phone_number),
            "otp": otp.strip(),
            "context": "wallet_transfer",
        }
    ).encode("utf-8")

    request = UrlRequest(
        TRANSFER_OTP_VERIFY_URL,
        data=payload,
        headers={"Content-Type": "application/json"},
        method="POST",
    )

    try:
        with urlopen(request, timeout=TRANSFER_OTP_VERIFY_TIMEOUT_SECONDS) as response:
            body = response.read().decode("utf-8", errors="ignore")
    except Exception:
        return False

    try:
        data = json.loads(body) if body else {}
    except json.JSONDecodeError:
        return False

    return bool(data.get("valid") is True or str(data.get("status", "")).lower() in {"approved", "ok", "valid"})


def normalize_withdraw_ticket_status(ticket: WithdrawTicket) -> None:
    # Backward compatibility for older snapshots where "Approved" meant final payout.
    if ticket.status == "Approved":
        ticket.status = "Paid"


def send_smtp_message(msg: EmailMessage, *, context_label: str) -> bool:
    try:
        recipients = [email for _, email in getaddresses(msg.get_all("To", [])) if email]
        if not recipients:
            print(f"Failed to send {context_label}: no recipients")
            return False
        tls_context = ssl.create_default_context()
        if SMTP_USE_SSL:
            with smtplib.SMTP_SSL(SMTP_HOST, SMTP_PORT, timeout=15) as smtp:
                smtp.ehlo()
                if SMTP_USERNAME:
                    smtp.login(SMTP_USERNAME, SMTP_PASSWORD)
                refused = smtp.send_message(msg)
        else:
            with smtplib.SMTP(SMTP_HOST, SMTP_PORT, timeout=15) as smtp:
                smtp.ehlo()
                if SMTP_USE_TLS:
                    smtp.starttls(context=tls_context)
                    smtp.ehlo()
                if SMTP_USERNAME:
                    smtp.login(SMTP_USERNAME, SMTP_PASSWORD)
                refused = smtp.send_message(msg)
        if isinstance(refused, dict) and refused:
            if len(refused) >= len(recipients):
                print(f"Failed to send {context_label}: all recipients refused {list(refused.keys())}")
                return False
            print(f"Partial delivery for {context_label}: refused recipients {list(refused.keys())}")
        return True
    except Exception as exc:
        print(f"Failed to send {context_label}: {exc}")
        return False


def send_admin_withdraw_email(ticket: WithdrawTicket) -> bool:
    recipients = build_alert_recipients()
    if not recipients or not SMTP_HOST:
        return False

    alert_phones = ", ".join(WITHDRAW_ALERT_PHONES) if WITHDRAW_ALERT_PHONES else "-"
    subject = f"[40bingo] Withdraw request {ticket.id} needs manual payout"
    body = (
        "A user submitted a withdraw request.\n\n"
        f"Request ID: {ticket.id}\n"
        f"Audit Event: withdraw_requested\n"
        f"User: {ticket.user_name}\n"
        f"Phone: {ticket.phone_number}\n"
        f"Bank: {ticket.bank}\n"
        f"Account Number: {ticket.account_number}\n"
        f"Account Holder: {ticket.account_holder}\n"
        f"Amount: ETB {ticket.amount:.2f}\n"
        f"Created At: {ticket.created_at}\n\n"
        f"Operational Alert Phones: {alert_phones}\n"
        f"Routed SMTP Recipients: {', '.join(recipients)}\n\n"
        "Action required:\n"
        "1) Send bank transfer manually from company account.\n"
        "2) Open Admin > Withdraw Requests.\n"
        "3) Move to Processing, then Mark Paid with transfer reference.\n"
    )

    msg = EmailMessage()
    msg["Subject"] = subject
    msg["From"] = SMTP_FROM
    msg["To"] = ", ".join(recipients)
    msg.set_content(body)
    return send_smtp_message(msg, context_label=f"withdraw alert email for ticket {ticket.id}")


def send_admin_withdraw_paid_email(ticket: WithdrawTicket) -> bool:
    recipients = build_alert_recipients()
    if not recipients or not SMTP_HOST:
        return False

    alert_phones = ", ".join(WITHDRAW_ALERT_PHONES) if WITHDRAW_ALERT_PHONES else "-"
    subject = f"[40bingo] Withdraw payout completed: {ticket.id}"
    body = (
        "A withdraw request has been marked as PAID.\n\n"
        f"Request ID: {ticket.id}\n"
        f"Audit Event: withdraw_paid\n"
        f"User: {ticket.user_name}\n"
        f"Phone: {ticket.phone_number}\n"
        f"Bank: {ticket.bank}\n"
        f"Account Number: {ticket.account_number}\n"
        f"Account Holder: {ticket.account_holder}\n"
        f"Amount: ETB {ticket.amount:.2f}\n"
        f"Paid At: {ticket.paid_at or '-'}\n"
        f"Paid By: {ticket.paid_by or '-'}\n"
        f"Payout Reference: {ticket.payout_reference or '-'}\n"
        f"Admin Note: {ticket.admin_note or '-'}\n"
        f"Operational Alert Phones: {alert_phones}\n"
        f"Routed SMTP Recipients: {', '.join(recipients)}\n"
    )

    msg = EmailMessage()
    msg["Subject"] = subject
    msg["From"] = SMTP_FROM
    msg["To"] = ", ".join(recipients)
    msg.set_content(body)
    return send_smtp_message(msg, context_label=f"withdraw paid email for ticket {ticket.id}")


def hash_password(raw_password: str) -> str:
    salt = secrets.token_hex(16)
    digest = hashlib.pbkdf2_hmac("sha256", raw_password.encode("utf-8"), salt.encode("utf-8"), 150000)
    return f"{salt}${digest.hex()}"


def verify_password(raw_password: str, stored_hash: str) -> bool:
    try:
        salt, digest_hex = stored_hash.split("$", maxsplit=1)
    except ValueError:
        # Legacy support for older snapshots that stored plaintext passwords.
        return hmac.compare_digest(raw_password, stored_hash)
    check = hashlib.pbkdf2_hmac("sha256", raw_password.encode("utf-8"), salt.encode("utf-8"), 150000).hex()
    return hmac.compare_digest(check, digest_hex)


def create_referral_code() -> str:
    used = {user.referral_code for user in USERS.values()}
    while True:
        code = "".join(str(randint(0, 9)) for _ in range(6))
        if code not in used:
            return code


def generate_phone_for_telegram_user(telegram_id: int) -> str:
    seed = int(str(abs(telegram_id))[-8:]) if telegram_id else randint(10000000, 99999999)
    attempts = 0
    while attempts < 1000:
        phone = f"09{(seed + attempts) % 100000000:08d}"
        existing = USERS.get(phone)
        if not existing or existing.telegram_id == telegram_id:
            return phone
        attempts += 1
    raise HTTPException(status_code=500, detail="Unable to allocate a phone number for Telegram account.")


def verify_telegram_init_data(init_data: str) -> dict:
    if not TELEGRAM_BOT_TOKEN:
        raise HTTPException(status_code=500, detail="Telegram bot token is not configured on server.")

    parsed_items = dict(parse_qsl(init_data, keep_blank_values=True))
    hash_value = parsed_items.pop("hash", None)
    if not hash_value:
        raise HTTPException(status_code=401, detail="Invalid Telegram initData: missing hash.")

    data_check_string = "\n".join(f"{key}={value}" for key, value in sorted(parsed_items.items()))
    secret_key = hmac.new(b"WebAppData", TELEGRAM_BOT_TOKEN.encode("utf-8"), hashlib.sha256).digest()
    expected_hash = hmac.new(secret_key, data_check_string.encode("utf-8"), hashlib.sha256).hexdigest()
    if not hmac.compare_digest(expected_hash, hash_value):
        raise HTTPException(status_code=401, detail="Invalid Telegram initData signature.")

    user_raw = parsed_items.get("user")
    if not user_raw:
        raise HTTPException(status_code=401, detail="Invalid Telegram initData: missing user.")
    try:
        user_data = json.loads(user_raw)
    except json.JSONDecodeError as exc:
        raise HTTPException(status_code=401, detail="Invalid Telegram user payload.") from exc

    if "id" not in user_data:
        raise HTTPException(status_code=401, detail="Invalid Telegram user payload: missing id.")

    auth_date_raw = parsed_items.get("auth_date")
    if auth_date_raw and auth_date_raw.isdigit():
        auth_ts = int(auth_date_raw)
        if abs(int(utc_now().timestamp()) - auth_ts) > 60 * 60 * 24:
            raise HTTPException(status_code=401, detail="Expired Telegram session payload.")

    return user_data


def make_public_user(user: UserStore) -> UserPublic:
    return UserPublic(
        user_name=user.user_name,
        phone_number=user.phone_number,
        referral_code=user.referral_code,
        is_admin=user.is_admin,
    )


def can_manage_deposit_accounts(user: UserStore) -> bool:
    return bool(user.is_admin)


def require_admin_user(user: UserStore) -> None:
    if not can_manage_deposit_accounts(user):
        raise HTTPException(status_code=403, detail="Admin access required")


def find_deposit_method(method_code: Literal["telebirr", "cbebirr"]) -> DepositMethod:
    method = next((item for item in DEPOSIT_METHODS if item.code == method_code), None)
    if method is None:
        raise HTTPException(status_code=404, detail="Deposit method not found")
    return method


def get_casino_game_or_404(game_id: str) -> CasinoGameItem:
    normalized_game_id = game_id.strip().lower()
    game = next((item for item in CASINO_GAMES if item.id == normalized_game_id), None)
    if game is None:
        raise HTTPException(status_code=404, detail="Casino game not found")
    return game


def roll_casino_multiplier(game_id: str) -> float:
    payout_table = CASINO_PAYOUT_TABLES.get(game_id, [(1.0, 0.0)])
    roll = randint(1, 1_000_000) / 1_000_000
    cumulative = 0.0
    for chance, multiplier in payout_table:
        cumulative += max(0.0, chance)
        if roll <= cumulative:
            return max(0.0, multiplier)
    return max(0.0, payout_table[-1][1])


def read_nested_str(payload: object, dotted_key: str) -> str | None:
    value: object = payload
    for part in dotted_key.split("."):
        if not isinstance(value, dict):
            return None
        value = value.get(part)
    if isinstance(value, str):
        cleaned = value.strip()
        if cleaned:
            return cleaned
    return None


def normalize_casino_launch_mode(mode_value: str | None) -> Literal["iframe", "redirect"]:
    mode = (mode_value or "").strip().lower()
    return "iframe" if mode == "iframe" else "redirect"


def sanitize_casino_return_url(return_url: str | None) -> str | None:
    if not return_url:
        return None
    candidate = return_url.strip()
    if not candidate:
        return None
    parsed = urlparse(candidate)
    if parsed.scheme not in {"http", "https"}:
        return None
    hostname = (parsed.hostname or "").lower()
    if CASINO_ALLOWED_RETURN_HOSTS and hostname not in CASINO_ALLOWED_RETURN_HOSTS:
        return None
    return candidate


def prune_expired_casino_launches() -> None:
    now = utc_now()
    expired: list[str] = []
    for launch_id, raw in list(CASINO_LAUNCH_SESSIONS.items()):
        expires_at = parse_iso_datetime(raw.get("expires_at"))
        if expires_at is None or expires_at <= now:
            expired.append(launch_id)
    for launch_id in expired:
        CASINO_LAUNCH_SESSIONS.pop(launch_id, None)


def get_casino_launch_session_or_404(launch_id: str) -> dict[str, str]:
    prune_expired_casino_launches()
    launch = CASINO_LAUNCH_SESSIONS.get(launch_id)
    if launch is None:
        raise HTTPException(status_code=404, detail="Casino launch session expired")
    expires_at = parse_iso_datetime(launch.get("expires_at"))
    if expires_at is None or expires_at <= utc_now():
        CASINO_LAUNCH_SESSIONS.pop(launch_id, None)
        raise HTTPException(status_code=404, detail="Casino launch session expired")
    return launch


def build_selfhosted_casino_launch_url(request: Request, game: CasinoGameItem, launch_id: str) -> str:
    base = str(request.base_url).rstrip("/")
    return f"{base}/casino/selfhosted/{game.id}?launch_id={launch_id}"


def build_selfhosted_game_html(game: CasinoGameItem, launch_id: str) -> str:
    template = """<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <title>__TITLE__</title>
  <style>
    :root {
      --bg: #090d19;
      --panel: #121a2d;
      --ink: #edf2ff;
      --muted: #b8c3de;
      --accent: #ffd400;
      --accent-ink: #4a1570;
      --danger: #ff5a74;
      --ok: #4ad17f;
      --soft: #1c2744;
      --cell: #1b2540;
      --cell-hit: #2879ff;
    }
    * { box-sizing: border-box; }
    body {
      margin: 0;
      min-height: 100vh;
      background: radial-gradient(circle at 20% -20%, rgba(255, 212, 0, 0.18), transparent 36%), var(--bg);
      color: var(--ink);
      font-family: Segoe UI, Arial, sans-serif;
    }
    .wrap {
      min-height: 100vh;
      display: grid;
      grid-template-rows: auto 1fr auto;
      gap: 10px;
      padding: 12px;
    }
    .top {
      display: grid;
      gap: 8px;
      background: var(--panel);
      border: 1px solid rgba(255,255,255,0.12);
      border-radius: 14px;
      padding: 12px;
    }
    .title {
      display: flex;
      justify-content: space-between;
      align-items: center;
      gap: 8px;
    }
    .title h1 {
      margin: 0;
      font-size: clamp(1.1rem, 4.6vw, 1.5rem);
    }
    .provider {
      font-size: 0.8rem;
      color: var(--muted);
    }
    .meta {
      display: flex;
      flex-wrap: wrap;
      gap: 8px;
      color: var(--muted);
      font-size: 0.88rem;
    }
    .meta span {
      background: rgba(255,255,255,0.07);
      border-radius: 999px;
      padding: 6px 10px;
    }
    .play {
      background: var(--panel);
      border: 1px solid rgba(255,255,255,0.12);
      border-radius: 14px;
      padding: 12px;
      display: grid;
      gap: 10px;
      align-content: start;
    }
    .play-grid {
      display: grid;
      grid-template-columns: 1fr auto;
      gap: 8px;
      align-items: end;
    }
    .play label {
      display: grid;
      gap: 6px;
      color: var(--muted);
      font-size: 0.88rem;
    }
    .play input, .play select {
      border: 1px solid rgba(255,255,255,0.18);
      border-radius: 10px;
      background: #f8fbff;
      color: #161b29;
      padding: 10px 12px;
      font-size: 1rem;
      width: 100%;
    }
    .btn {
      border: 0;
      border-radius: 10px;
      padding: 10px 14px;
      font-weight: 700;
      cursor: pointer;
      background: var(--accent);
      color: var(--accent-ink);
      min-width: 108px;
      height: 44px;
    }
    .btn:disabled {
      opacity: 0.65;
      cursor: not-allowed;
    }
    .game-options {
      display: grid;
      gap: 8px;
    }
    .game-options.row {
      grid-template-columns: repeat(2, minmax(0, 1fr));
    }
    .stage {
      margin-top: 4px;
      border-radius: 14px;
      border: 1px solid rgba(255,255,255,0.12);
      background: linear-gradient(170deg, #172344, #111a34);
      min-height: 230px;
      display: grid;
      place-items: center;
      text-align: center;
      padding: 12px;
    }
    .wallet {
      font-size: 0.95rem;
      color: var(--muted);
    }
    .wallet strong {
      color: var(--ink);
      font-size: 1.15rem;
    }
    .msg {
      border-radius: 10px;
      padding: 10px;
      font-weight: 600;
      font-size: 0.95rem;
      background: rgba(255,255,255,0.05);
    }
    .msg.ok { color: var(--ok); border: 1px solid rgba(74,209,127,0.45); }
    .msg.err { color: var(--danger); border: 1px solid rgba(255,90,116,0.45); }
    .result-line {
      color: var(--muted);
      font-size: 0.9rem;
      text-align: center;
      min-height: 20px;
    }
    .slot-grid {
      display: grid;
      grid-template-columns: repeat(5, minmax(0, 1fr));
      gap: 6px;
      width: 100%;
      max-width: 360px;
    }
    .slot-cell {
      background: var(--cell);
      border: 1px solid rgba(255,255,255,0.14);
      border-radius: 10px;
      min-height: 52px;
      display: grid;
      place-items: center;
      font-size: 1.3rem;
      font-weight: 700;
    }
    .slot-cell.hit {
      background: var(--cell-hit);
      border-color: rgba(255,255,255,0.38);
    }
    .roulette-wheel {
      width: clamp(180px, 52vw, 240px);
      aspect-ratio: 1;
      border-radius: 999px;
      border: 10px solid #7d90c6;
      background: conic-gradient(#0e1a33 0 20deg, #992f2f 20deg 40deg, #1f1f1f 40deg 60deg, #992f2f 60deg 80deg, #1f1f1f 80deg 100deg, #992f2f 100deg 120deg, #1f1f1f 120deg 140deg, #992f2f 140deg 160deg, #1f1f1f 160deg 180deg, #992f2f 180deg 200deg, #1f1f1f 200deg 220deg, #992f2f 220deg 240deg, #1f1f1f 240deg 260deg, #992f2f 260deg 280deg, #1f1f1f 280deg 300deg, #992f2f 300deg 320deg, #1f1f1f 320deg 340deg, #992f2f 340deg 360deg);
      display: grid;
      place-items: center;
      position: relative;
    }
    .roulette-center {
      width: 64px;
      height: 64px;
      border-radius: 999px;
      background: #f5f7ff;
      color: #0f1730;
      display: grid;
      place-items: center;
      font-size: 1.3rem;
      font-weight: 800;
    }
    .table-hands {
      width: 100%;
      display: grid;
      gap: 8px;
      max-width: 420px;
    }
    .hand-row {
      background: rgba(255,255,255,0.06);
      border: 1px solid rgba(255,255,255,0.12);
      border-radius: 10px;
      padding: 8px;
      text-align: left;
      font-size: 0.95rem;
    }
    .crash-meter {
      width: min(92%, 360px);
      height: 20px;
      border-radius: 999px;
      background: rgba(255,255,255,0.1);
      overflow: hidden;
      border: 1px solid rgba(255,255,255,0.16);
    }
    .crash-fill {
      height: 100%;
      width: 0%;
      background: linear-gradient(90deg, #3cd88d, #ffdc4d);
      transition: width 0.4s ease;
    }
    .crash-multi {
      margin-top: 10px;
      font-size: clamp(1.4rem, 8vw, 2.4rem);
      font-weight: 800;
    }
    .mines-grid {
      display: grid;
      grid-template-columns: repeat(5, minmax(0, 1fr));
      gap: 6px;
      width: min(92vw, 360px);
    }
    .mine-cell {
      border-radius: 8px;
      background: #26345f;
      border: 1px solid rgba(255,255,255,0.16);
      min-height: 44px;
      display: grid;
      place-items: center;
      font-size: 1rem;
      font-weight: 700;
    }
    .mine-cell.hit {
      background: #2a9158;
    }
    .mine-cell.boom {
      background: #b53e53;
    }
    .hilo-cards {
      display: flex;
      gap: 14px;
      align-items: center;
      justify-content: center;
    }
    .card {
      width: 82px;
      aspect-ratio: 3 / 4;
      border-radius: 10px;
      background: #f6f8ff;
      color: #10172d;
      display: grid;
      place-items: center;
      font-size: 1.4rem;
      font-weight: 800;
    }
    .dice-wrap {
      display: flex;
      gap: 10px;
      justify-content: center;
      align-items: center;
    }
    .dice {
      width: 66px;
      height: 66px;
      border-radius: 12px;
      border: 1px solid rgba(255,255,255,0.2);
      background: #f5f7ff;
      color: #0f162b;
      display: grid;
      place-items: center;
      font-size: 2rem;
      font-weight: 700;
    }
    .foot {
      color: var(--muted);
      font-size: 0.82rem;
      text-align: center;
      padding-bottom: 4px;
    }
  </style>
</head>
<body>
  <div class="wrap">
    <section class="top">
      <div class="title">
        <h1>__TITLE__</h1>
        <span class="provider">__PROVIDER__</span>
      </div>
      <div class="meta">
        <span>Volatility: __VOLATILITY__</span>
        <span>Min Bet: ETB __MIN_BET__</span>
        <span>Max Bet: ETB __MAX_BET__</span>
        <span>Max Win: x__MAX_MULTIPLIER__</span>
      </div>
    </section>

    <section class="play">
      <p style="margin:0;color:var(--muted)">__DESCRIPTION__</p>
      <div class="play-grid">
        <label>
          Stake (ETB)
          <input id="stakeInput" type="number" min="__MIN_BET__" max="__MAX_BET__" step="0.01" value="__MIN_BET__" />
        </label>
        <button id="playBtn" class="btn" type="button">Play</button>
      </div>
      <div id="gameOptions" class="game-options"></div>
      <div class="wallet">Wallet Balance: ETB <strong id="walletValue">--</strong></div>
      <div id="message" class="msg">Configure your round and press Play.</div>
      <div id="stage" class="stage"></div>
      <div id="resultLine" class="result-line">Waiting for your first round...</div>
    </section>

    <div class="foot">Self-hosted mode. Payout settles from 40bingo wallet in real-time.</div>
  </div>
  <script>
    const launchId = "__LAUNCH_ID__";
    const gameId = "__GAME_ID__";
    const minBet = Number("__MIN_BET__");
    const maxBet = Number("__MAX_BET__");
    const stakeInput = document.getElementById("stakeInput");
    const playBtn = document.getElementById("playBtn");
    const walletValue = document.getElementById("walletValue");
    const message = document.getElementById("message");
    const resultLine = document.getElementById("resultLine");
    const stage = document.getElementById("stage");
    const gameOptions = document.getElementById("gameOptions");
    const state = {
      rouletteBet: "red",
      rouletteNumber: 17,
      baccaratBet: "player",
      hiloPick: "high",
      dicePick: "over",
      diceExact: 7,
      minesCount: 3,
    };

    const symbols = ["7", "A", "K", "Q", "J", "$", "#", "*"];
    const cards = ["A", "2", "3", "4", "5", "6", "7", "8", "9", "10", "J", "Q", "K"];
    const diceFaces = ["1", "2", "3", "4", "5", "6"];

    function setMessage(text, tone) {
      message.textContent = text;
      message.className = "msg " + (tone || "");
    }

    function randInt(min, max) {
      return Math.floor(Math.random() * (max - min + 1)) + min;
    }

    function randomCard() {
      return cards[randInt(0, cards.length - 1)];
    }

    function renderOptions() {
      if (gameId === "roulette-euro") {
        gameOptions.className = "game-options row";
        gameOptions.innerHTML = `
          <label>Bet Type
            <select id="rouletteBet">
              <option value="red">Red</option>
              <option value="black">Black</option>
              <option value="odd">Odd</option>
              <option value="even">Even</option>
              <option value="number">Exact Number</option>
            </select>
          </label>
          <label>Number (0-36)
            <input id="rouletteNumber" type="number" min="0" max="36" value="17" />
          </label>
        `;
        const bet = document.getElementById("rouletteBet");
        const num = document.getElementById("rouletteNumber");
        bet.addEventListener("change", () => {
          state.rouletteBet = bet.value;
        });
        num.addEventListener("input", () => {
          state.rouletteNumber = Math.max(0, Math.min(36, Number(num.value || 0)));
        });
        return;
      }
      if (gameId === "baccarat-royal") {
        gameOptions.className = "game-options";
        gameOptions.innerHTML = `
          <label>Bet Side
            <select id="baccaratBet">
              <option value="player">Player</option>
              <option value="banker">Banker</option>
              <option value="tie">Tie</option>
            </select>
          </label>
        `;
        const select = document.getElementById("baccaratBet");
        select.addEventListener("change", () => {
          state.baccaratBet = select.value;
        });
        return;
      }
      if (gameId === "hilo-cards") {
        gameOptions.className = "game-options";
        gameOptions.innerHTML = `
          <label>Pick Direction
            <select id="hiloPick">
              <option value="high">High</option>
              <option value="low">Low</option>
            </select>
          </label>
        `;
        const select = document.getElementById("hiloPick");
        select.addEventListener("change", () => {
          state.hiloPick = select.value;
        });
        return;
      }
      if (gameId === "lucky-dice") {
        gameOptions.className = "game-options row";
        gameOptions.innerHTML = `
          <label>Prediction
            <select id="dicePick">
              <option value="over">Over 7</option>
              <option value="under">Under 7</option>
              <option value="exact">Exact 7</option>
            </select>
          </label>
          <label>Exact Total
            <input id="diceExact" type="number" min="2" max="12" value="7" />
          </label>
        `;
        const pick = document.getElementById("dicePick");
        const exact = document.getElementById("diceExact");
        pick.addEventListener("change", () => {
          state.dicePick = pick.value;
        });
        exact.addEventListener("input", () => {
          state.diceExact = Math.max(2, Math.min(12, Number(exact.value || 7)));
        });
        return;
      }
      if (gameId === "mines-grid") {
        gameOptions.className = "game-options";
        gameOptions.innerHTML = `
          <label>Mines Count
            <select id="minesCount">
              <option value="3">3 Mines</option>
              <option value="5">5 Mines</option>
              <option value="7">7 Mines</option>
            </select>
          </label>
        `;
        const select = document.getElementById("minesCount");
        select.addEventListener("change", () => {
          state.minesCount = Number(select.value || "3");
        });
        return;
      }
      gameOptions.className = "game-options";
      gameOptions.innerHTML = "";
    }

    function renderIdleStage() {
      if (gameId === "slots-megaways") {
        stage.innerHTML = `
          <div class="slot-grid">
            ${Array.from({ length: 10 }, () => `<div class="slot-cell">?</div>`).join("")}
          </div>
        `;
        return;
      }
      if (gameId === "roulette-euro") {
        stage.innerHTML = `
          <div>
            <div class="roulette-wheel"><div class="roulette-center">0</div></div>
            <div style="margin-top:10px;color:var(--muted)">Place bet and spin.</div>
          </div>
        `;
        return;
      }
      if (gameId === "blackjack-classic") {
        stage.innerHTML = `
          <div class="table-hands">
            <div class="hand-row"><strong>Dealer:</strong> ? ?</div>
            <div class="hand-row"><strong>You:</strong> ? ?</div>
          </div>
        `;
        return;
      }
      if (gameId === "baccarat-royal") {
        stage.innerHTML = `
          <div class="table-hands">
            <div class="hand-row"><strong>Player:</strong> ? ?</div>
            <div class="hand-row"><strong>Banker:</strong> ? ?</div>
          </div>
        `;
        return;
      }
      if (gameId === "crash-orbit") {
        stage.innerHTML = `
          <div>
            <div class="crash-meter"><div id="crashFill" class="crash-fill"></div></div>
            <div id="crashMulti" class="crash-multi">x1.00</div>
          </div>
        `;
        return;
      }
      if (gameId === "mines-grid") {
        stage.innerHTML = `
          <div class="mines-grid">
            ${Array.from({ length: 25 }, () => `<div class="mine-cell">?</div>`).join("")}
          </div>
        `;
        return;
      }
      if (gameId === "hilo-cards") {
        stage.innerHTML = `
          <div class="hilo-cards">
            <div class="card">?</div>
            <div style="font-size:1.4rem;color:var(--muted)">-></div>
            <div class="card">?</div>
          </div>
        `;
        return;
      }
      if (gameId === "lucky-dice") {
        stage.innerHTML = `
          <div class="dice-wrap">
            <div class="dice">?</div>
            <div class="dice">?</div>
          </div>
        `;
        return;
      }
      stage.innerHTML = `<div style="color:var(--muted)">Ready.</div>`;
    }

    function renderOutcomeVisual(payload) {
      const net = Number(payload?.result?.net ?? 0);
      const isWin = net >= 0;

      if (gameId === "slots-megaways") {
        const baseSymbol = symbols[randInt(0, symbols.length - 1)];
        const cells = Array.from({ length: 10 }, (_, idx) => {
          const symbol = isWin && idx < 4 ? baseSymbol : symbols[randInt(0, symbols.length - 1)];
          const klass = isWin && idx < 4 ? "slot-cell hit" : "slot-cell";
          return `<div class="${klass}">${symbol}</div>`;
        }).join("");
        stage.innerHTML = `<div class="slot-grid">${cells}</div>`;
        return;
      }

      if (gameId === "roulette-euro") {
        const landed = randInt(0, 36);
        stage.innerHTML = `
          <div>
            <div class="roulette-wheel"><div class="roulette-center">${landed}</div></div>
            <div style="margin-top:10px;color:${isWin ? "var(--ok)" : "var(--danger)"}">${isWin ? "Winning spin" : "No hit this spin"}</div>
          </div>
        `;
        return;
      }

      if (gameId === "blackjack-classic") {
        const dealer = `${randomCard()} ${randomCard()}`;
        const player = `${randomCard()} ${randomCard()} ${isWin ? randomCard() : ""}`.trim();
        stage.innerHTML = `
          <div class="table-hands">
            <div class="hand-row"><strong>Dealer:</strong> ${dealer}</div>
            <div class="hand-row"><strong>You:</strong> ${player}</div>
            <div class="hand-row" style="color:${isWin ? "var(--ok)" : "var(--danger)"}"><strong>${isWin ? "Blackjack flow won" : "Dealer took the hand"}</strong></div>
          </div>
        `;
        return;
      }

      if (gameId === "baccarat-royal") {
        const player = `${randomCard()} ${randomCard()}`;
        const banker = `${randomCard()} ${randomCard()}`;
        stage.innerHTML = `
          <div class="table-hands">
            <div class="hand-row"><strong>Player:</strong> ${player}</div>
            <div class="hand-row"><strong>Banker:</strong> ${banker}</div>
            <div class="hand-row" style="color:${isWin ? "var(--ok)" : "var(--danger)"}"><strong>${isWin ? "Your side won" : "Your side lost"}</strong></div>
          </div>
        `;
        return;
      }

      if (gameId === "crash-orbit") {
        const target = Math.max(1, Number(payload?.result?.multiplier ?? 1));
        stage.innerHTML = `
          <div>
            <div class="crash-meter"><div id="crashFill" class="crash-fill"></div></div>
            <div id="crashMulti" class="crash-multi">x1.00</div>
          </div>
        `;
        const fill = document.getElementById("crashFill");
        const multi = document.getElementById("crashMulti");
        const pct = Math.max(8, Math.min(100, (target / Math.max(2, Number("__MAX_MULTIPLIER__"))) * 100));
        fill.style.width = pct.toFixed(0) + "%";
        multi.textContent = "x" + target.toFixed(2);
        return;
      }

      if (gameId === "mines-grid") {
        const hitCount = isWin ? randInt(10, 18) : randInt(3, 8);
        const boomAt = isWin ? -1 : randInt(0, 24);
        const cells = Array.from({ length: 25 }, (_, idx) => {
          if (idx === boomAt) return `<div class="mine-cell boom">X</div>`;
          if (idx < hitCount) return `<div class="mine-cell hit">V</div>`;
          return `<div class="mine-cell">?</div>`;
        }).join("");
        stage.innerHTML = `<div class="mines-grid">${cells}</div>`;
        return;
      }

      if (gameId === "hilo-cards") {
        stage.innerHTML = `
          <div class="hilo-cards">
            <div class="card">${randomCard()}</div>
            <div style="font-size:1.4rem;color:${isWin ? "var(--ok)" : "var(--danger)"}">${state.hiloPick === "high" ? "UP" : "DOWN"}</div>
            <div class="card">${randomCard()}</div>
          </div>
        `;
        return;
      }

      if (gameId === "lucky-dice") {
        const d1 = randInt(1, 6);
        const d2 = randInt(1, 6);
        stage.innerHTML = `
          <div>
            <div class="dice-wrap">
              <div class="dice">${diceFaces[d1 - 1]}</div>
              <div class="dice">${diceFaces[d2 - 1]}</div>
            </div>
            <div style="margin-top:8px;color:${isWin ? "var(--ok)" : "var(--danger)"}">Total ${d1 + d2}</div>
          </div>
        `;
        return;
      }
    }

    async function settleRound(stake) {
      const response = await fetch("/api/casino/play-launch", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ launch_id: launchId, stake }),
      });
      const payload = await response.json();
      if (!response.ok) {
        throw new Error(payload?.detail || "Unable to play round.");
      }
      return payload;
    }

    async function playRound() {
      const stake = Number(stakeInput.value);
      if (!Number.isFinite(stake)) {
        setMessage("Enter a valid stake amount.", "err");
        return;
      }
      if (stake < minBet || stake > maxBet) {
        setMessage("Stake must be between ETB " + minBet.toFixed(2) + " and ETB " + maxBet.toFixed(2) + ".", "err");
        return;
      }

      playBtn.disabled = true;
      setMessage("Running round...", "");
      try {
        const payload = await settleRound(stake);
        const balance = Number(payload?.wallet?.main_balance ?? 0);
        walletValue.textContent = balance.toFixed(2);
        renderOutcomeVisual(payload);
        const outcome = payload?.result?.outcome === "win" ? "ok" : "";
        setMessage(payload.message || "Round finished.", outcome);
        const net = Number(payload?.result?.net ?? 0);
        const mult = Number(payload?.result?.multiplier ?? 0).toFixed(2);
        resultLine.textContent = "Result: " + (net >= 0 ? "WIN" : "LOSS") + " ETB " + Math.abs(net).toFixed(2) + " | x" + mult;
      } catch (error) {
        const text = error instanceof Error ? error.message : "Unable to play round.";
        setMessage(text, "err");
      } finally {
        playBtn.disabled = false;
      }
    }

    function gameButtonLabel() {
      if (gameId === "slots-megaways") return "Spin";
      if (gameId === "roulette-euro") return "Spin Wheel";
      if (gameId === "blackjack-classic") return "Deal";
      if (gameId === "baccarat-royal") return "Deal";
      if (gameId === "crash-orbit") return "Start Crash";
      if (gameId === "mines-grid") return "Start Grid";
      if (gameId === "hilo-cards") return "Draw Card";
      if (gameId === "lucky-dice") return "Roll Dice";
      return "Play";
    }

    playBtn.textContent = gameButtonLabel();
    renderOptions();
    renderIdleStage();
    playBtn.addEventListener("click", playRound);
  </script>
</body>
</html>
"""
    return (
        template.replace("__TITLE__", escape(game.title))
        .replace("__PROVIDER__", escape(CASINO_PROVIDER_NAME))
        .replace("__DESCRIPTION__", escape(game.description))
        .replace("__VOLATILITY__", escape(game.volatility))
        .replace("__MIN_BET__", f"{game.min_bet:.2f}")
        .replace("__MAX_BET__", f"{game.max_bet:.2f}")
        .replace("__MAX_MULTIPLIER__", f"{game.max_multiplier:.2f}")
        .replace("__LAUNCH_ID__", escape(launch_id))
        .replace("__GAME_ID__", escape(game.id))
    )
def request_external_casino_launch_url(
    payload: CasinoLaunchRequest,
    user: UserStore,
    game: CasinoGameItem,
    launch_id: str,
) -> tuple[str, Literal["iframe", "redirect"]]:
    if not CASINO_LAUNCH_API_URL:
        raise HTTPException(
            status_code=503,
            detail=(
                "Casino launch provider is not configured. "
                "Set CASINO_LAUNCH_API_URL and provider credentials."
            ),
        )

    return_url = sanitize_casino_return_url(payload.return_url)
    provider_payload: dict[str, object] = {
        "operator_id": CASINO_PROVIDER_OPERATOR_ID,
        "provider": CASINO_PROVIDER_NAME,
        "game_id": game.id,
        "player_id": user.phone_number,
        "session_id": launch_id,
        "currency": "ETB",
        "locale": payload.locale,
        "device": payload.device,
    }
    if return_url:
        provider_payload["return_url"] = return_url

    request_body = json.dumps(provider_payload, separators=(",", ":"), ensure_ascii=False).encode("utf-8")
    headers = {"Content-Type": "application/json"}
    if CASINO_PROVIDER_API_KEY:
        headers["x-api-key"] = CASINO_PROVIDER_API_KEY
    if CASINO_PROVIDER_SECRET:
        headers["x-signature"] = hmac.new(
            CASINO_PROVIDER_SECRET.encode("utf-8"),
            request_body,
            hashlib.sha256,
        ).hexdigest()

    request = UrlRequest(
        CASINO_LAUNCH_API_URL,
        data=request_body,
        headers=headers,
        method="POST",
    )
    try:
        with urlopen(request, timeout=12) as response:
            raw_text = response.read().decode("utf-8")
    except Exception as exc:  # pragma: no cover - external call path
        raise HTTPException(status_code=502, detail=f"Casino provider launch failed: {exc}") from exc

    try:
        response_payload = json.loads(raw_text)
    except Exception as exc:
        raise HTTPException(status_code=502, detail=f"Casino provider returned invalid JSON: {exc}") from exc

    launch_url = (
        read_nested_str(response_payload, "launch_url")
        or read_nested_str(response_payload, "url")
        or read_nested_str(response_payload, "game_url")
        or read_nested_str(response_payload, "gameUrl")
        or read_nested_str(response_payload, "data.launch_url")
        or read_nested_str(response_payload, "data.url")
    )
    if not launch_url:
        raise HTTPException(status_code=502, detail="Casino provider did not return a launch URL.")

    mode = normalize_casino_launch_mode(
        read_nested_str(response_payload, "mode")
        or read_nested_str(response_payload, "open_mode")
        or CASINO_LAUNCH_MODE
    )
    return launch_url, mode


def record_transaction(
    user: UserStore,
    tx_type: Literal["Deposit", "Withdraw", "Transfer", "Bet", "Win"],
    amount: float,
    status_value: Literal["Completed", "Pending", "Failed"],
) -> None:
    user.history.insert(
        0,
        TransactionRecord(
            type=tx_type,
            amount=amount,
            status=status_value,
            created_at=utc_now().replace(microsecond=0).isoformat(),
        ),
    )


def update_latest_pending_withdraw_status(user: UserStore, amount: float, next_status: Literal["Completed", "Failed"]) -> None:
    for entry in user.history:
        if entry.type == "Withdraw" and entry.status == "Pending" and abs(entry.amount - amount) < 1e-9:
            entry.status = next_status
            return


def append_audit_event(
    event_type: Literal["deposit_confirmed", "withdraw_requested", "withdraw_paid", "withdraw_rejected"],
    *,
    phone_number: str,
    amount: float,
    status: str,
    method: str | None = None,
    transaction_number: str | None = None,
    withdraw_ticket_id: str | None = None,
    bank: str | None = None,
    account_number: str | None = None,
    account_holder: str | None = None,
    actor_phone: str | None = None,
    note: str | None = None,
) -> None:
    AUDIT_EVENTS.insert(
        0,
        AuditEvent(
            id=secrets.token_hex(10),
            event_type=event_type,
            created_at=utc_now().replace(microsecond=0).isoformat(),
            phone_number=phone_number,
            amount=round(float(amount), 2),
            status=status,
            method=method,
            transaction_number=transaction_number,
            withdraw_ticket_id=withdraw_ticket_id,
            bank=bank,
            account_number=account_number,
            account_holder=account_holder,
            actor_phone=actor_phone,
            note=note,
        ),
    )
    if len(AUDIT_EVENTS) > 5000:
        del AUDIT_EVENTS[5000:]
    try:
        persist_audit_events()
    except Exception as exc:
        print(f"Failed to persist audit event {event_type}: {exc}")


def get_withdraw_ticket_or_404(ticket_id: str) -> WithdrawTicket:
    ticket = next((item for item in WITHDRAW_TICKETS if item.id == ticket_id), None)
    if ticket is None:
        raise HTTPException(status_code=404, detail="Withdraw request not found")
    normalize_withdraw_ticket_status(ticket)
    return ticket


def record_bet_history_for_round(
    room: RoomStore,
    now: datetime,
    called_numbers: list[int],
    winners: list[WinnerEntry],
    game_winning: float,
) -> set[str]:
    changed_phones: set[str] = set()
    by_user_cards: dict[str, list[int]] = {}
    for cartella_no, owner_phone in room.taken_cartellas.items():
        by_user_cards.setdefault(owner_phone, []).append(cartella_no)

    winner_cards = sorted({entry.cartella_no for entry in winners})
    winner_payouts_by_phone: dict[str, float] = {}
    for entry in winners:
        winner_payouts_by_phone[entry.phone_number] = round(winner_payouts_by_phone.get(entry.phone_number, 0.0) + entry.payout, 2)

    for owner_phone, cards in by_user_cards.items():
        if is_simulated_phone(owner_phone):
            continue
        user = USERS.get(owner_phone)
        if not user:
            continue
        cards_sorted = sorted(cards)
        payout = round(winner_payouts_by_phone.get(owner_phone, 0.0), 2)
        result: Literal["Won", "Lost"] = "Won" if payout > 0 else "Lost"
        preview_card = create_bingo_card(cards_sorted[0]) if cards_sorted else None
        user.bet_history.insert(
            0,
            BetHistoryRecord(
                id=f"{room.id}:{now.timestamp()}:{owner_phone}:{len(user.bet_history) + 1}",
                stake=room.stake,
                game_winning=round(game_winning, 2),
                winner_cards=winner_cards,
                your_cards=cards_sorted,
                date=now.date().isoformat(),
                result=result,
                payout=payout,
                called_numbers=called_numbers,
                preview_card=preview_card,
            ),
        )
        if len(user.bet_history) > 200:
            user.bet_history = user.bet_history[:200]
        changed_phones.add(owner_phone)
    return changed_phones


def normalize_transaction_number(value: str) -> str:
    cleaned = re.sub(r"\s+", "", value.strip().upper())
    return cleaned


TX_LABEL_PATTERN = re.compile(
    r"\b(?:transaction(?:\s*(?:number|no|id|ref(?:erence)?))?|tx(?:n|id)?|trx|receipt(?:\s*(?:number|no|id))?|reference|ref)\b[\s:#=-]*([A-Za-z0-9-]{3,120})\b",
    flags=re.IGNORECASE,
)
TX_STOPWORDS = {
    "ETB",
    "BIRR",
    "TELEBIRR",
    "CBEBIRR",
    "CBE",
    "TRANSFER",
    "SUCCESS",
    "PAYMENT",
    "FROM",
    "TO",
    "DATE",
    "TIME",
    "TX",
    "TRX",
    "REF",
    "ID",
    "NO",
}


def is_likely_transaction_token(token: str) -> bool:
    if not re.fullmatch(r"[A-Z0-9-]{3,120}", token):
        return False
    if token in TX_STOPWORDS:
        return False
    if not re.search(r"\d", token):
        return False
    has_letter = bool(re.search(r"[A-Z]", token))
    if not has_letter and len(token) < 6:
        return False
    if re.fullmatch(r"\d{8,13}", token):
        return False
    return True


def extract_transaction_number_candidate(message: str | None) -> str | None:
    if not message:
        return None

    text = message.strip()
    if not text:
        return None

    labeled_match = TX_LABEL_PATTERN.search(text)
    if labeled_match:
        candidate = normalize_transaction_number(labeled_match.group(1))
        if is_likely_transaction_token(candidate):
            return candidate

    tokens = re.findall(r"[A-Z0-9-]{3,120}", text.upper())
    tokens.sort(key=len, reverse=True)
    for token in tokens:
        if is_likely_transaction_token(token):
            return token
    return None


def ensure_valid_transaction_number(value: str) -> None:
    if not re.fullmatch(r"[A-Z0-9-]{3,120}", value):
        raise HTTPException(
            status_code=400,
            detail="Invalid transaction number format. Use letters, numbers, and hyphen only.",
        )


def extract_receipt_links(message: str | None) -> list[str]:
    if not message:
        return []
    return re.findall(r"https?://[^\s]+", message)


def is_allowed_domain(hostname: str, allowed_domains: set[str]) -> bool:
    host = hostname.lower().rstrip(".")
    return any(host == domain or host.endswith(f".{domain}") for domain in allowed_domains)


def validate_receipt_source_links(method: Literal["telebirr", "cbebirr"], message: str | None) -> list[str]:
    links = extract_receipt_links(message)
    if not links:
        return []

    allowed_domains = DEPOSIT_SOURCE_DOMAINS[method]
    for link in links:
        try:
            hostname = urlparse(link).hostname
        except Exception:
            hostname = None
        if not hostname or not is_allowed_domain(hostname, allowed_domains):
            raise HTTPException(
                status_code=400,
                detail=f"Invalid receipt source link for {method}. Use an official {method} link.",
            )
    return links


def normalize_phone_for_match(value: str) -> str:
    digits = re.sub(r"\D", "", value)
    if digits.startswith("251") and len(digits) == 12:
        return f"0{digits[3:]}"
    if digits.startswith("9") and len(digits) == 9:
        return f"0{digits}"
    if digits.startswith("09") and len(digits) == 10:
        return digits
    return digits


def normalize_owner_for_match(value: str) -> str:
    return re.sub(r"[^a-z0-9]", "", value.lower())


def _safe_unquote(value: str) -> str:
    try:
        return unquote(value)
    except Exception:
        return value


def _safe_unquote_plus(value: str) -> str:
    try:
        return unquote_plus(value)
    except Exception:
        return value


def iter_receipt_search_spaces(message: str | None) -> set[str]:
    spaces: set[str] = set()

    def add_space(value: str | None) -> None:
        if not value:
            return
        trimmed = value.strip()
        if trimmed:
            spaces.add(trimmed)

    add_space(message or "")
    for link in extract_receipt_links(message):
        add_space(link)
        add_space(_safe_unquote(link))
        add_space(_safe_unquote_plus(link))
        try:
            parsed = urlparse(link)
        except Exception:
            continue
        add_space(parsed.path)
        add_space(parsed.query)
        add_space(parsed.fragment)
        for key, value in parse_qsl(parsed.query, keep_blank_values=True):
            decoded_value = _safe_unquote(value)
            plus_decoded_value = _safe_unquote_plus(value)
            add_space(value)
            add_space(decoded_value)
            add_space(plus_decoded_value)
            add_space(f"{key} {decoded_value}")

    return spaces


def extract_phone_matches(value: str | None) -> set[str]:
    if not value:
        return set()
    matches: set[str] = set()
    phone_pattern = re.compile(r"(?:\+?251|0)?9(?:[\s().-]*\d){8}")
    for segment in iter_receipt_search_spaces(value):
        for matched in phone_pattern.findall(segment):
            normalized = normalize_phone_for_match(matched)
            if normalized:
                matches.add(normalized)
    return matches


def has_assigned_owner_name_in_receipt(method: DepositMethod, message: str | None) -> bool:
    receipt_owner_hints = [normalize_owner_for_match(item) for item in iter_receipt_search_spaces(message)]
    receipt_owner_hints = [hint for hint in receipt_owner_hints if hint]
    if not receipt_owner_hints:
        return False

    for account in method.transfer_accounts:
        owner_token = normalize_owner_for_match(account.owner_name)
        if not owner_token:
            continue
        if any(owner_token in hint for hint in receipt_owner_hints):
            return True
    return False


def validate_receipt_recipient(method: DepositMethod, message: str | None) -> None:
    if not message or not message.strip():
        raise HTTPException(
            status_code=400,
            detail="Receipt message is required and must show the recipient account number.",
        )

    assigned_numbers = {normalize_phone_for_match(account.phone_number) for account in method.transfer_accounts}
    mentioned_numbers = extract_phone_matches(message)
    if assigned_numbers.intersection(mentioned_numbers):
        return
    if has_assigned_owner_name_in_receipt(method, message):
        return

    assigned_display = ", ".join(account.phone_number for account in method.transfer_accounts)
    raise HTTPException(
        status_code=400,
        detail=f"Receipt must show transfer to assigned account ({assigned_display}) or assigned recipient name.",
    )


def reserve_deposit_receipt(tx_number: str, phone_number: str, links: list[str]) -> None:
    existing_owner = USED_DEPOSIT_TX.get(tx_number)
    if existing_owner:
        if existing_owner == phone_number:
            raise HTTPException(status_code=409, detail="This receipt is already used by this account.")
        raise HTTPException(status_code=409, detail="This receipt is already used by another account.")

    for link in links:
        key = link.strip().lower()
        owner = USED_RECEIPT_LINKS.get(key)
        if owner:
            if owner == phone_number:
                raise HTTPException(status_code=409, detail="This receipt link is already used by this account.")
            raise HTTPException(status_code=409, detail="This receipt link is already used by another account.")

    USED_DEPOSIT_TX[tx_number] = phone_number
    for link in links:
        USED_RECEIPT_LINKS[link.strip().lower()] = phone_number
    persist_receipt_cache()


def create_session(phone_number: str) -> str:
    token = secrets.token_urlsafe(32)
    SESSIONS[token] = create_session_record(phone_number)
    persist_sessions()
    return token


def get_auth_token(authorization: str | None) -> str:
    if not authorization:
        raise HTTPException(status_code=status.HTTP_401_UNAUTHORIZED, detail="Authentication required")
    prefix = "Bearer "
    if not authorization.startswith(prefix):
        raise HTTPException(status_code=status.HTTP_401_UNAUTHORIZED, detail="Invalid auth header")
    return authorization[len(prefix) :].strip()


def load_latest_user_from_persisted_state(phone_number: str) -> UserStore | None:
    if PG_STORE.enabled():
        try:
            raw_user = PG_STORE.load_user(phone_number, include_history=False, include_bet_history=False)
            if raw_user is None:
                return None
            return UserStore.model_validate(raw_user)
        except Exception:
            return None
    # In SQLite multi-worker Passenger setups, each worker can keep stale in-memory
    # user objects. Load latest persisted user snapshot to avoid wallet flip-flops.
    persisted_users = db_read_state("users")
    if not isinstance(persisted_users, dict):
        return None
    raw_user = persisted_users.get(phone_number)
    if raw_user is None:
        return None
    try:
        return UserStore.model_validate(raw_user)
    except Exception:
        return None


def refresh_user_from_primary_store(phone_number: str) -> UserStore | None:
    latest_user = load_latest_user_from_persisted_state(phone_number)
    if latest_user is not None:
        USERS[latest_user.phone_number] = latest_user
    return latest_user


def get_current_user(authorization: str | None = Header(default=None)) -> UserStore:
    token = get_auth_token(authorization)
    record = normalize_session_record(SESSIONS.get(token))

    # Passenger can serve requests from different workers. If a token is not
    # found in this worker memory, reload persisted state once and retry.
    if not record:
        if PG_STORE.enabled():
            record = normalize_session_record(PG_STORE.load_session(token))
        else:
            load_persisted_state()
            record = normalize_session_record(SESSIONS.get(token))

    if not record:
        raise HTTPException(status_code=status.HTTP_401_UNAUTHORIZED, detail="Session expired")
    expires_at = parse_iso_datetime(record.get("expires_at"))
    if expires_at is None or utc_now() >= expires_at:
        raise HTTPException(status_code=status.HTTP_401_UNAUTHORIZED, detail="Session expired")
    phone_number = record["phone_number"]
    SESSIONS[token] = record
    user = USERS.get(phone_number)
    if not user and PG_STORE.enabled():
        latest_user = refresh_user_from_primary_store(phone_number)
        if latest_user is not None:
            user = latest_user
    if not user:
        raise HTTPException(status_code=status.HTTP_401_UNAUTHORIZED, detail="User not found")
    if IS_PRODUCTION_ENV:
        last_refresh = USER_REFRESH_AT.get(phone_number)
        now = utc_now()
        if last_refresh is None or (now - last_refresh).total_seconds() >= USER_REFRESH_TTL_SECONDS:
            latest_user = refresh_user_from_primary_store(phone_number)
            USER_REFRESH_AT[phone_number] = now
            if latest_user is not None:
                user = latest_user
    return user


def create_bingo_card(cartella_no: int) -> BingoCardResponse:
    rng = Random(cartella_no * 97 + 13)
    b_col = rng.sample(range(1, 16), 5)
    i_col = rng.sample(range(16, 31), 5)
    n_col = rng.sample(range(31, 46), 5)
    g_col = rng.sample(range(46, 61), 5)
    o_col = rng.sample(range(61, 76), 5)

    grid: list[list[int | str]] = []
    for row_index in range(5):
        row: list[int | str] = [
            b_col[row_index],
            i_col[row_index],
            n_col[row_index],
            g_col[row_index],
            o_col[row_index],
        ]
        grid.append(row)

    grid[2][2] = "FREE"
    return BingoCardResponse(card_no=cartella_no, grid=grid)


def find_stake(stake_id: str) -> StakeOption:
    stake = next((option for option in STAKE_OPTIONS if option.id == stake_id), None)
    if not stake:
        raise HTTPException(status_code=404, detail="Stake option not found")
    if stake.status == "none":
        raise HTTPException(status_code=400, detail="Stake room is not active yet")
    return stake


def create_room(stake: StakeOption) -> RoomStore:
    return RoomStore(
        id=f"room-{stake.id}",
        stake_id=stake.id,
        stake=stake.stake,
        card_price=stake.stake,
        players_seed=randint(36, 120),
        started_at=utc_now(),
        called_sequence=generate_called_sequence(),
    )


def simulated_user_marker(index: int) -> str:
    return f"{SIMULATED_USER_TAG}:{index}"


def build_simulated_user_name(index: int) -> str:
    first = SIMULATED_FIRST_NAMES[index % len(SIMULATED_FIRST_NAMES)]
    last = SIMULATED_LAST_NAMES[(index // len(SIMULATED_FIRST_NAMES)) % len(SIMULATED_LAST_NAMES)]
    return f"{first} {last}"


def is_suspicious_simulated_phone(phone_number: str) -> bool:
    digits = re.sub(r"\D", "", phone_number)
    if len(digits) != 10 or not digits.startswith("09"):
        return True
    tail = digits[2:]
    if len(set(tail)) <= 2:
        return True
    bad_tokens = ("000000", "111111", "123456", "654321", "012345", "987654", "999999")
    if any(token in tail for token in bad_tokens):
        return True
    ascending = "0123456789"
    descending = ascending[::-1]
    for idx in range(0, len(ascending) - 5):
        seq = ascending[idx : idx + 6]
        if seq in tail or seq in descending:
            return True
    return False


def generate_simulated_phone(index: int) -> str:
    seed = int(hashlib.sha256(f"{SIMULATED_PHONE_START}:{index}".encode("utf-8")).hexdigest()[:12], 16)
    marker = simulated_user_marker(index)
    for attempt in range(50000):
        tail = 10000000 + ((seed + attempt * 104729) % 90000000)
        candidate = f"09{tail:08d}"
        if is_suspicious_simulated_phone(candidate):
            continue
        existing = USERS.get(candidate)
        if existing is not None and existing.telegram_username != marker:
            continue
        return candidate
    raise RuntimeError("Unable to allocate a non-suspicious phone number for simulated user.")


def is_simulated_user(user: UserStore | None) -> bool:
    if not user:
        return False
    marker = user.telegram_username or ""
    return marker.startswith(f"{SIMULATED_USER_TAG}:")


def is_simulated_phone(phone_number: str | None) -> bool:
    if not phone_number:
        return False
    return is_simulated_user(USERS.get(phone_number))


def get_or_create_simulated_user(index: int) -> tuple[UserStore, bool]:
    marker = simulated_user_marker(index)
    for user in USERS.values():
        if user.telegram_username == marker:
            return user, False

    user_name = build_simulated_user_name(index)
    candidate = generate_simulated_phone(index)
    existing = USERS.get(candidate)
    if existing is not None:
        if existing.telegram_username == marker:
            return existing, False
        raise RuntimeError("Simulated phone collision with a real account.")

    simulated = UserStore(
        user_name=user_name,
        phone_number=candidate,
        password_hash=SIMULATED_PASSWORD_HASH,
        referral_code=create_referral_code(),
        is_admin=False,
        telegram_id=None,
        telegram_username=marker,
        wallet=WalletState(main_balance=0.0, bonus_balance=0.0),
    )
    USERS[candidate] = simulated
    return simulated, True


def get_simulated_owner_phone(room: RoomStore, queue: Literal["current", "next"], cartella_no: int) -> tuple[str, bool]:
    # Deterministic per-round owner assignment while distributing identities across the pool.
    round_seed = f"{room.id}:{queue}:{room.started_at.isoformat()}"
    offset = int(hashlib.sha256(round_seed.encode("utf-8")).hexdigest()[:8], 16) % SIMULATED_BOT_POOL_SIZE
    index = (offset + cartella_no - 1) % SIMULATED_BOT_POOL_SIZE
    user, created = get_or_create_simulated_user(index)
    return user.phone_number, created


def get_or_create_room(stake: StakeOption) -> RoomStore:
    room = ROOMS.get(stake.id)
    if room is None:
        room = create_room(stake)
        ROOMS[stake.id] = room
        persist_rooms()
    return room


def build_dynamic_stake_option(stake: StakeOption, user_phone: str) -> StakeOption:
    if stake.status == "none":
        return StakeOption(
            id=stake.id,
            stake=stake.stake,
            status="none",
            countdown_seconds=None,
            possible_win=None,
            bonus=stake.bonus,
            room_phase=None,
            my_cards_current=0,
            my_cards_next=0,
            open_available=False,
        )

    room = get_or_create_room(stake)
    room_state = build_room_state(room, user_phone)
    paid_count = room_state.current_paid_count if room_state.phase == "playing" else room_state.display_paid_count
    possible_win = int(round((paid_count * stake.stake) * (1 - HOUSE_COMMISSION_RATE)))

    if room_state.phase == "playing":
        status: Literal["countdown", "playing", "none"] = "playing"
        countdown_seconds: int | None = None
    else:
        status = "countdown"
        countdown_seconds = room_state.countdown_seconds if room_state.phase == "selecting" else room_state.announcement_seconds

    return StakeOption(
        id=stake.id,
        stake=stake.stake,
        status=status,
        countdown_seconds=countdown_seconds,
        possible_win=possible_win,
        bonus=stake.bonus,
        room_phase=room_state.phase,
        my_cards_current=len(room_state.my_cartellas),
        my_cards_next=len(room_state.next_my_cartellas),
        open_available=room_state.phase == "playing" and len(room_state.my_cartellas) > 0,
    )


def generate_called_sequence() -> list[int]:
    sequence = sample(range(1, 76), 75)
    shuffle(sequence)
    return sequence


def mark_key(phone_number: str, cartella_no: int) -> str:
    return f"{phone_number}:{cartella_no}"


def get_user_cartellas_from_map(cartella_map: dict[int, str], phone_number: str) -> list[int]:
    return sorted([cartella_no for cartella_no, owner in cartella_map.items() if owner == phone_number])


def get_user_cartella(room: RoomStore, phone_number: str) -> int | None:
    cartellas = get_user_cartellas_from_map(room.taken_cartellas, phone_number)
    return cartellas[0] if cartellas else None


def get_user_held_cartella_from_map(held_map: dict[int, str], phone_number: str) -> int | None:
    holds = sorted([cartella_no for cartella_no, owner in held_map.items() if owner == phone_number])
    return holds[0] if holds else None


def get_user_held_cartella(room: RoomStore, phone_number: str) -> int | None:
    return get_user_held_cartella_from_map(room.held_cartellas, phone_number)


def get_user_marked_numbers(room: RoomStore, phone_number: str, cartella_no: int) -> list[int]:
    key = mark_key(phone_number, cartella_no)
    raw = room.marked_by_user_card.get(key, [])
    clean = sorted(set([value for value in raw if isinstance(value, int) and 1 <= value <= 75]))
    room.marked_by_user_card[key] = clean
    return clean


def card_numbers_set(cartella_no: int) -> set[int]:
    card = create_bingo_card(cartella_no)
    values: set[int] = set()
    for row in card.grid:
        for value in row:
            if isinstance(value, int):
                values.add(value)
    return values


def has_bingo_for_marks(cartella_no: int, called_numbers: list[int], marked_numbers: list[int]) -> bool:
    called_set = set(called_numbers)
    marked_set = set(marked_numbers)
    card = create_bingo_card(cartella_no)

    def is_hit(value: int | str) -> bool:
        if value == "FREE":
            return True
        return isinstance(value, int) and value in called_set and value in marked_set

    rows = any(all(is_hit(value) for value in row) for row in card.grid)
    cols = any(all(is_hit(card.grid[row_idx][col_idx]) for row_idx in range(5)) for col_idx in range(5))
    d1 = all(is_hit(card.grid[idx][idx]) for idx in range(5))
    d2 = all(is_hit(card.grid[idx][4 - idx]) for idx in range(5))
    return rows or cols or d1 or d2


def get_room_by_id(room_id: str) -> RoomStore:
    room = next((candidate for candidate in ROOMS.values() if candidate.id == room_id), None)
    if room is None:
        raise HTTPException(status_code=404, detail="Room not found")
    return room


def prune_hold_map(held_map: dict[int, str], held_updated_at: dict[int, datetime], taken_map: dict[int, str]) -> bool:
    now = utc_now()
    remove_list: list[int] = []
    for cartella_no, owner in held_map.items():
        if cartella_no in taken_map:
            remove_list.append(cartella_no)
            continue
        updated_at = held_updated_at.get(cartella_no)
        if not updated_at:
            remove_list.append(cartella_no)
            continue
        if (now - updated_at).total_seconds() > HOLD_TTL_SECONDS:
            remove_list.append(cartella_no)
            continue
        if owner not in USERS:
            remove_list.append(cartella_no)
    for cartella_no in remove_list:
        held_map.pop(cartella_no, None)
        held_updated_at.pop(cartella_no, None)
    return bool(remove_list)


def prune_holds(room: RoomStore) -> bool:
    changed_current = prune_hold_map(room.held_cartellas, room.held_updated_at, room.taken_cartellas)
    changed_next = prune_hold_map(room.next_held_cartellas, room.next_held_updated_at, room.next_taken_cartellas)
    return changed_current or changed_next


def compute_called_numbers(room: RoomStore, reference_time: datetime) -> list[int]:
    elapsed_seconds = int((reference_time - room.started_at).total_seconds())
    if elapsed_seconds < SELECT_PHASE_SECONDS:
        return []
    play_elapsed = elapsed_seconds - SELECT_PHASE_SECONDS
    call_count = int(play_elapsed // CALL_INTERVAL_SECONDS)
    call_count = max(0, min(call_count, len(room.called_sequence)))
    return room.called_sequence[:call_count]


def start_next_round(room: RoomStore, now: datetime) -> None:
    room.started_at = now
    room.called_sequence = generate_called_sequence()
    room.taken_cartellas = dict(room.next_taken_cartellas)
    room.next_taken_cartellas = {}

    room.held_cartellas = {cartella_no: owner for cartella_no, owner in room.next_held_cartellas.items() if cartella_no not in room.taken_cartellas}
    room.held_updated_at = {
        cartella_no: room.next_held_updated_at.get(cartella_no, now)
        for cartella_no in room.held_cartellas.keys()
    }
    room.next_held_cartellas = {}
    room.next_held_updated_at = {}

    room.marked_by_user_card = {}
    room.ended_at = None
    room.winner_phone = None
    room.winner_cartella = None
    room.winner_payout = None
    room.house_commission = None
    room.pending_claims = []
    room.claim_window_ends_at = None
    room.claim_window_reference_time = None
    room.winners = []
    room.result_until = None
    persist_rooms()


def finalize_claim_window_if_needed(room: RoomStore, now: datetime) -> None:
    if room.claim_window_ends_at is None:
        return
    if now < room.claim_window_ends_at:
        return

    if not room.pending_claims:
        room.claim_window_ends_at = None
        room.claim_window_reference_time = None
        persist_rooms()
        return

    valid_claims: list[ClaimEntry] = []
    seen: set[tuple[str, int]] = set()
    reference_time = room.claim_window_reference_time or room.claim_window_ends_at
    called_numbers = compute_called_numbers(room, reference_time)

    for claim in room.pending_claims:
        key = (claim.phone_number, claim.cartella_no)
        if key in seen:
            continue
        seen.add(key)
        owner_phone = room.taken_cartellas.get(claim.cartella_no)
        if owner_phone != claim.phone_number:
            continue
        if claim.phone_number not in USERS:
            continue
        if is_simulated_phone(claim.phone_number):
            marks = sorted(set(called_numbers).intersection(card_numbers_set(claim.cartella_no)))
        else:
            marks = get_user_marked_numbers(room, claim.phone_number, claim.cartella_no)
        if has_bingo_for_marks(claim.cartella_no, called_numbers, marks):
            valid_claims.append(claim)

    if not valid_claims:
        room.pending_claims = []
        room.claim_window_ends_at = None
        room.claim_window_reference_time = None
        persist_rooms()
        return

    total_sales = round(float(len(room.taken_cartellas) * room.card_price), 2)
    house_commission = round(total_sales * HOUSE_COMMISSION_RATE, 2)
    distributable = round(total_sales - house_commission, 2)
    split_count = len(valid_claims)
    base_payout = round(distributable / split_count, 2) if split_count > 0 else 0.0

    winners: list[WinnerEntry] = []
    changed_user_phones: set[str] = set()
    assigned = 0.0

    for idx, claim in enumerate(valid_claims):
        payout = base_payout
        if idx == split_count - 1:
            payout = round(distributable - assigned, 2)
        assigned += payout

        winner_user = USERS.get(claim.phone_number)
        if not winner_user:
            continue

        if not is_simulated_phone(claim.phone_number):
            if PG_STORE.enabled():
                PG_STORE.adjust_wallet_and_record_transaction(claim.phone_number, payout, "Win", "Completed")
                refreshed_winner = refresh_user_from_primary_store(claim.phone_number)
                if refreshed_winner is not None:
                    winner_user = refreshed_winner
            else:
                winner_user.wallet.main_balance = round(winner_user.wallet.main_balance + payout, 2)
                record_transaction(winner_user, "Win", payout, "Completed")
            changed_user_phones.add(claim.phone_number)
        winners.append(
            WinnerEntry(
                phone_number=claim.phone_number,
                user_name=winner_user.user_name,
                cartella_no=claim.cartella_no,
                payout=payout,
                card=create_bingo_card(claim.cartella_no),
            )
        )

    if not winners:
        room.pending_claims = []
        room.claim_window_ends_at = None
        persist_rooms()
        return

    changed_user_phones.update(
        record_bet_history_for_round(
            room=room,
            now=now,
            called_numbers=called_numbers,
            winners=winners,
            game_winning=distributable,
        )
    )

    room.winners = winners
    room.ended_at = now
    room.winner_phone = winners[0].phone_number
    room.winner_cartella = winners[0].cartella_no
    room.winner_payout = winners[0].payout
    room.house_commission = house_commission
    room.result_until = now + timedelta(seconds=RESULT_ANNOUNCE_SECONDS)
    room.pending_claims = []
    room.claim_window_ends_at = None
    room.claim_window_reference_time = None
    if changed_user_phones:
        persist_users(changed_user_phones)
    persist_rooms()


def end_room_if_calls_complete(room: RoomStore, now: datetime) -> None:
    if room.ended_at is not None:
        return
    if room.claim_window_ends_at is not None:
        return
    elapsed_seconds = (now - room.started_at).total_seconds()
    if elapsed_seconds < SELECT_PHASE_SECONDS:
        return
    total_round_seconds = SELECT_PHASE_SECONDS + (len(room.called_sequence) * CALL_INTERVAL_SECONDS)
    if elapsed_seconds < total_round_seconds:
        return
    called_numbers = compute_called_numbers(room, now)
    total_sales = round(float(len(room.taken_cartellas) * room.card_price), 2)
    house_commission = round(total_sales * HOUSE_COMMISSION_RATE, 2)
    distributable = round(total_sales - house_commission, 2)
    changed_user_phones = record_bet_history_for_round(
        room=room,
        now=now,
        called_numbers=called_numbers,
        winners=[],
        game_winning=distributable,
    )
    room.ended_at = now
    room.winner_phone = None
    room.winner_cartella = None
    room.winner_payout = 0.0
    room.house_commission = house_commission
    room.winners = []
    room.result_until = now + timedelta(seconds=RESULT_ANNOUNCE_SECONDS)
    if changed_user_phones:
        persist_users(changed_user_phones)
    persist_rooms()


def get_queue_maps(
    room: RoomStore, queue: Literal["current", "next"]
) -> tuple[dict[int, str], dict[int, str], dict[int, datetime]]:
    if queue == "next":
        return room.next_taken_cartellas, room.next_held_cartellas, room.next_held_updated_at
    return room.taken_cartellas, room.held_cartellas, room.held_updated_at


def compute_simulated_target(
    room: RoomStore,
    phase: Literal["selecting", "playing", "finished"],
    countdown_seconds: int,
    called_numbers: list[int],
) -> int:
    if not ENABLE_SIMULATED_ACTIVITY or phase == "finished":
        return 0

    if phase == "selecting":
        elapsed_select = max(0, SELECT_PHASE_SECONDS - max(0, countdown_seconds))
        step_index = elapsed_select // SIMULATED_SELECTING_STEP_SECONDS
        baseline_target = min(SIMULATED_SELECTING_MAX_PAID, step_index * SIMULATED_SELECTING_CARDS_PER_STEP)

        crowd_seed = int(hashlib.sha256(f"{room.id}:{room.started_at.isoformat()}".encode("utf-8")).hexdigest()[:8], 16) % 100
        if crowd_seed < SIMULATED_HIGH_TRAFFIC_ROUND_PERCENT:
            ramp_window = max(1, SELECT_PHASE_SECONDS - 2)
            progress = min(1.0, elapsed_select / ramp_window)
            burst_target = int(round(SIMULATED_HIGH_TRAFFIC_TARGET * progress))
            return max(baseline_target, burst_target)

        return baseline_target

    _ = (called_numbers,)
    return 0


def ensure_simulated_cards_for_queue(
    room: RoomStore,
    queue: Literal["current", "next"],
    target: int,
) -> tuple[bool, set[str]]:
    if target <= 0:
        return False, set()

    taken_map, held_map, _ = get_queue_maps(room, queue)
    current_simulated = [cartella_no for cartella_no, owner in taken_map.items() if is_simulated_phone(owner)]
    deficit = max(0, target - len(current_simulated))
    if deficit <= 0:
        return False, set()

    blocked = set(taken_map.keys()) | set(held_map.keys())
    available = [cartella_no for cartella_no in range(1, CARTELLA_TOTAL + 1) if cartella_no not in blocked]
    if not available:
        return False, set()

    seed_source = f"{room.id}:{queue}:{room.started_at.isoformat()}:{target}:{len(taken_map)}"
    seed = int(hashlib.sha256(seed_source.encode("utf-8")).hexdigest()[:16], 16)
    rng = Random(seed)
    chosen = rng.sample(available, min(deficit, len(available)))

    changed_room = False
    changed_user_phones: set[str] = set()
    for cartella_no in chosen:
        owner_phone, user_created = get_simulated_owner_phone(room, queue, cartella_no)
        if cartella_no in taken_map:
            continue
        taken_map[cartella_no] = owner_phone
        room.marked_by_user_card.setdefault(mark_key(owner_phone, cartella_no), [])
        changed_room = True
        if user_created:
            changed_user_phones.add(owner_phone)

    return changed_room, changed_user_phones


def ensure_simulated_activity(room: RoomStore, now: datetime) -> None:
    if not ENABLE_SIMULATED_ACTIVITY or room.ended_at is not None:
        return

    elapsed_seconds = int((now - room.started_at).total_seconds())
    if elapsed_seconds < 0:
        elapsed_seconds = 0

    if elapsed_seconds < SELECT_PHASE_SECONDS:
        phase: Literal["selecting", "playing", "finished"] = "selecting"
        queue: Literal["current", "next"] = "current"
        countdown_seconds = SELECT_PHASE_SECONDS - elapsed_seconds
        called_numbers: list[int] = []
    else:
        return

    target = compute_simulated_target(room, phase, countdown_seconds, called_numbers)
    changed_room, changed_user_phones = ensure_simulated_cards_for_queue(room, queue, target)
    if changed_user_phones:
        persist_users(changed_user_phones)
    if changed_room:
        persist_rooms()


def inject_simulated_claims(room: RoomStore, now: datetime) -> bool:
    if not ENABLE_SIMULATED_ACTIVITY:
        return False
    if room.ended_at is not None:
        return False
    if (now - room.started_at).total_seconds() < SELECT_PHASE_SECONDS:
        return False

    reference_time = room.claim_window_reference_time or now
    called_numbers = compute_called_numbers(room, reference_time)
    if not called_numbers:
        return False
    called_set = set(called_numbers)

    changed = False
    added_count = 0
    max_new_claims = 1 if room.claim_window_ends_at is None else 2
    existing = {(entry.phone_number, entry.cartella_no) for entry in room.pending_claims}
    for cartella_no, owner_phone in sorted(room.taken_cartellas.items()):
        if not is_simulated_phone(owner_phone):
            continue
        key = (owner_phone, cartella_no)
        if key in existing:
            continue
        marks = sorted(called_set.intersection(card_numbers_set(cartella_no)))
        if not has_bingo_for_marks(cartella_no, called_numbers, marks):
            continue
        room.pending_claims.append(
            ClaimEntry(phone_number=owner_phone, cartella_no=cartella_no, claimed_at=now)
        )
        existing.add(key)
        changed = True
        added_count += 1
        if added_count >= max_new_claims:
            break

    if changed and room.claim_window_ends_at is None:
        room.claim_window_ends_at = now + timedelta(seconds=CLAIM_GRACE_SECONDS)
        room.claim_window_reference_time = now

    return changed


def advance_room_if_needed(room: RoomStore) -> None:
    now = utc_now()
    ensure_simulated_activity(room, now)
    if inject_simulated_claims(room, now):
        persist_rooms()
    finalize_claim_window_if_needed(room, now)
    end_room_if_calls_complete(room, now)
    if room.ended_at is not None and room.result_until is not None and now >= room.result_until:
        start_next_round(room, now)


def compute_simulated_paid_cartellas(
    room: RoomStore,
    phase: Literal["selecting", "playing", "finished"],
    active_queue: Literal["current", "next"],
    called_numbers: list[int],
    countdown_seconds: int,
) -> list[int]:
    _ = (phase, called_numbers, countdown_seconds)
    _ = active_queue
    all_taken = dict(room.taken_cartellas)
    all_taken.update(room.next_taken_cartellas)
    return sorted([cartella_no for cartella_no, owner in all_taken.items() if is_simulated_phone(owner)])


def build_room_state(room: RoomStore, user_phone: str) -> RoomState:
    advance_room_if_needed(room)
    if prune_holds(room):
        persist_rooms()
    now = utc_now()
    reference_time = room.ended_at or now
    elapsed_seconds = int((reference_time - room.started_at).total_seconds())
    if elapsed_seconds < 0:
        elapsed_seconds = 0

    if room.ended_at is not None:
        phase: Literal["selecting", "playing", "finished"] = "finished"
        countdown_seconds = 0
        call_countdown_seconds = 0
        called_numbers = compute_called_numbers(room, reference_time)
    elif elapsed_seconds < SELECT_PHASE_SECONDS:
        phase = "selecting"
        countdown_seconds = SELECT_PHASE_SECONDS - elapsed_seconds
        call_countdown_seconds = 0
        called_numbers = []
    else:
        phase = "playing"
        countdown_seconds = 0
        play_elapsed_seconds = max(0.0, (now - room.started_at).total_seconds() - SELECT_PHASE_SECONDS)
        remainder = play_elapsed_seconds % CALL_INTERVAL_SECONDS
        seconds_left = CALL_INTERVAL_SECONDS - remainder
        call_countdown_seconds = max(1, int(math.ceil(seconds_left - 1e-9)))
        called_numbers = compute_called_numbers(room, now)

    my_cartellas = get_user_cartellas_from_map(room.taken_cartellas, user_phone)
    next_my_cartellas = get_user_cartellas_from_map(room.next_taken_cartellas, user_phone)
    my_cartella = my_cartellas[0] if my_cartellas else None

    my_marked_numbers_by_card: dict[str, list[int]] = {}
    called_set = set(called_numbers)
    for cartella_no in my_cartellas:
        allowed_marks = called_set.intersection(card_numbers_set(cartella_no))
        marks = [value for value in get_user_marked_numbers(room, user_phone, cartella_no) if value in allowed_marks]
        room.marked_by_user_card[mark_key(user_phone, cartella_no)] = marks
        my_marked_numbers_by_card[str(cartella_no)] = marks

    my_marked_numbers = my_marked_numbers_by_card.get(str(my_cartella), []) if my_cartella is not None else []

    active_queue: Literal["current", "next"] = "current" if phase == "selecting" else "next"
    queue_taken, queue_held, _ = get_queue_maps(room, active_queue)
    paid_cartellas = sorted(queue_taken.keys())
    simulated_paid_cartellas = compute_simulated_paid_cartellas(
        room=room,
        phase=phase,
        active_queue=active_queue,
        called_numbers=called_numbers,
        countdown_seconds=countdown_seconds,
    )
    display_paid_count = len(paid_cartellas)
    current_paid_count = len(room.taken_cartellas)
    current_total_sales = round(float(current_paid_count * room.card_price), 2)
    current_house_commission = round(current_total_sales * HOUSE_COMMISSION_RATE, 2)
    current_distributable = round(current_total_sales - current_house_commission, 2)
    held_cartellas = sorted([cartella_no for cartella_no in queue_held.keys() if cartella_no not in queue_taken])
    unavailable = sorted(
        set(
            [cartella_no for cartella_no, owner in queue_taken.items() if owner != user_phone]
            + [cartella_no for cartella_no, owner in queue_held.items() if owner != user_phone]
        )
    )
    my_held_cartella = get_user_held_cartella_from_map(queue_held, user_phone)
    winner_entry = room.winners[0] if room.winners else None
    winner_user = USERS.get(room.winner_phone) if room.winner_phone else None
    claim_window_seconds = (
        max(0, int(math.ceil((room.claim_window_ends_at - now).total_seconds())))
        if room.claim_window_ends_at is not None and now < room.claim_window_ends_at
        else 0
    )
    announcement_seconds = (
        max(0, int((room.result_until - now).total_seconds()))
        if room.result_until is not None and now < room.result_until
        else 0
    )

    return RoomState(
        id=room.id,
        stake=room.stake,
        card_price=room.card_price,
        players=room.players_seed + len(room.taken_cartellas) + len(room.next_taken_cartellas),
        phase=phase,
        countdown_seconds=countdown_seconds,
        call_countdown_seconds=call_countdown_seconds,
        cartella_total=CARTELLA_TOTAL,
        paid_cartellas=paid_cartellas,
        simulated_paid_cartellas=simulated_paid_cartellas,
        display_paid_count=display_paid_count,
        current_paid_count=current_paid_count,
        current_total_sales=current_total_sales,
        current_house_commission=current_house_commission,
        current_distributable=current_distributable,
        held_cartellas=held_cartellas,
        unavailable_cartellas=unavailable,
        my_cartella=my_cartella,
        my_cartellas=my_cartellas,
        next_my_cartellas=next_my_cartellas,
        my_held_cartella=my_held_cartella,
        active_queue=active_queue,
        called_numbers=called_numbers,
        latest_number=called_numbers[-1] if called_numbers else None,
        my_marked_numbers=my_marked_numbers,
        my_marked_numbers_by_card=my_marked_numbers_by_card,
        winner_name=winner_entry.user_name if winner_entry else (winner_user.user_name if winner_user else None),
        winner_cartella=winner_entry.cartella_no if winner_entry else room.winner_cartella,
        winner_payout=winner_entry.payout if winner_entry else room.winner_payout,
        house_commission=room.house_commission,
        winners=room.winners,
        claim_window_seconds=claim_window_seconds,
        announcement_seconds=announcement_seconds,
    )


def seed_demo_users() -> None:
    demos = [
        {
            "user_name": "Fraol",
            "phone_number": "0913885322",
            "password": "123456",
            "referral_code": "300021",
            "is_admin": False,
            "main_balance": DEMO_START_BALANCE,
            "bonus_balance": 50.0,
            "history": [
                TransactionRecord(type="Deposit", amount=100, status="Completed", created_at="2026-02-20T19:02:13Z"),
                TransactionRecord(type="Deposit", amount=200, status="Completed", created_at="2026-02-20T18:37:22Z"),
                TransactionRecord(type="Deposit", amount=100, status="Completed", created_at="2026-02-20T18:20:33Z"),
                TransactionRecord(type="Deposit", amount=200, status="Completed", created_at="2026-02-11T19:15:47Z"),
                TransactionRecord(type="Deposit", amount=100, status="Completed", created_at="2026-02-05T18:49:48Z"),
            ],
        },
        {
            "user_name": "Getu",
            "phone_number": "0912000001",
            "password": "123456",
            "referral_code": "332690",
            "is_admin": False,
            "main_balance": DEMO_START_BALANCE,
            "bonus_balance": 35.0,
            "history": [
                TransactionRecord(type="Deposit", amount=150, status="Completed", created_at="2026-02-21T09:10:13Z"),
                TransactionRecord(type="Deposit", amount=120, status="Completed", created_at="2026-02-20T16:37:22Z"),
            ],
        },
        {
            "user_name": "40bingo Admin",
            "phone_number": "0969801746",
            "password": "123456",
            "referral_code": "680174",
            "is_admin": True,
            "main_balance": DEMO_START_BALANCE,
            "bonus_balance": 0.0,
            "history": [],
        },
    ]

    for demo in demos:
        demo_phone = demo["phone_number"]
        if demo_phone in USERS:
            continue
        user = UserStore(
            user_name=str(demo["user_name"]),
            phone_number=demo_phone,
            password_hash=hash_password(str(demo["password"])),
            referral_code=str(demo["referral_code"]),
            is_admin=bool(demo.get("is_admin", False)),
            wallet=WalletState(main_balance=float(demo["main_balance"]), bonus_balance=float(demo["bonus_balance"])),
        )
        user.history.extend(demo["history"])
        USERS[demo_phone] = user


ensure_runtime_config_ready()
ensure_db_ready()
load_persisted_state()
apply_default_deposit_logos()
apply_admin_bootstrap()
if ENABLE_DEMO_SEED:
    seed_demo_users()
# Avoid rewriting full state on every boot when Postgres is the primary store.
# Runtime handlers persist mutations explicitly.
if not PG_STORE.enabled():
    persist_users()
    persist_deposit_methods()
    persist_withdraw_tickets()
    persist_audit_events()
    persist_receipt_cache()
    persist_rooms()


async def room_tick_loop() -> None:
    while True:
        for room in list(ROOMS.values()):
            advance_room_if_needed(room)
            if prune_holds(room):
                persist_rooms()
        await asyncio.sleep(1)


@app.on_event("startup")
async def start_room_ticker() -> None:
    global GAME_TICKER_TASK
    if GAME_TICKER_TASK is None or GAME_TICKER_TASK.done():
        GAME_TICKER_TASK = asyncio.create_task(room_tick_loop())


@app.on_event("shutdown")
async def stop_room_ticker() -> None:
    global GAME_TICKER_TASK
    if GAME_TICKER_TASK is None:
        return
    GAME_TICKER_TASK.cancel()
    try:
        await GAME_TICKER_TASK
    except asyncio.CancelledError:
        pass
    GAME_TICKER_TASK = None


@app.get("/api/health")
def health() -> dict:
    return {
        "status": "ok",
        "service": "40bingo-api",
        "time": utc_now().isoformat(),
        "storage": "postgres" if PG_STORE.enabled() else "sqlite",
        "email_alerts_ready": is_email_alerts_configured(),
    }


@app.post("/api/auth/signup")
def signup(payload: SignupRequest) -> dict:
    phone_number = normalize_phone(payload.phone_number)
    if find_user_by_phone(phone_number):
        raise HTTPException(status_code=409, detail="Phone number already registered")

    user = UserStore(
        user_name=payload.user_name.strip(),
        phone_number=phone_number,
        password_hash=hash_password(payload.password),
        referral_code=create_referral_code(),
        is_admin=is_bootstrap_admin_phone(phone_number),
        wallet=WalletState(main_balance=SIGNUP_INITIAL_MAIN_BALANCE, bonus_balance=SIGNUP_INITIAL_BONUS_BALANCE),
    )
    USERS[phone_number] = user
    persist_users([phone_number])
    token = create_session(phone_number)
    return {
        "message": "Account created successfully.",
        "token": token,
        "user": make_public_user(user).model_dump(),
        "wallet": user.wallet.model_dump(),
    }


@app.post("/api/auth/login")
def login(payload: LoginRequest) -> dict:
    user = find_user_by_phone(payload.phone_number)
    if not user or not verify_password(payload.password, user.password_hash):
        raise HTTPException(status_code=401, detail="Invalid phone number or password")

    token = create_session(user.phone_number)
    return {
        "message": "Login successful.",
        "token": token,
        "user": make_public_user(user).model_dump(),
        "wallet": user.wallet.model_dump(),
    }


@app.post("/api/auth/telegram")
def telegram_auth(payload: TelegramAuthRequest) -> dict:
    telegram_user = verify_telegram_init_data(payload.init_data)
    telegram_id = int(telegram_user["id"])
    telegram_username = (telegram_user.get("username") or "").strip() or None
    display_name = (
        (telegram_user.get("first_name") or "").strip()
        or telegram_username
        or f"tg_{telegram_id}"
    )

    user = next((candidate for candidate in USERS.values() if candidate.telegram_id == telegram_id), None)
    if user is None:
        phone_for_link = (payload.phone_number or "").strip()
        password_for_link = payload.password or ""
        if phone_for_link and password_for_link:
            existing = find_user_by_phone(phone_for_link)
            if existing is None or not verify_password(password_for_link, existing.password_hash):
                raise HTTPException(status_code=401, detail="Invalid phone number or password for Telegram link.")
            if existing.telegram_id is not None and existing.telegram_id != telegram_id:
                raise HTTPException(status_code=409, detail="This account is already linked to another Telegram profile.")
            existing.telegram_id = telegram_id
            existing.telegram_username = telegram_username
            user = existing
        else:
            generated_phone = generate_phone_for_telegram_user(telegram_id)
            user = UserStore(
                user_name=display_name[:40],
                phone_number=generated_phone,
                password_hash=hash_password(secrets.token_urlsafe(24)),
                referral_code=create_referral_code(),
                is_admin=is_bootstrap_admin_phone(generated_phone),
                telegram_id=telegram_id,
                telegram_username=telegram_username,
                wallet=WalletState(main_balance=SIGNUP_INITIAL_MAIN_BALANCE, bonus_balance=SIGNUP_INITIAL_BONUS_BALANCE),
            )
            USERS[user.phone_number] = user
    else:
        user.telegram_username = telegram_username
        if display_name:
            user.user_name = display_name[:40]

    persist_users([user.phone_number])
    token = create_session(user.phone_number)
    return {
        "message": "Telegram authentication successful.",
        "token": token,
        "user": make_public_user(user).model_dump(),
        "wallet": user.wallet.model_dump(),
    }


@app.post("/api/auth/logout")
def logout(authorization: str | None = Header(default=None)) -> dict:
    token = get_auth_token(authorization)
    SESSIONS.pop(token, None)
    persist_sessions()
    return {"message": "Logged out"}


@app.get("/api/auth/me")
def auth_me(user: UserStore = Depends(get_current_user)) -> dict:
    return {
        "user": make_public_user(user).model_dump(),
        "wallet": user.wallet.model_dump(),
    }


@app.get("/api/dashboard")
def dashboard(user: UserStore = Depends(get_current_user)) -> dict:
    stake_options = [build_dynamic_stake_option(stake, user.phone_number).model_dump() for stake in STAKE_OPTIONS]
    return {
        "brand": BRAND,
        "user": make_public_user(user).model_dump(),
        "is_admin": can_manage_deposit_accounts(user),
        "wallet": user.wallet.model_dump(),
        "deposit_methods": [method.model_dump() for method in DEPOSIT_METHODS],
        "stake_options": stake_options,
        "faq": FAQ_ITEMS,
        "games": [
            {"id": "bingo", "title": "Bingo Game", "description": "Classic live bingo room", "cta": "Play"},
            {"id": "spin", "title": "Spin Game", "description": "Quick spin mini game", "cta": "Play"},
        ],
    }


@app.get("/api/admin/deposit-methods")
def admin_deposit_methods(user: UserStore = Depends(get_current_user)) -> dict:
    require_admin_user(user)
    return {"items": [method.model_dump() for method in DEPOSIT_METHODS]}


@app.put("/api/admin/deposit-methods/{method_code}")
def update_admin_deposit_method(
    method_code: Literal["telebirr", "cbebirr"],
    payload: AdminUpdateDepositAccountsRequest,
    user: UserStore = Depends(get_current_user),
) -> dict:
    require_admin_user(user)
    method = find_deposit_method(method_code)

    normalized_accounts: list[DepositAccount] = []
    seen_phones: set[str] = set()
    for account in payload.transfer_accounts:
        normalized_phone = normalize_phone(account.phone_number)
        if not re.fullmatch(r"^(09\d{8}|\+2519\d{8})$", normalized_phone):
            raise HTTPException(status_code=400, detail=f"Invalid phone number: {account.phone_number}")
        if normalized_phone in seen_phones:
            raise HTTPException(status_code=400, detail="Duplicate transfer account phone number in update payload.")
        seen_phones.add(normalized_phone)
        normalized_accounts.append(
            DepositAccount(
                phone_number=normalized_phone,
                owner_name=account.owner_name.strip(),
            )
        )

    method.transfer_accounts = normalized_accounts
    persist_deposit_methods()
    return {
        "message": f"{method.label} accounts updated.",
        "method": method.model_dump(),
        "deposit_methods": [item.model_dump() for item in DEPOSIT_METHODS],
    }


@app.get("/api/admin/withdraw-requests")
def admin_withdraw_requests(user: UserStore = Depends(get_current_user)) -> dict:
    require_admin_user(user)
    for ticket in WITHDRAW_TICKETS:
        normalize_withdraw_ticket_status(ticket)
    return {"items": [ticket.model_dump() for ticket in WITHDRAW_TICKETS[:200]]}


@app.get("/api/admin/audit-events")
def admin_audit_events(user: UserStore = Depends(get_current_user)) -> dict:
    require_admin_user(user)
    return {"items": [event.model_dump() for event in AUDIT_EVENTS[:1000]]}


@app.post("/api/admin/withdraw-requests/{ticket_id}/approve")
def approve_withdraw_request(ticket_id: str, user: UserStore = Depends(get_current_user)) -> dict:
    require_admin_user(user)
    ticket = get_withdraw_ticket_or_404(ticket_id)
    if ticket.status != "Pending":
        raise HTTPException(status_code=400, detail=f"Request already {ticket.status.lower()}.")
    ticket.status = "Processing"
    ticket.processing_at = utc_now().replace(microsecond=0).isoformat()
    ticket.processing_by = user.phone_number
    ticket.reviewed_at = utc_now().replace(microsecond=0).isoformat()
    ticket.reviewed_by = user.phone_number

    persist_withdraw_tickets()

    return {"message": "Withdraw request moved to processing. Send bank payout, then mark paid.", "item": ticket.model_dump()}


@app.post("/api/admin/withdraw-requests/{ticket_id}/mark-paid")
def mark_paid_withdraw_request(
    ticket_id: str,
    payload: AdminMarkPaidRequest,
    user: UserStore = Depends(get_current_user),
) -> dict:
    require_admin_user(user)
    ticket = get_withdraw_ticket_or_404(ticket_id)

    if ticket.status == "Pending":
        raise HTTPException(status_code=400, detail="Move request to processing before marking paid.")
    if ticket.status != "Processing":
        raise HTTPException(status_code=400, detail=f"Request already {ticket.status.lower()}.")

    ticket.status = "Paid"
    ticket.paid_at = utc_now().replace(microsecond=0).isoformat()
    ticket.paid_by = user.phone_number
    ticket.payout_reference = payload.payout_reference.strip()
    ticket.admin_note = payload.admin_note.strip() if payload.admin_note else None
    ticket.reviewed_at = ticket.paid_at
    ticket.reviewed_by = user.phone_number

    target_user = find_user_by_phone(ticket.phone_number)
    if not target_user:
        raise HTTPException(
            status_code=409,
            detail="Request owner account is missing. Cannot mark this request as paid.",
        )

    try:
        if PG_STORE.enabled():
            PG_STORE.update_latest_pending_withdraw(target_user.phone_number, ticket.amount, "Completed")
            refreshed_target = refresh_user_from_primary_store(target_user.phone_number)
            if refreshed_target is not None:
                target_user = refreshed_target
        else:
            update_latest_pending_withdraw_status(target_user, ticket.amount, "Completed")
            persist_users([target_user.phone_number])
        persist_withdraw_tickets()
    except Exception as exc:
        print(f"Failed to persist mark-paid update for ticket {ticket.id}: {exc}")
        raise HTTPException(
            status_code=500,
            detail="Failed to persist payout update. Check backend logs for details.",
        ) from None

    append_audit_event(
        "withdraw_paid",
        phone_number=ticket.phone_number,
        amount=ticket.amount,
        status=ticket.status,
        withdraw_ticket_id=ticket.id,
        bank=ticket.bank,
        account_number=ticket.account_number,
        account_holder=ticket.account_holder,
        actor_phone=user.phone_number,
        note=f"Payout reference: {ticket.payout_reference or '-'}; admin note: {ticket.admin_note or '-'}",
    )
    email_notified = send_admin_withdraw_paid_email(ticket)
    message = "Withdraw request marked as paid."
    if email_notified:
        message = f"{message} Admin payout email sent."
    return {"message": message, "item": ticket.model_dump(), "email_notified": email_notified}


@app.post("/api/admin/withdraw-requests/{ticket_id}/reject")
def reject_withdraw_request(ticket_id: str, user: UserStore = Depends(get_current_user)) -> dict:
    require_admin_user(user)
    ticket = get_withdraw_ticket_or_404(ticket_id)
    if ticket.status not in {"Pending", "Processing"}:
        raise HTTPException(status_code=400, detail=f"Request already {ticket.status.lower()}.")
    ticket.status = "Rejected"
    ticket.reviewed_at = utc_now().replace(microsecond=0).isoformat()
    ticket.reviewed_by = user.phone_number

    target_user = find_user_by_phone(ticket.phone_number)
    if target_user:
        if PG_STORE.enabled():
            PG_STORE.refund_withdraw(target_user.phone_number, float(ticket.amount))
            refreshed_target = refresh_user_from_primary_store(target_user.phone_number)
            if refreshed_target is not None:
                target_user = refreshed_target
        else:
            target_user.wallet.main_balance = round(target_user.wallet.main_balance + float(ticket.amount), 2)
            update_latest_pending_withdraw_status(target_user, ticket.amount, "Failed")
            record_transaction(target_user, "Deposit", ticket.amount, "Completed")
            persist_users([target_user.phone_number])
    persist_withdraw_tickets()
    append_audit_event(
        "withdraw_rejected",
        phone_number=ticket.phone_number,
        amount=ticket.amount,
        status=ticket.status,
        withdraw_ticket_id=ticket.id,
        bank=ticket.bank,
        account_number=ticket.account_number,
        account_holder=ticket.account_holder,
        actor_phone=user.phone_number,
        note="Withdraw request rejected and funds refunded to wallet.",
    )

    return {"message": "Withdraw request rejected and refunded.", "item": ticket.model_dump()}


@app.get("/api/wallet/history")
def wallet_history(user: UserStore = Depends(get_current_user)) -> dict:
    if PG_STORE.enabled():
        items = PG_STORE.load_user_history(user.phone_number, limit=50)
        return {"items": items}
    return {"items": [entry.model_dump() for entry in user.history[:50]]}


@app.get("/api/game/bet-history")
def bet_history(user: UserStore = Depends(get_current_user)) -> dict:
    if PG_STORE.enabled():
        items = PG_STORE.load_user_bet_history(user.phone_number, limit=100)
        return {"items": items}
    return {"items": [entry.model_dump() for entry in user.bet_history[:100]]}


@app.post("/api/wallet/deposit")
def submit_deposit(payload: DepositRequest, user: UserStore = Depends(get_current_user)) -> dict:
    tx_number = normalize_transaction_number(payload.transaction_number or "")
    if not re.fullmatch(r"[A-Z0-9-]{3,120}", tx_number):
        inferred_tx = extract_transaction_number_candidate(payload.transaction_number) or extract_transaction_number_candidate(
            payload.receipt_message,
        )
        if inferred_tx:
            tx_number = inferred_tx
    if not tx_number:
        raise HTTPException(
            status_code=400,
            detail="Transaction number is required. Paste your receipt message to auto-detect it.",
        )
    method = find_deposit_method(payload.method)
    validate_receipt_recipient(method, payload.receipt_message)
    ensure_valid_transaction_number(tx_number)
    links = validate_receipt_source_links(method.code, payload.receipt_message)
    reserve_deposit_receipt(tx_number, user.phone_number, links)

    amount = round(float(payload.amount), 2)
    if PG_STORE.enabled():
        PG_STORE.adjust_wallet_and_record_transaction(user.phone_number, amount, "Deposit", "Completed")
        refreshed_user = refresh_user_from_primary_store(user.phone_number)
        if refreshed_user is not None:
            user = refreshed_user
    else:
        user.wallet.main_balance = round(user.wallet.main_balance + amount, 2)
        record_transaction(user, "Deposit", amount, "Completed")
        persist_users([user.phone_number])
    append_audit_event(
        "deposit_confirmed",
        phone_number=user.phone_number,
        amount=amount,
        status="Completed",
        method=payload.method,
        transaction_number=tx_number,
        note="Deposit confirmed and wallet credited.",
    )
    return {
        "message": f"Deposit request accepted via {payload.method}.",
        "wallet": user.wallet.model_dump(),
    }


@app.post("/api/wallet/transfer")
def transfer_balance(payload: TransferRequest, user: UserStore = Depends(get_current_user)) -> dict:
    if not ENABLE_INTERNAL_TRANSFER:
        raise HTTPException(
            status_code=503,
            detail="Transfers are disabled in this environment until secure OTP verification is configured.",
        )
    if not verify_transfer_otp(user.phone_number, payload.otp):
        raise HTTPException(status_code=401, detail="Invalid or expired OTP")

    target_phone = normalize_phone(payload.phone_number)
    if target_phone == user.phone_number:
        raise HTTPException(status_code=400, detail="You cannot transfer to your own account")
    target_user = find_user_by_phone(target_phone)
    if not target_user:
        raise HTTPException(status_code=404, detail="Receiver account not found")
    amount = round(float(payload.amount), 2)
    if PG_STORE.enabled():
        try:
            PG_STORE.transfer_wallet_balance(user.phone_number, target_user.phone_number, amount)
        except ValueError as exc:
            if str(exc) == "insufficient_balance":
                raise HTTPException(status_code=400, detail="Insufficient balance")
            raise HTTPException(status_code=400, detail="Transfer request is invalid.") from None
        refreshed_sender = refresh_user_from_primary_store(user.phone_number)
        if refreshed_sender is not None:
            user = refreshed_sender
        refreshed_target = refresh_user_from_primary_store(target_user.phone_number)
        if refreshed_target is not None:
            target_user = refreshed_target
    else:
        if user.wallet.main_balance < amount:
            raise HTTPException(status_code=400, detail="Insufficient balance")

        user.wallet.main_balance = round(user.wallet.main_balance - amount, 2)
        target_user.wallet.main_balance = round(target_user.wallet.main_balance + amount, 2)
        record_transaction(user, "Transfer", amount, "Completed")
        record_transaction(target_user, "Deposit", amount, "Completed")
        persist_users([user.phone_number, target_user.phone_number])
    return {
        "message": "Transfer completed successfully.",
        "wallet": user.wallet.model_dump(),
    }


@app.post("/api/wallet/withdraw")
def withdraw_balance(payload: WithdrawRequest, user: UserStore = Depends(get_current_user)) -> dict:
    amount = round(float(payload.amount), 2)
    if amount < 100:
        raise HTTPException(status_code=400, detail="Minimum withdraw amount is 100 ETB")
    if PG_STORE.enabled():
        try:
            PG_STORE.adjust_wallet_and_record_transaction(user.phone_number, -amount, "Withdraw", "Pending")
        except ValueError as exc:
            if str(exc) == "insufficient_balance":
                raise HTTPException(status_code=400, detail="Insufficient balance")
            raise HTTPException(status_code=400, detail="Withdraw request is invalid.") from None
        refreshed_user = refresh_user_from_primary_store(user.phone_number)
        if refreshed_user is not None:
            user = refreshed_user
    else:
        if user.wallet.main_balance < amount:
            raise HTTPException(status_code=400, detail="Insufficient balance")
        user.wallet.main_balance = round(user.wallet.main_balance - amount, 2)
        record_transaction(user, "Withdraw", amount, "Pending")
    ticket = WithdrawTicket(
        id=secrets.token_hex(8),
        phone_number=user.phone_number,
        user_name=user.user_name,
        bank=payload.bank.strip(),
        account_number=payload.account_number.strip(),
        account_holder=payload.account_holder.strip(),
        amount=amount,
        status="Pending",
        created_at=utc_now().replace(microsecond=0).isoformat(),
        processing_at=None,
        processing_by=None,
        paid_at=None,
        paid_by=None,
        payout_reference=None,
        admin_note=None,
    )
    WITHDRAW_TICKETS.insert(0, ticket)
    if not PG_STORE.enabled():
        persist_users([user.phone_number])
    persist_withdraw_tickets()
    append_audit_event(
        "withdraw_requested",
        phone_number=user.phone_number,
        amount=amount,
        status="Pending",
        withdraw_ticket_id=ticket.id,
        bank=ticket.bank,
        account_number=ticket.account_number,
        account_holder=ticket.account_holder,
        note="Withdraw request submitted and waiting for admin payout.",
    )
    email_notified = send_admin_withdraw_email(ticket)
    message = "Withdraw request submitted to admin. It will be reviewed shortly."
    if email_notified:
        message = f"{message} Admin email alert sent."
    return {
        "message": message,
        "wallet": user.wallet.model_dump(),
        "request_id": ticket.id,
        "email_notified": email_notified,
    }


@app.get("/api/casino/games")
def casino_games(user: UserStore = Depends(get_current_user)) -> dict:
    return {"items": [game.model_dump() for game in CASINO_GAMES]}


def settle_casino_round(user: UserStore, game: CasinoGameItem, stake_value: float) -> dict:
    stake = round(float(stake_value), 2)
    if stake < game.min_bet or stake > game.max_bet:
        raise HTTPException(
            status_code=400,
            detail=f"Stake for {game.title} must be between ETB {game.min_bet:.2f} and ETB {game.max_bet:.2f}.",
        )
    multiplier = round(roll_casino_multiplier(game.id), 4)
    payout = round(stake * multiplier, 2)
    if PG_STORE.enabled():
        try:
            PG_STORE.adjust_wallet_and_record_transaction(user.phone_number, -stake, "Bet", "Completed")
        except ValueError as exc:
            if str(exc) == "insufficient_balance":
                raise HTTPException(status_code=400, detail="Insufficient balance")
            raise HTTPException(status_code=400, detail="Stake could not be processed.") from None
        if payout > 0:
            PG_STORE.adjust_wallet_and_record_transaction(user.phone_number, payout, "Win", "Completed")
        refreshed_user = refresh_user_from_primary_store(user.phone_number)
        if refreshed_user is not None:
            user = refreshed_user
    else:
        if user.wallet.main_balance < stake:
            raise HTTPException(status_code=400, detail="Insufficient balance")
        user.wallet.main_balance = round(user.wallet.main_balance - stake, 2)
        record_transaction(user, "Bet", stake, "Completed")
        if payout > 0:
            user.wallet.main_balance = round(user.wallet.main_balance + payout, 2)
            record_transaction(user, "Win", payout, "Completed")
        persist_users([user.phone_number])

    net = round(payout - stake, 2)
    outcome: Literal["win", "lose"] = "win" if payout > 0 else "lose"

    direction = "won" if net >= 0 else "lost"
    return {
        "message": f"{game.title} round finished. You {direction} ETB {abs(net):.2f}.",
        "wallet": user.wallet.model_dump(),
        "result": {
            "game_id": game.id,
            "game_title": game.title,
            "stake": stake,
            "multiplier": multiplier,
            "payout": payout,
            "net": net,
            "outcome": outcome,
            "played_at": utc_now().replace(microsecond=0).isoformat(),
        },
    }


@app.post("/api/casino/launch")
def casino_launch(payload: CasinoLaunchRequest, request: Request, user: UserStore = Depends(get_current_user)) -> dict:
    game = get_casino_game_or_404(payload.game_id)
    prune_expired_casino_launches()
    launch_id = secrets.token_urlsafe(18)
    mode_key = CASINO_PROVIDER_MODE or "selfhosted"

    if mode_key == "external":
        launch_url, mode = request_external_casino_launch_url(payload, user, game, launch_id)
    elif mode_key in {"selfhosted", "self-hosted", "free", "oss", "opensource"}:
        launch_url = build_selfhosted_casino_launch_url(request, game, launch_id)
        mode = "iframe"
    else:
        raise HTTPException(
            status_code=503,
            detail=(
                f"Unsupported CASINO_PROVIDER_MODE '{CASINO_PROVIDER_MODE}'. "
                "Use 'selfhosted' or 'external'."
            ),
        )

    now = utc_now().replace(microsecond=0)
    expires_at = now + timedelta(seconds=CASINO_LAUNCH_SESSION_SECONDS)
    CASINO_LAUNCH_SESSIONS[launch_id] = {
        "launch_id": launch_id,
        "game_id": game.id,
        "phone_number": user.phone_number,
        "provider": CASINO_PROVIDER_NAME,
        "launch_url": launch_url,
        "mode": mode,
        "created_at": now.isoformat(),
        "expires_at": expires_at.isoformat(),
    }

    return {
        "launch_id": launch_id,
        "game_id": game.id,
        "game_title": game.title,
        "provider": CASINO_PROVIDER_NAME,
        "mode": mode,
        "launch_url": launch_url,
        "expires_at": expires_at.isoformat(),
    }


@app.get("/casino/selfhosted/{game_id}", response_class=HTMLResponse)
def casino_selfhosted_page(game_id: str, launch_id: str) -> HTMLResponse:
    launch = get_casino_launch_session_or_404(launch_id)
    if launch.get("game_id") != game_id:
        raise HTTPException(status_code=404, detail="Launch session does not match this game")
    game = get_casino_game_or_404(game_id)
    html = build_selfhosted_game_html(game, launch_id)
    return HTMLResponse(content=html)


@app.post("/api/casino/play-launch")
def casino_play_launch(payload: CasinoLaunchPlayRequest) -> dict:
    launch = get_casino_launch_session_or_404(payload.launch_id)
    game_id = launch.get("game_id", "")
    phone_number = launch.get("phone_number", "")
    game = get_casino_game_or_404(game_id)
    user = find_user_by_phone(phone_number)
    if user is None:
        raise HTTPException(status_code=404, detail="Launch user not found")
    settled = settle_casino_round(user, game, payload.stake)
    launch["last_played_at"] = utc_now().replace(microsecond=0).isoformat()
    launch["expires_at"] = (utc_now() + timedelta(seconds=CASINO_LAUNCH_SESSION_SECONDS)).replace(microsecond=0).isoformat()
    return settled


@app.post("/api/casino/webhook")
async def casino_webhook(
    request: Request,
    x_signature: str | None = Header(default=None),
    x_casino_signature: str | None = Header(default=None),
) -> dict:
    raw_body = await request.body()
    if CASINO_WEBHOOK_SECRET:
        provided_signature = (x_casino_signature or x_signature or "").strip().lower()
        expected_signature = hmac.new(
            CASINO_WEBHOOK_SECRET.encode("utf-8"),
            raw_body,
            hashlib.sha256,
        ).hexdigest().lower()
        if not provided_signature or not hmac.compare_digest(provided_signature, expected_signature):
            raise HTTPException(status_code=401, detail="Invalid casino webhook signature")

    try:
        payload = json.loads(raw_body.decode("utf-8") or "{}")
    except Exception as exc:
        raise HTTPException(status_code=400, detail=f"Invalid casino webhook payload: {exc}") from exc

    if not isinstance(payload, dict):
        raise HTTPException(status_code=400, detail="Invalid casino webhook payload type")

    launch_id = (
        read_nested_str(payload, "launch_id")
        or read_nested_str(payload, "session_id")
        or read_nested_str(payload, "sessionId")
        or read_nested_str(payload, "round_id")
    )
    user: UserStore | None = None
    if launch_id:
        launch_record = CASINO_LAUNCH_SESSIONS.get(launch_id)
        if launch_record:
            user = find_user_by_phone(launch_record.get("phone_number", ""))

    if user is None:
        player_hint = (
            read_nested_str(payload, "phone_number")
            or read_nested_str(payload, "player_id")
            or read_nested_str(payload, "playerId")
            or read_nested_str(payload, "user_id")
            or read_nested_str(payload, "external_player_id")
        )
        if player_hint:
            user = find_user_by_phone(player_hint)

    if user is None:
        return {"status": "ignored", "reason": "user_not_found"}

    amount_value: object = None
    for key in ["amount", "net", "delta", "settlement_amount", "win_amount", "payout"]:
        if key in payload:
            amount_value = payload.get(key)
            break
    if amount_value is None:
        nested_settlement = payload.get("settlement")
        if isinstance(nested_settlement, dict):
            for key in ["amount", "net", "delta"]:
                if key in nested_settlement:
                    amount_value = nested_settlement.get(key)
                    break

    amount: float | None = None
    if isinstance(amount_value, (int, float)):
        amount = float(amount_value)
    elif isinstance(amount_value, str):
        cleaned = amount_value.replace(",", "").strip()
        try:
            amount = float(cleaned)
        except ValueError:
            amount = None

    if amount is None:
        return {"status": "ignored", "reason": "amount_missing"}

    normalized_amount = round(amount, 2)
    if PG_STORE.enabled():
        if normalized_amount > 0:
            PG_STORE.adjust_wallet_and_record_transaction(user.phone_number, normalized_amount, "Win", "Completed")
        elif normalized_amount < 0:
            debit = abs(normalized_amount)
            available = round(float(user.wallet.main_balance), 2)
            applied_debit = min(debit, available)
            if applied_debit > 0:
                PG_STORE.adjust_wallet_and_record_transaction(user.phone_number, -applied_debit, "Bet", "Completed")
            normalized_amount = -applied_debit
        refreshed_user = refresh_user_from_primary_store(user.phone_number)
        if refreshed_user is not None:
            user = refreshed_user
    else:
        if normalized_amount > 0:
            user.wallet.main_balance = round(user.wallet.main_balance + normalized_amount, 2)
            record_transaction(user, "Win", normalized_amount, "Completed")
        elif normalized_amount < 0:
            debit = abs(normalized_amount)
            user.wallet.main_balance = round(max(0.0, user.wallet.main_balance - debit), 2)
            record_transaction(user, "Bet", debit, "Completed")
        persist_users([user.phone_number])

    prune_expired_casino_launches()
    return {
        "status": "ok",
        "applied_amount": normalized_amount,
        "wallet": user.wallet.model_dump(),
    }


@app.post("/api/casino/play")
def casino_play(payload: CasinoPlayRequest, user: UserStore = Depends(get_current_user)) -> dict:
    game = get_casino_game_or_404(payload.game_id)
    return settle_casino_round(user, game, payload.stake)


@app.post("/api/game/preview")
def preview_card(payload: PreviewCardRequest, user: UserStore = Depends(get_current_user)) -> dict:
    stake = find_stake(payload.stake_id)
    room = get_or_create_room(stake)
    room_state = build_room_state(room, user.phone_number)
    queue = room_state.active_queue
    taken_map, held_map, held_updated_at = get_queue_maps(room, queue)

    owner = taken_map.get(payload.cartella_no)
    if owner and owner != user.phone_number:
        raise HTTPException(status_code=409, detail="This cartella is already taken")

    held_owner = held_map.get(payload.cartella_no)
    if held_owner and held_owner != user.phone_number:
        raise HTTPException(status_code=409, detail="This cartella is currently held by another player")

    previous_hold = get_user_held_cartella_from_map(held_map, user.phone_number)
    if previous_hold is not None and previous_hold != payload.cartella_no:
        held_map.pop(previous_hold, None)
        held_updated_at.pop(previous_hold, None)

    held_map[payload.cartella_no] = user.phone_number
    held_updated_at[payload.cartella_no] = utc_now()
    persist_rooms()

    card = create_bingo_card(payload.cartella_no)
    return {
        "stake": stake.model_dump(),
        "card": card.model_dump(),
        "room": build_room_state(room, user.phone_number).model_dump(),
        "queue": queue,
    }


@app.post("/api/game/join")
def join_stake(payload: JoinStakeRequest, user: UserStore = Depends(get_current_user)) -> dict:
    stake = find_stake(payload.stake_id)
    room = get_or_create_room(stake)
    room_state = build_room_state(room, user.phone_number)
    queue = room_state.active_queue
    taken_map, held_map, held_updated_at = get_queue_maps(room, queue)

    owner = taken_map.get(payload.cartella_no)
    if owner and owner != user.phone_number:
        raise HTTPException(status_code=409, detail="This cartella is already taken")

    held_owner = held_map.get(payload.cartella_no)
    if held_owner and held_owner != user.phone_number:
        raise HTTPException(status_code=409, detail="This cartella is currently held by another player")

    user_cards_in_queue = get_user_cartellas_from_map(taken_map, user.phone_number)
    if payload.cartella_no in user_cards_in_queue:
        current_cards = [create_bingo_card(cartella_no).model_dump() for cartella_no in get_user_cartellas_from_map(room.taken_cartellas, user.phone_number)]
        return {
            "message": "You already own this cartella.",
            "stake": stake.model_dump(),
            "wallet": user.wallet.model_dump(),
            "card": create_bingo_card(payload.cartella_no).model_dump(),
            "cards": current_cards,
            "room": build_room_state(room, user.phone_number).model_dump(),
            "queue": queue,
        }

    if len(user_cards_in_queue) >= MAX_CARDS_PER_USER:
        raise HTTPException(status_code=400, detail=f"Maximum {MAX_CARDS_PER_USER} cards per user in one game queue")

    stake_amount = round(float(stake.stake), 2)
    if not PG_STORE.enabled() and user.wallet.main_balance < stake_amount:
        raise HTTPException(status_code=400, detail="Insufficient balance")

    previous_hold = get_user_held_cartella_from_map(held_map, user.phone_number)
    if previous_hold is not None and previous_hold != payload.cartella_no:
        held_map.pop(previous_hold, None)
        held_updated_at.pop(previous_hold, None)

    if PG_STORE.enabled():
        try:
            PG_STORE.adjust_wallet_and_record_transaction(user.phone_number, -stake_amount, "Bet", "Completed")
        except ValueError as exc:
            if str(exc) == "insufficient_balance":
                raise HTTPException(status_code=400, detail="Insufficient balance")
            raise HTTPException(status_code=400, detail="Could not process the stake charge.") from None
        refreshed_user = refresh_user_from_primary_store(user.phone_number)
        if refreshed_user is not None:
            user = refreshed_user
    else:
        user.wallet.main_balance = round(user.wallet.main_balance - stake_amount, 2)
        record_transaction(user, "Bet", stake_amount, "Completed")
        persist_users([user.phone_number])

    taken_map[payload.cartella_no] = user.phone_number
    held_map.pop(payload.cartella_no, None)
    held_updated_at.pop(payload.cartella_no, None)
    room.marked_by_user_card[mark_key(user.phone_number, payload.cartella_no)] = []
    persist_rooms()

    card = create_bingo_card(payload.cartella_no)
    current_cards = [create_bingo_card(cartella_no).model_dump() for cartella_no in get_user_cartellas_from_map(room.taken_cartellas, user.phone_number)]
    return {
        "message": "Card purchased for current game." if queue == "current" else "Card booked for next game.",
        "stake": stake.model_dump(),
        "wallet": user.wallet.model_dump(),
        "card": card.model_dump(),
        "cards": current_cards,
        "room": build_room_state(room, user.phone_number).model_dump(),
        "queue": queue,
    }


@app.get("/api/game/room-by-stake/{stake_id}")
def get_room_by_stake(stake_id: str, user: UserStore = Depends(get_current_user)) -> dict:
    stake = find_stake(stake_id)
    room = get_or_create_room(stake)
    cards = [create_bingo_card(cartella_no).model_dump() for cartella_no in get_user_cartellas_from_map(room.taken_cartellas, user.phone_number)]
    card = cards[0] if cards else None
    return {
        "room": build_room_state(room, user.phone_number).model_dump(),
        "card": card,
        "cards": cards,
    }


@app.get("/api/game/room/{room_id}")
def get_room(room_id: str, user: UserStore = Depends(get_current_user)) -> dict:
    room = get_room_by_id(room_id)

    cards = [create_bingo_card(cartella_no).model_dump() for cartella_no in get_user_cartellas_from_map(room.taken_cartellas, user.phone_number)]
    card = cards[0] if cards else None
    return {
        "room": build_room_state(room, user.phone_number).model_dump(),
        "card": card,
        "cards": cards,
    }


@app.post("/api/game/mark-number")
def mark_number(payload: MarkNumberRequest, user: UserStore = Depends(get_current_user)) -> dict:
    room = get_room_by_id(payload.room_id)
    room_state = build_room_state(room, user.phone_number)

    if room_state.phase != "playing":
        raise HTTPException(status_code=400, detail="Game is not in playing phase")

    my_cartella = payload.cartella_no or room_state.my_cartella
    if my_cartella is None:
        raise HTTPException(status_code=400, detail="Join a cartella before marking numbers")
    if my_cartella not in room_state.my_cartellas:
        raise HTTPException(status_code=400, detail="You do not own this card")

    if payload.number not in room_state.called_numbers:
        raise HTTPException(status_code=400, detail="This number has not been called yet")

    card_values = card_numbers_set(my_cartella)
    if payload.number not in card_values:
        raise HTTPException(status_code=400, detail="This number is not on your card")

    marks = set(get_user_marked_numbers(room, user.phone_number, my_cartella))
    if payload.marked:
        marks.add(payload.number)
    else:
        marks.discard(payload.number)
    room.marked_by_user_card[mark_key(user.phone_number, my_cartella)] = sorted(marks)
    persist_rooms()

    return {
        "message": "Mark updated",
        "room": build_room_state(room, user.phone_number).model_dump(),
    }


@app.post("/api/game/claim-bingo")
def claim_bingo(payload: ClaimBingoRequest, user: UserStore = Depends(get_current_user)) -> dict:
    room = get_room_by_id(payload.room_id)
    room_state = build_room_state(room, user.phone_number)

    if room_state.phase == "selecting":
        raise HTTPException(status_code=400, detail="Game has not started yet")

    if room_state.phase == "finished":
        if room_state.winners:
            winners = ", ".join([f"{entry.user_name} (#{entry.cartella_no})" for entry in room_state.winners])
            winner = winners
        else:
            winner = room_state.winner_name or "Unknown"
        return {
            "message": f"Game already finished. Winner: {winner}",
            "wallet": user.wallet.model_dump(),
            "room": room_state.model_dump(),
        }

    my_cartella = payload.cartella_no or room_state.my_cartella
    if my_cartella is None:
        raise HTTPException(status_code=400, detail="Join a cartella before claiming bingo")
    if my_cartella not in room_state.my_cartellas:
        raise HTTPException(status_code=400, detail="You do not own this card")

    if room.claim_window_reference_time is not None:
        called_numbers_for_claim = compute_called_numbers(room, room.claim_window_reference_time)
    else:
        called_numbers_for_claim = room_state.called_numbers

    marks_for_card = room_state.my_marked_numbers_by_card.get(str(my_cartella), [])
    if not has_bingo_for_marks(my_cartella, called_numbers_for_claim, marks_for_card):
        raise HTTPException(status_code=400, detail="No completed bingo line yet")

    now = utc_now()

    # Open a short grace window so multiple valid claims can split payout.
    if room.claim_window_ends_at is None:
        room.claim_window_ends_at = now + timedelta(seconds=CLAIM_GRACE_SECONDS)
        room.claim_window_reference_time = now

    claim_key = (user.phone_number, my_cartella)
    exists = any((entry.phone_number, entry.cartella_no) == claim_key for entry in room.pending_claims)
    if not exists:
        room.pending_claims.append(ClaimEntry(phone_number=user.phone_number, cartella_no=my_cartella, claimed_at=now))

    finalize_claim_window_if_needed(room, now)
    persist_rooms()
    next_state = build_room_state(room, user.phone_number)

    if next_state.phase == "finished":
        winner_count = len(next_state.winners)
        split_note = f"split between {winner_count} winner(s)" if winner_count > 1 else "single winner payout"
        return {
            "message": f"Bingo finalized: {split_note}. House commission is 15%.",
            "wallet": user.wallet.model_dump(),
            "room": next_state.model_dump(),
        }

    return {
        "message": f"Claim received. Waiting {next_state.claim_window_seconds}s for final winner split.",
        "wallet": user.wallet.model_dump(),
        "room": next_state.model_dump(),
    }

