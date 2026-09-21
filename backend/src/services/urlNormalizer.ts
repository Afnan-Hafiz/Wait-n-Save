/**
 * urlNormalizer.ts
 *
 * Converts any product URL into a stable canonical "product key" used as the
 * deduplication key across tracked_items. The key:
 *   - strips tracking / affiliate / session params
 *   - keeps variant-identifying params (size, color, sku, etc.)
 *   - lower-cases the hostname and path
 *
 * Also exports helpers for domain blocklist and variant hint extraction.
 */

// ── Param deny-list (tracking / affiliate / analytics) ─────────────────────
const STRIP_PARAMS = new Set([
  // UTM
  "utm_source", "utm_medium", "utm_campaign", "utm_term", "utm_content",
  "utm_id", "utm_campaign_id",
  // Google
  "gclid", "gclsrc", "gbraid", "wbraid", "dclid",
  // Facebook / Meta
  "fbclid", "fbaid", "fb_action_ids", "fb_action_types",
  // Other ad networks
  "msclkid", "twclid", "ttclid", "li_fat_id", "mc_cid", "mc_eid",
  // Affiliate / referral
  "ref", "referer", "referrer", "affiliate", "affiliate_id",
  "aff_id", "aff_sub", "aff_sub2", "sub_id", "subid",
  "irclickid", "irgwc", "clickid", "partnerref",
  // Session / tracking
  "sessionid", "session_id", "sid", "cid",
  "trk", "trkd", "trkCampaign", "trkChannel",
  "zanpid", "origin",
  // Amazon-specific
  "tag", "linkId", "camp", "creative", "creativeASIN",
  // eBay-specific
  "hash", "mkrid", "siteid", "campid", "customid",
]);

// ── Param allow-list (variant-identifying, must be preserved) ───────────────
const KEEP_PARAMS = new Set([
  "variant", "variant_id", "variantId",
  "size", "color", "colour",
  "style", "style_id",
  "sku", "skuId", "sku_id",
  "option", "option1", "option2", "option3",
  "selectedOption", "selected_option",
  "configuration", "config",
  "itemId", "item_id",
  "nid",       // Shopify
  // Salesforce Commerce Cloud dynamic variant attribute prefix
  // handled via regex below
]);

// Salesforce Commerce Cloud variant param pattern: dwvar_*_*
const SFCC_VARIANT_REGEX = /^dwvar_/;

function shouldKeepParam(name: string): boolean {
  if (KEEP_PARAMS.has(name)) return true;
  if (SFCC_VARIANT_REGEX.test(name)) return true;
  return false;
}

/** Return the canonical product key for a URL. */
export function normalizeUrl(rawUrl: string): string {
  let url: URL;
  try {
    url = new URL(rawUrl);
  } catch {
    // Not a valid URL — return as-is (edge: extension may pass partial URLs)
    return rawUrl.toLowerCase().trim();
  }

  // Keep only variant params; drop everything else
  const keptParams: Array<[string, string]> = [];
  for (const [key, value] of url.searchParams.entries()) {
    if (STRIP_PARAMS.has(key)) continue;
    if (shouldKeepParam(key)) {
      keptParams.push([key.toLowerCase(), value.toLowerCase()]);
    }
    // Unknown params: drop them (conservative — treats unknown = tracking)
  }

  // Sort kept params for stable key regardless of original order
  keptParams.sort(([a], [b]) => a.localeCompare(b));

  const canonical = new URL(url.origin);
  canonical.pathname = url.pathname.toLowerCase().replace(/\/+$/, ""); // strip trailing slash
  for (const [k, v] of keptParams) {
    canonical.searchParams.set(k, v);
  }
  // Strip hash — never meaningful for product identity
  canonical.hash = "";

  return canonical.toString();
}

/** Extract variant key-value pairs from a URL (for variant_hint storage). */
export function extractVariantHint(
  rawUrl: string
): Record<string, string> | null {
  let url: URL;
  try {
    url = new URL(rawUrl);
  } catch {
    return null;
  }

  const hint: Record<string, string> = {};
  for (const [key, value] of url.searchParams.entries()) {
    if (shouldKeepParam(key)) {
      hint[key] = value;
    }
  }
  return Object.keys(hint).length > 0 ? hint : null;
}

// ── Domain blocklist ─────────────────────────────────────────────────────────
// Can be used to flag sites requiring specific handling if needed. Empty to allow all e-commerce sites smoothly.
const BLOCKED_DOMAINS: Record<string, string> = {};

export interface BlockedDomainResult {
  blocked: boolean;
  apiAlternative?: string;
}

export function checkBlockedDomain(rawUrl: string): BlockedDomainResult {
  let hostname: string;
  try {
    hostname = new URL(rawUrl).hostname.replace(/^www\./, "");
  } catch {
    return { blocked: false };
  }

  const alternative = BLOCKED_DOMAINS[hostname];
  if (alternative) {
    return { blocked: true, apiAlternative: alternative };
  }
  return { blocked: false };
}
