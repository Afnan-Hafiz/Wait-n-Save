import "./popup.css";
import type { Message, MessageResponse, ApiItem } from "../shared/types";

async function handleManualAdd(e: Event): Promise<void> {
  e.preventDefault();
  const url      = ($('manual-url')      as HTMLInputElement).value.trim();
  const title    = ($('manual-title')    as HTMLInputElement).value.trim();
  const priceStr = ($('manual-price')    as HTMLInputElement).value.trim();
  const currency = ($('manual-currency') as HTMLSelectElement).value;
  const errEl    = $('manual-error');
  const btn      = $('btn-manual') as HTMLButtonElement;

  errEl.textContent = '';

  const price = parseFloat(priceStr);
  if (!url) { errEl.textContent = 'Please enter a product URL.'; return; }
  if (!title) { errEl.textContent = 'Please enter an item name.'; return; }
  if (isNaN(price) || price <= 0) { errEl.textContent = 'Please enter a valid price greater than 0.'; return; }

  btn.disabled = true;
  btn.textContent = 'Saving…';

  const resp = await sendMessage({
    type: 'STAR_ITEM',
    payload: { productUrl: url, title, price, currency, geoHint: navigator.language, imageUrl: null, variantHint: null },
  });

  btn.disabled = false;
  btn.textContent = '⭐ Track this item';

  if (resp.success) {
    // Clear form and go back to main
    ($('manual-url')   as HTMLInputElement).value = '';
    ($('manual-title') as HTMLInputElement).value = '';
    ($('manual-price') as HTMLInputElement).value = '';
    errEl.textContent = '';
    showView('main');
    await loadItems();
  } else {
    errEl.textContent = resp.error ?? 'Failed to save. Try again.';
  }
}

// ── Helpers ───────────────────────────────────────────────────────────────────
function sendMessage(msg: Message): Promise<MessageResponse> {
  return chrome.runtime.sendMessage(msg);
}

function $(id: string): HTMLElement {
  const el = document.getElementById(id);
  if (!el) throw new Error(`Element #${id} not found`);
  return el;
}

function showView(name: "login" | "register" | "forgot" | "reset" | "manual" | "main"): void {
  for (const v of ["login", "register", "forgot", "reset", "manual", "main"]) {
    $(`view-${v}`).classList.toggle("hidden", v !== name);
  }
  document.body.classList.toggle("logged-in", name === "main" || name === "manual");
}

function formatCurrency(amount: string | null, currency: string): string {
  if (!amount) return "—";
  const num = parseFloat(amount);
  if (isNaN(num)) return "—";
  const code = (currency || "").trim().toUpperCase() || "USD";

  const SYMBOLS: Record<string, string> = {
    BDT: "৳",
    USD: "$",
    EUR: "€",
    GBP: "£",
    INR: "₹",
    JPY: "¥",
    TRY: "₺",
    KRW: "₩",
    ILS: "₪",
    PHP: "₱",
    THB: "฿",
    BRL: "R$",
    CAD: "CA$",
    AUD: "AU$",
  };

  const sym = SYMBOLS[code];
  const hasDecimals = num % 1 !== 0;
  const formattedNum = new Intl.NumberFormat(undefined, {
    minimumFractionDigits: hasDecimals ? 2 : 0,
    maximumFractionDigits: 2,
  }).format(num);

  if (sym) {
    return `${sym} ${formattedNum}`;
  }

  try {
    return new Intl.NumberFormat(undefined, {
      style: "currency",
      currency: code,
      currencyDisplay: "narrowSymbol",
      minimumFractionDigits: hasDecimals ? 2 : 0,
      maximumFractionDigits: 2,
    }).format(num);
  } catch {
    return `${code} ${formattedNum}`;
  }
}

function statusLabel(status: string): string {
  const map: Record<string, string> = {
    ok: "",
    bot_blocked: "⚠ Site blocking — check may fail",
    login_gated: "🔒 Login-gated pricing",
    delisted: "❌ Item removed",
    parse_error: "⚠ Price unavailable",
    currency_mismatch: "⚠ Currency mismatch",
  };
  return map[status] ?? status;
}

