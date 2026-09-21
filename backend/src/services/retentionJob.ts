/**
 * retentionJob.ts
 *
 * Daily cron job that prunes price_history to prevent unbounded table growth.
 *
 * Policy:
 *   - Keep full resolution for the last RETENTION_FULL_DAYS (default: 90)
 *   - Beyond that, keep one row per item per day for RETENTION_KEEP_DAILY_DAYS (default: 365)
 *   - Delete everything older than full + daily retention combined
 */

import cron from "node-cron";
import { query } from "../db/client";
import { config } from "../config";

async function runRetention(): Promise<void> {
  console.log("[retention] Running price_history pruning job...");
  const start = Date.now();

  const { fullDays, keepDailyDays } = config.retention;
  const totalDays = fullDays + keepDailyDays;

  // Step 1: Delete rows older than total retention window
  const deleted1 = await query<{ count: string }>(
    `WITH deleted AS (
       DELETE FROM price_history
       WHERE checked_at < now() - make_interval(days => $1)
       RETURNING id
     )
     SELECT COUNT(*) as count FROM deleted`,
    [totalDays]
  );
  console.log(`[retention] Deleted ${deleted1[0]?.count ?? 0} rows older than ${totalDays} days`);

  // Step 2: For rows between FULL_DAYS and totalDays, keep only the earliest
  //         record per (item_id, day) — prune the rest
  const deleted2 = await query<{ count: string }>(
    `WITH ranked AS (
       SELECT id,
              ROW_NUMBER() OVER (
                PARTITION BY item_id, checked_at::date
                ORDER BY checked_at ASC
              ) AS rn
       FROM price_history
       WHERE checked_at < now() - make_interval(days => $1)
         AND checked_at >= now() - make_interval(days => $2)
     ),
     to_delete AS (
       SELECT id FROM ranked WHERE rn > 1
     ),
     deleted AS (
       DELETE FROM price_history
       WHERE id IN (SELECT id FROM to_delete)
       RETURNING id
     )
     SELECT COUNT(*) as count FROM deleted`,
    [fullDays, totalDays]
  );
  console.log(`[retention] Pruned ${deleted2[0]?.count ?? 0} duplicate daily rows (kept 1/day)`);

  const elapsed = ((Date.now() - start) / 1000).toFixed(1);
  console.log(`[retention] ✅ Done in ${elapsed}s`);
}

export function startRetentionJob(): void {
  // Run every day at 2:00 AM
  const schedule = "0 2 * * *";
  console.log(`[retention] Starting retention cron: "${schedule}"`);
  cron.schedule(schedule, () => {
    runRetention().catch((err) =>
      console.error("[retention] Unhandled error:", err)
    );
  });
}
