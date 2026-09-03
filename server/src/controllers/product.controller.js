const mongoose = require('mongoose');
const asyncHandler = require('../utils/asyncHandler');
const ApiError = require('../utils/ApiError');
const { sendSuccess, paginationMeta } = require('../utils/apiResponse');
const { Product, ProductVariant, Category, SubCategory, Brand, Review } = require('../models');
const { destroyAsset } = require('../config/cloudinary');
const variantService = require('../services/variant.service');
const recommendations = require('../services/recommendation.service');
const broadcast = require('../realtime/broadcast');
const { localizeAll, localizeProduct, localizeProducts } = require('../utils/localize');

// `hasVariants` and `variantSummary` ride along on every list payload so cards can show
// "From ₹1,299" and a colour count without a second request. `translations` is selected
// so localize() can overlay it, then stripped from the response before it is sent.
const LIST_FIELDS =
  'name slug brand price discountPercent finalPrice stock lowStockThreshold images ratings status isFeatured isTopSelling soldCount category subCategory hasVariants variantSummary variantAttributes translations createdAt';

/** Taxonomy is populated everywhere a product is; it needs its own copy translated. */
const TAXONOMY_FIELDS = 'name slug translations';

const SORT_MAP = {
  newest: { createdAt: -1 },
  oldest: { createdAt: 1 },
  price_asc: { finalPrice: 1 },
  price_desc: { finalPrice: -1 },
  rating: { 'ratings.average': -1, 'ratings.count': -1 },
  popular: { soldCount: -1, viewCount: -1 },
  discount: { discountPercent: -1 },
  name_asc: { name: 1 },
  name_desc: { name: -1 },
};

/** Translate query params into a Mongo filter. Shared by the storefront and admin lists. */
async function buildFilter(query, { isAdmin = false } = {}) {
  const filter = {};

  // Shoppers only ever see published products; admins can ask for any status.
  if (isAdmin) {
    if (query.status && query.status !== 'all') filter.status = query.status;
  } else {
    filter.status = 'published';
  }

  // Category / sub-category accept either an ObjectId or a slug.
  if (query.category) {
    const ids = await resolveRefs(Category, query.category);
    if (ids.length) filter.category = { $in: ids };
    else return { __empty: true };
  }
  if (query.subCategory) {
    const ids = await resolveRefs(SubCategory, query.subCategory);
    if (ids.length) filter.subCategory = { $in: ids };
    else return { __empty: true };
  }

  if (query.brand) filter.brand = { $in: String(query.brand).split(',').map((b) => b.trim()) };
  if (query.tags) filter.tags = { $in: String(query.tags).split(',').map((t) => t.trim()) };

  const min = Number(query.minPrice);
  const max = Number(query.maxPrice);
  if (!Number.isNaN(min) || !Number.isNaN(max)) {
    filter.finalPrice = {};
    if (!Number.isNaN(min)) filter.finalPrice.$gte = min;
    if (!Number.isNaN(max)) filter.finalPrice.$lte = max;
  }

  if (query.minDiscount) filter.discountPercent = { $gte: Number(query.minDiscount) };
  if (query.minRating) filter['ratings.average'] = { $gte: Number(query.minRating) };
  /*
   * "Has been reviewed at all", which is not the same question as `minRating` and is
   * what the Top Rated rail is built from — an unreviewed product has an average of
   * 0 and would otherwise sit in the same bucket as a badly reviewed one.
   */
  if (query.rated === 'true') filter['ratings.count'] = { $gt: 0 };

  if (query.availability === 'in_stock') filter.stock = { $gt: 0 };
  if (query.availability === 'out_of_stock') filter.stock = { $lte: 0 };

  if (query.featured === 'true') filter.isFeatured = true;
  if (query.topSelling === 'true') filter.isTopSelling = true;

  if (query.search) {
    const safe = String(query.search).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const rx = new RegExp(safe, 'i');
    // Regex (not $text) so partial words like "ply" still match "plywood".
    filter.$or = [{ name: rx }, { brand: rx }, { shortDescription: rx }, { tags: rx }, { sku: rx }];
  }

  return filter;
}