function statusClass(status: string): string {
  if (status === "ok") return "";
  if (status === "delisted" || status === "login_gated") return "status-error";
  return "status-blocked";
}

// ── Item card builder ──────────────────────────────────────────────────────────
function buildItemCard(item: ApiItem): HTMLLIElement {
  const li = document.createElement("li");
  li.className = "item-card";
  li.dataset["itemId"] = item.id;

  const origPrice = parseFloat(item.original_price);
  const currPrice = item.current_price ? parseFloat(item.current_price) : null;
  const pctOff = item.pct_off ? parseInt(item.pct_off, 10) : null;
  const priceDropped = currPrice !== null && currPrice < origPrice;

  const thumb = item.image_url
    ? `<img class="item-thumb" src="${item.image_url}" alt="" loading="lazy" />`
    : `<div class="item-thumb-placeholder">🛍️</div>`;

  const currPriceHtml = currPrice !== null
    ? `<span class="price-current ${priceDropped ? "" : "same"}">${formatCurrency(String(currPrice), item.currency)}</span>
       ${pctOff && pctOff > 0 ? `<span class="pct-badge">-${pctOff}%</span>` : ""}`
    : `<span class="price-current same">Not checked yet</span>`;

  const statusText = statusLabel(item.fetch_status);
  const statusHtml = statusText
    ? `<div class="item-status ${statusClass(item.fetch_status)}">${statusText}</div>`
    : "";

  const variantHint = item.variant_hint
    ? Object.entries(item.variant_hint).map(([k, v]) => `${k}: ${v}`).join(", ")
    : "";

  li.innerHTML = `
    ${thumb}
    <div class="item-body">
      <a class="item-title" href="${item.product_url}" target="_blank" rel="noopener noreferrer"
         title="${item.title ?? item.product_url}">
        ${item.title ?? item.product_url}
        ${variantHint ? `<span style="color:var(--text-dim);font-weight:400"> (${variantHint})</span>` : ""}
      </a>
      <div class="item-prices">
        ${priceDropped ? `<span class="price-original">${formatCurrency(item.original_price, item.currency)}</span>` : ""}
        ${currPriceHtml}
      </div>
      ${statusHtml}
    </div>
    <div class="item-actions">
      <button class="btn-untrack" data-item-id="${item.id}" aria-label="Untrack">✕</button>
    </div>
  `;

  return li;
}

// ── Load items ─────────────────────────────────────────────────────────────────
async function loadItems(): Promise<void> {
  const loading = $("items-loading");
  const empty = $("items-empty");
  const list = $("items-list") as HTMLUListElement;
  const countBadge = $("items-count");

  loading.classList.remove("hidden");
  empty.classList.add("hidden");
  list.innerHTML = "";

  const resp = await sendMessage({ type: "GET_ITEMS" });
  loading.classList.add("hidden");

  if (!resp.success) {
    empty.classList.remove("hidden");
    return;
  }

  const items = resp.data as ApiItem[];
  const active = items.filter((i) => i.is_active);

  countBadge.textContent = String(active.length);

  if (active.length === 0) {
    empty.classList.remove("hidden");
    return;
  }

  for (const item of active) {
    list.appendChild(buildItemCard(item));
  }

  // Delegate untrack click
  list.addEventListener("click", async (e) => {
    const btn = (e.target as HTMLElement).closest(".btn-untrack") as HTMLButtonElement | null;
    if (!btn) return;
    const itemId = btn.dataset["itemId"];
    if (!itemId) return;
    btn.disabled = true;
    btn.textContent = "…";
    const delResp = await sendMessage({ type: "DELETE_ITEM", payload: { itemId } });
    if (delResp.success) {
      btn.closest(".item-card")?.remove();
      const count = list.querySelectorAll(".item-card").length;
      countBadge.textContent = String(count);
      if (count === 0) empty.classList.remove("hidden");
    } else {
      btn.disabled = false;
      btn.textContent = "✕";
    }
  });
}

