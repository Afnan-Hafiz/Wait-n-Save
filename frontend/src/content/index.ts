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
  return new Promise((resolve) => {
    try {
      if (!chrome?.runtime?.id) {
        resolve({
          success: false,
          error: "Extension was reloaded. Please refresh the page.",
        });
        return;
      }
      chrome.runtime.sendMessage(msg, (response) => {
        if (chrome.runtime.lastError) {
          resolve({
            success: false,
            error: chrome.runtime.lastError.message || "Failed to communicate with extension",
          });
        } else if (!response) {
          resolve({
            success: false,
            error: "No response from extension background worker.",
          });
        } else {
          resolve(response);
        }
      });
    } catch (err) {
      resolve({
        success: false,
        error: err instanceof Error ? err.message : String(err),
      });
    }
  });
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
  let btn = document.getElementById(BUTTON_ID) as HTMLButtonElement | null;
  if (btn) return btn;

  // Styles injected inline so they work regardless of page CSS
  if (!document.getElementById("wns-styles")) {
    const style = document.createElement("style");
    style.id = "wns-styles";
    style.textContent = `
      #${BUTTON_ID} {
        all: initial;
        position: fixed;
        bottom: 24px;
        right: 24px;
        z-index: 2147483647;
        display: flex;
        align-items: center;
        gap: 9px;
        background: #0B0C10;
        color: #FFFFFF;
        font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif;
        font-size: 13px;
        font-weight: 700;
        letter-spacing: 0.05em;
        padding: 10px 18px;
        border-radius: 100px;
        border: 1px solid rgba(229, 169, 60, 0.45);
        cursor: pointer;
        box-shadow: 0 4px 20px rgba(0, 0, 0, 0.6), 0 0 14px rgba(229, 169, 60, 0.2);
        transition: all 0.2s cubic-bezier(0.16, 1, 0.3, 1);
        white-space: nowrap;
        user-select: none;
        box-sizing: border-box;
        line-height: normal;
      }
      #${BUTTON_ID}:hover {
        transform: translateY(-2px);
        border-color: #E5A93C;
        box-shadow: 0 6px 24px rgba(0, 0, 0, 0.7), 0 0 20px rgba(229, 169, 60, 0.35);
      }
      #${BUTTON_ID}:active { transform: translateY(0); }
      #${BUTTON_ID}.wns-tracked {
        background: #0B0C10;
        border-color: #22C55E;
        color: #4ADE80;
        box-shadow: 0 4px 20px rgba(0, 0, 0, 0.6), 0 0 16px rgba(34, 197, 94, 0.25);
      }
      #${BUTTON_ID}.wns-loading { opacity: 0.75; cursor: wait; pointer-events: none; }
      #${TOAST_ID} {
        all: initial;
        position: fixed;
        bottom: 84px;
        right: 24px;
        z-index: 2147483647;
        background: #13151E;
        color: #FFFFFF;
        font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif;
        font-size: 12px;
        font-weight: 500;
        padding: 12px 18px;
        border-radius: 10px;
        border: 1px solid rgba(229, 169, 60, 0.3);
        box-shadow: 0 10px 36px rgba(0, 0, 0, 0.7), 0 0 16px rgba(229, 169, 60, 0.15);
        opacity: 0;
        transform: translateY(8px);
        transition: all 0.25s ease;
        pointer-events: none;
        max-width: 320px;
        line-height: 1.4;
        box-sizing: border-box;
      }
      #${TOAST_ID}.wns-show { opacity: 1; transform: translateY(0); }
    `;
    (document.head || document.documentElement).appendChild(style);
  }

  btn = document.createElement("button");
  btn.id = BUTTON_ID;
  btn.innerHTML = "⭐ Star this item";
  (document.body || document.documentElement).appendChild(btn);

  if (!document.getElementById(TOAST_ID)) {
    const toast = document.createElement("div");
    toast.id = TOAST_ID;
    (document.body || document.documentElement).appendChild(toast);
  }

  // Attach persistent click handler immediately
  btn.addEventListener("click", () => void handleButtonClick(btn!));

  return btn;
}

