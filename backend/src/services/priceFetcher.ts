/**
 * priceFetcher.ts
 *
 * Extraction chain (cheapest first):
 *   1. HTTP GET + Cheerio — JSON-LD Product/Offer → Open Graph → CSS selectors
 *   2. Playwright (Chromium headless) — same extraction on fully-rendered DOM
 *
 * Returns a FetchResult regardless of success/failure.
 * Callers must check `fetchStatus` before trusting `price`.
 */

import * as cheerio from "cheerio";
import { config } from "../config";
import { classifyResponse, FetchStatus } from "./botDetector";

export interface FetchResult {
  price: number | null;
  currency: string | null;
  /** Badge text like "Clearance", "Black Friday Deal" etc. */
  saleBadge: string | null;
  /** Retailer's own strikethrough price — display-only, not used as baseline */
  retailerOriginalPrice: number | null;
  fetchStatus: FetchStatus;
  /** Short HTML excerpt for debugging selector failures */
  rawHtmlSnippet: string;
}

// ── User-agent pool ───────────────────────────────────────────────────────────
const USER_AGENTS = [
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36",
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36",
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64; rv:128.0) Gecko/20100101 Firefox/128.0",
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 14_5) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.5 Safari/605.1.15",
];

function randomUA(): string {
  return USER_AGENTS[Math.floor(Math.random() * USER_AGENTS.length)];
}

// ── Sale-badge keyword detection ─────────────────────────────────────────────
const SALE_KEYWORDS = [
  "clearance", "sale", "discount", "deal", "offer",
  "black friday", "cyber monday", "flash sale", "limited time",
  "today only", "special price", "markdown", "reduced",
];

function detectSaleBadge(html: string): string | null {
  const lower = html.toLowerCase();
  for (const kw of SALE_KEYWORDS) {
    if (lower.includes(kw)) return kw;
  }
  return null;
}

// ── Price parsing helpers ────────────────────────────────────────────────────
function parsePrice(raw: unknown): number | null {
  if (raw === null || raw === undefined) return null;
  if (typeof raw === "number") {
    return isNaN(raw) || raw <= 0 ? null : raw;
  }
  const str = String(raw).trim().replace(/[^\d.,]/g, "");
  if (!str) return null;

  let normalised = str;
  const hasComma = str.includes(",");
  const hasDot = str.includes(".");

  if (hasComma && hasDot) {
    // Both comma and dot are present.
    // The separator that appears LAST is the decimal separator.
    if (str.lastIndexOf(",") > str.lastIndexOf(".")) {
      // European format: 1.234,56 or 1.234.567,89
      normalised = str.replace(/\./g, "").replace(",", ".");
    } else {
      // Standard format: 1,234.56 or 1,234,567.89
      normalised = str.replace(/,/g, "");
    }
  } else if (hasComma) {
    // Only comma(s) present, no dot.
    const commaCount = (str.match(/,/g) || []).length;
    // Multiple commas (e.g. 1,000,000 or 1,25,000) are thousands/lakh grouping separators.
    if (commaCount > 1) {
      normalised = str.replace(/,/g, "");
    } else {
      // Single comma:
      // European decimal (e.g. 12,50 or 9,99) has 1 or 2 digits after the comma.
      // Thousands separator (e.g. 2,899 or 4,500) has 3 digits after the comma.
      if (/,\d{1,2}$/.test(str)) {
        normalised = str.replace(",", ".");
      } else {
        normalised = str.replace(/,/g, "");
      }
    }
  } else if (hasDot) {
    // Only dot(s) present, no comma.
    const dotCount = (str.match(/\./g) || []).length;
    if (dotCount > 1) {
      // Multiple dots (e.g. 1.234.567) -> European thousands separators
      normalised = str.replace(/\./g, "");
    } else {
      // Single dot: standard decimal (e.g. 2899.99 or 12.50)
      normalised = str;
    }
  }

  const n = parseFloat(normalised);
  return isNaN(n) || n <= 0 ? null : n;
}