// ── Current page status ────────────────────────────────────────────────────────
async function checkCurrentPage(): Promise<void> {
  const bar = $("current-page-bar");
  const barText = $("page-bar-text");

  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  if (!tab?.url || !tab.url.startsWith("http")) return;

  const resp = await sendMessage({ type: "CHECK_URL", payload: { url: tab.url } });
  if (!resp.success) return;

  const data = resp.data as { tracked: boolean; blockedDomain: boolean; item?: { fetch_status: string } };

  if (data.blockedDomain) {
    bar.className = "page-bar blocked";
    barText.textContent = "⚠ This site restricts price tracking";
    bar.classList.remove("hidden");
  } else if (data.tracked) {
    bar.className = "page-bar tracked";
    barText.textContent = "✓ Tracking this page";
    bar.classList.remove("hidden");
  }
}

async function handleForgotPassword(e: Event): Promise<void> {
  e.preventDefault();
  const email = ($('forgot-email') as HTMLInputElement).value.trim();
  const errEl = $('forgot-error');
  const successEl = $('forgot-success');
  const btn = $('btn-forgot') as HTMLButtonElement;

  errEl.textContent = '';
  successEl.classList.add('hidden');
  successEl.textContent = '';
  btn.disabled = true;
  btn.textContent = 'Sending…';

  const resp = await sendMessage({ type: 'FORGOT_PASSWORD', payload: { email } });
  btn.disabled = false;
  btn.textContent = 'Send Reset Token';

  if (resp.success) {
    successEl.textContent = '✅ Check your email for a reset token. Also check your spam folder.';
    successEl.classList.remove('hidden');
  } else {
    errEl.textContent = resp.error ?? 'Something went wrong. Try again.';
  }
}

async function handleResetPassword(e: Event): Promise<void> {
  e.preventDefault();
  const token = ($('reset-token') as HTMLInputElement).value.trim();
  const password = ($('reset-password') as HTMLInputElement).value;
  const confirm = ($('reset-confirm') as HTMLInputElement).value;
  const errEl = $('reset-error');
  const btn = $('btn-reset') as HTMLButtonElement;

  errEl.textContent = '';

  if (password !== confirm) {
    errEl.textContent = 'Passwords do not match.';
    return;
  }
  if (password.length < 8) {
    errEl.textContent = 'Password must be at least 8 characters.';
    return;
  }

  btn.disabled = true;
  btn.textContent = 'Updating…';

  const resp = await sendMessage({ type: 'RESET_PASSWORD', payload: { token, password } });
  btn.disabled = false;
  btn.textContent = 'Set New Password';

  if (resp.success) {
    // Success — show login with a hint
    ($('email') as HTMLInputElement).value = '';
    ($('password') as HTMLInputElement).value = '';
    $('login-error').textContent = '';
    showView('login');
    // Flash a brief success note
    const errLoginEl = $('login-error');
    errLoginEl.style.color = 'var(--green)';
    errLoginEl.textContent = '✅ Password updated! Sign in with your new password.';
    setTimeout(() => {
      errLoginEl.textContent = '';
      errLoginEl.style.color = '';
    }, 5000);
  } else {
    errEl.textContent = resp.error ?? 'Reset failed. Check your token and try again.';
  }
}

// ── Auth flows ─────────────────────────────────────────────────────────────────
async function handleLogin(e: Event): Promise<void> {
  e.preventDefault();
  const email = ($("email") as HTMLInputElement).value.trim();
  const password = ($("password") as HTMLInputElement).value;
  const errEl = $("login-error");
  const btn = $("btn-login") as HTMLButtonElement;

  errEl.textContent = "";
  btn.disabled = true;
  btn.textContent = "Signing in…";

  const resp = await sendMessage({ type: "LOGIN", payload: { email, password } });
  btn.disabled = false;
  btn.textContent = "Sign In";

  if (resp.success) {
    showView("main");
    await loadItems();
    await checkCurrentPage();
  } else {
    errEl.textContent = resp.error ?? "Login failed";
  }
}

