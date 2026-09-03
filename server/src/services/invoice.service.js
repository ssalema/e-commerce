const fs = require('fs');
const path = require('path');
const PDFDocument = require('pdfkit');
const QRCode = require('qrcode');

const env = require('../config/env');
const logger = require('../utils/logger');
const { getBranding } = require('./mail.service');

/**
 * The order invoice, drawn straight into the HTTP response — nothing is written to
 * disk and nothing is cached, so an invoice reprinted a year later is rebuilt
 * from the order document that has always been its only source of truth.
 *
 * Artwork is shared with the transactional emails (server/src/assets/email): the
 * shield on this page and the shield in the order-confirmation mail have to be
 * the identical mark, and cutting a second set for the PDF is how the two drift
 * apart. Type is the four PDF base fonts — Helvetica for the document, Times for
 * the one line of display serif in the footer — because a bundled webfont would
 * be a megabyte on every download for a page that reads as well without it.
 *
 * The page is laid out before a mark is made on it. `paginate()` measures every
 * row and the summary block, decides what goes on which sheet, and only then
 * does the drawing begin — which is what lets a continuation page use the full
 * height of the paper, and lets the summary pull the last line item down with it
 * rather than opening a sheet that carries nothing but a total.
 */

const ASSET_DIR = path.join(__dirname, '../assets/email');

/* ------------------------------------------------------------------ *
 * Palette — the tailwind.config.js ramps, as hex. A PDF cannot read a
 * CSS variable, so the values are duplicated here the same way
 * mail.service.js duplicates them, and for the same reason.
 * ------------------------------------------------------------------ */
const P = {
  ink900: '#0f172a',
  ink700: '#334155',
  ink600: '#475569',
  ink500: '#64748b',
  ink400: '#94a3b8',
  ink200: '#e2e8f0',
  ink100: '#f1f5f9',
  ink50: '#f8fafc',
  brand600: '#2563eb',
  // tailwind `accent` — the invoice is the one surface that leads with navy and
  // gold rather than navy and blue. Blue stays on the glyphs, which are shared
  // with the mails; the gold is this document's own accent.
  accent: '#f59e0b',
  accentDark: '#d97706',
  accent50: '#fffbeb',
  accent100: '#fef3c7',
  green50: '#f0fdf4',
  green700: '#15803d',
  red50: '#fef2f2',
  red700: '#b91c1c',
  white: '#ffffff',
};

/* ------------------------------------------------------------------ *
 * Geometry — A4 at 72dpi is 595.28 x 841.89pt.
 *
 * The margins are 34pt — a shade under 12mm, and inside every desktop printer's
 * unprintable edge. They were 48, which cost 28pt of column width and read as a
 * document floating in the middle of the sheet rather than set on it.
 *
 * Vertically the page is a fixed frame: the letterhead opens the first sheet and
 * the closing blocks end the last. What changes per page is how far the content
 * may run — a sheet that ends in a page number can use the paper the masthead
 * and the closing blocks would otherwise be holding, and does.
 * ------------------------------------------------------------------ */
const LEFT = 34;
const RIGHT = 561;
const WIDTH = RIGHT - LEFT;

/** The last line of ink the page allows. */
const BOTTOM = 812;
/**
 * Where a continuation page starts. It carries no masthead — a letterhead is
 * something a document has once, and repeating it turned every sheet after the
 * first into a second cover page — so the table begins at the top margin.
 */
const PAGE_TOP = 40;

/** Heights of the two closing blocks, which are laid out as units. */
const TRUST_H = 40;
const FOOTER_H = 74;
/** Gap between the trust row and the footer beneath it. */
const CLOSING_GAP = 12;

/** The foot of the last page, fixed: the closing blocks never move off these lines. */
const FOOTER_Y = BOTTOM - FOOTER_H;
const TRUST_Y = FOOTER_Y - CLOSING_GAP - TRUST_H;

/** The baseline the foot line sits on, the same on every sheet. */
const PAGE_FOOT_TEXT = 801;

/**
 * Where content has to stop. Two lines, not one — this is the whole reason a
 * continuation page used to hold 126pt of paper for closing blocks it never
 * carried. A sheet that ends in the page counter may run to `FLOW_BOTTOM`; only
 * the sheet that actually closes the document stops at `LAST_BOTTOM`.
 */
const FLOW_BOTTOM = PAGE_FOOT_TEXT - 16;
const LAST_BOTTOM = TRUST_Y - 16;

/** Breathing room between the item table and the summary under it. */
const SUMMARY_GAP = 10;

const TAGLINE = 'Quality Products, Premium Experience';

/**
 * The four promises the order-confirmation mail closes with, in its order and
 * with its glyphs — the invoice is read in the same moment, and answering the
 * same four questions twice in two visual languages is what makes a suite of
 * documents feel assembled rather than designed.
 */
const TRUST = [
  {
    icon: 'shield-check-brand.png',
    title: '100% Genuine Products',
    text: 'Sourced directly from trusted brands.',
  },
  { icon: 'order-return.png', title: 'Easy Returns', text: 'Hassle-free returns within 7 days.' },
  { icon: 'job-headset.png', title: 'Customer Support', text: "We're here to help you anytime." },
  { icon: 'lock-brand.png', title: 'Secure Payments', text: 'Your payments are safe and encrypted.' },
];

/* ------------------------------------------------------------------ *
 * Formatting
 * ------------------------------------------------------------------ */

/**
 * "5th August 2026". Spelled out rather than 5/8/2026, because a numeric date on
 * a document that crosses borders is ambiguous by exactly one month — and this
 * is the date a return window or a warranty is counted from.
 */
const ORDINALS = ['th', 'st', 'nd', 'rd'];
const longDate = (value) => {
  const at = new Date(value);
  const day = at.getDate();
  // 11th, 12th and 13th break the last-digit rule and are the only ones that do.
  const suffix = day > 3 && day < 21 ? 'th' : ORDINALS[day % 10] || 'th';
  return `${day}${suffix} ${at.toLocaleString('en-IN', { month: 'long' })} ${at.getFullYear()}`;
};

