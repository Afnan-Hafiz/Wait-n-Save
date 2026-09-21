/**
 * extractor.ts
 *
 * Client-side price/variant extraction running in the content script.
 * Has access to the FULLY RENDERED live DOM — no Playwright needed here.
 * Mirrors the server-side logic in priceFetcher.ts.
 */

export interface ExtractedProduct {
  title: string | null;
  imageUrl: string | null;
  price: number | null;
  currency: string | null;
  variantHint: Record<string, string> | null;
}

// ── Price parsing ─────────────────────────────────────────────────────────────
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

// ── JSON-LD extraction ────────────────────────────────────────────────────────
function extractFromJsonLd(): { price: number | null; currency: string | null } {
  const scripts = Array.from(document.querySelectorAll('script[type="application/ld+json"]'));
  for (const script of scripts) {
    try {
      const data: unknown = JSON.parse(script.textContent ?? "");
      const candidates = Array.isArray(data) ? data : [data];
      for (const node of candidates) {
        const obj = node as Record<string, unknown>;
        const type = obj["@type"];
        const types = Array.isArray(type) ? type : [type];
        if (!types.some((t) => typeof t === "string" && t.toLowerCase().includes("product"))) continue;

        const offers = obj["offers"] as unknown;
        const offerList = Array.isArray(offers) ? offers : offers ? [offers] : [];
        for (const offer of offerList) {
          const o = offer as Record<string, unknown>;
          const p = parsePrice(o["price"] ?? o["lowPrice"]);
          if (p !== null) {
            return { price: p, currency: (o["priceCurrency"] as string) ?? null };
          }
        }
      }
    } catch {
      // continue
    }
  }
  return { price: null, currency: null };
}

// ── Open Graph meta tags ──────────────────────────────────────────────────────
function extractFromOg(): { price: number | null; currency: string | null } {
  const priceEl =
    document.querySelector('meta[property="og:price:amount"]') ??
    document.querySelector('meta[property="product:price:amount"]');
  const currencyEl =
    document.querySelector('meta[property="og:price:currency"]') ??
    document.querySelector('meta[property="product:price:currency"]');
  return {
    price: parsePrice(priceEl?.getAttribute("content")),
    currency: currencyEl?.getAttribute("content") ?? null,
  };
}

// ── Microdata / itemprop ──────────────────────────────────────────────────────
function extractFromMicrodata(): { price: number | null; currency: string | null } {
  const el = document.querySelector('[itemprop="price"]');
  const currEl = document.querySelector('[itemprop="priceCurrency"]');
  return {
    price: parsePrice(el?.getAttribute("content") ?? el?.textContent),
    currency: currEl?.getAttribute("content") ?? null,
  };
}

