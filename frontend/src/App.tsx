import { FormEvent, useEffect, useMemo, useRef, useState } from "react";
import {
  approveAdminWithdrawRequest,
  claimBingo,
  clearAuthToken,
  fetchAdminWithdrawRequests,
  fetchBetHistory,
  fetchCasinoGames,
  fetchDashboard,
  fetchHistory,
  fetchStakeRoom,
  getAuthToken,
  joinStake,
  loginWithTelegram,
  markNumberForCard,
  login as loginRequest,
  markPaidAdminWithdrawRequest,
  launchCasinoGame,
  logout as logoutRequest,
  previewCard,
  rejectAdminWithdrawRequest,
  setAuthToken,
  signup as signupRequest,
  submitDeposit,
  submitTransfer,
  submitWithdraw,
  syncRoom,
  updateAdminDepositMethod,
} from "./api";
import type {
  AuthResponse,
  BetHistoryRecord,
  BingoCard,
  CasinoGame,
  CasinoLaunchResponse,
  DashboardResponse,
  DepositMethod,
  RoomState,
  StakeOption,
  TransactionRecord,
  UserProfile,
  Wallet,
  WithdrawTicket,
} from "./types";

type AuthMode = "login" | "signup";
type ServiceView = "home" | "stakes" | "game" | "casino" | "casino-launch" | "wallet" | "history" | "how" | "contact";
type CartellaStep = "pick" | "preview";
type WalletTab = "deposit" | "withdraw" | "transfer" | "history" | "admin";
type CasinoDisplayGame = CasinoGame & { image_url: string; exclusive?: boolean };

const AUTH_PHONE_STORAGE_KEY = "40bingo_auth_phone";
const AUTH_PASSWORD_STORAGE_KEY = "40bingo_auth_password";
const AUTH_REMEMBER_STORAGE_KEY = "40bingo_auth_remember_password";
const THEME_STORAGE_KEY = "40bingo_theme_mode";
const BRAND_MODAL_STORAGE_KEY = "40bingo_brand_modal_seen_at";
const LEGACY_AUTH_PHONE_STORAGE_KEY = "ethio_bingo_auth_phone";
const LEGACY_AUTH_PASSWORD_STORAGE_KEY = "ethio_bingo_auth_password";
const LEGACY_AUTH_REMEMBER_STORAGE_KEY = "ethio_bingo_auth_remember_password";
const LEGACY_THEME_STORAGE_KEY = "ethio_bingo_theme_mode";
const LEGACY_BRAND_MODAL_STORAGE_KEY = "ethio_bingo_brand_modal_seen_at";
const APP_BACK_GUARD_STATE_KEY = "__40bingo_back_guard";
const CASINO_ENABLED = false;

const services: Array<{ view: ServiceView; label: string }> = [
  { view: "home", label: "Home" },
  { view: "stakes", label: "Bingo Game" },
  { view: "game", label: "Live Game" },
  ...(CASINO_ENABLED ? [{ view: "casino" as ServiceView, label: "Casino Games" }] : []),
  { view: "wallet", label: "Wallet" },
  { view: "history", label: "History" },
  { view: "how", label: "How To Play" },
  { view: "contact", label: "Contact" },
];

const cartellaList = Array.from({ length: 200 }, (_, idx) => idx + 1);
const calledBoard = Array.from({ length: 75 }, (_, idx) => idx + 1);
const callerLetters = ["B", "I", "N", "G", "O"] as const;
const callerRows = Array.from({ length: 15 }, (_, idx) => [idx + 1, idx + 16, idx + 31, idx + 46, idx + 61]);
const fallbackBrand = {
  name: "40bingo",
  tagline: "Play smart. Win fair.",
  primary: "#391066",
  accent: "#ffd400",
  surface: "#a693c8",
};
const casinoTopCategories = [
  { id: "live", title: "LIVE", subtitle: "Live Dealer", icon: "LD" },
  { id: "new", title: "New Games", subtitle: "New Today", icon: "NEW" },
  { id: "jackpot", title: "Jackpot Slots", subtitle: "Big Wins", icon: "777" },
  { id: "exclusive", title: "Exclusive", subtitle: "Members", icon: "VIP" },
];
const casinoImageById: Record<string, string> = {
  "slots-megaways": "https://raw.githubusercontent.com/s0bvi/goldsvet-opensource/main/frontend/Default/ico/JokerSlotKA.jpg",
  "roulette-euro": "https://raw.githubusercontent.com/s0bvi/goldsvet-opensource/main/frontend/Default/ico/RouletteClassicPT.jpg",
  "blackjack-classic": "https://raw.githubusercontent.com/s0bvi/goldsvet-opensource/main/frontend/Default/ico/BlackJackAM.jpg",
  "baccarat-royal": "https://raw.githubusercontent.com/s0bvi/goldsvet-opensource/main/frontend/Default/ico/CasinoHoldemPG.jpg",
  "crash-orbit": "https://raw.githubusercontent.com/s0bvi/goldsvet-opensource/main/frontend/Default/ico/BillysGameAM.jpg",
  "mines-grid": "https://raw.githubusercontent.com/s0bvi/goldsvet-opensource/main/frontend/Default/ico/GameOfLuckEGT.jpg",
  "hilo-cards": "https://raw.githubusercontent.com/s0bvi/goldsvet-opensource/main/frontend/Default/ico/MoneyGame.jpg",
  "lucky-dice": "https://raw.githubusercontent.com/s0bvi/goldsvet-opensource/main/frontend/Default/ico/VirtualRouletteEGT.jpg",
};
const fallbackCasinoImage =
  "https://raw.githubusercontent.com/s0bvi/goldsvet-opensource/main/frontend/Default/img/casino1.png";
const fallbackCasinoGames: CasinoGame[] = [
  {
    id: "slots-megaways",
    title: "Slots Megaways",
    description: "Fast reel spins with stacked symbols and jackpot swings.",
    min_bet: 5,
    max_bet: 500,
    max_multiplier: 10,
    volatility: "high",
    provider: "OpenSource Casino 8.5",
  },
  {
    id: "roulette-euro",
    title: "European Roulette",
    description: "Single-zero roulette with high-risk payout spikes.",
    min_bet: 10,
    max_bet: 1000,
    max_multiplier: 20,
    volatility: "medium",
    provider: "OpenSource Casino 8.5",
  },
  {
    id: "blackjack-classic",
    title: "Blackjack Classic",
    description: "Classic 21 flow with steady medium volatility returns.",
    min_bet: 10,
    max_bet: 800,
    max_multiplier: 8,
    volatility: "low",
    provider: "OpenSource Casino 8.5",
  },
  {
    id: "baccarat-royal",
    title: "Baccarat Royal",
    description: "Banker versus player quick rounds with balanced odds.",
    min_bet: 10,
    max_bet: 900,
    max_multiplier: 9,
    volatility: "low",
    provider: "OpenSource Casino 8.5",
  },
  {
    id: "crash-orbit",
    title: "Crash Orbit",
    description: "Multiplier rush mode with explosive top-end payouts.",
    min_bet: 5,
    max_bet: 400,
    max_multiplier: 20,
    volatility: "high",
    provider: "OpenSource Casino 8.5",
  },
  {
    id: "mines-grid",
    title: "Mines Grid",
    description: "Reveal safe tiles and cash out before the mine hits.",
    min_bet: 5,
    max_bet: 350,
    max_multiplier: 12,
    volatility: "medium",
    provider: "OpenSource Casino 8.5",
  },
  {
    id: "hilo-cards",
    title: "Hi-Lo Cards",
    description: "Predict high or low swings for quick multiplier jumps.",
    min_bet: 5,
    max_bet: 300,
    max_multiplier: 6,
    volatility: "medium",
    provider: "OpenSource Casino 8.5",
  },
  {
    id: "lucky-dice",
    title: "Lucky Dice",
    description: "Two-dice instant rounds with frequent outcomes.",
    min_bet: 5,
    max_bet: 300,
    max_multiplier: 6,
    volatility: "low",
    provider: "OpenSource Casino 8.5",
  },
];