async function resolveRefs(Model, raw) {
  const values = String(raw).split(',').map((v) => v.trim()).filter(Boolean);
  const ids = values.filter((v) => mongoose.isValidObjectId(v));
  const slugs = values.filter((v) => !mongoose.isValidObjectId(v));
  if (slugs.length) {
    const found = await Model.find({ slug: { $in: slugs } }).select('_id').lean();
    ids.push(...found.map((d) => String(d._id)));
  }
  return ids;
}

const parsePaging = (query, defaultLimit = 12) => {
  const page = Math.max(1, Number(query.page) || 1);
  const limit = Math.min(60, Math.max(1, Number(query.limit) || defaultLimit));
  /*
   * An explicit `offset` wins over `page`. The homepage rails load 10 rows and then
   * 15 at a time, so every batch after the first starts at a row number that is not
   * a multiple of any page size — expressing that as a page is not possible.
   */
  const offset = Number(query.offset);
  const skip = Number.isFinite(offset) && offset >= 0 ? Math.floor(offset) : (page - 1) * limit;
  return { page, limit, skip };
};

/* ------------------------------------------------------------------ */

/** GET /products — storefront listing with filters, sorting, pagination. */
exports.listProducts = asyncHandler(async (req, res) => {
  const isAdmin = req.user?.role === 'admin' && req.query.adminView === 'true';
  const filter = await buildFilter(req.query, { isAdmin });
  const { page, limit, skip } = parsePaging(req.query, isAdmin ? 10 : 12);

  if (filter.__empty) {
    return sendSuccess(res, {
      message: 'Products fetched',
      data: { products: [] },
      meta: paginationMeta({ total: 0, page, limit }),
    });
  }

  const sort = SORT_MAP[req.query.sort] || SORT_MAP.newest;

  const [products, total] = await Promise.all([
    Product.find(filter)
      .select(isAdmin ? undefined : LIST_FIELDS)
      .populate('category', TAXONOMY_FIELDS)
      .populate('subCategory', TAXONOMY_FIELDS)
      .sort(sort)
      .skip(skip)
      .limit(limit)
      .lean({ virtuals: true }),
    Product.countDocuments(filter),
  ]);

  return sendSuccess(res, {
    message: 'Products fetched',
    // The admin list edits the source copy, so it must see it untranslated.
    data: { products: isAdmin ? products : localizeProducts(products, req.language) },
    meta: paginationMeta({ total, page, limit }),
  });
});

/**
 * GET /products/filters — the value ranges the sidebar needs (price bounds, brands,
 * counts per sub-category), computed for the *current* filter set.
 */
exports.getFilterMeta = asyncHandler(async (req, res) => {
  const filter = await buildFilter(req.query);
  if (filter.__empty) {
    return sendSuccess(res, {
      message: 'Filter metadata fetched',
      data: { priceRange: { min: 0, max: 0 }, brands: [], subCategories: [], total: 0 },
    });
  }

  const [agg] = await Product.aggregate([
    { $match: filter },
    {
      $facet: {
        price: [{ $group: { _id: null, min: { $min: '$finalPrice' }, max: { $max: '$finalPrice' } } }],
        brands: [
          { $match: { brand: { $ne: null } } },
          { $group: { _id: '$brand', count: { $sum: 1 } } },
          { $sort: { count: -1 } },
          { $limit: 25 },
        ],
        subCategories: [
          { $group: { _id: '$subCategory', count: { $sum: 1 } } },
          { $sort: { count: -1 } },
        ],
        total: [{ $count: 'value' }],
      },
    },
  ]);

  const subCatIds = agg.subCategories.map((s) => s._id).filter(Boolean);
  const subCatDocs = await SubCategory.find({ _id: { $in: subCatIds } })
    .select('name slug category translations')
    .lean();
  const byId = new Map(
    localizeAll(subCatDocs, req.language).map((d) => [String(d._id), d])
  );

  // Products store the brand as a name; the catalogue supplies the artwork for it.
  const brandNames = agg.brands.map((b) => b._id).filter(Boolean);
  const brandDocs = brandNames.length
    ? await Brand.find({ name: { $in: brandNames } }).select('name slug logo').lean()
    : [];
  const brandByName = new Map(brandDocs.map((b) => [b.name, b]));

  return sendSuccess(res, {
    message: 'Filter metadata fetched',
    data: {
      priceRange: {
        min: Math.floor(agg.price[0]?.min ?? 0),
        max: Math.ceil(agg.price[0]?.max ?? 0),
      },
      brands: agg.brands.map((b) => ({
        name: b._id,
        count: b.count,
        slug: brandByName.get(b._id)?.slug,
        logo: brandByName.get(b._id)?.logo,
      })),
      subCategories: agg.subCategories
        .filter((s) => byId.has(String(s._id)))
        .map((s) => ({ ...byId.get(String(s._id)), count: s.count })),
      total: agg.total[0]?.value ?? 0,
    },
  });
});

