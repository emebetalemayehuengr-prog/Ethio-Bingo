import { FormEvent, useEffect, useMemo, useState } from "react";
import {
  approveAdminWithdrawRequest,
  claimBingo,
  clearAuthToken,
  fetchAdminWithdrawRequests,
  fetchBetHistory,
  fetchDashboard,
  fetchHistory,
  fetchStakeRoom,
  getAuthToken,
  joinStake,
  loginWithTelegram,
  markNumberForCard,
  login as loginRequest,
  markPaidAdminWithdrawRequest,
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
type ServiceView = "home" | "stakes" | "game" | "casino" | "wallet" | "history" | "how" | "contact";
type CartellaStep = "pick" | "preview";
type WalletTab = "deposit" | "withdraw" | "transfer" | "history" | "admin";

const AUTH_PHONE_STORAGE_KEY = "ethio_bingo_auth_phone";
const AUTH_PASSWORD_STORAGE_KEY = "ethio_bingo_auth_password";
const AUTH_REMEMBER_STORAGE_KEY = "ethio_bingo_auth_remember_password";
const THEME_STORAGE_KEY = "ethio_bingo_theme_mode";

const services: Array<{ view: ServiceView; label: string }> = [
  { view: "home", label: "Home" },
  { view: "stakes", label: "Bingo Game" },
  { view: "game", label: "Live Game" },
  { view: "casino", label: "Casino Games" },
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
  name: "Ethio Bingo",
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
const casinoCircleGames = [
  { id: "welcome-offer", title: "Welcome Offer", image_url: "/casino/welcome-offer.svg" },
  { id: "claw-machine", title: "Claw Machine", image_url: "/casino/claw-machine.svg" },
  { id: "win-wheel", title: "Win With The Wheel Sweepstakes", image_url: "/casino/win-wheel-sweepstakes.svg" },
  { id: "power-up", title: "Pick A Power-Up", image_url: "/casino/pick-a-power-up.svg" },
  { id: "roar-bear", title: "Roar of the Bear Megaways", image_url: "/casino/roar-bear.svg" },
];
const casinoFeaturedGames = [
  { id: "super-hammer", title: "Super Hammer", image_url: "/casino/super-hammer.svg", exclusive: true },
  { id: "walking-dead", title: "Walking Dead Collect Em", image_url: "/casino/walking-dead.svg", exclusive: true },
  { id: "roar-bear", title: "Roar of the Bear", image_url: "/casino/roar-bear.svg", exclusive: true },
  { id: "bankin-more-bacon", title: "Bankin More Bacon", image_url: "/casino/bankin-more-bacon.svg", exclusive: true },
  { id: "treasure-drops", title: "Treasure Drops", image_url: "/casino/treasure-drops.svg", exclusive: true },
];
const casinoLatestGames = [
  { id: "gates-of-olympus", title: "Gates of Olympus", image_url: "/casino/gates-of-olympus.svg" },
  { id: "sweet-bonanza", title: "Sweet Bonanza", image_url: "/casino/sweet-bonanza.svg" },
  { id: "wolf-gold", title: "Wolf Gold", image_url: "/casino/wolf-gold.svg" },
  { id: "book-of-ra", title: "Book of Ra", image_url: "/casino/book-of-ra.svg" },
  { id: "big-bass", title: "Big Bass Splash", image_url: "/casino/big-bass-splash.svg" },
  { id: "blackjack", title: "Blackjack Classic", image_url: "/casino/blackjack-classic.svg" },
];

const fmtEtb = (value: number) => `ETB ${value.toFixed(2)}`;
const fmtDate = (value: string) => new Date(value).toLocaleString();
const fmtShortDate = (value: string) => new Date(value).toLocaleDateString("en-GB");
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
  const accountCreatedNotice = notice.toLowerCase().startsWith("account created");
  return (
    <div className="auth-shell">
      <div className="auth-card">
        <div className="auth-brand">
          <img src="/brand/ethio-bingo-logo.svg" alt="Ethio Bingo logo" className="auth-brand-logo" />
          <h1>Ethio Bingo</h1>
        </div>
        <p>{mode === "signup" ? "Create account to continue." : "Sign in to continue."}</p>
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
            <input value={phone} onChange={(event) => setPhone(event.target.value)} required />
          </label>
          <label>
            Password
            <input type="password" value={password} onChange={(event) => setPassword(event.target.value)} required />
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

  useEffect(() => {
    try {
      const storedTheme = window.localStorage.getItem(THEME_STORAGE_KEY);
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
    } catch {
      // ignore storage errors
    }
  }, [isDarkMode]);

  useEffect(() => {
    try {
      const remembered = window.localStorage.getItem(AUTH_REMEMBER_STORAGE_KEY) === "1";
      const savedPhone = window.localStorage.getItem(AUTH_PHONE_STORAGE_KEY) ?? "";
      const savedPassword = window.localStorage.getItem(AUTH_PASSWORD_STORAGE_KEY) ?? "";
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
      if (rememberPassword) {
        window.localStorage.setItem(AUTH_PASSWORD_STORAGE_KEY, authPassword);
      } else {
        window.localStorage.removeItem(AUTH_PASSWORD_STORAGE_KEY);
      }
    } catch {
      // ignore storage errors
    }
  }, [authPhone, authPassword, rememberPassword]);

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
  }, [casinoTapMode, service]);

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
    const storageKey = "ethio_bingo_brand_modal_seen_at";
    const raw = window.localStorage.getItem(storageKey);
    const lastSeen = raw ? Number(raw) : 0;
    const cooldownMs = 1000 * 60 * 60 * 6;
    if (!Number.isFinite(lastSeen) || Date.now() - lastSeen >= cooldownMs) {
      setShowBrandModal(true);
    }
  }, [profile?.phone_number]);

  const openService = (next: ServiceView) => {
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

  const handleCasinoPlay = (gameTitle: string) => {
    setNotice(`Opening ${gameTitle}...`);
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
      const [dash, hist, betHist] = await Promise.all([fetchDashboard(), fetchHistory(), safeFetchBetHistory()]);
      setDashboard(dash);
      setProfile(dash.user);
      setHistory(hist.items);
      setBetHistory(betHist.items);
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
    if (!profile) return;
    if (cartellaOpen || service === "game" || service === "stakes") return;
    let inFlight = false;
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
    }, 1800);
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
      const normalizedPhone = authPhone.trim();
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
      if (authMode === "signup" && message.toLowerCase().includes("already registered")) {
        setAuthMode("login");
        setAuthNotice("This phone is already registered. Please sign in.");
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
      const phoneForLink = authPhone.trim();
      const canLinkExisting = phoneForLink.length > 0 && authPassword.trim().length >= 6;
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
      setCards(res.cards ?? (res.card ? [res.card] : []));
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
    window.localStorage.setItem("ethio_bingo_brand_modal_seen_at", String(Date.now()));
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
      <div className="ethio-loading">
        <div className="loader-ring" />
        <p>Loading Ethio Bingo...</p>
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

  return (
    <div className="ethio-app">
      <div className={`drawer-overlay ${drawerOpen ? "show" : ""}`} onClick={() => setDrawerOpen(false)} />
      <aside className={`side-drawer ${drawerOpen ? "open" : ""}`}>
        <div className="drawer-profile">
          <div className="avatar">EB</div>
          <div>
            <h3>HEY, PLAYER</h3>
            <p>{profile.user_name}</p>
          </div>
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
            <img src="/brand/ethio-bingo-logo.svg" alt="Ethio Bingo logo" className="brand-inline-logo" />
            <span>Ethio Bingo</span>
          </div>
          <button className="menu-toggle" type="button" onClick={() => setDrawerOpen((state) => !state)}>
            =
          </button>
          <button
            className={`theme-toggle ${isDarkMode ? "dark" : "light"}`}
            type="button"
            aria-label={isDarkMode ? "Switch to light mode" : "Switch to dark mode"}
            onClick={() => setIsDarkMode((current) => !current)}
          >
            <span>{isDarkMode ? "Dark" : "Light"}</span>
          </button>
          <button className="refresh-btn" type="button" onClick={() => void loadData()}>
            Refresh
          </button>
          <div className="wallet-pill">{fmtEtb(wallet.main_balance)}</div>
        </div>
      </header>

      <main className="main-content">
        {loading && <div className="notice">Refreshing data...</div>}
        {error && <div className="notice error">{error}</div>}
        {notice && <div className="notice success">{notice}</div>}

        {service === "home" && (
          <section className="panel">
            <h2>Services</h2>
            <p>Use the hamburger menu to open services that do not fit in one page.</p>
            <div className="home-grid">
              <article className="service-card">
                <h3>Bingo Rooms</h3>
                <p>Choose stake and buy cartella.</p>
                <button className="primary-btn" type="button" onClick={() => openService("stakes")}>
                  Open
                </button>
              </article>
              <article className="service-card">
                <h3>Wallet</h3>
                <p>Manage your balance, deposits, withdrawals, and transfer history.</p>
                <button className="primary-btn" type="button" onClick={() => openService("wallet")}>
                  Open
                </button>
              </article>
              <article className="service-card">
                <h3>Live Game</h3>
                <p>After countdown, players mark called numbers by clicking.</p>
                <button className="primary-btn" type="button" onClick={() => openService("game")}>
                  Open
                </button>
              </article>
              <article className="service-card">
                <h3>Casino Games</h3>
                <p>Play quick casino rounds with the same Ethio Bingo wallet balance.</p>
                <button className="primary-btn" type="button" onClick={() => openService("casino")}>
                  Open
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
                const active =
                  stake.room_phase === "selecting" || (stake.status === "countdown" && stake.room_phase !== "finished")
                    ? `0:${String(stake.countdown_seconds ?? 0).padStart(2, "0")}`
                    : isPlaying
                      ? "Playing"
                      : stake.room_phase === "finished"
                        ? `0:${String(stake.countdown_seconds ?? 0).padStart(2, "0")}`
                        : "None";
                const canOpen = Boolean(stake.open_available && (stake.my_cards_current ?? 0) > 0);
                return (
                  <div key={stake.id} className={`stake-row ${stake.bonus ? "bonus" : ""}`}>
                    {stake.bonus && <div className="bonus-tag">Bonus</div>}
                    <span className="stake-col">{stake.stake} birr</span>
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

        {service === "casino" && (
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
                    <img className="casino-circle-image" src={game.image_url} alt={`${game.title} icon`} loading="lazy" />
                  </div>
                  <p>{game.title}</p>
                </article>
              ))}
            </div>

            <div className="casino-content-block">
              <div className="casino-section-heading">
                <div className="casino-section-label">FEATURED</div>
                <p className="casino-section-subtitle">Top picks right now</p>
              </div>
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
                    ☆
                  </button>
                  <img className="casino-thumb" src={game.image_url} alt={`${game.title} preview`} loading="lazy" />
                  <div className="casino-card-overlay">
                    <button
                      className="casino-play-btn"
                      type="button"
                      onClick={(event) => {
                        event.stopPropagation();
                        handleCasinoPlay(game.title);
                      }}
                    >
                      Play
                    </button>
                  </div>
                  <div className="casino-card-title">{game.title}</div>
                </article>
              ))}
            </div>

            <div className="casino-section-heading">
              <div className="casino-section-label latest">LATEST RELEASES</div>
              <p className="casino-section-subtitle">Latest and greatest slot games</p>
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
                    ☆
                  </button>
                  <img className="casino-thumb" src={game.image_url} alt={`${game.title} preview`} loading="lazy" />
                  <div className="casino-card-overlay">
                    <button
                      className="casino-play-btn"
                      type="button"
                      onClick={(event) => {
                        event.stopPropagation();
                        handleCasinoPlay(game.title);
                      }}
                    >
                      Play
                    </button>
                  </div>
                  <div className="casino-card-title">{game.title}</div>
                </article>
              ))}
            </div>
            </div>
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
                    <div className="cartella-ad">Ethio Bingo</div>
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
                  {selectedMethod.transfer_accounts.map((account) => (
                    <div key={`${selectedMethod.code}-${account.phone_number}`} className="account-box">
                      <span>{account.phone_number}</span>
                      <small>{account.owner_name}</small>
                      <button className="secondary-btn copy-btn" type="button" onClick={() => void onCopyPhone(account.phone_number)}>
                        {copiedPhone === account.phone_number ? "Copied" : "Copy"}
                      </button>
                    </div>
                  ))}
                </div>
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
              <h3>Ethio Bingo Updates</h3>
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

