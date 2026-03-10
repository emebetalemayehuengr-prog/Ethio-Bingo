export type Wallet = {
  currency: string;
  main_balance: number;
  bonus_balance: number;
};

export type UserProfile = {
  user_name: string;
  phone_number: string;
  referral_code: string;
  is_admin: boolean;
};

export type AuthResponse = {
  message: string;
  token: string;
  user: UserProfile;
  wallet: Wallet;
};

export type TransactionRecord = {
  type: "Deposit" | "Withdraw" | "Transfer" | "Bet" | "Win";
  amount: number;
  status: "Completed" | "Pending" | "Failed";
  created_at: string;
};

export type BetHistoryRecord = {
  id: string;
  stake: number;
  game_winning: number;
  winner_cards: number[];
  your_cards: number[];
  date: string;
  result: "Won" | "Lost";
  payout: number;
  called_numbers: number[];
  preview_card: BingoCard | null;
};

export type DepositMethod = {
  code: "telebirr" | "cbebirr";
  label: string;
  logo_url?: string | null;
  transfer_accounts: { phone_number: string; owner_name: string }[];
  instruction_steps: string[];
  receipt_example: string;
};

export type WithdrawTicket = {
  id: string;
  phone_number: string;
  user_name: string;
  bank: string;
  account_number: string;
  account_holder: string;
  amount: number;
  status: "Pending" | "Processing" | "Paid" | "Rejected" | "Approved";
  created_at: string;
  reviewed_at: string | null;
  reviewed_by: string | null;
  processing_at: string | null;
  processing_by: string | null;
  paid_at: string | null;
  paid_by: string | null;
  payout_reference: string | null;
  admin_note: string | null;
};

export type StakeOption = {
  id: string;
  stake: number;
  status: "countdown" | "playing" | "none";
  countdown_seconds: number | null;
  possible_win: number | null;
  bonus: boolean;
  room_phase: "selecting" | "playing" | "finished" | null;
  my_cards_current: number;
  my_cards_next: number;
  open_available: boolean;
};

export type DashboardResponse = {
  brand: {
    name: string;
    tagline: string;
    primary: string;
    accent: string;
    surface: string;
  };
  user: UserProfile;
  is_admin: boolean;
  wallet: Wallet;
  deposit_methods: DepositMethod[];
  stake_options: StakeOption[];
  faq: { id: string; question: string; answer: string }[];
  games: { id: string; title: string; description: string; cta: string }[];
};

export type CasinoGame = {
  id: string;
  title: string;
  description: string;
  min_bet: number;
  max_bet: number;
  max_multiplier: number;
  volatility: "low" | "medium" | "high";
  provider: string;
};

export type CasinoPlayResponse = {
  message: string;
  wallet: Wallet;
  result: {
    game_id: string;
    game_title: string;
    stake: number;
    multiplier: number;
    payout: number;
    net: number;
    outcome: "win" | "lose";
    played_at: string;
  };
};

export type CasinoLaunchResponse = {
  launch_id: string;
  game_id: string;
  game_title: string;
  provider: string;
  mode: "iframe" | "redirect";
  launch_url: string;
  expires_at: string;
};

export type BingoCard = {
  card_no: number;
  grid: Array<Array<number | string>>;
};

export type WinnerEntry = {
  phone_number: string;
  user_name: string;
  cartella_no: number;
  payout: number;
  card: BingoCard;
};

export type RoomState = {
  id: string;
  stake: number;
  card_price: number;
  players: number;
  phase: "selecting" | "playing" | "finished";
  countdown_seconds: number;
  call_countdown_seconds: number;
  cartella_total: number;
  paid_cartellas: number[];
  simulated_paid_cartellas?: number[];
  display_paid_count?: number;
  current_paid_count?: number;
  current_total_sales?: number;
  current_house_commission?: number;
  current_distributable?: number;
  held_cartellas: number[];
  unavailable_cartellas: number[];
  my_cartella: number | null;
  my_cartellas: number[];
  next_my_cartellas: number[];
  my_held_cartella: number | null;
  active_queue: "current" | "next";
  called_numbers: number[];
  latest_number: number | null;
  my_marked_numbers: number[];
  my_marked_numbers_by_card: Record<string, number[]>;
  winner_name: string | null;
  winner_cartella: number | null;
  winner_payout: number | null;
  house_commission: number | null;
  winners: WinnerEntry[];
  claim_window_seconds: number;
  announcement_seconds: number;
};

export type JoinStakeResponse = {
  message: string;
  stake: StakeOption;
  wallet: Wallet;
  card: BingoCard;
  cards?: BingoCard[];
  room: RoomState;
  queue?: "current" | "next";
};

export type PreviewCardResponse = {
  stake: StakeOption;
  card: BingoCard;
  room: RoomState;
  queue?: "current" | "next";
};

export type RoomSyncResponse = {
  room: RoomState;
  card: BingoCard | null;
  cards?: BingoCard[];
};
