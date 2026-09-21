/**
 * content/index.ts
 *
 * Injected into every page. Responsibilities:
 *   1. Detect if the current page looks like a product page
 *   2. Inject a floating "⭐ Star this item" button
 *   3. Check tracked state and update button appearance
 *   4. On click: extract product data and send to background worker
 *   5. Show toast notifications for feedback
 */

import { extractProduct } from "../shared/extractor";
import type { Message, MessageResponse } from "../shared/types";

// ── Constants ─────────────────────────────────────────────────────────────────
const BUTTON_ID = "wns-star-btn";
const TOAST_ID = "wns-toast";

// ── Helpers ───────────────────────────────────────────────────────────────────
function sendMessage(msg: Message): Promise<MessageResponse> {
  return chrome.runtime.sendMessage(msg);
}

function isProductPage(): boolean {
  const url = window.location.href;
  const host = window.location.hostname.replace(/^www\./, "");

  // ── 1. Schema.org Product microdata ────────────────────────────────────────
  if (document.querySelector('[itemtype*="schema.org/Product"]')) return true;
  if (document.querySelector('[itemprop="price"], [itemprop="offers"]')) return true;

  // ── 2. JSON-LD with @type: Product (NOT just any JSON-LD) ──────────────────
  for (const el of Array.from(document.querySelectorAll('script[type="application/ld+json"]'))) {
    try {
      const raw = JSON.parse(el.textContent ?? "{}");
      const entries: unknown[] = Array.isArray(raw) ? raw : [raw];
      for (const entry of entries) {
        const t = (entry as Record<string, unknown>)["@type"];
        const types = Array.isArray(t) ? t : [t];
        if (types.some((v) => typeof v === "string" && /product/i.test(v))) return true;
      }
    } catch { /* malformed JSON — skip */ }
  }

  // ── 3. Open Graph product type ─────────────────────────────────────────────
  const ogType = document.querySelector('meta[property="og:type"]')?.getAttribute("content") ?? "";
  if (/product/i.test(ogType)) return true;
  if (document.querySelector('meta[property="og:price:amount"], meta[property="product:price:amount"]')) return true;

  // ── 4. URL path segments typical of product pages ──────────────────────────
  if (/\/(product|products|item|items|p|dp|detail|pd|goods|sku|listing|buy)[\/-]/i.test(url)) return true;
  if (/[?&](sku|productId|itemId|product_id|pid|asin|pId)=/i.test(url)) return true;

  // ── 5. Known e-commerce domains ────────────────────────────────────────────
  const ecommerceDomains = [
    // Global
    "amazon.", "ebay.", "walmart.", "etsy.", "aliexpress.", "alibaba.",
    "rakuten.", "wish.", "mercari.", "poshmark.", "depop.",
    // South Asia / Bangladesh
    "daraz.", "chaldal.", "shajgoj.", "ryans.", "startech.", "techland.",
    "pickaboo.", "rokomari.", "ajkerdeal.", "bagdoom.", "sheba.",
    // India
    "flipkart.", "myntra.", "ajio.", "nykaa.", "meesho.", "snapdeal.", "tatacliq.",
    // Southeast Asia
    "lazada.", "shopee.", "tokopedia.", "bukalapak.", "blibli.", "zalora.",
    // China
    "jd.com", "taobao.", "tmall.", "pinduoduo.",
    // Europe / Fashion
    "zalando.", "asos.", "zara.", "hm.", "uniqlo.", "manomano.",
    // US / Electronics
    "target.", "bestbuy.", "newegg.", "bhphotovideo.", "adorama.", "microcenter.",
    // Middle East
    "noon.", "namshi.",
    // Korea / Japan
    "coupang.", "gmarket.", "kakaku.",
    // Turkey
    "trendyol.", "hepsiburada.", "n11.com",
    // Africa
    "jumia.", "konga.",
  ];
  if (ecommerceDomains.some((d) => host.includes(d))) return true;

  return false;
}