// ── Currency detection helpers ──────────────────────────────────────────────
export function detectCurrencyFromText(text: string, hostname: string): string | null {
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

export function detectCurrencyFromHostname(hostname: string): string | null {
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

// ── CSS selector heuristics ───────────────────────────────────────────────────
const PRICE_SELECTORS = [
  '[data-testid="price"]',
  '[data-automation="buybox-price"]',
  ".price--highlight", ".price__current", ".price-current",
  ".product-price", ".sale-price", ".offer-price",
  "#priceblock_ourprice", "#priceblock_dealprice",
  ".a-price .a-offscreen",
  '[class*="price"][class*="sale"]',
  '[class*="current"][class*="price"]',
  ".pdp-price", ".PriceRange",
];

function extractFromSelectors(): { price: number | null; currency: string | null } {
  for (const sel of PRICE_SELECTORS) {
    const el = document.querySelector(sel);
    if (el) {
      const rawText = el.getAttribute("content") ?? el.textContent ?? "";
      const p = parsePrice(rawText);
      if (p !== null) {
        const containerText = `${el.parentElement?.textContent ?? ""} ${rawText}`;
        const curr = detectCurrencyFromText(containerText, window.location.hostname);
        return { price: p, currency: curr };
      }
    }
  }
  return { price: null, currency: null };
}

// ── Variant hint from URL + DOM ───────────────────────────────────────────────
const VARIANT_PARAMS = new Set([
  "variant", "variant_id", "size", "color", "colour", "style",
  "sku", "option", "option1", "option2", "option3", "selectedOption",
  "configuration", "itemId", "nid",
]);

function extractVariantHint(): Record<string, string> | null {
  const hint: Record<string, string> = {};

  // From URL params
  const params = new URL(window.location.href).searchParams;
  for (const [k, v] of params.entries()) {
    if (VARIANT_PARAMS.has(k) || /^dwvar_/.test(k)) {
      hint[k] = v;
    }
  }

  // From selected DOM elements (dropdowns, swatches)
  const selectedOption = document.querySelector(
    'select[name*="size"] option:checked, select[name*="color"] option:checked, ' +
    'select[name*="variant"] option:checked, [data-selected="true"][data-value]'
  );
  if (selectedOption) {
    const val =
      selectedOption.getAttribute("value") ??
      selectedOption.getAttribute("data-value");
    const name =
      selectedOption.closest("select")?.getAttribute("name") ?? "variant";
    if (val && name) hint[name] = val;
  }

  return Object.keys(hint).length > 0 ? hint : null;
}

// ── Title extraction ──────────────────────────────────────────────────────────
function extractTitle(): string | null {
  return (
    document
      .querySelector('[itemprop="name"]')
      ?.textContent?.trim() ??
    document
      .querySelector('meta[property="og:title"]')
      ?.getAttribute("content") ??
    document.title?.trim() ??
    null
  );
}

// ── Image extraction ──────────────────────────────────────────────────────────
function extractImage(): string | null {
  const og = document
    .querySelector('meta[property="og:image"]')
    ?.getAttribute("content");
  if (og) return og;

  const itemprop = document
    .querySelector('[itemprop="image"]')
    ?.getAttribute("content");
  if (itemprop) return itemprop;

  // Largest visible img heuristic
  const imgs = Array.from(document.querySelectorAll("img")).filter(
    (img) => img.naturalWidth > 100 && img.naturalHeight > 100
  );
  imgs.sort((a, b) => b.naturalWidth * b.naturalHeight - a.naturalWidth * a.naturalHeight);
  return imgs[0]?.src ?? null;
}

// ── Main export ───────────────────────────────────────────────────────────────
export function extractProduct(): ExtractedProduct {
  // Price chain: JSON-LD → OG → microdata → CSS selectors
  let price: number | null = null;
  let currency: string | null = null;

  const jsonLd = extractFromJsonLd();
  if (jsonLd.price !== null) {
    price = jsonLd.price;
    currency = jsonLd.currency;
  }

  if (price === null) {
    const og = extractFromOg();
    if (og.price !== null) { price = og.price; currency = og.currency; }
  }

  if (price === null) {
    const micro = extractFromMicrodata();
    if (micro.price !== null) { price = micro.price; currency = micro.currency; }
  }

  if (price === null) {
    const fromSel = extractFromSelectors();
    if (fromSel.price !== null) {
      price = fromSel.price;
      if (!currency && fromSel.currency) {
        currency = fromSel.currency;
      }
    }
  }

  if (!currency) {
    currency = inferCurrencyFromPage();
  }

  return {
    title: extractTitle(),
    imageUrl: extractImage(),
    price,
    currency,
    variantHint: extractVariantHint(),
  };
}

function inferCurrencyFromPage(): string {
  const host = window.location.hostname;

  // 1. Check known domain
  const fromHost = detectCurrencyFromHostname(host);
  if (fromHost) return fromHost;

  // 2. Scan body for unique Unicode symbols ONLY (no Latin letters that match English words)
  const body = document.body?.textContent ?? "";
  const unicodeSymbols: [string, string][] = [
    ["৳", "BDT"],
    ["€", "EUR"],
    ["£", "GBP"],
    ["₹", "INR"],
    ["₺", "TRY"],
    ["₩", "KRW"],
    ["₪", "ILS"],
    ["₫", "VND"],
    ["₱", "PHP"],
    ["฿", "THB"],
    ["₸", "KZT"],
    ["₴", "UAH"],
    ["₡", "CRC"],
    ["₲", "PYG"],
  ];
  for (const [sym, code] of unicodeSymbols) {
    if (body.includes(sym)) return code;
  }

  // 3. Look for digit-adjacent currency prefixes
  if (/\b(?:IDR|Rp\.?)\s*\d/i.test(body)) return "IDR";
  if (/\b(?:MYR|RM)\s*\d/i.test(body)) return "MYR";

  // 4. Lang/locale hint
  const langCode = (document.documentElement?.lang ?? "").toLowerCase().split("-")[0];
  const langMap: Record<string, string> = {
    "bn": "BDT", "tr": "TRY", "ko": "KRW", "ja": "JPY",
    "zh": "CNY", "th": "THB", "vi": "VND", "hi": "INR", "uk": "UAH",
  };
  if (langCode && langMap[langCode]) return langMap[langCode];

  // 5. If body has '$'
  if (body.includes("$")) {
    return detectCurrencyFromText("$", host) ?? "USD";
  }

  return "USD";
}
