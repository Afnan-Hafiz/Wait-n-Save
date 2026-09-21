import { Router, Request, Response, NextFunction } from "express";
import { z } from "zod";
import { query } from "../db/client";
import { requireAuth } from "../middleware/auth";
import { normalizeUrl, extractVariantHint, checkBlockedDomain } from "../services/urlNormalizer";
import { runChecks } from "../services/scheduler";

const router = Router();

// All routes require authentication
router.use(requireAuth);

const StarItemSchema = z.object({
  productUrl: z.string().url(),
  title: z.string().nullish(),
  imageUrl: z.string().url().nullish(),
  price: z.number().positive(),
  currency: z.string().length(3).default("USD"),
  geoHint: z.string().nullish(),
  variantHint: z.record(z.string()).nullish(),
});

// ── POST /api/items — Star a new item ─────────────────────────────────────────
router.post(
  "/",
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const body = StarItemSchema.parse(req.body);
      const userId = req.auth!.userId;

      const productKey = normalizeUrl(body.productUrl);
      const variantHint = body.variantHint ?? extractVariantHint(body.productUrl);
      const blocked = checkBlockedDomain(body.productUrl);

      // Upsert: if same user already tracks this canonical URL, return existing
      const rows = await query<{
        id: string; title: string | null; original_price: string;
        current_price: string | null; created_at: string; fetch_status: string;
      }>(
        `INSERT INTO tracked_items
           (user_id, product_url, product_key, variant_hint, title, image_url,
            currency, geo_hint, original_price, current_price, lowest_price)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $9, $9)
         ON CONFLICT (user_id, product_key)
         DO UPDATE SET
           product_url = EXCLUDED.product_url,
           title = COALESCE(EXCLUDED.title, tracked_items.title),
           image_url = COALESCE(EXCLUDED.image_url, tracked_items.image_url),
           is_active = true,
           currency = EXCLUDED.currency,
           current_price = EXCLUDED.current_price,
           original_price = CASE
             WHEN tracked_items.original_price < 10 AND EXCLUDED.original_price >= 10 THEN EXCLUDED.original_price
             WHEN tracked_items.currency <> EXCLUDED.currency THEN EXCLUDED.original_price
             ELSE tracked_items.original_price
           END,
           lowest_price = LEAST(tracked_items.lowest_price, EXCLUDED.lowest_price)
         RETURNING id, title, original_price, current_price, created_at, fetch_status, currency`,
        [
          userId,
          body.productUrl,
          productKey,
          variantHint ? JSON.stringify(variantHint) : null,
          body.title ?? null,
          body.imageUrl ?? null,
          body.currency,
          body.geoHint ?? null,
          body.price,
        ]
      );

      const item = rows[0];
      const response: Record<string, unknown> = { item };

      if (blocked.blocked) {
        response.warning = `This site (${new URL(body.productUrl).hostname}) restricts automated access. `
          + `Re-checks may be unreliable. Consider using their official API: ${blocked.apiAlternative ?? "N/A"}.`;
      }

      res.status(201).json(response);
    } catch (err) {
      next(err);
    }
  }
);

// ── GET /api/items — List all tracked items for current user ──────────────────
router.get(
  "/",
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const items = await query(
        `SELECT id, product_url, title, image_url, currency,
                original_price, current_price, lowest_price,
                fetch_status, last_checked_at, is_active, created_at,
                variant_hint,
                CASE
                  WHEN original_price > 0 AND current_price IS NOT NULL
                  THEN ROUND(((original_price - current_price) / original_price) * 100)
                  ELSE NULL
                END AS pct_off
         FROM tracked_items
         WHERE user_id = $1
         ORDER BY created_at DESC`,
        [req.auth!.userId]
      );
      res.json({ items });
    } catch (err) {
      next(err);
    }
  }
);

// ── GET /api/items/check-url — Check if a URL is already tracked ──────────────
// Must be defined BEFORE /:id to avoid route collision
router.get(
  "/check-url",
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const rawUrl = req.query["url"];
      if (typeof rawUrl !== "string" || !rawUrl) {
        res.status(400).json({ error: "url query param is required" });
        return;
      }

      let productKey: string;
      try {
        productKey = normalizeUrl(rawUrl);
      } catch {
        res.status(400).json({ error: "Invalid URL" });
        return;
      }

      const rows = await query<{
        id: string; is_active: boolean; fetch_status: string;
        current_price: string | null; original_price: string;
      }>(
        `SELECT id, is_active, fetch_status, current_price, original_price
         FROM tracked_items
         WHERE user_id = $1 AND product_key = $2`,
        [req.auth!.userId, productKey]
      );

      const blocked = checkBlockedDomain(rawUrl);
      res.json({
        tracked: rows.length > 0,
        item: rows[0] ?? null,
        blockedDomain: blocked.blocked,
        apiAlternative: blocked.apiAlternative ?? null,
      });
    } catch (err) {
      next(err);
    }
  }
);

// ── GET /api/items/:id — Single item detail ───────────────────────────────────
router.get(
  "/:id",
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const rows = await query(
        `SELECT * FROM tracked_items WHERE id = $1 AND user_id = $2`,
        [req.params["id"], req.auth!.userId]
      );
      if (!rows[0]) {
        res.status(404).json({ error: "Item not found" });
        return;
      }
      res.json({ item: rows[0] });
    } catch (err) {
      next(err);
    }
  }
);

// ── PATCH /api/items/:id — Update currency (and optionally title) ──────────────
const PatchItemSchema = z.object({
  currency: z.string().length(3).optional(),
  title: z.string().min(1).optional(),
});

router.patch(
  "/:id",
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const { currency, title } = PatchItemSchema.parse(req.body);
      if (!currency && !title) {
        res.status(400).json({ error: "Provide at least one field to update (currency, title)" });
        return;
      }

      const setClauses: string[] = [];
      const params: unknown[] = [];

      if (currency) { params.push(currency); setClauses.push(`currency = $${params.length}`); }
      if (title)    { params.push(title);    setClauses.push(`title = $${params.length}`); }

      params.push(req.params["id"]);
      params.push(req.auth!.userId);

      const rows = await query<{ id: string; currency: string; title: string | null }>(
        `UPDATE tracked_items
         SET ${setClauses.join(", ")}
         WHERE id = $${params.length - 1} AND user_id = $${params.length}
         RETURNING id, currency, title`,
        params
      );

      if (!rows[0]) {
        res.status(404).json({ error: "Item not found" });
        return;
      }
      res.json({ item: rows[0] });
    } catch (err) {
      next(err);
    }
  }
);

// ── DELETE /api/items/:id — Untrack an item ───────────────────────────────────
router.delete(
  "/:id",
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const result = await query<{ id: string }>(
        `UPDATE tracked_items SET is_active = false
         WHERE id = $1 AND user_id = $2
         RETURNING id`,
        [req.params["id"], req.auth!.userId]
      );
      if (!result[0]) {
        res.status(404).json({ error: "Item not found" });
        return;
      }
      res.json({ success: true });
    } catch (err) {
      next(err);
    }
  }
);

// ── POST /api/items/trigger-check — Manual check trigger (dev/test) ───────────
router.post(
  "/trigger-check",
  async (_req: Request, res: Response, next: NextFunction) => {
    try {
      // Fire and forget — respond immediately
      runChecks().catch(console.error);
      res.json({ message: "Price check cycle triggered" });
    } catch (err) {
      next(err);
    }
  }
);

export default router;