// ── Button injection ──────────────────────────────────────────────────────────
function injectButton(): HTMLButtonElement {
  if (document.getElementById(BUTTON_ID)) {
    return document.getElementById(BUTTON_ID) as HTMLButtonElement;
  }

  // Styles injected inline so they work regardless of page CSS
  const style = document.createElement("style");
  style.textContent = `
    #${BUTTON_ID} {
      all: initial;
      position: fixed;
      bottom: 24px;
      right: 24px;
      z-index: 2147483647;
      display: flex;
      align-items: center;
      gap: 8px;
      background: linear-gradient(135deg, #6c3fff, #a855f7);
      color: #fff;
      font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif;
      font-size: 14px;
      font-weight: 600;
      padding: 10px 18px;
      border-radius: 100px;
      border: none;
      cursor: pointer;
      box-shadow: 0 4px 24px rgba(108, 63, 255, 0.45);
      transition: all 0.2s ease;
      letter-spacing: 0.2px;
      white-space: nowrap;
    }
    #${BUTTON_ID}:hover {
      transform: translateY(-2px);
      box-shadow: 0 8px 32px rgba(108, 63, 255, 0.55);
    }
    #${BUTTON_ID}:active { transform: translateY(0); }
    #${BUTTON_ID}.wns-tracked {
      background: linear-gradient(135deg, #059669, #34d399);
      box-shadow: 0 4px 24px rgba(52, 211, 153, 0.35);
    }
    #${BUTTON_ID}.wns-loading { opacity: 0.7; cursor: wait; }
    #${TOAST_ID} {
      all: initial;
      position: fixed;
      bottom: 80px;
      right: 24px;
      z-index: 2147483647;
      background: #1a1a24;
      color: #f1f5f9;
      font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif;
      font-size: 13px;
      font-weight: 500;
      padding: 10px 16px;
      border-radius: 10px;
      border: 1px solid #2d2d3d;
      box-shadow: 0 8px 32px rgba(0,0,0,0.4);
      opacity: 0;
      transform: translateY(8px);
      transition: all 0.25s ease;
      pointer-events: none;
    }
    #${TOAST_ID}.wns-show { opacity: 1; transform: translateY(0); }
  `;
  document.head.appendChild(style);

  const btn = document.createElement("button");
  btn.id = BUTTON_ID;
  btn.innerHTML = "⭐ Star this item";
  document.body.appendChild(btn);

  const toast = document.createElement("div");
  toast.id = TOAST_ID;
  document.body.appendChild(toast);

  return btn;
}

function showToast(message: string, durationMs = 3000): void {
  const toast = document.getElementById(TOAST_ID);
  if (!toast) return;
  toast.textContent = message;
  toast.classList.add("wns-show");
  setTimeout(() => toast.classList.remove("wns-show"), durationMs);
}

function setButtonState(
  btn: HTMLButtonElement,
  state: "untracked" | "tracked" | "loading" | "login_needed"
): void {
  btn.classList.remove("wns-tracked", "wns-loading");
  switch (state) {
    case "tracked":
      btn.innerHTML = "✓ Tracked";
      btn.classList.add("wns-tracked");
      break;
    case "loading":
      btn.innerHTML = "⏳ Saving…";
      btn.classList.add("wns-loading");
      break;
    case "login_needed":
      btn.innerHTML = "⭐ Sign in to track";
      break;
    default:
      btn.innerHTML = "⭐ Star this item";
  }
}

// ── Main logic ────────────────────────────────────────────────────────────────
async function init(): Promise<void> {
  if (!isProductPage()) return;

  const btn = injectButton();

  // ── Check auth state ─────────────────────────────────────────────────────
  const authResp = await sendMessage({ type: "GET_AUTH" });
  if (!authResp.success || !authResp.data) {
    setButtonState(btn, "login_needed");
    btn.addEventListener("click", () => {
      chrome.runtime.openOptionsPage?.();
      // Open popup as fallback
      showToast("Click the Wait-n-Save icon to sign in first.");
    });
    return;
  }

  // ── Check if current URL is already tracked ──────────────────────────────
  const checkResp = await sendMessage({
    type: "CHECK_URL",
    payload: { url: window.location.href },
  });

  if (checkResp.success) {
    const statusData = checkResp.data as { tracked: boolean };
    if (statusData.tracked) {
      setButtonState(btn, "tracked");
    }
  }

  // ── Star button click handler ────────────────────────────────────────────
  btn.addEventListener("click", async () => {
    if (btn.classList.contains("wns-tracked")) {
      showToast("✓ Already tracking this item.");
      return;
    }

    setButtonState(btn, "loading");

    const product = extractProduct();

    if (product.price === null) {
      showToast("⚠️ Couldn't detect a price on this page. Try selecting a variant first.");
      setButtonState(btn, "untracked");
      return;
    }

    const response = await sendMessage({
      type: "STAR_ITEM",
      payload: {
        productUrl: window.location.href,
        title: product.title,
        imageUrl: product.imageUrl,
        price: product.price,
        currency: product.currency ?? "USD",
        geoHint: navigator.language,
        variantHint: product.variantHint,
      },
    });

    if (response.success) {
      setButtonState(btn, "tracked");
      const currency = product.currency ?? "USD";
      const SYMBOLS: Record<string, string> = {
        BDT: "৳", USD: "$", EUR: "€", GBP: "£", INR: "₹", JPY: "¥",
        TRY: "₺", KRW: "₩", CAD: "CA$", AUD: "AU$",
      };
      const sym = SYMBOLS[currency];
      const num = product.price!;
      const formattedNum = new Intl.NumberFormat(undefined, {
        minimumFractionDigits: num % 1 !== 0 ? 2 : 0,
        maximumFractionDigits: 2,
      }).format(num);
      const formattedPrice = sym ? `${sym} ${formattedNum}` : `${currency} ${formattedNum}`;
      showToast(`✅ Tracking "${product.title ?? "this item"}" at ${formattedPrice}`);
    } else {
      setButtonState(btn, "untracked");
      showToast(`❌ ${response.error ?? "Failed to save. Try again."}`);
    }
  });
}

// Run after DOM is ready
if (document.readyState === "loading") {
  document.addEventListener("DOMContentLoaded", () => void init());
} else {
  void init();
}
