/** Shared types between extension components */

export interface StarredItem {
  productUrl: string;
  title: string | null;
  imageUrl: string | null;
  price: number;
  currency: string;
  geoHint: string;
  variantHint: Record<string, string> | null;
}

export interface TrackedItemStatus {
  tracked: boolean;
  item: {
    id: string;
    is_active: boolean;
    fetch_status: string;
    current_price: string | null;
    original_price: string;
  } | null;
  blockedDomain: boolean;
  apiAlternative: string | null;
}

export interface ApiItem {
  id: string;
  product_url: string;
  title: string | null;
  image_url: string | null;
  currency: string;
  original_price: string;
  current_price: string | null;
  lowest_price: string | null;
  fetch_status: string;
  last_checked_at: string | null;
  is_active: boolean;
  pct_off: string | null;
  variant_hint: Record<string, string> | null;
}

export interface AuthState {
  token: string;
  userId: string;
  email: string;
}

// ── Message types between content ↔ background ───────────────────────────────
export type Message =
  | { type: "STAR_ITEM"; payload: StarredItem }
  | { type: "CHECK_URL"; payload: { url: string } }
  | { type: "LOGIN"; payload: { email: string; password: string } }
  | { type: "FORGOT_PASSWORD"; payload: { email: string } }
  | { type: "RESET_PASSWORD"; payload: { token: string; password: string } }
  | { type: "LOGOUT" }
  | { type: "GET_AUTH" }
  | { type: "GET_TAB_URL" }
  | { type: "GET_ITEMS" }
  | { type: "DELETE_ITEM"; payload: { itemId: string } }
  | { type: "UNTRACK_URL"; payload: { url: string } };

export type MessageResponse =
  | { success: true; data?: unknown }
  | { success: false; error: string };