/** GET /products/search?q= — lightweight live-search feed for the header. */
exports.searchSuggestions = asyncHandler(async (req, res) => {
  const q = String(req.query.q || '').trim();
  if (q.length < 2) {
    return sendSuccess(res, { message: 'Suggestions fetched', data: { products: [], categories: [] } });
  }

  const safe = q.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const rx = new RegExp(safe, 'i');

  /*
   * Matching stays on the English source: `name` and `translations.<lang>.name` are
   * both searched, so a Hindi shopper finds a product by typing either its English
   * model number or its translated name. The results are then shown translated.
   */
  const [products, categories] = await Promise.all([
    Product.find({
      status: 'published',
      $or: [{ name: rx }, { brand: rx }, { tags: rx }, { [`translations.${req.language}.name`]: rx }],
    })
      .select('name slug finalPrice price discountPercent images ratings translations')
      .limit(8)
      .lean({ virtuals: true }),
    Category.find({
      isActive: true,
      $or: [{ name: rx }, { [`translations.${req.language}.name`]: rx }],
    })
      .select('name slug translations')
      .limit(4)
      .lean(),
  ]);

  return sendSuccess(res, {
    message: 'Suggestions fetched',
    data: {
      products: localizeProducts(products, req.language),
      categories: localizeAll(categories, req.language),
    },
  });
});

/** GET /products/:idOrSlug */
exports.getProduct = asyncHandler(async (req, res) => {
  const { idOrSlug } = req.params;
  const query = mongoose.isValidObjectId(idOrSlug) ? { _id: idOrSlug } : { slug: idOrSlug };
  if (req.user?.role !== 'admin') query.status = 'published';

  const product = await Product.findOne(query)
    .populate('category', TAXONOMY_FIELDS)
    .populate('subCategory', TAXONOMY_FIELDS);

  if (!product) throw ApiError.notFound('Product not found');

  // Fire-and-forget: a view counter must never delay or fail the response.
  Product.updateOne({ _id: product._id }, { $inc: { viewCount: 1 } }).catch(() => {});

  // Every combination — including sold-out and inactive ones, which the selector shows
  // disabled rather than hiding — travels with the product so switching a variant needs
  // no further round trip.
  // The admin form edits the source copy, so it must receive it untranslated.
  const isAdmin = req.user?.role === 'admin';
  const payload = isAdmin
    ? product.toJSON()
    : localizeProduct(product.toJSON(), req.language);

  if (product.hasVariants) {
    payload.variants = await variantService.listPublicVariants(product._id);
  }

  return sendSuccess(res, { message: 'Product fetched', data: { product: payload } });
});

