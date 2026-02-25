# Ethio Bingo Node Architecture (Task 1 + Task 2)

This folder contains the requested architecture artifacts for:

- Telegram auth + JWT sessions
- Wallet and manual-deposit workflow
- Real-time game engine with Socket rooms
- 15% admin commission settlement
- 2-second winner grace period

## Core services

1. Auth service
- Validate Telegram `initData` hash (`src/auth/telegramAuth.ts`)
- Issue JWT session token

2. Wallet service
- Balance ledger in `wallet_transactions`
- Credit/debit strictly through transactions

3. Manual deposits
- Player submits Telebirr/CBE Birr proof
- Request is stored as `pending`
- Admin approves from panel, then wallet is credited
- Implemented service contract in `src/wallet/manualDeposits.ts`

4. Game engine (Socket.io + Redis pub/sub compatible)
- Room prices: `10, 20, 50, 100, 1000 ETB`
- Joining phase closes when round starts (`transitionToPlaying`)
- Server calls numbers every 5s
- Claim validation window: 2s after each call
- If >1 valid claim in that 2s window, split prize equally
- Engine implementation: `src/engine/gameEngine.ts`

## Task 1: Database schema

See `db/schema.sql`.

Main entities:
- `users`, `auth_sessions`
- `wallets`, `wallet_transactions`
- `deposit_requests`
- `rooms`, `game_rounds`
- `round_cards`, `called_numbers`, `round_claims`, `round_winners`

Commission tracking:
- `game_rounds.commission_rate`
- `game_rounds.gross_sales_etb`
- `game_rounds.admin_commission_etb`
- `game_rounds.prize_pool_etb`
- ledger rows with `tx_type='admin_commission'`

## Task 2: Winner grace + commission split

Implemented in `BingoGameEngine`:

1. Every 5 seconds server stores and broadcasts a called number.
2. Claim accepted only if it arrives within:
   - `last_called_at <= claim_time <= last_called_at + 2000ms`
3. First valid claim starts a timer to the same 2-second window end.
4. All additional valid claims in that window are collected.
5. On timer fire:
   - `baseCommission = gross * 0.15`
   - `prizePool = gross - baseCommission`
   - `payoutEach = prizePool / winnerCount`
   - Rounding remainder is added to admin commission for accounting closure.
6. Round is marked finished and payouts are persisted.

## Frontend constraints note

The schema + engine support:
- sticky call UI and horizontal card scrolling on React side
- room broadcasts to keep all players synchronized on held/paid states and called numbers
