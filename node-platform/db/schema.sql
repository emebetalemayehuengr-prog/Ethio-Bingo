-- 40bingo PostgreSQL schema
-- Stack: Node.js + Socket.io + Redis + PostgreSQL

CREATE EXTENSION IF NOT EXISTS pgcrypto;

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_type WHERE typname = 'deposit_status') THEN
    CREATE TYPE deposit_status AS ENUM ('pending', 'approved', 'rejected');
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_type WHERE typname = 'room_state') THEN
    CREATE TYPE room_state AS ENUM ('joining', 'playing', 'finished', 'cancelled');
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_type WHERE typname = 'tx_type') THEN
    CREATE TYPE tx_type AS ENUM (
      'deposit_approved',
      'card_purchase',
      'win_payout',
      'admin_commission',
      'manual_adjustment'
    );
  END IF;
END $$;

CREATE TABLE IF NOT EXISTS users (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  telegram_user_id BIGINT UNIQUE,
  phone_number TEXT UNIQUE,
  display_name TEXT NOT NULL,
  password_hash TEXT,
  is_admin BOOLEAN NOT NULL DEFAULT FALSE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS auth_sessions (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  jwt_jti TEXT NOT NULL UNIQUE,
  issued_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  expires_at TIMESTAMPTZ NOT NULL,
  revoked_at TIMESTAMPTZ
);

CREATE INDEX IF NOT EXISTS idx_auth_sessions_user_id ON auth_sessions(user_id);
CREATE INDEX IF NOT EXISTS idx_auth_sessions_expires_at ON auth_sessions(expires_at);

CREATE TABLE IF NOT EXISTS wallets (
  user_id UUID PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
  currency TEXT NOT NULL DEFAULT 'ETB',
  available_balance NUMERIC(14, 2) NOT NULL DEFAULT 0,
  locked_balance NUMERIC(14, 2) NOT NULL DEFAULT 0,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS wallet_transactions (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  tx_type tx_type NOT NULL,
  amount_etb NUMERIC(14, 2) NOT NULL,
  direction TEXT NOT NULL CHECK (direction IN ('credit', 'debit')),
  balance_after_etb NUMERIC(14, 2) NOT NULL,
  room_id UUID,
  round_id UUID,
  metadata JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_wallet_transactions_user_created
  ON wallet_transactions(user_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_wallet_transactions_round_id
  ON wallet_transactions(round_id);

CREATE TABLE IF NOT EXISTS deposit_requests (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  provider TEXT NOT NULL CHECK (provider IN ('telebirr', 'cbebirr')),
  submitted_amount_etb NUMERIC(14, 2) NOT NULL CHECK (submitted_amount_etb > 0),
  tx_reference TEXT NOT NULL,
  sms_or_link TEXT,
  status deposit_status NOT NULL DEFAULT 'pending',
  admin_note TEXT,
  approved_amount_etb NUMERIC(14, 2),
  reviewed_by UUID REFERENCES users(id),
  reviewed_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_deposit_requests_status_created
  ON deposit_requests(status, created_at DESC);

CREATE TABLE IF NOT EXISTS rooms (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  name TEXT NOT NULL,
  card_price_etb NUMERIC(14, 2) NOT NULL CHECK (card_price_etb IN (10, 20, 50, 100, 1000)),
  is_active BOOLEAN NOT NULL DEFAULT TRUE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS game_rounds (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  room_id UUID NOT NULL REFERENCES rooms(id) ON DELETE CASCADE,
  round_no BIGINT NOT NULL,
  state room_state NOT NULL DEFAULT 'joining',
  join_opened_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  join_closed_at TIMESTAMPTZ,
  started_at TIMESTAMPTZ,
  ended_at TIMESTAMPTZ,
  commission_rate NUMERIC(5, 4) NOT NULL DEFAULT 0.15 CHECK (commission_rate >= 0 AND commission_rate <= 1),
  gross_sales_etb NUMERIC(14, 2) NOT NULL DEFAULT 0,
  admin_commission_etb NUMERIC(14, 2) NOT NULL DEFAULT 0,
  prize_pool_etb NUMERIC(14, 2) NOT NULL DEFAULT 0,
  payout_each_etb NUMERIC(14, 2) NOT NULL DEFAULT 0,
  winner_count INTEGER NOT NULL DEFAULT 0,
  last_called_number SMALLINT,
  UNIQUE (room_id, round_no)
);

CREATE INDEX IF NOT EXISTS idx_game_rounds_room_state
  ON game_rounds(room_id, state);

CREATE TABLE IF NOT EXISTS round_cards (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  round_id UUID NOT NULL REFERENCES game_rounds(id) ON DELETE CASCADE,
  user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  card_no INTEGER NOT NULL CHECK (card_no BETWEEN 1 AND 200),
  card_payload JSONB NOT NULL,
  purchased_etb NUMERIC(14, 2) NOT NULL,
  purchased_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (round_id, card_no)
);

CREATE INDEX IF NOT EXISTS idx_round_cards_round_user
  ON round_cards(round_id, user_id);

CREATE TABLE IF NOT EXISTS called_numbers (
  id BIGSERIAL PRIMARY KEY,
  round_id UUID NOT NULL REFERENCES game_rounds(id) ON DELETE CASCADE,
  call_seq INTEGER NOT NULL,
  called_number SMALLINT NOT NULL CHECK (called_number BETWEEN 1 AND 75),
  called_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (round_id, call_seq),
  UNIQUE (round_id, called_number)
);

CREATE INDEX IF NOT EXISTS idx_called_numbers_round_seq
  ON called_numbers(round_id, call_seq DESC);

CREATE TABLE IF NOT EXISTS round_claims (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  round_id UUID NOT NULL REFERENCES game_rounds(id) ON DELETE CASCADE,
  user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  card_id UUID NOT NULL REFERENCES round_cards(id) ON DELETE CASCADE,
  claim_seq INTEGER NOT NULL,
  for_call_seq INTEGER NOT NULL,
  claim_window_ends_at TIMESTAMPTZ NOT NULL,
  is_valid BOOLEAN NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (round_id, claim_seq)
);

CREATE INDEX IF NOT EXISTS idx_round_claims_round_call
  ON round_claims(round_id, for_call_seq, created_at);

CREATE TABLE IF NOT EXISTS round_winners (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  round_id UUID NOT NULL REFERENCES game_rounds(id) ON DELETE CASCADE,
  user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  card_id UUID NOT NULL REFERENCES round_cards(id) ON DELETE CASCADE,
  payout_etb NUMERIC(14, 2) NOT NULL CHECK (payout_etb >= 0),
  settled_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_round_winners_round_id
  ON round_winners(round_id);

-- Recommended accounting invariant:
-- sum(round_winners.payout_etb) + game_rounds.admin_commission_etb = game_rounds.gross_sales_etb