/** GET /products/:id/related */
exports.getRelatedProducts = asyncHandler(async (req, res) => {
  const product = await Product.findById(req.params.id).select('category subCategory tags');
  if (!product) throw ApiError.notFound('Product not found');

  const related = await Product.find({
    _id: { $ne: product._id },
    status: 'published',
    $or: [
      { subCategory: product.subCategory },
      { category: product.category },
      ...(product.tags?.length ? [{ tags: { $in: product.tags } }] : []),
    ],
  })
    .select(LIST_FIELDS)
    .sort({ soldCount: -1, 'ratings.average': -1 })
    .limit(Number(req.query.limit) || 8)
    .lean({ virtuals: true });

  return sendSuccess(res, {
    message: 'Related products fetched',
    data: { products: localizeProducts(related, req.language) },
  });
});

/**
 * POST /products/by-ids — resolves the "recently viewed" list the client keeps in
 * localStorage. Order of the request is preserved in the response.
 */
exports.getProductsByIds = asyncHandler(async (req, res) => {
  const ids = (req.body.ids || []).filter((id) => mongoose.isValidObjectId(id)).slice(0, 20);
  if (!ids.length) return sendSuccess(res, { message: 'Products fetched', data: { products: [] } });

  const products = await Product.find({ _id: { $in: ids }, status: 'published' })
    .select(LIST_FIELDS)
    .lean({ virtuals: true });

  const byId = new Map(products.map((p) => [String(p._id), p]));
  const ordered = ids.map((id) => byId.get(String(id))).filter(Boolean);

  return sendSuccess(res, {
    message: 'Products fetched',
    data: { products: localizeProducts(ordered, req.language) },
  });
});

/**
 * GET /products/home-feed — every homepage rail in one round trip.
 *
 * "Top Selling" and "Products For You" are computed, not curated: the first from
 * real order volume, the second from this shopper's own signals. See
 * services/recommendation.service.js for how each is derived and what it falls
 * back to on a shop with no sales yet.
 *
 * Personalisation reads whoever `optionalAuth` resolved, plus `?seen=` — the
 * recently-viewed ids the browser already keeps — so a signed-out visitor, which
 * is most of them, still gets a rail shaped by what they have been looking at.
 */
/** Products sent per rail with the page. The storefront shows ten of them at a time. */
const RAIL_SIZE = 10;

/**
 * The three rails that are plain catalogue reads, defined once and shared by the feed
 * and by the paging endpoint below.
 *
 * They are one definition on purpose. When the homepage sent the first ten rows and
 * the storefront then paged the *listing* endpoint with its own approximation of the
 * same filter and sort, the two drifted: "Top Rated" opened on average alone and
 * continued on average-then-count, so load more could repeat a product or skip one.
 *
 * Every sort ends on `_id` for the same reason — a sort with ties has no defined order
 * between two pages of it, and skip/limit paging over an undefined order loses rows.
 */
const STATIC_RAILS = {
  new_arrivals: {
    title: 'New Arrivals',
    subtitle: 'Fresh in store',
    filter: { status: 'published' },
    sort: { createdAt: -1, _id: -1 },
  },
  best_deals: {
    title: 'Best Deals',
    subtitle: 'Biggest discounts right now',
    filter: { status: 'published', discountPercent: { $gte: 10 } },
    sort: { discountPercent: -1, _id: -1 },
  },
  top_rated: {
    title: 'Top Rated',
    subtitle: 'Loved by our customers',
    // "Has been reviewed at all" — an unreviewed product averages 0 and would
    // otherwise rank alongside a badly reviewed one.
    filter: { status: 'published', 'ratings.count': { $gt: 0 } },
    sort: { 'ratings.average': -1, 'ratings.count': -1, _id: -1 },
  },
};

/** The computed rails, in the order the homepage stacks them, plus their copy. */
const COMPUTED_RAILS = {
  for_you: { title: 'Products For You', subtitle: 'Handpicked for your taste' },
  top_selling: { title: 'Top Selling Products', subtitle: 'What everyone is buying' },
};

/** Rail order on the homepage: personalised, then popular, then the catalogue reads. */
const RAIL_ORDER = ['for_you', 'top_selling', 'new_arrivals', 'best_deals', 'top_rated'];