// ── Currency detection helpers ──────────────────────────────────────────────
function detectCurrencyFromText(text: string, hostname: string): string | null {
  if (!text) return null;
  const host = (hostname || "").toLowerCase();

  // Multi-char explicit symbols / codes first
  if (/\b(?:US\$|USD)\b/i.test(text)) return "USD";
  if (/\b(?:CA\$|CAD)\b/i.test(text)) return "CAD";
  if (/\b(?:AU\$|AUD|A\$)\b/i.test(text)) return "AUD";
  if (/\b(?:NZ\$|NZD)\b/i.test(text)) return "NZD";
  if (/\b(?:HK\$|HKD)\b/i.test(text)) return "HKD";
  if (/\b(?:SG\$|SGD|S\$)\b/i.test(text)) return "SGD";
  if (/\b(?:R\$|BRL)\b/i.test(text)) return "BRL";
  if (/\b(?:BDT|Tk\.?)\b/i.test(text)) return "BDT";
  if (/\b(?:EUR)\b/i.test(text)) return "EUR";
  if (/\b(?:GBP)\b/i.test(text)) return "GBP";
  if (/\b(?:INR)\b/i.test(text)) return "INR";
  if (/\b(?:JPY)\b/i.test(text)) return "JPY";
  if (/\b(?:CNY|RMB)\b/i.test(text)) return "CNY";
  if (/\b(?:TRY|TL)\b/i.test(text)) return "TRY";
  if (/\b(?:KRW)\b/i.test(text)) return "KRW";
  if (/\b(?:IDR)\b/i.test(text) || /(?:^|\s)Rp\.?\s*\d/i.test(text)) return "IDR";
  if (/\b(?:MYR)\b/i.test(text) || /(?:^|\s)RM\s*\d/i.test(text)) return "MYR";
  if (/\b(?:THB)\b/i.test(text)) return "THB";
  if (/\b(?:VND)\b/i.test(text)) return "VND";
  if (/\b(?:PHP)\b/i.test(text)) return "PHP";
  if (/\b(?:PLN)\b/i.test(text) || /zł/i.test(text)) return "PLN";

  // Unique Unicode currency symbols
  if (text.includes("৳")) return "BDT";
  if (text.includes("€")) return "EUR";
  if (text.includes("£")) return "GBP";
  if (text.includes("₹")) return "INR";
  if (text.includes("₺")) return "TRY";
  if (text.includes("₩")) return "KRW";
  if (text.includes("₪")) return "ILS";
  if (text.includes("₫")) return "VND";
  if (text.includes("₱")) return "PHP";
  if (text.includes("฿")) return "THB";
  if (text.includes("₸")) return "KZT";
  if (text.includes("₴")) return "UAH";
  if (text.includes("₡")) return "CRC";
  if (text.includes("₲")) return "PYG";
  if (text.includes("¥")) {
    if (host.endsWith(".cn") || host.includes("taobao") || host.includes("jd.com")) return "CNY";
    return "JPY";
  }

  // Dollar symbol '$' — resolve by domain
  if (text.includes("$")) {
    if (host.endsWith(".ca") || host.includes("amazon.ca")) return "CAD";
    if (host.endsWith(".au") || host.includes("amazon.com.au")) return "AUD";
    if (host.endsWith(".nz")) return "NZD";
    if (host.endsWith(".sg")) return "SGD";
    if (host.endsWith(".hk")) return "HKD";
    if (host.endsWith(".br") || host.includes("amazon.com.br")) return "BRL";
    if (host.endsWith(".mx")) return "MXN";
    return "USD";
  }

  return null;
}