/** "Rs. 8,698.72" — the lakh/crore grouping, since every price here is in INR. */
const money = (n) =>
  `Rs. ${Number(n || 0).toLocaleString('en-IN', {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  })}`;

const titleCase = (value = '') =>
  String(value)
    .replace(/_/g, ' ')
    .replace(/\b\w/g, (c) => c.toUpperCase());

const ONES = [
  '',
  'One',
  'Two',
  'Three',
  'Four',
  'Five',
  'Six',
  'Seven',
  'Eight',
  'Nine',
  'Ten',
  'Eleven',
  'Twelve',
  'Thirteen',
  'Fourteen',
  'Fifteen',
  'Sixteen',
  'Seventeen',
  'Eighteen',
  'Nineteen',
];
const TENS = ['', '', 'Twenty', 'Thirty', 'Forty', 'Fifty', 'Sixty', 'Seventy', 'Eighty', 'Ninety'];

const under100 = (n) => (n < 20 ? ONES[n] : `${TENS[Math.floor(n / 10)]}${n % 10 ? ` ${ONES[n % 10]}` : ''}`);

/** Indian grouping — crore, lakh, thousand, hundred — not the short scale. */
function inWords(n) {
  if (!n) return 'Zero';
  const parts = [];
  const crore = Math.floor(n / 1e7);
  const lakh = Math.floor((n % 1e7) / 1e5);
  const thousand = Math.floor((n % 1e5) / 1e3);
  const hundred = Math.floor((n % 1e3) / 100);
  const rest = n % 100;

  if (crore) parts.push(`${inWords(crore)} Crore`);
  if (lakh) parts.push(`${under100(lakh)} Lakh`);
  if (thousand) parts.push(`${under100(thousand)} Thousand`);
  if (hundred) parts.push(`${ONES[hundred]} Hundred`);
  if (rest) parts.push(under100(rest));
  return parts.join(' ');
}

/**
 * The amount spelled out, which is what makes the figure above it hard to alter
 * after the fact — the reason every invoice carries the line.
 */
function amountInWords(amount) {
  const rupees = Math.floor(amount);
  // Round the fraction, not the product: 0.1 + 0.2 in float arithmetic is 30.000000000000004 paise.
  const paise = Math.round((amount - rupees) * 100);
  const tail = paise ? ` and ${under100(paise)} Paise` : '';
  return `Rupees ${inWords(rupees)}${tail} Only`;
}

/* ------------------------------------------------------------------ *
 * Images
 * ------------------------------------------------------------------ */

/**
 * PDFKit reads JPEG and PNG and nothing else, so the Cloudinary transform asks
 * for `f_jpg` rather than the `f_auto` the storefront uses — auto would hand us
 * a WebP for any modern browser, and this is not a browser.
 */
const thumb = (url, size = 160) =>
  !url || !url.includes('/upload/')
    ? url
    : url.replace('/upload/', `/upload/w_${size},h_${size},c_fill,q_auto,f_jpg/`);

/**
 * Remote artwork — the uploaded logo and the product shots — has to be resolved
 * *before* the document starts streaming, because once a byte of PDF is on the
 * wire the response can no longer become an error. Everything here degrades to
 * null and the page draws a placeholder in its place.
 */
async function fetchImage(url, timeoutMs = 4000) {
  if (!url) return null;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch(url, { signal: controller.signal });
    if (!res.ok) return null;
    if (!/image\/(jpeg|jpg|png)/i.test(res.headers.get('content-type') || '')) return null;
    return Buffer.from(await res.arrayBuffer());
  } catch (err) {
    logger.warn(`Invoice image could not be fetched (${url}): ${err.message}`);
    return null;
  } finally {
    clearTimeout(timer);
  }
}

/** A bundled glyph. Missing artwork must never take the download down with it. */
function glyph(doc, file, x, y, size) {
  const full = path.join(ASSET_DIR, file);
  if (!fs.existsSync(full)) return;
  try {
    doc.image(full, x, y, { width: size, height: size });
  } catch (err) {
    logger.warn(`Invoice glyph ${file} could not be drawn: ${err.message}`);
  }
}

/** Scales a photo to cover its box and clips the overflow to a rounded corner. */
function cover(doc, buffer, x, y, size, radius) {
  doc.save();
  doc.roundedRect(x, y, size, size, radius).clip();
  try {
    doc.image(buffer, x, y, { cover: [size, size], align: 'center', valign: 'center' });
  } catch (err) {
    logger.warn(`Invoice thumbnail could not be drawn: ${err.message}`);
  }
  doc.restore();
}

/* ------------------------------------------------------------------ *
 * Drawing primitives
 * ------------------------------------------------------------------ */

const rule = (doc, y, color = P.ink200, width = 0.8, x0 = LEFT, x1 = RIGHT) =>
  doc.save().lineWidth(width).moveTo(x0, y).lineTo(x1, y).strokeColor(color).stroke().restore();

const dashedRule = (doc, x0, y0, x1, y1) =>
  doc
    .save()
    .lineWidth(0.7)
    .dash(2, { space: 2.5 })
    .moveTo(x0, y0)
    .lineTo(x1, y1)
    .strokeColor(P.ink200)
    .stroke()
    .undash()
    .restore();

/** A glyph on a filled disc — the meta card's rows and the trust row's marks. */
function disc(doc, file, cx, cy, radius, fill, glyphSize) {
  doc.save().circle(cx, cy, radius).fill(fill).restore();
  glyph(doc, file, cx - glyphSize / 2, cy - glyphSize / 2, glyphSize);
}

