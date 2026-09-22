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

function formatCurrencyParts(amount: string | null, currency: string): { sym: string; formatted: string } {
  if (!amount) return { sym: "", formatted: "—" };
  const num = parseFloat(amount);
  if (isNaN(num)) return { sym: "", formatted: "—" };
  const code = (currency || "").trim().toUpperCase() || "USD";

  const SYMBOLS: Record<string, string> = {
    BDT: "৳", USD: "$", EUR: "€", GBP: "£", INR: "₹", JPY: "¥",
    TRY: "₺", KRW: "₩", ILS: "₪", PHP: "₱", THB: "฿", BRL: "R$",
    CAD: "CA$", AUD: "AU$", SGD: "S$", MYR: "RM", IDR: "Rp",
  };

  const sym = SYMBOLS[code] ?? code;
  const hasDecimals = num % 1 !== 0;
  const formatted = new Intl.NumberFormat(undefined, {
    minimumFractionDigits: hasDecimals ? 2 : 0,
    maximumFractionDigits: 2,
  }).format(num);

  return { sym, formatted };
}

function formatCurrency(amount: string | null, currency: string): string {
  const parts = formatCurrencyParts(amount, currency);
  return parts.sym ? `${parts.sym} ${parts.formatted}` : parts.formatted;
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

// ── Item card builder ──────────────────────────────────────────────────────────
function buildItemCard(item: ApiItem): HTMLLIElement {
  const li = document.createElement("li");
  li.dataset["itemId"] = item.id;

  const origPrice = parseFloat(item.original_price);
  const currPrice = item.current_price ? parseFloat(item.current_price) : null;
  const pctOff = item.pct_off ? parseInt(item.pct_off, 10) : null;
  const priceDropped = currPrice !== null && currPrice < origPrice;

  // Status badges: Target Reached (>=10% drop or lowest) vs Price Dropped vs Watching
  const isTarget = pctOff !== null && pctOff >= 10;
  li.className = isTarget ? "item-card card-target" : "item-card";

  let statusBadgeHtml = "";
  if (isTarget) {
    statusBadgeHtml = `<div class="card-status-row"><span class="badge-status badge-target">Target Reached</span></div>`;
  } else if (priceDropped && pctOff !== null && pctOff > 0) {
    statusBadgeHtml = `<div class="card-status-row"><span class="badge-status badge-dropped">Price Dropped — ${pctOff}%</span></div>`;
  } else {
    statusBadgeHtml = `<div class="card-status-row"><span class="badge-status badge-watching">Watching...</span></div>`;
  }

  const thumbImg = item.image_url
    ? `<img class="item-thumb" src="${item.image_url}" alt="${item.title ?? ""}" loading="lazy" />`
    : `<div class="item-thumb-placeholder">🛍️</div>`;

  const thumbBoxHtml = isTarget
    ? `<div class="item-thumb-box">${thumbImg}<div class="target-ping-dot"></div><div class="target-solid-dot"></div></div>`
    : `<div class="item-thumb-box">${thumbImg}</div>`;

  const currParts = formatCurrencyParts(item.current_price, item.currency);
  const origParts = formatCurrencyParts(item.original_price, item.currency);

  const currPriceHtml = currPrice !== null
    ? `<span class="price-current-group ${priceDropped ? "price-dropped-gold wns-shimmer" : ""}">${currParts.sym} ${currParts.formatted}</span>`
    : `<span class="price-current-group" style="font-size:13px;color:var(--muted-foreground)">Not checked</span>`;

  const variantHint = item.variant_hint
    ? Object.entries(item.variant_hint).map(([k, v]) => `${k}: ${v}`).join(", ")
    : "";

  li.innerHTML = `
    ${thumbBoxHtml}
    <div class="item-body">
      ${statusBadgeHtml}
      <a class="item-title" href="${item.product_url}" target="_blank" rel="noopener noreferrer"
         title="${item.title ?? item.product_url}">
        ${item.title ?? item.product_url}
        ${variantHint ? `<span style="color:var(--muted-foreground);font-weight:400"> (${variantHint})</span>` : ""}
      </a>
      <div class="item-prices">
        ${currPriceHtml}
        ${priceDropped ? `<span class="price-original">${origParts.sym} ${origParts.formatted}</span>` : ""}
      </div>
    </div>
    <button class="btn-untrack" data-item-id="${item.id}" aria-label="Remove item" title="Remove item">✕</button>
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

  countBadge.textContent = String(active.length).padStart(2, "0");

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
      countBadge.textContent = String(count).padStart(2, "0");
      if (count === 0) empty.classList.remove("hidden");
      await checkCurrentPage();
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
  if (!tab?.url || !tab.url.startsWith("http")) {
    bar.classList.add("hidden");
    return;
  }

  const resp = await sendMessage({ type: "CHECK_URL", payload: { url: tab.url } });
  if (!resp.success) {
    bar.classList.add("hidden");
    return;
  }

  const data = resp.data as { tracked: boolean; blockedDomain: boolean; item?: { fetch_status: string } };

  if (data.blockedDomain) {
    bar.className = "page-bar blocked";
    barText.textContent = "⚠ This site restricts price tracking";
    bar.classList.remove("hidden");
  } else if (data.tracked) {
    bar.className = "page-bar tracked";
    barText.textContent = "✓ Tracking this page";
    bar.classList.remove("hidden");
  } else {
    bar.classList.add("hidden");
  }
}

async function handleForgotPassword(e: Event): Promise<void> {
  e.preventDefault();
  const emailInput = $('forgot-email') as HTMLInputElement;
  const email = emailInput.value.trim();
  const errEl = $('forgot-error');
  const successEl = $('forgot-success');
  const btn = $('btn-forgot') as HTMLButtonElement;

  errEl.textContent = '';
  successEl.classList.add('hidden');
  successEl.textContent = '';

  if (!email) {
    errEl.textContent = 'Please enter your email address.';
    return;
  }

  btn.disabled = true;
  btn.textContent = 'Sending…';

  const resp = await sendMessage({ type: 'FORGOT_PASSWORD', payload: { email } });
  btn.disabled = false;
  btn.textContent = 'SEND RESET CODE';

  if (resp.success) {
    const data = resp.data as { message?: string; devCode?: string } | string;
    const devCode = typeof data === 'object' ? data?.devCode : undefined;

    // Transition straight to the reset code view
    showView('reset');

    const resetTokenInput = $('reset-token') as HTMLInputElement;
    if (devCode) {
      resetTokenInput.value = devCode;
    } else {
      resetTokenInput.value = '';
    }

    const resetErrEl = $('reset-error');
    resetErrEl.style.color = '#10B981';
    resetErrEl.textContent = devCode
      ? `✅ Verification code generated! (Dev code: ${devCode})`
      : `✅ Verification code sent to ${email}! (Check Spam/Junk if not in Inbox)`;

    setTimeout(() => {
      resetErrEl.textContent = '';
      resetErrEl.style.color = '';
    }, 8000);
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

  errEl.style.color = '';
  errEl.textContent = '';

  if (!token) {
    errEl.textContent = 'Please enter the verification code.';
    return;
  }
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
  btn.textContent = 'CHANGE PASSWORD';

  if (resp.success) {
    // Fill the email in login form if available
    const forgotEmail = ($('forgot-email') as HTMLInputElement).value.trim();
    if (forgotEmail) {
      ($('email') as HTMLInputElement).value = forgotEmail;
    }
    ($('password') as HTMLInputElement).value = '';
    ($('reset-token') as HTMLInputElement).value = '';
    ($('reset-password') as HTMLInputElement).value = '';
    ($('reset-confirm') as HTMLInputElement).value = '';

    showView('login');

    const loginErrEl = $('login-error');
    loginErrEl.style.color = '#10B981';
    loginErrEl.textContent = '✅ Password updated! Sign in with your new password.';
    setTimeout(() => {
      loginErrEl.textContent = '';
      loginErrEl.style.color = '';
    }, 6000);
  } else {
    errEl.textContent = resp.error ?? 'Reset failed. Check your code and try again.';
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

  const testAlertBtn = $("btn-test-alert");
  if (testAlertBtn) {
    testAlertBtn.addEventListener("click", async () => {
      const statusEl = $("main-status-msg");
      testAlertBtn.setAttribute("disabled", "true");
      statusEl.className = "status-msg";
      statusEl.textContent = "Dispatching sample price drop alert to your email…";
      statusEl.classList.remove("hidden");

      let res = await sendMessage({ type: "TEST_PRICE_ALERT" });

      // Direct fallback if Chrome extension service worker is caching old script
      if (!res.success && res.error?.includes("Unknown message type")) {
        const auth = await getAuth();
        if (auth?.token) {
          try {
            const apiRes = await fetch("http://localhost:3001/api/items/test-alert", {
              method: "POST",
              headers: {
                "Content-Type": "application/json",
                "Authorization": `Bearer ${auth.token}`,
              },
            });
            const data = await apiRes.json();
            if (apiRes.ok) {
              res = { success: true, data };
            } else {
              res = { success: false, error: data?.error ?? "Failed to send alert" };
            }
          } catch (err: any) {
            res = { success: false, error: err.message };
          }
        }
      }

      testAlertBtn.removeAttribute("disabled");

      if (res.success) {
        statusEl.className = "status-msg success";
        statusEl.textContent = "✅ Price drop alert sent! Check your email.";

        // Also trigger native desktop notification if available
        if (typeof chrome !== "undefined" && chrome.notifications) {
          chrome.notifications.create({
            type: "basic",
            iconUrl: "icons/icon128.png",
            title: "Wait-n-Save: Price Alert Dispatched",
            message: "A sample price drop alert has been sent to your email!",
            priority: 2,
          });
        }
      } else {
        statusEl.className = "status-msg error";
        statusEl.textContent = `❌ ${res.error ?? "Failed to send test alert"}`;
      }

      setTimeout(() => {
        statusEl.classList.add("hidden");
      }, 7000);
    });
  }

  const checkNowBtn = $("btn-check-now");
  if (checkNowBtn) {
    checkNowBtn.addEventListener("click", async () => {
      const statusEl = $("main-status-msg");
      checkNowBtn.setAttribute("disabled", "true");
      statusEl.className = "status-msg";
      statusEl.textContent = "Checking prices for your items…";
      statusEl.classList.remove("hidden");

      let res = await sendMessage({ type: "TRIGGER_PRICE_CHECK" });

      if (!res.success && res.error?.includes("Unknown message type")) {
        const auth = await getAuth();
        if (auth?.token) {
          try {
            const apiRes = await fetch("http://localhost:3001/api/items/trigger-check", {
              method: "POST",
              headers: {
                "Content-Type": "application/json",
                "Authorization": `Bearer ${auth.token}`,
              },
            });
            const data = await apiRes.json();
            if (apiRes.ok) {
              res = { success: true, data };
            }
          } catch {}
        }
      }

      checkNowBtn.removeAttribute("disabled");

      if (res.success) {
        statusEl.className = "status-msg success";
        statusEl.textContent = "✅ Price check cycle started!";
        await loadItems();
      } else {
        statusEl.className = "status-msg error";
        statusEl.textContent = `❌ ${res.error ?? "Failed to trigger check"}`;
      }

      setTimeout(() => {
        statusEl.classList.add("hidden");
      }, 5000);
    });
  }

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
