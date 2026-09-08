/**
 * Fires a correctly signed Razorpay webhook at this API, so the whole path —
 * signature check, dedupe, handler, database write — can be exercised without
 * waiting on a real payment or exposing a laptop to the internet.
 *
 *   node scripts/webhook-test.js --list
 *   node scripts/webhook-test.js payment.captured --order order_QabcXYZ
 *   node scripts/webhook-test.js refund.processed --payment pay_QabcXYZ --amount 499
 *   node scripts/webhook-test.js payment.captured --order order_X --url https://api.example.com
 *
 * `--order` is the Razorpay order id stored on the Payment row (`razorpayOrderId`),
 * not this store's order number; `--payment` is `razorpayPaymentId`. Pass a real
 * one from your own database and the handler will act on that order for real — on
 * a development database, which is the point. Without one it invents an id, the
 * signature still verifies, and the event is recorded as `ignored` because no such
 * payment exists. That alone is a useful test: it proves the URL, the secret and
 * the ledger all work.
 *
 * The signature is a plain HMAC-SHA256 of the exact JSON bytes under
 * RAZORPAY_WEBHOOK_SECRET — the same thing Razorpay does, which is why this is a
 * genuine test of the endpoint rather than a bypass of it.
 *
 * Sending the same event twice with the same --event-id is how to check
 * idempotency: the second one should come back {"duplicate": true} and change
 * nothing.
 */

const crypto = require('crypto');
const env = require('../src/config/env');

const args = process.argv.slice(2);
const flag = (name, fallback) => {
  const i = args.indexOf(`--${name}`);
  return i === -1 ? fallback : args[i + 1];
};

/** The event name is the first bare word — anything that is neither a flag nor a flag's value. */
const eventName = args.find(
  (arg, i) => !arg.startsWith('--') && !args[i - 1]?.startsWith('--')
);

const now = Math.floor(Date.now() / 1000);
const paise = (rupees) => Math.round(Number(rupees) * 100);

/** Payload shapes trimmed to the fields the handlers actually read. */
const BUILDERS = {
  'payment.authorized': (o) => ({
    payment: { entity: { id: o.paymentId, order_id: o.orderId, amount: paise(o.amount), method: 'upi', status: 'authorized' } },
  }),
  'payment.captured': (o) => ({
    payment: {
      entity: {
        id: o.paymentId, order_id: o.orderId, amount: paise(o.amount), status: 'captured',
        method: 'upi', vpa: 'shopper@okhdfcbank', fee: paise(o.amount * 0.02), tax: paise(o.amount * 0.0036),
      },
    },
  }),
  'payment.failed': (o) => ({
    payment: {
      entity: {
        id: o.paymentId, order_id: o.orderId, amount: paise(o.amount), status: 'failed',
        error_code: 'BAD_REQUEST_ERROR', error_description: 'Payment was not completed on time',
      },
    },
  }),
  'order.paid': (o) => ({
    order: { entity: { id: o.orderId, amount: paise(o.amount), status: 'paid' } },
    payment: { entity: { id: o.paymentId, order_id: o.orderId, amount: paise(o.amount), method: 'card', status: 'captured' } },
  }),
  'refund.created': (o) => ({
    refund: { entity: { id: o.refundId, payment_id: o.paymentId, amount: paise(o.amount), status: 'created', speed_requested: 'normal' } },
  }),
  'refund.processed': (o) => ({
    refund: {
      entity: {
        id: o.refundId, payment_id: o.paymentId, amount: paise(o.amount), status: 'processed',
        speed_processed: 'normal', created_at: now, acquirer_data: { arn: '10000000000000' },
      },
    },
  }),
  'refund.failed': (o) => ({
    refund: { entity: { id: o.refundId, payment_id: o.paymentId, amount: paise(o.amount), status: 'failed' } },
  }),
  'refund.speed_changed': (o) => ({
    refund: { entity: { id: o.refundId, payment_id: o.paymentId, amount: paise(o.amount), status: 'processed', speed_requested: 'optimum', speed_processed: 'normal' } },
  }),
  'payment.dispute.created': (o) => ({
    payment: {
      entity: { id: o.paymentId },
      dispute: {
        entity: {
          id: o.disputeId, payment_id: o.paymentId, amount: paise(o.amount), status: 'open',
          phase: 'chargeback', reason_code: 'FRAUD', reason_description: 'Cardholder does not recognise the transaction',
          respond_by: now + 7 * 86400, created_at: now,
        },
      },
    },
  }),
  'payment.dispute.won': (o) => ({
    payment: { entity: { id: o.paymentId }, dispute: { entity: { id: o.disputeId, payment_id: o.paymentId, amount: paise(o.amount), status: 'won' } } },
  }),
  'payment.dispute.lost': (o) => ({
    payment: { entity: { id: o.paymentId }, dispute: { entity: { id: o.disputeId, payment_id: o.paymentId, amount: paise(o.amount), status: 'lost' } } },
  }),
  'payment.downtime.started': () => ({
    'payment.downtime': { entity: { id: `down_${Date.now()}`, method: 'upi', status: 'started', severity: 'high', begin: now, instrument: { vpa_handle: 'okhdfcbank' } } },
  }),
  'payment.downtime.resolved': (o) => ({
    'payment.downtime': { entity: { id: o.downtimeId || 'down_test', method: 'upi', status: 'resolved', begin: now - 600 } },
  }),
  'settlement.processed': (o) => ({
    settlement: { entity: { id: `setl_${Date.now()}`, amount: paise(o.amount), fees: paise(o.amount * 0.02), tax: paise(o.amount * 0.0036), utr: 'UTR0000TEST', status: 'processed' } },
  }),
};

