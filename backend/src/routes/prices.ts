import { Router, Request, Response, NextFunction } from "express";
import { query } from "../db/client";
import { requireAuth } from "../middleware/auth";

const router = Router();

router.use(requireAuth);

// ── GET /api/prices/:itemId — Price history for a chart ───────────────────────
router.get(
  "/:itemId",
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const { itemId } = req.params;
      const userId = req.auth!.userId;

      // Ensure item belongs to requesting user
      const ownership = await query<{ id: string }>(
        `SELECT id FROM tracked_items WHERE id = $1 AND user_id = $2`,
        [itemId, userId]
      );
      if (!ownership[0]) {
        res.status(404).json({ error: "Item not found" });
        return;
      }

      // Pagination: default to last 90 days, up to 500 rows
      const days = Math.min(
        parseInt(String(req.query["days"] ?? "90"), 10),
        365
      );

      const history = await query(
        `SELECT price, currency, sale_badge, retailer_original_price,
                fetch_status, checked_at
         FROM price_history
         WHERE item_id = $1
           AND checked_at > now() - make_interval(days => $2)
         ORDER BY checked_at ASC
         LIMIT 500`,
        [itemId, days]
      );

      res.json({ itemId, history });
    } catch (err) {
      next(err);
    }
  }
);

export default router;