function showToast(message: string, durationMs = 3500): void {
  const toast = document.getElementById(TOAST_ID);
  if (!toast) return;
  toast.textContent = message;
  toast.classList.add("wns-show");

  const existingTimer = (toast as unknown as { _timer?: ReturnType<typeof setTimeout> })._timer;
  if (existingTimer) clearTimeout(existingTimer);
  (toast as unknown as { _timer?: ReturnType<typeof setTimeout> })._timer = setTimeout(() => {
    toast.classList.remove("wns-show");
  }, durationMs);
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

// ── Check tracking and auth status ───────────────────────────────────────────
async function checkStatus(btn: HTMLButtonElement): Promise<void> {
  try {
    const authResp = await sendMessage({ type: "GET_AUTH" });
    if (!authResp.success || !authResp.data) {
      if (!btn.classList.contains("wns-loading")) {
        setButtonState(btn, "login_needed");
      }
      return;
    }

    const checkResp = await sendMessage({
      type: "CHECK_URL",
      payload: { url: window.location.href },
    });

    if (checkResp.success) {
      const statusData = checkResp.data as { tracked: boolean };
      if (statusData?.tracked) {
        setButtonState(btn, "tracked");
      } else {
        setButtonState(btn, "untracked");
      }
    }
  } catch (err) {
    console.debug("[Wait-n-Save] checkStatus error:", err);
  }
}

// ── Button Click Handler ──────────────────────────────────────────────────────
async function handleButtonClick(btn: HTMLButtonElement): Promise<void> {
  if (btn.classList.contains("wns-loading")) return;

  // 1. If currently tracked, clicking removes it
  if (btn.classList.contains("wns-tracked")) {
    setButtonState(btn, "loading");
    const untrackResp = await sendMessage({
      type: "UNTRACK_URL",
      payload: { url: window.location.href },
    });
    if (untrackResp.success) {
      setButtonState(btn, "untracked");
      showToast("🗑️ Removed from Price Watch");
    } else {
      setButtonState(btn, "tracked");
      showToast(`❌ ${untrackResp.error ?? "Failed to remove item"}`);
    }
    return;
  }

  // 2. User wants to star this item: check auth first
  setButtonState(btn, "loading");

  const authResp = await sendMessage({ type: "GET_AUTH" });
  if (!authResp.success || !authResp.data) {
    setButtonState(btn, "login_needed");
    showToast("⭐ Please click the Wait-n-Save extension icon in your toolbar to sign in first.", 4500);
    return;
  }

  // Extract live product from DOM
  let product;
  try {
    product = extractProduct();
  } catch (err) {
    console.error("[Wait-n-Save] Extractor error:", err);
    setButtonState(btn, "untracked");
    showToast("⚠️ Failed to parse product details from page.", 3500);
    return;
  }

  if (!product || product.price === null || isNaN(product.price) || product.price <= 0) {
    setButtonState(btn, "untracked");
    showToast("⚠️ Couldn't detect a price on this page. Try selecting a variant or size first.", 4000);
    return;
  }

  let currency = (product.currency || "").trim().toUpperCase();
  if (!/^[A-Z]{3}$/.test(currency)) {
    currency = "USD";
  }

  const response = await sendMessage({
    type: "STAR_ITEM",
    payload: {
      productUrl: window.location.href,
      title: product.title || document.title || "Tracked Product",
      imageUrl: product.imageUrl,
      price: product.price,
      currency,
      geoHint: navigator.language || "en",
      variantHint: product.variantHint,
    },
  });

  if (response.success) {
    setButtonState(btn, "tracked");
    const SYMBOLS: Record<string, string> = {
      BDT: "৳", USD: "$", EUR: "€", GBP: "£", INR: "₹", JPY: "¥",
      TRY: "₺", KRW: "₩", CAD: "CA$", AUD: "AU$",
    };
    const sym = SYMBOLS[currency];
    const num = product.price;
    const formattedNum = new Intl.NumberFormat(undefined, {
      minimumFractionDigits: num % 1 !== 0 ? 2 : 0,
      maximumFractionDigits: 2,
    }).format(num);
    const formattedPrice = sym ? `${sym} ${formattedNum}` : `${currency} ${formattedNum}`;
    showToast(`✅ Tracking "${product.title ?? "this item"}" at ${formattedPrice}`, 3500);
  } else {
    setButtonState(btn, "untracked");
    showToast(`❌ ${response.error ?? "Failed to save. Try again."}`, 4000);
  }
}

// ── Main initialization ───────────────────────────────────────────────────────
function init(): void {
  if (!isProductPage()) return;

  const btn = injectButton();
  void checkStatus(btn);

  // ── Listen for real-time messages from popup or background ─────────────────
  chrome.runtime.onMessage.addListener((msg: unknown) => {
    const m = msg as { type?: string; payload?: { url?: string } };
    const curBtn = document.getElementById(BUTTON_ID) as HTMLButtonElement | null;
    if (!curBtn) return;

    if (m?.type === "ITEM_UNTRACKED" || m?.type === "ITEM_TRACKED" || m?.type === "AUTH_CHANGED") {
      void checkStatus(curBtn);
    }
  });

  // ── Listen for storage auth changes (e.g. login/logout in popup) ───────────
  try {
    chrome.storage.onChanged.addListener((changes, area) => {
      if (area === "local" && changes["auth"]) {
        const curBtn = document.getElementById(BUTTON_ID) as HTMLButtonElement | null;
        if (curBtn) void checkStatus(curBtn);
      }
    });
  } catch {
    // Ignore if storage listener not supported in this context
  }
}

// ── Startup & SPA navigation observer ─────────────────────────────────────────
if (document.readyState === "loading") {
  document.addEventListener("DOMContentLoaded", () => init());
} else {
  init();
}

// Watch for client-side URL changes (SPA transitions on Amazon, Shopify, etc.)
let lastUrl = window.location.href;
setInterval(() => {
  if (window.location.href !== lastUrl) {
    lastUrl = window.location.href;
    if (isProductPage()) {
      const btn = injectButton();
      void checkStatus(btn);
    }
  }
}, 1500);
