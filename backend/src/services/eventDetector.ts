/**
 * eventDetector.ts
 *
 * Decides whether a price check should trigger a notification.
 *
 * Baseline = original_price (price at star time) — never the retailer's
 * advertised "original" price, which may be inflated.
 *
 * Three-layer dedup:
 *   1. last_notified_price column — only notify if price is lower than last time we notified
 *   2. DEDUP_DAYS cooldown — don't re-notify within N days even if price dropped further
 *   3. Confirmed by checking notifications_sent table (survives restarts)
 */

import { query } from "../db/client";
import { config } from "../config";
import type { FetchResult } from "./priceFetcher";

export type EventType =
  | "price_drop"
  | "clearance"
  | "seasonal"
  | "sale"
  | "delisted"
  | "extraction_failure";

export interface PriceEvent {
  itemId: string;
  userId: string;
  eventType: EventType;
  originalPrice: number;
  newPrice: number | null;
  pctOff: number | null;
  saleBadge: string | null;
  retailerOriginalPrice: number | null;
  title: string | null;
  imageUrl: string | null;
  productUrl: string;
  currency: string;
}

interface TrackedItemRow {
  id: string;
  user_id: string;
  original_price: string;
  current_price: string | null;
  last_notified_price: string | null;
  currency: string;
  title: string | null;
  image_url: string | null;
  product_url: string;
}

const SEASONAL_KEYWORDS = [
  "black friday", "cyber monday", "prime day", "flash sale",
  "holiday sale", "mega sale", "super sale", "labor day",
  "memorial day", "independence day", "boxing day",
];

const CLEARANCE_KEYWORDS = ["clearance", "final sale", "last chance", "markdown"];

function classifyBadge(
  badge: string | null
): "seasonal" | "clearance" | "sale" | null {
  if (!badge) return null;
  const lower = badge.toLowerCase();
  if (SEASONAL_KEYWORDS.some((k) => lower.includes(k))) return "seasonal";
  if (CLEARANCE_KEYWORDS.some((k) => lower.includes(k))) return "clearance";
  return "sale";
}

/** Returns a PriceEvent if a notification should be sent, otherwise null. */
export async function detectEvent(
  item: TrackedItemRow,
  result: FetchResult
): Promise<PriceEvent | null> {
  const originalPrice = parseFloat(item.original_price);
  const lastNotifiedPrice = item.last_notified_price
    ? parseFloat(item.last_notified_price)
    : null;
  const newPrice = result.price;

  // ── Delisted event ─────────────────────────────────────────────────────────
  if (result.fetchStatus === "delisted") {
    const alreadySent = await wasRecentlyNotified(item.id, "delisted");
    if (alreadySent) return null;
    return buildEvent(item, "delisted", originalPrice, null, result);
  }

  // ── Extraction failure (alert only after threshold, handled in scheduler) ──
  if (newPrice === null) return null;

  // ── Price-drop detection ───────────────────────────────────────────────────
  let eventType: EventType | null = null;

  // Price dropped below original starred price
  if (newPrice < originalPrice) {
    eventType = "price_drop";
  }

  // Override with more specific badge-based event type if present
  const badgeType = classifyBadge(result.saleBadge);
  if (badgeType) eventType = badgeType;

  if (!eventType) return null;

  // ── Dedup Layer 1: same or higher price than last notification ─────────────
  // (allow notifications when price continues to drop)
  if (lastNotifiedPrice !== null && newPrice >= lastNotifiedPrice) {
    return null;
  }

  // ── Dedup Layer 2: cooldown window ────────────────────────────────────────
  // Even for continued drops, enforce DEDUP_DAYS between emails
  const alreadySent = await wasRecentlyNotified(item.id, eventType);
  if (alreadySent) return null;

  return buildEvent(item, eventType, originalPrice, newPrice, result);
}

function buildEvent(
  item: TrackedItemRow,
  eventType: EventType,
  originalPrice: number,
  newPrice: number | null,
  result: FetchResult
): PriceEvent {
  const pctOff =
    newPrice !== null && originalPrice > 0
      ? Math.round(((originalPrice - newPrice) / originalPrice) * 100)
      : null;

  return {
    itemId: item.id,
    userId: item.user_id,
    eventType,
    originalPrice,
    newPrice,
    pctOff,
    saleBadge: result.saleBadge,
    retailerOriginalPrice: result.retailerOriginalPrice,
    title: item.title,
    imageUrl: item.image_url,
    productUrl: item.product_url,
    currency: result.currency ?? item.currency,
  };
}

async function wasRecentlyNotified(
  itemId: string,
  eventType: string
): Promise<boolean> {
  const rows = await query<{ count: string }>(
    `SELECT COUNT(*) as count
     FROM notifications_sent
     WHERE item_id = $1
       AND event_type = $2
       AND sent_at > now() - interval '1 day' * $3`,
    [itemId, eventType, config.dedupDays]
  );
  return parseInt(rows[0]?.count ?? "0", 10) > 0;
}

/** Record a sent notification so dedup works across restarts. */
export async function recordNotification(
  userId: string,
  itemId: string,
  sentPrice: number | null,
  eventType: EventType
): Promise<void> {
  await query(
    `INSERT INTO notifications_sent (user_id, item_id, sent_price, event_type)
     VALUES ($1, $2, $3, $4)`,
    [userId, itemId, sentPrice, eventType]
  );

  // Update last_notified_price on the item
  if (sentPrice !== null) {
    await query(
      `UPDATE tracked_items SET last_notified_price = $1 WHERE id = $2`,
      [sentPrice, itemId]
    );
  }
}
