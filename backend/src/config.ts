import { z } from "zod";
import dotenv from "dotenv";

dotenv.config();

const envSchema = z.object({
  // Server
  PORT: z.string().default("3001"),
  NODE_ENV: z
    .enum(["development", "production", "test"])
    .default("development"),

  // Database
  DATABASE_URL: z
    .string()
    .min(1, "DATABASE_URL is required")
    .default(
      "postgresql://waitnsave:waitnsave_secret@localhost:5432/waitnsave"
    ),

  // Auth
  JWT_SECRET: z
    .string()
    .min(16, "JWT_SECRET must be at least 16 characters"),
  JWT_EXPIRES_IN: z.string().default("7d"),

  // CORS
  CORS_ORIGIN: z.string().default("http://localhost:3000"),

  // Scheduler
  CRON_SCHEDULE: z.string().default("0 */6 * * *"),
  SCHEDULER_BATCH_SIZE: z.coerce.number().int().positive().default(5),
  SCHEDULER_BASE_DELAY_MS: z.coerce.number().int().nonnegative().default(3000),
  SCHEDULER_JITTER_MS: z.coerce.number().int().nonnegative().default(2000),

  // Playwright
  DISABLE_PLAYWRIGHT: z
    .string()
    .transform((v) => v === "true")
    .default("false"),

  // Notifications
  DEDUP_DAYS: z.coerce.number().int().positive().default(3),

  // Email
  GMAIL_USER: z.string().optional(),
  GMAIL_APP_PASSWORD: z.string().optional(),
  EMAIL_FROM_NAME: z.string().default("Wait-n-Save"),

  // Data retention
  RETENTION_FULL_DAYS: z.coerce.number().int().positive().default(90),
  RETENTION_KEEP_DAILY_DAYS: z.coerce.number().int().positive().default(365),
});

const parsed = envSchema.safeParse(process.env);

if (!parsed.success) {
  console.error("❌  Invalid environment variables:");
  for (const issue of parsed.error.issues) {
    console.error(`    ${issue.path.join(".")}: ${issue.message}`);
  }
  process.exit(1);
}

const env = parsed.data;

export const config = {
  port: parseInt(env.PORT, 10),
  nodeEnv: env.NODE_ENV,
  isDev: env.NODE_ENV === "development",

  databaseUrl: env.DATABASE_URL,

  jwtSecret: env.JWT_SECRET,
  jwtExpiresIn: env.JWT_EXPIRES_IN,

  corsOrigin: env.CORS_ORIGIN,

  cron: {
    schedule: env.CRON_SCHEDULE,
    batchSize: env.SCHEDULER_BATCH_SIZE,
    baseDelayMs: env.SCHEDULER_BASE_DELAY_MS,
    jitterMs: env.SCHEDULER_JITTER_MS,
  },

  disablePlaywright: env.DISABLE_PLAYWRIGHT,

  dedupDays: env.DEDUP_DAYS,

  email: {
    gmailUser: env.GMAIL_USER,
    gmailAppPassword: env.GMAIL_APP_PASSWORD,
    fromName: env.EMAIL_FROM_NAME,
  },

  retention: {
    fullDays: env.RETENTION_FULL_DAYS,
    keepDailyDays: env.RETENTION_KEEP_DAILY_DAYS,
  },
} as const;

export type Config = typeof config;
