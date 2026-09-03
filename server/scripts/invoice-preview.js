/**
 * Renders the order invoice in src/services/invoice.service.js to a PDF you can
 * open, without touching an order and without an HTTP request.
 *
 *   node scripts/invoice-preview.js          # render, then print the file paths
 *   node scripts/invoice-preview.js --open   # ...and open them in the viewer
 *   node scripts/invoice-preview.js --no-db  # skip Mongo; use env fallback branding
 *
 * Nothing about the document is duplicated here. The script hands the real
 * `streamInvoice` a response object that writes to a file instead of a socket,
 * and calls it with fixtures — so a preview can never drift from the PDF a
 * shopper downloads.
 *
 * Two renderings of one order, differing only in how many lines it has, because
 * the length is the one thing that changes the shape of the page:
 *
 *   invoice.pdf         every line — the table breaks, so the continuation sheet
 *                       and its missing masthead are on show, and the summary
 *                       and closing blocks sit on a second page
 *   invoice-1-page.pdf  the first three lines — everything closes on one sheet,
 *                       which is what puts the footer's fixed position and the
 *                       white space above it under the eye
 *
 * Everything else is shared, so a difference between the two files is a
 * pagination decision and nothing else. Between them they carry everything the
 * layout can put on a page: the three-row payment panel with a gateway
 * reference, a coupon deduction, a delivery charge, the savings line under the
 * summary, and item rows with and without a variant and with and without a
 * thumbnail. The states this order cannot also be — cash on delivery, refunded,
 * an online order whose gateway reference was never recorded — only ever take a
 * row away from what you see here.
 */

const fs = require('fs');
const path = require('path');
const { execFile } = require('child_process');

const env = require('../src/config/env');

const OUT_DIR = path.join(__dirname, '../.invoice-preview');

const args = process.argv.slice(2);
const useDb = !args.includes('--no-db');
const shouldOpen = args.includes('--open');

/* ------------------------------------------------------------------ *
 * Branding
 *
 * getBranding() reads the admin's Organization settings, so a preview against
 * the real database shows the real logo, support line and social chips. Without
 * one, mongoose would buffer the query for ten seconds before giving up;
 * disabling buffering makes it fail immediately and the service falls back to
 * its env defaults, which is the other thing worth previewing anyway.
 * ------------------------------------------------------------------ */

async function connectDb() {
  const mongoose = require('mongoose');
  if (!useDb || !env.mongoUri) {
    // Without this, the very first getBranding() sits in mongoose's buffer for
    // ten seconds before failing to the fallback the run already asked for.
    mongoose.set('bufferCommands', false);
    return false;
  }
  try {
    await mongoose.connect(env.mongoUri, { serverSelectionTimeoutMS: 5000 });
    return true;
  } catch (err) {
    console.warn(`  ! Mongo unavailable (${err.message.split('\n')[0]}) — using fallback branding`);
    mongoose.set('bufferCommands', false);
    return false;
  }
}

/* ------------------------------------------------------------------ *
 * A response that is a file
 *
 * streamInvoice only ever asks for setHeader() and the writable end of `res`,
 * so a WriteStream with two extra methods is the whole contract. The headers
 * are kept because the filename the service chooses is worth seeing.
 * ------------------------------------------------------------------ */

function fileResponse(filePath) {
  const stream = fs.createWriteStream(filePath);
  const headers = {};
  stream.setHeader = (name, value) => {
    headers[name.toLowerCase()] = value;
  };
  stream.getHeader = (name) => headers[name.toLowerCase()];
  return stream;
}

/* ------------------------------------------------------------------ *
 * The fixture
 * ------------------------------------------------------------------ */

const day = 24 * 60 * 60 * 1000;
/** A fixed offset from a fixed instant, so re-running produces the same file. */
const NOW = new Date('2026-05-12T14:32:00+05:30').getTime();