const parseSeenIds = (raw) =>
  String(raw || '')
    .split(',')
    .map((id) => id.trim())
    .filter((id) => mongoose.isValidObjectId(id))
    .slice(0, 20);

/**
 * One page of one rail — the single place any rail is ever built, so the products the
 * homepage opens with and the products "load more" appends are drawn from the same
 * ranking or the same query, never from two that merely resemble each other.
 *
 * Returns `{ products, total }`, where `total` is what this rail could ever show:
 * the depth of the ranking for the computed pair, a count against the same filter for
 * the rest. The storefront offers "load more" only while `total` says there is more.
 */
async function loadRail(key, { offset = 0, limit = RAIL_SIZE, seenIds = [], userId } = {}) {
  if (key === 'top_selling') {
    return recommendations.getTopSelling({ select: LIST_FIELDS, limit, offset });
  }

  if (key === 'for_you') {
    /*
     * Held out of the personalised rail: two rails stacked on the homepage showing the
     * same five products is the thing that made the manual flags look broken. The
     * exclusion is the *visible* head of Top Selling, taken from its cached ranking, so
     * every page of "For You" is built against the same held-out set.
     */
    const excludeIds = (await recommendations.rankTopSelling()).slice(0, RAIL_SIZE);
    return recommendations.getForYou({
      userId,
      seenIds,
      excludeIds,
      select: LIST_FIELDS,
      limit,
      offset,
    });
  }

  const def = STATIC_RAILS[key];
  if (!def) return null;

  const [products, total] = await Promise.all([
    Product.find(def.filter)
      .select(LIST_FIELDS)
      .sort(def.sort)
      .skip(offset)
      .limit(limit)
      .lean({ virtuals: true }),
    Product.countDocuments(def.filter),
  ]);

  return { products, total };
}

exports.getHomeFeed = asyncHandler(async (req, res) => {
  const seenIds = parseSeenIds(req.query.seen);
  const userId = req.user?._id;

  /*
   * Every rail at once. "For You" needs Top Selling's ranking to exclude it, but that
   * ranking is cached and single-flighted inside the service, so the two resolve it
   * together rather than one waiting on the other — against a remote cluster a serial
   * round trip is the dominant cost of this endpoint.
   */
  const rails = await Promise.all(
    RAIL_ORDER.map((key) => loadRail(key, { seenIds, userId, limit: RAIL_SIZE }))
  );

  const lang = req.language;

  /*
   * The rail headings are interface copy, not catalogue data, so the API sends the
   * stable `key` and the storefront renders `shop:home.sections.<key>`. The English
   * title/subtitle still ride along as a fallback for any client that has not been
   * updated — but the storefront never displays them.
   *
   * Empty rails are dropped, which on a brand-new catalogue is every rail; the two
   * computed ones fill themselves as long as a single product is published.
   */
  return sendSuccess(res, {
    message: 'Home feed fetched',
    data: {
      sections: RAIL_ORDER.map((key, i) => {
        const { title, subtitle } = COMPUTED_RAILS[key] || STATIC_RAILS[key];
        const { products, total } = rails[i];
        return { key, title, subtitle, products, total };
      })
        .filter((s) => s.products.length > 0)
        .map((s) => ({ ...s, products: localizeProducts(s.products, lang) })),
    },
  });
});

/**
 * GET /products/rail/:key — the rest of a homepage rail, one page at a time.
 *
 * This exists so "load more" continues a rail *as that rail*, which the listing
 * endpoint cannot do: "Top Selling" is ninety days of order volume and "For You" is
 * one shopper's affinity, and neither is expressible as a sort on /products. Paging
 * them there returned a differently-ordered list that repeated and skipped products.
 */
exports.getRail = asyncHandler(async (req, res) => {
  const key = String(req.params.key || '');
  const { limit, skip } = parsePaging(req.query, RAIL_SIZE);

  const rail = await loadRail(key, {
    offset: skip,
    limit,
    seenIds: parseSeenIds(req.query.seen),
    userId: req.user?._id,
  });
  if (!rail) throw new ApiError(404, 'Unknown rail');

  return sendSuccess(res, {
    message: 'Rail fetched',
    data: { products: localizeProducts(rail.products, req.language) },
    meta: paginationMeta({
      total: rail.total,
      page: Math.floor(skip / limit) + 1,
      limit,
    }),
  });
});