const fmtEtb = (value: number) => `ETB ${value.toFixed(2)}`;
const fmtDate = (value: string) => new Date(value).toLocaleString();
const fmtShortDate = (value: string) => new Date(value).toLocaleDateString("en-GB");
const fmtClock = (value: number) => {
  const safe = Math.max(0, Math.floor(value));
  const mins = Math.floor(safe / 60);
  const secs = safe % 60;
  return `${mins}:${String(secs).padStart(2, "0")}`;
};
const maskPhone = (value: string) => {
  if (value.length < 4) return value;
  return `${value.slice(0, 3)}***${value.slice(-2)}`;
};
const txLabelPattern =
  /\b(?:transaction(?:\s*(?:number|no|id|ref(?:erence)?))?|tx(?:n|id)?|trx|receipt(?:\s*(?:number|no|id))?|reference|ref)\b[\s:#=-]*([A-Za-z0-9-]{3,120})\b/i;
const txStopWords = new Set([
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
]);
const normalizeTransactionNumberInput = (value: string) => value.trim().replace(/\s+/g, "").toUpperCase();
const normalizePhoneForMatch = (value: string) => {
  const digits = value.replace(/\D/g, "");
  if (digits.startsWith("251") && digits.length === 12) return `0${digits.slice(3)}`;
  if (digits.startsWith("9") && digits.length === 9) return `0${digits}`;
  if (digits.startsWith("09") && digits.length === 10) return digits;
  return digits;
};
const normalizeAuthPhoneInput = (value: string) => {
  const trimmed = value.trim();
  const digits = trimmed.replace(/\D/g, "");
  if (digits.startsWith("2519") && digits.length === 12) return `+${digits}`;
  if (digits.startsWith("09") && digits.length === 10) return digits;
  if (digits.startsWith("9") && digits.length === 9) return `0${digits}`;
  return trimmed;
};
const isValidAuthPhoneInput = (value: string) => /^(09\d{8}|\+2519\d{8})$/.test(value);
const normalizeOwnerForMatch = (value: string) => value.toLowerCase().replace(/[^a-z0-9]/g, "");
const safeDecodeUriComponent = (value: string) => {
  try {
    return decodeURIComponent(value);
  } catch {
    return value;
  }
};
const extractReceiptLinks = (rawText: string) => rawText.match(/https?:\/\/[^\s]+/gi) ?? [];
const collectReceiptSearchSpaces = (rawText: string) => {
  const spaces = new Set<string>();
  const addSpace = (value: string | null | undefined) => {
    if (!value) return;
    const trimmed = value.trim();
    if (trimmed) spaces.add(trimmed);
  };

  addSpace(rawText);
  for (const link of extractReceiptLinks(rawText)) {
    addSpace(link);
    const decodedLink = safeDecodeUriComponent(link);
    addSpace(decodedLink);
    addSpace(decodedLink.replace(/\+/g, " "));

    try {
      const parsed = new URL(link);
      addSpace(parsed.pathname);
      addSpace(parsed.search);
      addSpace(parsed.hash);
      parsed.searchParams.forEach((value, key) => {
        const decodedValue = safeDecodeUriComponent(value);
        addSpace(value);
        addSpace(decodedValue);
        addSpace(decodedValue.replace(/\+/g, " "));
        addSpace(`${key} ${decodedValue}`);
      });
    } catch {
      // Ignore malformed links in pasted text.
    }
  }

  return Array.from(spaces);
};
const extractPhoneMatches = (rawText: string) => {
  const phonePattern = /(?:\+?251|0)?9(?:[\s().-]*\d){8}/g;
  const matches = new Set<string>();
  for (const segment of collectReceiptSearchSpaces(rawText)) {
    const found = segment.match(phonePattern) ?? [];
    for (const candidate of found) {
      const normalized = normalizePhoneForMatch(candidate);
      if (normalized.length > 0) {
        matches.add(normalized);
      }
    }
  }
  return matches;
};
const hasAssignedRecipientInReceipt = (
  message: string,
  accounts: Array<{ phone_number: string; owner_name: string }> | undefined,
) => {
  if (!accounts?.length) return true;
  const receiptPhones = extractPhoneMatches(message);
  const assignedPhones = new Set(accounts.map((account) => normalizePhoneForMatch(account.phone_number)));
  for (const phone of receiptPhones) {
    if (assignedPhones.has(phone)) return true;
  }
  const receiptOwnerHints = collectReceiptSearchSpaces(message)
    .map((value) => normalizeOwnerForMatch(value))
    .filter((value) => value.length > 0);
  for (const account of accounts) {
    const ownerToken = normalizeOwnerForMatch(account.owner_name);
    if (!ownerToken) continue;
    if (receiptOwnerHints.some((hint) => hint.includes(ownerToken))) {
      return true;
    }
  }
  return false;
};
const isLikelyTransactionToken = (token: string) => {
  if (!/^[A-Z0-9-]{3,120}$/.test(token)) return false;
  if (txStopWords.has(token)) return false;
  if (!/\d/.test(token)) return false;
  const hasLetter = /[A-Z]/.test(token);
  if (!hasLetter && token.length < 6) return false;
  if (/^\d{8,13}$/.test(token)) return false;
  return true;
};
const extractTransactionNumber = (rawText: string) => {
  const text = rawText.trim();
  if (!text) return "";

  const labeledMatch = text.match(txLabelPattern);
  if (labeledMatch?.[1]) {
    const candidate = normalizeTransactionNumberInput(labeledMatch[1]);
    if (isLikelyTransactionToken(candidate)) {
      return candidate;
    }
  }

  const tokens = text
    .toUpperCase()
    .replace(/[^A-Z0-9-\s]/g, " ")
    .split(/\s+/)
    .map((token) => token.trim())
    .filter(Boolean)
    .filter(isLikelyTransactionToken)
    .sort((a, b) => b.length - a.length);

  return tokens[0] ?? "";
};
const toBingoLetter = (value: number) => {
  if (value <= 15) return "B";
  if (value <= 30) return "I";
  if (value <= 45) return "N";
  if (value <= 60) return "G";
  return "O";
};
const toCallLabel = (value: number | null | undefined) => (typeof value === "number" ? `${toBingoLetter(value)} ${value}` : "--");
const marksForCard = (state: RoomState | null, cardNo: number | null) => {
  if (!state || !cardNo) return [];
  return state.my_marked_numbers_by_card?.[String(cardNo)] ?? [];
};

function hasBingo(card: BingoCard, calledNumbers: number[], marked: number[]) {
  const markedSet = new Set(marked);
  const allowed = new Set(calledNumbers);
  const check = (value: number | string) => {
    if (value === "FREE") return true;
    return typeof value === "number" && allowed.has(value) && markedSet.has(value);
  };
  const rows = card.grid.some((row) => row.every(check));
  const cols = [0, 1, 2, 3, 4].some((col) => card.grid.every((row) => check(row[col])));
  const d1 = [0, 1, 2, 3, 4].every((idx) => check(card.grid[idx][idx]));
  const d2 = [0, 1, 2, 3, 4].every((idx) => check(card.grid[idx][4 - idx]));
  return rows || cols || d1 || d2;
}

function getBingoLineCellIndexes(card: BingoCard, calledNumbers: number[]) {
  const calledSet = new Set(calledNumbers);
  const isHit = (value: number | string) => value === "FREE" || (typeof value === "number" && calledSet.has(value));
  const winners = new Set<number>();

  for (let row = 0; row < 5; row += 1) {
    if (card.grid[row].every(isHit)) {
      for (let col = 0; col < 5; col += 1) winners.add(row * 5 + col);
    }
  }

  for (let col = 0; col < 5; col += 1) {
    let complete = true;
    for (let row = 0; row < 5; row += 1) {
      if (!isHit(card.grid[row][col])) {
        complete = false;
        break;
      }
    }
    if (complete) {
      for (let row = 0; row < 5; row += 1) winners.add(row * 5 + col);
    }
  }

  let diag1 = true;
  for (let idx = 0; idx < 5; idx += 1) {
    if (!isHit(card.grid[idx][idx])) {
      diag1 = false;
      break;
    }
  }
  if (diag1) {
    for (let idx = 0; idx < 5; idx += 1) winners.add(idx * 5 + idx);
  }

  let diag2 = true;
  for (let idx = 0; idx < 5; idx += 1) {
    if (!isHit(card.grid[idx][4 - idx])) {
      diag2 = false;
      break;
    }
  }
  if (diag2) {
    for (let idx = 0; idx < 5; idx += 1) winners.add(idx * 5 + (4 - idx));
  }

  return winners;
}

function MethodCard({ method, active, onClick }: { method: DepositMethod; active: boolean; onClick: () => void }) {
  return (
    <button className={`method-card ${active ? "active" : ""}`} type="button" onClick={onClick}>
      {method.logo_url ? (
        <img
          src={method.logo_url}
          alt={`${method.label} logo`}
          className="method-logo"
          onError={(event) => {
            const target = event.currentTarget;
            if (target.dataset.fallbackApplied === "1") return;
            target.dataset.fallbackApplied = "1";
            target.src = method.code === "telebirr" ? "/providers/telebirr.svg" : "/providers/cbebirr.png";
          }}
        />
      ) : null}
      <strong>{method.label}</strong>
      <span>No transaction fee</span>
    </button>
  );
}

function AuthScreen({
  mode,
  setMode,
  name,
  setName,
  phone,
  setPhone,
  password,
  setPassword,
  busy,
  notice,
  error,
  rememberPassword,
  setRememberPassword,
  onSubmit,
  onTelegramLogin,
  telegramAvailable,
}: {
  mode: AuthMode;
  setMode: (mode: AuthMode) => void;
  name: string;
  setName: (value: string) => void;
  phone: string;
  setPhone: (value: string) => void;
  password: string;
  setPassword: (value: string) => void;
  busy: boolean;
  notice: string;
  error: string;
  rememberPassword: boolean;
  setRememberPassword: (value: boolean) => void;
  onSubmit: (event: FormEvent<HTMLFormElement>) => void;
  onTelegramLogin: () => void;
  telegramAvailable: boolean;
}) {
  const [showPassword, setShowPassword] = useState(false);
  const accountCreatedNotice = notice.toLowerCase().startsWith("account created");
  return (
    <div className="auth-shell">
      <div className="auth-brand-lockup">
        <img src="/brand/40bingo-logo.svg" alt="40bingo logo" className="auth-brand-logo" />
        <div>
          <h1>40bingo</h1>
          <p>Play smart. Win fair.</p>
        </div>
      </div>
      <div className="auth-card">
        <h2>{mode === "signup" ? "Create Your Account" : "Welcome Back"}</h2>
        <p className="auth-subtitle">{mode === "signup" ? "Create account to continue." : "Sign in to continue."}</p>
        <div className="auth-switch">
          <button type="button" className={mode === "login" ? "active" : ""} onClick={() => setMode("login")}>
            Login
          </button>
          <button type="button" className={mode === "signup" ? "active" : ""} onClick={() => setMode("signup")}>
            Signup
          </button>
        </div>
        <form className="auth-form" onSubmit={onSubmit}>
          {mode === "signup" && (
            <label>
              User Name
              <input value={name} onChange={(event) => setName(event.target.value)} required />
            </label>
          )}
          <label>
            Phone Number
            <input
              value={phone}
              maxLength={13}
              inputMode="tel"
              autoComplete="tel"
              placeholder="09XXXXXXXX or +2519XXXXXXXX"
              onChange={(event) => setPhone(event.target.value)}
              onBlur={(event) => setPhone(normalizeAuthPhoneInput(event.target.value))}
              required
            />
          </label>
          <label>
            Password
            <div className="auth-password-wrap">
              <input
                type={showPassword ? "text" : "password"}
                value={password}
                autoComplete={mode === "login" ? "current-password" : "new-password"}
                onChange={(event) => setPassword(event.target.value)}
                required
              />
              <button
                type="button"
                className="auth-password-toggle"
                onClick={() => setShowPassword((current) => !current)}
                aria-label={showPassword ? "Hide password" : "Show password"}
              >
                {showPassword ? "Hide" : "Show"}
              </button>
            </div>
          </label>
          <label className="auth-inline-check">
            <input type="checkbox" checked={rememberPassword} onChange={(event) => setRememberPassword(event.target.checked)} />
            <span>Remember password on this device</span>
          </label>
          {notice && <p className={`auth-notice ${accountCreatedNotice ? "account-created" : ""}`}>{notice}</p>}
          {error && <p className="auth-error">{error}</p>}
          <button className="primary-btn" type="submit" disabled={busy}>
            {busy ? "Please wait..." : mode === "login" ? "Log in" : "Create account"}
          </button>
          {telegramAvailable && (
            <button className="secondary-btn" type="button" disabled={busy} onClick={onTelegramLogin}>
              Continue with Telegram
            </button>
          )}
        </form>
      </div>
    </div>
  );
}

export default function App() {
  const backGuardArmedRef = useRef(false);
  const [ready, setReady] = useState(false);
  const [isDarkMode, setIsDarkMode] = useState(true);
  const [loading, setLoading] = useState(false);
  const [working, setWorking] = useState(false);
  const [cardRechargeLabel, setCardRechargeLabel] = useState("");
  const [notice, setNotice] = useState("");
  const [error, setError] = useState("");

  const [authMode, setAuthMode] = useState<AuthMode>("login");
  const [authBusy, setAuthBusy] = useState(false);
  const [authNotice, setAuthNotice] = useState("");
  const [authError, setAuthError] = useState("");
  const [authName, setAuthName] = useState("");
  const [authPhone, setAuthPhone] = useState("");
  const [authPassword, setAuthPassword] = useState("");
  const [rememberPassword, setRememberPassword] = useState(false);
  const [profile, setProfile] = useState<UserProfile | null>(null);

  const [dashboard, setDashboard] = useState<DashboardResponse | null>(null);
  const [history, setHistory] = useState<TransactionRecord[]>([]);
  const [betHistory, setBetHistory] = useState<BetHistoryRecord[]>([]);
  const [selectedBet, setSelectedBet] = useState<BetHistoryRecord | null>(null);
  const [service, setService] = useState<ServiceView>("home");
  const [drawerOpen, setDrawerOpen] = useState(false);
  const [casinoTapMode, setCasinoTapMode] = useState(false);
  const [activeCasinoCardId, setActiveCasinoCardId] = useState<string | null>(null);
  const [casinoGames, setCasinoGames] = useState<CasinoGame[]>(fallbackCasinoGames);
  const [casinoCatalogNotice, setCasinoCatalogNotice] = useState("");
  const [casinoLaunchBusyId, setCasinoLaunchBusyId] = useState<string | null>(null);
  const [casinoLaunch, setCasinoLaunch] = useState<CasinoLaunchResponse | null>(null);

  const [methodCode, setMethodCode] = useState<"telebirr" | "cbebirr">("telebirr");
  const [walletTab, setWalletTab] = useState<WalletTab>("deposit");
  const [depositGuideOpen, setDepositGuideOpen] = useState(false);
  const [depositAmount, setDepositAmount] = useState("100");
  const [txNo, setTxNo] = useState("");
  const [receiptMessage, setReceiptMessage] = useState("");
  const [transferPhone, setTransferPhone] = useState("");
  const [transferAmount, setTransferAmount] = useState("10");
  const [transferOtp, setTransferOtp] = useState("");
  const [withdrawBank, setWithdrawBank] = useState("CBE");
  const [withdrawAccountNumber, setWithdrawAccountNumber] = useState("");
  const [withdrawAccountHolder, setWithdrawAccountHolder] = useState("");
  const [withdrawAmount, setWithdrawAmount] = useState("50");
  const [adminDraftAccounts, setAdminDraftAccounts] = useState<Record<"telebirr" | "cbebirr", Array<{ phone_number: string; owner_name: string }>>>({
    telebirr: [],
    cbebirr: [],
  });
  const [adminWithdrawRequests, setAdminWithdrawRequests] = useState<WithdrawTicket[]>([]);
  const [adminPayoutRefs, setAdminPayoutRefs] = useState<Record<string, string>>({});
  const [copiedPhone, setCopiedPhone] = useState("");
  const [showBrandModal, setShowBrandModal] = useState(false);
  const [stakeCountdownNow, setStakeCountdownNow] = useState(() => Date.now());
  const [stakeCountdownDeadlines, setStakeCountdownDeadlines] = useState<Record<string, number>>({});

  const [selectedStake, setSelectedStake] = useState<StakeOption | null>(null);
  const [cartellaOpen, setCartellaOpen] = useState(false);
  const [cartellaStep, setCartellaStep] = useState<CartellaStep>("pick");
  const [pickerRoom, setPickerRoom] = useState<RoomState | null>(null);
  const [selectedCartella, setSelectedCartella] = useState<number | null>(null);
  const [processingCartella, setProcessingCartella] = useState<number | null>(null);
  const [preview, setPreview] = useState<BingoCard | null>(null);

  const [room, setRoom] = useState<RoomState | null>(null);
  const [cards, setCards] = useState<BingoCard[]>([]);
  const [selectedCardNo, setSelectedCardNo] = useState<number | null>(null);
  const [card, setCard] = useState<BingoCard | null>(null);
  const [markedNumbers, setMarkedNumbers] = useState<number[]>([]);
  const [markingNumber, setMarkingNumber] = useState<number | null>(null);
  const [claimingBingo, setClaimingBingo] = useState(false);
  const [autoClaimRequested, setAutoClaimRequested] = useState(false);

  const wallet: Wallet = dashboard?.wallet ?? { currency: "ETB", main_balance: 0, bonus_balance: 0 };
  const selectedMethod = useMemo(
    () => dashboard?.deposit_methods.find((method) => method.code === methodCode) ?? null,
    [dashboard, methodCode],
  );
  const paidSet = useMemo(() => new Set(pickerRoom?.paid_cartellas ?? []), [pickerRoom]);
  const simulatedPaidSet = useMemo(() => new Set(pickerRoom?.simulated_paid_cartellas ?? []), [pickerRoom]);
  const heldSet = useMemo(() => new Set(pickerRoom?.held_cartellas ?? []), [pickerRoom]);
  const calledSet = useMemo(() => new Set(room?.called_numbers ?? []), [room?.called_numbers]);
  const casinoCatalog = useMemo<CasinoDisplayGame[]>(
    () =>
      (casinoGames.length > 0 ? casinoGames : fallbackCasinoGames).map((game, idx) => ({
        ...game,
        image_url: casinoImageById[game.id] ?? fallbackCasinoImage,
        exclusive: idx < 4 || game.volatility === "high",
      })),
    [casinoGames],
  );
  const casinoCircleGames = useMemo(() => casinoCatalog.slice(0, 5), [casinoCatalog]);
  const casinoFeaturedGames = useMemo(() => casinoCatalog.slice(0, Math.min(5, casinoCatalog.length)), [casinoCatalog]);
  const casinoLatestGames = useMemo(() => (casinoCatalog.length > 5 ? casinoCatalog.slice(5) : casinoCatalog), [casinoCatalog]);

  useEffect(() => {
    try {
      const storedTheme = window.localStorage.getItem(THEME_STORAGE_KEY) ?? window.localStorage.getItem(LEGACY_THEME_STORAGE_KEY);
      if (storedTheme === "dark") {
        setIsDarkMode(true);
        return;
      }
      if (storedTheme === "light") {
        setIsDarkMode(false);
        return;
      }
      const prefersDark = window.matchMedia?.("(prefers-color-scheme: dark)")?.matches ?? true;
      setIsDarkMode(prefersDark);
    } catch {
      // ignore storage errors
    }
  }, []);

  useEffect(() => {
    const mode = isDarkMode ? "dark" : "light";
    document.documentElement.setAttribute("data-theme", mode);
    try {
      window.localStorage.setItem(THEME_STORAGE_KEY, mode);
      window.localStorage.removeItem(LEGACY_THEME_STORAGE_KEY);
    } catch {
      // ignore storage errors
    }
  }, [isDarkMode]);

  useEffect(() => {
    try {
      const remembered =
        (window.localStorage.getItem(AUTH_REMEMBER_STORAGE_KEY) ??
          window.localStorage.getItem(LEGACY_AUTH_REMEMBER_STORAGE_KEY)) === "1";
      const savedPhone =
        window.localStorage.getItem(AUTH_PHONE_STORAGE_KEY) ??
        window.localStorage.getItem(LEGACY_AUTH_PHONE_STORAGE_KEY) ??
        "";
      const savedPassword =
        window.localStorage.getItem(AUTH_PASSWORD_STORAGE_KEY) ??
        window.localStorage.getItem(LEGACY_AUTH_PASSWORD_STORAGE_KEY) ??
        "";
      setRememberPassword(remembered);
      if (savedPhone) setAuthPhone(savedPhone);
      if (remembered && savedPassword) setAuthPassword(savedPassword);
    } catch {
      // ignore storage errors
    }
  }, []);

  useEffect(() => {
    try {
      window.localStorage.setItem(AUTH_REMEMBER_STORAGE_KEY, rememberPassword ? "1" : "0");
      window.localStorage.setItem(AUTH_PHONE_STORAGE_KEY, authPhone);
      window.localStorage.removeItem(LEGACY_AUTH_REMEMBER_STORAGE_KEY);
      window.localStorage.removeItem(LEGACY_AUTH_PHONE_STORAGE_KEY);
      if (rememberPassword) {
        window.localStorage.setItem(AUTH_PASSWORD_STORAGE_KEY, authPassword);
        window.localStorage.removeItem(LEGACY_AUTH_PASSWORD_STORAGE_KEY);
      } else {
        window.localStorage.removeItem(AUTH_PASSWORD_STORAGE_KEY);
        window.localStorage.removeItem(LEGACY_AUTH_PASSWORD_STORAGE_KEY);
      }
    } catch {
      // ignore storage errors
    }
  }, [authPhone, authPassword, rememberPassword]);

  useEffect(() => {
    if (!notice) return;
    const timer = window.setTimeout(() => setNotice(""), 4500);
    return () => window.clearTimeout(timer);
  }, [notice]);

  useEffect(() => {
    const onAuthExpired = () => {
      clearAuthToken();
      setProfile(null);
      setDashboard(null);
      setRoom(null);
      setCards([]);
      setSelectedCardNo(null);
      setCard(null);
      setMarkedNumbers([]);
      setService("home");
      setDrawerOpen(false);
      setCartellaOpen(false);
      setDepositGuideOpen(false);
      setSelectedBet(null);
      setAuthNotice("");
      setAuthError("");
      setError("");
      setLoading(false);
      setWorking(false);
      setNotice("Session expired. Please sign in again.");
    };
    window.addEventListener("auth:expired", onAuthExpired);
    return () => window.removeEventListener("auth:expired", onAuthExpired);
  }, []);

  useEffect(() => {
    const detectTapMode = () => {
      const coarsePointer = window.matchMedia?.("(pointer: coarse)")?.matches ?? false;
      const noHover = window.matchMedia?.("(hover: none)")?.matches ?? false;
      setCasinoTapMode(coarsePointer || noHover || window.innerWidth <= 820);
    };
    detectTapMode();
    window.addEventListener("resize", detectTapMode);
    return () => window.removeEventListener("resize", detectTapMode);
  }, []);

  useEffect(() => {
    if (!casinoTapMode || service !== "casino") {
      setActiveCasinoCardId(null);
    }
    if (service !== "casino-launch") {
      setCasinoLaunch(null);
      setCasinoLaunchBusyId(null);
    }
  }, [casinoTapMode, service]);

  useEffect(() => {
    if (!CASINO_ENABLED && (service === "casino" || service === "casino-launch")) {
      setService("home");
      setNotice("Casino games are temporarily unavailable while design is finalized.");
    }
  }, [service]);

  useEffect(() => {
    if (!drawerOpen) return;
    const previousOverflow = document.body.style.overflow;
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        setDrawerOpen(false);
      }
    };

    document.body.style.overflow = "hidden";
    window.addEventListener("keydown", onKeyDown);
    return () => {
      document.body.style.overflow = previousOverflow;
      window.removeEventListener("keydown", onKeyDown);
    };
  }, [drawerOpen]);

  useEffect(() => {
    if (service !== "stakes") return;
    const tick = () => setStakeCountdownNow(Date.now());
    tick();
    const timer = window.setInterval(tick, 1000);
    return () => window.clearInterval(timer);
  }, [service]);

  useEffect(() => {
    const stakeOptions = dashboard?.stake_options ?? [];
    if (!stakeOptions.length) {
      setStakeCountdownDeadlines({});
      return;
    }

    const syncedAt = Date.now();
    setStakeCountdownDeadlines((prev) => {
      const next: Record<string, number> = {};
      for (const option of stakeOptions) {
        if (option.countdown_seconds == null) continue;
        const safeSeconds = Math.max(0, option.countdown_seconds);
        const serverDeadline = syncedAt + safeSeconds * 1000;
        const previousDeadline = prev[option.id];
        if (previousDeadline && Math.abs(previousDeadline - serverDeadline) <= 1500 && safeSeconds > 0) {
          next[option.id] = previousDeadline;
          continue;
        }
        next[option.id] = serverDeadline;
      }
      return next;
    });
  }, [dashboard?.stake_options]);

  useEffect(() => {
    if (!dashboard?.deposit_methods?.length) return;
    if (walletTab === "admin" && profile?.is_admin) return;
    setAdminDraftAccounts((prev) => {
      const next: Record<"telebirr" | "cbebirr", Array<{ phone_number: string; owner_name: string }>> = {
        telebirr:
          dashboard.deposit_methods
            .find((method) => method.code === "telebirr")
            ?.transfer_accounts.map((account) => ({ ...account })) ?? prev.telebirr,
        cbebirr:
          dashboard.deposit_methods
            .find((method) => method.code === "cbebirr")
            ?.transfer_accounts.map((account) => ({ ...account })) ?? prev.cbebirr,
      };
      return next;
    });
  }, [dashboard?.deposit_methods, walletTab, profile?.is_admin]);

  useEffect(() => {
    if (!profile) return;
    const raw =
      window.localStorage.getItem(BRAND_MODAL_STORAGE_KEY) ??
      window.localStorage.getItem(LEGACY_BRAND_MODAL_STORAGE_KEY);
    const lastSeen = raw ? Number(raw) : 0;
    const cooldownMs = 1000 * 60 * 60 * 6;
    if (!Number.isFinite(lastSeen) || Date.now() - lastSeen >= cooldownMs) {
      setShowBrandModal(true);
    }
  }, [profile?.phone_number]);

  const openService = (next: ServiceView) => {
    if (!CASINO_ENABLED && (next === "casino" || next === "casino-launch")) {
      setService("home");
      setNotice("Casino games are temporarily unavailable while design is finalized.");
      setDrawerOpen(false);
      return;
    }
    if (next === "game" && (!room || !cards.length)) {
      setService("stakes");
      setNotice("Choose stake and buy cartella first.");
      setDrawerOpen(false);
      return;
    }
    setService(next);
    setDrawerOpen(false);
  };

  const handleCasinoCardTap = (gameId: string) => {
    if (!casinoTapMode) return;
    setActiveCasinoCardId((prev) => (prev === gameId ? null : gameId));
  };

  const handleCasinoPlay = async (game: CasinoDisplayGame) => {
    setActiveCasinoCardId(null);
    setCasinoLaunchBusyId(game.id);
    setError("");
    try {
      const launch = await launchCasinoGame({
        game_id: game.id,
        device: casinoTapMode ? "mobile" : "desktop",
        locale: "en",
        return_url: window.location.href,
      });
      if (launch.mode === "redirect") {
        window.location.assign(launch.launch_url);
        return;
      }
      setCasinoLaunch(launch);
      setService("casino-launch");
      setDrawerOpen(false);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Unable to launch casino game");
    } finally {
      setCasinoLaunchBusyId(null);
    }
  };

  const closeCasinoLaunch = () => {
    setCasinoLaunch(null);
    setService(CASINO_ENABLED ? "casino" : "home");
  };

  const refreshHistory = async () => {
    const data = await fetchHistory();
    setHistory(data.items);
  };

  const safeFetchBetHistory = async () => {
    try {
      return await fetchBetHistory();
    } catch (err) {
      const message = err instanceof Error ? err.message.toLowerCase() : "";
      if (message.includes("not found") || message.includes("request failed")) {
        return { items: [] as BetHistoryRecord[] };
      }
      throw err;
    }
  };

  const refreshBetHistory = async () => {
    const data = await safeFetchBetHistory();
    setBetHistory(data.items);
  };

  const refreshAdminWithdrawRequests = async () => {
    if (!profile?.is_admin) return;
    const data = await fetchAdminWithdrawRequests();
    setAdminWithdrawRequests(data.items);
    setAdminPayoutRefs((prev) => {
      const next = { ...prev };
      for (const item of data.items) {
        if (!next[item.id]) {
          next[item.id] = item.payout_reference ?? "";
        }
      }
      return next;
    });
  };

  const loadData = async () => {
    setLoading(true);
    setError("");
    try {
      const [dash, hist, betHist, casino] = await Promise.all([
        fetchDashboard(),
        fetchHistory(),
        safeFetchBetHistory(),
        fetchCasinoGames().catch(() => ({ items: fallbackCasinoGames })),
      ]);
      setDashboard(dash);
      setProfile(dash.user);
      setHistory(hist.items);
      setBetHistory(betHist.items);
      setCasinoGames(casino.items.length > 0 ? casino.items : fallbackCasinoGames);
      setCasinoCatalogNotice(casino.items.length > 0 ? "" : "Showing cached casino lineup.");
      if (dash.deposit_methods.length > 0) {
        setMethodCode(dash.deposit_methods[0].code);
      }
    } catch (err) {
      const message = err instanceof Error ? err.message : "Unable to load data";
      setError(message);
      if (message.toLowerCase().includes("auth") || message.toLowerCase().includes("session")) {
        clearAuthToken();
        setProfile(null);
        setDashboard(null);
      }
    } finally {
      setLoading(false);
      setReady(true);
    }
  };

  const completeAuthFlow = (auth: AuthResponse, normalizedPhone: string, successMessage: string) => {
    setAuthToken(auth.token);
    setProfile(auth.user);
    setDashboard((prev) => ({
      brand: prev?.brand ?? fallbackBrand,
      user: auth.user,
      is_admin: auth.user.is_admin,
      wallet: auth.wallet,
      deposit_methods: prev?.deposit_methods ?? [],
      stake_options: prev?.stake_options ?? [],
      faq: prev?.faq ?? [],
      games: prev?.games ?? [],
    }));
    setNotice(successMessage);
    setAuthName("");
    setAuthPhone(normalizedPhone);
    if (!rememberPassword) {
      setAuthPassword("");
    }
    setAuthMode("login");
    setDrawerOpen(false);
    setService("home");
    void loadData();
  };

  useEffect(() => {
    const token = getAuthToken();
    if (!token) {
      setReady(true);
      return;
    }
    void loadData();
  }, []);

  useEffect(() => {
    if (!profile) return;
    if (!profile.is_admin && walletTab === "admin") {
      setWalletTab("deposit");
    }
  }, [profile, walletTab]);

  useEffect(() => {
    if (!profile?.is_admin || walletTab !== "admin") return;
    let inFlight = false;
    const poll = () => {
      if (inFlight) return;
      inFlight = true;
      void (async () => {
        try {
          await refreshAdminWithdrawRequests();
        } finally {
          inFlight = false;
        }
      })();
    };
    poll();
    const timer = window.setInterval(poll, 2500);
    return () => window.clearInterval(timer);
  }, [profile?.is_admin, walletTab]);

  useEffect(() => {
    if (!profile) {
      backGuardArmedRef.current = false;
      return;
    }
    if (backGuardArmedRef.current) return;
    try {
      const currentState =
        window.history.state && typeof window.history.state === "object"
          ? (window.history.state as Record<string, unknown>)
          : {};
      window.history.pushState({ ...currentState, [APP_BACK_GUARD_STATE_KEY]: true }, "", window.location.href);
      backGuardArmedRef.current = true;
    } catch {
      // Ignore history API errors in constrained webviews.
    }
  }, [profile?.phone_number]);

  useEffect(() => {
    if (!profile) return;
    const onPopState = () => {
      if (!getAuthToken()) return;
      setDrawerOpen(false);
      setCartellaOpen(false);
      setDepositGuideOpen(false);
      setSelectedBet(null);
      setCartellaStep("pick");
      setService("home");
      try {
        const currentState =
          window.history.state && typeof window.history.state === "object"
            ? (window.history.state as Record<string, unknown>)
            : {};
        window.history.pushState({ ...currentState, [APP_BACK_GUARD_STATE_KEY]: true }, "", window.location.href);
      } catch {
        // Ignore history API errors in constrained webviews.
      }
    };
    window.addEventListener("popstate", onPopState);
    return () => window.removeEventListener("popstate", onPopState);
  }, [profile?.phone_number]);

  useEffect(() => {
    if (!profile) return;
    if (cartellaOpen || service === "game") return;
    let inFlight = false;
    const pollIntervalMs = service === "stakes" ? 1000 : 1800;
    const pollDashboard = () => {
      if (inFlight) return;
      inFlight = true;
      void (async () => {
        try {
          const dash = await fetchDashboard();
          setDashboard(dash);
          setProfile(dash.user);
        } catch {
          // keep polling
        } finally {
          inFlight = false;
        }
      })();
    };
    pollDashboard();
    const timer = window.setInterval(() => {
      pollDashboard();
    }, pollIntervalMs);
    return () => window.clearInterval(timer);
  }, [profile?.phone_number, service, cartellaOpen]);

  useEffect(() => {
    if (!room?.id || service !== "game") return;
    let inFlight = false;
    const pollRoom = () => {
      if (inFlight) return;
      inFlight = true;
      void (async () => {
        try {
          const synced = await syncRoom(room.id);
          setRoom(synced.room);
          setCards(synced.cards ?? (synced.card ? [synced.card] : []));
        } catch {
          // keep polling
        } finally {
          inFlight = false;
        }
      })();
    };
    pollRoom();
    const timer = window.setInterval(() => {
      pollRoom();
    }, 1200);
    return () => window.clearInterval(timer);
  }, [room?.id, service]);

  useEffect(() => {
    if (!cards.length) {
      setSelectedCardNo(null);
      setCard(null);
      return;
    }
    setSelectedCardNo((prev) => {
      if (prev && cards.some((item) => item.card_no === prev)) return prev;
      return cards[0].card_no;
    });
  }, [cards]);

  useEffect(() => {
    if (!selectedCardNo) {
      setCard(null);
      setMarkedNumbers([]);
      return;
    }
    const selected = cards.find((item) => item.card_no === selectedCardNo) ?? null;
    setCard(selected);
    setMarkedNumbers(marksForCard(room, selectedCardNo));
  }, [selectedCardNo, cards, room]);

  useEffect(() => {
    if (!cartellaOpen || !selectedStake) return;
    let inFlight = false;
    const pollStakeRoom = () => {
      if (inFlight) return;
      inFlight = true;
      void (async () => {
        try {
          const res = await fetchStakeRoom(selectedStake.id);
          setPickerRoom(res.room);
          if (res.room.my_held_cartella && cartellaStep === "pick" && !selectedCartella) {
            setSelectedCartella(res.room.my_held_cartella);
          }
        } catch {
          // keep polling
        } finally {
          inFlight = false;
        }
      })();
    };

    pollStakeRoom();

    const timer = window.setInterval(() => {
      pollStakeRoom();
    }, 1000);

    return () => window.clearInterval(timer);
  }, [cartellaOpen, selectedStake, cartellaStep, selectedCartella]);

  useEffect(() => {
    if (
      cartellaOpen &&
      pickerRoom?.phase === "playing" &&
      room?.id === pickerRoom.id &&
      pickerRoom?.my_cartellas?.length > 0 &&
      cards.length > 0
    ) {
      setCartellaOpen(false);
      setService("game");
    }
  }, [cartellaOpen, pickerRoom?.phase, pickerRoom?.id, pickerRoom?.my_cartellas, room?.id, cards.length]);

  useEffect(() => {
    const roundFinished = room?.phase === "finished" || (cartellaOpen && pickerRoom?.phase === "finished");
    const inGameFlow = service === "game" || service === "stakes" || cartellaOpen;
    if (!roundFinished || !inGameFlow) return;
    const timer = window.setTimeout(() => {
      setCartellaOpen(false);
      setCartellaStep("pick");
      setService("home");
      setNotice("Round finished. Returning to Home.");
    }, 1800);
    return () => window.clearTimeout(timer);
  }, [service, room?.phase, room?.id, pickerRoom?.phase, pickerRoom?.id, cartellaOpen]);

  useEffect(() => {
    if (!cardRechargeLabel) return;
    const timer = window.setTimeout(() => setCardRechargeLabel(""), 7000);
    return () => window.clearTimeout(timer);
  }, [cardRechargeLabel]);

  useEffect(() => {
    if (!autoClaimRequested) return;
    if (markingNumber !== null || claimingBingo) return;
    const claimReady = room?.phase === "playing" && !!card ? hasBingo(card, room?.called_numbers ?? [], markedNumbers) : false;
    if (!claimReady || !room?.id) {
      setAutoClaimRequested(false);
      return;
    }
    void onClaimBingo();
  }, [autoClaimRequested, markingNumber, claimingBingo, room, card, markedNumbers]);

  const onAuthSubmit = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    setAuthBusy(true);
    setAuthNotice("");
    setAuthError("");
    try {
      const normalizedPhone = normalizeAuthPhoneInput(authPhone);
      if (!isValidAuthPhoneInput(normalizedPhone)) {
        throw new Error("Use phone format 09XXXXXXXX or +2519XXXXXXXX.");
      }
      setAuthPhone(normalizedPhone);
      if (authMode === "signup") {
        const res = await signupRequest({
          user_name: authName.trim(),
          phone_number: normalizedPhone,
          password: authPassword,
        });
        completeAuthFlow(res, normalizedPhone, "Account created and signed in.");
      } else {
        const res = await loginRequest({
          phone_number: normalizedPhone,
          password: authPassword,
        });
        completeAuthFlow(res, normalizedPhone, "Signed in successfully.");
      }
    } catch (err) {
      const message = err instanceof Error ? err.message : "Login failed";
      const normalizedMessage = message.toLowerCase();
      if (
        authMode === "signup" &&
        (normalizedMessage.includes("already registered") ||
          normalizedMessage.includes("already exists") ||
          normalizedMessage.includes("already in use"))
      ) {
        setAuthMode("login");
        setAuthNotice("This phone number already exists. Please log in.");
        setAuthError("");
        return;
      }
      if (authMode === "login" && normalizedMessage.includes("invalid phone number or password")) {
        setAuthError("Incorrect phone number or password.");
        return;
      }
      setAuthError(message);
    } finally {
      setAuthBusy(false);
    }
  };

  const onTelegramLogin = async () => {
    setAuthBusy(true);
    setAuthNotice("");
    setAuthError("");
    try {
      const tgInitData = (
        window as Window & { Telegram?: { WebApp?: { initData?: string } } }
      ).Telegram?.WebApp?.initData;
      if (!tgInitData) {
        throw new Error("Open this app inside Telegram to use Telegram authentication.");
      }
      const phoneForLink = normalizeAuthPhoneInput(authPhone);
      const canLinkExisting = isValidAuthPhoneInput(phoneForLink) && authPassword.trim().length >= 6;
      const res = await loginWithTelegram({
        init_data: tgInitData,
        ...(canLinkExisting ? { phone_number: phoneForLink, password: authPassword } : {}),
      });
      completeAuthFlow(res, res.user.phone_number, "Telegram sign-in successful.");
    } catch (err) {
      setAuthError(err instanceof Error ? err.message : "Telegram login failed");
    } finally {
      setAuthBusy(false);
    }
  };

  const onLogout = async () => {
    try {
      await logoutRequest();
    } catch {
      // no-op
    }
    clearAuthToken();
    setProfile(null);
    setDashboard(null);
    setHistory([]);
    setBetHistory([]);
    setSelectedBet(null);
    setRoom(null);
    setCards([]);
    setSelectedCardNo(null);
    setCard(null);
    setMarkedNumbers([]);
    setService("home");
    setDrawerOpen(false);
    setShowBrandModal(false);
  };

  const onOpenStake = async (stake: StakeOption) => {
    setSelectedStake(stake);
    setSelectedCartella(null);
    setProcessingCartella(null);
    setPreview(null);
    setCartellaStep("pick");
    setCartellaOpen(true);
    setWorking(true);
    setError("");
    try {
      const res = await fetchStakeRoom(stake.id);
      setPickerRoom(res.room);
      setRoom(res.room);
      setCards(res.cards ?? (res.card ? [res.card] : []));
      if (res.room.my_cartella) {
        setSelectedCartella(res.room.my_cartella);
      } else if (res.room.my_held_cartella) {
        setSelectedCartella(res.room.my_held_cartella);
      }
      if (res.card) {
        setPreview(res.card);
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : "Unable to open cartella");
      setCartellaOpen(false);
    } finally {
      setWorking(false);
    }
  };

  const onOpenLiveStake = async (stake: StakeOption) => {
    setWorking(true);
    setError("");
    try {
      const res = await fetchStakeRoom(stake.id);
      setPickerRoom(res.room);
      setRoom(res.room);
      const ownedCards = res.cards ?? (res.card ? [res.card] : []);
      setCards(ownedCards);
      if (!ownedCards.length) {
        setNotice("No active bought cartella for this live game.");
        return;
      }
      setSelectedCardNo((prev) => {
        if (prev && ownedCards.some((item) => item.card_no === prev)) return prev;
        return ownedCards[0].card_no;
      });
      setService("game");
    } catch (err) {
      setError(err instanceof Error ? err.message : "Unable to open live game");
    } finally {
      setWorking(false);
    }
  };

  const onPreviewCartella = async () => {
    if (!selectedStake || !selectedCartella) {
      setError("Select cartella number first.");
      return;
    }
    setWorking(true);
    setError("");
    try {
      const res = await previewCard(selectedStake.id, selectedCartella);
      setPickerRoom(res.room);
      setRoom(res.room);
      setPreview(res.card);
      setCartellaStep("preview");
    } catch (err) {
      setError(err instanceof Error ? err.message : "Unable to preview card");
    } finally {
      setWorking(false);
    }
  };

  const onConfirmCartella = async () => {
    if (!selectedStake || !selectedCartella) return;
    setProcessingCartella(selectedCartella);
    setWorking(true);
    setError("");
    try {
      const res = await joinStake(selectedStake.id, selectedCartella);
      setDashboard((prev) => (prev ? { ...prev, wallet: res.wallet } : prev));
      setPickerRoom(res.room);
      setRoom(res.room);
      const returnedCards = res.cards ?? (res.card ? [res.card] : []);
      const mergedCards =
        res.card && !returnedCards.some((item) => item.card_no === res.card.card_no)
          ? [...returnedCards, res.card]
          : returnedCards;
      setCards(mergedCards);
      setSelectedCardNo(res.card?.card_no ?? selectedCartella);
      setNotice(res.message);
      void refreshHistory();
      if (res.room.phase === "playing" && res.queue !== "next") {
        setCartellaOpen(false);
        setService("game");
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : "Unable to confirm cartella");
    } finally {
      setProcessingCartella(null);
      setWorking(false);
    }
  };

  const onDeposit = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    setWorking(true);
    setError("");
    try {
      const amount = Number(depositAmount);
      const receiptText = receiptMessage.trim();
      const directTxNo = normalizeTransactionNumberInput(txNo);
      const inferredTxNo = extractTransactionNumber(receiptText);
      const transactionNumber = directTxNo || inferredTxNo;
      if (!selectedMethod) throw new Error("Select a deposit method first.");
      if (!amount || amount <= 0) throw new Error("Enter valid amount.");
      if (!receiptText) throw new Error("Paste receipt message so recipient account can be verified.");
      if (!hasAssignedRecipientInReceipt(receiptText, selectedMethod.transfer_accounts)) {
        throw new Error("Receipt must show one assigned receiver number or name.");
      }
      if (transactionNumber.length < 3) throw new Error("Enter valid transaction number or paste the receipt message.");
      const res = await submitDeposit({
        method: methodCode,
        amount,
        transaction_number: transactionNumber,
        receipt_message: receiptText,
      });
      setDashboard((prev) => (prev ? { ...prev, wallet: res.wallet } : prev));
      setNotice(res.message);
      setCardRechargeLabel(`Recharged +ETB ${amount.toFixed(2)}`);
      setTxNo("");
      setReceiptMessage("");
      setDepositGuideOpen(false);
      await refreshHistory();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Deposit failed");
    } finally {
      setWorking(false);
    }
  };

  const onTransfer = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    setWorking(true);
    setError("");
    try {
      const amount = Number(transferAmount);
      if (!amount || amount <= 0) throw new Error("Enter valid transfer amount.");
      if (!transferPhone.trim()) throw new Error("Enter recipient phone number.");
      if (!/^\d{4,6}$/.test(transferOtp.trim())) throw new Error("Enter valid OTP (4 to 6 digits).");
      const res = await submitTransfer({
        phone_number: transferPhone.trim(),
        amount,
        otp: transferOtp.trim(),
      });
      setDashboard((prev) => (prev ? { ...prev, wallet: res.wallet } : prev));
      setNotice(res.message);
      setTransferPhone("");
      setTransferAmount("10");
      setTransferOtp("");
      await refreshHistory();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Transfer failed");
    } finally {
      setWorking(false);
    }
  };

  const onWithdraw = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    setWorking(true);
    setError("");
    try {
      const amount = Number(withdrawAmount);
      if (!amount || amount <= 0) throw new Error("Enter valid withdraw amount.");
      if (!withdrawAccountNumber.trim()) throw new Error("Enter account number.");
      if (!withdrawAccountHolder.trim()) throw new Error("Enter account holder name.");
      const res = await submitWithdraw({
        bank: withdrawBank,
        account_number: withdrawAccountNumber.trim(),
        account_holder: withdrawAccountHolder.trim(),
        amount,
      });
      setDashboard((prev) => (prev ? { ...prev, wallet: res.wallet } : prev));
      setNotice(res.message);
      setWithdrawAmount("50");
      await refreshHistory();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Withdraw failed");
    } finally {
      setWorking(false);
    }
  };

  const onSaveDepositAccounts = async (methodCodeToSave: "telebirr" | "cbebirr") => {
    const draft = adminDraftAccounts[methodCodeToSave] ?? [];
    const cleaned = draft
      .map((row) => ({ phone_number: row.phone_number.trim(), owner_name: row.owner_name.trim() }))
      .filter((row) => row.phone_number.length > 0 && row.owner_name.length > 0);
    if (!cleaned.length) {
      setError("Add at least one transfer account before saving.");
      return;
    }

    setWorking(true);
    setError("");
    try {
      const res = await updateAdminDepositMethod(methodCodeToSave, {
        transfer_accounts: cleaned,
      });
      setDashboard((prev) => (prev ? { ...prev, deposit_methods: res.deposit_methods } : prev));
      setNotice(res.message);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Unable to save deposit accounts");
    } finally {
      setWorking(false);
    }
  };

  const onCloseBrandModal = () => {
    window.localStorage.setItem(BRAND_MODAL_STORAGE_KEY, String(Date.now()));
    window.localStorage.removeItem(LEGACY_BRAND_MODAL_STORAGE_KEY);
    setShowBrandModal(false);
  };

  const onCopyPhone = async (phone: string) => {
    try {
      await navigator.clipboard.writeText(phone);
      setCopiedPhone(phone);
      setNotice(`Copied ${phone}`);
      window.setTimeout(() => {
        setCopiedPhone((prev) => (prev === phone ? "" : prev));
      }, 1500);
    } catch {
      setError("Clipboard copy failed.");
    }
  };

  const toggleMarked = async (value: number | string, cardNoParam?: number) => {
    if (typeof value !== "number") return;
    if (!room?.id) return;
    const targetCardNo = cardNoParam ?? selectedCardNo;
    if (!targetCardNo) return;
    if (room.phase !== "playing") return;
    if (!calledSet.has(value)) return;
    if (markingNumber === value) return;

    const currentMarks = targetCardNo === selectedCardNo ? markedNumbers : marksForCard(room, targetCardNo);
    const nextMarked = !currentMarks.includes(value);
    setMarkingNumber(value);
    setError("");

    try {
      const res = await markNumberForCard(room.id, value, nextMarked, targetCardNo);
      setRoom(res.room);
      setMarkedNumbers(marksForCard(res.room, targetCardNo));
      setSelectedCardNo(targetCardNo);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Unable to update mark");
    } finally {
      setMarkingNumber(null);
    }
  };

  const onClaimBingo = async () => {
    if (!room?.id) return;
    if (!bingoClaimable) {
      if (markingNumber !== null) {
        setAutoClaimRequested(true);
        setNotice("Finishing your last mark... Bingo will claim automatically.");
        return;
      }
      setNotice("Mark called numbers first.");
      return;
    }

    setAutoClaimRequested(false);
    setClaimingBingo(true);
    setError("");
    try {
      const res = await claimBingo(room.id, selectedCardNo ?? undefined);
      setRoom(res.room);
      setMarkedNumbers(marksForCard(res.room, selectedCardNo));
      const paidWallet = res.wallet;
      if (paidWallet) {
        setDashboard((prev) => (prev ? { ...prev, wallet: paidWallet } : prev));
      }
      setNotice(res.message);
      void refreshHistory();
      void refreshBetHistory();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Unable to claim bingo");
    } finally {
      setClaimingBingo(false);
    }
  };

  if (!ready) {
    return (
      <div className="fortybingo-loading">
        <div className="loader-ring" />
        <p>Loading 40bingo...</p>
      </div>
    );
  }

  if (!profile) {
    return (
      <AuthScreen
        mode={authMode}
        setMode={(mode) => {
          setAuthMode(mode);
          setAuthError("");
          setAuthNotice("");
        }}
        name={authName}
        setName={setAuthName}
        phone={authPhone}
        setPhone={setAuthPhone}
        password={authPassword}
        setPassword={setAuthPassword}
        busy={authBusy}
        notice={authNotice}
        error={authError}
        rememberPassword={rememberPassword}
        setRememberPassword={setRememberPassword}
        onSubmit={onAuthSubmit}
        onTelegramLogin={onTelegramLogin}
        telegramAvailable={Boolean((window as Window & { Telegram?: { WebApp?: { initData?: string } } }).Telegram?.WebApp?.initData)}
      />
    );
  }

  const getStakeCountdownSeconds = (stake: StakeOption) => {
    if (stake.countdown_seconds == null) return 0;
    const fallback = Math.max(0, stake.countdown_seconds);
    const deadline = stakeCountdownDeadlines[stake.id];
    if (!deadline) return fallback;
    return Math.max(0, Math.ceil((deadline - stakeCountdownNow) / 1000));
  };

  const bingoClaimable = room?.phase === "playing" && !!card ? hasBingo(card, room?.called_numbers ?? [], markedNumbers) : false;
  const gameCountdownValue =
    room?.phase === "selecting"
      ? room.countdown_seconds
      : room?.phase === "playing"
        ? room.call_countdown_seconds
        : room?.announcement_seconds ?? 0;
  const gameCountdownLabel = `0:${String(Math.max(0, gameCountdownValue)).padStart(2, "0")}`;
  const gameStatusLabel =
    room?.phase === "selecting"
      ? "Game Starting"
      : room?.phase === "playing"
        ? room.claim_window_seconds > 0
          ? `Checking winners ${room.claim_window_seconds}s`
          : `Next call in ${Math.max(0, room.call_countdown_seconds)}s`
        : room?.announcement_seconds
          ? `Next game in ${room.announcement_seconds}s`
          : "Round Complete";
  const currentPaidCount = room?.current_paid_count ?? room?.display_paid_count ?? room?.paid_cartellas.length ?? 0;
  const currentTotalSales = room ? room.current_total_sales ?? currentPaidCount * room.card_price : 0;
  const currentHouseCommission = room ? room.current_house_commission ?? currentTotalSales * 0.15 : 0;
  const realWinnerPool = room ? room.current_distributable ?? Math.max(0, currentTotalSales - currentHouseCommission) : 0;
  const winnerEntries = room?.winners ?? [];
  const myWinnerEntry = winnerEntries.find((entry) => entry.phone_number === profile.phone_number) ?? null;
  const resultAmount = myWinnerEntry?.payout ?? winnerEntries[0]?.payout ?? 0;
  const showResultOverlay = room?.phase === "finished" && winnerEntries.length > 0;
  const pickerCountdownValue =
    pickerRoom?.phase === "selecting"
      ? pickerRoom.countdown_seconds
      : pickerRoom?.phase === "playing"
        ? pickerRoom.call_countdown_seconds
        : pickerRoom?.announcement_seconds ?? 0;
  const pickerPaidCount = pickerRoom?.display_paid_count ?? pickerRoom?.paid_cartellas.length ?? 0;
  const pickerPhase = pickerRoom?.phase ?? "selecting";
  const pickerLiveDetail =
    pickerRoom?.active_queue === "next"
      ? "Holding open for next game"
      : pickerRoom?.phase === "selecting"
        ? `Game starts in ${Math.max(0, pickerRoom?.countdown_seconds ?? 0)}s`
        : pickerRoom?.phase === "playing"
          ? "Live calls in progress"
          : `Next game opens in ${Math.max(0, pickerRoom?.announcement_seconds ?? 0)}s`;
  const cardBuyAmount = selectedStake?.stake ?? pickerRoom?.card_price ?? 0;
  const insufficientCardBalance = cardBuyAmount > 0 && wallet.main_balance < cardBuyAmount;
  const latestBallLetter = typeof room?.latest_number === "number" ? toBingoLetter(room.latest_number) : null;
  const latestBallClass = latestBallLetter ? `call-${latestBallLetter.toLowerCase()}` : "call-idle";
  const renderBoughtCard = (ownedCard: BingoCard, rail: "desktop" | "panel" = "desktop") => {
    const isActive = selectedCardNo === ownedCard.card_no;
    const marksForOwnedCard = marksForCard(room, ownedCard.card_no);
    return (
      <article
        key={`${rail}-owned-card-${ownedCard.card_no}`}
        className={`bingo-card player-card bought-card ${rail === "panel" ? "compact" : ""} ${isActive ? "active" : ""}`}
      >
        <h3>Your Card No. {ownedCard.card_no}</h3>
        <div className="letters">
          <span>B</span>
          <span>I</span>
          <span>N</span>
          <span>G</span>
          <span>O</span>
        </div>
        <div className="grid">
          {ownedCard.grid.flat().map((value, idx) => {
            const clickable = typeof value === "number" && calledSet.has(value);
            const marked = typeof value === "number" && marksForOwnedCard.includes(value);
            return (
              <button
                key={`${rail}-${ownedCard.card_no}-${value}-${idx}`}
                type="button"
                className={`cell ${value === "FREE" ? "free" : ""} ${clickable ? "clickable" : ""} ${marked ? "marked" : ""} ${markingNumber === value && isActive ? "marking" : ""}`}
                onClick={() => {
                  setSelectedCardNo(ownedCard.card_no);
                  void toggleMarked(value, ownedCard.card_no);
                }}
                disabled={typeof value !== "number" || !clickable || (markingNumber === value && isActive) || room?.phase !== "playing"}
              >
                {value}
              </button>
            );
          })}
        </div>
      </article>
    );
  };
  const isCasinoLaunchView = service === "casino-launch" && Boolean(casinoLaunch);

  const profileInitials = (profile.user_name.trim().slice(0, 2) || "40").toUpperCase();
  const selectedMethodDraftAccounts = selectedMethod ? adminDraftAccounts[selectedMethod.code] ?? [] : [];

  return (
    <div className={`fortybingo-app ${isCasinoLaunchView ? "casino-launch-active" : ""}`}>
      {!isCasinoLaunchView && (
        <>
          <div className={`drawer-overlay ${drawerOpen ? "show" : ""}`} onClick={() => setDrawerOpen(false)} />
          <aside className={`side-drawer ${drawerOpen ? "open" : ""}`}>
            <div className="drawer-profile">
              <div className="avatar">{profileInitials}</div>
              <div className="drawer-profile-meta">
                <h3>{profile.user_name}</h3>
                <p>{profile.phone_number}</p>
              </div>
              <button className="drawer-close" type="button" onClick={() => setDrawerOpen(false)} aria-label="Close menu">
                x
              </button>
            </div>
            <nav>
              {services.map((item) => (
                <button
                  key={item.view}
                  className={`menu-item ${service === item.view ? "active" : ""}`}
                  type="button"
                  onClick={() => openService(item.view)}
                >
                  {item.label}
                </button>
              ))}
              <button className="menu-item danger" type="button" onClick={() => void onLogout()}>
                Logout
              </button>
            </nav>
          </aside>

          <header className="top-header">
            <div className="top-strip">
              <div className="brand-inline">
                <img src="/brand/40bingo-logo.svg" alt="40bingo logo" className="brand-inline-logo" />
                <span>40bingo</span>
              </div>
              <button className="menu-toggle" type="button" onClick={() => setDrawerOpen((state) => !state)}>
                Menu
              </button>
              <button
                className={`theme-toggle ${isDarkMode ? "on" : "off"}`}
                type="button"
                aria-label={isDarkMode ? "Switch to light mode" : "Switch to dark mode"}
                onClick={() => setIsDarkMode((current) => !current)}
              >
                <span className="theme-toggle-track" aria-hidden="true">
                  <span className="theme-toggle-thumb" />
                </span>
                <span className="theme-toggle-label">{isDarkMode ? "On" : "Off"}</span>
              </button>
              <button className="refresh-btn" type="button" onClick={() => void loadData()}>
                Refresh
              </button>
              <div className="wallet-pill">{fmtEtb(wallet.main_balance)}</div>
            </div>
          </header>
        </>
      )}

      <main className={`main-content ${isCasinoLaunchView ? "casino-launch-main" : ""}`}>
        {!isCasinoLaunchView && loading && <div className="notice">Refreshing data...</div>}
        {!isCasinoLaunchView && error && <div className="notice error">{error}</div>}
        {!isCasinoLaunchView && notice && <div className="notice success">{notice}</div>}

        {service === "home" && (
          <section className="home-landing fade-up">
            <div className="home-feature-grid">
              <article className="home-feature-card">
                <div className="home-feature-top">
                  <span className="home-feature-icon">01</span>
                  <h3>Bingo Rooms</h3>
                </div>
                <p>Pick your stake, secure a cartella, and move directly into the next active round.</p>
                <button className="primary-btn" type="button" onClick={() => openService("stakes")}>
                  Open Rooms
                </button>
              </article>

              <article className="home-feature-card">
                <div className="home-feature-top">
                  <span className="home-feature-icon">02</span>
                  <h3>Wallet Center</h3>
                </div>
                <p>Manage deposit, withdraw, transfer, and transaction history from one controlled panel.</p>
                <button className="primary-btn" type="button" onClick={() => openService("wallet")}>
                  Open Wallet
                </button>
              </article>

              <article className="home-feature-card">
                <div className="home-feature-top">
                  <span className="home-feature-icon">03</span>
                  <h3>Live Game</h3>
                </div>
                <p>Follow called numbers in real time and mark your purchased cards during active play.</p>
                <button className="primary-btn" type="button" onClick={() => openService("game")}>
                  Open Live Game
                </button>
              </article>

              <article className="home-feature-card">
                <div className="home-feature-top">
                  <span className="home-feature-icon">04</span>
                  <h3>How To Play</h3>
                </div>
                <p>Review rules, payout flow, and support guidance before joining your next game.</p>
                <button className="primary-btn" type="button" onClick={() => openService("how")}>
                  Open Guide
                </button>
              </article>
            </div>
          </section>
        )}

        {service === "stakes" && (
          <section className="panel stake-panel">
            <h2>Please Choose Your Stake</h2>
            <div className="stake-head-row">
              <span>Stake</span>
              <span>Active</span>
              <span>Possible Win</span>
              <span>Join</span>
            </div>
            <div className="stake-list">
              {(dashboard?.stake_options ?? []).map((stake) => {
                const isPlaying = stake.room_phase === "playing" || stake.status === "playing";
                const liveCountdown = getStakeCountdownSeconds(stake);
                const active =
                  stake.room_phase === "selecting" || (stake.status === "countdown" && stake.room_phase !== "finished")
                    ? fmtClock(liveCountdown)
                    : isPlaying
                      ? "Playing"
                      : stake.room_phase === "finished"
                        ? fmtClock(liveCountdown)
                        : "None";
                const canOpen = Boolean(stake.open_available && (stake.my_cards_current ?? 0) > 0);
                return (
                  <div key={stake.id} className={`stake-row ${stake.bonus ? "bonus" : ""}`}>
                    <span className="stake-col">
                      {stake.bonus && <span className="bonus-tag">Bonus</span>}
                      {stake.stake} birr
                    </span>
                    <span className={`stake-col status ${stake.status}`}>{active}</span>
                    <span className="stake-col win">{stake.possible_win != null ? `${stake.possible_win} Birr` : "-"}</span>
                    <button
                      className="join-btn"
                      type="button"
                      disabled={stake.status === "none" || working}
                      onClick={() => void (canOpen ? onOpenLiveStake(stake) : onOpenStake(stake))}
                    >
                      {canOpen ? "Open" : "Join"}
                    </button>
                  </div>
                );
              })}
            </div>
          </section>
        )}

        {service === "game" && (
          <section className="panel game-panel">
            {!room || !card ? (
              <div className="empty-state">
                <h3>No active room</h3>
                <p>Buy cartella first from Bingo Game service.</p>
              </div>
            ) : (
              <>
                {!showResultOverlay && (
                  <div className="game-live-shell">
                    {room.phase === "selecting" && (
                      <div className="game-top-row compact buying-only">
                        <div className={`countdown phase-${room.phase}`}>{gameCountdownLabel}</div>
                        <div className="stake-chip">{room.card_price} Birr Per Card</div>
                      </div>
                    )}
                    <div className="game-stat-grid">
                      <div className="stat-box">
                        <small>Win</small>
                        <strong>{realWinnerPool.toFixed(2)}</strong>
                      </div>
                      <div className="stat-box">
                        <small>Stake</small>
                        <strong>{room.card_price}</strong>
                      </div>
                      <div className="stat-box">
                        <small>Call</small>
                        <strong>{room.called_numbers.length}</strong>
                      </div>
                      <div className="stat-box">
                        <small>Bought</small>
                        <strong>{currentPaidCount}</strong>
                      </div>
                      <button type="button" className="stat-box stat-sound" aria-label="sound">
                        (( ))
                      </button>
                    </div>
                    <div className="caller-layout">
                      <aside className="caller-side-card">
                        <div className={`caller-ball-shell ${latestBallClass}`}>
                          <div className={`caller-ball ${latestBallClass}`}>
                            <small>{latestBallLetter ?? "-"}</small>
                            <strong>{room.latest_number ?? "--"}</strong>
                          </div>
                        </div>
                        <div className="caller-recent-row">
                          {(room.called_numbers.slice(-4).reverse() ?? []).map((num) => (
                            <div
                              key={`recent-${num}`}
                              className={`recent-pill call-${toBingoLetter(num).toLowerCase()} ${room.latest_number === num ? "latest" : ""}`}
                            >
                              {num}
                            </div>
                          ))}
                          {room.called_numbers.length === 0 && <div className="recent-pill">-</div>}
                        </div>
                        <div className="in-panel-card-rail">
                          {cards.map((ownedCard) => renderBoughtCard(ownedCard, "panel"))}
                        </div>
                      </aside>

                      <section className="caller-board-panel">
                        <div className="caller-board-grid">
                          <div className="caller-head-row">
                            {callerLetters.map((letter) => (
                              <div key={`head-${letter}`} className={`caller-letter caller-${letter.toLowerCase()}`}>
                                {letter}
                              </div>
                            ))}
                          </div>
                          {callerRows.map((row, rowIdx) => (
                            <div key={`row-${rowIdx + 1}`} className="caller-row">
                              {row.map((num, colIdx) => (
                                <div
                                  key={`caller-${callerLetters[colIdx]}-${num}`}
                                  className={`caller-number ${calledSet.has(num) ? "hit" : ""} ${room.latest_number === num ? "latest" : ""}`}
                                >
                                  {num}
                                </div>
                              ))}
                            </div>
                          ))}
                        </div>
                      </section>
                    </div>

                    <div className="game-actions compact">
                      <button className="primary-btn" type="button" onClick={() => void onClaimBingo()} disabled={!bingoClaimable || claimingBingo || room.phase !== "playing"}>
                        {claimingBingo ? "Confirming..." : "Bingo"}
                      </button>
                    </div>
                  </div>
                )}
                {showResultOverlay && (
                  <div className={`result-overlay ${myWinnerEntry ? "won" : "lost"}`}>
                    <div className={`result-modal ${myWinnerEntry ? "won" : "lost"}`}>
                      <h2>{myWinnerEntry ? "You Won" : "You Lost"}</h2>
                      <h3>Amount : {Math.round(resultAmount)} ETB</h3>
                      <p className="result-subtitle">Payout is split equally between all confirmed winners.</p>
                      <div className={`result-winners ${winnerEntries.length > 1 ? "stacked" : ""}`}>
                        {winnerEntries.map((winner) => (
                          <div
                            key={`winner-${winner.phone_number}-${winner.cartella_no}`}
                            className={`result-winner-card ${myWinnerEntry ? "winner-side" : "loser-side"}`}
                          >
                            {(() => {
                              const winnerLineIndexes = getBingoLineCellIndexes(winner.card, room?.called_numbers ?? []);
                              return (
                                <>
                            <p>
                              {winner.user_name} {maskPhone(winner.phone_number)} | Card No. {winner.cartella_no} | ETB {winner.payout.toFixed(2)}
                            </p>
                            <article className="bingo-card mini">
                              <h4>Card No. {winner.card.card_no}</h4>
                              <div className="letters">
                                <span>B</span>
                                <span>I</span>
                                <span>N</span>
                                <span>G</span>
                                <span>O</span>
                              </div>
                              <div className="grid">
                                {winner.card.grid.flat().map((value, idx) => {
                                  const hit = typeof value === "number" && calledSet.has(value);
                                  const bingoLine = winnerLineIndexes.has(idx);
                                  return (
                                    <div key={`winner-cell-${winner.cartella_no}-${idx}`} className={`cell ${value === "FREE" ? "free" : ""} ${hit ? "marked" : ""} ${bingoLine ? "bingo-line" : ""}`}>
                                      {value}
                                    </div>
                                  );
                                })}
                              </div>
                            </article>
                                </>
                              );
                            })()}
                          </div>
                        ))}
                      </div>
                      <button className="primary-btn" type="button" onClick={() => openService("stakes")}>
                        Play again
                      </button>
                    </div>
                  </div>
                )}
              </>
            )}
          </section>
        )}

        {CASINO_ENABLED && service === "casino" && (
          <section className="panel casino-panel">
            <div className="casino-top-strip">
              {casinoTopCategories.map((item) => (
                <div key={item.id} className="casino-top-item">
                  <div className="casino-top-icon">{item.icon}</div>
                  <strong>{item.title}</strong>
                  <span>{item.subtitle}</span>
                </div>
              ))}
            </div>

            <div className="casino-circle-rail">
              {casinoCircleGames.map((game) => (
                <article key={game.id} className="casino-circle-item">
                  <div className="casino-circle-image-shell">
                    <img
                      className="casino-circle-image"
                      src={game.image_url}
                      alt={`${game.title} icon`}
                      loading="lazy"
                      onError={(event) => {
                        event.currentTarget.src = fallbackCasinoImage;
                      }}
                    />
                  </div>
                  <p>{game.title}</p>
                </article>
              ))}
            </div>

            <div className="casino-content-block">
              <div className="casino-section-heading">
                <div className="casino-section-label">FEATURED</div>
                <p className="casino-section-subtitle">Real catalog images from source repo</p>
              </div>
              {casinoCatalogNotice && <p className="casino-catalog-note">{casinoCatalogNotice}</p>}
              <div className="casino-card-grid">
                {casinoFeaturedGames.map((game) => (
                  <article
                    key={game.id}
                    className={`casino-feature-card ${casinoTapMode && activeCasinoCardId === game.id ? "mobile-open" : ""}`}
                    onClick={() => handleCasinoCardTap(game.id)}
                  >
                    {game.exclusive && <span className="casino-exclusive-badge">Exclusive</span>}
                    <button
                      className="casino-star-btn"
                      type="button"
                      aria-label={`Favorite ${game.title}`}
                      onClick={(event) => event.stopPropagation()}
                    >
                      {"\u2606"}
                    </button>
                    <img
                      className="casino-thumb"
                      src={game.image_url}
                      alt={`${game.title} preview`}
                      loading="lazy"
                      onError={(event) => {
                        event.currentTarget.src = fallbackCasinoImage;
                      }}
                    />
                    <div className="casino-card-overlay">
                      <button
                        className="casino-play-btn"
                        type="button"
                        disabled={casinoLaunchBusyId === game.id}
                        onClick={(event) => {
                          event.stopPropagation();
                          void handleCasinoPlay(game);
                        }}
                      >
                        {casinoLaunchBusyId === game.id ? "Opening..." : "Open"}
                      </button>
                    </div>
                    <div className="casino-card-title">{game.title}</div>
                    <div className="casino-card-meta">
                      Min ETB {game.min_bet.toFixed(0)} - x{game.max_multiplier.toFixed(0)}
                    </div>
                  </article>
                ))}
              </div>

              <div className="casino-section-heading">
                <div className="casino-section-label latest">LATEST RELEASES</div>
                <p className="casino-section-subtitle">Tap game card and open to play with wallet balance</p>
              </div>
              <div className="casino-card-grid latest">
                {casinoLatestGames.map((game) => (
                  <article
                    key={game.id}
                    className={`casino-feature-card latest ${casinoTapMode && activeCasinoCardId === game.id ? "mobile-open" : ""}`}
                    onClick={() => handleCasinoCardTap(game.id)}
                  >
                    <button
                      className="casino-star-btn"
                      type="button"
                      aria-label={`Favorite ${game.title}`}
                      onClick={(event) => event.stopPropagation()}
                    >
                      {"\u2606"}
                    </button>
                    <img
                      className="casino-thumb"
                      src={game.image_url}
                      alt={`${game.title} preview`}
                      loading="lazy"
                      onError={(event) => {
                        event.currentTarget.src = fallbackCasinoImage;
                      }}
                    />
                    <div className="casino-card-overlay">
                      <button
                        className="casino-play-btn"
                        type="button"
                        disabled={casinoLaunchBusyId === game.id}
                        onClick={(event) => {
                          event.stopPropagation();
                          void handleCasinoPlay(game);
                        }}
                      >
                        {casinoLaunchBusyId === game.id ? "Opening..." : "Open"}
                      </button>
                    </div>
                    <div className="casino-card-title">{game.title}</div>
                    <div className="casino-card-meta">
                      Min ETB {game.min_bet.toFixed(0)} - x{game.max_multiplier.toFixed(0)}
                    </div>
                  </article>
                ))}
              </div>
            </div>
          </section>
        )}

        {CASINO_ENABLED && service === "casino-launch" && (
          <section className="casino-launch-view">
            <div className="casino-launch-head">
              <button className="secondary-btn" type="button" onClick={closeCasinoLaunch}>
                Back
              </button>
              <div className="casino-launch-title">
                <strong>{casinoLaunch?.game_title ?? "Casino Game"}</strong>
                <span>{casinoLaunch?.provider ?? "Provider"}</span>
              </div>
              <button
                className="secondary-btn"
                type="button"
                onClick={() => {
                  if (casinoLaunch?.launch_url) {
                    window.open(casinoLaunch.launch_url, "_blank", "noopener,noreferrer");
                  }
                }}
                disabled={!casinoLaunch?.launch_url}
              >
                Open External
              </button>
            </div>
            {casinoLaunch?.launch_url ? (
              <iframe
                className="casino-launch-frame"
                src={casinoLaunch.launch_url}
                title={casinoLaunch.game_title}
                allow="autoplay; fullscreen; payment"
                allowFullScreen
              />
            ) : (
              <div className="casino-launch-empty">Launch session unavailable.</div>
            )}
          </section>
        )}

        {service === "wallet" && (
          <section className="panel wallet-panel">
            <h2>Wallet</h2>
            <p className="panel-subtitle">Withdraw requests notify admin by email for manual bank payout.</p>
            <div className="balance-row">
              <div className="balance-card">
                <h3>Main Balance</h3>
                <strong>{fmtEtb(wallet.main_balance)}</strong>
              </div>
              <div className="balance-card">
                <h3>Bonus Balance</h3>
                <strong>{fmtEtb(wallet.bonus_balance)}</strong>
              </div>
            </div>
            <div className="wallet-tabs">
              <button className={`wallet-tab ${walletTab === "deposit" ? "active" : ""}`} type="button" onClick={() => setWalletTab("deposit")}>
                Deposit
              </button>
              <button className={`wallet-tab ${walletTab === "withdraw" ? "active" : ""}`} type="button" onClick={() => setWalletTab("withdraw")}>
                Withdraw
              </button>
              <button className={`wallet-tab ${walletTab === "transfer" ? "active" : ""}`} type="button" onClick={() => setWalletTab("transfer")}>
                Transfer
              </button>
              <button className={`wallet-tab ${walletTab === "history" ? "active" : ""}`} type="button" onClick={() => setWalletTab("history")}>
                History
              </button>
              {profile.is_admin && (
                <button className={`wallet-tab ${walletTab === "admin" ? "active" : ""}`} type="button" onClick={() => setWalletTab("admin")}>
                  Admin
                </button>
              )}
            </div>

            {walletTab === "deposit" && (
              <div className="wallet-subpanel">
                <div className="method-grid">
                  {(dashboard?.deposit_methods ?? []).map((method) => (
                    <MethodCard
                      key={method.code}
                      method={method}
                      active={methodCode === method.code}
                      onClick={() => setMethodCode(method.code)}
                    />
                  ))}
                </div>
                <button className="primary-btn" type="button" onClick={() => setDepositGuideOpen(true)}>
                  Open Deposit Guide
                </button>
              </div>
            )}

            {walletTab === "withdraw" && (
              <form className="wallet-form wallet-subpanel" onSubmit={onWithdraw}>
                <label>
                  Bank
                  <select value={withdrawBank} onChange={(event) => setWithdrawBank(event.target.value)}>
                    <option value="CBE">CBE</option>
                    <option value="Awash">Awash</option>
                    <option value="Dashen">Dashen</option>
                    <option value="BOA">Bank of Abyssinia</option>
                  </select>
                </label>
                <label>
                  Account Number
                  <input value={withdrawAccountNumber} onChange={(event) => setWithdrawAccountNumber(event.target.value)} placeholder="Enter account number" />
                </label>
                <label>
                  Account Holder
                  <input value={withdrawAccountHolder} onChange={(event) => setWithdrawAccountHolder(event.target.value)} placeholder="Enter account holder name" />
                </label>
                <label>
                  Amount
                  <input type="number" min={3} value={withdrawAmount} onChange={(event) => setWithdrawAmount(event.target.value)} />
                </label>
                <button className="primary-btn" type="submit" disabled={working}>
                  {working ? "Submitting..." : "Manual Withdraw"}
                </button>
              </form>
            )}

            {walletTab === "transfer" && (
              <form className="wallet-form wallet-subpanel" onSubmit={onTransfer}>
                <label>
                  Phone Number
                  <input value={transferPhone} onChange={(event) => setTransferPhone(event.target.value)} placeholder="09xxxxxxxx" />
                </label>
                <label>
                  Amount
                  <input type="number" min={1} value={transferAmount} onChange={(event) => setTransferAmount(event.target.value)} />
                </label>
                <label>
                  OTP
                  <input value={transferOtp} onChange={(event) => setTransferOtp(event.target.value)} placeholder="Enter OTP" />
                </label>
                <button className="primary-btn" type="submit" disabled={working}>
                  {working ? "Transferring..." : "Transfer Balance"}
                </button>
              </form>
            )}

            {walletTab === "history" && (
              <div className="wallet-subpanel history-scroll">
                <table>
                  <thead>
                    <tr>
                      <th>Type</th>
                      <th>Date</th>
                      <th>Amount</th>
                      <th>Status</th>
                    </tr>
                  </thead>
                  <tbody>
                    {history.map((row) => (
                      <tr key={`wallet-row-${row.type}-${row.created_at}-${row.amount}`}>
                        <td>{row.type}</td>
                        <td>{fmtDate(row.created_at)}</td>
                        <td>{row.amount}</td>
                        <td>{row.status}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}

            {walletTab === "admin" && profile.is_admin && (
              <div className="wallet-subpanel admin-settings">
                {(["telebirr", "cbebirr"] as const).map((code) => {
                  const rows = adminDraftAccounts[code] ?? [];
                  const label = code === "telebirr" ? "Telebirr" : "CBE Birr";
                  return (
                    <article key={`admin-${code}`} className="admin-method-box">
                      <h3>{label} Transfer Accounts</h3>
                      <div className="admin-account-grid">
                        {rows.map((row, idx) => (
                          <div key={`admin-${code}-${idx}`} className="admin-account-row">
                            <input
                              value={row.phone_number}
                              onChange={(event) =>
                                setAdminDraftAccounts((prev) => ({
                                  ...prev,
                                  [code]: prev[code].map((candidate, candidateIdx) =>
                                    candidateIdx === idx ? { ...candidate, phone_number: event.target.value } : candidate,
                                  ),
                                }))
                              }
                              placeholder="Phone number"
                            />
                            <input
                              value={row.owner_name}
                              onChange={(event) =>
                                setAdminDraftAccounts((prev) => ({
                                  ...prev,
                                  [code]: prev[code].map((candidate, candidateIdx) =>
                                    candidateIdx === idx ? { ...candidate, owner_name: event.target.value } : candidate,
                                  ),
                                }))
                              }
                              placeholder="Owner"
                            />
                            <button
                              className="secondary-btn"
                              type="button"
                              onClick={() =>
                                setAdminDraftAccounts((prev) => ({
                                  ...prev,
                                  [code]: prev[code].filter((_, rowIdx) => rowIdx !== idx),
                                }))
                              }
                            >
                              Remove
                            </button>
                          </div>
                        ))}
                      </div>
                      <div className="admin-actions">
                        <button
                          className="secondary-btn"
                          type="button"
                          onClick={() =>
                            setAdminDraftAccounts((prev) => ({
                              ...prev,
                              [code]: [...prev[code], { phone_number: "", owner_name: "" }],
                            }))
                          }
                        >
                          Add Account
                        </button>
                        <button className="primary-btn" type="button" disabled={working} onClick={() => void onSaveDepositAccounts(code)}>
                          {working ? "Saving..." : `Save ${label}`}
                        </button>
                      </div>
                    </article>
                  );
                })}
                <article className="admin-method-box">
                  <h3>Withdraw Requests</h3>
                  <div className="history-scroll">
                    <table>
                      <thead>
                        <tr>
                          <th>User</th>
                          <th>Amount</th>
                          <th>Bank Account</th>
                          <th>Status</th>
                          <th>Action</th>
                        </tr>
                      </thead>
                      <tbody>
                        {adminWithdrawRequests.map((item) => {
                          const normalizedStatus = item.status === "Approved" ? "Paid" : item.status;
                          const payoutRef = adminPayoutRefs[item.id] ?? "";

                          return (
                            <tr key={item.id}>
                              <td>
                                {item.user_name}
                                <br />
                                <small>{item.phone_number}</small>
                              </td>
                              <td>ETB {item.amount.toFixed(2)}</td>
                              <td>
                                <strong>{item.bank}</strong>
                                <br />
                                <small>{item.account_holder}</small>
                                <br />
                                <small>{item.account_number}</small>
                              </td>
                              <td>{normalizedStatus}</td>
                              <td>
                                {normalizedStatus === "Pending" ? (
                                  <div className="admin-actions">
                                    <button
                                      className="primary-btn"
                                      type="button"
                                      disabled={working}
                                      onClick={async () => {
                                        setWorking(true);
                                        setError("");
                                        try {
                                          const res = await approveAdminWithdrawRequest(item.id);
                                          setNotice(res.message);
                                          await refreshAdminWithdrawRequests();
                                        } catch (err) {
                                          setError(err instanceof Error ? err.message : "Unable to start withdraw processing");
                                        } finally {
                                          setWorking(false);
                                        }
                                      }}
                                    >
                                      Start Processing
                                    </button>
                                    <button
                                      className="secondary-btn"
                                      type="button"
                                      disabled={working}
                                      onClick={async () => {
                                        setWorking(true);
                                        setError("");
                                        try {
                                          const res = await rejectAdminWithdrawRequest(item.id);
                                          setNotice(res.message);
                                          await refreshAdminWithdrawRequests();
                                        } catch (err) {
                                          setError(err instanceof Error ? err.message : "Unable to reject withdraw request");
                                        } finally {
                                          setWorking(false);
                                        }
                                      }}
                                    >
                                      Reject
                                    </button>
                                  </div>
                                ) : normalizedStatus === "Processing" ? (
                                  <div className="admin-actions">
                                    <input
                                      value={payoutRef}
                                      placeholder="Bank transfer ref"
                                      onChange={(event) =>
                                        setAdminPayoutRefs((prev) => ({
                                          ...prev,
                                          [item.id]: event.target.value,
                                        }))
                                      }
                                    />
                                    <button
                                      className="primary-btn"
                                      type="button"
                                      disabled={working}
                                      onClick={async () => {
                                        setWorking(true);
                                        setError("");
                                        try {
                                          if (!payoutRef.trim()) {
                                            throw new Error("Enter bank transfer reference before marking paid.");
                                          }
                                          const res = await markPaidAdminWithdrawRequest(item.id, {
                                            payout_reference: payoutRef.trim(),
                                          });
                                          setNotice(res.message);
                                          setAdminPayoutRefs((prev) => ({
                                            ...prev,
                                            [item.id]: "",
                                          }));
                                          await refreshAdminWithdrawRequests();
                                        } catch (err) {
                                          setError(err instanceof Error ? err.message : "Unable to mark withdraw as paid");
                                        } finally {
                                          setWorking(false);
                                        }
                                      }}
                                    >
                                      Mark Paid
                                    </button>
                                    <button
                                      className="secondary-btn"
                                      type="button"
                                      disabled={working}
                                      onClick={async () => {
                                        setWorking(true);
                                        setError("");
                                        try {
                                          const res = await rejectAdminWithdrawRequest(item.id);
                                          setNotice(res.message);
                                          await refreshAdminWithdrawRequests();
                                        } catch (err) {
                                          setError(err instanceof Error ? err.message : "Unable to reject withdraw request");
                                        } finally {
                                          setWorking(false);
                                        }
                                      }}
                                    >
                                      Reject
                                    </button>
                                  </div>
                                ) : (
                                  <span>{normalizedStatus === "Paid" ? "Paid" : "Reviewed"}</span>
                                )}
                              </td>
                            </tr>
                          );
                        })}
                      </tbody>
                    </table>
                  </div>
                </article>
              </div>
            )}
          </section>
        )}

        {service === "history" && (
          <section className="panel history-panel">
            <h2>Bet History</h2>
            <table>
              <thead>
                <tr>
                  <th>No</th>
                  <th>Stake</th>
                  <th>Game Winning</th>
                  <th>Winner Cards</th>
                  <th>Your Cards</th>
                  <th>Date</th>
                  <th>Result</th>
                </tr>
              </thead>
              <tbody>
                {betHistory.map((row, idx) => (
                  <tr key={row.id} className="bet-history-row" onClick={() => setSelectedBet(row)}>
                    <td>{idx + 1}</td>
                    <td>{row.stake} Birr</td>
                    <td>{Math.round(row.game_winning)} Birr</td>
                    <td>
                      <div className="card-chip-group">
                        {row.winner_cards.map((cardNo) => (
                          <span key={`winner-card-${row.id}-${cardNo}`} className="card-chip winner">
                            {cardNo}
                          </span>
                        ))}
                      </div>
                    </td>
                    <td>
                      <div className="card-chip-group">
                        {row.your_cards.map((cardNo) => (
                          <span key={`your-card-${row.id}-${cardNo}`} className="card-chip mine">
                            {cardNo}
                          </span>
                        ))}
                      </div>
                    </td>
                    <td>{fmtShortDate(row.date)}</td>
                    <td className={row.result === "Won" ? "result-won" : "result-lost"}>{row.result}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </section>
        )}

        {service === "how" && (
          <section className="panel faq-panel">
            <h2>How To Play</h2>
            {(dashboard?.faq ?? []).map((item) => (
              <details key={item.id}>
                <summary>{item.question}</summary>
                <p>{item.answer}</p>
              </details>
            ))}
          </section>
        )}

        {service === "contact" && (
          <section className="panel placeholder-panel">
            <h2>Contact</h2>
            <p>Use in-app support and wallet contact channels.</p>
          </section>
        )}
      </main>

      {cartellaOpen && (
        <div className="modal-overlay show" onClick={() => setCartellaOpen(false)}>
          <div className="modal-card cartella-modal" onClick={(event) => event.stopPropagation()}>
            {cartellaStep === "pick" && (
              <>
                <div className="cartella-stage">
                  <aside className="cartella-stage-ads" aria-hidden="true">
                    <div className="cartella-ad">40bingo</div>
                    <div className="cartella-ad alt">Held Cartellas</div>
                  </aside>
                  <section className="cartella-stage-main">
                    <div className="modal-head">
                      <h3>
                        {selectedStake
                          ? `${selectedStake.stake} Birr ${pickerRoom?.active_queue === "next" ? "Next Game Queue" : "Current Game"}`
                          : "Choose Cartella"}
                      </h3>
                      <button type="button" onClick={() => setCartellaOpen(false)}>
                        x
                      </button>
                    </div>
                    {cardRechargeLabel && <div className="modal-recharge-label">{cardRechargeLabel}</div>}
                    <div className="cartella-details-lines">
                      <div className="cartella-details-line primary">
                        <span className={`cartella-pill countdown phase-${pickerPhase}`}>0:{String(Math.max(0, pickerCountdownValue)).padStart(2, "0")}</span>
                        <span className="cartella-pill stake">{selectedStake ? `${selectedStake.stake} Birr Per Card` : "0 Birr Per Card"}</span>
                        <span className={`cartella-pill latest phase-${pickerPhase}`}>{pickerLiveDetail}</span>
                      </div>
                      <div className="cartella-details-line secondary">
                        <span>
                          <strong>{pickerRoom?.held_cartellas.length ?? 0}</strong> Held
                        </span>
                        <span>
                          <strong>{pickerPaidCount}</strong> Paid
                        </span>
                        <span>
                          <strong>200</strong> Total
                        </span>
                        <span>
                          <strong>{pickerRoom?.my_cartellas.length ?? 0}</strong> My Current
                        </span>
                        <span>
                          <strong>{pickerRoom?.next_my_cartellas.length ?? 0}</strong> My Next
                        </span>
                        <span className="legend-inline">W=available R=held B=paid G=sim</span>
                      </div>
                    </div>
                    <div className="cartella-surface">
                      <div className="cartella-grid">
                        {cartellaList.map((num) => {
                          const paid = paidSet.has(num);
                          const mineHeld = pickerRoom?.my_held_cartella === num;
                          const held = heldSet.has(num);
                          const heldByOther = held && !mineHeld;
                          const simulated = simulatedPaidSet.has(num);
                          const red = processingCartella === num || held;
                          const selected = selectedCartella === num;
                          return (
                            <button
                              key={`c-${num}`}
                              type="button"
                              className={`cartella-cell ${paid ? "paid" : ""} ${simulated ? "simulated" : ""} ${red ? "processing" : ""} ${selected ? "selected" : ""} ${heldByOther ? "held-other" : ""} ${mineHeld ? "held-mine" : ""}`}
                              onClick={() => {
                                if (!paid && !heldByOther) setSelectedCartella(num);
                              }}
                              disabled={paid || heldByOther}
                            >
                              {num}
                            </button>
                          );
                        })}
                      </div>
                    </div>
                    <div className="modal-actions">
                      <button className="secondary-btn" type="button" onClick={() => setCartellaOpen(false)}>
                        Go Back
                      </button>
                      <button
                        className="secondary-btn"
                        type="button"
                        onClick={() => void onPreviewCartella()}
                        disabled={!selectedCartella || working}
                      >
                        {working ? "Loading..." : "Preview Card"}
                      </button>
                      <button
                        className={`primary-btn ${insufficientCardBalance ? "insufficient-buy-btn" : ""}`}
                        type="button"
                        onClick={() => void onConfirmCartella()}
                        disabled={!selectedCartella || working || insufficientCardBalance}
                      >
                        {working
                          ? "Buying..."
                          : insufficientCardBalance
                            ? `Insufficient Balance (Need ETB ${cardBuyAmount})`
                            : pickerRoom?.active_queue === "next"
                              ? "Buy For Next Game"
                              : "Buy Card"}
                      </button>
                    </div>
                  </section>
                </div>
              </>
            )}

            {cartellaStep === "preview" && preview && (
              <>
                <div className="game-top-row compact">
                  <div className={`countdown phase-${pickerRoom?.phase ?? "selecting"}`}>
                    0:{String(Math.max(0, pickerCountdownValue)).padStart(2, "0")}
                  </div>
                  <div className="stake-chip">{selectedStake ? `${selectedStake.stake} Birr Per Card` : "0 Birr Per Card"}</div>
                </div>
                {cardRechargeLabel && <div className="modal-recharge-label">{cardRechargeLabel}</div>}
                <article className="bingo-card">
                  <h3>Card No. {preview.card_no}</h3>
                  <div className="letters">
                    <span>B</span>
                    <span>I</span>
                    <span>N</span>
                    <span>G</span>
                    <span>O</span>
                  </div>
                  <div className="grid">
                    {preview.grid.flat().map((value, idx) => (
                      <div key={`p-${value}-${idx}`} className={`cell ${value === "FREE" ? "free" : ""}`}>
                        {value}
                      </div>
                    ))}
                  </div>
                </article>
                <div className="modal-actions">
                  <button className="secondary-btn" type="button" onClick={() => setCartellaStep("pick")}>
                    Go Back
                  </button>
                  <button
                    className={`primary-btn ${insufficientCardBalance ? "insufficient-buy-btn" : ""}`}
                    type="button"
                    disabled={working || insufficientCardBalance}
                    onClick={() => void onConfirmCartella()}
                  >
                    {working
                      ? "Paying..."
                      : insufficientCardBalance
                        ? `Insufficient Balance (Need ETB ${cardBuyAmount})`
                        : pickerRoom?.active_queue === "next"
                          ? "Buy For Next Game"
                          : "Buy Card"}
                  </button>
                </div>
              </>
            )}
          </div>
        </div>
      )}

      {depositGuideOpen && (
        <div className="modal-overlay show" onClick={() => setDepositGuideOpen(false)}>
          <div className="modal-card deposit-modal" onClick={(event) => event.stopPropagation()}>
            <div className="modal-head">
              <h3>{selectedMethod?.label ?? "Deposit"}</h3>
              <button type="button" onClick={() => setDepositGuideOpen(false)}>
                x
              </button>
            </div>
            {selectedMethod && (
              <>
                {selectedMethod.logo_url ? (
                  <img
                    className="deposit-provider-logo"
                    src={selectedMethod.logo_url}
                    alt={`${selectedMethod.label} logo`}
                    onError={(event) => {
                      const target = event.currentTarget;
                      if (target.dataset.fallbackApplied === "1") return;
                      target.dataset.fallbackApplied = "1";
                      target.src = selectedMethod.code === "telebirr" ? "/providers/telebirr.svg" : "/providers/cbebirr.png";
                    }}
                  />
                ) : null}
                <p className="panel-subtitle">Follow steps below and submit receipt info. Receiver account is verified against assigned personnel.</p>
                <ol>
                  {selectedMethod.instruction_steps.map((step) => (
                    <li key={step}>{step}</li>
                  ))}
                </ol>
                <div className="accounts">
                  {profile.is_admin
                    ? selectedMethodDraftAccounts.map((account, idx) => (
                        <div key={`${selectedMethod.code}-draft-${idx}`} className="account-box admin-edit">
                          <input
                            value={account.phone_number}
                            onChange={(event) =>
                              setAdminDraftAccounts((prev) => ({
                                ...prev,
                                [selectedMethod.code]: (prev[selectedMethod.code] ?? []).map((item, rowIdx) =>
                                  rowIdx === idx ? { ...item, phone_number: event.target.value } : item,
                                ),
                              }))
                            }
                            placeholder="09XXXXXXXX"
                          />
                          <input
                            value={account.owner_name}
                            onChange={(event) =>
                              setAdminDraftAccounts((prev) => ({
                                ...prev,
                                [selectedMethod.code]: (prev[selectedMethod.code] ?? []).map((item, rowIdx) =>
                                  rowIdx === idx ? { ...item, owner_name: event.target.value } : item,
                                ),
                              }))
                            }
                            placeholder="Owner name"
                          />
                          <div className="admin-inline-actions">
                            <button
                              className="secondary-btn copy-btn"
                              type="button"
                              disabled={!account.phone_number.trim()}
                              onClick={() => void onCopyPhone(account.phone_number.trim())}
                            >
                              {copiedPhone === account.phone_number.trim() ? "Copied" : "Copy"}
                            </button>
                            <button
                              className="secondary-btn"
                              type="button"
                              onClick={() =>
                                setAdminDraftAccounts((prev) => ({
                                  ...prev,
                                  [selectedMethod.code]: (prev[selectedMethod.code] ?? []).filter((_, rowIdx) => rowIdx !== idx),
                                }))
                              }
                            >
                              Remove
                            </button>
                          </div>
                        </div>
                      ))
                    : selectedMethod.transfer_accounts.map((account) => (
                        <div key={`${selectedMethod.code}-${account.phone_number}`} className="account-box">
                          <span>{account.phone_number}</span>
                          <small>{account.owner_name}</small>
                          <button className="secondary-btn copy-btn" type="button" onClick={() => void onCopyPhone(account.phone_number)}>
                            {copiedPhone === account.phone_number ? "Copied" : "Copy"}
                          </button>
                        </div>
                      ))}
                </div>
                {profile.is_admin && (
                  <div className="deposit-admin-actions">
                    <button
                      className="secondary-btn"
                      type="button"
                      onClick={() =>
                        setAdminDraftAccounts((prev) => ({
                          ...prev,
                          [selectedMethod.code]: [...(prev[selectedMethod.code] ?? []), { phone_number: "", owner_name: "" }],
                        }))
                      }
                    >
                      Add Number
                    </button>
                    <button className="primary-btn" type="button" disabled={working} onClick={() => void onSaveDepositAccounts(selectedMethod.code)}>
                      {working ? "Saving..." : "Save Numbers"}
                    </button>
                  </div>
                )}
                <form className="wallet-form" onSubmit={onDeposit}>
                  <label>
                    Amount
                    <input type="number" min={1} value={depositAmount} onChange={(event) => setDepositAmount(event.target.value)} />
                  </label>
                  <label>
                    Transaction Number
                    <input
                      value={txNo}
                      onChange={(event) => {
                        const rawValue = event.target.value;
                        const extracted = extractTransactionNumber(rawValue);
                        if (/\s/.test(rawValue) && extracted) {
                          setTxNo(extracted);
                          if (!receiptMessage.trim()) {
                            setReceiptMessage(rawValue.trim());
                          }
                          return;
                        }
                        setTxNo(rawValue);
                      }}
                    />
                  </label>
                  <label>
                    Message
                    <input
                      required
                      value={receiptMessage}
                      placeholder="Paste payment SMS/receipt message"
                      onChange={(event) => {
                        const nextMessage = event.target.value;
                        setReceiptMessage(nextMessage);
                        const extracted = extractTransactionNumber(nextMessage);
                        if (!extracted) return;
                        setTxNo((current) => {
                          const currentNormalized = normalizeTransactionNumberInput(current);
                          if (currentNormalized && currentNormalized !== extracted) return current;
                          return extracted;
                        });
                      }}
                    />
                  </label>
                  <small>Receipt message must include one assigned receiver phone number or owner name.</small>
                  <button className="primary-btn" type="submit" disabled={working}>
                    {working ? "Submitting..." : "Submit Deposit"}
                  </button>
                </form>
              </>
            )}
          </div>
        </div>
      )}

      {selectedBet && (
        <div className="modal-overlay show" onClick={() => setSelectedBet(null)}>
          <div className={`modal-card bet-history-modal ${selectedBet.result === "Won" ? "won" : "lost"}`} onClick={(event) => event.stopPropagation()}>
            <div className="modal-head">
              <h3>{selectedBet.result === "Won" ? "You Won" : "This Card Lost"}</h3>
              <button type="button" onClick={() => setSelectedBet(null)}>
                x
              </button>
            </div>
            <p className="bet-result-amount">
              Amount : ETB {selectedBet.result === "Won" ? selectedBet.payout.toFixed(2) : selectedBet.game_winning.toFixed(2)}
            </p>
            {selectedBet.preview_card && (
              <article className="bingo-card compact history-card-preview">
                <h3>Card No. {selectedBet.preview_card.card_no}</h3>
                <div className="letters">
                  <span>B</span>
                  <span>I</span>
                  <span>N</span>
                  <span>G</span>
                  <span>O</span>
                </div>
                <div className="grid">
                  {selectedBet.preview_card.grid.flat().map((value, idx) => {
                    const marked = typeof value === "number" && selectedBet.called_numbers.includes(value);
                    return (
                      <div key={`history-preview-${selectedBet.id}-${idx}`} className={`cell ${value === "FREE" ? "free" : ""} ${marked ? "marked" : ""}`}>
                        {value}
                      </div>
                    );
                  })}
                </div>
              </article>
            )}
          </div>
        </div>
      )}

      {showBrandModal && (
        <div className="modal-overlay show" onClick={onCloseBrandModal}>
          <div className="modal-card brand-modal" onClick={(event) => event.stopPropagation()}>
            <div className="modal-head">
              <h3>40bingo Updates</h3>
              <button type="button" onClick={onCloseBrandModal}>
                x
              </button>
            </div>
            <div className="brand-modal-content">
              <article className="brand-promo">
                <h4>Prize Structure</h4>
                <p>Join any stake room and play live with fair payouts. House commission remains fixed at 15%.</p>
              </article>
              <article className="brand-promo">
                <h4>Safe Deposit</h4>
                <p>Use only verified Telebirr/CBE transfer accounts listed in wallet. Duplicate receipts are blocked automatically.</p>
              </article>
            </div>
            <button className="primary-btn" type="button" onClick={onCloseBrandModal}>
              Continue
            </button>
          </div>
        </div>
      )}
    </div>
  );
}


