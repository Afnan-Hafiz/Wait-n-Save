/**
 * scheduler.ts
 *
 * node-cron job that periodically re-checks all active tracked items.
 *
 * Safety features:
 *   - Staggered batches with random jitter (prevents IP bans)
 *   - Never fires notifications on failed/blocked fetches
 *   - Suspends items after consecutive failures
 *   - Groups events by user and sends one digest email per user per cycle
 */

import cron from "node-cron";
import { query } from "../db/client";
import { config } from "../config";
import { fetchPrice } from "./priceFetcher";
import { detectEvent, recordNotification, type PriceEvent } from "./eventDetector";
import { sendDigest } from "./mailer";

// ── Constants ─────────────────────────────────────────────────────────────────
const MAX_CONSECUTIVE_FAILS = 5;   // suspend item after this many failures
const ADMIN_ALERT_THRESHOLD = 10;  // log admin alert after this many total parse errors

interface ActiveItem {
  id: string;
  user_id: string;
  user_email: string;
  product_url: string;
  product_key: string;
  geo_hint: string | null;
  currency: string;
  original_price: string;
  current_price: string | null;
  last_notified_price: string | null;
  consecutive_fails: number;
  title: string | null;
  image_url: string | null;
}

// ── Jitter helper ─────────────────────────────────────────────────────────────
function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function jitter(): number {
  return config.cron.baseDelayMs + Math.floor(Math.random() * config.cron.jitterMs);
}

// ── Core check function for a single item ────────────────────────────────────
async function checkItem(item: ActiveItem): Promise<PriceEvent | null> {
  console.log(`[scheduler] Checking: ${item.title ?? item.product_url}`);

  const result = await fetchPrice(item.product_url, item.geo_hint);

  // ── Write to price_history regardless of outcome ──────────────────────────
  await query(
    `INSERT INTO price_history
       (item_id, price, currency, sale_badge, retailer_original_price, fetch_status, raw_html_snippet)
     VALUES ($1, $2, $3, $4, $5, $6, $7)`,
    [
      item.id,
      result.price,
      result.currency ?? item.currency,
      result.saleBadge,
      result.retailerOriginalPrice,
      result.fetchStatus,
      result.rawHtmlSnippet,
    ]
  );

  // ── Handle fetch failures ─────────────────────────────────────────────────
  if (result.fetchStatus !== "ok") {
    const newFails = item.consecutive_fails + 1;

    if (result.fetchStatus === "delisted") {
      // Deactivate immediately
      await query(
        `UPDATE tracked_items
         SET fetch_status = $1, is_active = false, consecutive_fails = $2,
             last_checked_at = now()
         WHERE id = $3`,
        [result.fetchStatus, newFails, item.id]
      );
    } else {
      const suspend = newFails >= MAX_CONSECUTIVE_FAILS;
      await query(
        `UPDATE tracked_items
         SET fetch_status = $1, consecutive_fails = $2,
             is_active = $3, last_checked_at = now()
         WHERE id = $4`,
        [result.fetchStatus, newFails, !suspend, item.id]
      );
      if (suspend) {
        console.warn(
          `[scheduler] ⚠️  Suspended item ${item.id} after ${newFails} consecutive failures (${result.fetchStatus})`
        );
      }
      if (newFails >= ADMIN_ALERT_THRESHOLD) {
        console.error(
          `[scheduler] 🔴 Admin alert: ${newFails} failures for ${item.product_url} (${result.fetchStatus})`
        );
      }
    }

    // Still detect delisted event for user notification
    if (result.fetchStatus === "delisted") {
      return detectEvent(item as Parameters<typeof detectEvent>[0], result);
    }
    return null;
  }

  // ── Successful fetch — update item state ──────────────────────────────────
  const newPrice = result.price!;
  const currentLowest = item.current_price ? parseFloat(item.current_price) : null;
  const newLowest = currentLowest === null || newPrice < currentLowest ? newPrice : currentLowest;

  // Currency mismatch guard
  if (result.currency && item.currency && result.currency !== item.currency) {
    await query(
      `UPDATE tracked_items
       SET fetch_status = 'currency_mismatch', last_checked_at = now(),
           consecutive_fails = 0
       WHERE id = $1`,
      [item.id]
    );
    console.warn(`[scheduler] Currency mismatch for ${item.id}: expected ${item.currency}, got ${result.currency}`);
    return null;
  }

  await query(
    `UPDATE tracked_items
     SET current_price = $1, lowest_price = $2, fetch_status = 'ok',
         consecutive_fails = 0, last_checked_at = now()
     WHERE id = $3`,
    [newPrice, newLowest, item.id]
  );

  // ── Check for notification event ──────────────────────────────────────────
  return detectEvent(item as Parameters<typeof detectEvent>[0], result);
}

