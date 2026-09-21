/**
 * mailer.ts
 *
 * Sends digest emails via Gmail SMTP (App Password).
 * Falls back to a console transport when GMAIL_APP_PASSWORD is not set,
 * so the app is fully functional in dev without real credentials.
 */

import nodemailer, { Transporter } from "nodemailer";
import fs from "fs";
import path from "path";
import { config } from "../config";
import type { PriceEvent } from "./eventDetector";

// ── Transport singleton ───────────────────────────────────────────────────────
let transport: Transporter | null = null;

export function getTransport(): Transporter {
  if (transport) return transport;

  if (config.email.gmailUser && config.email.gmailAppPassword) {
    transport = nodemailer.createTransport({
      service: "gmail",
      auth: {
        user: config.email.gmailUser,
        pass: config.email.gmailAppPassword,
      },
    });
    console.log("[mailer] Using Gmail SMTP transport");
  } else {
    // Console transport — logs email to stdout, no real delivery
    transport = nodemailer.createTransport({
      jsonTransport: true,
    });
    console.log("[mailer] ⚠️  No Gmail credentials found — using console transport (emails logged to stdout)");
  }

  return transport;
}

// ── Template loading ─────────────────────────────────────────────────────────
const TEMPLATE_PATH = path.join(__dirname, "../templates/priceAlert.html");
let templateCache: string | null = null;

function getTemplate(): string {
  if (!templateCache) {
    templateCache = fs.readFileSync(TEMPLATE_PATH, "utf8");
  }
  return templateCache;
}

// ── HTML helpers ──────────────────────────────────────────────────────────────
function formatCurrency(amount: number | null, currency: string): string {
  if (amount === null) return "N/A";
  try {
    return new Intl.NumberFormat("en-US", {
      style: "currency",
      currency: currency || "USD",
      minimumFractionDigits: 2,
    }).format(amount);
  } catch {
    return `${currency} ${amount.toFixed(2)}`;
  }
}

const EVENT_BADGE_LABELS: Record<string, string> = {
  price_drop: "💸 Price Drop",
  clearance: "🏷️ Clearance",
  seasonal: "🔥 Seasonal Sale",
  sale: "⚡ Sale",
  delisted: "❌ Item Removed",
  extraction_failure: "⚠️ Update Unavailable",
};

function buildProductCard(event: PriceEvent): string {
  const badgeLabel = EVENT_BADGE_LABELS[event.eventType] ?? event.eventType;
  const badgeClass = `badge-${event.eventType}`;
  const oldPriceStr = formatCurrency(event.originalPrice, event.currency);
  const newPriceStr = event.newPrice !== null
    ? formatCurrency(event.newPrice, event.currency)
    : "N/A";
  const pctStr = event.pctOff !== null ? `${event.pctOff}% off` : "";

  const imageHtml = event.imageUrl
    ? `<div class="product-image-wrap">
         <img src="${escHtml(event.imageUrl)}" alt="${escHtml(event.title ?? "Product")}" />
       </div>`
    : "";

  const retailerNote = event.retailerOriginalPrice
    ? `<p class="retailer-note">Retailer's claimed original: ${formatCurrency(event.retailerOriginalPrice, event.currency)} (may be inflated)</p>`
    : "";

  const delistedBody = event.eventType === "delisted"
    ? `<p style="color:#94a3b8;font-size:14px;margin:0 0 16px;">
         This item is no longer available on the retailer's site.
         It may have sold out or been removed.
       </p>`
    : "";

  const priceSection = event.newPrice !== null && event.eventType !== "delisted"
    ? `<table class="price-table" cellpadding="0" cellspacing="0">
         <tr>
           <td class="price-old-cell">
             <div class="price-label">Your price</div>
             <div class="price-old">${escHtml(oldPriceStr)}</div>
           </td>
           <td class="price-new-cell">
             <div class="price-label">Now</div>
             <div class="price-new">${escHtml(newPriceStr)}</div>
           </td>
           <td class="price-pct-cell">
             ${pctStr ? `<span class="price-pct">${escHtml(pctStr)}</span>` : ""}
           </td>
         </tr>
       </table>
       ${retailerNote}`
    : "";

  const ctaLabel = event.eventType === "delisted" ? "View Product" : "Buy Now →";

  return `
    <div class="product-card">
      ${imageHtml}
      <div class="product-body">
        <span class="event-badge ${escHtml(badgeClass)}">${escHtml(badgeLabel)}</span>
        <h2 class="product-title">
          <a href="${escHtml(event.productUrl)}" target="_blank" rel="noopener noreferrer">
            ${escHtml(event.title ?? "Product")}
          </a>
        </h2>
        ${delistedBody}
        ${priceSection}
        <div class="cta-wrap">
          <a class="cta-btn" href="${escHtml(event.productUrl)}" target="_blank" rel="noopener noreferrer">
            ${ctaLabel}
          </a>
        </div>
      </div>
    </div>`;
}