/**
 * One line of text, clipped with an ellipsis if it will not fit its column.
 *
 * `lineBreak: false` reads like it should do this and does not — PDFKit wraps at
 * the given width regardless, and the overflow lands on top of whatever was
 * drawn beneath it. A long address line was printing its tail across the city
 * and pincode under it for exactly this reason. Constraining the *height* to a
 * single line is what actually holds the text to one.
 *
 * The font has to be set before the call: the line height is read from it — and
 * read with the line gap included, because `currentLineHeight()` without the
 * flag returns the type's own height and PDFKit advances by more than that.
 */
function oneLine(doc, text, x, y, width, options = {}) {
  doc.text(text, x, y, { width, height: doc.currentLineHeight(true), ellipsis: true, ...options });
}

/** A status chip: text on a tinted pill, sized to the text it holds. */
function pill(doc, text, x, y, { bg, fg }) {
  doc.font('Helvetica-Bold').fontSize(8.5);
  const w = doc.widthOfString(text) + 18;
  doc.save().roundedRect(x, y - 4.5, w, 17, 8.5).fill(bg).restore();
  doc.fillColor(fg).text(text, x + 9, y, { lineBreak: false });
  return w;
}

/** The gold heart between the footer's two rules — one path, no artwork. */
function heart(doc, cx, cy, s) {
  doc
    .save()
    .moveTo(cx, cy + s * 0.75)
    .bezierCurveTo(cx - s * 1.25, cy - s * 0.2, cx - s * 0.55, cy - s * 1.0, cx, cy - s * 0.2)
    .bezierCurveTo(cx + s * 0.55, cy - s * 1.0, cx + s * 1.25, cy - s * 0.2, cx, cy + s * 0.75)
    .fill(P.accentDark)
    .restore();
}

/* ------------------------------------------------------------------ *
 * Sections
 * ------------------------------------------------------------------ */

/**
 * Masthead: the mark, the name split across navy and gold, and the registered
 * address. The address stands where the site URL and the support inbox used to:
 * an invoice has to say where the seller is, and both of those are repeated
 * in the footer anyway.
 *
 * First sheet only.
 */
function header(doc, brand, logo) {
  const y = 26;

  if (logo) {
    // An uploaded logo carries its own colours, so it gets a white tile with a
    // hairline rather than the navy one the bundled stand-in is cut for.
    doc.save().roundedRect(LEFT, y, 40, 40, 12).lineWidth(0.8).fillAndStroke(P.white, P.ink200).restore();
    doc.save().roundedRect(LEFT, y, 40, 40, 12).clip();
    try {
      doc.image(logo, LEFT + 5, y + 5, { fit: [30, 30], align: 'center', valign: 'center' });
    } catch (err) {
      logger.warn(`Invoice logo could not be drawn: ${err.message}`);
    }
    doc.restore();
  } else {
    doc.save().roundedRect(LEFT, y, 40, 40, 12).fill(P.ink900).restore();
    glyph(doc, 'brand-shield-lock.png', LEFT + 9, y + 9, 22);
  }

  const [first, ...rest] = String(brand.siteName || env.appName).split(' ');
  doc
    .font('Helvetica-Bold')
    .fontSize(18)
    .fillColor(P.ink900)
    .text(first, LEFT + 52, y + 4, { continued: rest.length > 0, lineBreak: false });
  if (rest.length) doc.fillColor(P.accentDark).text(` ${rest.join(' ')}`, { lineBreak: false });

  doc
    .font('Helvetica')
    .fontSize(8)
    .fillColor(P.ink500)
    .text(TAGLINE, LEFT + 52, y + 26, { lineBreak: false });

  if (brand.address) {
    glyph(doc, 'step-location.png', RIGHT - 212, y + 2, 11);
    doc
      .font('Helvetica')
      .fontSize(8)
      .fillColor(P.ink500)
      .text(brand.address, RIGHT - 196, y + 1, { width: 196, lineGap: 2 });
  }

  // The one gold rule on the page, and the widest — it is what separates the
  // letterhead from the document proper. It sits 12pt under the mark, close
  // enough to read as that block's own underline rather than as a band of empty
  // paper between two unrelated things.
  rule(doc, 78, P.accentDark, 1.2);
}

/** "ORDER INVOICE" against the card that carries the three numbers it is filed by. */
function titleBlock(doc, order) {
  doc
    .font('Helvetica-Bold')
    .fontSize(23)
    .fillColor(P.ink900)
    .text('ORDER INVOICE', LEFT, 90, { characterSpacing: 0.4, lineBreak: false });
  // 8pt under the baseline, not under the line box: PDFKit's `y` is the top of
  // the line, and at 23pt the descender space below the caps is most of a
  // centimetre — measuring from it left the rule adrift from the word it marks.
  doc.save().roundedRect(LEFT, 114, 42, 3, 1.5).fill(P.accentDark).restore();

  // Four rows at a 22pt pitch. Each number sits directly above its own date, so
  // the card reads as two pairs rather than a list of four unrelated facts.
  const card = { x: RIGHT - 258, y: 84, w: 258, h: 100 };
  doc
    .save()
    .roundedRect(card.x, card.y, card.w, card.h, 10)
    .lineWidth(0.8)
    .fillAndStroke(P.ink50, P.ink200)
    .restore();

  // Two different moments, and the reason both are printed: the order date is
  // when the shopper placed it, and the invoice date is when this document was
  // first issued — which for a COD order can be days later. `invoicedAt` is
  // stamped by the download endpoint on first generation; orders placed before
  // the field existed have none, and fall back to the order date rather than
  // printing a blank.
  const rows = [
    ['step-clipboard-white.png', 'Invoice No.', order.invoiceNumber || '—'],
    ['inquiry-calendar-white.png', 'Invoice Date', longDate(order.invoicedAt || order.createdAt)],
    ['step-package-white.png', 'Order No.', order.orderNumber || '—'],
    ['inquiry-calendar-white.png', 'Order Date', longDate(order.createdAt)],
  ];

  rows.forEach(([icon, label, value], i) => {
    const y = card.y + 9 + i * 22;
    disc(doc, icon, card.x + 17, y + 8, 9, P.ink900, 10);
    doc.font('Helvetica-Bold').fontSize(8).fillColor(P.ink900).text(label, card.x + 35, y + 5, {
      width: 70,
      lineBreak: false,
    });
    doc.font('Helvetica').fillColor(P.ink400).text(':', card.x + 107, y + 5, { lineBreak: false });
    doc.fontSize(8.5).fillColor(P.ink700);
    oneLine(doc, value, card.x + 118, y + 4.5, card.w - 130);
  });
}

