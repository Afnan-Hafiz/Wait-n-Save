# Wait-n-Save Database

This directory contains database schemas, migrations, and documentation for the Wait-n-Save PostgreSQL / Neon database.

## Directory Structure

```
database/
├── migrations/
│   └── 001_init.sql      # Initial schema migration (tables, indexes, constraints)
└── README.md             # This guide
```

## Schema Overview

### Tables

1. **`users`**
   - User credentials and authentication (`id`, `email`, `password_hash`, `created_at`).

2. **`tracked_items`**
   - Items starred by users from e-commerce sites.
   - Stores `product_url`, canonical `product_key`, `variant_hint`, `title`, `image_url`, `currency`, `geo_hint`, `original_price`, `current_price`, `lowest_price`, `fetch_status`, `is_active`, and timestamps.
   - Unique constraint: `(user_id, product_key)`.

3. **`price_history`**
   - Historical time-series record of price checks for each tracked item.
   - Stores `price`, `currency`, `sale_badge`, `retailer_original_price`, `fetch_status`, `raw_html_snippet`, and `checked_at`.

4. **`price_events`**
   - Events triggered when a price change occurs (e.g., `real_drop`, `fake_discount`, `price_increase`).
   - Powers user email notifications.

## Running Migrations

To apply migrations against your configured database (`DATABASE_URL` in `.env`):

```bash
# From workspace root:
npm run migrate

# Or from backend/:
cd backend
npm run migrate
```