function detectCurrencyFromHostname(hostname: string): string | null {
  const host = (hostname || "").toLowerCase().replace(/^www\./, "");

  // Major known retailers
  if (host === "amazon.com" || host.endsWith(".amazon.com")) return "USD";
  if (host === "amazon.co.uk") return "GBP";
  if (host === "amazon.ca") return "CAD";
  if (host === "amazon.de" || host === "amazon.fr" || host === "amazon.it" || host === "amazon.es" || host === "amazon.nl") return "EUR";
  if (host === "amazon.co.jp") return "JPY";
  if (host === "amazon.in") return "INR";
  if (host === "amazon.com.au") return "AUD";
  if (host === "amazon.com.br") return "BRL";
  if (host === "amazon.com.mx") return "MXN";
  if (host === "daraz.com.bd") return "BDT";
  if (host === "daraz.pk") return "PKR";
  if (host === "daraz.lk") return "LKR";
  if (host === "daraz.com.np") return "NPR";
  if (host === "walmart.com" || host === "target.com" || host === "bestbuy.com") return "USD";

  // TLD suffixes
  if (host.endsWith(".bd") || host.endsWith(".com.bd")) return "BDT";
  if (host.endsWith(".uk") || host.endsWith(".co.uk")) return "GBP";
  if (host.endsWith(".ca")) return "CAD";
  if (host.endsWith(".au") || host.endsWith(".com.au")) return "AUD";
  if (host.endsWith(".in") || host.endsWith(".co.in")) return "INR";
  if (host.endsWith(".jp") || host.endsWith(".co.jp")) return "JPY";
  if (host.endsWith(".kr") || host.endsWith(".co.kr")) return "KRW";
  if (host.endsWith(".de") || host.endsWith(".fr") || host.endsWith(".it") || host.endsWith(".es") || host.endsWith(".nl")) return "EUR";
  if (host.endsWith(".tr") || host.endsWith(".com.tr")) return "TRY";
  if (host.endsWith(".za") || host.endsWith(".co.za")) return "ZAR";

  return null;
}

// ── Symbol-based currency inference (server-side fallback) ────────────────────
function inferCurrencyFromHtml(html: string, pageUrl: string): string | null {
  let hostname = "";
  try {
    hostname = new URL(pageUrl).hostname;
  } catch {
    // ignore
  }

  const fromHost = detectCurrencyFromHostname(hostname);
  if (fromHost) return fromHost;

  const unicodeSymbols: [string, string][] = [
    ["৳", "BDT"], ["€", "EUR"], ["£", "GBP"], ["₹", "INR"],
    ["₺", "TRY"], ["₩", "KRW"], ["₪", "ILS"], ["₫", "VND"],
    ["₱", "PHP"], ["฿", "THB"], ["₸", "KZT"], ["₴", "UAH"],
    ["₡", "CRC"], ["₲", "PYG"],
  ];
  for (const [sym, code] of unicodeSymbols) {
    if (html.includes(sym)) return code;
  }

  if (/\b(?:IDR|Rp\.?)\s*\d/i.test(html)) return "IDR";
  if (/\b(?:MYR|RM)\s*\d/i.test(html)) return "MYR";

  if (html.includes("$")) {
    return detectCurrencyFromText("$", hostname) ?? "USD";
  }

  return null;
}

// ── Cheerio extraction ────────────────────────────────────────────────────────
interface ExtractionResult {
  price: number | null;
  currency: string | null;
  retailerOriginalPrice: number | null;
  saleBadge: string | null;
}