const PAYMENT_TINTS = {
  paid: { bg: P.green50, fg: P.green700 },
  pending: { bg: P.accent50, fg: P.accentDark },
  failed: { bg: P.red50, fg: P.red700 },
  // Money still owed back wears the same amber as money still owed — both are
  // outstanding; only a completed refund goes quiet.
  refund_pending: { bg: P.accent50, fg: P.accentDark },
  refunded: { bg: P.ink100, fg: P.ink600 },
};

/* ------------------------------------------------------------------ *
 * The two panels under the title — who the order went to, and how it was paid
 * for. They were one card split by a dashed rule, which asked the reader to
 * take "billed & shipped to" as the heading for a payment status it plainly
 * does not describe. They are two cards now, each under its own label.
 * ------------------------------------------------------------------ */
/**
 * `h` is measured, not chosen. The ribbon's underside is at `y + 10`; content
 * starts 4pt clear of it at `PANEL_TOP`, runs to the longest thing either panel
 * holds — a name, a 10pt gap, and four lines of address — and closes on a foot
 * the weight of the head. The 14pt at the top used to be 28, which read as a
 * missing field under the label.
 */
const PANEL = { y: 204, h: 94 };
/** The first line inside a panel — clear of the ribbon that overlaps its top. */
const PANEL_TOP = PANEL.y + 14;
/**
 * The name sits on the panel's first line as a heading, and the address is its
 * body: the gap between them is what tells them apart. Set flush they read as
 * one ragged block with the name accidentally bolded.
 */
const NAME_H = 20;
const NAME_GAP = 10;
const CUSTOMER = { x: LEFT, w: 307 };
const PAYMENT = { x: LEFT + 321, w: RIGHT - (LEFT + 321) };

/** The panel body. */
function panel(doc, x, w) {
  doc
    .save()
    .roundedRect(x, PANEL.y, w, PANEL.h, 10)
    .lineWidth(0.8)
    .fillAndStroke(P.white, P.ink200)
    .restore();
}

/**
 * The label, cut as a ribbon that overlaps the panel's top edge tip first, so it
 * reads as attached to the panel rather than floating above it. Sized to its own
 * text: two ribbons of a fixed width would leave the shorter one padded out.
 */
function ribbon(doc, text, x) {
  const top = PANEL.y - 12;
  doc.font('Helvetica-Bold').fontSize(8);
  const w = doc.widthOfString(text, { characterSpacing: 0.7 }) + 30;
  doc
    .save()
    .moveTo(x, top)
    .lineTo(x + w, top)
    .lineTo(x + w + 13, top + 11)
    .lineTo(x + w, top + 22)
    .lineTo(x, top + 22)
    .fill(P.ink900)
    .restore();
  doc.fillColor(P.white).text(text, x + 15, top + 7, { characterSpacing: 0.7, lineBreak: false });
}

/** Left — the address the parcel was shipped to, which is also the billing name. */
function customerCard(doc, order) {
  panel(doc, CUSTOMER.x, CUSTOMER.w);
  ribbon(doc, 'CUSTOMER DETAILS', CUSTOMER.x);

  const a = order.shippingAddress;
  // A disc small enough to clear the ribbon: at r13 its top crossed the label.
  disc(doc, 'inquiry-user-accent.png', CUSTOMER.x + 28, PANEL_TOP + 10, 10, P.accent50, 12);

  doc.font('Helvetica-Bold').fontSize(12).fillColor(P.ink900);
  oneLine(doc, a.fullName, CUSTOMER.x + 44, PANEL_TOP + 3, CUSTOMER.w - 58);

  const x = CUSTOMER.x + 16;
  const w = CUSTOMER.w - 32;
  doc.font('Helvetica').fontSize(8.5).fillColor(P.ink600);
  const lh = doc.currentLineHeight(true);

  // The street gets two lines if it needs them. Held to one it dropped the
  // landmark off the end, and a landmark is the half of an Indian address a
  // courier actually navigates by — the panel is sized for the wrap.
  const street = [a.addressLine1, a.addressLine2, a.landmark].filter(Boolean).join(', ');
  const streetH = Math.min(doc.heightOfString(street, { width: w }), lh * 2);
  let y = PANEL_TOP + NAME_H + NAME_GAP;
  // The +1 is slack, not decoration: at exactly two line heights PDFKit decides
  // the second line does not fit and ellipsises the first.
  doc.text(street, x, y, { width: w, height: lh * 2 + 1, ellipsis: true });

  y += streetH + 2;
  oneLine(doc, `${a.city}, ${a.state} - ${a.pincode}`, x, y, w);
  oneLine(doc, `${a.country || 'India'} · ${a.phone}`, x, y + lh + 2, w);
}

/**
 * Right — the payment facts a shopper checks an invoice for, label over value so
 * a gateway reference has the full width of the panel to be legible in.
 *
 * Where an order has got to is deliberately not here. That is live information —
 * it is "confirmed" the day this is printed and "delivered" a week later — and
 * an invoice is a fixed record of a transaction, so it would be stale on the
 * copy in the shopper's downloads folder. The storefront's order page tracks it.
 */
