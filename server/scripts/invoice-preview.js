/**
 * Renders the tax invoice in src/services/invoice.service.js to a browsable set
 * of PDFs, without touching an order and without an HTTP request.
 *
 *   node scripts/invoice-preview.js          # render, then print the index path
 *   node scripts/invoice-preview.js --open   # ...and open it in the browser
 *   node scripts/invoice-preview.js --no-db  # skip Mongo; use env fallback branding
 *
 * Nothing about the document is duplicated here. The script hands the real
 * `streamInvoice` a response object that writes to a file instead of a socket,
 * and calls it with fixtures — so a preview can never drift from the PDF a
 * shopper downloads.
 *
 * The fixtures cover what the layout actually has to decide between: a paid card
 * order with a coupon, a COD order still awaiting payment, a single line with no
 * saving at all, a refunded one, and an order long enough to break the table and
 * push the summary and closing blocks onto a second page.
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
 * Fixtures
 * ------------------------------------------------------------------ */

const day = 24 * 60 * 60 * 1000;
/** A fixed offset from a fixed instant, so re-running produces the same files. */
const NOW = new Date('2026-05-12T14:32:00+05:30').getTime();
const ago = (days) => new Date(NOW - days * day);

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
];

/**
 * The item table sums to `subtotal` — every line billed at its discounted
 * selling price — and from there the coupon is the only deduction:
 * `subtotal − couponDiscount + shipping = total`. `mrpTotal` and `discount` are
 * the display pair, the pre-discount original and the saving already inside
 * `subtotal`, so they sit outside that sum.
 */
const pricing = {
  mrpTotal: 11396,
  subtotal: 10596,
  discount: 800,
  couponDiscount: 500,
  couponCode: 'WELCOME500',
  shipping: 0,
  total: 10096,
};

const order = (overrides = {}) => ({
  _id: '6631f0a2c4d5e6f70123abcd',
  orderNumber: 'ORD2627000418',
  invoiceNumber: 'INV2627000418',
  createdAt: ago(6),
  paymentMethod: 'razorpay',
  paymentStatus: 'paid',
  items,
  pricing,
  shippingAddress: address,
  ...overrides,
});

/** Long enough that the table has to break and carry its head onto page two. */
const manyItems = Array.from({ length: 11 }, (_, i) => ({
  name:
    i % 3 === 0
      ? 'Studio Reference Monitor Headphones with Detachable Cable and Carry Pouch'
      : `Accessory Bundle ${i + 1}`,
  variantLabel: i % 2 ? 'Charcoal' : '',
  variantSku: `SKU-${1000 + i}`,
  quantity: (i % 3) + 1,
  finalPrice: 749 + i * 110,
  lineTotal: (749 + i * 110) * ((i % 3) + 1),
  image: i % 4 === 0 ? 'https://res.cloudinary.com/demo/image/upload/sample.jpg' : '',
}));
const manySubtotal = manyItems.reduce((sum, item) => sum + item.lineTotal, 0);

const CASES = [
  {
    file: 'paid-card',
    label: 'Paid — card, coupon applied',
    note: 'Three lines, a coupon deduction and free delivery. The everyday invoice.',
    order: order(),
  },
  {
    file: 'cod-pending',
    label: 'Cash on delivery — payment pending',
    note: 'The amber payment chip, and a delivery charge that is actually charged.',
    order: order({
      paymentMethod: 'cod',
      paymentStatus: 'pending',
      pricing: { ...pricing, shipping: 79, total: 10175 },
    }),
  },
  {
    file: 'single-item',
    label: 'Single item — no saving',
    note: 'No coupon row and no savings line: the shortest the summary gets.',
    order: order({
      items: [items[0]],
      pricing: { mrpTotal: 8499, subtotal: 8499, discount: 0, shipping: 0, total: 8499 },
    }),
  },
  {
    file: 'refunded',
    label: 'Refunded',
    note: 'A returned order still prints its invoice — the payment chip goes quiet.',
    order: order({ paymentStatus: 'refunded' }),
  },
  {
    file: 'multi-page',
    label: 'Eleven lines — page break',
    note: 'The table breaks, the head repeats, and the closing blocks find a page.',
    order: order({
      items: manyItems,
      pricing: {
        mrpTotal: manySubtotal + 1200,
        subtotal: manySubtotal,
        discount: 1200,
        couponDiscount: 0,
        shipping: 0,
        total: manySubtotal,
      },
    }),
  },
];

/* ------------------------------------------------------------------ *
 * Index
 * ------------------------------------------------------------------ */

