# 40bingo Deployment on HahuCloud (cPanel)

This guide assumes:

- Frontend is hosted on `https://40bingo.com`
- Backend is hosted on `https://api.40bingo.com`
- You are using HahuCloud shared hosting with cPanel.

## 1) Backend (FastAPI) via cPanel Python Selector

1. Upload `backend/` to your hosting account (for example: `~/apps/40bingo-backend`).
2. In cPanel, open `Setup Python App` and create an app:
   - Python version: `3.11`
   - Application root: `apps/40bingo-backend`
   - Application URL: choose your API subdomain (for example `api.40bingo.com`)
   - Startup file: `passenger_wsgi.py`
   - Entry point: `application`
3. Open Terminal in cPanel and install deps in the app virtualenv:

```bash
cd ~/apps/40bingo-backend
pip install -r requirements.txt
```

4. Configure app environment variables from [`backend.env.example`](backend.env.example).
5. Restart the Python app from cPanel.
6. Verify backend health:

```text
https://api.40bingo.com/api/health
```

## 2) Frontend (Vite static) on cPanel

1. Build frontend with production API base:

```powershell
cd frontend
$env:VITE_API_BASE="https://api.40bingo.com"
npm ci
npm run build
```

2. Upload contents of `frontend/dist/` into `public_html/`.
3. Keep `.htaccess` in the web root (generated from `frontend/public/.htaccess`) for SPA fallback routes.
4. Open `https://40bingo.com` and test login/game/wallet flows.

## 3) Required Backend Env Vars

Minimum required:

- `APP_ENV=production`
- `CORS_ALLOWED_ORIGINS=https://40bingo.com`
- `FORTY_BINGO_DB_PATH=/home/<cpanel-user>/apps/40bingo-backend/data/40bingo.db`
- `SESSION_TTL_SECONDS=86400`
- `ENABLE_DEMO_SEED=false`
- `SIGNUP_INITIAL_MAIN_BALANCE=0`
- `SIGNUP_INITIAL_BONUS_BALANCE=0`
- `SMTP_HOST`, `SMTP_USERNAME`, `SMTP_PASSWORD`, `SMTP_FROM`
- One alert recipient path:
  - `ADMIN_ALERT_EMAILS` (email recipients), or
  - `ADMIN_ALERT_SMS_RECIPIENTS` (email-to-SMS addresses), or
  - `WITHDRAW_ALERT_PHONES` + `SMTP_SMS_GATEWAY_DOMAIN` (phone-to-email gateway route)

Optional:

- `DATABASE_URL=<postgres-url>` if using Postgres instead of SQLite.
- `TELEGRAM_BOT_TOKEN=<token>` if Telegram auth is enabled.

## 4) Post-Deploy Checklist

1. `GET /api/health` returns `status=ok`.
2. Signup/login works from the frontend domain.
3. Stake join and card purchase update wallet balance correctly.
4. Deposit and withdraw notifications arrive on admin email.
5. Browser refresh on non-root routes still works (SPA rewrite active).