function paymentCard(doc, order) {
  panel(doc, PAYMENT.x, PAYMENT.w);
  ribbon(doc, 'PAYMENT DETAILS', PAYMENT.x);

  const online = order.paymentMethod !== 'cod';
  const status = order.paymentStatus || 'pending';
  // Populated when the controller has a Payment document to hand; an online
  // order that was never captured simply has no reference to print.
  const reference = online ? order.payment?.razorpayPaymentId : null;

  const rows = [
    {
      icon: 'inquiry-bag.png',
      label: 'PAYMENT METHOD',
      value: online ? 'Online (Razorpay)' : 'Cash on Delivery',
    },
    {
      icon: 'shield-check-brand.png',
      label: 'PAYMENT STATUS',
      value: titleCase(status),
      tint: PAYMENT_TINTS[status] || PAYMENT_TINTS.refunded,
    },
    reference ? { icon: 'step-clipboard.png', label: 'TRANSACTION ID', value: reference } : null,
  ].filter(Boolean);

  // Three rows fill the panel exactly; two are set on a looser pitch and centred
  // in the same space, so the shorter card reads as deliberately spaced rather
  // than top-heavy.
  const pitch = rows.length > 2 ? 24 : 30;
  const room = PANEL.h - 18;
  const top = PANEL_TOP + Math.max(0, room - rows.length * pitch) / 2;
  const textX = PAYMENT.x + 38;
  const textW = RIGHT - 9 - textX;

  rows.forEach((row, i) => {
    const y = top + i * pitch;
    doc.save().roundedRect(PAYMENT.x + 12, y, 20, 20, 6).fill(P.ink50).restore();
    glyph(doc, row.icon, PAYMENT.x + 16.5, y + 4.5, 11);

    doc
      .font('Helvetica-Bold')
      .fontSize(6.5)
      .fillColor(P.ink400)
      .text(row.label, textX, y + 1, { characterSpacing: 0.6, lineBreak: false });

    // No rules between the rows: at this pitch the discs already read as a
    // column of three, and a hairline every 24pt in a narrow panel is noise.
    if (row.tint) pill(doc, row.value, textX, y + 11, row.tint);
    else {
      doc.font('Helvetica').fontSize(8.5).fillColor(P.ink700);
      oneLine(doc, row.value, textX, y + 11, textW);
    }
  });
}

/** Where the item table starts on the first page, under the two panels. */
const TABLE_TOP = PANEL.y + PANEL.h + 14;

/** The navy band above the line items, and its height. */
const HEAD_H = 26;

const COLS = {
  thumb: LEFT + 14,
  text: LEFT + 62,
  textWidth: 226,
  qty: 336,
  qtyWidth: 46,
  rate: 390,
  rateWidth: 82,
  amount: 478,
  amountWidth: 67,
};

/** Repeated on every page the table spills onto. */
function tableHead(doc, y) {
  doc.save().roundedRect(LEFT, y, WIDTH, HEAD_H, 7).fill(P.ink900).restore();
  doc.font('Helvetica-Bold').fontSize(8).fillColor(P.white);
  const opts = { characterSpacing: 0.6, lineBreak: false };
  doc.text('ITEM', COLS.thumb, y + 9, opts);
  doc.text('QTY', COLS.qty, y + 9, { ...opts, width: COLS.qtyWidth, align: 'center' });
  doc.text('RATE', COLS.rate, y + 9, { ...opts, width: COLS.rateWidth, align: 'right' });
  doc.text('AMOUNT', COLS.amount, y + 9, { ...opts, width: COLS.amountWidth, align: 'right' });
  return y + HEAD_H;
}

/**
 * The table's own outline, drawn last: the head is a filled navy block, so the
 * border only has to close the body beneath it.
 */
function tableBorder(doc, headTop, bottom) {
  doc
    .save()
    .lineWidth(0.8)
    .roundedRect(LEFT, headTop, WIDTH, bottom - headTop, 7)
    .strokeColor(P.ink200)
    .stroke()
    .restore();
}

/* ------------------------------------------------------------------ *
 * Measurement
 *
 * Everything that decides where a page breaks is computed here, before any ink
 * is laid down. Measuring and drawing in one pass is what made the old layout
 * reserve the closing blocks' 126pt on every sheet, including the ones that
 * never carried them.
 * ------------------------------------------------------------------ */

/**
 * One row per shipped line. Under the name sits the variant — "Black · M" — and
 * only the variant: it is what tells one line apart from the other size of the
 * same product in the same order, which is the question a reader actually brings
 * to this column. The SKU that used to sit beside it is a warehouse code, and
 * printing it here spent a line of the row's width on something no shopper reads
 * and no return needs, since a claim is looked up by order number.
 *
 * The variant sits on one line under the name rather than stacking, which is
 * what keeps a row to 45pt — the height the thumbnail sets the floor at anyway.
 */
function measureRows(doc, order, shots) {
  return order.items.map((item, i) => {
    const meta = item.variantLabel ? `(${item.variantLabel})` : '';

    doc.font('Helvetica-Bold').fontSize(8.5);
    // Capped at two lines: a product name is denormalised onto the order and can
    // be any length an admin typed, and one row is not allowed to grow taller
    // than the page it has to break against.
    const titleHeight = Math.min(doc.heightOfString(item.name, { width: COLS.textWidth }), 22);
    return {
      item,
      meta,
      titleHeight,
      shot: shots[i],
      height: Math.max(45, titleHeight + (meta ? 11 : 0) + 17),
    };
  });
}

/**
 * The summary column — the storefront's own Price Details panel, line for line,
 * so the breakdown a shopper approved at checkout is the breakdown they are
 * invoiced from.
 *
 * It has to *add up*, which decides the first row. The discounted selling price
 * is the price: `pricing.subtotal` is what the item table charges, already net
 * of the product discount, so the column opens there and the coupon is the only
 * thing taken off it — subtotal − coupon + delivery = the grand total, to the
 * paisa. `pricing.discount` is the gap between MRP and that subtotal, a saving
 * banked before the order was placed; printing it as a row would invite the
 * reader to subtract a number that was subtracted already, so it appears once,
 * below the total, as the saving it is.
 *
 * There is no tax line, by decision. `pricing.service.js` charges none, so for
 * anything this system prices the column closes on its own.
 */