const address = {
  fullName: 'Ananya Sharma',
  addressLine1: 'Flat 402, Sunrise Residency',
  addressLine2: '17th Cross, HSR Layout Sector 3',
  landmark: 'Opposite BDA Complex',
  city: 'Bengaluru',
  state: 'Karnataka',
  pincode: '560102',
  country: 'India',
  phone: '+91 98450 12345',
};

/**
 * `finalPrice` is the per-unit price the row is billed at and `lineTotal` is
 * that times the quantity. The invoice prints both and derives neither from the
 * other, so a fixture that disagreed with itself would look right here and be
 * wrong in production.
 *
 * The list runs long on purpose — it is what breaks the table onto a second
 * page — and mixes every shape a row comes in: with a variant and without, with
 * a thumbnail and without, and a name long enough to have to wrap inside its
 * column. `variantSku` is still set on the fixtures because an order carries it;
 * the invoice simply no longer prints it.
 */
const items = [
  {
    name: 'Aurora Wireless Over-Ear Headphones',
    variantLabel: 'Midnight Blue',
    variantSku: 'AUR-OE-MDB',
    quantity: 1,
    finalPrice: 8499,
    lineTotal: 8499,
    image: 'https://res.cloudinary.com/demo/image/upload/sample.jpg',
  },
  {
    name: 'Braided USB-C Fast Charging Cable (2 m)',
    variantLabel: '',
    variantSku: 'CBL-USBC-2M',
    quantity: 2,
    finalPrice: 399,
    lineTotal: 798,
    image: '',
  },
  {
    name: 'Travel Case for Over-Ear Headphones',
    variantLabel: 'Charcoal',
    variantSku: '',
    quantity: 1,
    finalPrice: 1299,
    lineTotal: 1299,
    image: 'https://res.cloudinary.com/demo/image/upload/shoes.jpg',
  },
  {
    name: 'Studio Reference Monitor Headphones with Detachable Cable and Carry Pouch',
    variantLabel: 'Graphite',
    variantSku: 'STU-RM-GRP',
    quantity: 1,
    finalPrice: 12499,
    lineTotal: 12499,
    image: '',
  },
  {
    name: 'Replacement Memory Foam Ear Cushions',
    variantLabel: 'Protein Leather',
    variantSku: 'CSH-MF-PL',
    quantity: 2,
    finalPrice: 899,
    lineTotal: 1798,
    image: '',
  },
  {
    name: 'Desktop Headphone Stand, Solid Walnut',
    variantLabel: '',
    variantSku: 'STD-WAL-01',
    quantity: 1,
    finalPrice: 1999,
    lineTotal: 1999,
    image: 'https://res.cloudinary.com/demo/image/upload/sample.jpg',
  },
  {
    name: '3.5 mm Audio Cable with Inline Microphone',
    variantLabel: '1.2 m',
    variantSku: '',
    quantity: 3,
    finalPrice: 549,
    lineTotal: 1647,
    image: '',
  },
  {
    name: 'Bluetooth Audio Transmitter for In-Flight Entertainment',
    variantLabel: '',
    variantSku: 'BTX-AIR-02',
    quantity: 1,
    finalPrice: 2299,
    lineTotal: 2299,
    image: '',
  },
  {
    name: 'Microfibre Cleaning Kit',
    variantLabel: '',
    variantSku: '',
    quantity: 1,
    finalPrice: 349,
    lineTotal: 349,
    image: '',
  },
  {
    name: 'Extended Warranty — 2 Years, Accidental Damage',
    variantLabel: 'Plan B',
    variantSku: 'WTY-2Y-ADP',
    quantity: 1,
    finalPrice: 1499,
    lineTotal: 1499,
    image: '',
  },
  {
    name: 'Gift Wrap and Handwritten Note',
    variantLabel: 'Kraft',
    variantSku: 'GFT-KRF',
    quantity: 1,
    finalPrice: 149,
    lineTotal: 149,
    image: '',
  },
];