function extractFromHtml(html: string, pageUrl: string): ExtractionResult {
  const $ = cheerio.load(html);
  let price: number | null = null;
  let currency: string | null = null;
  let retailerOriginalPrice: number | null = null;

  // ── 1. JSON-LD: schema.org Product/Offer ─────────────────────────────────
  $('script[type="application/ld+json"]').each((_, el) => {
    if (price !== null) return; // already found
    try {
      const raw = $(el).html() ?? "";
      const data: unknown = JSON.parse(raw);
      const candidates = Array.isArray(data) ? data : [data];
      for (const node of candidates) {
        const obj = node as Record<string, unknown>;
        const type = obj["@type"];
        const types = Array.isArray(type) ? type : [type];
        if (!types.some((t) => typeof t === "string" && t.toLowerCase().includes("product"))) continue;

        // offers can be a single object or an array
        const offers = obj["offers"] as unknown;
        const offerList = Array.isArray(offers) ? offers : offers ? [offers] : [];

        for (const offer of offerList) {
          const o = offer as Record<string, unknown>;
          const p = parsePrice(o["price"] ?? o["lowPrice"]);
          if (p !== null) {
            price = p;
            currency = (o["priceCurrency"] as string) ?? null;
            break;
          }
        }
        if (price !== null) break;
      }
    } catch {
      // Malformed JSON-LD — continue to next strategy
    }
  });

  // ── 2. Open Graph price meta tags ─────────────────────────────────────────
  if (price === null) {
    const ogPrice = $('meta[property="og:price:amount"]').attr("content")
      ?? $('meta[property="product:price:amount"]').attr("content");
    if (ogPrice) price = parsePrice(ogPrice);

    const ogCurrency = $('meta[property="og:price:currency"]').attr("content")
      ?? $('meta[property="product:price:currency"]').attr("content");
    if (ogCurrency) currency = ogCurrency;
  }

  // ── 3. Standard microdata / itemprop ──────────────────────────────────────
  if (price === null) {
    const itemprop = $('[itemprop="price"]').first();
    const val = itemprop.attr("content") ?? itemprop.text();
    price = parsePrice(val);
    const curr = $('[itemprop="priceCurrency"]').first().attr("content");
    if (curr) currency = curr;
  }

  // ── 4. Common CSS selectors (heuristic fallback) ──────────────────────────
  if (price === null) {
    const priceSelectors = [
      '[data-testid="price"]',
      '[data-automation="buybox-price"]',
      ".price--highlight", ".price__current", ".price-current",
      ".product-price", ".sale-price", ".offer-price",
      "#priceblock_ourprice", "#priceblock_dealprice",  // Amazon (fallback)
      ".a-price .a-offscreen",
      '[class*="price"][class*="sale"]',
      '[class*="current"][class*="price"]',
      ".pdp-price", ".PriceRange", ".Price",
    ];
    for (const sel of priceSelectors) {
      const el = $(sel).first();
      if (el.length) {
        const raw = el.attr("content") ?? el.text();
        const p = parsePrice(raw);
        if (p !== null) {
          price = p;
          if (!currency) {
            let host = "";
            try { host = new URL(pageUrl).hostname; } catch {}
            currency = detectCurrencyFromText(`${el.parent().text()} ${raw}`, host);
          }
          break;
        }
      }
    }
  }

  // ── Retailer's advertised original / strikethrough price ──────────────────
  const strikethroughSelectors = [
    'del [itemprop="price"]', "del .price", "s .price",
    "[data-testid='price-was']", ".price--compare",
    ".was-price", ".original-price", ".price__was",
    "#priceblock_ourprice del",
  ];
  for (const sel of strikethroughSelectors) {
    const el = $(sel).first();
    if (el.length) {
      const p = parsePrice(el.attr("content") ?? el.text());
      if (p !== null) { retailerOriginalPrice = p; break; }
    }
  }

  // ── Sale badge ─────────────────────────────────────────────────────────────
  const saleBadge = detectSaleBadge(
    [$('[class*="badge"]', "sale-label", "promo-label").text(), html.substring(0, 50_000)].join(" ")
  );

  // ── 5. Symbol-based currency inference (last resort) ────────────────────────
  // Runs even when price came from a structured source but lacked priceCurrency
  if (currency === null) {
    currency = inferCurrencyFromHtml(html, pageUrl);
  }

  return { price, currency, retailerOriginalPrice, saleBadge };
}

