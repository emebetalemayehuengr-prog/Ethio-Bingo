# 40bingo (React + FastAPI)

This app is standalone and separate from `qit-pcp`.

## Folder Layout

- `backend/` FastAPI service
- `frontend/` React + Vite app
- `deploy/hahucloud/` HahuCloud deployment guides

## Run Locally

### Backend

```powershell
cd backend
python -m venv .venv
.\.venv\Scripts\activate
pip install -r requirements.txt
uvicorn app.main:app --reload --host 0.0.0.0 --port 8012
```

Backend base URL: `http://127.0.0.1:8012`

### Frontend

```powershell
cd frontend
npm install
npm run dev
```

Frontend URL: `http://127.0.0.1:5188`

## Production Environment (Backend)

Set at minimum:

- `APP_ENV=production`
- `ENABLE_DEMO_SEED=false`
- `ADMIN_BOOTSTRAP_PHONES=<comma-separated admins>`
- `SESSION_TTL_SECONDS=86400` (or your policy)
- `CORS_ALLOWED_ORIGINS=https://<your-frontend-domain>`
- `SIGNUP_INITIAL_MAIN_BALANCE=0`
- `SIGNUP_INITIAL_BONUS_BALANCE=0`
- SMTP vars:
  - `SMTP_HOST`
  - `SMTP_USERNAME`
  - `SMTP_PASSWORD`
  - `SMTP_FROM`
  - `ADMIN_ALERT_EMAILS`

Wallet persistence:

- Preferred SQLite env vars:
  - `FORTY_BINGO_DB_PATH=/var/data/40bingo.db`
  - `FORTY_BINGO_FALLBACK_DB_PATH=<optional>`
  - `PERSISTENT_SQLITE_ROOTS=/var/data,/home`
- `DATABASE_URL` (Postgres) is also supported.
- Legacy env vars `ETHIO_BINGO_DB_PATH` and `ETHIO_BINGO_FALLBACK_DB_PATH` are still accepted for compatibility.

## Deploy on HahuCloud (Primary)

Use the deployment pack in [`deploy/hahucloud/README.md`](deploy/hahucloud/README.md).

Included for HahuCloud/cPanel:

- `backend/passenger_wsgi.py` for Python Selector + Passenger (FastAPI via WSGI adapter)
- `frontend/public/.htaccess` SPA rewrite fallback for Apache hosting

## Render (Optional Legacy)

If you still need Render, this repo keeps [`render.yaml`](render.yaml) with `40bingo-backend` and `40bingo-frontend` services.

## Main API Routes

- `GET /api/dashboard`
- `GET /api/wallet/history`
- `POST /api/wallet/deposit`
- `POST /api/wallet/withdraw`
- `POST /api/wallet/transfer`
- `POST /api/game/join`
- `POST /api/game/claim-bingo`

## Notes

- SQLite is default when `DATABASE_URL` is not set.
- Demo accounts are seeded only when `ENABLE_DEMO_SEED=true`.
