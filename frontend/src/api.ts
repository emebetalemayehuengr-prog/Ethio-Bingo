import type {
  AuthResponse,
  BetHistoryRecord,
  CasinoGame,
  CasinoLaunchResponse,
  CasinoPlayResponse,
  DashboardResponse,
  DepositMethod,
  JoinStakeResponse,
  PreviewCardResponse,
  RoomSyncResponse,
  TransactionRecord,
  UserProfile,
  Wallet,
  WithdrawTicket,
} from "./types";

type RuntimeConfig = {
  API_BASE?: string;
};

const runtimeApiBase = (window as Window & { __RUNTIME_CONFIG__?: RuntimeConfig }).__RUNTIME_CONFIG__?.API_BASE?.trim();
const normalizedRuntimeApiBase = runtimeApiBase ? runtimeApiBase.replace(/\/+$/, "") : "";

const envApiBase = (import.meta.env.VITE_API_BASE as string | undefined)?.trim();
const normalizedEnvApiBase = envApiBase ? envApiBase.replace(/\/+$/, "") : "";

const LOCAL_HOST_PATTERN =
  /^(localhost|127\.0\.0\.1|0\.0\.0\.0|::1)$|^(10\.|192\.168\.|172\.(1[6-9]|2\d|3[0-1])\.)/;

const inferApiBase = () => {
  const { protocol, hostname } = window.location;
  if (LOCAL_HOST_PATTERN.test(hostname) || hostname.endsWith(".local")) {
    return `${protocol}//${hostname}:8012`;
  }
  const baseHost = hostname.replace(/^www\./, "");
  const apiHost = baseHost.startsWith("api.") ? baseHost : `api.${baseHost}`;
  return `${protocol}//${apiHost}`;
};

const API_BASE = normalizedRuntimeApiBase || normalizedEnvApiBase || inferApiBase();
const TOKEN_KEY = "40bingo_token";
const LEGACY_TOKEN_KEY = "ethio_bingo_token";
const REQUEST_TIMEOUT_MS = 12000;

const tokenFromStorage =
  window.localStorage.getItem(TOKEN_KEY) ?? window.localStorage.getItem(LEGACY_TOKEN_KEY) ?? "";
if (tokenFromStorage && !window.localStorage.getItem(TOKEN_KEY)) {
  window.localStorage.setItem(TOKEN_KEY, tokenFromStorage);
  window.localStorage.removeItem(LEGACY_TOKEN_KEY);
}
let authToken = tokenFromStorage;

export function getAuthToken() {
  return authToken;
}

export function setAuthToken(token: string | null) {
  authToken = token ?? "";
  if (authToken) {
    window.localStorage.setItem(TOKEN_KEY, authToken);
    window.localStorage.removeItem(LEGACY_TOKEN_KEY);
  } else {
    window.localStorage.removeItem(TOKEN_KEY);
    window.localStorage.removeItem(LEGACY_TOKEN_KEY);
  }
}

export function clearAuthToken() {
  setAuthToken(null);
}

async function request<T>(path: string, options?: RequestInit): Promise<T> {
  const headers: Record<string, string> = {
    "Content-Type": "application/json",
    ...(options?.headers as Record<string, string> | undefined),
  };

  if (authToken) {
    headers.Authorization = `Bearer ${authToken}`;
  }

  const controller = new AbortController();
  const timeoutId = window.setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
  let response: Response;
  try {
    response = await fetch(`${API_BASE}${path}`, {
      ...options,
      headers,
      signal: controller.signal,
    });
  } catch (err) {
    if (err instanceof DOMException && err.name === "AbortError") {
      throw new Error("Request timed out. Check your connection.");
    }
    if (err instanceof TypeError || (err instanceof Error && /failed to fetch|networkerror|load failed/i.test(err.message))) {
      const offline = typeof navigator !== "undefined" && navigator.onLine === false;
      throw new Error(
        offline
          ? "You're offline. Check your connection and try again."
          : "Network error. Unable to reach the server. Check your connection and try again.",
      );
    }
    throw err;
  } finally {
    window.clearTimeout(timeoutId);
  }

  if (!response.ok) {
    if (response.status === 401) {
      clearAuthToken();
      window.dispatchEvent(new CustomEvent("auth:expired"));
    }
    const errorBody = await response.json().catch(() => ({}));
    let detail = "Request failed";
    if (typeof errorBody.detail === "string") {
      detail = errorBody.detail;
    } else if (Array.isArray(errorBody.detail) && errorBody.detail.length > 0) {
      const first = errorBody.detail[0] as { loc?: Array<string | number>; msg?: string };
      const path =
        Array.isArray(first?.loc) && first.loc.length
          ? first.loc.filter((part) => part !== "body").join(".")
          : "";
      if (typeof first?.msg === "string") {
        detail = path ? `${path}: ${first.msg}` : first.msg;
      }
    }
    throw new Error(detail);
  }

  return response.json() as Promise<T>;
}

export function signup(payload: { user_name: string; phone_number: string; password: string }) {
  return request<AuthResponse>("/api/auth/signup", {
    method: "POST",
    body: JSON.stringify(payload),
  });
}

export function login(payload: { phone_number: string; password: string }) {
  return request<AuthResponse>("/api/auth/login", {
    method: "POST",
    body: JSON.stringify(payload),
  });
}