/* ------------------------------------------------------------------ *
 * Admin writes
 * ------------------------------------------------------------------ */

/** POST /products (admin) */
exports.createProduct = asyncHandler(async (req, res) => {
  const payload = { ...req.body, createdBy: req.user._id };
  delete payload.finalPrice; // always derived
  delete payload.ratings;
  delete payload.soldCount;
  // Variants are rows in their own collection, reconciled after the product exists.
  const variantRows = Array.isArray(payload.variants) ? payload.variants : null;
  delete payload.variants;
  delete payload.variantSummary;
  delete payload.hasVariants;
  if (payload.variantAttributes) {
    payload.variantAttributes = variantService.normaliseAttributeDefinitions(payload.variantAttributes);
  }

  if (!(await Category.exists({ _id: payload.category }))) {
    throw ApiError.badRequest('Selected category does not exist');
  }
  if (payload.subCategory) {
    const sub = await SubCategory.findById(payload.subCategory).select('category');
    if (!sub) throw ApiError.badRequest('Selected sub-category does not exist');
    if (String(sub.category) !== String(payload.category)) {
      throw ApiError.badRequest('Sub-category does not belong to the selected category');
    }
  }

  const product = await Product.create(payload);

  let variants = [];
  if (variantRows?.length) variants = await variantService.reconcileVariants(product, variantRows);

  // reconcileVariants rewrote the rollup (stock, price, hasVariants) — re-read it.
  const saved = await Product.findById(product._id)
    .populate('category', TAXONOMY_FIELDS)
    .populate('subCategory', TAXONOMY_FIELDS);

  broadcast.productCreated(saved);
  if (variants.length) broadcast.variantsChanged('created', saved);

  return sendSuccess(res, {
    statusCode: 201,
    message: 'Product created',
    data: {
      product: {
        ...saved.toJSON(),
        variants: variants.map(variantService.publicVariant),
      },
    },
  });
});

/** PATCH /products/:id (admin) */
exports.updateProduct = asyncHandler(async (req, res) => {
  const product = await Product.findById(req.params.id);
  if (!product) throw ApiError.notFound('Product not found');

  const payload = { ...req.body };
  delete payload.finalPrice;
  delete payload.ratings;
  delete payload.soldCount;
  delete payload.createdBy;
  // Both are derived from the variant rows; a client-sent value is never trusted.
  delete payload.variantSummary;
  delete payload.hasVariants;

  // `undefined` means "the caller isn't touching variants" (e.g. a quick status edit);
  // an empty array means "this product no longer has any".
  const variantRows = Array.isArray(payload.variants) ? payload.variants : undefined;
  delete payload.variants;
  if (payload.variantAttributes) {
    payload.variantAttributes = variantService.normaliseAttributeDefinitions(payload.variantAttributes);
  }

  if (payload.subCategory) {
    const sub = await SubCategory.findById(payload.subCategory).select('category');
    const targetCategory = payload.category || product.category;
    if (!sub) throw ApiError.badRequest('Selected sub-category does not exist');
    if (String(sub.category) !== String(targetCategory)) {
      throw ApiError.badRequest('Sub-category does not belong to the selected category');
    }
  }

  // Any image dropped from the new set is removed from Cloudinary too — unless a variant
  // is still using it, which is legal since variants may reuse the parent's photography.
  if (Array.isArray(payload.images)) {
    const keep = new Set(payload.images.map((i) => i.publicId));
    const orphans = product.images.filter((i) => !keep.has(i.publicId));
    if (orphans.length) {
      const usedByVariants = new Set(
        (await ProductVariant.find({ product: product._id }).select('images.publicId').lean()).flatMap((v) =>
          (v.images || []).map((i) => i.publicId)
        )
      );
      await Promise.all(
        orphans.filter((i) => !usedByVariants.has(i.publicId)).map((i) => destroyAsset(i.publicId))
      );
    }
  }

  // Videos are product-level only — nothing else can be holding a reference.
  if (Array.isArray(payload.videos)) {
    const keep = new Set(payload.videos.map((v) => v.publicId));
    await Promise.all(
      (product.videos || [])
        .filter((v) => !keep.has(v.publicId))
        .map((v) => destroyAsset(v.publicId, { resourceType: 'video' }))
    );
  }

  Object.assign(product, payload);
  await product.save();

  let variants = null;
  if (variantRows !== undefined) {
    variants = await variantService.reconcileVariants(product, variantRows);
  } else if (product.hasVariants && (payload.price !== undefined || payload.discountPercent !== undefined)) {
    // Repricing the parent must not silently override the SKUs; the rollup wins back.
    await variantService.syncProductAggregates(product._id);
  }

  const saved = await Product.findById(product._id)
    .populate('category', TAXONOMY_FIELDS)
    .populate('subCategory', TAXONOMY_FIELDS);

  broadcast.productUpdated(saved);
  if (variants) {
    broadcast.variantsChanged('replaced', saved);
    broadcast.stockChanged([{ product: saved._id }], { reason: 'variants_updated' });
  }

  return sendSuccess(res, {
    message: 'Product updated',
    data: {
      product: {
        ...saved.toJSON(),
        ...(variants ? { variants: variants.map(variantService.publicVariant) } : {}),
      },
    },
  });
});

