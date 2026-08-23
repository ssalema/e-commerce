const mongoose = require('mongoose');

/**
 * The picklist a shopper chooses from when returning a delivered order — the
 * twin of CancellationReason, and admin-managed on exactly the same terms.
 *
 * It is a separate collection rather than a `kind` column on one, because the two
 * lists answer different questions: "why did you call this off before it arrived"
 * and "what is wrong with what arrived". Sharing rows would put "Wrong address
 * selected" in front of somebody holding a damaged parcel.
 *
 * "Other" is deliberately *not* a row here: it is not a reason, it is the escape
 * hatch the dialog always offers, and an admin deleting it would leave shoppers
 * with no way to say something the list does not cover. The storefront renders it
 * after whatever this collection returns.
 *
 * A chosen reason is copied onto the order as text, so editing or deleting a row
 * changes what future shoppers are offered and never what a settled return says.
 */
const returnReasonSchema = new mongoose.Schema(
  {
    label: {
      type: String,
      required: [true, 'Reason is required'],
      trim: true,
      maxlength: 120,
    },
    /**
     * The row's slot in the picklist. The controller keeps these a gap-free
     * 0..n-1 sequence, so two reasons never share a number and 'order 5' always
     * names exactly one row.
     */
    displayOrder: { type: Number, default: 0, index: true },
    isActive: { type: Boolean, default: true, index: true },
  },
  { timestamps: true }
);

/**
 * The list a fresh install starts with, seeded on first read so the return dialog
 * is never empty before an admin has opened the screen. Seeding happens once — an
 * admin who deletes every row keeps an empty list.
 */
const DEFAULT_REASONS = [
  'Item arrived damaged',
  'Wrong item delivered',
  'Item does not match the description',
  'Size or fit is not right',
  'Quality not as expected',
  'Missing parts or accessories',
  'Item stopped working',
  'Received a duplicate order',
  'No longer needed',
];

module.exports = mongoose.model('ReturnReason', returnReasonSchema);
module.exports.DEFAULT_REASONS = DEFAULT_REASONS;
