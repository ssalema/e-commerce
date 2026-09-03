/**
 * Backfills Order.invoicedAt on orders placed before the field existed.
 *
 *   node scripts/backfill-invoiced-at.js --dry-run   # count only, write nothing
 *   node scripts/backfill-invoiced-at.js             # write
 *
 * `invoicedAt` is the date the invoice was issued, stamped by the download
 * endpoint the first time it generates the PDF. Orders that predate the field
 * have none, and the invoice falls back to `createdAt` for them — which reads
 * correctly today but is not stable: the first time anyone downloads one of
 * those old invoices the endpoint stamps it with *today*, and a 2024 order
 * suddenly claims to have been invoiced this morning.
 *
 * Setting `invoicedAt = createdAt` on the whole backlog closes that. It is the
 * honest value: for every one of those orders the invoice was issued at
 * checkout, because there was no separate issuing step to record. After this
 * runs, only orders created from here on get a genuinely distinct issue date.
 *
 * Idempotent — it only ever touches documents where the field is still absent,
 * so running it twice is running it once.
 */

const mongoose = require('mongoose');

const env = require('../src/config/env');
const Order = require('../src/models/Order');

const dryRun = process.argv.slice(2).includes('--dry-run');

async function main() {
  if (!env.mongoUri) throw new Error('MONGO_URI is not set — nothing to migrate.');

  await mongoose.connect(env.mongoUri, { serverSelectionTimeoutMS: 5000 });
  console.warn(`Connected to ${mongoose.connection.name}`);

  // `null` matches both an explicit null and a missing field, which is what an
  // order written before the field existed actually has.
  const filter = { invoicedAt: null };
  const pending = await Order.countDocuments(filter);

  if (!pending) {
    console.warn('Nothing to backfill — every order already carries an issue date.');
    return;
  }

  if (dryRun) {
    console.warn(`${pending} order(s) would be stamped with their own createdAt. No write made.`);
    return;
  }

  // An aggregation pipeline update, so each document is set from its own
  // createdAt in one pass — a find-then-save loop over a year of orders is a
  // round trip per document for a value the server already has.
  const { modifiedCount } = await Order.updateMany(filter, [
    { $set: { invoicedAt: '$createdAt' } },
  ]);

  console.warn(`Backfilled ${modifiedCount} of ${pending} order(s).`);

  const left = await Order.countDocuments(filter);
  if (left) console.warn(`! ${left} order(s) still without an issue date — re-run to finish.`);
}

main()
  .catch((err) => {
    console.error(err);
    process.exitCode = 1;
  })
  .finally(() => mongoose.disconnect());
