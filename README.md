# LEMS — Lab Equipment Management System

## Project layout
- `backend/`: Express API and MySQL integration
- `front end/`: preserved original HTML/CSS/JavaScript client
- `frontend-react/`: responsive React + Vite client
- `capacitor.config.ts` and `frontend-react/capacitor.config.ts`: Capacitor app configuration

## Local development
1. Install Node.js 20+.
2. Configure `backend/.env` using `backend/.env.example`; never commit a real `.env` file.
3. Back up your existing `lems_db` and verify tables/columns before any migration.
4. Run `npm run dev:backend` and `npm run dev:frontend` in separate terminals.
5. Vite runs on port 5173 and proxies API calls to Express on port 3000.

## Railway deployment
Build command: `npm run build`. Start command: `npm start`. Health check path: `/health`.
Configure `NODE_ENV`, `JWT_SECRET`, `MYSQLHOST`, `MYSQLPORT`, `MYSQLUSER`, `MYSQLPASSWORD`, `MYSQLDATABASE`, `APP_BASE_URL`, `EMAIL_USER`, `EMAIL_PASS`, and optional `CORS_ORIGINS` in Railway Variables. Use Railway's private MySQL variable references. Back up/import your existing schema and data explicitly; deploying the app does not copy local records. Never commit database credentials or production secrets.

## Android app
The React client is configured for Capacitor, which packages the same app UI for Android. Its API helper reads `VITE_API_BASE_URL` at build time.

1. For the Railway-hosted website, use `VITE_API_BASE_URL=/api` (same-origin API).
2. For an Android/Capacitor build, copy `frontend-react/.env.production.example` to `frontend-react/.env.production`. It points to `https://lems-app-production.up.railway.app/api`. Do not use `localhost` for a phone build; on a phone, localhost refers to the phone itself.
3. From the repository root, run `npm run build`.
4. In `frontend-react`, run `npx cap sync android`, then open the Android project with `npx cap open android`.
5. Test login, equipment listing, checkout, return, and admin-only actions on a physical phone before releasing an APK.

If using a separate native Android Studio Java/Kotlin app rather than Capacitor, configure its HTTP client base URL as `https://lems-app-production.up.railway.app/api` and send API requests to the existing Express backend. Do not connect Android directly to MySQL.

## Release status
Do not consider a release production-ready until the schema, admin account, and end-to-end API workflows have been verified. These instructions configure the client; they do not themselves deploy or change the Railway production service.