const SUMMARY = { x: 320, w: RIGHT - 320 };

function measureSummary(doc, order) {
  const p = order.pricing;
  const count = order.items.reduce((sum, item) => sum + item.quantity, 0);
  // Orders placed before `mrpTotal` was stored still carry the gap it was derived from.
  const mrpTotal = p.mrpTotal || p.subtotal + (p.discount || 0);
  const savings = (p.discount || 0) + (p.couponDiscount || 0);

  const rows = [
    { label: `Subtotal (${count} ${count === 1 ? 'item' : 'items'})`, value: money(p.subtotal) },
    p.couponDiscount
      ? { label: `Coupon (${p.couponCode})`, value: `- ${money(p.couponDiscount)}`, tone: P.green700 }
      : null,
    p.shipping
      ? { label: 'Delivery Charges', value: money(p.shipping) }
      : { label: 'Delivery Charges', value: 'FREE', tone: P.green700 },
  ].filter(Boolean);

  const words = amountInWords(p.total);

  const savingsLine = savings > 0 ? `You saved ${money(savings)} on this order (MRP ${money(mrpTotal)})` : '';

  // The offsets below are the ones `drawSummary` draws at, read back as heights.
  const barOffset = rows.length * 15 + 6;
  const wordsH = doc.font('Helvetica').fontSize(8).heightOfString(words, { width: SUMMARY.w - 28 });
  let end = Math.max(barOffset + 56, barOffset + 46 + wordsH);
  if (savingsLine) {
    end += 4 + doc.font('Helvetica-Bold').fontSize(7.5).heightOfString(savingsLine, { width: SUMMARY.w - 28 });
  }

  return { rows, words, savingsLine, total: p.total, height: Math.max(barOffset + 68, end + 6) };
}

/**
 * Which sheet each row and the summary belong on.
 *
 * Two rules do the work. A page that ends in the slim page foot may run to
 * `FLOW_BOTTOM`; the one that carries the summary and the closing blocks stops
 * at `LAST_BOTTOM`. And when the summary cannot make its own page's cut, it
 * takes the last line item down with it — a sheet holding nothing but a total
 * reads as a printing fault, and the row it strands above reads as cut off.
 */
function paginate(doc, order, shots) {
  const rows = measureRows(doc, order, shots);
  const summary = measureSummary(doc, order);

  const pages = [];
  let page = { top: TABLE_TOP, rows: [] };
  let y = TABLE_TOP + HEAD_H;

  const close = () => {
    page.end = y;
    pages.push(page);
  };

  rows.forEach((row) => {
    if (y + row.height > FLOW_BOTTOM) {
      close();
      page = { top: PAGE_TOP, rows: [] };
      y = PAGE_TOP + HEAD_H;
    }
    page.rows.push(row);
    y += row.height;
  });
  close();

  const last = pages[pages.length - 1];
  if (last.end + SUMMARY_GAP + summary.height <= LAST_BOTTOM) {
    last.summary = summary;
    return { pages, summary };
  }

  // The summary needs a sheet of its own. Carry the final row onto it — one row,
  // not as many as will fit: emptying the page above to fill the page below
  // trades one ragged sheet for two.
  const carried = { top: PAGE_TOP, rows: [], summary };
  const roomForRows = LAST_BOTTOM - SUMMARY_GAP - summary.height;
  if (last.rows.length > 1) {
    const row = last.rows[last.rows.length - 1];
    if (PAGE_TOP + HEAD_H + row.height <= roomForRows) {
      carried.rows.push(last.rows.pop());
      last.end -= row.height;
    }
  }
  carried.end = PAGE_TOP + HEAD_H + carried.rows.reduce((sum, r) => sum + r.height, 0);
  pages.push(carried);

  return { pages, summary };
}

/* ------------------------------------------------------------------ *
 * Drawing
 * ------------------------------------------------------------------ */

function drawRows(doc, page) {
  let y = tableHead(doc, page.top);

  page.rows.forEach((row, i) => {
    const { item, meta, titleHeight, shot } = row;

    if (shot) cover(doc, shot, COLS.thumb, y + 4, 38, 8);
    else {
      doc.save().roundedRect(COLS.thumb, y + 4, 38, 38, 8).fill(P.ink50).restore();
      glyph(doc, 'inquiry-bag.png', COLS.thumb + 11, y + 14, 16);
    }

    doc
      .font('Helvetica-Bold')
      .fontSize(8.5)
      .fillColor(P.ink900)
      .text(item.name, COLS.text, y + 11, { width: COLS.textWidth, height: 22, ellipsis: true });

    if (meta) {
      doc.font('Helvetica').fontSize(7.5).fillColor(P.ink500);
      oneLine(doc, meta, COLS.text, y + 12 + titleHeight, COLS.textWidth);
    }

    doc.font('Helvetica').fontSize(9).fillColor(P.ink700);
    doc.text(String(item.quantity), COLS.qty, y + 14, { width: COLS.qtyWidth, align: 'center' });
    doc.text(money(item.finalPrice), COLS.rate, y + 14, { width: COLS.rateWidth, align: 'right' });
    doc
      .font('Helvetica-Bold')
      .fillColor(P.ink900)
      .text(money(item.lineTotal), COLS.amount, y + 14, { width: COLS.amountWidth, align: 'right' });

    y += row.height;
    if (i < page.rows.length - 1) rule(doc, y, P.ink100, 0.7, LEFT + 8, RIGHT - 8);
  });

  tableBorder(doc, page.top, y);
  return y;
}