async function handleRegister(e: Event): Promise<void> {
  e.preventDefault();
  const email = ($("reg-email") as HTMLInputElement).value.trim();
  const password = ($("reg-password") as HTMLInputElement).value;
  const errEl = $("register-error");
  const btn = $("btn-register") as HTMLButtonElement;

  errEl.textContent = "";
  btn.disabled = true;
  btn.textContent = "Creating…";

  // Call register endpoint directly
  const authResp = await getAuth();
  if (authResp) {
    showView("main");
    return;
  }

  try {
    const res = await fetch("http://localhost:3001/api/auth/register", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ email, password }),
    });
    const data = await res.json() as { token?: string; user?: { id: string; email: string }; error?: string };
    if (!res.ok) throw new Error(data.error ?? "Registration failed");

    // Store auth via background
    await chrome.storage.local.set({
      auth: { token: data.token, userId: data.user!.id, email: data.user!.email },
    });

    showView("main");
    await loadItems();
    await checkCurrentPage();
  } catch (err) {
    errEl.textContent = err instanceof Error ? err.message : "Registration failed";
  } finally {
    btn.disabled = false;
    btn.textContent = "Create Account";
  }
}

async function getAuth(): Promise<{ token: string } | null> {
  const resp = await sendMessage({ type: "GET_AUTH" });
  return resp.success ? (resp.data as { token: string } | null) : null;
}

// ── Init ──────────────────────────────────────────────────────────────────────
async function init(): Promise<void> {
  // ── Eye toggle (delegated — covers all password fields) ────────────────
  document.addEventListener("click", (e) => {
    const btn = (e.target as HTMLElement).closest(".eye-btn") as HTMLButtonElement | null;
    if (!btn) return;
    const targetId = btn.dataset["target"];
    if (!targetId) return;
    const input = document.getElementById(targetId) as HTMLInputElement | null;
    if (!input) return;
    const isHidden = input.type === "password";
    input.type = isHidden ? "text" : "password";
    btn.setAttribute("aria-label", isHidden ? "Hide password" : "Show password");
    btn.querySelector(".eye-off")?.classList.toggle("hidden", isHidden);
    btn.querySelector(".eye-on")?.classList.toggle("hidden", !isHidden);
  });

  // Event listeners
  $("login-form").addEventListener("submit", (e) => void handleLogin(e));
  $("register-form").addEventListener("submit", (e) => void handleRegister(e));
  $("forgot-form").addEventListener("submit", (e) => void handleForgotPassword(e));
  $("reset-form").addEventListener("submit", (e) => void handleResetPassword(e));
  $("manual-form").addEventListener("submit", (e) => void handleManualAdd(e));
  $("link-register").addEventListener("click", (e) => { e.preventDefault(); showView("register"); });
  $("link-login").addEventListener("click", (e) => { e.preventDefault(); showView("login"); });
  $("link-forgot").addEventListener("click", (e) => { e.preventDefault(); showView("forgot"); });
  $("link-have-token").addEventListener("click", (e) => { e.preventDefault(); showView("reset"); });
  $("link-back-login").addEventListener("click", (e) => { e.preventDefault(); showView("login"); });
  $("link-back-forgot").addEventListener("click", (e) => { e.preventDefault(); showView("forgot"); });
  $("link-back-main").addEventListener("click", (e) => { e.preventDefault(); showView("main"); });
  $("btn-open-manual").addEventListener("click", async () => {
    // Pre-fill URL & title from the active tab
    const tabResp = await sendMessage({ type: "GET_TAB_URL" });
    if (tabResp.success && tabResp.data) {
      const tabData = tabResp.data as { url: string; title: string };
      const urlInput = $("manual-url") as HTMLInputElement;
      const titleInput = $("manual-title") as HTMLInputElement;
      if (tabData.url && !urlInput.value) urlInput.value = tabData.url;
      if (tabData.title && !titleInput.value) titleInput.value = tabData.title;
    }
    showView("manual");
  });
  $("btn-logout").addEventListener("click", async () => {
    await sendMessage({ type: "LOGOUT" });
    showView("login");
  });

  // Check if already logged in
  const auth = await getAuth();
  if (auth) {
    showView("main");
    await loadItems();
    await checkCurrentPage();
  } else {
    showView("login");
  }
}

void init();