// ── Main fetch function ───────────────────────────────────────────────────────
export async function fetchPrice(
  url: string,
  geoHint?: string | null
): Promise<FetchResult> {
  const ua = randomUA();
  const lang = geoHint ?? "en-US";

  // ── Step 1: HTTP fetch + Cheerio ──────────────────────────────────────────
  try {
    const response = await fetch(url, {
      headers: {
        "User-Agent": ua,
        "Accept": "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
        "Accept-Language": `${lang},en;q=0.9`,
        "Accept-Encoding": "gzip, deflate, br",
        "Cache-Control": "no-cache",
        "Pragma": "no-cache",
        // Spoof referrer as the site's own homepage
        "Referer": new URL(url).origin + "/",
      },
      redirect: "follow",
      signal: AbortSignal.timeout(15_000),
    });

    const html = await response.text();
    const finalUrl = response.url;
    const status = classifyResponse(html, response.status, finalUrl);

    if (status !== "ok") {
      // Try Playwright before giving up on bot-block
      if (status === "bot_blocked" && !config.disablePlaywright) {
        return await fetchWithPlaywright(url, lang, status);
      }
      return {
        price: null, currency: null, saleBadge: null,
        retailerOriginalPrice: null, fetchStatus: status,
        rawHtmlSnippet: html.substring(0, 500),
      };
    }

    const extracted = extractFromHtml(html, url);
    if (extracted.price === null && !config.disablePlaywright) {
      // SPA shell — escalate to Playwright
      return await fetchWithPlaywright(url, lang, "parse_error");
    }

    return {
      ...extracted,
      fetchStatus: extracted.price !== null ? "ok" : "parse_error",
      rawHtmlSnippet: html.substring(0, 500),
    };
  } catch (err) {
    console.error(`[priceFetcher] HTTP fetch failed for ${url}:`, err);
    // If network error and Playwright is enabled, try it
    if (!config.disablePlaywright) {
      return await fetchWithPlaywright(url, lang, "parse_error");
    }
    return {
      price: null, currency: null, saleBadge: null,
      retailerOriginalPrice: null, fetchStatus: "parse_error",
      rawHtmlSnippet: "",
    };
  }
}

// ── Playwright fallback ────────────────────────────────────────────────────────
async function fetchWithPlaywright(
  url: string,
  lang: string,
  fallbackStatus: FetchStatus
): Promise<FetchResult> {
  if (config.disablePlaywright) {
    return {
      price: null, currency: null, saleBadge: null,
      retailerOriginalPrice: null, fetchStatus: fallbackStatus,
      rawHtmlSnippet: "",
    };
  }

  let browser: import("playwright").Browser | null = null;
  try {
    const { chromium } = await import("playwright");
    browser = await chromium.launch({ headless: true });
    const context = await browser.newContext({
      userAgent: randomUA(),
      locale: lang,
      extraHTTPHeaders: { "Accept-Language": `${lang},en;q=0.9` },
    });
    const page = await context.newPage();

    await page.goto(url, { waitUntil: "networkidle", timeout: 30_000 });

    const finalUrl = page.url();
    const html = await page.content();
    const status = classifyResponse(html, 200, finalUrl);

    if (status !== "ok") {
      return {
        price: null, currency: null, saleBadge: null,
        retailerOriginalPrice: null, fetchStatus: status,
        rawHtmlSnippet: html.substring(0, 500),
      };
    }

    const extracted = extractFromHtml(html, url);
    return {
      ...extracted,
      fetchStatus: extracted.price !== null ? "ok" : "parse_error",
      rawHtmlSnippet: html.substring(0, 500),
    };
  } catch (err) {
    console.error(`[priceFetcher] Playwright failed for ${url}:`, err);
    return {
      price: null, currency: null, saleBadge: null,
      retailerOriginalPrice: null, fetchStatus: "parse_error",
      rawHtmlSnippet: "",
    };
  } finally {
    await browser?.close();
  }
}