function escHtml(str: string): string {
  return str
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

// ── Public API ────────────────────────────────────────────────────────────────

export interface DigestRecipient {
  email: string;
  name?: string;
}

/**
 * Send a digest email for one user containing all triggered events.
 * Multiple events are batched into a single email.
 */
export async function sendDigest(
  recipient: DigestRecipient,
  events: PriceEvent[]
): Promise<void> {
  if (events.length === 0) return;

  const isMultiple = events.length > 1;
  const headerTitle = isMultiple
    ? `${events.length} Price Alerts`
    : EVENT_BADGE_LABELS[events[0].eventType] ?? "Price Alert";
  const headerSubtitle = isMultiple
    ? "Multiple items you're watching have updates"
    : events[0].title ?? "One of your tracked items has an update";

  const productCards = events.map(buildProductCard).join("\n");

  const baseUrl = "https://waitnsave.app"; // update with real URL when deployed
  const html = getTemplate()
    .replace(/{{headerTitle}}/g, escHtml(headerTitle))
    .replace(/{{headerSubtitle}}/g, escHtml(headerSubtitle))
    .replace(/{{#if isDigest}}[\s\S]*?{{\/if}}/g, "")
    .replace(/{{digestCount}}/g, String(events.length))
    .replace(/{{#if multipleItems}}s{{\/if}}/g, isMultiple ? "s" : "")
    .replace(/{{#if multipleItems}}have{{else}}has{{\/if}}/g, isMultiple ? "have" : "has")
    .replace(/{{productCards}}/g, productCards)
    .replace(/{{unsubscribeUrl}}/g, `${baseUrl}/unsubscribe`)
    .replace(/{{dashboardUrl}}/g, `${baseUrl}/dashboard`)
    .replace(/{{year}}/g, String(new Date().getFullYear()));

  const subject = isMultiple
    ? `💸 ${events.length} price alerts — Wait-n-Save`
    : `${EVENT_BADGE_LABELS[events[0].eventType] ?? "Price alert"}: ${events[0].title ?? "tracked item"}`;

  const transport = getTransport();

  const mailOptions = {
    from: `"${config.email.fromName}" <${config.email.gmailUser ?? "noreply@waitnsave.app"}>`,
    to: recipient.email,
    subject,
    html,
    // Deliverability: allow one-click unsubscribe
    headers: {
      "List-Unsubscribe": `<${baseUrl}/unsubscribe>`,
      "List-Unsubscribe-Post": "List-Unsubscribe=One-Click",
    },
  };

  if (!config.email.gmailUser || !config.email.gmailAppPassword) {
    // Console transport — log the stringified mail object
    const info = await transport.sendMail(mailOptions);
    console.log("[mailer] 📧 Email (console mode):", JSON.stringify(JSON.parse((info as unknown as { message: string }).message), null, 2));
    return;
  }

  await transport.sendMail(mailOptions);
  console.log(`[mailer] ✅ Digest sent to ${recipient.email} (${events.length} event${isMultiple ? "s" : ""})`);
}