/**
 * The pricing for a given set of lines, derived from them rather than written
 * out: the item table sums to `subtotal`, and from there the coupon is the only
 * deduction — `subtotal − couponDiscount + shipping = total`. `mrpTotal` and
 * `discount` are the display pair, the pre-discount original and the saving
 * already inside `subtotal`, so they sit outside that sum.
 *
 * Derived, because the two fixtures hold different lines: a hand-written
 * subtotal would agree with one of them and quietly lie on the other.
 */
const pricingFor = (lines) => {
  const subtotal = lines.reduce((sum, item) => sum + item.lineTotal, 0);
  // A quarter off the MRP, so the savings line has something to say on both.
  const discount = Math.round(subtotal / 3);
  return {
    mrpTotal: subtotal + discount,
    subtotal,
    discount,
    couponDiscount: 500,
    couponCode: 'WELCOME500',
    shipping: 79,
    total: subtotal - 500 + 79,
  };
};

const orderWith = (lines) => ({
  _id: '6631f0a2c4d5e6f70123abcd',
  orderNumber: 'ORD2627000418',
  invoiceNumber: 'INV2627000418',
  createdAt: new Date(NOW - 6 * day),
  // Issued two days after the order was placed, so the preview shows the two
  // dates doing what they are there to do: differing.
  invoicedAt: new Date(NOW - 4 * day),
  paymentMethod: 'razorpay',
  paymentStatus: 'paid',
  // The Payment document the controller populates onto the order. Only its
  // `razorpayPaymentId` is read — it is the transaction id on the payment panel.
  payment: { razorpayPaymentId: 'pay_QeR8kZ2mTv91Lx' },
  items: lines,
  pricing: pricingFor(lines),
  shippingAddress: address,
});

/**
 * The two renderings. Same order, different lengths — the only variable that
 * changes the shape of the page.
 */
const CASES = [
  { file: 'invoice.pdf', label: 'every line — the table breaks onto a second sheet', lines: items },
  { file: 'invoice-1-page.pdf', label: 'three lines — everything closes on one sheet', lines: items.slice(0, 3) },
];

/* ------------------------------------------------------------------ *
 * Main
 * ------------------------------------------------------------------ */

async function main() {
  const connected = await connectDb();
  // Required only once the DB has been decided: the service resolves its
  // branding on the first call, not at module load.
  const { streamInvoice } = require('../src/services/invoice.service');

  fs.mkdirSync(OUT_DIR, { recursive: true });

  const branding = connected ? 'live Organization settings' : 'env fallback';
  const written = [];

  // Sequentially: the second run reuses the branding the first one resolved, and
  // racing them to render two A4 pages buys nothing worth the tangle.
  for (const preview of CASES) {
    const out = path.join(OUT_DIR, preview.file);
    const res = fileResponse(out);
    // streamInvoice returns as soon as it has called doc.end(); the bytes are
    // still draining into the file, so the size below has to wait for `finish`.
    const drained = new Promise((resolve, reject) => {
      res.on('finish', resolve);
      res.on('error', reject);
    });

    await streamInvoice(orderWith(preview.lines), res);
    await drained;

    const kb = Math.round(fs.statSync(out).size / 1024);
    console.log(`  ✓ ${preview.file} — ${preview.label} (${kb} KB)`);
    written.push(out);
  }

  console.log(`\n  ${written.length} previews, branding: ${branding}`);
  written.forEach((out) => console.log(`  → ${out}`));
  console.log();

  if (connected) await require('mongoose').disconnect();
  if (shouldOpen) {
    // `start` is a cmd builtin, hence the shell; `open`/`xdg-open` are binaries.
    written.forEach((out) => {
      const opener =
        process.platform === 'win32'
          ? ['cmd', ['/c', 'start', '', out]]
          : process.platform === 'darwin'
            ? ['open', [out]]
            : ['xdg-open', [out]];
      execFile(opener[0], opener[1]);
    });
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
