# Ethio Bingo (Standalone React + FastAPI)

This app is fully separate from your existing `qit-pcp` project.

## Folder layout

- `backend/` FastAPI service
- `frontend/` React + Vite app

## 1) Run backend

```powershell
cd C:\Users\HP\Documents\ethio-bingo-app\backend
python -m venv .venv
.\.venv\Scripts\activate
pip install -r requirements.txt
uvicorn app.main:app --reload --host 0.0.0.0 --port 8012
```

Backend base URL: `http://127.0.0.1:8012`

## 2) Run frontend

```powershell
cd C:\Users\HP\Documents\ethio-bingo-app\frontend
npm install
npm run dev  # serves on 5188 from vite config
```

Frontend URL: `http://127.0.0.1:5188`

## Production settings (required)

Copy `backend/.env.example` into your runtime environment and set at minimum:

- `APP_ENV=production`
- `ENABLE_DEMO_SEED=false`
- `ADMIN_BOOTSTRAP_PHONES=<admin phone list, comma-separated>`
- `SESSION_TTL_SECONDS=86400` (or your policy)
- `CORS_ALLOWED_ORIGINS=https://your-frontend-domain`
- `SIGNUP_INITIAL_MAIN_BALANCE=0` and `SIGNUP_INITIAL_BONUS_BALANCE=0`
- SMTP vars (`SMTP_HOST`, `SMTP_USERNAME`, `SMTP_PASSWORD`, `SMTP_FROM`, `ADMIN_ALERT_EMAILS`) for withdraw email alerts
- Optional simulated traffic (visual only): `ENABLE_SIMULATED_ACTIVITY=true`

### Render env values for your setup

Use your GitHub/Render email account `embetalemayehuengr@gmail.com` and set these backend environment variables in Render:

- `ADMIN_ALERT_EMAILS=embetalemayehuengr@gmail.com`
- `TELEGRAM_BOT_TOKEN=<your pre-provided bot token for testing>`
- `APP_ENV=production`
- `ENABLE_DEMO_SEED=false`
- `ENABLE_INTERNAL_TRANSFER=false`
- `SESSION_TTL_SECONDS=86400`
- `SIGNUP_INITIAL_MAIN_BALANCE=0`
- `SIGNUP_INITIAL_BONUS_BALANCE=0`
- `CORS_ALLOWED_ORIGINS=https://<your-frontend-render-domain>`
- Brevo SMTP:
  - `SMTP_HOST=smtp-relay.brevo.com`
  - `SMTP_PORT=587`
  - `SMTP_USERNAME=a35000001@smtp-brevo.com`
  - `SMTP_PASSWORD=<your brevo smtp key>`
  - `SMTP_FROM=embetalemayehuengr@gmail.com`
  - `SMTP_USE_TLS=true`

Frontend Render env:

- `VITE_API_BASE=https://<your-backend-render-domain>`

You can copy from [`backend/render.env.example`](backend/render.env.example) when filling Render env vars.

## Deploy on Render

This repo now includes a blueprint file at [`render.yaml`](render.yaml) that deploys:

- `ethio-bingo-backend` (FastAPI, Python)
- `ethio-bingo-frontend` (React static site)

Steps:

1. Push this folder to a GitHub repository.
2. In Render, choose **Blueprint** deployment and select that repo.
3. After services are created, set secret env vars on backend:
   - `TELEGRAM_BOT_TOKEN` = your bot token
   - `SMTP_PASSWORD` = your Brevo SMTP key
4. Redeploy backend service.

If backend build fails with `pydantic-core` on Python `3.14.x`, set backend
`PYTHON_VERSION=3.11.11` in Render env vars and redeploy.

Important:

- If your frontend service URL is not exactly `https://ethio-bingo-frontend.onrender.com`, update backend `CORS_ALLOWED_ORIGINS` to the real URL.
- If your backend service URL is not exactly `https://ethio-bingo-backend.onrender.com`, update frontend `VITE_API_BASE` to the real URL and redeploy frontend.

Transfer security:

- `ENABLE_INTERNAL_TRANSFER=false` by default (safe)
- To enable transfers, configure real OTP verification endpoint:
  - `ENABLE_INTERNAL_TRANSFER=true`
  - `TRANSFER_OTP_VERIFY_URL=https://your-otp-service/verify`

## Included screens and flows

- Ethio Bingo mobile-first top navigation and drawer menu
- Bingo and Spin game cards
- Wallet section with tabs:
  - Deposit (Telebirr and CBE Birr methods)
  - Withdraw (manual form)
  - Transfer (phone + OTP form)
  - History (transaction table)
- Stake table with Join actions
- Room join modal with 1-96 number picker (24 picks), auto-call, next-call, and bingo claim logic
- FAQ accordion section
- Live bingo card preview with countdown and card actions
- Settings modal (profile/wallet/history) for mobile flow

## Deposit Contacts

- `+251945811613` - `ERGO`
- `0923794255` - `KIYA`

## Main API routes

- `GET /api/dashboard`
- `GET /api/wallet/history`
- `POST /api/wallet/deposit`
- `POST /api/wallet/withdraw`
- `POST /api/wallet/transfer`
- `GET /api/game/card`
- `POST /api/game/join`

## Notes

- SQLite is used by default (`ETHIO_BINGO_DB_PATH`) unless `DATABASE_URL` is set.
- Demo accounts are seeded only when `ENABLE_DEMO_SEED=true`.