// ── Main scheduler tick ───────────────────────────────────────────────────────
async function runChecks(): Promise<void> {
  console.log("[scheduler] 🕐 Price check cycle starting...");
  const start = Date.now();

  const items = await query<ActiveItem>(
    `SELECT
       ti.id, ti.user_id, ti.product_url, ti.product_key,
       ti.geo_hint, ti.currency,
       ti.original_price, ti.current_price, ti.last_notified_price,
       ti.consecutive_fails, ti.title, ti.image_url,
       u.email AS user_email
     FROM tracked_items ti
     JOIN users u ON u.id = ti.user_id
     WHERE ti.is_active = true
     ORDER BY ti.last_checked_at ASC NULLS FIRST`
  );

  if (items.length === 0) {
    console.log("[scheduler] No active items to check.");
    return;
  }

  console.log(`[scheduler] Checking ${items.length} items in batches of ${config.cron.batchSize}`);

  // ── Process in batches ─────────────────────────────────────────────────────
  const userEvents = new Map<string, { email: string; events: PriceEvent[] }>();

  for (let i = 0; i < items.length; i += config.cron.batchSize) {
    const batch = items.slice(i, i + config.cron.batchSize);

    // Process batch sequentially to control request rate
    for (const item of batch) {
      try {
        const event = await checkItem(item);
        if (event) {
          const key = item.user_id;
          if (!userEvents.has(key)) {
            userEvents.set(key, { email: item.user_email, events: [] });
          }
          userEvents.get(key)!.events.push(event);
        }
      } catch (err) {
        console.error(`[scheduler] Unexpected error checking item ${item.id}:`, err);
      }
    }

    // Jittered delay between batches
    if (i + config.cron.batchSize < items.length) {
      await sleep(jitter());
    }
  }

  // ── Send digest emails (one per user) ─────────────────────────────────────
  for (const [userId, { email, events }] of userEvents) {
    if (events.length === 0) continue;
    try {
      await sendDigest({ email }, events);
      // Record each notification for dedup
      for (const event of events) {
        await recordNotification(userId, event.itemId, event.newPrice, event.eventType);
      }
    } catch (err) {
      console.error(`[scheduler] Failed to send digest to ${email}:`, err);
    }
  }

  const elapsed = ((Date.now() - start) / 1000).toFixed(1);
  console.log(`[scheduler] ✅ Cycle complete in ${elapsed}s. Events fired: ${[...userEvents.values()].reduce((n, v) => n + v.events.length, 0)}`);
}

// ── Start the cron job ────────────────────────────────────────────────────────
export function startScheduler(): void {
  if (!cron.validate(config.cron.schedule)) {
    console.error(`[scheduler] Invalid CRON_SCHEDULE: "${config.cron.schedule}"`);
    return;
  }

  console.log(`[scheduler] Starting price check cron: "${config.cron.schedule}"`);
  cron.schedule(config.cron.schedule, () => {
    runChecks().catch((err) =>
      console.error("[scheduler] Unhandled error in cron cycle:", err)
    );
  });
}

/** Expose for manual trigger via test route */
export { runChecks };
