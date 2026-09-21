# Wait-n-Save

A browser extension + backend service that watches the products you care about and tells you exactly when it's worth buying.

Star any item on any e-commerce site, and Wait & Save keeps an eye on it in the background — tracking clearance sales, discounts, seasonal events (Black Friday, Cyber Monday, flash sales), and plain old price drops. When something happens, you get an email showing the original price next to the current price, so you know exactly how much you're saving before you buy.

## How it works

1. **Star an item** — a browser extension button captures the product, its image, current price, and exact variant (size/color/etc.) directly from the page.
2. **Track it** — the backend stores the item and periodically re-checks its price using structured page data (JSON-LD/Open Graph) with a headless-browser fallback for JS-heavy sites.
3. **Detect a deal** — a price event is flagged when the current price drops below your original starred price, or the page shows a clearance/sale/discount indicator. The check is robust to bot-blocks, delistings, and currency mismatches.
4. **Get notified** — a single digest email lands in your inbox with a before/after price comparison for all triggered items, so you can decide whether it's finally time to buy.

## Tech stack

| Layer | Technology |
|---|---|
| Frontend (Extension) | TypeScript, Manifest V3, Webpack |
| Backend | Node.js, Express, TypeScript |
| Database | PostgreSQL 16 (Neon / Local) |
| Scheduler | node-cron (staggered batches + jitter) |
| Price extraction | Cheerio (JSON-LD → OG → microdata → CSS) + Playwright fallback |
| Notifications | Nodemailer (Gmail SMTP) |
| Validation | Zod |

## Project Structure

```
Wait-n-Save/
├── frontend/               # Browser extension (popup, background, content scripts)
├── backend/                # Express API, scraper, scheduler, mailer
├── database/               # SQL migrations and schema documentation
└── docker-compose.yml      # Local development database container
```

## Quick start

### Prerequisites

- Node.js 18+
- Docker & Docker Compose (or Neon PostgreSQL)
- A Chromium-based browser (Chrome, Edge, Brave)

### 1. Clone and configure

```bash
git clone https://github.com/yourname/wait-n-save
cd wait-n-save
cp .env.example .env
# Edit .env — at minimum set JWT_SECRET and DATABASE_URL
```

### 2. Start the database

```bash
docker-compose up -d
```

The PostgreSQL container auto-runs the migration from `database/migrations/001_init.sql`.

### 3. Start the backend

```bash
cd backend
npm install
npm run dev
```

The server starts at `http://localhost:3001`. A price check cron runs every 6 hours by default.

> **Email**: Leave `GMAIL_USER` and `GMAIL_APP_PASSWORD` blank — the mailer defaults to a console transport that logs emails to stdout. Set them when you're ready for real delivery.

> **Playwright**: The Chromium headless fallback downloads on first use (~150 MB). Set `DISABLE_PLAYWRIGHT=true` to skip it.

### 4. Load the browser extension

```bash
cd frontend
npm install
npm run build    # or: npm run dev (watch mode)
```

Then in Chrome:
1. Open `chrome://extensions`
2. Enable **Developer mode**
3. Click **Load unpacked**
4. Select `frontend/dist/`

### 5. Use it

1. Click the Wait-n-Save icon → **Sign in** (or create an account)
2. Navigate to any product page
3. Click the **⭐ Star this item** button that appears in the corner
4. The popup shows all your tracked items with live prices

## API reference

All endpoints are at `http://localhost:3001/api`.

| Method | Path | Auth | Description |
|---|---|---|---|
| POST | `/auth/register` | — | Create account |
| POST | `/auth/login` | — | Get JWT |
| GET | `/auth/me` | ✓ | Current user |
| POST | `/items` | ✓ | Star an item |
| GET | `/items` | ✓ | List tracked items |
| GET | `/items/check-url?url=` | ✓ | Check if URL is tracked |
| GET | `/items/:id` | ✓ | Item detail |
| DELETE | `/items/:id` | ✓ | Untrack item |
| POST | `/items/trigger-check` | ✓ | Manually run price check |
| GET | `/prices/:itemId` | ✓ | Price history (for charts) |

## Edge cases handled

- **Fake "original" prices** — baseline is always the price you starred, not the retailer's strikethrough
- **Variant-specific pricing** — URL variant params (`?size=M&color=red`) are included in the canonical key
- **JS-rendered SPAs** — Playwright fallback for sites that return empty shells to plain HTTP GET
- **Anti-bot protection** — 15+ Cloudflare/PerimeterX signatures detected; items suspended after 5 consecutive blocks
- **Login-gated pricing** — detected and flagged; user notified once
- **Regional currency mismatch** — price comparison skipped if fetched currency differs from starred currency
- **Delisted / 404** — item deactivated, one-time removal email sent
- **Silent extraction failure** — counted, admin-alerted after 10 failures; no false notification sent
- **Notification spam** — three-layer dedup: `last_notified_price` + cooldown window + `notifications_sent` table
- **Rate limiting / IP bans** — staggered batches with random jitter, rotating User-Agent pool
- **Cross-device dedup** — `UNIQUE(user_id, product_key)` means starring the same item twice = one row
- **Historical data growth** — full fidelity 90 days, daily snapshots to 365 days, then pruned

## Gmail App Password setup

1. Enable 2-Factor Authentication on your Google account
2. Go to [myaccount.google.com/apppasswords](https://myaccount.google.com/apppasswords)
3. Create a password for "Mail" → "Windows Computer"
4. Set `GMAIL_USER=you@gmail.com` and `GMAIL_APP_PASSWORD=<16-char-password>` in `.env`

## Status

✅ Production-ready incremental build — extension + backend + email notifications complete.