const escapeHtml = (value = '') =>
  String(value).replace(
    /[&<>"']/g,
    (char) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[char]
  );

const INDEX_STYLE = `
  :root{color-scheme:light dark}
  *{box-sizing:border-box}
  body{margin:0;padding:40px 20px;background:#f1f5f9;color:#0f172a;
       font:400 15px/1.6 Inter,'Segoe UI',Roboto,Helvetica,Arial,sans-serif}
  .wrap{max-width:820px;margin:0 auto}
  h1{margin:0 0 6px;font-size:28px;letter-spacing:-.5px}
  .sub{margin:0 0 32px;color:#64748b;font-size:14px}
  ul{list-style:none;margin:0;padding:0;display:grid;gap:10px}
  li{background:#fff;border:1px solid #e2e8f0;border-radius:12px}
  a.card{display:flex;gap:14px;align-items:baseline;flex-wrap:wrap;
         padding:14px 18px;text-decoration:none;color:inherit}
  a.card:hover{background:#f8fafc}
  .name{font-weight:700}
  .note{color:#64748b;font-size:13px}
  .meta{width:100%;color:#475569;font-size:13px}
  .meta b{color:#0f172a;font-weight:600}
  footer{margin:36px 0 0;color:#94a3b8;font-size:12px;text-align:center}
  @media (prefers-color-scheme:dark){
    body{background:#0b1120;color:#e2e8f0}
    li{background:#111c33;border-color:#1e293b}
    a.card:hover{background:#16233d}
    .meta b{color:#f8fafc}
  }`;

const indexPage = (rendered, branding) => `<!doctype html>
<html lang="en"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>Invoice previews</title><style>${INDEX_STYLE}</style></head>
<body>
  <div class="wrap">
    <h1>Invoice previews</h1>
    <p class="sub">
      ${rendered.length} rendering${rendered.length === 1 ? '' : 's'} of the document in
      <code>src/services/invoice.service.js</code>. Branding: <b>${escapeHtml(branding)}</b>.
      Each link opens the PDF exactly as <code>GET /orders/:id/invoice</code> streams it.
    </p>
    <ul>
      ${rendered
        .map(
          (entry) => `
        <li>
          <a class="card" href="${entry.file}.pdf" target="_blank" rel="noopener">
            <span class="name">${escapeHtml(entry.label)}</span>
            <span class="note">${escapeHtml(entry.note)}</span>
            <span class="meta">File: <b>${escapeHtml(entry.filename)}</b> &middot; ${entry.kb} KB</span>
          </a>
        </li>`
        )
        .join('')}
    </ul>
    <footer>Regenerate with <code>npm run invoice:preview</code>. No order was touched.</footer>
  </div>
</body></html>`;

/* ------------------------------------------------------------------ *
 * Main
 * ------------------------------------------------------------------ */

async function main() {
  const connected = await connectDb();
  // Required only once the DB has been decided: the service resolves its
  // branding on the first call, not at module load.
  const { streamInvoice } = require('../src/services/invoice.service');

  fs.mkdirSync(OUT_DIR, { recursive: true });

  const rendered = [];
  for (const preview of CASES) {
    const filePath = path.join(OUT_DIR, `${preview.file}.pdf`);
    const res = fileResponse(filePath);
    // streamInvoice returns as soon as it has called doc.end(); the bytes are
    // still draining into the file, so the size below has to wait for `finish`.
    const written = new Promise((resolve, reject) => {
      res.on('finish', resolve);
      res.on('error', reject);
    });

    await streamInvoice(preview.order, res);
    await written;

    const kb = Math.round(fs.statSync(filePath).size / 1024);
    const disposition = /filename="([^"]+)"/.exec(res.getHeader('content-disposition') || '');
    rendered.push({ ...preview, kb, filename: disposition ? disposition[1] : `${preview.file}.pdf` });
    console.log(`  ✓ ${preview.file}.pdf — ${preview.label} (${kb} KB)`);
  }

  const indexPath = path.join(OUT_DIR, 'index.html');
  fs.writeFileSync(
    indexPath,
    indexPage(rendered, connected ? 'live Organization settings' : 'env fallback')
  );

  console.log(`\n${rendered.length} previews → ${indexPath}`);

  if (connected) await require('mongoose').disconnect();
  if (shouldOpen) {
    // `start` is a cmd builtin, hence the shell; `open`/`xdg-open` are binaries.
    const opener =
      process.platform === 'win32'
        ? ['cmd', ['/c', 'start', '', indexPath]]
        : process.platform === 'darwin'
          ? ['open', [indexPath]]
          : ['xdg-open', [indexPath]];
    execFile(opener[0], opener[1]);
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