function drawSummary(doc, summary, y) {
  const { rows, words, savingsLine } = summary;

  rows.forEach((row, i) => {
    const ry = y + i * 15;
    doc.font('Helvetica').fontSize(9).fillColor(P.ink600);
    oneLine(doc, row.label, SUMMARY.x + 14, ry, 130);
    doc
      .font('Helvetica')
      .fontSize(9)
      .fillColor(row.tone || P.ink900)
      .text(row.value, COLS.amount, ry, { width: COLS.amountWidth, align: 'right' });
  });

  const barY = y + rows.length * 15 + 6;
  doc.save().roundedRect(SUMMARY.x, barY, SUMMARY.w, 28, 7).fill(P.ink900).restore();
  doc
    .font('Helvetica-Bold')
    .fontSize(9.5)
    .fillColor(P.white)
    .text('GRAND TOTAL', SUMMARY.x + 14, barY + 9.5, { characterSpacing: 0.6, lineBreak: false });
  doc
    .fontSize(11.5)
    .text(money(summary.total), COLS.amount - 24, barY + 8, {
      width: COLS.amountWidth + 24,
      align: 'right',
    });

  doc
    .font('Helvetica-Bold')
    .fontSize(7.5)
    .fillColor(P.ink900)
    .text('Amount in Words:', SUMMARY.x + 14, barY + 36, { lineBreak: false });
  doc
    .font('Helvetica')
    .fontSize(8)
    .fillColor(P.ink600)
    .text(words, SUMMARY.x + 14, barY + 46, { width: SUMMARY.w - 28 });

  // The MRP and the two discounts, stated once, after the sum they are not part of.
  if (savingsLine) {
    doc
      .font('Helvetica-Bold')
      .fontSize(7.5)
      .fillColor(P.green700)
      .text(savingsLine, SUMMARY.x + 14, Math.max(doc.y, barY + 56) + 4, { width: SUMMARY.w - 28 });
  }
}

/**
 * The four promises, in the order mail's own words and with its own glyphs.
 *
 * Deliberately quiet: it is marketing on a document that is a record of a
 * transaction, and it is read after the total, not before it. Set a size down
 * from the invoice proper — smaller discs, smaller type, a lighter band — so it
 * reads as a strip along the foot rather than a fifth section of the invoice.
 */
function trustRow(doc, y) {
  doc
    .save()
    .roundedRect(LEFT, y, WIDTH, TRUST_H, 8)
    .lineWidth(0.8)
    .fillAndStroke(P.ink50, P.ink200)
    .restore();

  const colWidth = WIDTH / 4;
  TRUST.forEach((point, i) => {
    const x = LEFT + i * colWidth;
    if (i) dashedRule(doc, x, y + 9, x, y + TRUST_H - 9);

    disc(doc, point.icon, x + 16, y + TRUST_H / 2, 8.5, P.white, 10);
    doc.font('Helvetica-Bold').fontSize(6.8).fillColor(P.ink900);
    oneLine(doc, point.title, x + 29, y + 10, colWidth - 35);
    doc
      .font('Helvetica')
      .fontSize(6)
      .fillColor(P.ink500)
      .text(point.text, x + 29, y + 19.5, { width: colWidth - 35, lineGap: 0.5 });
  });
}

/**
 * Four columns, in the order a reader wants them: the thank-you the order mail
 * signs off with, the two channels a shopper acts on when something is wrong,
 * the networks to follow when nothing is, and a QR back to the storefront.
 *
 * Columns are fixed rather than divided evenly: the widest thing in each is a
 * different shape — a line of display serif, an email address, a row of 18pt
 * discs, a 46pt square — and four equal quarters would starve the second and
 * waste the fourth.
 */
const FOOT = {
  thanks: { x: LEFT, w: 116 },
  help: { x: 172, w: 150 },
  // Wide enough for all five networks at the chip size below, so a store that
  // fills in every profile gets the same row as one that fills in four.
  social: { x: 346, w: 124 },
  scan: { x: 488, w: RIGHT - 488 },
};

/** Chip diameter and the pitch they are set on. */
const CHIP = 18;
const CHIP_PITCH = 24;

