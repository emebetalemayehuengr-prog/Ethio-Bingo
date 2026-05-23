import type {
  AuthResponse,
  BetHistoryRecord,
  CasinoGame,
  CasinoLaunchResponse,
  CasinoPlayResponse,
  DashboardResponse,
  DepositMethod,
  DepositedRecord,
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
const READ_REQUEST_TIMEOUT_MS = 15000;
const DASHBOARD_REQUEST_TIMEOUT_MS = 30000;
const GAME_READ_REQUEST_TIMEOUT_MS = 15000;
const GAME_JOIN_REQUEST_TIMEOUT_MS = 25000;
const TRANSPORT_RETRY_LIMIT = 1;
const DASHBOARD_TRANSPORT_RETRY_LIMIT = 2;
const AUTH_RECOVERY_TIMEOUT_MS = 7000;
const AUTH_RECOVERY_RETRY_LIMIT = 1;
const AUTH_SESSION_PROBE_PATH = "/api/auth/me";
const AUTH_ENDPOINT_PREFIXES = ["/api/auth/login", "/api/auth/signup", "/api/auth/telegram", "/api/auth/logout"];

export class ApiRequestError extends Error {
  status: number;
  detail: unknown;

  constructor(message: string, status: number, detail?: unknown) {
    super(message);
    this.name = "ApiRequestError";
    this.status = status;
    this.detail = detail;
  }
}

export function isApiRequestError(error: unknown): error is ApiRequestError {
  return error instanceof ApiRequestError;
}

const tokenFromStorage =
  window.localStorage.getItem(TOKEN_KEY) ?? window.localStorage.getItem(LEGACY_TOKEN_KEY) ?? "";
if (tokenFromStorage && !window.localStorage.getItem(TOKEN_KEY)) {
  window.localStorage.setItem(TOKEN_KEY, tokenFromStorage);
  window.localStorage.removeItem(LEGACY_TOKEN_KEY);
}
let authToken = tokenFromStorage;
let authRecoveryPromise: Promise<boolean> | null = null;
let authExpiredTokenNotified = "";

export function getAuthToken() {
  return authToken;
}

export function setAuthToken(token: string | null) {
  authToken = token ?? "";
  if (authToken) {
    authExpiredTokenNotified = "";
  }
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

const normalizePath = (path: string) => {
  const queryIndex = path.indexOf("?");
  return queryIndex >= 0 ? path.slice(0, queryIndex) : path;
};

const isAuthEndpointPath = (path: string) => {
  const normalized = normalizePath(path);
  return normalized === AUTH_SESSION_PROBE_PATH || AUTH_ENDPOINT_PREFIXES.some((prefix) => normalized.startsWith(prefix));
};

const isGameEndpointPath = (path: string) => normalizePath(path).startsWith("/api/game/");
const isGameJoinEndpointPath = (path: string) => normalizePath(path) === "/api/game/join";
const isDashboardEndpointPath = (path: string) => normalizePath(path) === "/api/dashboard";

const normalizeMethod = (method?: string) => (method ?? "GET").toUpperCase();

const isRetrySafeMethod = (method?: string) => {
  const normalized = normalizeMethod(method);
  return normalized === "GET" || normalized === "HEAD";
};

const getRequestTimeoutForPath = (path: string, method?: string) => {
  if (isGameJoinEndpointPath(path)) return GAME_JOIN_REQUEST_TIMEOUT_MS;
  if (!isRetrySafeMethod(method)) return REQUEST_TIMEOUT_MS;
  if (isDashboardEndpointPath(path)) return DASHBOARD_REQUEST_TIMEOUT_MS;
  if (isGameEndpointPath(path)) return GAME_READ_REQUEST_TIMEOUT_MS;
  return READ_REQUEST_TIMEOUT_MS;
};

const getTransportRetryLimitForPath = (path: string) => {
  if (isDashboardEndpointPath(path)) return DASHBOARD_TRANSPORT_RETRY_LIMIT;
  return TRANSPORT_RETRY_LIMIT;
};

const notifyAuthExpired = () => {
  if (!authToken) return;
  if (authExpiredTokenNotified === authToken) return;
  authExpiredTokenNotified = authToken;
  clearAuthToken();
  window.dispatchEvent(new CustomEvent("auth:expired"));
};

async function performFetch(
  path: string,
  options: RequestInit | undefined,
  headers: Record<string, string>,
  timeoutMs: number = REQUEST_TIMEOUT_MS,
): Promise<Response> {
  const controller = new AbortController();
  const timeoutId = window.setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await fetch(`${API_BASE}${path}`, {
      ...options,
      headers,
      cache: options?.cache ?? "no-store",
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
}

async function probeAuthSessionRecovery(): Promise<boolean> {
  if (!authToken) return false;
  if (authRecoveryPromise) return authRecoveryPromise;
  const tokenAtStart = authToken;
  authRecoveryPromise = (async () => {
    const probeHeaders: Record<string, string> = {
      Authorization: `Bearer ${tokenAtStart}`,
    };
    try {
      const response = await performFetch(
        AUTH_SESSION_PROBE_PATH,
        {
          method: "GET",
          cache: "no-store",
        },
        probeHeaders,
        AUTH_RECOVERY_TIMEOUT_MS,
      );
      if (authToken !== tokenAtStart) {
        return Boolean(authToken);
      }
      return response.ok;
    } catch {
      return false;
    }
  })().finally(() => {
    authRecoveryPromise = null;
  });
  return authRecoveryPromise;
}

async function request<T>(
  path: string,
  options?: RequestInit,
  authRetryAttempt: number = 0,
  transportRetryAttempt: number = 0,
): Promise<T> {
  const headers: Record<string, string> = {
    "Content-Type": "application/json",
    ...(options?.headers as Record<string, string> | undefined),
  };

  if (authToken) {
    headers.Authorization = `Bearer ${authToken}`;
  }

  let response: Response;
  try {
    response = await performFetch(path, options, headers, getRequestTimeoutForPath(path, options?.method));
  } catch (err) {
    const message = err instanceof Error ? err.message.toLowerCase() : "";
    const canRetryTransport =
      transportRetryAttempt < getTransportRetryLimitForPath(path) &&
      isRetrySafeMethod(options?.method) &&
      (message.includes("timed out") || message.includes("network error") || message.includes("offline"));
    if (canRetryTransport) {
      return request<T>(path, options, authRetryAttempt, transportRetryAttempt + 1);
    }
    throw err;
  }

  if (!response.ok) {
    if (response.status === 401) {
      const canRecoverSession =
        authRetryAttempt < AUTH_RECOVERY_RETRY_LIMIT && !isAuthEndpointPath(path) && Boolean(authToken);
      if (canRecoverSession) {
        const recovered = await probeAuthSessionRecovery();
        if (recovered) {
          return request<T>(path, options, authRetryAttempt + 1, transportRetryAttempt);
        }
      }
      notifyAuthExpired();
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
    throw new ApiRequestError(detail, response.status, errorBody?.detail ?? null);
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

export function fetchAdminDepositedRecords() {
  return request<{ items: DepositedRecord[] }>("/api/admin/deposited-records");
}

export function clearAdminDepositedRecords(payload: { confirm: boolean; day?: string | null }) {
  return request<{ message: string; deleted: number }>("/api/admin/deposited-records/clear", {
    method: "POST",
    body: JSON.stringify(payload),
  });
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

export function previewCard(stakeId: string, cartellaNo: number, roundId?: string) {
  return request<PreviewCardResponse>("/api/game/preview", {
    method: "POST",
    body: JSON.stringify({ stake_id: stakeId, cartella_no: cartellaNo, round_id: roundId ?? null }),
  });
}

export function joinStake(stakeId: string, cartellaNo: number, roundId?: string) {
  return request<JoinStakeResponse>("/api/game/join", {
    method: "POST",
    body: JSON.stringify({ stake_id: stakeId, cartella_no: cartellaNo, round_id: roundId ?? null }),
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

export function setAutoMarkPreference(roomId: string, enabled: boolean) {
  return request<{ message: string; room: RoomSyncResponse["room"] }>("/api/game/auto-mark", {
    method: "POST",
    body: JSON.stringify({ room_id: roomId, enabled }),
  });
}

export function claimBingo(roomId: string, cartellaNo?: number) {
  return request<{ message: string; room: RoomSyncResponse["room"]; wallet?: Wallet }>("/api/game/claim-bingo", {
    method: "POST",
    body: JSON.stringify({ room_id: roomId, cartella_no: cartellaNo }),
  });
}

