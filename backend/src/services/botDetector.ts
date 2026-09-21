/**
 * botDetector.ts
 *
 * Inspects a fetched HTTP response to decide whether we received a real
 * product page or a bot-protection / access-denial page.
 *
 * Returns one of:
 *   'ok'              — looks like a real page, proceed with extraction
 *   'bot_blocked'     — Cloudflare/PerimeterX/CAPTCHA challenge detected
 *   'login_gated'     — page redirected to a login wall
 *   'delisted'        — HTTP 404/410 or explicit "not available" copy
 *   'parse_error'     — page too small or suspiciously empty
 */

export type FetchStatus =
  | "ok"
  | "bot_blocked"
  | "login_gated"
  | "delisted"
  | "parse_error"
  | "currency_mismatch";

// ── Bot-block fingerprints ────────────────────────────────────────────────────
const BOT_BLOCK_STRINGS = [
  "cf-browser-verification",
  "cf_chl_prog",
  "cf-turnstile",
  "cloudflare",
  "__cf_bm",
  "Enable JavaScript and cookies",
  "Access Denied",
  "Bot protection",
  "perimeterx",
  "px-captcha",
  "pxCaptcha",
  "Are you a human",
  "__ddg",          // DDoS-Guard
  "challenge-form",
  "security check",
  "please verify you are a human",
  "i am not a robot",
  "just a moment",  // Cloudflare challenge page title
  "attention required",
  "ray id",         // Cloudflare error footer
] as const;

// ── Login-gate fingerprints ──────────────────────────────────────────────────
const LOGIN_GATE_PATHS = [
  "/login", "/signin", "/sign-in",
  "/account/login", "/user/login",
  "/auth", "/authenticate",
];

const LOGIN_GATE_STRINGS = [
  "sign in to see price",
  "sign in to view price",
  "log in to see price",
  "member pricing",
  "member-only price",
  "login to view price",
  "please sign in",
  "members only",
];

// ── Delisted / out-of-stock fingerprints ─────────────────────────────────────
const DELISTED_STRINGS = [
  "page not found",
  "product not found",
  "item not found",
  "this item is no longer available",
  "this product is no longer available",
  "sorry, this item is unavailable",
  "we couldn't find that page",
  "no longer carried",
];

/** Classify the response returned by the fetcher. */
export function classifyResponse(
  html: string,
  statusCode: number,
  finalUrl?: string
): FetchStatus {
  // 1. Hard HTTP errors → delisted
  if (statusCode === 404 || statusCode === 410) return "delisted";

  // 2. Bot-blocking HTTP codes
  if (statusCode === 403 || statusCode === 429 || statusCode === 503) {
    return "bot_blocked";
  }

  const lower = html.toLowerCase();

  // 3. Bot-block text fingerprints
  for (const sig of BOT_BLOCK_STRINGS) {
    if (lower.includes(sig.toLowerCase())) return "bot_blocked";
  }

  // 4. Login gate — check final URL path and page text
  if (finalUrl) {
    const path = new URL(finalUrl).pathname.toLowerCase();
    if (LOGIN_GATE_PATHS.some((p) => path.startsWith(p))) return "login_gated";
  }
  for (const sig of LOGIN_GATE_STRINGS) {
    if (lower.includes(sig)) return "login_gated";
  }

  // 5. Delisted / not-found copy
  for (const sig of DELISTED_STRINGS) {
    if (lower.includes(sig)) return "delisted";
  }

  // 6. Suspiciously tiny response — probably an error shell
  if (html.trim().length < 2_000) return "parse_error";

  return "ok";
}