/** The thank-you, the support channels, the networks and the QR. */
function footer(doc, brand, qr, y) {
  const socials = brand.socials.slice(0, 5);

  dashedRule(doc, 160, y + 2, 160, y + 52);
  dashedRule(doc, 334, y + 2, 334, y + 52);
  if (socials.length) dashedRule(doc, 480, y + 2, 480, y + 52);

  /* Thank you */
  const thanks = FOOT.thanks;
  const centre = thanks.x + thanks.w / 2;
  doc
    .font('Times-Bold')
    .fontSize(18)
    .fillColor(P.ink900)
    .text('Thank You', thanks.x, y, { width: thanks.w, align: 'center', lineBreak: false });
  rule(doc, y + 26, P.accent100, 1, centre - 33, centre - 13);
  heart(doc, centre, y + 26, 4.5);
  rule(doc, y + 26, P.accent100, 1, centre + 13, centre + 33);
  doc
    .font('Helvetica')
    .fontSize(9.5)
    .fillColor(P.ink600)
    .text('for shopping with us!', thanks.x, y + 33, { width: thanks.w, align: 'center', lineBreak: false });

  /* Need help */
  const help = FOOT.help;
  doc
    .font('Helvetica-Bold')
    .fontSize(8.5)
    .fillColor(P.accentDark)
    .text('Need Help?', help.x, y + 2, { lineBreak: false });

  let helpY = y + 18;
  if (brand.supportEmail) {
    glyph(doc, 'inquiry-mail.png', help.x, helpY, 10);
    doc.font('Helvetica').fontSize(7.5).fillColor(P.ink600);
    oneLine(doc, `Contact us at ${brand.supportEmail}`, help.x + 14, helpY + 1.5, help.w - 14);
    helpY += 14;
  }
  if (brand.supportPhone) {
    glyph(doc, 'inquiry-phone.png', help.x, helpY, 10);
    doc.font('Helvetica').fontSize(7.5).fillColor(P.ink600);
    oneLine(doc, `or call us at ${brand.supportPhone}`, help.x + 14, helpY + 1.5, help.w - 14);
  }

  /* Follow us — its own column, and no column at all when nothing is configured. */
  if (socials.length) {
    const social = FOOT.social;
    // Ink, not the gold "Need Help?" wears: that heading is a call to action and
    // this one is a label over a row of marks that already carry all the colour
    // this corner of the page can hold.
    doc
      .font('Helvetica-Bold')
      .fontSize(8.5)
      .fillColor(P.ink900)
      .text('Follow Us', social.x, y + 2, { lineBreak: false });

    // Chips only. A handle underneath would have to be invented from the site
    // name, and a printed @name that turns out not to exist is worse than none.
    socials.forEach((network, i) => {
      glyph(doc, network.file.replace('social-', 'social-color-'), social.x + i * CHIP_PITCH, y + 22, CHIP);
    });
  }

  /* Scan to visit — caption under the code rather than beside it, which is what
     lets this column be narrow enough for the row of chips to its left. */
  const scan = FOOT.scan;
  const boxX = scan.x + (scan.w - 44) / 2;
  if (qr) {
    doc.save().roundedRect(boxX, y + 1, 44, 44, 8).lineWidth(1).fillAndStroke(P.white, P.accent).restore();
    try {
      doc.image(qr, boxX + 5, y + 6, { width: 34, height: 34 });
    } catch (err) {
      logger.warn(`Invoice QR could not be drawn: ${err.message}`);
    }
  }
  doc
    .font('Helvetica')
    .fontSize(6.5)
    .fillColor(P.ink500)
    .text('Scan to visit our website', scan.x, y + 47, { width: scan.w, align: 'center', lineBreak: false });

}

const SIGNATURE = 'This is a computer-generated invoice and does not require a physical signature.';

/**
 * The line every sheet ends on, and what makes the two feet read as one design
 * rather than two: the page position on the right, and — on the sheet that
 * closes the document — the signature note beside it.
 *
 * No rule above it and no repeated invoice reference. Both were structure the
 * page did not need: the reference is already on the meta card at the top, and a
 * hairline 16pt under a table that has its own border only reads as a second
 * border. On a continuation page this whole foot costs 16pt where the closing
 * blocks cost 126, which is the point — the paper it gives back is paper the
 * item table gets to use.
 */
function footLine(doc, page, pages, note = '') {
  doc.font('Helvetica').fontSize(7).fillColor(P.ink400);
  if (note) doc.text(note, LEFT, PAGE_FOOT_TEXT, { width: WIDTH, align: 'center', lineBreak: false });
  // Printed on every invoice, a one-page one included. "Page 1 of 1" is not
  // noise on a document that gets printed and filed: it is the line that says
  // nothing came after it, and its absence is what makes a reader wonder
  // whether a second sheet went missing.
  doc.text(`Page ${page} of ${pages}`, LEFT, PAGE_FOOT_TEXT, {
    width: WIDTH,
    align: 'right',
    lineBreak: false,
  });
}

/**
 * The closing blocks, on the lines they always sit on.
 *
 * They do not chase the end of the content: the trust strip and the footer are
 * anchored to `TRUST_Y` and `FOOTER_Y`, so the foot of an invoice with two items
 * is printed exactly where the foot of one with twenty is.
 */
function closing(doc, brand, qr, pages) {
  trustRow(doc, TRUST_Y);
  footer(doc, brand, qr, FOOTER_Y);
  footLine(doc, pages, pages, SIGNATURE);
}

/* ------------------------------------------------------------------ *
 * Entry point
 * ------------------------------------------------------------------ */

/**
 * Streams a printable A4 order invoice into `res`.
 *
 * Async on purpose: the branding, the logo, the product shots and the QR are all
 * resolved *before* the first byte is written, because a stream that has already
 * started cannot turn back into a JSON error. Everything remote is optional and
 * falls back to something drawn locally, so a slow Cloudinary never costs a
 * shopper their invoice.
 */
async function streamInvoice(order, res) {
  const brand = await getBranding().catch(() => ({
    siteName: env.appName,
    logoUrl: '',
    supportEmail: '',
    supportPhone: '',
    address: '',
    socials: [],
  }));

  const [logo, qr, ...shots] = await Promise.all([
    fetchImage(brand.logoUrl),
    QRCode.toBuffer(env.clientUrl, {
      type: 'png',
      margin: 0,
      width: 200,
      color: { dark: `${P.ink900}ff`, light: '#ffffffff' },
    }).catch((err) => {
      logger.warn(`Invoice QR could not be generated: ${err.message}`);
      return null;
    }),
    ...order.items.map((item) => fetchImage(thumb(item.image))),
  ]);

  const doc = new PDFDocument({ size: 'A4', margin: 0 });

  res.setHeader('Content-Type', 'application/pdf');
  res.setHeader('Content-Disposition', `attachment; filename="${order.invoiceNumber}.pdf"`);
  doc.pipe(res);

  // Measured first, drawn second — every page knows how many sheets it is one of
  // before it is printed, which is what the page counter needs and what lets a
  // continuation sheet use the paper the closing blocks are not standing on.
  const { pages } = paginate(doc, order, shots);

  pages.forEach((page, i) => {
    if (i) doc.addPage();
    if (!i) {
      header(doc, brand, logo);
      titleBlock(doc, order);
      customerCard(doc, order);
      paymentCard(doc, order);
    }

    const end = drawRows(doc, page);
    if (page.summary) drawSummary(doc, page.summary, end + SUMMARY_GAP);
    else footLine(doc, i + 1, pages.length);
  });

  closing(doc, brand, qr, pages.length);

  doc.end();
}

module.exports = { streamInvoice };
