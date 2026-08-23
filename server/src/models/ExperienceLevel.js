const mongoose = require('mongoose');

/**
 * The seed the collection starts life with — the list the careers form shipped with
 * before HR could edit it. They are inserted once, on the first read of an empty
 * collection, so an existing deployment keeps the exact options its applications
 * already reference.
 */
const DEFAULT_EXPERIENCE_LEVELS = [
  { value: 'intern', label: 'Intern' },
  { value: 'fresher', label: 'Fresher (0-1 Years)' },
  { value: '1-3', label: '1-3 Years' },
  { value: '3-5', label: '3-5 Years' },
  { value: '5+', label: '5+ Years' },
];

/**
 * One option in the careers form's "Experience" dropdown, and in the panel's
 * matching filter.
 *
 * Admin-managed from Inquiries → Careers, exactly like JobPosition. Applications
 * store the `value` as a plain string (see JobApplication.experience), so deleting
 * a level never orphans an application — the panel falls back to printing the raw
 * value when a level it no longer knows comes back.
 */
const experienceLevelSchema = new mongoose.Schema(
  {
    /** What the applicant reads, e.g. "Fresher (0-1 Years)". */
    label: {
      type: String,
      required: [true, 'Experience label is required'],
      trim: true,
      maxlength: 40,
      unique: true,
    },
    /**
     * What gets stored on the application. Derived from the label once, at creation,
     * and never rewritten — renaming a level must not strand the rows that used it.
     */
    value: {
      type: String,
      required: true,
      trim: true,
      lowercase: true,
      maxlength: 40,
      unique: true,
      immutable: true,
    },
    displayOrder: { type: Number, default: 0, index: true },
    isActive: { type: Boolean, default: true, index: true },
  },
  { timestamps: true }
);

/** "Fresher (0-1 Years)" -> "fresher-0-1-years", trimmed of stray separators. */
experienceLevelSchema.statics.slugify = function slugify(label) {
  return String(label)
    .toLowerCase()
    .replace(/[^a-z0-9+]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 40);
};

/**
 * Reads the list, seeding the defaults whenever it is found empty — the same
 * read-through shape as Setting.getSingleton(). An empty collection means the
 * careers form would offer no experience at all and reject every application, so
 * the defaults coming back after the last level is deleted is the safe outcome,
 * not a surprise: the way to retire an option is to switch it off, which the
 * dropdown honours and this seeding never undoes.
 */
experienceLevelSchema.statics.listOrSeed = async function listOrSeed(filter = {}) {
  const total = await this.estimatedDocumentCount();

  if (total === 0) {
    const seeded = DEFAULT_EXPERIENCE_LEVELS.map((level, index) => ({
      ...level,
      displayOrder: index,
    }));
    // Two requests can race here on a cold start; the unique indexes make the
    // loser a duplicate-key error rather than a second copy of the list.
    await this.insertMany(seeded, { ordered: false }).catch(() => {});
  }

  return this.find(filter).sort({ displayOrder: 1, label: 1 }).lean();
};

// Statics ride on the model itself, so a require can read the canonical list.
experienceLevelSchema.statics.DEFAULT_EXPERIENCE_LEVELS = DEFAULT_EXPERIENCE_LEVELS;

module.exports = mongoose.model('ExperienceLevel', experienceLevelSchema);
