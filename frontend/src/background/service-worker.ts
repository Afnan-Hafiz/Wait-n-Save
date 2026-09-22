/**
 * background/service-worker.ts
 *
 * MV3 service worker:
 *   - Manages JWT auth state in chrome.storage.local
 *   - Proxies all API calls from content script and popup
 *   - Updates tab badge to reflect tracked state
 */

import type { Message, MessageResponse, AuthState } from "../shared/types";

const API_BASE = "http://localhost:3001"; // update for production

// ── Storage helpers ───────────────────────────────────────────────────────────
async function getAuth(): Promise<AuthState | null> {
  const result = await chrome.storage.local.get("auth");
  return (result["auth"] as AuthState) ?? null;
}

async function setAuth(auth: AuthState): Promise<void> {
  await chrome.storage.local.set({ auth });
}

async function clearAuth(): Promise<void> {
  await chrome.storage.local.remove("auth");
}

// ── API call helper ───────────────────────────────────────────────────────────
async function apiCall(
  method: string,
  path: string,
  body?: unknown,
  token?: string
): Promise<{ ok: boolean; status: number; data: unknown }> {
  const headers: Record<string, string> = {
    "Content-Type": "application/json",
  };
  if (token) headers["Authorization"] = `Bearer ${token}`;

  const res = await fetch(`${API_BASE}${path}`, {
    method,
    headers,
    body: body ? JSON.stringify(body) : undefined,
  });

  let data: unknown;
  try {
    data = await res.json();
  } catch {
    data = null;
  }

  return { ok: res.ok, status: res.status, data };
}

// ── Badge helper ──────────────────────────────────────────────────────────────
async function updateBadge(tabId: number, tracked: boolean): Promise<void> {
  await chrome.action.setBadgeText({
    tabId,
    text: tracked ? "✓" : "",
  });
  await chrome.action.setBadgeBackgroundColor({
    tabId,
    color: "#6c3fff",
  });
}

// ── URL status cache (per-session, by tab) ────────────────────────────────────
const urlStatusCache = new Map<string, boolean>();

// ── Broadcast to all tabs ─────────────────────────────────────────────────────
async function broadcastToTabs(msg: unknown): Promise<void> {
  try {
    const tabs = await chrome.tabs.query({});
    for (const tab of tabs) {
      if (tab.id) {
        chrome.tabs.sendMessage(tab.id, msg).catch(() => {});
      }
    }
  } catch {
    // ignore
  }
}

// ── Message handler ───────────────────────────────────────────────────────────
chrome.runtime.onMessage.addListener(
  (
    message: Message,
    sender: chrome.runtime.MessageSender,
    sendResponse: (response: MessageResponse) => void
  ) => {
    handleMessage(message, sender).then(sendResponse).catch((err) => {
      sendResponse({ success: false, error: String(err) });
    });
    return true; // keep message channel open for async response
  }
);

