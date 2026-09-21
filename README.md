# Wait n Save 

A browser extension + backend service that watches the products you care about and tells you exactly when it's worth buying.

Star any item on any e-commerce site, and Wait & Save keeps an eye on it in the background — tracking clearance sales, discounts, seasonal events (Black Friday, Cyber Monday, flash sales), and plain old price drops. When something happens, you get an email showing the original price next to the current price, so you know exactly how much you're saving before you buy.

## Why
Prices fluctuate constantly and "sales" aren't always real discounts. Wait & Save removes the guesswork — instead of manually checking a product page every few days, it checks for you and only reaches out when the price actually moves in your favor.

## How it works
1. **Star an item** — a browser extension button captures the product, its image, and its current price directly from the page.
2. **Track it** — the backend stores the item and periodically re-checks its price using structured page data (JSON-LD/Open Graph) with a headless-browser fallback for JS-heavy sites.
3. **Detect a deal** — a price event is flagged when the current price drops below your original starred price, or the page shows a clearance/sale/discount indicator.
4. **Get notified** — an email lands in your inbox with a before/after price comparison, so you can decide whether it's finally time to buy.

## Tech stack
- **Extension:** TypeScript, Manifest V3
- **Backend:** Node.js (Express/Fastify), TypeScript
- **Database:** PostgreSQL
- **Scheduler:** node-cron / BullMQ
- **Price extraction:** Cheerio (structured data parsing) + Playwright (headless fallback)
- **Notifications:** Nodemailer (Gmail)

## Status
🚧 Work in progress — building incrementally: extension → price capture → scheduled re-checks → email notifications.
