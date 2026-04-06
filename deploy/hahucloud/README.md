# 40bingo Deployment on HahuCloud (cPanel)

This guide assumes:

- Frontend is hosted on `https://40bingo.com`
- Backend is hosted on `https://api.40bingo.com`
- You are using HahuCloud shared hosting with cPanel.

## 0) GitHub Actions Deploy Automation

The repo deploy automation lives in `.github/workflows/deploy.yaml`.

Expected GitHub repository secrets:

- `SSH_HOST`
- `SSH_USER`
- `SSH_PRIVATE_KEY` or legacy `SSH_KEY`
- `SSH_PORT` (optional, defaults to `22`)
- `SSH_FRONTEND_PATH` (for example `public_html`)
- `SSH_BACKEND_PATH` (for example `/home/<cpanel-user>/apps/40bingo-backend`)
- `VITE_API_BASE` (for example `https://api.40bingo.com`)
- `RUNTIME_API_BASE` (optional runtime override for `runtime-config.js`)
- `SSH_PASSPHRASE` only if the private key is encrypted

Workflow behavior:

1. Builds the frontend.
2. Verifies `index.html`, `.htaccess`, and `runtime-config.js` are present in `frontend/dist/`.
3. Installs backend requirements and validates the FastAPI app can import.
4. Uploads tar archives over SFTP so hidden files and directory layout are preserved.
5. Extracts the archives on the server, touches `tmp/restart.txt`, and checks `/api/health`.

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
3. Optional: update `public_html/runtime-config.js` to point at your API domain without rebuilding:

```js
window.__RUNTIME_CONFIG__ = { API_BASE: "https://api.40bingo.com" };
```

4. Keep `.htaccess` in the web root (generated from `frontend/public/.htaccess`) for SPA fallback routes.
5. Open `https://40bingo.com` and test login/game/wallet flows.

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
- SMTP transport flags:
  - For implicit SSL (`SMTP_PORT=465`): `SMTP_USE_SSL=true`, `SMTP_USE_TLS=false`
  - For STARTTLS (`SMTP_PORT=587`): `SMTP_USE_SSL=false`, `SMTP_USE_TLS=true`
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