async function handleMessage(
  message: Message,
  sender: chrome.runtime.MessageSender
): Promise<MessageResponse> {
  switch (message.type) {
    // ── Login ────────────────────────────────────────────────────────────────
    case "LOGIN": {
      const result = await apiCall("POST", "/api/auth/login", {
        email: message.payload.email,
        password: message.payload.password,
      });
      if (!result.ok) {
        const errData = result.data as { error?: string };
        return { success: false, error: errData?.error ?? "Login failed" };
      }
      const loginData = result.data as { token: string; user: { id: string; email: string } };
      await setAuth({
        token: loginData.token,
        userId: loginData.user.id,
        email: loginData.user.email,
      });
      broadcastToTabs({ type: "AUTH_CHANGED", payload: { loggedIn: true } }).catch(() => {});
      return { success: true, data: loginData.user };
    }

    // ── Logout ───────────────────────────────────────────────────────────────
    case "LOGOUT": {
      await clearAuth();
      urlStatusCache.clear();
      broadcastToTabs({ type: "AUTH_CHANGED", payload: { loggedIn: false } }).catch(() => {});
      return { success: true };
    }

    // ── Get auth state ───────────────────────────────────────────────────────
    case "GET_AUTH": {
      const auth = await getAuth();
      return { success: true, data: auth };
    }

    // ── Get current tab URL (for manual add form) ────────────────────────────
    case "GET_TAB_URL": {
      const tabs = await chrome.tabs.query({ active: true, currentWindow: true });
      const tab = tabs[0];
      return { success: true, data: { url: tab?.url ?? "", title: tab?.title ?? "" } };
    }

    // ── Star an item ─────────────────────────────────────────────────────────
    case "STAR_ITEM": {
      const auth = await getAuth();
      if (!auth) return { success: false, error: "Not logged in" };

      const result = await apiCall(
        "POST",
        "/api/items",
        message.payload,
        auth.token
      );
      if (!result.ok) {
        const errData = result.data as { error?: string };
        return { success: false, error: errData?.error ?? "Failed to star item" };
      }

      // Update badge on current tab
      if (sender.tab?.id) {
        await updateBadge(sender.tab.id, true);
        urlStatusCache.set(message.payload.productUrl, true);
      }

      broadcastToTabs({
        type: "ITEM_TRACKED",
        payload: { url: message.payload.productUrl },
      }).catch(() => {});

      return { success: true, data: result.data };
    }

    // ── Check URL tracking state ─────────────────────────────────────────────
    case "CHECK_URL": {
      const auth = await getAuth();
      if (!auth) return { success: true, data: { tracked: false, item: null } };

      const cached = urlStatusCache.get(message.payload.url);
      if (cached !== undefined) {
        return { success: true, data: { tracked: cached } };
      }

      const result = await apiCall(
        "GET",
        `/api/items/check-url?url=${encodeURIComponent(message.payload.url)}`,
        undefined,
        auth.token
      );
      if (!result.ok) return { success: true, data: { tracked: false, item: null } };

      const statusData = result.data as { tracked: boolean; item: unknown };
      urlStatusCache.set(message.payload.url, statusData.tracked);

      // Update badge on active tab
      if (sender.tab?.id) {
        await updateBadge(sender.tab.id, statusData.tracked);
      }

      return { success: true, data: statusData };
    }

    // ── Get all tracked items ────────────────────────────────────────────────
    case "GET_ITEMS": {
      const auth = await getAuth();
      if (!auth) return { success: false, error: "Not logged in" };

      const result = await apiCall("GET", "/api/items", undefined, auth.token);
      if (!result.ok) return { success: false, error: "Failed to fetch items" };
      return { success: true, data: (result.data as { items: unknown }).items };
    }

    // ── Delete / untrack item ────────────────────────────────────────────────
    case "DELETE_ITEM": {
      const auth = await getAuth();
      if (!auth) return { success: false, error: "Not logged in" };

      const result = await apiCall(
        "DELETE",
        `/api/items/${message.payload.itemId}`,
        undefined,
        auth.token
      );
      if (!result.ok) return { success: false, error: "Failed to untrack item" };
      urlStatusCache.clear(); // invalidate cache

      const [activeTab] = await chrome.tabs.query({ active: true, currentWindow: true });
      if (activeTab?.id) {
        await updateBadge(activeTab.id, false);
      }

      const itemData = (result.data as { item?: { product_url?: string } })?.item;
      broadcastToTabs({
        type: "ITEM_UNTRACKED",
        payload: { itemId: message.payload.itemId, url: itemData?.product_url },
      }).catch(() => {});

      return { success: true, data: result.data };
    }

    // ── Untrack item by URL directly ─────────────────────────────────────────
    case "UNTRACK_URL": {
      const auth = await getAuth();
      if (!auth) return { success: false, error: "Not logged in" };

      const result = await apiCall(
        "POST",
        "/api/items/untrack-by-url",
        { url: message.payload.url },
        auth.token
      );
      if (!result.ok) return { success: false, error: "Failed to untrack item" };
      urlStatusCache.clear();

      if (sender.tab?.id) {
        await updateBadge(sender.tab.id, false);
      }

      broadcastToTabs({
        type: "ITEM_UNTRACKED",
        payload: { url: message.payload.url },
      }).catch(() => {});

      return { success: true, data: result.data };
    }

    // ── Forgot password ──────────────────────────────────────────────────
    case "FORGOT_PASSWORD": {
      const result = await apiCall("POST", "/api/auth/forgot-password", {
        email: message.payload.email,
      });
      if (!result.ok) {
        const errData = result.data as { error?: string };
        return { success: false, error: errData?.error ?? "Request failed" };
      }
      return { success: true, data: result.data };
    }

    // ── Reset password ───────────────────────────────────────────────────
    case "RESET_PASSWORD": {
      const result = await apiCall("POST", "/api/auth/reset-password", {
        token: message.payload.token,
        password: message.payload.password,
      });
      if (!result.ok) {
        const errData = result.data as { error?: string };
        return { success: false, error: errData?.error ?? "Reset failed" };
      }
      return { success: true, data: result.data };
    }

    // ── Trigger price check cycle ─────────────────────────────────────────
    case "TRIGGER_PRICE_CHECK": {
      const auth = await getAuth();
      if (!auth) return { success: false, error: "Not logged in" };
      const result = await apiCall("POST", "/api/items/trigger-check", {}, auth.token);
      if (!result.ok) return { success: false, error: "Failed to trigger check" };
      return { success: true, data: result.data };
    }

    // ── Send test price drop alert email ──────────────────────────────────
    case "TEST_PRICE_ALERT": {
      const auth = await getAuth();
      if (!auth) return { success: false, error: "Not logged in" };
      const result = await apiCall("POST", "/api/items/test-alert", {}, auth.token);
      if (!result.ok) {
        const errData = result.data as { error?: string };
        return { success: false, error: errData?.error ?? "Failed to send test alert" };
      }
      return { success: true, data: result.data };
    }

    default:
      return { success: false, error: "Unknown message type" };
  }
}

// ── Update badge when tab navigates ──────────────────────────────────────────
chrome.tabs.onUpdated.addListener(async (tabId, changeInfo, tab) => {
  if (changeInfo.status !== "complete" || !tab.url) return;

  const auth = await getAuth();
  if (!auth) return;

  try {
    const result = await apiCall(
      "GET",
      `/api/items/check-url?url=${encodeURIComponent(tab.url)}`,
      undefined,
      auth.token
    );
    if (result.ok) {
      const data = result.data as { tracked: boolean };
      await updateBadge(tabId, data.tracked);
    }
  } catch {
    // Silently ignore — backend may not be running
  }
});