export function loginWithTelegram(payload: { init_data: string; phone_number?: string; password?: string }) {
  return request<AuthResponse>("/api/auth/telegram", {
    method: "POST",
    body: JSON.stringify(payload),
  });
}

export function logout() {
  return request<{ message: string }>("/api/auth/logout", {
    method: "POST",
  });
}

export function fetchMe() {
  return request<{ user: UserProfile; wallet: Wallet }>("/api/auth/me");
}

export function fetchDashboard() {
  return request<DashboardResponse>("/api/dashboard");
}

export function fetchHistory() {
  return request<{ items: TransactionRecord[] }>("/api/wallet/history");
}

export function fetchBetHistory() {
  return request<{ items: BetHistoryRecord[] }>("/api/game/bet-history");
}

export function fetchCasinoGames() {
  return request<{ items: CasinoGame[] }>("/api/casino/games");
}

export function playCasinoGame(payload: { game_id: string; stake: number }) {
  return request<CasinoPlayResponse>("/api/casino/play", {
    method: "POST",
    body: JSON.stringify(payload),
  });
}

export function launchCasinoGame(payload: {
  game_id: string;
  device?: "mobile" | "desktop" | "auto";
  locale?: string;
  return_url?: string;
}) {
  return request<CasinoLaunchResponse>("/api/casino/launch", {
    method: "POST",
    body: JSON.stringify(payload),
  });
}

export function submitDeposit(payload: {
  method: "telebirr" | "cbebirr";
  amount: number;
  transaction_number: string;
  receipt_message?: string;
}) {
  return request<{ message: string; wallet: Wallet }>("/api/wallet/deposit", {
    method: "POST",
    body: JSON.stringify(payload),
  });
}

export function submitTransfer(payload: { phone_number: string; amount: number; otp: string }) {
  return request<{ message: string; wallet: Wallet }>("/api/wallet/transfer", {
    method: "POST",
    body: JSON.stringify(payload),
  });
}

export function submitWithdraw(payload: {
  bank: string;
  account_number: string;
  account_holder: string;
  amount: number;
}) {
  return request<{ message: string; wallet: Wallet; request_id: string }>("/api/wallet/withdraw", {
    method: "POST",
    body: JSON.stringify(payload),
  });
}

export function fetchAdminDepositMethods() {
  return request<{ items: DepositMethod[] }>("/api/admin/deposit-methods");
}

export function updateAdminDepositMethod(
  methodCode: "telebirr" | "cbebirr",
  payload: { transfer_accounts: Array<{ phone_number: string; owner_name: string }> },
) {
  return request<{ message: string; method: DepositMethod; deposit_methods: DepositMethod[] }>(
    `/api/admin/deposit-methods/${methodCode}`,
    {
      method: "PUT",
      body: JSON.stringify(payload),
    },
  );
}

export function fetchAdminWithdrawRequests() {
  return request<{ items: WithdrawTicket[] }>("/api/admin/withdraw-requests");
}

export function approveAdminWithdrawRequest(ticketId: string) {
  return request<{ message: string; item: WithdrawTicket }>(`/api/admin/withdraw-requests/${ticketId}/approve`, {
    method: "POST",
  });
}

export function markPaidAdminWithdrawRequest(
  ticketId: string,
  payload: { payout_reference: string; admin_note?: string },
) {
  return request<{ message: string; item: WithdrawTicket }>(`/api/admin/withdraw-requests/${ticketId}/mark-paid`, {
    method: "POST",
    body: JSON.stringify(payload),
  });
}

export function rejectAdminWithdrawRequest(ticketId: string) {
  return request<{ message: string; item: WithdrawTicket }>(`/api/admin/withdraw-requests/${ticketId}/reject`, {
    method: "POST",
  });
}

export function previewCard(stakeId: string, cartellaNo: number) {
  return request<PreviewCardResponse>("/api/game/preview", {
    method: "POST",
    body: JSON.stringify({ stake_id: stakeId, cartella_no: cartellaNo }),
  });
}

export function joinStake(stakeId: string, cartellaNo: number) {
  return request<JoinStakeResponse>("/api/game/join", {
    method: "POST",
    body: JSON.stringify({ stake_id: stakeId, cartella_no: cartellaNo }),
  });
}

export function fetchStakeRoom(stakeId: string) {
  return request<RoomSyncResponse>(`/api/game/room-by-stake/${stakeId}`);
}
export function syncRoom(roomId: string) {
  return request<RoomSyncResponse>(`/api/game/room/${roomId}`);
}

export function markNumber(roomId: string, number: number, marked: boolean) {
  return request<{ message: string; room: RoomSyncResponse["room"] }>("/api/game/mark-number", {
    method: "POST",
    body: JSON.stringify({ room_id: roomId, number, marked }),
  });
}

export function markNumberForCard(roomId: string, number: number, marked: boolean, cartellaNo: number) {
  return request<{ message: string; room: RoomSyncResponse["room"] }>("/api/game/mark-number", {
    method: "POST",
    body: JSON.stringify({ room_id: roomId, number, marked, cartella_no: cartellaNo }),
  });
}

export function claimBingo(roomId: string, cartellaNo?: number) {
  return request<{ message: string; room: RoomSyncResponse["room"]; wallet?: Wallet }>("/api/game/claim-bingo", {
    method: "POST",
    body: JSON.stringify({ room_id: roomId, cartella_no: cartellaNo }),
  });
}