if (args.includes('--list') || !eventName) {
  console.log('Usage: node scripts/webhook-test.js <event> [--order <razorpayOrderId>] [--payment <razorpayPaymentId>]');
  console.log('                                            [--amount <rupees>] [--url <base>] [--event-id <id>]\n');
  console.log('Events this script can build:');
  for (const name of Object.keys(BUILDERS)) console.log(`  ${name}`);
  process.exit(args.includes('--list') ? 0 : 1);
}

const build = BUILDERS[eventName];
if (!build) {
  console.error(`No sample payload for "${eventName}". Run with --list to see the available events.`);
  process.exit(1);
}

if (!env.razorpay.webhookSecret) {
  console.error('RAZORPAY_WEBHOOK_SECRET is not set — the server would reject this with 503 anyway.');
  process.exit(1);
}

const suffix = Date.now().toString(36);
const payload = build({
  orderId: flag('order', `order_TEST${suffix}`),
  paymentId: flag('payment', `pay_TEST${suffix}`),
  refundId: flag('refund', `rfnd_TEST${suffix}`),
  disputeId: flag('dispute', `disp_TEST${suffix}`),
  downtimeId: flag('downtime'),
  amount: Number(flag('amount', 499)),
});

const body = JSON.stringify({
  entity: 'event',
  account_id: 'acc_TEST',
  event: eventName,
  contains: Object.keys(payload),
  payload,
  created_at: now,
});

const signature = crypto
  .createHmac('sha256', env.razorpay.webhookSecret)
  .update(body)
  .digest('hex');

/**
 * `--url` means the base origin, and the endpoint path is appended below. But the
 * obvious thing to paste is the whole URL you just typed into the Razorpay
 * dashboard, and doing that used to produce `/api/v1/payments/webhook` twice and a
 * 404 that looks like the route is missing. Any endpoint path already on the end is
 * stripped back off, so both forms work.
 */
function originOf(value) {
  let base = (value || '').replace(/\/+$/, '');
  for (;;) {
    const before = base;
    base = base.replace(/\/payments\/webhook$/, '');
    if (env.apiPrefix && base.endsWith(env.apiPrefix)) base = base.slice(0, -env.apiPrefix.length);
    if (base === before) return base;
  }
}

const base = originOf(flag('url', env.serverUrl));
if (!base) {
  console.error('No target. Pass --url https://your-api-host, or set SERVER_URL in .env.');
  process.exit(1);
}
const url = `${base}${env.apiPrefix}/payments/webhook`;
const eventId = flag('event-id', `evt_TEST${suffix}`);

(async () => {
  console.log(`POST ${url}`);
  console.log(`     event ${eventName}  event-id ${eventId}\n`);

  const res = await fetch(url, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'X-Razorpay-Signature': signature,
      'X-Razorpay-Event-Id': eventId,
    },
    body,
  });

  const text = await res.text();
  console.log(`${res.status} ${res.statusText}`);
  console.log(text);

  if (res.status === 400) console.log('\n400 means the signature did not match — the server and this script are reading different secrets.');
  if (res.status === 503) console.log('\n503 means the server has no RAZORPAY_WEBHOOK_SECRET set.');
  process.exit(res.ok ? 0 : 1);
})().catch((err) => {
  console.error(`Could not reach ${url}: ${err.message}`);
  process.exit(1);
});
