# LEMS — Lab Equipment Management System

## Project layout
- `backend/`: Express API and MySQL integration
- `front end/`: preserved original HTML/CSS/JavaScript client
- `frontend-react/`: responsive React + Vite client
- `capacitor.config.ts`: Android wrapper configuration (to be integrated after web/API verification)

## Local development
1. Install Node.js 20+ and MySQL.
2. Configure `backend/.env` using `backend/.env.example`; never commit a real `.env` file.
3. Back up your existing `lems_db` and verify tables/columns before any migration.
4. Run `npm run dev:backend` and `npm run dev:frontend` in separate terminals.
5. Vite runs on port 5173 and proxies API calls to Express on port 3000.

## Railway deployment
Build command: `npm run build`. Start command: `npm start`. Health check path: `/health`.
Configure `NODE_ENV`, `JWT_SECRET`, `MYSQLHOST`, `MYSQLPORT`, `MYSQLUSER`, `MYSQLPASSWORD`, `MYSQLDATABASE`, `APP_BASE_URL`, `EMAIL_USER`, `EMAIL_PASS`, and optional `CORS_ORIGINS` in Railway Variables. Use Railway's private MySQL variable references. Back up/import your existing schema and data explicitly; deploying the app does not copy local records. Rotate any database password previously committed to Git before exposing the service.

## Android
Before building an APK, set `VITE_API_BASE_URL` to the deployed HTTPS API root ending in `/api`, build the Vite frontend, sync Capacitor, and test the installed app on a physical phone. Do not use localhost as the production API host.

## Release status
The migration is in progress. Do not consider auth or deployment production-ready until the schema, admin account, and end-to-end API workflows have been verified.
