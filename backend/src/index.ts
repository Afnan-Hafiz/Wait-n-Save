import express from "express";
import cors from "cors";
import helmet from "helmet";
import { config } from "./config";
import { getPool, closePool } from "./db/client";
import { errorHandler } from "./middleware/errorHandler";
import authRouter from "./routes/auth";
import itemsRouter from "./routes/items";
import pricesRouter from "./routes/prices";
import { startScheduler } from "./services/scheduler";
import { startRetentionJob } from "./services/retentionJob";

const app = express();

// ── Security & parsing middleware ─────────────────────────────────────────────
app.use(helmet());
app.use(
  cors({
    origin: (origin, callback) => {
      // Allow requests with no origin (e.g. curl, Postman)
      if (!origin) return callback(null, true);
      // Allow any Chrome/Firefox extension origin
      if (origin.startsWith("chrome-extension://") || origin.startsWith("moz-extension://")) {
        return callback(null, true);
      }
      // Allow the configured CORS origin
      if (origin === config.corsOrigin) return callback(null, true);
      callback(new Error(`CORS: origin ${origin} not allowed`));
    },
    methods: ["GET", "POST", "PUT", "DELETE", "OPTIONS"],
    allowedHeaders: ["Content-Type", "Authorization"],
    credentials: true,
  })
);
app.use(express.json({ limit: "1mb" }));
app.use(express.urlencoded({ extended: true }));

// ── Health check ──────────────────────────────────────────────────────────────
app.get("/health", (_req, res) => {
  res.json({ status: "ok", ts: new Date().toISOString() });
});

// ── API routes ────────────────────────────────────────────────────────────────
app.use("/api/auth", authRouter);
app.use("/api/items", itemsRouter);
app.use("/api/prices", pricesRouter);

// ── 404 catch-all ─────────────────────────────────────────────────────────────
app.use((_req, res) => {
  res.status(404).json({ error: "Not found" });
});

// ── Central error handler ─────────────────────────────────────────────────────
app.use(errorHandler);

// ── Bootstrap ─────────────────────────────────────────────────────────────────
async function main(): Promise<void> {
  // Verify DB connection
  try {
    await getPool().query("SELECT 1");
    console.log("✅ Database connected");
  } catch (err) {
    console.error("❌ Database connection failed:", err);
    process.exit(1);
  }

  // Start background jobs
  startScheduler();
  startRetentionJob();

  // Start HTTP server
  app.listen(config.port, () => {
    console.log(`🚀 Wait-n-Save backend listening on http://localhost:${config.port}`);
    console.log(`   Environment: ${config.nodeEnv}`);
    console.log(`   Playwright: ${config.disablePlaywright ? "disabled" : "enabled"}`);
  });
}

// ── Graceful shutdown ─────────────────────────────────────────────────────────
process.on("SIGTERM", async () => {
  console.log("SIGTERM received — shutting down gracefully");
  await closePool();
  process.exit(0);
});
process.on("SIGINT", async () => {
  console.log("SIGINT received — shutting down gracefully");
  await closePool();
  process.exit(0);
});

main().catch((err) => {
  console.error("Fatal startup error:", err);
  process.exit(1);
});

export default app;
