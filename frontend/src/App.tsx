import { FormEvent, KeyboardEvent as ReactKeyboardEvent, Suspense, lazy, startTransition, useEffect, useMemo, useRef, useState } from "react";
import { unstable_batchedUpdates } from "react-dom";
import {
  approveAdminWithdrawRequest,
  clearAdminDepositedRecords,
  claimBingo,
  clearAuthToken,
  fetchAdminDepositedRecords,
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
  setAutoMarkPreference,
  login as loginRequest,
  markPaidAdminWithdrawRequest,
  launchCasinoGame,
  logout as logoutRequest,
  isApiRequestError,
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
  DepositedRecord,
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
type PendingMarkMap = Record<string, boolean>;
type ToastTone = "success" | "error" | "info";
type WalletFieldErrorMap = Partial<
  Record<
    | "depositAmount"
    | "txNo"
    | "receiptMessage"
    | "transferPhone"
    | "transferAmount"
    | "transferOtp"
    | "withdrawAccountNumber"
    | "withdrawAccountHolder"
    | "withdrawAmount",
    string
  >
>;

type PusherEventHandler = (payload: unknown) => void;
type PusherChannelLike = { bind: (eventName: string, handler: PusherEventHandler) => void; unbind: (eventName: string, handler: PusherEventHandler) => void };
type PusherClientLike = {
  subscribe: (channelName: string) => PusherChannelLike;
  unsubscribe: (channelName: string) => void;
  disconnect: () => void;
};
type PusherConstructor = new (key: string, options: { cluster: string; forceTLS: boolean }) => PusherClientLike;

declare global {
  interface Window {
    Pusher?: PusherConstructor;
  }
}

const loadCartellaModalContent = () => import("./components/modals/CartellaModalContent");
const loadDepositModalContent = () => import("./components/modals/DepositModalContent");
const loadBetHistoryModalContent = () => import("./components/modals/BetHistoryModalContent");
const loadBrandModalContent = () => import("./components/modals/BrandModalContent");

const CartellaModalContent = lazy(loadCartellaModalContent);
const DepositModalContent = lazy(loadDepositModalContent);
const BetHistoryModalContent = lazy(loadBetHistoryModalContent);
const BrandModalContent = lazy(loadBrandModalContent);

const AUTH_PHONE_STORAGE_KEY = "40bingo_auth_phone";
const AUTH_REMEMBER_STORAGE_KEY = "40bingo_auth_remember_phone";
const THEME_STORAGE_KEY = "40bingo_theme_mode";
const BRAND_MODAL_STORAGE_KEY = "40bingo_brand_modal_seen_at";
const LEGACY_AUTH_PHONE_STORAGE_KEY = "ethio_bingo_auth_phone";
const LEGACY_AUTH_REMEMBER_STORAGE_KEY = "ethio_bingo_auth_remember_phone";
const LEGACY_THEME_STORAGE_KEY = "ethio_bingo_theme_mode";
const LEGACY_BRAND_MODAL_STORAGE_KEY = "ethio_bingo_brand_modal_seen_at";
const DEPRECATED_AUTH_REMEMBER_PASSWORD_STORAGE_KEY = "40bingo_auth_remember_password";
const LEGACY_DEPRECATED_AUTH_REMEMBER_PASSWORD_STORAGE_KEY = "ethio_bingo_auth_remember_password";
const DEPRECATED_AUTH_PASSWORD_STORAGE_KEY = "40bingo_auth_password";
const LEGACY_DEPRECATED_AUTH_PASSWORD_STORAGE_KEY = "ethio_bingo_auth_password";
const APP_BACK_GUARD_STATE_KEY = "__40bingo_back_guard";
const CASINO_ENABLED = false;
const NOTICE_TIMEOUT_MS = 4500;
const CARD_RECHARGE_LABEL_TIMEOUT_MS = 2500;
const SESSION_SHARE_SERVICE_PARAM = "service";
const SESSION_SHARE_STAKE_PARAM = "stake";
const SESSION_SHARE_SERVICE_VALUE = "game";
const SESSION_QR_IMAGE_SIZE = 280;
const ROOM_EMPTY_POLL_GRACE_MS = 8000;
const ROOM_EMPTY_POLL_GRACE_COUNT = 3;
const LIVE_COUNTDOWN_TICK_MS = 250;
const FINISHED_RESULTS_MIN_HOLD_MS = 10000;
const FINISHED_RESULTS_MAX_HOLD_MS = 30000;
const FINISHED_RESULTS_DEFAULT_HOLD_MS = 15000;
const PUSHER_KEY = ((import.meta.env.VITE_PUSHER_KEY as string | undefined)?.trim() || "ZmjxWZcUWx03wDBd7vmSQTBIP-2KVn4yK8oEXG3efsg");
const PUSHER_CLUSTER = ((import.meta.env.VITE_PUSHER_CLUSTER as string | undefined)?.trim() || "ap2");
const PUSHER_JS_URL = "https://js.pusher.com/8.4.0/pusher.min.js";
const REALTIME_SYNC_THROTTLE_MS = 400;
const REALTIME_PUSH_STALE_MS = 6000;
const REALTIME_FALLBACK_POLL_MS = 2500;
const OPEN_STALE_FINISHED_RETRIES = 3;

let pusherScriptReadyPromise: Promise<void> | null = null;
function ensurePusherScriptLoaded() {
  if (typeof window === "undefined") return Promise.resolve();
  if (window.Pusher) return Promise.resolve();
  if (pusherScriptReadyPromise) return pusherScriptReadyPromise;
  pusherScriptReadyPromise = new Promise<void>((resolve, reject) => {
    const existing = document.querySelector<HTMLScriptElement>(`script[src="${PUSHER_JS_URL}"]`);
    if (existing) {
      existing.addEventListener("load", () => resolve(), { once: true });
      existing.addEventListener("error", () => reject(new Error("Failed to load Pusher script")), { once: true });
      return;
    }
    const script = document.createElement("script");
    script.src = PUSHER_JS_URL;
    script.async = true;
    script.onload = () => resolve();
    script.onerror = () => reject(new Error("Failed to load Pusher script"));
    document.head.appendChild(script);
  });
  return pusherScriptReadyPromise;
}

function readInitialDarkModePreference() {
  if (typeof window === "undefined") return true;
  try {
    const storedTheme = window.localStorage.getItem(THEME_STORAGE_KEY) ?? window.localStorage.getItem(LEGACY_THEME_STORAGE_KEY);
    if (storedTheme === "dark") return true;
    if (storedTheme === "light") return false;
  } catch {
    // ignore storage errors
  }
  return window.matchMedia?.("(prefers-color-scheme: dark)")?.matches ?? true;
}

const services: Array<{ view: ServiceView; label: string }> = [
  { view: "home", label: "Home" },
  { view: "stakes", label: "Rooms" },
  { view: "game", label: "Live" },
  ...(CASINO_ENABLED ? [{ view: "casino" as ServiceView, label: "Casino Games" }] : []),
  { view: "wallet", label: "Wallet" },
  { view: "history", label: "History" },
  { view: "how", label: "How To Play" },
  { view: "contact", label: "Contact" },
];

const mobileNavViews: ServiceView[] = ["home", "stakes", "game", "wallet", "history"];
const drawerMenuViews: ServiceView[] = ["how", "contact"];

const HOW_TO_PLAY_AMHARIC_STEPS = [
  "ወደ Rooms ገጽ በመግባት የሚፈልጉትን ዋጋ ይምረጡ እና ካርቴላ ይግዙ።",
  "ቆጠራው ከተጠናቀቀ በኋላ ጨዋታው ይጀምራል፤ የሚጠሩ ቁጥሮችን በቀጥታ ይከታተሉ።",
  "በገዙት ካርቴላ ላይ የተጠሩ ቁጥሮችን ይምልኩ።",
  "አሸናፊው ሲታወቅ ውጤቱ በሲስተሙ ይረጋገጣል ከዚያም ክፍያው ወደ Balance ይገባል።",
  "እገዛ ካስፈለገ በContact ወይም በWallet ያሉ የድጋፍ መረጃዎችን ይጠቀሙ።",
];

const DEPOSIT_AMHARIC_STEPS = [
  "ከሚታዩት የተረጋገጡ የክፍያ ቁጥሮች አንዱን ብቻ ይጠቀሙ።",
  "ያስገቡትን መጠን እና የግብይት ቁጥር በትክክል ያስገቡ።",
  "የክፍያ SMS ወይም ደረሰኝ ጽሑፍ እንዳለ በቀጥታ ያቅርቡ።",
];

const WITHDRAW_AMHARIC_STEPS = [
  "ባንክ, የመለያ ቁጥር እና የባለመለያ ስም በትክክል ያስገቡ።",
  "የሚወጣውን መጠን በትክክል ይሙሉ እና የማውጣት ጥያቄ አዝራር ይጫኑ።",
  "ጥያቄው ከተላከ በኋላ በአስተዳዳሪ ማረጋገጥ ይጠናቀቃል።",
];

function renderMobileNavIcon(view: ServiceView) {
  switch (view) {
    case "home":
      return (
        <svg viewBox="0 0 24 24" aria-hidden="true" focusable="false">
          <path d="M4 10.5 12 4l8 6.5V20a1 1 0 0 1-1 1h-4v-6H9v6H5a1 1 0 0 1-1-1z" />
        </svg>
      );
    case "stakes":
      return (
        <svg viewBox="0 0 24 24" aria-hidden="true" focusable="false">
          <path d="M4 4h7v7H4zM13 4h7v7h-7zM4 13h7v7H4zM13 13h7v7h-7z" />
        </svg>
      );
    case "game":
      return (
        <svg viewBox="0 0 24 24" aria-hidden="true" focusable="false">
          <path d="M12 2a6 6 0 0 0-6 6c0 3.2 2.5 5.2 4.7 7 1.1.9 2.3 1.8 3.3 2.9 1-1.1 2.2-2 3.3-2.9 2.2-1.8 4.7-3.8 4.7-7a6 6 0 0 0-6-6zM12 7.2a1.8 1.8 0 1 1 0 3.6 1.8 1.8 0 0 1 0-3.6z" />
        </svg>
      );
    case "wallet":
      return (
        <svg viewBox="0 0 24 24" aria-hidden="true" focusable="false">
          <path d="M4 7a3 3 0 0 1 3-3h10v3H7a1 1 0 0 0 0 2h13v9a3 3 0 0 1-3 3H7a3 3 0 0 1-3-3zM15 12a2 2 0 1 0 0 4h5v-4z" />
        </svg>
      );
    case "history":
      return (
        <svg viewBox="0 0 24 24" aria-hidden="true" focusable="false">
          <path d="M12 4a8 8 0 1 1-7.6 10.5H2l3.2-3.8L8.4 14H6.6A5.5 5.5 0 1 0 12 6.5V4zm-1 4h2v5h4v2h-6V8z" />
        </svg>
      );
    default:
      return (
        <svg viewBox="0 0 24 24" aria-hidden="true" focusable="false">
          <circle cx="12" cy="12" r="8" />
        </svg>
      );
  }
}

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

const buildMarkRequestKey = (cardNo: number, value: number) => `${cardNo}:${value}`;

const applyMarkMutationToRoom = (state: RoomState | null, cardNo: number, value: number, marked: boolean) => {
  if (!state) return state;
  const cardKey = String(cardNo);
  const currentMarks = state.my_marked_numbers_by_card?.[cardKey] ?? [];
  const nextMarks = marked ? Array.from(new Set([...currentMarks, value])).sort((a, b) => a - b) : currentMarks.filter((item) => item !== value);
  return {
    ...state,
    my_marked_numbers_by_card: {
      ...state.my_marked_numbers_by_card,
      [cardKey]: nextMarks,
    },
    my_marked_numbers:
      state.my_cartella === cardNo
        ? nextMarks
        : state.my_marked_numbers,
  };
};

const applyPendingMarksToRoom = (state: RoomState | null, pendingMarks: PendingMarkMap) => {
  let nextState = state;
  for (const [key, marked] of Object.entries(pendingMarks)) {
    const [cardNoRaw, valueRaw] = key.split(":");
    const cardNo = Number(cardNoRaw);
    const value = Number(valueRaw);
    if (!Number.isFinite(cardNo) || !Number.isFinite(value)) continue;
    nextState = applyMarkMutationToRoom(nextState, cardNo, value, marked);
  }
  return nextState;
};

const hasMarkedNumbers = (markMap: Record<string, number[]>) => Object.values(markMap).some((values) => values.length > 0);

const mergeUniqueSortedNumbers = (...numberLists: Array<number[] | undefined>) =>
  Array.from(
    new Set(
      numberLists.flatMap((numberList) =>
        Array.isArray(numberList) ? numberList.filter((value): value is number => Number.isFinite(value)) : [],
      ),
    ),
  ).sort((left, right) => left - right);

const stabilizeNumberList = (incomingList: number[] | undefined, previousList: number[] | undefined) => {
  const incoming = incomingList ?? [];
  const previous = previousList ?? [];
  if (!previous.length || incoming.length >= previous.length) return incoming;
  return mergeUniqueSortedNumbers(previous, incoming);
};

const maxOptionalNumber = (incomingValue: number | undefined, previousValue: number | undefined) => {
  if (incomingValue == null) return previousValue;
  if (previousValue == null) return incomingValue;
  return Math.max(incomingValue, previousValue);
};

const getPickerQueueKey = (state: RoomState | null) => {
  if (!state) return "";
  const queueRoundId = state.active_queue === "next" ? state.next_round_id : state.round_id;
  return `${state.id}:${state.active_queue}:${queueRoundId}:${state.phase}`;
};

const deriveStakeUiFromRoom = (stake: StakeOption, room: RoomState): StakeOption => {
  const myCardsCurrent = room.my_cartellas?.length ?? stake.my_cards_current;
  const myCardsNext = room.next_my_cartellas?.length ?? stake.my_cards_next;
  const phase = room.phase;
  const status: StakeOption["status"] = phase === "playing" ? "playing" : "countdown";
  const countdownSeconds =
    phase === "selecting"
      ? room.countdown_seconds
      : phase === "finished"
        ? room.announcement_seconds
        : null;
  return {
    ...stake,
    status,
    countdown_seconds: countdownSeconds,
    room_phase: phase,
    my_cards_current: myCardsCurrent,
    my_cards_next: myCardsNext,
    open_available: phase === "playing" && myCardsCurrent > 0,
  };
};

type WithdrawFlowStatus = "Pending" | "Processing" | "Paid" | "Rejected";

const normalizeWithdrawFlowStatus = (status: WithdrawTicket["status"]): WithdrawFlowStatus => {
  if (status === "Approved") return "Paid";
  return status;
};

const mergeWithdrawTicketForward = (previous: WithdrawTicket | undefined, incoming: WithdrawTicket): WithdrawTicket => {
  const incomingStatus = normalizeWithdrawFlowStatus(incoming.status);
  if (!previous) return { ...incoming, status: incomingStatus };

  const previousStatus = normalizeWithdrawFlowStatus(previous.status);

  if (previousStatus === "Paid") {
    if (incomingStatus !== "Paid") return previous;
    return { ...incoming, status: "Paid" };
  }

  if (previousStatus === "Rejected") {
    if (incomingStatus !== "Rejected") return previous;
    return { ...incoming, status: "Rejected" };
  }

  if (previousStatus === "Processing" && incomingStatus === "Pending") {
    return { ...incoming, ...previous, status: "Processing" };
  }

  return { ...incoming, status: incomingStatus };
};

const mergeWithdrawTicketsForward = (previousTickets: WithdrawTicket[], incomingTickets: WithdrawTicket[]): WithdrawTicket[] => {
  const previousById = new Map(previousTickets.map((ticket) => [ticket.id, ticket]));
  return incomingTickets.map((ticket) => mergeWithdrawTicketForward(previousById.get(ticket.id), ticket));
};

const upsertWithdrawTicketForward = (tickets: WithdrawTicket[], incoming: WithdrawTicket): WithdrawTicket[] => {
  const nextTicket = mergeWithdrawTicketForward(
    tickets.find((ticket) => ticket.id === incoming.id),
    incoming,
  );
  const index = tickets.findIndex((ticket) => ticket.id === incoming.id);
  if (index < 0) return [nextTicket, ...tickets];
  const next = [...tickets];
  next[index] = nextTicket;
  return next;
};

const stabilizeRoomMarks = (previous: RoomState | null, incoming: RoomState | null) => {
  if (!incoming || !previous) return incoming;
  if (incoming.id !== previous.id) return incoming;
  if (incoming.round_id === previous.round_id) {
    const phaseRank: Record<RoomState["phase"], number> = { selecting: 0, playing: 1, finished: 2 };
    if (phaseRank[incoming.phase] < phaseRank[previous.phase]) {
      return previous;
    }
    if (
      incoming.phase === "playing" &&
      previous.phase === "playing" &&
      incoming.called_numbers.length + 1 < previous.called_numbers.length
    ) {
      return previous;
    }
  }

  let stabilized = incoming;
  if (incoming.round_id === previous.round_id && incoming.phase === previous.phase) {
    stabilized = {
      ...stabilized,
      paid_cartellas: stabilizeNumberList(incoming.paid_cartellas, previous.paid_cartellas),
      simulated_paid_cartellas: stabilizeNumberList(incoming.simulated_paid_cartellas, previous.simulated_paid_cartellas),
      my_cartellas: stabilizeNumberList(incoming.my_cartellas, previous.my_cartellas),
      next_my_cartellas: stabilizeNumberList(incoming.next_my_cartellas, previous.next_my_cartellas),
      my_held_cartella: incoming.my_held_cartella ?? previous.my_held_cartella,
      display_paid_count: maxOptionalNumber(incoming.display_paid_count, previous.display_paid_count),
      current_paid_count: maxOptionalNumber(incoming.current_paid_count, previous.current_paid_count),
    };
  }

  if (stabilized.phase !== "playing") return stabilized;

  const incomingMap = stabilized.my_marked_numbers_by_card ?? {};
  const previousMap = previous.my_marked_numbers_by_card ?? {};
  if (hasMarkedNumbers(incomingMap) || !hasMarkedNumbers(previousMap)) return stabilized;

  const fallbackMarked =
    stabilized.my_cartella != null
      ? previousMap[String(stabilized.my_cartella)] ?? stabilized.my_marked_numbers
      : stabilized.my_marked_numbers;

  return {
    ...stabilized,
    my_marked_numbers_by_card: previousMap,
    my_marked_numbers: fallbackMarked,
  };
};

const resolveSyncedCards = (nextRoom: RoomState, nextCards: BingoCard[], previousCards: BingoCard[], previousRoom: RoomState | null) => {
  if (nextCards.length > 0) return nextCards;
  const sameRoom = Boolean(previousRoom && previousRoom.id === nextRoom.id);
  const sameRound = Boolean(sameRoom && previousRoom && previousRoom.round_id === nextRoom.round_id);
  if (
    previousCards.length > 0 &&
    previousRoom &&
    sameRound &&
    previousRoom.phase === "playing" &&
    nextRoom.phase === "playing"
  ) {
    return previousCards;
  }
  if (sameRound && nextRoom.phase === "finished" && previousCards.length > 0) return previousCards;
  if (sameRound && (nextRoom.announcement_seconds ?? 0) > 0 && previousCards.length > 0) return previousCards;
  if (nextRoom.my_cartellas.length > 0 && previousCards.length > 0) {
    const filtered = previousCards.filter((card) => nextRoom.my_cartellas.includes(card.card_no));
    if (filtered.length > 0) return filtered;
  }
  return [];
};

const stabilizePickerRoomState = (previous: RoomState | null, incoming: RoomState | null) => {
  if (!incoming || !previous) return incoming;
  if (incoming.id !== previous.id) return incoming;
  if (incoming.round_id !== previous.round_id || incoming.phase !== previous.phase) return incoming;

  return {
    ...incoming,
    paid_cartellas: stabilizeNumberList(incoming.paid_cartellas, previous.paid_cartellas),
    simulated_paid_cartellas: stabilizeNumberList(incoming.simulated_paid_cartellas, previous.simulated_paid_cartellas),
    my_cartellas: stabilizeNumberList(incoming.my_cartellas, previous.my_cartellas),
    next_my_cartellas: stabilizeNumberList(incoming.next_my_cartellas, previous.next_my_cartellas),
    my_held_cartella: incoming.my_held_cartella ?? previous.my_held_cartella,
    display_paid_count: maxOptionalNumber(incoming.display_paid_count, previous.display_paid_count),
    current_paid_count: maxOptionalNumber(incoming.current_paid_count, previous.current_paid_count),
  };
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

function activateOnEnterSpace(event: ReactKeyboardEvent<HTMLElement>, action: () => void) {
  if (event.key !== "Enter" && event.key !== " ") return;
  event.preventDefault();
  action();
}

function fallbackCopyText(value: string) {
  const textarea = document.createElement("textarea");
  textarea.value = value;
  textarea.setAttribute("readonly", "true");
  textarea.setAttribute("aria-hidden", "true");
  textarea.style.position = "fixed";
  textarea.style.top = "0";
  textarea.style.left = "0";
  textarea.style.opacity = "0";
  textarea.style.pointerEvents = "none";
  document.body.appendChild(textarea);
  textarea.focus();
  textarea.select();
  textarea.setSelectionRange(0, value.length);
  let copied = false;
  try {
    copied = document.execCommand("copy");
  } catch {
    copied = false;
  } finally {
    document.body.removeChild(textarea);
  }
  return copied;
}

function readSharedStakeIdFromLocation() {
  if (typeof window === "undefined") return "";
  try {
    const params = new URLSearchParams(window.location.search);
    const stakeId = params.get(SESSION_SHARE_STAKE_PARAM)?.trim() ?? "";
    const service = params.get(SESSION_SHARE_SERVICE_PARAM)?.trim() ?? "";
    if (!stakeId) return "";
    if (service && service !== SESSION_SHARE_SERVICE_VALUE) return "";
    return stakeId;
  } catch {
    return "";
  }
}

function clearSharedStakeParamsFromLocation() {
  if (typeof window === "undefined") return;
  try {
    const url = new URL(window.location.href);
    url.searchParams.delete(SESSION_SHARE_SERVICE_PARAM);
    url.searchParams.delete(SESSION_SHARE_STAKE_PARAM);
    window.history.replaceState(window.history.state, "", url.toString());
  } catch {
    // ignore history API failures
  }
}

function buildSessionShareLink(stakeId: string) {
  if (typeof window === "undefined" || !stakeId) return "";
  try {
    const url = new URL(window.location.href);
    url.searchParams.set(SESSION_SHARE_SERVICE_PARAM, SESSION_SHARE_SERVICE_VALUE);
    url.searchParams.set(SESSION_SHARE_STAKE_PARAM, stakeId);
    return url.toString();
  } catch {
    return "";
  }
}

function buildSessionQrImageSrc(value: string) {
  if (!value) return "";
  return `https://api.qrserver.com/v1/create-qr-code/?size=${SESSION_QR_IMAGE_SIZE}x${SESSION_QR_IMAGE_SIZE}&data=${encodeURIComponent(value)}`;
}

function ModalBodyFallback({
  title,
  message,
  onClose,
  variant = "lines",
  headingId,
}: {
  title: string;
  message: string;
  onClose: () => void;
  variant?: "lines" | "grid" | "card";
  headingId?: string;
}) {
  const blockCount = variant === "grid" ? 24 : variant === "card" ? 12 : 5;
  return (
    <>
      <div className="modal-head">
        <h3 id={headingId}>{title}</h3>
        <button type="button" onClick={onClose} aria-label="Close dialog">
          &times;
        </button>
      </div>
      <div className={`modal-skeleton modal-skeleton-${variant}`}>
        <p className="modal-skeleton-copy">{message}</p>
        <div className={variant === "grid" ? "modal-skeleton-grid-blocks" : "modal-skeleton-stack"}>
          {Array.from({ length: blockCount }, (_, idx) => (
            <span key={`${title}-fallback-${idx}`} className={`modal-skeleton-block ${variant === "grid" ? "small" : ""}`} />
          ))}
        </div>
      </div>
    </>
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
  confirmPassword,
  setConfirmPassword,
  busy,
  notice,
  error,
  rememberPhone,
  setRememberPhone,
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
  confirmPassword: string;
  setConfirmPassword: (value: string) => void;
  busy: boolean;
  notice: string;
  error: string;
  rememberPhone: boolean;
  setRememberPhone: (value: boolean) => void;
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
        <p className="auth-subtitle">
          {mode === "signup" ? "Set up your profile and join a room in under a minute." : "Sign in and jump back into your live game."}
        </p>
        <div className="auth-switch">
          <button type="button" className={mode === "login" ? "active" : ""} onClick={() => setMode("login")}>
            Sign In
          </button>
          <button type="button" className={mode === "signup" ? "active" : ""} onClick={() => setMode("signup")}>
            Sign Up
          </button>
        </div>
        <form className="auth-form" onSubmit={onSubmit}>
          {mode === "signup" && (
            <label>
              Full Name
              <input value={name} onChange={(event) => setName(event.target.value)} autoComplete="name" required />
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
                aria-pressed={showPassword}
                aria-label={showPassword ? "Hide password" : "Show password"}
              >
                {showPassword ? "Hide" : "Show"}
              </button>
            </div>
          </label>
          {mode === "signup" && (
            <label>
              Confirm Password
              <input
                type={showPassword ? "text" : "password"}
                value={confirmPassword}
                autoComplete="new-password"
                onChange={(event) => setConfirmPassword(event.target.value)}
                required
              />
            </label>
          )}
          <label className="auth-inline-check">
            <input type="checkbox" checked={rememberPhone} onChange={(event) => setRememberPhone(event.target.checked)} />
            <span>Remember my phone number on this device</span>
          </label>
          {notice && (
            <p className={`auth-notice ${accountCreatedNotice ? "account-created" : ""}`} role="status" aria-live="polite">
              {notice}
            </p>
          )}
          {error && (
            <p className="auth-error" role="alert">
              {error}
            </p>
          )}
          <button className="primary-btn" type="submit" disabled={busy}>
            {busy ? "Please wait..." : mode === "login" ? "Sign In" : "Create Account"}
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

function ToastRail({
  loading,
  notice,
  error,
  onDismissNotice,
  onDismissError,
}: {
  loading: boolean;
  notice: string;
  error: string;
  onDismissNotice: () => void;
  onDismissError: () => void;
}) {
  const toasts: Array<{ id: string; tone: ToastTone; message: string; dismissible: boolean }> = [];
  if (loading) {
    toasts.push({ id: "loading", tone: "info", message: "Refreshing live data...", dismissible: false });
  }
  if (error) {
    toasts.push({ id: "error", tone: "error", message: error, dismissible: true });
  }
  if (notice) {
    toasts.push({ id: "notice", tone: "success", message: notice, dismissible: true });
  }
  if (!toasts.length) return null;
  return (
    <div className="toast-rail" role="region" aria-label="Notifications">
      {toasts.map((toast) => (
        <div
          key={toast.id}
          className={`toast-card ${toast.tone}`}
          role={toast.tone === "error" ? "alert" : "status"}
          aria-live={toast.tone === "error" ? "assertive" : "polite"}
        >
          <p>{toast.message}</p>
          {toast.dismissible && (
            <button
              type="button"
              className="toast-dismiss"
              aria-label={`Dismiss ${toast.tone} message`}
              onClick={toast.id === "error" ? onDismissError : onDismissNotice}
            >
              &times;
            </button>
          )}
        </div>
      ))}
    </div>
  );
}

export default function App() {
  const backGuardArmedRef = useRef(false);
  const topHeaderRef = useRef<HTMLElement | null>(null);
  const gameSessionPanelRef = useRef<HTMLDivElement | null>(null);
  const shareDialogRef = useRef<HTMLDivElement | null>(null);
  const drawerDialogRef = useRef<HTMLElement | null>(null);
  const cartellaDialogRef = useRef<HTMLDivElement | null>(null);
  const depositDialogRef = useRef<HTMLDivElement | null>(null);
  const betDialogRef = useRef<HTMLDivElement | null>(null);
  const brandDialogRef = useRef<HTMLDivElement | null>(null);
  const overlayReturnFocusRef = useRef<HTMLElement | null>(null);
  const overlayWasOpenRef = useRef(false);
  const pendingMarksRef = useRef<PendingMarkMap>({});
  const roomSyncReceivedAtRef = useRef<number>(Date.now());
  const pickerRoomSyncReceivedAtRef = useRef<number>(Date.now());
  const lastStableGameSnapshotRef = useRef<{ room: RoomState; cards: BingoCard[]; at: number } | null>(null);
  const emptyGameSyncPollCountRef = useRef(0);
  const latestRoomRef = useRef<RoomState | null>(null);
  const latestCardsRef = useRef<BingoCard[]>([]);
  const latestServiceRef = useRef<ServiceView>("home");
  const pusherClientRef = useRef<PusherClientLike | null>(null);
  const realtimeLastEventAtRef = useRef(0);
  const realtimeLastSyncAtRef = useRef(0);
  const lastRoomTransitionLogRef = useRef<string>("");
  const lastPickerTransitionLogRef = useRef<string>("");
  const lastFinishedRoomRef = useRef<string | null>(null);
  const lastFinishedRedirectRef = useRef<string | null>(null);
  const lastSeenRoundKeyRef = useRef<string>("");
  const sharedStakeOpeningRef = useRef(false);
  const [ready, setReady] = useState(false);
  const [pusherReady, setPusherReady] = useState(false);
  const [isDarkMode, setIsDarkMode] = useState(() => readInitialDarkModePreference());
  const [isPageVisible, setIsPageVisible] = useState(() => (typeof document === "undefined" ? true : document.visibilityState !== "hidden"));
  const [loading, setLoading] = useState(false);
  const [working, setWorking] = useState(false);
  const [depositSubmitting, setDepositSubmitting] = useState(false);
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
  const [authConfirmPassword, setAuthConfirmPassword] = useState("");
  const [rememberPhone, setRememberPhone] = useState(false);
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
  const [walletFieldErrors, setWalletFieldErrors] = useState<WalletFieldErrorMap>({});
  const [adminDraftAccounts, setAdminDraftAccounts] = useState<Record<"telebirr" | "cbebirr", Array<{ phone_number: string; owner_name: string }>>>({
    telebirr: [],
    cbebirr: [],
  });
  const [adminAccountsSavingByMethod, setAdminAccountsSavingByMethod] = useState<Record<"telebirr" | "cbebirr", boolean>>({
    telebirr: false,
    cbebirr: false,
  });
  const [adminDraftDirtyByMethod, setAdminDraftDirtyByMethod] = useState<Record<"telebirr" | "cbebirr", boolean>>({
    telebirr: false,
    cbebirr: false,
  });
  const [adminWithdrawRequests, setAdminWithdrawRequests] = useState<WithdrawTicket[]>([]);
  const [adminPayoutRefs, setAdminPayoutRefs] = useState<Record<string, string>>({});
  const [adminDepositedRecords, setAdminDepositedRecords] = useState<DepositedRecord[]>([]);
  const [adminDepositedSearch, setAdminDepositedSearch] = useState("");
  const [adminDepositedDayFilter, setAdminDepositedDayFilter] = useState("");
  const [adminClearDepositedBusy, setAdminClearDepositedBusy] = useState(false);
  const [copiedPhone, setCopiedPhone] = useState("");
  const [copiedAccountNumber, setCopiedAccountNumber] = useState("");
  const [showBrandModal, setShowBrandModal] = useState(false);
  const [shareQrOpen, setShareQrOpen] = useState(false);
  const [shareQrImageError, setShareQrImageError] = useState(false);
  const [sharedStakeId, setSharedStakeId] = useState(() => readSharedStakeIdFromLocation());
  const [stakeCountdownNow, setStakeCountdownNow] = useState(() => Date.now());
  const [liveCountdownNow, setLiveCountdownNow] = useState(() => Date.now());
  const [stakeCountdownDeadlines, setStakeCountdownDeadlines] = useState<Record<string, number>>({});
  const [sessionPanelExpanded, setSessionPanelExpanded] = useState(true);
  const [nowPlayingExpanded, setNowPlayingExpanded] = useState(true);
  const [nowPlayingToggleTop, setNowPlayingToggleTop] = useState(88);
  const pickerQueueLockKeyRef = useRef<string>("");

  const [selectedStake, setSelectedStake] = useState<StakeOption | null>(null);
  const [cartellaOpen, setCartellaOpen] = useState(false);
  const [cartellaStep, setCartellaStep] = useState<CartellaStep>("pick");
  const [pickerRoom, setPickerRoom] = useState<RoomState | null>(null);
  const [lockedPickerPaidCartellas, setLockedPickerPaidCartellas] = useState<number[]>([]);
  const [lockedPickerSimulatedCartellas, setLockedPickerSimulatedCartellas] = useState<number[]>([]);
  const [selectedCartella, setSelectedCartella] = useState<number | null>(null);
  const [processingCartella, setProcessingCartella] = useState<number | null>(null);
  const [preview, setPreview] = useState<BingoCard | null>(null);

  const [room, setRoom] = useState<RoomState | null>(null);
  const [cards, setCards] = useState<BingoCard[]>([]);
  const [selectedCardNo, setSelectedCardNo] = useState<number | null>(null);
  const [pendingMarks, setPendingMarks] = useState<PendingMarkMap>({});
  const [claimingBingo, setClaimingBingo] = useState(false);
  const [autoClaimRequested, setAutoClaimRequested] = useState(false);
  const [autoMarkUpdating, setAutoMarkUpdating] = useState(false);

  const wallet: Wallet = dashboard?.wallet ?? { currency: "ETB", main_balance: 0, bonus_balance: 0 };
  const selectedMethod = useMemo(
    () => dashboard?.deposit_methods.find((method) => method.code === methodCode) ?? null,
    [dashboard, methodCode],
  );
  const selectedCartellaOwned = useMemo(() => {
    if (!pickerRoom || !selectedCartella) return false;
    return pickerRoom.my_cartellas.includes(selectedCartella) || pickerRoom.next_my_cartellas.includes(selectedCartella);
  }, [pickerRoom, selectedCartella]);
  const selectedCartellaHeld = selectedCartella != null && pickerRoom?.my_held_cartella === selectedCartella;
  const calledSet = useMemo(() => new Set(room?.called_numbers ?? []), [room?.called_numbers]);
  const card = useMemo(() => {
    if (!selectedCardNo) return null;
    return cards.find((item) => item.card_no === selectedCardNo) ?? null;
  }, [cards, selectedCardNo]);
  const markedNumbers = useMemo(() => marksForCard(room, selectedCardNo), [room, selectedCardNo]);
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
  const overlayOpen = drawerOpen || cartellaOpen || depositGuideOpen || selectedBet !== null || showBrandModal || shareQrOpen;
  const hasPendingMarks = Object.keys(pendingMarks).length > 0;
  const canResumeLiveGame =
    Boolean(room?.id) ||
    (dashboard?.stake_options ?? []).some(
      (stakeOption) => (stakeOption.my_cards_current ?? 0) > 0 || (stakeOption.my_cards_next ?? 0) > 0,
    );
  const activeStake = useMemo(() => {
    if (!room) return selectedStake;
    if (selectedStake && (selectedStake.stake === room.stake || selectedStake.stake === room.card_price)) {
      return selectedStake;
    }
    return (
      dashboard?.stake_options.find((option) => option.stake === room.stake || option.stake === room.card_price) ??
      selectedStake
    );
  }, [dashboard?.stake_options, room, selectedStake]);
  const sessionShareLink = useMemo(() => (activeStake?.id ? buildSessionShareLink(activeStake.id) : ""), [activeStake?.id]);
  const sessionQrImageSrc = useMemo(() => buildSessionQrImageSrc(sessionShareLink), [sessionShareLink]);

  const setPendingMarkState = (nextPending: PendingMarkMap) => {
    pendingMarksRef.current = nextPending;
    setPendingMarks(nextPending);
  };

  const logRoomTransition = (source: "game" | "picker", nextRoom: RoomState | null) => {
    if (!nextRoom) return;
    const signature = [
      nextRoom.id,
      nextRoom.round_id,
      nextRoom.phase,
      nextRoom.call_countdown_seconds,
      nextRoom.called_numbers.length,
      nextRoom.my_cartellas.length,
      nextRoom.next_my_cartellas.length,
    ].join("|");
    const signatureRef = source === "game" ? lastRoomTransitionLogRef : lastPickerTransitionLogRef;
    if (signatureRef.current === signature) return;
    signatureRef.current = signature;
    console.info("[room-transition]", {
      source,
      room_id: nextRoom.id,
      round_id: nextRoom.round_id,
      phase: nextRoom.phase,
      call_countdown_seconds: nextRoom.call_countdown_seconds,
      called_count: nextRoom.called_numbers.length,
      my_cartellas: nextRoom.my_cartellas,
      next_my_cartellas: nextRoom.next_my_cartellas,
    });
  };

  const setRoomWithPendingMarks = (nextRoom: RoomState | null) => {
    if (nextRoom) {
      roomSyncReceivedAtRef.current = Date.now();
      logRoomTransition("game", nextRoom);
    }
    setRoom((previousRoom) => {
      const stabilizedRoom = stabilizeRoomMarks(previousRoom, nextRoom);
      return applyPendingMarksToRoom(stabilizedRoom, pendingMarksRef.current);
    });
  };

  const setPickerRoomWithSyncMeta = (nextRoom: RoomState | null) => {
    if (nextRoom) {
      pickerRoomSyncReceivedAtRef.current = Date.now();
      logRoomTransition("picker", nextRoom);
    }
    setPickerRoom((previousRoom) => stabilizePickerRoomState(previousRoom, nextRoom));
  };

  useEffect(() => {
    const queueKey = getPickerQueueKey(pickerRoom);
    if (!pickerRoom || !queueKey) {
      pickerQueueLockKeyRef.current = "";
      setLockedPickerPaidCartellas([]);
      setLockedPickerSimulatedCartellas([]);
      return;
    }
    const incomingPaid = pickerRoom.paid_cartellas ?? [];
    const incomingSimulated = pickerRoom.simulated_paid_cartellas ?? [];
    if (pickerQueueLockKeyRef.current !== queueKey) {
      pickerQueueLockKeyRef.current = queueKey;
      setLockedPickerPaidCartellas(mergeUniqueSortedNumbers(incomingPaid));
      setLockedPickerSimulatedCartellas(mergeUniqueSortedNumbers(incomingSimulated));
      return;
    }
    setLockedPickerPaidCartellas((previous) => stabilizeNumberList(incomingPaid, previous));
    setLockedPickerSimulatedCartellas((previous) => stabilizeNumberList(incomingSimulated, previous));
  }, [
    pickerRoom?.id,
    pickerRoom?.phase,
    pickerRoom?.active_queue,
    pickerRoom?.round_id,
    pickerRoom?.next_round_id,
    pickerRoom?.paid_cartellas,
    pickerRoom?.simulated_paid_cartellas,
  ]);

  useEffect(() => {
    latestRoomRef.current = room;
  }, [room]);

  useEffect(() => {
    latestCardsRef.current = cards;
  }, [cards]);

  useEffect(() => {
    latestServiceRef.current = service;
  }, [service]);

  useEffect(() => {
    if (!profile || !PUSHER_KEY) return;
    let cancelled = false;
    void ensurePusherScriptLoaded()
      .then(() => {
        if (cancelled || pusherClientRef.current || !window.Pusher) return;
        pusherClientRef.current = new window.Pusher(PUSHER_KEY, {
          cluster: PUSHER_CLUSTER,
          forceTLS: true,
        });
        setPusherReady(true);
      })
      .catch(() => {
        // Keep polling fallback when realtime transport is unavailable.
      });
    return () => {
      cancelled = true;
    };
  }, [profile?.phone_number]);

  useEffect(() => {
    if (!pusherReady || service !== "game" || !room?.id) return;
    const client = pusherClientRef.current;
    if (!client) return;
    const channelName = `room-${room.id}`;
    const channel = client.subscribe(channelName);
    let inFlight = false;
    const onRoomUpdated: PusherEventHandler = () => {
      if (inFlight) return;
      const now = Date.now();
      if (now - realtimeLastEventAtRef.current < REALTIME_SYNC_THROTTLE_MS) return;
      realtimeLastEventAtRef.current = now;
      inFlight = true;
      void syncRoom(room.id)
        .then((synced) => {
          const syncedCards = synced.cards ?? (synced.card ? [synced.card] : []);
          const previousCards = latestCardsRef.current;
          const previousRoom = latestRoomRef.current;
          const resolvedCards = resolveSyncedCards(synced.room, syncedCards, previousCards, previousRoom);
          const hasCurrentOwnership = (synced.room.my_cartellas?.length ?? 0) > 0;
          const emptySnapshot = !hasCurrentOwnership && resolvedCards.length === 0;
          if (emptySnapshot) {
            const stable = lastStableGameSnapshotRef.current;
            const preserveStablePlayingSnapshot =
              !!stable &&
              stable.room.id === synced.room.id &&
              stable.room.round_id === synced.room.round_id &&
              (stable.room.phase === "playing" || stable.room.phase === "finished");
            if (preserveStablePlayingSnapshot) {
              return;
            }
          } else {
            emptyGameSyncPollCountRef.current = 0;
            lastStableGameSnapshotRef.current = { room: synced.room, cards: resolvedCards, at: Date.now() };
          }
          startTransition(() => {
            setRoomWithPendingMarks(synced.room);
            setCards(resolvedCards);
          });
          realtimeLastSyncAtRef.current = Date.now();
        })
        .catch(() => {
          // keep polling fallback
        })
        .finally(() => {
          inFlight = false;
        });
    };
    channel.bind("room.updated", onRoomUpdated);
    return () => {
      channel.unbind("room.updated", onRoomUpdated);
      client.unsubscribe(channelName);
    };
  }, [pusherReady, service, room?.id]);

  useEffect(() => {
    if (!pusherReady || !cartellaOpen || !selectedStake?.id) return;
    const client = pusherClientRef.current;
    if (!client) return;
    const channelRoomId = pickerRoom?.id ?? `room-${selectedStake.id}`;
    const channelName = `room-${channelRoomId}`;
    const channel = client.subscribe(channelName);
    let inFlight = false;
    const onRoomUpdated: PusherEventHandler = () => {
      if (inFlight) return;
      const now = Date.now();
      if (now - realtimeLastEventAtRef.current < REALTIME_SYNC_THROTTLE_MS) return;
      realtimeLastEventAtRef.current = now;
      inFlight = true;
      void fetchStakeRoom(selectedStake.id)
        .then((res) => {
          startTransition(() => {
            setPickerRoomWithSyncMeta(res.room);
          });
          realtimeLastSyncAtRef.current = Date.now();
        })
        .catch(() => {
          // keep polling fallback
        })
        .finally(() => {
          inFlight = false;
        });
    };
    channel.bind("room.updated", onRoomUpdated);
    return () => {
      channel.unbind("room.updated", onRoomUpdated);
      client.unsubscribe(channelName);
    };
  }, [pusherReady, cartellaOpen, selectedStake?.id, pickerRoom?.id]);

  useEffect(() => {
    return () => {
      pusherClientRef.current?.disconnect();
      pusherClientRef.current = null;
    };
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
    const onVisibilityChange = () => setIsPageVisible(document.visibilityState !== "hidden");
    document.addEventListener("visibilitychange", onVisibilityChange);
    return () => document.removeEventListener("visibilitychange", onVisibilityChange);
  }, []);

  useEffect(() => {
    try {
      const remembered =
        (window.localStorage.getItem(AUTH_REMEMBER_STORAGE_KEY) ??
          window.localStorage.getItem(LEGACY_AUTH_REMEMBER_STORAGE_KEY) ??
          window.localStorage.getItem(DEPRECATED_AUTH_REMEMBER_PASSWORD_STORAGE_KEY) ??
          window.localStorage.getItem(LEGACY_DEPRECATED_AUTH_REMEMBER_PASSWORD_STORAGE_KEY)) === "1";
      const savedPhone =
        window.localStorage.getItem(AUTH_PHONE_STORAGE_KEY) ??
        window.localStorage.getItem(LEGACY_AUTH_PHONE_STORAGE_KEY) ??
        "";
      setRememberPhone(remembered);
      if (savedPhone) setAuthPhone(savedPhone);
      window.localStorage.removeItem(DEPRECATED_AUTH_REMEMBER_PASSWORD_STORAGE_KEY);
      window.localStorage.removeItem(LEGACY_DEPRECATED_AUTH_REMEMBER_PASSWORD_STORAGE_KEY);
      window.localStorage.removeItem(DEPRECATED_AUTH_PASSWORD_STORAGE_KEY);
      window.localStorage.removeItem(LEGACY_DEPRECATED_AUTH_PASSWORD_STORAGE_KEY);
    } catch {
      // ignore storage errors
    }
  }, []);

  useEffect(() => {
    try {
      window.localStorage.setItem(AUTH_REMEMBER_STORAGE_KEY, rememberPhone ? "1" : "0");
      if (rememberPhone) {
        window.localStorage.setItem(AUTH_PHONE_STORAGE_KEY, authPhone);
      } else {
        window.localStorage.removeItem(AUTH_PHONE_STORAGE_KEY);
      }
      window.localStorage.removeItem(LEGACY_AUTH_REMEMBER_STORAGE_KEY);
      window.localStorage.removeItem(LEGACY_AUTH_PHONE_STORAGE_KEY);
      window.localStorage.removeItem(DEPRECATED_AUTH_REMEMBER_PASSWORD_STORAGE_KEY);
      window.localStorage.removeItem(LEGACY_DEPRECATED_AUTH_REMEMBER_PASSWORD_STORAGE_KEY);
      window.localStorage.removeItem(DEPRECATED_AUTH_PASSWORD_STORAGE_KEY);
      window.localStorage.removeItem(LEGACY_DEPRECATED_AUTH_PASSWORD_STORAGE_KEY);
    } catch {
      // ignore storage errors
    }
  }, [authPhone, rememberPhone]);

  useEffect(() => {
    if (!notice) return;
    const timer = window.setTimeout(() => setNotice(""), NOTICE_TIMEOUT_MS);
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
      setService("home");
      setDrawerOpen(false);
      setCartellaOpen(false);
      setDepositGuideOpen(false);
      setSelectedBet(null);
      setAuthNotice("");
      setAuthError("");
      setAuthPassword("");
      setAuthConfirmPassword("");
      setError("");
      setWalletFieldErrors({});
      setLoading(false);
      setWorking(false);
      setAdminWithdrawRequests([]);
      setAdminPayoutRefs({});
      setAdminDepositedRecords([]);
      setAdminDepositedSearch("");
      setAdminDepositedDayFilter("");
      setAdminClearDepositedBusy(false);
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
    if (service !== "stakes") return;
    const tick = () => setStakeCountdownNow(Date.now());
    tick();
    const timer = window.setInterval(tick, 1000);
    return () => window.clearInterval(timer);
  }, [service]);

  useEffect(() => {
    if (service !== "game" && !cartellaOpen) return;
    const tick = () => setLiveCountdownNow(Date.now());
    tick();
    const timer = window.setInterval(tick, LIVE_COUNTDOWN_TICK_MS);
    return () => window.clearInterval(timer);
  }, [service, cartellaOpen]);

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
    const onAdminTab = walletTab === "admin" && profile?.is_admin;
    setAdminDraftAccounts((prev) => {
      const next: Record<"telebirr" | "cbebirr", Array<{ phone_number: string; owner_name: string }>> = {
        telebirr: prev.telebirr,
        cbebirr: prev.cbebirr,
      };
      for (const code of ["telebirr", "cbebirr"] as const) {
        const keepLocalDraft = onAdminTab && adminDraftDirtyByMethod[code];
        if (keepLocalDraft) continue;
        const serverRows = dashboard.deposit_methods.find((method) => method.code === code)?.transfer_accounts.map((account) => ({ ...account }));
        if (serverRows) {
          next[code] = serverRows;
        }
      }
      return next;
    });
  }, [dashboard?.deposit_methods, walletTab, profile?.is_admin, adminDraftDirtyByMethod.telebirr, adminDraftDirtyByMethod.cbebirr]);

  useEffect(() => {
    if (service === "stakes") {
      void loadCartellaModalContent();
      return;
    }
    if (service === "wallet") {
      void loadDepositModalContent();
      return;
    }
    if (service === "history") {
      void loadBetHistoryModalContent();
    }
  }, [service]);

  async function openOwnedStakeGame(stake: StakeOption) {
    setSelectedStake(stake);
    setWorking(true);
    setError("");
    try {
      let res = await fetchStakeRoom(stake.id);
      let ownedCards = res.cards ?? (res.card ? [res.card] : []);
      const expectedLiveOrOwned =
        (stake.my_cards_current ?? 0) > 0 ||
        stake.open_available ||
        stake.room_phase === "playing";

      // Guard against stale snapshots during phase boundaries. Retry a few times
      // before deciding to render a finished view with no current ownership.
      for (let attempt = 1; attempt < OPEN_STALE_FINISHED_RETRIES; attempt += 1) {
        const likelyStaleFinished =
          expectedLiveOrOwned &&
          res.room.phase === "finished" &&
          (res.room.my_cartellas?.length ?? 0) === 0 &&
          ownedCards.length === 0;
        if (!likelyStaleFinished) break;
        try {
          res = await fetchStakeRoom(stake.id);
          ownedCards = res.cards ?? (res.card ? [res.card] : []);
        } catch {
          break;
        }
      }
      setPickerRoomWithSyncMeta(res.room);
      setRoomWithPendingMarks(res.room);
      setCards(ownedCards);
      if (!ownedCards.length) {
        if ((res.room.next_my_cartellas?.length ?? 0) > 0) {
          setNotice("You have cartella booked for the next game. Wait for this round to finish.");
          setService("game");
        } else {
          setNotice("No active bought cartella for this live game.");
        }
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
  }

  async function recoverCurrentGameView() {
    try {
      const dash = dashboard ?? (await fetchDashboard());
      if (!dashboard) {
        setDashboard(dash);
        setProfile(dash.user);
        if (dash.deposit_methods.length > 0) {
          setMethodCode((prev) => (dash.deposit_methods.some((method) => method.code === prev) ? prev : dash.deposit_methods[0].code));
        }
      }
      const ownedStakes = dash.stake_options.filter(
        (option) => (option.my_cards_current ?? 0) > 0 || (option.my_cards_next ?? 0) > 0,
      );
      const stake = ownedStakes.find((option) => option.room_phase !== "finished") ?? ownedStakes[0] ?? null;
      if (!stake) {
        setService("stakes");
        setNotice("Choose stake and buy cartella first.");
        setDrawerOpen(false);
        return;
      }
      setDrawerOpen(false);
      await openOwnedStakeGame(stake);
    } catch (err) {
      setService("stakes");
      setDrawerOpen(false);
      setError(err instanceof Error ? err.message : "Unable to open your active game");
    }
  }

  const openService = (next: ServiceView) => {
    if (!CASINO_ENABLED && (next === "casino" || next === "casino-launch")) {
      setService("home");
      setNotice("Casino games are temporarily unavailable while design is finalized.");
      setDrawerOpen(false);
      return;
    }
    if (next === "game" && !room) {
      void recoverCurrentGameView();
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
    setAdminWithdrawRequests((prev) => mergeWithdrawTicketsForward(prev, data.items));
    setAdminPayoutRefs((prev) => {
      const next = { ...prev };
      for (const item of data.items) {
        const normalizedStatus = normalizeWithdrawFlowStatus(item.status);
        const serverRef = item.payout_reference ?? "";
        if (normalizedStatus === "Paid" && serverRef) {
          next[item.id] = serverRef;
          continue;
        }
        if (!next[item.id]) {
          next[item.id] = serverRef;
        }
      }
      return next;
    });
  };

  const refreshAdminDepositedRecords = async () => {
    if (!profile?.is_admin) return;
    const data = await fetchAdminDepositedRecords();
    setAdminDepositedRecords(data.items);
  };

  const loadData = async () => {
    setLoading(true);
    setError("");
    try {
      const [dashResult, historyResult, betHistoryResult, casinoResult] = await Promise.allSettled([
        fetchDashboard(),
        fetchHistory().catch(() => null),
        safeFetchBetHistory().catch(() => null),
        fetchCasinoGames().catch(() => null),
      ]);
      startTransition(() => {
        if (dashResult.status === "fulfilled") {
          const dash = dashResult.value;
          setDashboard(dash);
          setProfile(dash.user);
          if (dash.deposit_methods.length > 0) {
            setMethodCode((prev) => (dash.deposit_methods.some((method) => method.code === prev) ? prev : dash.deposit_methods[0].code));
          }
        }

        if (historyResult.status === "fulfilled" && historyResult.value) {
          setHistory(historyResult.value.items);
        }

        if (betHistoryResult.status === "fulfilled" && betHistoryResult.value) {
          setBetHistory(betHistoryResult.value.items);
        }

        if (casinoResult.status === "fulfilled" && casinoResult.value) {
          const casino = casinoResult.value;
          const items = casino.items.length > 0 ? casino.items : fallbackCasinoGames;
          setCasinoGames(items);
          setCasinoCatalogNotice(casino.items.length > 0 ? "" : "Showing cached casino lineup.");
        } else {
          setCasinoGames(fallbackCasinoGames);
          setCasinoCatalogNotice("Showing cached casino lineup.");
        }
      });
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
    setAuthNotice("");
    setAuthError("");
    setAuthName("");
    setAuthConfirmPassword("");
    setAuthPhone(normalizedPhone);
    setAuthPassword("");
    setAuthMode("login");
    setDrawerOpen(false);
    setService("home");
    setLoading(true);
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
    setWalletFieldErrors({});
  }, [walletTab]);

  useEffect(() => {
    if (!profile?.is_admin || walletTab !== "admin" || !isPageVisible) return;
    let inFlight = false;
    const poll = () => {
      if (inFlight) return;
      inFlight = true;
      void (async () => {
        try {
          await Promise.all([refreshAdminWithdrawRequests(), refreshAdminDepositedRecords()]);
        } finally {
          inFlight = false;
        }
      })();
    };
    poll();
    const timer = window.setInterval(poll, 4000);
    return () => window.clearInterval(timer);
  }, [profile?.is_admin, walletTab, isPageVisible]);

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
      if (showBrandModal) {
        onCloseBrandModal();
      } else if (shareQrOpen) {
        setShareQrOpen(false);
        setShareQrImageError(false);
      } else if (selectedBet) {
        setSelectedBet(null);
      } else if (depositGuideOpen) {
        setDepositGuideOpen(false);
      } else if (cartellaOpen) {
        setCartellaStep("pick");
        setCartellaOpen(false);
      } else if (drawerOpen) {
        setDrawerOpen(false);
      } else if (service === "game") {
        // Never switch service from popstate while caller is open.
        // Game -> Rooms transition must only happen through explicit app flow (finished round redirect).
      } else if (service !== "home") {
        setService("home");
      }
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
  }, [profile?.phone_number, showBrandModal, shareQrOpen, selectedBet, depositGuideOpen, cartellaOpen, drawerOpen, service, canResumeLiveGame, room?.phase]);

  useEffect(() => {
    if (!profile || !isPageVisible) return;
    if (cartellaOpen || service === "game") return;
    let inFlight = false;
    const pollIntervalMs = service === "stakes" ? 2200 : 3600;
    const pollDashboard = () => {
      if (inFlight) return;
      inFlight = true;
      void (async () => {
        try {
          const dash = await fetchDashboard();
          startTransition(() => {
            setDashboard(dash);
            setProfile(dash.user);
          });
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
  }, [profile?.phone_number, service, cartellaOpen, isPageVisible]);

  useEffect(() => {
    if (!room?.id || service !== "game" || !isPageVisible) return;
    emptyGameSyncPollCountRef.current = 0;
    if (latestRoomRef.current && latestCardsRef.current.length > 0) {
      lastStableGameSnapshotRef.current = {
        room: latestRoomRef.current,
        cards: latestCardsRef.current,
        at: Date.now(),
      };
    }
    let inFlight = false;
    const pollRoom = () => {
      if (inFlight) return;
      if (pusherReady) {
        const msSinceRealtimeSync = Date.now() - realtimeLastSyncAtRef.current;
        if (msSinceRealtimeSync < REALTIME_PUSH_STALE_MS) {
          return;
        }
      }
      inFlight = true;
      void (async () => {
        try {
          const synced = await syncRoom(room.id);
          const syncedCards = synced.cards ?? (synced.card ? [synced.card] : []);
          const previousCards = latestCardsRef.current;
          const previousRoom = latestRoomRef.current;
          const resolvedCards = resolveSyncedCards(synced.room, syncedCards, previousCards, previousRoom);
          const hasCurrentOwnership = (synced.room.my_cartellas?.length ?? 0) > 0;
          const emptySnapshot = !hasCurrentOwnership && resolvedCards.length === 0;
          if (emptySnapshot) {
            emptyGameSyncPollCountRef.current += 1;
            const stable = lastStableGameSnapshotRef.current;
            const preserveStablePlayingSnapshot =
              !!stable &&
              stable.room.id === synced.room.id &&
              stable.room.round_id === synced.room.round_id &&
              (stable.room.phase === "playing" || stable.room.phase === "finished");
            if (preserveStablePlayingSnapshot) {
              return;
            }
            const withinGraceWindow =
              !!stable &&
              stable.room.id === synced.room.id &&
              Date.now() - stable.at <= ROOM_EMPTY_POLL_GRACE_MS &&
              emptyGameSyncPollCountRef.current < ROOM_EMPTY_POLL_GRACE_COUNT;
            if (withinGraceWindow) {
              return;
            }
          } else {
            emptyGameSyncPollCountRef.current = 0;
            lastStableGameSnapshotRef.current = { room: synced.room, cards: resolvedCards, at: Date.now() };
          }

          startTransition(() => {
            setRoomWithPendingMarks(synced.room);
            setCards(resolvedCards);
          });
          realtimeLastSyncAtRef.current = Date.now();
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
    }, REALTIME_FALLBACK_POLL_MS);
    return () => window.clearInterval(timer);
  }, [room?.id, service, isPageVisible, pusherReady]);

  useEffect(() => {
    if (!cards.length) {
      setSelectedCardNo(null);
      return;
    }
    setSelectedCardNo((prev) => {
      if (prev && cards.some((item) => item.card_no === prev)) return prev;
      return cards[0].card_no;
    });
  }, [cards]);

  useEffect(() => {
    if (service === "game") {
      setSessionPanelExpanded(true);
      setNowPlayingExpanded(true);
    }
  }, [service, room?.id]);

  useEffect(() => {
    if (service !== "game") return;
    if (room?.phase === "playing" && !nowPlayingExpanded) {
      setNowPlayingExpanded(true);
    }
  }, [service, room?.phase, nowPlayingExpanded]);

  useEffect(() => {
    const nextRoundKey = room?.id && room?.round_id ? `${room.id}:${room.round_id}` : "";
    if (!nextRoundKey) {
      lastSeenRoundKeyRef.current = "";
      return;
    }
    if (lastSeenRoundKeyRef.current && lastSeenRoundKeyRef.current !== nextRoundKey) {
      setPendingMarkState({});
      setAutoClaimRequested(false);
      lastStableGameSnapshotRef.current = null;
    }
    lastSeenRoundKeyRef.current = nextRoundKey;
  }, [room?.id, room?.round_id]);

  useEffect(() => {
    if (!cartellaOpen || !selectedStake || !isPageVisible) return;
    let inFlight = false;
    const pollStakeRoom = () => {
      if (inFlight) return;
      inFlight = true;
      void (async () => {
        try {
          const res = await fetchStakeRoom(selectedStake.id);
          startTransition(() => {
            setPickerRoomWithSyncMeta(res.room);
            if (res.room.my_held_cartella && cartellaStep === "pick" && !selectedCartella) {
              setSelectedCartella(res.room.my_held_cartella);
            }
          });
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
    }, 1500);

    return () => window.clearInterval(timer);
  }, [cartellaOpen, selectedStake, cartellaStep, selectedCartella, isPageVisible]);

  useEffect(() => {
    if (!cartellaOpen || !selectedCartella || processingCartella === selectedCartella) return;
    if (selectedCartellaHeld || selectedCartellaOwned) return;
    setSelectedCartella(null);
    if (preview?.card_no === selectedCartella) {
      setPreview(null);
    }
    if (cartellaStep === "preview") {
      setCartellaStep("pick");
    }
    setNotice("That cartella was released. Choose it again or pick another available card.");
  }, [
    cartellaOpen,
    cartellaStep,
    preview?.card_no,
    processingCartella,
    selectedCartella,
    selectedCartellaHeld,
    selectedCartellaOwned,
  ]);

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
    const finishedRoomKey =
      service === "game" && room?.phase === "finished"
        ? `game:${room.id}`
        : cartellaOpen && pickerRoom?.phase === "finished"
          ? `picker:${pickerRoom.id}`
          : null;
    if (!finishedRoomKey) {
      lastFinishedRoomRef.current = null;
      return;
    }
    if (lastFinishedRoomRef.current === finishedRoomKey) return;
    lastFinishedRoomRef.current = finishedRoomKey;
    setNotice(
      service === "game"
        ? "Round finished. Results stay visible until the next game starts."
        : "Round finished. Next card selection opens shortly.",
    );
  }, [service, room?.phase, room?.id, pickerRoom?.phase, pickerRoom?.id, cartellaOpen]);

  useEffect(() => {
    const finishedRoundKey =
      service === "game" && room?.phase === "finished" && (room?.winners?.length ?? 0) > 0 && room?.id
        ? `${room.id}:${room.round_id}`
        : null;
    if (!finishedRoundKey) {
      lastFinishedRedirectRef.current = null;
      return;
    }
    if (lastFinishedRedirectRef.current === finishedRoundKey) return;
    lastFinishedRedirectRef.current = finishedRoundKey;
    setSessionPanelExpanded(true);
    setNowPlayingExpanded(true);
    setNotice("Round finished. Winners are shown below. Use Play again when you're ready.");
  }, [service, room?.phase, room?.id, room?.round_id, room?.winners]);

  useEffect(() => {
    if (!cardRechargeLabel) return;
    const timer = window.setTimeout(() => setCardRechargeLabel(""), CARD_RECHARGE_LABEL_TIMEOUT_MS);
    return () => window.clearTimeout(timer);
  }, [cardRechargeLabel]);

  useEffect(() => {
    if (!autoClaimRequested) return;
    if (hasPendingMarks || claimingBingo) return;
    const claimReady = room?.phase === "playing" && !!card ? hasBingo(card, room?.called_numbers ?? [], markedNumbers) : false;
    if (!claimReady || !room?.id) {
      setAutoClaimRequested(false);
      return;
    }
    void onClaimBingo();
  }, [autoClaimRequested, hasPendingMarks, claimingBingo, room, card, markedNumbers]);

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
      if (authPassword.trim().length < 6) {
        throw new Error("Password must be at least 6 characters.");
      }
      setAuthPhone(normalizedPhone);
      if (authMode === "signup") {
        const normalizedName = authName.trim().replace(/\s+/g, " ");
        if (normalizedName.length < 2) {
          throw new Error("Enter your full name to create an account.");
        }
        if (authConfirmPassword !== authPassword) {
          throw new Error("Passwords do not match.");
        }
        const res = await signupRequest({
          user_name: normalizedName,
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
      const duplicateSignupAttempt =
        authMode === "signup" &&
        (isApiRequestError(err)
          ? err.status === 409
          : normalizedMessage.includes("already registered") ||
            normalizedMessage.includes("already exists") ||
            normalizedMessage.includes("already in use"));
      if (duplicateSignupAttempt) {
        setAuthMode("login");
        setAuthNotice("This phone number already exists. Please log in.");
        setAuthError("");
        setAuthConfirmPassword("");
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
    // Reset ALL state
    setProfile(null);
    setDashboard(null);
    setHistory([]);
    setBetHistory([]);
    setSelectedBet(null);
    setRoom(null);
    setCards([]);
    setSelectedCardNo(null);
    setService("home");
    setDrawerOpen(false);
    setShowBrandModal(false);
    // Add missing resets
    setLoading(false);
    setWorking(false);
    setError("");
    setNotice("");
    setAuthNotice("");
    setAuthError("");
    setAuthMode("login");
    setAuthName("");
    setAuthPassword("");
    setAuthConfirmPassword("");
    setWalletFieldErrors({});
    if (!rememberPhone) {
      setAuthPhone("");
    }
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
      setPickerRoomWithSyncMeta(res.room);
      setRoomWithPendingMarks(res.room);
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

  async function reserveCartella(cartellaNo: number, showPreview = false) {
    if (!selectedStake) return;
    const alreadyReserved =
      pickerRoom?.my_held_cartella === cartellaNo ||
      pickerRoom?.my_cartellas.includes(cartellaNo) ||
      pickerRoom?.next_my_cartellas.includes(cartellaNo);
    const hasPreview = preview?.card_no === cartellaNo;

    if (alreadyReserved && hasPreview) {
      setSelectedCartella(cartellaNo);
      if (showPreview) {
        setCartellaStep("preview");
      }
      return;
    }

    setProcessingCartella(cartellaNo);
    setWorking(true);
    setError("");
    try {
      const preferredRoundId =
        pickerRoom?.active_queue === "next"
          ? pickerRoom?.next_round_id
          : pickerRoom?.round_id;
      const res = await previewCard(selectedStake.id, cartellaNo, preferredRoundId);
      setPickerRoomWithSyncMeta(res.room);
      setRoomWithPendingMarks(res.room);
      setSelectedCartella(cartellaNo);
      setPreview(res.card);
      if (showPreview) {
        setCartellaStep("preview");
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : "Unable to select cartella");
      if (selectedCartella === cartellaNo) {
        setSelectedCartella(null);
      }
    } finally {
      setProcessingCartella(null);
      setWorking(false);
    }
  }

  const onPreviewCartella = async () => {
    if (!selectedStake || !selectedCartella) {
      setError("Select cartella number first.");
      return;
    }
    await reserveCartella(selectedCartella, true);
  };

  const onConfirmCartella = async () => {
    if (!selectedStake || !selectedCartella) return;
    setProcessingCartella(selectedCartella);
    setWorking(true);
    setError("");
    try {
      const shouldPreflightReserve = !preview || preview.card_no !== selectedCartella;
      let candidateRoom = pickerRoom;
      if (shouldPreflightReserve) {
        const reserveRoundId =
          candidateRoom?.active_queue === "next"
            ? candidateRoom?.next_round_id
            : candidateRoom?.round_id ?? room?.round_id;
        const reserve = await previewCard(selectedStake.id, selectedCartella, reserveRoundId);
        setPickerRoomWithSyncMeta(reserve.room);
        setRoomWithPendingMarks(reserve.room);
        setPreview(reserve.card);
        candidateRoom = reserve.room;
      }

      const preferredRoundId =
        candidateRoom?.active_queue === "next"
          ? candidateRoom?.next_round_id
          : candidateRoom?.round_id ?? room?.round_id;
      let res;
      try {
        res = await joinStake(selectedStake.id, selectedCartella, preferredRoundId);
      } catch (err) {
        const message = err instanceof Error ? err.message.toLowerCase() : "";
        if (!message.includes("round changed")) {
          throw err;
        }
        const refreshed = await fetchStakeRoom(selectedStake.id);
        setPickerRoomWithSyncMeta(refreshed.room);
        setRoomWithPendingMarks(refreshed.room);
        const refreshedRoundId =
          refreshed.room.active_queue === "next"
            ? refreshed.room.next_round_id
            : refreshed.room.round_id;
        const reserve = await previewCard(selectedStake.id, selectedCartella, refreshedRoundId);
        setPickerRoomWithSyncMeta(reserve.room);
        setRoomWithPendingMarks(reserve.room);
        setPreview(reserve.card);
        const confirmedRoundId = reserve.room.active_queue === "next" ? reserve.room.next_round_id : reserve.room.round_id;
        res = await joinStake(selectedStake.id, selectedCartella, confirmedRoundId);
      }
      setDashboard((prev) => (prev ? { ...prev, wallet: res.wallet } : prev));
      setDashboard((prev) => {
        if (!prev || !selectedStake) return prev;
        const updatedOptions = (prev.stake_options ?? []).map((option) => {
          if (option.id !== selectedStake.id) return option;
          return deriveStakeUiFromRoom(option, res.room);
        });
        return { ...prev, stake_options: updatedOptions };
      });
      setPickerRoomWithSyncMeta(res.room);
      setRoomWithPendingMarks(res.room);
      const returnedCards = res.cards ?? (res.card ? [res.card] : []);
      const mergedCards =
        res.card && !returnedCards.some((item) => item.card_no === res.card.card_no)
          ? [...returnedCards, res.card]
          : returnedCards;
      const purchasedForCurrentQueue = res.queue !== "next";
      const purchasedCardNo = res.card?.card_no ?? selectedCartella;
      
      if (!res.card && !selectedCartella) {
        throw new Error("No card available for selection");
      }
      
      setCards(mergedCards);
      
      if (purchasedForCurrentQueue) {
        setSelectedCardNo(purchasedCardNo);
        setSelectedCartella(null);
      } else {
        setSelectedCartella(purchasedCardNo);
      }
      
      setNotice(
        purchasedForCurrentQueue
          ? res.room?.phase === "selecting"
            ? "Card purchased. Opening your board while the game countdown finishes."
            : res.message
          : "Card booked for next game. Your number is now marked in blue.",
      );
      void refreshHistory();
      
      unstable_batchedUpdates(() => {
        setCartellaStep("pick");
        setPreview(null);
        if (purchasedForCurrentQueue) {
          setCartellaOpen(false);
          setService("game");
        }
      });
    } catch (err) {
      setError(err instanceof Error ? err.message : "Unable to confirm cartella");
    } finally {
      setProcessingCartella(null);
      setWorking(false);
    }
  };

  const onToggleAutoMark = async () => {
    if (!room?.id) return;
    const nextEnabled = !Boolean(room.auto_mark_called_numbers);
    setAutoMarkUpdating(true);
    setError("");
    try {
      const res = await setAutoMarkPreference(room.id, nextEnabled);
      setRoomWithPendingMarks(res.room);
      setNotice(res.message);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Unable to update auto-mark setting");
    } finally {
      setAutoMarkUpdating(false);
    }
  };

  useEffect(() => {
    if (!sharedStakeId || !profile || !(dashboard?.stake_options?.length ?? 0) || sharedStakeOpeningRef.current) return;
    const linkedStake = dashboard?.stake_options.find((option) => option.id === sharedStakeId) ?? null;
    if (!linkedStake) {
      setSharedStakeId("");
      clearSharedStakeParamsFromLocation();
      setService("stakes");
      setNotice("That shared session is no longer available.");
      return;
    }
    sharedStakeOpeningRef.current = true;
    void (async () => {
      try {
        if ((linkedStake.my_cards_current ?? 0) > 0) {
          await openOwnedStakeGame(linkedStake);
        } else {
          await onOpenStake(linkedStake);
          setService("stakes");
          setNotice("Shared live session opened. Choose a cartella to join.");
        }
      } finally {
        sharedStakeOpeningRef.current = false;
        setSharedStakeId("");
        clearSharedStakeParamsFromLocation();
      }
    })();
  }, [dashboard?.stake_options, profile, sharedStakeId]);
  const clearWalletFieldError = (field: keyof WalletFieldErrorMap) => {
    setWalletFieldErrors((prev) => {
      if (!prev[field]) return prev;
      const next = { ...prev };
      delete next[field];
      return next;
    });
  };

  const validateDepositFields = (
    amount: number,
    transactionNumber: string,
    receiptText: string,
    method: DepositMethod | null,
  ): WalletFieldErrorMap => {
    const nextErrors: WalletFieldErrorMap = {};
    const hasReceiptLink = extractReceiptLinks(receiptText).length > 0;
    if (!amount || amount <= 0) {
      nextErrors.depositAmount = "Enter a valid deposit amount.";
    }
    if (!receiptText) {
      nextErrors.receiptMessage = "Paste the full receipt text so payment can be verified.";
    }
    if (transactionNumber.length < 3) {
      nextErrors.txNo = "Enter a valid transaction reference.";
    }
    if (method && receiptText && !hasReceiptLink && !hasAssignedRecipientInReceipt(receiptText, method.transfer_accounts)) {
      nextErrors.receiptMessage = "Receipt must include one of the approved transfer numbers or account names.";
    }
    return nextErrors;
  };

  const validateTransferFields = (amount: number, phone: string, otp: string): WalletFieldErrorMap => {
    const nextErrors: WalletFieldErrorMap = {};
    if (!isValidAuthPhoneInput(normalizeAuthPhoneInput(phone))) {
      nextErrors.transferPhone = "Use 09XXXXXXXX or +2519XXXXXXXX.";
    }
    if (!amount || amount <= 0) {
      nextErrors.transferAmount = "Enter a valid transfer amount.";
    }
    if (!/^\d{4,6}$/.test(otp.trim())) {
      nextErrors.transferOtp = "OTP must be 4 to 6 digits.";
    }
    return nextErrors;
  };

  const validateWithdrawFields = (amount: number, accountNumber: string, accountHolder: string): WalletFieldErrorMap => {
    const nextErrors: WalletFieldErrorMap = {};
    if (!amount || amount <= 0) {
      nextErrors.withdrawAmount = "Enter a valid withdraw amount.";
    }
    if (accountNumber.trim().length < 6) {
      nextErrors.withdrawAccountNumber = "Account number must be at least 6 characters.";
    }
    if (accountHolder.trim().length < 2) {
      nextErrors.withdrawAccountHolder = "Enter the account holder name.";
    }
    return nextErrors;
  };

  const onSaveDepositAccounts = async (methodCodeToSave: "telebirr" | "cbebirr") => {
    const draft = adminDraftAccounts[methodCodeToSave] ?? [];
    const partialRow = draft.find((row) => {
      const phone = row.phone_number.trim();
      const owner = row.owner_name.trim();
      return (phone.length > 0 && owner.length === 0) || (phone.length === 0 && owner.length > 0);
    });
    if (partialRow) {
      setError("Complete both phone number and account owner for every row before saving.");
      return;
    }

    const cleaned = draft
      .map((row) => ({
        phone_number: normalizeAuthPhoneInput(row.phone_number),
        owner_name: row.owner_name.trim(),
      }))
      .filter((row) => row.phone_number.length > 0 && row.owner_name.length > 0);
    if (!cleaned.length) {
      setError("Add at least one transfer account before saving.");
      return;
    }

    const invalidPhone = cleaned.find((row) => !isValidAuthPhoneInput(row.phone_number));
    if (invalidPhone) {
      setError(`Invalid phone number: ${invalidPhone.phone_number}. Use 09XXXXXXXX or +2519XXXXXXXX.`);
      return;
    }

    const seen = new Set<string>();
    for (const row of cleaned) {
      const normalized = normalizePhoneForMatch(row.phone_number);
      if (seen.has(normalized)) {
        setError("Duplicate transfer account phone numbers are not allowed.");
        return;
      }
      seen.add(normalized);
    }

    setAdminAccountsSavingByMethod((prev) => ({ ...prev, [methodCodeToSave]: true }));
    setError("");
    try {
      const res = await updateAdminDepositMethod(methodCodeToSave, {
        transfer_accounts: cleaned,
      });
      setDashboard((prev) => (prev ? { ...prev, deposit_methods: res.deposit_methods } : prev));
      setAdminDraftAccounts((prev) => ({
        ...prev,
        [methodCodeToSave]: res.method.transfer_accounts.map((account) => ({ ...account })),
      }));
      setAdminDraftDirtyByMethod((prev) => ({ ...prev, [methodCodeToSave]: false }));
      setNotice(res.message);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Unable to save deposit accounts");
    } finally {
      setAdminAccountsSavingByMethod((prev) => ({ ...prev, [methodCodeToSave]: false }));
    }
  };

  const clearAdminDepositedFilters = () => {
    setAdminDepositedSearch("");
    setAdminDepositedDayFilter("");
  };

  const onClearAdminDepositedRecords = async () => {
    const targetDay = adminDepositedDayFilter.trim();
    const scopeLabel = targetDay ? `for ${targetDay}` : "for all days";
    const confirmed = window.confirm(`Clear deposited records ${scopeLabel}? This cannot be undone.`);
    if (!confirmed) return;
    setAdminClearDepositedBusy(true);
    setError("");
    try {
      const res = await clearAdminDepositedRecords({
        confirm: true,
        day: targetDay || null,
      });
      setNotice(res.message);
      await refreshAdminDepositedRecords();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Unable to clear deposited records");
    } finally {
      setAdminClearDepositedBusy(false);
    }
  };

  const submitDepositForm = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    setError("");
    const amount = Number(depositAmount);
    const receiptText = receiptMessage.trim();
    const directTxNo = normalizeTransactionNumberInput(txNo);
    const inferredTxNo = extractTransactionNumber(receiptText);
    const transactionNumber = directTxNo || inferredTxNo;
    if (!selectedMethod) {
      setError("Choose a deposit method first.");
      return;
    }
    const validationErrors = validateDepositFields(amount, transactionNumber, receiptText, selectedMethod);
    if (Object.keys(validationErrors).length > 0) {
      setWalletFieldErrors((prev) => ({
        ...prev,
        depositAmount: validationErrors.depositAmount,
        txNo: validationErrors.txNo,
        receiptMessage: validationErrors.receiptMessage,
      }));
      return;
    }
    setWalletFieldErrors((prev) => {
      const next = { ...prev };
      delete next.depositAmount;
      delete next.txNo;
      delete next.receiptMessage;
      return next;
    });
    setDepositSubmitting(true);
    try {
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
      await Promise.allSettled([
        refreshHistory(),
        (async () => {
          const dash = await fetchDashboard();
          startTransition(() => {
            setDashboard(dash);
            setProfile(dash.user);
          });
        })(),
      ]);
      setDepositGuideOpen(false);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Deposit request failed.");
    } finally {
      setDepositSubmitting(false);
    }
  };

  const submitTransferForm = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    setError("");
    const amount = Number(transferAmount);
    const validationErrors = validateTransferFields(amount, transferPhone, transferOtp);
    if (Object.keys(validationErrors).length > 0) {
      setWalletFieldErrors((prev) => ({
        ...prev,
        transferPhone: validationErrors.transferPhone,
        transferAmount: validationErrors.transferAmount,
        transferOtp: validationErrors.transferOtp,
      }));
      return;
    }
    setWalletFieldErrors((prev) => {
      const next = { ...prev };
      delete next.transferPhone;
      delete next.transferAmount;
      delete next.transferOtp;
      return next;
    });
    setWorking(true);
    try {
      const normalizedPhone = normalizeAuthPhoneInput(transferPhone);
      const res = await submitTransfer({
        phone_number: normalizedPhone,
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
      setError(err instanceof Error ? err.message : "Transfer failed.");
    } finally {
      setWorking(false);
    }
  };

  const submitWithdrawForm = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    setError("");
    const amount = Number(withdrawAmount);
    const validationErrors = validateWithdrawFields(amount, withdrawAccountNumber, withdrawAccountHolder);
    if (Object.keys(validationErrors).length > 0) {
      setWalletFieldErrors((prev) => ({
        ...prev,
        withdrawAmount: validationErrors.withdrawAmount,
        withdrawAccountNumber: validationErrors.withdrawAccountNumber,
        withdrawAccountHolder: validationErrors.withdrawAccountHolder,
      }));
      return;
    }
    setWalletFieldErrors((prev) => {
      const next = { ...prev };
      delete next.withdrawAmount;
      delete next.withdrawAccountNumber;
      delete next.withdrawAccountHolder;
      return next;
    });
    setWorking(true);
    try {
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
      setError(err instanceof Error ? err.message : "Withdraw request failed.");
    } finally {
      setWorking(false);
    }
  };

  const onCloseBrandModal = () => {
    window.localStorage.setItem(BRAND_MODAL_STORAGE_KEY, String(Date.now()));
    window.localStorage.removeItem(LEGACY_BRAND_MODAL_STORAGE_KEY);
    setShowBrandModal(false);
  };

  const closeTopOverlay = () => {
    if (showBrandModal) {
      onCloseBrandModal();
      return;
    }
    if (shareQrOpen) {
      setShareQrOpen(false);
      setShareQrImageError(false);
      return;
    }
    if (selectedBet) {
      setSelectedBet(null);
      return;
    }
    if (depositGuideOpen) {
      setDepositGuideOpen(false);
      return;
    }
    if (cartellaOpen) {
      setCartellaStep("pick");
      setCartellaOpen(false);
      return;
    }
    if (drawerOpen) {
      setDrawerOpen(false);
    }
  };

  useEffect(() => {
    if (!overlayOpen) return;
    const previousOverflow = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    return () => {
      document.body.style.overflow = previousOverflow;
    };
  }, [overlayOpen]);

  useEffect(() => {
    if (!overlayOpen) return;
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key !== "Escape") return;
      event.preventDefault();
      closeTopOverlay();
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [overlayOpen, showBrandModal, shareQrOpen, selectedBet, depositGuideOpen, cartellaOpen, drawerOpen]);

  useEffect(() => {
    if (overlayOpen && !overlayWasOpenRef.current) {
      overlayReturnFocusRef.current = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    }
    if (!overlayOpen && overlayWasOpenRef.current) {
      try {
        overlayReturnFocusRef.current?.focus();
      } catch {
        // ignore focus restore errors
      }
      overlayReturnFocusRef.current = null;
    }
    overlayWasOpenRef.current = overlayOpen;
  }, [overlayOpen]);

  useEffect(() => {
    if (!overlayOpen) return;
    const target =
      (showBrandModal
        ? brandDialogRef.current
        : shareQrOpen
          ? shareDialogRef.current
        : selectedBet
          ? betDialogRef.current
          : depositGuideOpen
            ? depositDialogRef.current
            : cartellaOpen
              ? cartellaDialogRef.current
              : drawerOpen
                ? drawerDialogRef.current
                : null) ?? null;
    if (!target) return;
    const frameId = window.requestAnimationFrame(() => {
      try {
        target.focus();
      } catch {
        // ignore focus errors
      }
    });
    return () => window.cancelAnimationFrame(frameId);
  }, [overlayOpen, showBrandModal, shareQrOpen, selectedBet?.id, depositGuideOpen, cartellaOpen, drawerOpen]);

  useEffect(() => {
    const showResultOverlay =
      room?.phase === "finished" &&
      (room?.winners?.length ?? 0) > 0 &&
      (room?.next_my_cartellas?.length ?? 0) === 0;
    if (service !== "game" || !room || !card || showResultOverlay) return;

    let frameId = 0;
    const updateToggleTop = () => {
      frameId = 0;
      const headerBottom = topHeaderRef.current?.getBoundingClientRect().bottom ?? 0;
      const sessionBottom = gameSessionPanelRef.current?.getBoundingClientRect().bottom ?? 0;
      const anchorBottom = Math.max(headerBottom, sessionBottom > headerBottom ? sessionBottom : 0);
      const nextTop = Math.max(12, Math.round(anchorBottom + 10));
      setNowPlayingToggleTop((prev) => (prev === nextTop ? prev : nextTop));
    };

    const scheduleUpdate = () => {
      if (frameId) window.cancelAnimationFrame(frameId);
      frameId = window.requestAnimationFrame(updateToggleTop);
    };

    const resizeObserver = typeof ResizeObserver !== "undefined" ? new ResizeObserver(scheduleUpdate) : null;
    if (topHeaderRef.current) resizeObserver?.observe(topHeaderRef.current);
    if (gameSessionPanelRef.current) resizeObserver?.observe(gameSessionPanelRef.current);

    scheduleUpdate();
    window.addEventListener("resize", scheduleUpdate);
    window.addEventListener("scroll", scheduleUpdate, { passive: true });
    window.visualViewport?.addEventListener("resize", scheduleUpdate);
    window.visualViewport?.addEventListener("scroll", scheduleUpdate);

    return () => {
      if (frameId) window.cancelAnimationFrame(frameId);
      resizeObserver?.disconnect();
      window.removeEventListener("resize", scheduleUpdate);
      window.removeEventListener("scroll", scheduleUpdate);
      window.visualViewport?.removeEventListener("resize", scheduleUpdate);
      window.visualViewport?.removeEventListener("scroll", scheduleUpdate);
    };
  }, [service, room, card]);

  const onCopyPhone = async (phone: string) => {
    try {
      if (navigator.clipboard?.writeText) {
        await navigator.clipboard.writeText(phone);
      } else if (!fallbackCopyText(phone)) {
        throw new Error("Clipboard unavailable");
      }
      setCopiedPhone(phone);
      setNotice(`Copied ${phone}`);
      window.setTimeout(() => {
        setCopiedPhone((prev) => (prev === phone ? "" : prev));
      }, 1500);
    } catch {
      if (fallbackCopyText(phone)) {
        setCopiedPhone(phone);
        setNotice(`Copied ${phone}`);
        window.setTimeout(() => {
          setCopiedPhone((prev) => (prev === phone ? "" : prev));
        }, 1500);
        return;
      }
      setError("Clipboard copy failed.");
    }
  };

  const closeSessionShareModal = () => {
    setShareQrOpen(false);
    setShareQrImageError(false);
  };

  const copySessionLinkToClipboard = async () => {
    if (!sessionShareLink) return false;
    try {
      if (navigator.clipboard?.writeText) {
        await navigator.clipboard.writeText(sessionShareLink);
        return true;
      }
      return fallbackCopyText(sessionShareLink);
    } catch {
      return fallbackCopyText(sessionShareLink);
    }
  };

  const onCopySessionLinkAgain = async () => {
    const copied = await copySessionLinkToClipboard();
    if (copied) {
      setError("");
      setNotice("Session link copied again.");
      return;
    }
    setError("Clipboard copy failed.");
  };

  const onShareSession = async () => {
    if (!sessionShareLink) {
      setError("No live session link is available right now.");
      return;
    }
    const copied = await copySessionLinkToClipboard();
    setShareQrImageError(false);
    setShareQrOpen(true);
    if (copied) {
      setError("");
      setNotice("Session link copied. QR is ready to scan.");
      return;
    }
    setError("QR opened, but copying the session link failed.");
  };

  const toggleMarked = async (value: number | string, cardNoParam?: number) => {
    if (typeof value !== "number") return;
    const roomId = room?.id;
    if (!roomId) return;
    let workingRoom = room;
    let targetCardNo = cardNoParam ?? selectedCardNo;
    if (!targetCardNo) return;

    const ensureLatestOwnership = async () => {
      const synced = await syncRoom(roomId);
      const syncedCards = synced.cards ?? (synced.card ? [synced.card] : []);
      const previousCards = latestCardsRef.current;
      const previousRoom = latestRoomRef.current;
      const resolvedCards = resolveSyncedCards(synced.room, syncedCards, previousCards, previousRoom);
      setRoomWithPendingMarks(synced.room);
      setCards(resolvedCards);
      realtimeLastSyncAtRef.current = Date.now();
      return synced.room;
    };

    if (!workingRoom.my_cartellas.includes(targetCardNo) || workingRoom.phase !== "playing" || !workingRoom.called_numbers.includes(value)) {
      try {
        workingRoom = await ensureLatestOwnership();
      } catch {
        // fall through with local snapshot
      }
      targetCardNo = cardNoParam ?? selectedCardNo ?? targetCardNo;
    }

    if (!workingRoom.my_cartellas.includes(targetCardNo)) {
      const fallbackOwned = workingRoom.my_cartellas[0];
      if (fallbackOwned) {
        setSelectedCardNo(fallbackOwned);
        setNotice("Your active card changed in live sync. Switched to your owned card.");
      } else {
        setNotice("No owned card is available in this live round.");
      }
      return;
    }
    if (workingRoom.phase !== "playing") return;
    if (!workingRoom.called_numbers.includes(value)) return;
    const requestKey = buildMarkRequestKey(targetCardNo, value);
    if (pendingMarksRef.current[requestKey] !== undefined) return;

    const currentMarks = targetCardNo === selectedCardNo ? markedNumbers : marksForCard(workingRoom, targetCardNo);
    const isAlreadyMarked = currentMarks.includes(value);
    if (isAlreadyMarked) {
      if (workingRoom.auto_mark_called_numbers) {
        setNotice("Called numbers are auto-marked for this room.");
      }
      return;
    }
    const nextMarked = true;
    setSelectedCardNo(targetCardNo);
    setPendingMarkState({ ...pendingMarksRef.current, [requestKey]: nextMarked });
    setRoom((prev) => applyMarkMutationToRoom(prev, targetCardNo, value, nextMarked));
    setError("");

    try {
      const res = await markNumberForCard(roomId, value, nextMarked, targetCardNo);
      const { [requestKey]: _ignored, ...remainingPending } = pendingMarksRef.current;
      setPendingMarkState(remainingPending);
      setRoomWithPendingMarks(res.room);
    } catch (err) {
      const { [requestKey]: _ignored, ...remainingPending } = pendingMarksRef.current;
      setPendingMarkState(remainingPending);
      setRoom((prev) => applyMarkMutationToRoom(prev, targetCardNo, value, !nextMarked));
      const errorMessage = err instanceof Error ? err.message : "Unable to update mark";
      try {
        const synced = await syncRoom(roomId);
        const syncedCards = synced.cards ?? (synced.card ? [synced.card] : []);
        const previousCards = latestCardsRef.current;
        const previousRoom = latestRoomRef.current;
        const resolvedCards = resolveSyncedCards(synced.room, syncedCards, previousCards, previousRoom);
        setRoomWithPendingMarks(synced.room);
        setCards(resolvedCards);
        if ((synced.room.my_cartellas?.length ?? 0) > 0 && !synced.room.my_cartellas.includes(targetCardNo)) {
          setSelectedCardNo(synced.room.my_cartellas[0]);
        }
        realtimeLastSyncAtRef.current = Date.now();
      } catch {
        // keep optimistic rollback when sync fails
      }
      if (/do not own this card/i.test(errorMessage)) {
        setError("");
        setNotice("Live room re-synced. Your active card ownership was updated.");
      } else {
        setError(errorMessage);
      }
    }
  };

  const onCopyAccountNumber = async (accountNumber: string) => {
    const value = accountNumber.trim();
    if (!value) return;
    try {
      if (navigator.clipboard?.writeText) {
        await navigator.clipboard.writeText(value);
      } else if (!fallbackCopyText(value)) {
        throw new Error("Clipboard unavailable");
      }
      setCopiedAccountNumber(value);
      setNotice(`Copied account number ${value}`);
      window.setTimeout(() => {
        setCopiedAccountNumber((prev) => (prev === value ? "" : prev));
      }, 1500);
    } catch {
      try {
        if (fallbackCopyText(value)) {
          setCopiedAccountNumber(value);
          setNotice(`Copied account number ${value}`);
          window.setTimeout(() => {
            setCopiedAccountNumber((prev) => (prev === value ? "" : prev));
          }, 1500);
          return;
        }
      } catch {
        // fall through
      }
      setError("Clipboard copy failed.");
    }
  };

  const onClaimBingo = async () => {
    if (!room?.id) return;
    if (!bingoClaimable) {
      if (hasPendingMarks) {
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
      setRoomWithPendingMarks(res.room);
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
          setAuthConfirmPassword("");
        }}
        name={authName}
        setName={setAuthName}
        phone={authPhone}
        setPhone={setAuthPhone}
        password={authPassword}
        setPassword={setAuthPassword}
        confirmPassword={authConfirmPassword}
        setConfirmPassword={setAuthConfirmPassword}
        busy={authBusy}
        notice={authNotice}
        error={authError}
        rememberPhone={rememberPhone}
        setRememberPhone={setRememberPhone}
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

  const getAuthoritativePhaseCountdown = (state: RoomState | null, syncedAtMs: number) => {
    if (!state) return 0;
    const elapsedSinceSyncMs = Math.max(0, liveCountdownNow - syncedAtMs);

    if (state.phase === "playing") {
      const fallback = Math.max(0, state.call_countdown_seconds);
      if (typeof state.server_time_ms === "number" && typeof state.next_call_at_ms === "number") {
        const virtualServerNowMs = state.server_time_ms + elapsedSinceSyncMs;
        return Math.max(0, Math.ceil((state.next_call_at_ms - virtualServerNowMs) / 1000));
      }
      return Math.max(0, Math.ceil(Math.max(0, fallback * 1000 - elapsedSinceSyncMs) / 1000));
    }

    if (state.phase === "selecting") {
      const fallback = Math.max(0, state.countdown_seconds ?? 0);
      return Math.max(0, Math.ceil(Math.max(0, fallback * 1000 - elapsedSinceSyncMs) / 1000));
    }

    const fallback = Math.max(0, state.announcement_seconds ?? 0);
    return Math.max(0, Math.ceil(Math.max(0, fallback * 1000 - elapsedSinceSyncMs) / 1000));
  };

  const bingoClaimable = room?.phase === "playing" && !!card ? hasBingo(card, room?.called_numbers ?? [], markedNumbers) : false;
  const liveCallCountdown = room?.phase === "playing" ? getAuthoritativePhaseCountdown(room, roomSyncReceivedAtRef.current) : 0;
  const gameCountdownValue = getAuthoritativePhaseCountdown(room, roomSyncReceivedAtRef.current);
  const gameCountdownLabel = `0:${String(Math.max(0, gameCountdownValue)).padStart(2, "0")}`;
  const gameStatusLabel =
    room?.phase === "selecting"
      ? "Game Starting"
      : room?.phase === "playing"
        ? room.claim_window_seconds > 0
          ? `Checking winners ${room.claim_window_seconds}s`
          : `Next call in ${Math.max(0, liveCallCountdown)}s`
        : room?.announcement_seconds
          ? `Next game in ${room.announcement_seconds}s`
          : "Round Complete";
  const pickerLiveCallCountdown =
    pickerRoom?.phase === "playing" ? getAuthoritativePhaseCountdown(pickerRoom, pickerRoomSyncReceivedAtRef.current) : 0;
  const currentPaidCount = room?.current_paid_count ?? room?.display_paid_count ?? room?.paid_cartellas.length ?? 0;
  const currentTotalSales = room ? room.current_total_sales ?? currentPaidCount * room.card_price : 0;
  const currentHouseCommission = room ? room.current_house_commission ?? currentTotalSales * 0.15 : 0;
  const realWinnerPool = room ? room.current_distributable ?? Math.max(0, currentTotalSales - currentHouseCommission) : 0;
  const winnerEntries = room?.winners ?? [];
  const myWinnerEntry = winnerEntries.find((entry) => entry.phone_number === profile.phone_number) ?? null;
  const resultAmount = myWinnerEntry?.payout ?? winnerEntries[0]?.payout ?? 0;
  const showResultOverlay =
    room?.phase === "finished" &&
    winnerEntries.length > 0 &&
    (room?.next_my_cartellas?.length ?? 0) === 0;
  const sessionPanelId = room ? `game-session-panel-${room.id}` : "game-session-panel";
  const nowPlayingPanelId = room ? `now-playing-panel-${room.id}` : "now-playing-panel";
  const callerLockedOpen =
    service === "game" &&
    !!room &&
    (room.phase === "playing" || (room.phase === "selecting" && (room.called_numbers?.length ?? 0) > 0));
  const effectiveNowPlayingExpanded = callerLockedOpen ? true : nowPlayingExpanded;
  const nowPlayingCardLabel = selectedCardNo ? `Card ${selectedCardNo}` : `${cards.length} ${cards.length === 1 ? "Card" : "Cards"}`;
  const pickerCountdownValue = getAuthoritativePhaseCountdown(pickerRoom, pickerRoomSyncReceivedAtRef.current);
  const pickerPaidCount = pickerRoom?.display_paid_count ?? pickerRoom?.paid_cartellas.length ?? 0;
  const lockedPickerPaidCount = Math.max(pickerPaidCount, lockedPickerPaidCartellas.length);
  const pickerPhase = pickerRoom?.phase ?? "selecting";
  const pickerLiveDetail =
    pickerRoom?.active_queue === "next"
      ? "Holding open for next game"
      : pickerRoom?.phase === "selecting"
        ? `Game starts in ${Math.max(0, pickerCountdownValue)}s`
      : pickerRoom?.phase === "playing"
        ? "Live calls in progress"
          : `Next game opens in ${Math.max(0, pickerCountdownValue)}s`;
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
        <div className="player-card-head">
          <h3>Your Card No. {ownedCard.card_no}</h3>
          <button
            className={`player-card-select ${isActive ? "active" : ""}`}
            type="button"
            aria-pressed={isActive}
            onClick={() => setSelectedCardNo(ownedCard.card_no)}
          >
            {isActive ? "Active Card" : "View Card"}
          </button>
        </div>
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
            const markPending = typeof value === "number" && pendingMarks[buildMarkRequestKey(ownedCard.card_no, value)] !== undefined;
            return (
              <button
                key={`${rail}-${ownedCard.card_no}-${value}-${idx}`}
                type="button"
                className={`cell ${value === "FREE" ? "free" : ""} ${clickable ? "clickable" : ""} ${marked ? "marked" : ""} ${markPending ? "marking" : ""}`}
                onClick={() => {
                  setSelectedCardNo(ownedCard.card_no);
                  void toggleMarked(value, ownedCard.card_no);
                }}
                disabled={typeof value !== "number" || !clickable || marked || markPending || room?.phase !== "playing"}
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
  const selectedMethodAdminSaving = selectedMethod ? adminAccountsSavingByMethod[selectedMethod.code] ?? false : false;
  const filteredAdminDepositedRecords = useMemo(() => {
    const query = adminDepositedSearch.trim().toLowerCase();
    const dayFilter = adminDepositedDayFilter.trim();
    return adminDepositedRecords.filter((item) => {
      if (dayFilter && !item.created_at.startsWith(dayFilter)) {
        return false;
      }
      if (!query) return true;
      const methodLabel = item.method ?? "";
      const transactionNumber = item.transaction_number ?? "";
      const note = item.note ?? "";
      return (
        item.phone_number.toLowerCase().includes(query) ||
        methodLabel.toLowerCase().includes(query) ||
        transactionNumber.toLowerCase().includes(query) ||
        note.toLowerCase().includes(query)
      );
    });
  }, [adminDepositedRecords, adminDepositedSearch, adminDepositedDayFilter]);
  const filteredAdminDepositedTotal = useMemo(
    () => filteredAdminDepositedRecords.reduce((sum, item) => sum + (Number.isFinite(item.amount) ? item.amount : 0), 0),
    [filteredAdminDepositedRecords],
  );
  const updateAdminDraftRows = (
    code: "telebirr" | "cbebirr",
    updater: (rows: Array<{ phone_number: string; owner_name: string }>) => Array<{ phone_number: string; owner_name: string }>,
  ) => {
    setAdminDraftAccounts((prev) => ({
      ...prev,
      [code]: updater(prev[code] ?? []),
    }));
    setAdminDraftDirtyByMethod((prev) => ({ ...prev, [code]: true }));
  };
  const onDraftPhoneChange = (idx: number, value: string) => {
    if (!selectedMethod) return;
    updateAdminDraftRows(selectedMethod.code, (rows) =>
      rows.map((item, rowIdx) => (rowIdx === idx ? { ...item, phone_number: value } : item)),
    );
  };
  const onDraftOwnerChange = (idx: number, value: string) => {
    if (!selectedMethod) return;
    updateAdminDraftRows(selectedMethod.code, (rows) =>
      rows.map((item, rowIdx) => (rowIdx === idx ? { ...item, owner_name: value } : item)),
    );
  };
  const onRemoveDraftAccount = (idx: number) => {
    if (!selectedMethod) return;
    updateAdminDraftRows(selectedMethod.code, (rows) => rows.filter((_, rowIdx) => rowIdx !== idx));
  };
  const onAddDraftAccount = () => {
    if (!selectedMethod) return;
    updateAdminDraftRows(selectedMethod.code, (rows) => [...rows, { phone_number: "", owner_name: "" }]);
  };
  const onDepositTxChange = (rawValue: string) => {
    clearWalletFieldError("txNo");
    const extracted = extractTransactionNumber(rawValue);
    if (/\s/.test(rawValue) && extracted) {
      setTxNo(extracted);
      if (!receiptMessage.trim()) {
        clearWalletFieldError("receiptMessage");
        setReceiptMessage(rawValue.trim());
      }
      return;
    }
    setTxNo(rawValue);
  };
  const onDepositReceiptChange = (nextMessage: string) => {
    clearWalletFieldError("receiptMessage");
    setReceiptMessage(nextMessage);
    const extracted = extractTransactionNumber(nextMessage);
    if (!extracted) return;
    clearWalletFieldError("txNo");
    setTxNo((current) => {
      const currentNormalized = normalizeTransactionNumberInput(current);
      if (currentNormalized && currentNormalized !== extracted) return current;
      return extracted;
    });
  };

  return (
    <div className={`fortybingo-app ${isCasinoLaunchView ? "casino-launch-active" : ""} ${drawerOpen ? "drawer-open" : ""}`}>
      {!isCasinoLaunchView && (
        <>
          <div className={`drawer-overlay ${drawerOpen ? "show" : ""}`} onClick={() => setDrawerOpen(false)} />
          <aside
            ref={drawerDialogRef}
            id="app-side-drawer"
            className={`side-drawer ${drawerOpen ? "open" : ""}`}
            role="dialog"
            aria-modal="true"
            aria-label="Navigation menu"
            tabIndex={-1}
          >
            <div className="drawer-profile">
              <div className="avatar">{profileInitials}</div>
              <div className="drawer-profile-meta">
                <h3>{profile.user_name}</h3>
                <p>{profile.phone_number}</p>
              </div>
              <button className="drawer-close" type="button" onClick={() => setDrawerOpen(false)} aria-label="Close menu">
                &times;
              </button>
            </div>
            <nav>
              {services
                .filter((item) => drawerMenuViews.includes(item.view))
                .map((item) => (
                <button
                  key={item.view}
                  className={`menu-item ${service === item.view ? "active" : ""}`}
                  type="button"
                  onClick={() => openService(item.view)}
                >
                  {item.label}
                </button>
              ))}
              <button
                className="menu-item"
                type="button"
                onClick={() => {
                  setShowBrandModal(true);
                  setDrawerOpen(false);
                }}
              >
                What's New
              </button>
              <button className="menu-item danger logout-item" type="button" onClick={() => void onLogout()}>
                Logout
              </button>
            </nav>
          </aside>

          <header ref={topHeaderRef} className="top-header">
            <div className="top-strip">
              <button
                className="brand-inline brand-menu-trigger"
                type="button"
                aria-expanded={drawerOpen}
                aria-controls="app-side-drawer"
                onClick={() => setDrawerOpen((state) => !state)}
              >
                <img src="/brand/40bingo-logo.svg" alt="40bingo logo" className="brand-inline-logo" />
                <span className="brand-inline-text">40bingo</span>
              </button>
              <div className="top-strip-actions">
                <button
                  className={`theme-toggle ${isDarkMode ? "on" : "off"}`}
                  type="button"
                  aria-label={isDarkMode ? "Switch to light mode" : "Switch to dark mode"}
                  onClick={() => setIsDarkMode((current) => !current)}
                >
                  <span className="theme-toggle-track" aria-hidden="true">
                    <span className="theme-toggle-thumb" />
                  </span>
                  <span className="theme-toggle-label">{isDarkMode ? "Dark" : "Light"}</span>
                </button>
                <button className="refresh-btn" type="button" aria-label="Refresh dashboard data" onClick={() => void loadData()}>
                  <span className="refresh-btn-text">Refresh</span>
                </button>
                <div className="wallet-pill">
                  <span className="wallet-pill-label">Balance</span>
                  <span className="wallet-pill-value">{fmtEtb(wallet.main_balance)}</span>
                </div>
              </div>
            </div>
          </header>
        </>
      )}

      <main className={`main-content ${isCasinoLaunchView ? "casino-launch-main" : ""}`}>
        {!isCasinoLaunchView && (
          <ToastRail
            loading={loading}
            notice={notice}
            error={error}
            onDismissNotice={() => setNotice("")}
            onDismissError={() => setError("")}
          />
        )}

        {!isCasinoLaunchView && canResumeLiveGame && service !== "game" && (
          <div className="quick-action-bar fade-up">
            <div className="quick-action-copy">
              <strong>Live room still active</strong>
              <span>Return to your current card without reopening every screen.</span>
            </div>
            <button className="primary-btn" type="button" onClick={() => openService("game")}>
              Resume Live
            </button>
          </div>
        )}

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
                  <h3>Live</h3>
                </div>
                <p>Follow called numbers in real time and mark your purchased cards during active play.</p>
                <button className="primary-btn" type="button" onClick={() => openService("game")}>
                  Open Live
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
                const canOpen = Boolean(stake.open_available) || (isPlaying && (stake.my_cards_current ?? 0) > 0);
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
                      onClick={() => void (canOpen ? openOwnedStakeGame(stake) : onOpenStake(stake))}
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
            {!room ? (
              <div className="empty-state">
                <h3>No active room</h3>
                <p>Buy cartella first from Bingo Game service.</p>
              </div>
            ) : (
              <>
                {!showResultOverlay && (
                  <div className="game-live-shell">
                    <div
                      ref={gameSessionPanelRef}
                      id={sessionPanelId}
                      className={`game-session-panel ${sessionPanelExpanded ? "expanded" : "collapsed"}`}
                    >
                      <div className="game-session-toolbar">
                        <button
                          className="game-session-toggle"
                          type="button"
                          aria-expanded={sessionPanelExpanded}
                          aria-controls={`${sessionPanelId}-body`}
                          onClick={() => setSessionPanelExpanded((state) => !state)}
                        >
                          <span className="game-session-toggle-copy">
                            <small>Live Session</small>
                            <strong>{room.phase === "playing" ? "Round In Progress" : room.phase === "selecting" ? "Round Queue" : "Round Status"}</strong>
                            <span className="game-session-toggle-detail">{gameStatusLabel}</span>
                          </span>
                          <span className="game-session-summary-row" aria-hidden="true">
                            <span className="game-session-pill">Stake {room.card_price}</span>
                            <span className="game-session-pill">{room.called_numbers.length} Calls</span>
                            <span className="game-session-pill">{currentPaidCount} Bought</span>
                          </span>
                          <span className="game-session-toggle-icon" aria-hidden="true">
                            <svg viewBox="0 0 20 20" focusable="false">
                              <path d="M5.5 7.5 10 12l4.5-4.5" />
                            </svg>
                          </span>
                        </button>
                        <button
                          className="game-session-share-btn"
                          type="button"
                          aria-label="Copy session link and open QR"
                          disabled={!sessionShareLink}
                          onClick={() => void onShareSession()}
                        >
                          <svg viewBox="0 0 24 24" focusable="false" aria-hidden="true">
                            <path d="M12 16V4" />
                            <path d="m7 9 5-5 5 5" />
                            <path d="M5 20h14" />
                          </svg>
                        </button>
                      </div>
                      {sessionPanelExpanded && (
                        <div id={`${sessionPanelId}-body`} className="game-session-body">
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
                            <button
                              type="button"
                              className="stat-box"
                              aria-label="Toggle auto mark"
                              onClick={() => void onToggleAutoMark()}
                              disabled={autoMarkUpdating || room.phase === "finished"}
                            >
                              <small>Auto Mark</small>
                              <strong>
                                {autoMarkUpdating
                                  ? "..."
                                  : room.auto_mark_called_numbers
                                    ? "On"
                                    : "Off"}
                              </strong>
                            </button>
                            <button type="button" className="stat-box stat-sound" aria-label="sound">
                              (( ))
                            </button>
                          </div>
                        </div>
                      )}
                    </div>
                    <button
                      className="now-playing-toggle"
                      type="button"
                      aria-expanded={effectiveNowPlayingExpanded}
                      aria-controls={nowPlayingPanelId}
                      aria-label={
                        callerLockedOpen
                          ? "Now playing is locked open during live calling"
                          : effectiveNowPlayingExpanded
                            ? "Collapse now playing"
                            : "Expand now playing"
                      }
                      onClick={() => {
                        if (callerLockedOpen) return;
                        setNowPlayingExpanded((state) => !state);
                      }}
                      style={{ top: `${nowPlayingToggleTop}px` }}
                    >
                      <span className="now-playing-toggle-copy">
                        <small>{callerLockedOpen ? "Live caller locked" : effectiveNowPlayingExpanded ? "Hide panel" : "Show panel"}</small>
                        <strong>Now Playing</strong>
                      </span>
                      <span className="now-playing-toggle-status">{nowPlayingCardLabel}</span>
                      <span className="now-playing-toggle-icon" aria-hidden="true">
                        <svg viewBox="0 0 20 20" focusable="false">
                          <path d="M5.5 7.5 10 12l4.5-4.5" />
                        </svg>
                      </span>
                    </button>
                    <div className={`caller-layout ${effectiveNowPlayingExpanded ? "now-playing-open" : "now-playing-collapsed"}`}>
                      {effectiveNowPlayingExpanded && (
                        <aside id={nowPlayingPanelId} className="caller-side-card now-playing-panel">
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
                      )}

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
                      <h3>ETB {Math.round(resultAmount)}</h3>
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
            <p className="panel-subtitle">
              Manage deposits, transfers, and withdrawals in one place. Withdraw approval alerts are sent through configured admin channels.
            </p>
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
                  Open Deposit Instructions
                </button>
                <div className="wallet-language-note" aria-label="Deposit instructions in Amharic">
                  <h4>የዴፖዚት መመሪያ</h4>
                  <ol>
                    {DEPOSIT_AMHARIC_STEPS.map((step) => (
                      <li key={step}>{step}</li>
                    ))}
                  </ol>
                </div>
              </div>
            )}

            {walletTab === "withdraw" && (
              <form className="wallet-form wallet-subpanel" onSubmit={submitWithdrawForm}>
                <div className="wallet-language-note" aria-label="Withdraw instructions in Amharic">
                  <h4>የዊዝድራው መመሪያ</h4>
                  <ol>
                    {WITHDRAW_AMHARIC_STEPS.map((step) => (
                      <li key={step}>{step}</li>
                    ))}
                  </ol>
                </div>
                <label>
                  Bank
                  <select value={withdrawBank} onChange={(event) => setWithdrawBank(event.target.value)}>
                    <option value="CBE">Commercial Bank of Ethiopia</option>
                    <option value="Awash">Awash Bank</option>
                    <option value="Dashen">Dashen Bank</option>
                    <option value="BOA">Bank of Abyssinia</option>
                  </select>
                </label>
                <label>
                  Account Number
                  <input
                    value={withdrawAccountNumber}
                    aria-invalid={Boolean(walletFieldErrors.withdrawAccountNumber)}
                    className={walletFieldErrors.withdrawAccountNumber ? "input-error" : undefined}
                    onChange={(event) => {
                      clearWalletFieldError("withdrawAccountNumber");
                      setWithdrawAccountNumber(event.target.value);
                    }}
                    placeholder="Enter destination account number"
                  />
                  {walletFieldErrors.withdrawAccountNumber ? (
                    <small className="wallet-field-error" role="alert">
                      {walletFieldErrors.withdrawAccountNumber}
                    </small>
                  ) : null}
                </label>
                <label>
                  Account Holder
                  <input
                    value={withdrawAccountHolder}
                    aria-invalid={Boolean(walletFieldErrors.withdrawAccountHolder)}
                    className={walletFieldErrors.withdrawAccountHolder ? "input-error" : undefined}
                    onChange={(event) => {
                      clearWalletFieldError("withdrawAccountHolder");
                      setWithdrawAccountHolder(event.target.value);
                    }}
                    placeholder="Enter account holder name"
                  />
                  {walletFieldErrors.withdrawAccountHolder ? (
                    <small className="wallet-field-error" role="alert">
                      {walletFieldErrors.withdrawAccountHolder}
                    </small>
                  ) : null}
                </label>
                <label>
                  Amount
                  <input
                    type="number"
                    min={3}
                    value={withdrawAmount}
                    aria-invalid={Boolean(walletFieldErrors.withdrawAmount)}
                    className={walletFieldErrors.withdrawAmount ? "input-error" : undefined}
                    onChange={(event) => {
                      clearWalletFieldError("withdrawAmount");
                      setWithdrawAmount(event.target.value);
                    }}
                  />
                  {walletFieldErrors.withdrawAmount ? (
                    <small className="wallet-field-error" role="alert">
                      {walletFieldErrors.withdrawAmount}
                    </small>
                  ) : null}
                </label>
                <button className="primary-btn" type="submit" disabled={working}>
                  {working ? "Submitting..." : "Request Withdraw"}
                </button>
              </form>
            )}

            {walletTab === "transfer" && (
              <form className="wallet-form wallet-subpanel" onSubmit={submitTransferForm}>
                <label>
                  Receiver Phone
                  <input
                    value={transferPhone}
                    aria-invalid={Boolean(walletFieldErrors.transferPhone)}
                    className={walletFieldErrors.transferPhone ? "input-error" : undefined}
                    onChange={(event) => {
                      clearWalletFieldError("transferPhone");
                      setTransferPhone(event.target.value);
                    }}
                    placeholder="09XXXXXXXX or +2519XXXXXXXX"
                  />
                  {walletFieldErrors.transferPhone ? (
                    <small className="wallet-field-error" role="alert">
                      {walletFieldErrors.transferPhone}
                    </small>
                  ) : null}
                </label>
                <label>
                  Amount
                  <input
                    type="number"
                    min={1}
                    value={transferAmount}
                    aria-invalid={Boolean(walletFieldErrors.transferAmount)}
                    className={walletFieldErrors.transferAmount ? "input-error" : undefined}
                    onChange={(event) => {
                      clearWalletFieldError("transferAmount");
                      setTransferAmount(event.target.value);
                    }}
                  />
                  {walletFieldErrors.transferAmount ? (
                    <small className="wallet-field-error" role="alert">
                      {walletFieldErrors.transferAmount}
                    </small>
                  ) : null}
                </label>
                <label>
                  OTP
                  <input
                    value={transferOtp}
                    aria-invalid={Boolean(walletFieldErrors.transferOtp)}
                    className={walletFieldErrors.transferOtp ? "input-error" : undefined}
                    onChange={(event) => {
                      clearWalletFieldError("transferOtp");
                      setTransferOtp(event.target.value);
                    }}
                    placeholder="Enter 4 to 6 digit OTP"
                  />
                  {walletFieldErrors.transferOtp ? (
                    <small className="wallet-field-error" role="alert">
                      {walletFieldErrors.transferOtp}
                    </small>
                  ) : null}
                </label>
                <button className="primary-btn" type="submit" disabled={working}>
                  {working ? "Submitting..." : "Send Transfer"}
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
                    {history.length === 0 ? (
                      <tr>
                        <td colSpan={4}>
                          <div className="table-empty">No wallet activity yet.</div>
                        </td>
                      </tr>
                    ) : (
                      history.map((row) => (
                        <tr key={`wallet-row-${row.type}-${row.created_at}-${row.amount}`}>
                          <td>{row.type}</td>
                          <td>{fmtDate(row.created_at)}</td>
                          <td>{row.amount}</td>
                          <td>{row.status}</td>
                        </tr>
                      ))
                    )}
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
                                updateAdminDraftRows(code, (rows) =>
                                  rows.map((candidate, candidateIdx) =>
                                    candidateIdx === idx ? { ...candidate, phone_number: event.target.value } : candidate,
                                  ),
                                )
                              }
                              placeholder="Phone number"
                            />
                            <input
                              value={row.owner_name}
                              onChange={(event) =>
                                updateAdminDraftRows(code, (rows) =>
                                  rows.map((candidate, candidateIdx) =>
                                    candidateIdx === idx ? { ...candidate, owner_name: event.target.value } : candidate,
                                  ),
                                )
                              }
                              placeholder="Owner"
                            />
                            <button
                              className="secondary-btn"
                              type="button"
                              onClick={() =>
                                updateAdminDraftRows(code, (existingRows) => existingRows.filter((_, rowIdx) => rowIdx !== idx))
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
                            updateAdminDraftRows(code, (existingRows) => [...existingRows, { phone_number: "", owner_name: "" }])
                          }
                        >
                          Add Account
                        </button>
                        <button
                          className="primary-btn"
                          type="button"
                          disabled={adminAccountsSavingByMethod[code]}
                          onClick={() => void onSaveDepositAccounts(code)}
                        >
                          {adminAccountsSavingByMethod[code] ? "Saving..." : `Save ${label}`}
                        </button>
                      </div>
                    </article>
                  );
                })}
                <article className="admin-method-box">
                  <h3>Deposited Records (All Users)</h3>
                  <div className="admin-deposited-toolbar">
                    <input
                      value={adminDepositedSearch}
                      onChange={(event) => setAdminDepositedSearch(event.target.value)}
                      placeholder="Trace by phone, method, tx number, or note"
                    />
                    <input
                      type="date"
                      value={adminDepositedDayFilter}
                      onChange={(event) => setAdminDepositedDayFilter(event.target.value)}
                      aria-label="Filter by day"
                    />
                  </div>
                  <div className="admin-actions">
                    <button className="secondary-btn" type="button" onClick={clearAdminDepositedFilters}>
                      Clear Filters
                    </button>
                    <button
                      className="secondary-btn danger-btn"
                      type="button"
                      disabled={adminClearDepositedBusy || adminDepositedRecords.length === 0}
                      onClick={() => void onClearAdminDepositedRecords()}
                    >
                      {adminClearDepositedBusy ? "Clearing..." : adminDepositedDayFilter ? "Clear Day" : "Clear All"}
                    </button>
                  </div>
                  <div className="admin-deposited-summary">
                    <strong>Total (Filtered): {fmtEtb(filteredAdminDepositedTotal)}</strong>
                    <span>
                      {filteredAdminDepositedRecords.length} of {adminDepositedRecords.length} records
                    </span>
                  </div>
                  <div className="history-scroll admin-deposited-scroll">
                    <table>
                      <thead>
                        <tr>
                          <th>Time</th>
                          <th>User</th>
                          <th>Method</th>
                          <th>Transaction No</th>
                          <th>Amount</th>
                          <th>Status</th>
                          <th>Note</th>
                        </tr>
                      </thead>
                      <tbody>
                        {filteredAdminDepositedRecords.length === 0 ? (
                          <tr>
                            <td colSpan={7}>
                              <div className="table-empty">No deposited records found for the current filter.</div>
                            </td>
                          </tr>
                        ) : (
                          filteredAdminDepositedRecords.map((item) => {
                            return (
                              <tr key={item.id}>
                                <td>
                                  <small>{fmtDate(item.created_at)}</small>
                                </td>
                                <td>{item.phone_number}</td>
                                <td>{item.method ?? "-"}</td>
                                <td>{item.transaction_number ?? "-"}</td>
                                <td>{fmtEtb(item.amount)}</td>
                                <td>{item.status}</td>
                                <td>{item.note ?? "-"}</td>
                              </tr>
                            );
                          })
                        )}
                      </tbody>
                    </table>
                  </div>
                </article>
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
                        {adminWithdrawRequests.length === 0 ? (
                          <tr>
                            <td colSpan={5}>
                              <div className="table-empty">No withdraw requests right now.</div>
                            </td>
                          </tr>
                        ) : (
                          adminWithdrawRequests.map((item) => {
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
                                  <small className="withdraw-account-row">
                                    <span>{item.account_number}</span>
                                    <button
                                      className={`account-copy-icon-btn ${copiedAccountNumber === item.account_number ? "copied" : ""}`}
                                      type="button"
                                      aria-label="Copy account number"
                                      title={copiedAccountNumber === item.account_number ? "Copied" : "Copy account number"}
                                      onClick={() => void onCopyAccountNumber(item.account_number)}
                                    >
                                      {copiedAccountNumber === item.account_number ? (
                                        <svg viewBox="0 0 20 20" focusable="false" aria-hidden="true">
                                          <path d="M4 10.5 8.3 15 16 6.8" />
                                        </svg>
                                      ) : (
                                        <svg viewBox="0 0 20 20" focusable="false" aria-hidden="true">
                                          <path d="M7 3.5h8.5A1.5 1.5 0 0 1 17 5v10a1.5 1.5 0 0 1-1.5 1.5H7A1.5 1.5 0 0 1 5.5 15V5A1.5 1.5 0 0 1 7 3.5z" />
                                          <path d="M4 13.5A1.5 1.5 0 0 1 2.5 12V4A1.5 1.5 0 0 1 4 2.5h8.5" />
                                        </svg>
                                      )}
                                    </button>
                                  </small>
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
                                            setAdminWithdrawRequests((prev) => upsertWithdrawTicketForward(prev, res.item));
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
                                            setAdminWithdrawRequests((prev) => upsertWithdrawTicketForward(prev, res.item));
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
                                        disabled={working || !payoutRef.trim()}
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
                                            setAdminWithdrawRequests((prev) => upsertWithdrawTicketForward(prev, res.item));
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
                                            setAdminWithdrawRequests((prev) => upsertWithdrawTicketForward(prev, res.item));
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
                          })
                        )}
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
                {betHistory.length === 0 ? (
                  <tr>
                    <td colSpan={7}>
                      <div className="table-empty">No finished rounds yet. Your results will appear here.</div>
                    </td>
                  </tr>
                ) : (
                  betHistory.map((row, idx) => (
                    <tr
                      key={row.id}
                      className="bet-history-row"
                      tabIndex={0}
                      role="button"
                      aria-label={`Open bet history row ${idx + 1}`}
                      onClick={() => setSelectedBet(row)}
                      onKeyDown={(event) => activateOnEnterSpace(event, () => setSelectedBet(row))}
                    >
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
                  ))
                )}
              </tbody>
            </table>
          </section>
        )}

        {service === "how" && (
          <section className="panel faq-panel">
            <h2>How To Play</h2>
            <div className="amharic-guide-card">
              <h3>የጨዋታ መመሪያ (አማርኛ)</h3>
              <ol>
                {HOW_TO_PLAY_AMHARIC_STEPS.map((step) => (
                  <li key={step}>{step}</li>
                ))}
              </ol>
            </div>
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

      {!isCasinoLaunchView && (
        <nav className="mobile-bottom-nav" aria-label="Primary navigation">
          {services
            .filter((item) => mobileNavViews.includes(item.view))
            .map((item) => (
              <button
                key={`mobile-nav-${item.view}`}
                type="button"
                className={`mobile-bottom-nav-item ${service === item.view ? "active" : ""}`}
                aria-current={service === item.view ? "page" : undefined}
                onClick={() => openService(item.view)}
              >
                <span className="mobile-bottom-nav-icon">{renderMobileNavIcon(item.view)}</span>
                <span className="mobile-bottom-nav-label">{item.label}</span>
              </button>
            ))}
        </nav>
      )}

      {cartellaOpen && (
        <div className="modal-overlay show" onClick={() => setCartellaOpen(false)}>
          <div
            ref={cartellaDialogRef}
            className="modal-card cartella-modal"
            role="dialog"
            aria-modal="true"
            aria-labelledby="cartella-dialog-title"
            tabIndex={-1}
            onClick={(event) => event.stopPropagation()}
          >
            <Suspense
              fallback={
                <ModalBodyFallback
                  title={selectedStake ? `${selectedStake.stake} Birr Current Game` : "Choose Cartella"}
                  message="Preparing live cartella room..."
                  onClose={() => setCartellaOpen(false)}
                  variant="grid"
                  headingId="cartella-dialog-title"
                />
              }
            >
              <CartellaModalContent
                loading={working}
                cartellaStep={cartellaStep}
                selectedStake={selectedStake}
                pickerRoom={pickerRoom}
                cardRechargeLabel={cardRechargeLabel}
                pickerPhase={pickerPhase}
                pickerCountdownValue={pickerCountdownValue}
                pickerLiveDetail={pickerLiveDetail}
                pickerPaidCount={lockedPickerPaidCount}
                paidCartellas={lockedPickerPaidCartellas}
                simulatedPaidCartellas={lockedPickerSimulatedCartellas}
                heldCartellas={pickerRoom?.held_cartellas ?? []}
                processingCartella={processingCartella}
                selectedCartella={selectedCartella}
                selectedCartellaOwned={selectedCartellaOwned}
                preview={preview}
                insufficientCardBalance={insufficientCardBalance}
                cardBuyAmount={cardBuyAmount}
                working={working}
                onClose={() => setCartellaOpen(false)}
                onPreview={() => void onPreviewCartella()}
                onConfirm={() => void onConfirmCartella()}
                onBackToPick={() => setCartellaStep("pick")}
                onSelectCartella={(num) => void reserveCartella(num)}
              />
            </Suspense>
          </div>
        </div>
      )}

      {depositGuideOpen && (
        <div className="modal-overlay show" onClick={() => setDepositGuideOpen(false)}>
          <div
            ref={depositDialogRef}
            className="modal-card deposit-modal"
            role="dialog"
            aria-modal="true"
            aria-labelledby="deposit-dialog-title"
            tabIndex={-1}
            onClick={(event) => event.stopPropagation()}
          >
            <Suspense
              fallback={
                <ModalBodyFallback
                  title={selectedMethod?.label ?? "Deposit"}
                  message="Loading deposit instructions..."
                  onClose={() => setDepositGuideOpen(false)}
                  headingId="deposit-dialog-title"
                />
              }
            >
              <DepositModalContent
                selectedMethod={selectedMethod}
                selectedMethodDraftAccounts={selectedMethodDraftAccounts}
                isAdmin={profile.is_admin}
                copiedPhone={copiedPhone}
                adminWorking={selectedMethodAdminSaving}
                submitWorking={depositSubmitting}
                fieldErrors={{
                  depositAmount: walletFieldErrors.depositAmount,
                  txNo: walletFieldErrors.txNo,
                  receiptMessage: walletFieldErrors.receiptMessage,
                }}
                depositAmount={depositAmount}
                txNo={txNo}
                receiptMessage={receiptMessage}
                onClose={() => setDepositGuideOpen(false)}
                onCopyPhone={(phone) => void onCopyPhone(phone)}
                onDraftPhoneChange={onDraftPhoneChange}
                onDraftOwnerChange={onDraftOwnerChange}
                onRemoveDraftAccount={onRemoveDraftAccount}
                onAddDraftAccount={onAddDraftAccount}
                onSaveAccounts={(code) => void onSaveDepositAccounts(code)}
                onDepositAmountChange={(value) => {
                  clearWalletFieldError("depositAmount");
                  setDepositAmount(value);
                }}
                onTxChange={onDepositTxChange}
                onTxBlur={(value) => {
                  clearWalletFieldError("txNo");
                  setTxNo(normalizeTransactionNumberInput(value));
                }}
                onReceiptChange={onDepositReceiptChange}
                onSubmit={submitDepositForm}
              />
            </Suspense>
          </div>
        </div>
      )}

      {shareQrOpen && sessionShareLink && (
        <div className="modal-overlay show" onClick={closeSessionShareModal}>
          <div
            ref={shareDialogRef}
            className="modal-card session-share-modal"
            role="dialog"
            aria-modal="true"
            aria-labelledby="session-share-dialog-title"
            tabIndex={-1}
            onClick={(event) => event.stopPropagation()}
          >
            <div className="modal-head">
              <h3 id="session-share-dialog-title">Share Live Session</h3>
              <button type="button" onClick={closeSessionShareModal} aria-label="Close dialog">
                &times;
              </button>
            </div>
            <div className="session-share-content">
              <p className="panel-subtitle">The session link is copied already. Scan the QR code or send the link below to open this room.</p>
              <div className="session-share-qr-shell">
                {shareQrImageError || !sessionQrImageSrc ? (
                  <div className="session-share-qr-fallback">QR preview unavailable</div>
                ) : (
                  <img
                    className="session-share-qr-image"
                    src={sessionQrImageSrc}
                    alt="QR code for this live session"
                    referrerPolicy="no-referrer"
                    onError={() => setShareQrImageError(true)}
                  />
                )}
              </div>
              <div className="session-share-link-box" role="status" aria-live="polite">
                {sessionShareLink}
              </div>
              <div className="session-share-actions">
                <button className="secondary-btn" type="button" onClick={() => void onCopySessionLinkAgain()}>
                  Copy Link Again
                </button>
                <button className="primary-btn" type="button" onClick={closeSessionShareModal}>
                  Close
                </button>
              </div>
            </div>
          </div>
        </div>
      )}

      {selectedBet && (
        <div className="modal-overlay show" onClick={() => setSelectedBet(null)}>
          <div
            ref={betDialogRef}
            className={`modal-card bet-history-modal ${selectedBet.result === "Won" ? "won" : "lost"}`}
            role="dialog"
            aria-modal="true"
            aria-labelledby="bet-history-dialog-title"
            tabIndex={-1}
            onClick={(event) => event.stopPropagation()}
          >
            <Suspense
              fallback={
                <ModalBodyFallback
                  title={selectedBet.result === "Won" ? "You Won" : "This Card Lost"}
                  message="Loading bet details..."
                  onClose={() => setSelectedBet(null)}
                  variant="card"
                  headingId="bet-history-dialog-title"
                />
              }
            >
              <BetHistoryModalContent selectedBet={selectedBet} onClose={() => setSelectedBet(null)} />
            </Suspense>
          </div>
        </div>
      )}

      {showBrandModal && (
        <div className="modal-overlay show" onClick={onCloseBrandModal}>
          <div
            ref={brandDialogRef}
            className="modal-card brand-modal"
            role="dialog"
            aria-modal="true"
            aria-labelledby="brand-dialog-title"
            tabIndex={-1}
            onClick={(event) => event.stopPropagation()}
          >
            <Suspense fallback={<ModalBodyFallback title="40bingo Updates" message="Loading updates..." onClose={onCloseBrandModal} headingId="brand-dialog-title" />}>
              <BrandModalContent onClose={onCloseBrandModal} />
            </Suspense>
          </div>
        </div>
      )}
    </div>
  );
}