/** DELETE /products/:id (admin) */
exports.deleteProduct = asyncHandler(async (req, res) => {
  const product = await Product.findById(req.params.id);
  if (!product) throw ApiError.notFound('Product not found');

  // Variant imagery is owned by the variant, so it is released here too.
  const variants = await ProductVariant.find({ product: product._id }).select('images').lean();
  const assets = new Set([
    ...product.images.map((img) => img.publicId),
    ...variants.flatMap((v) => (v.images || []).map((img) => img.publicId)),
  ]);

  await Promise.all([
    ...[...assets].filter(Boolean).map((publicId) => destroyAsset(publicId)),
    ...(product.videos || []).map((video) => destroyAsset(video.publicId, { resourceType: 'video' })),
  ]);
  await ProductVariant.deleteMany({ product: product._id });
  await Review.deleteMany({ product: product._id });
  await product.deleteOne();

  broadcast.productDeleted(product);

  return sendSuccess(res, { message: 'Product deleted' });
});

/** PATCH /products/:id/status (admin) — publish / unpublish toggle. */
exports.updateProductStatus = asyncHandler(async (req, res) => {
  const { status } = req.body;
  const product = await Product.findByIdAndUpdate(
    req.params.id,
    { status },
    { new: true, runValidators: true }
  );
  if (!product) throw ApiError.notFound('Product not found');

  broadcast.productUpdated(product);

  return sendSuccess(res, { message: `Product ${status}`, data: { product } });
});

/** PATCH /products/:id/stock (admin) */
exports.updateStock = asyncHandler(async (req, res) => {
  const existing = await Product.findById(req.params.id).select('hasVariants');
  if (!existing) throw ApiError.notFound('Product not found');
  if (existing.hasVariants) {
    // The parent's stock is a rollup of its SKUs — writing it directly would be undone by
    // the next sync and would hide which combination actually needs restocking.
    throw ApiError.badRequest('This product is stocked per variant — update the individual SKUs instead');
  }

  const product = await Product.findByIdAndUpdate(
    req.params.id,
    { stock: req.body.stock },
    { new: true, runValidators: true }
  );
  if (!product) throw ApiError.notFound('Product not found');

  broadcast.stockChanged([{ product: product._id }], { reason: 'admin_adjustment' });

  return sendSuccess(res, { message: 'Stock updated', data: { product } });
});

exports.LIST_FIELDS = LIST_FIELDS;
