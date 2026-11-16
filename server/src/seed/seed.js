/* eslint-disable no-console */
const mongoose = require('mongoose');
const env = require('../config/env');
const { connectDB, disconnectDB } = require('../config/db');
const {
  User, Category, SubCategory, Brand, Product, ProductVariant, Banner, Coupon, Cart, Wishlist, Review, Order, Payment,
} = require('../models');
const data = require('./data');

/**
 * Clears catalogue and shopping data. User accounts (and their addresses) are left
 * alone, so an admin made with `npm run admin:create` survives a reseed; carts and
 * wishlists are recreated lazily on next use.
 */
async function destroy() {
  await Promise.all([
    Product.deleteMany({}), ProductVariant.deleteMany({}), Category.deleteMany({}), SubCategory.deleteMany({}), Brand.deleteMany({}),
    Banner.deleteMany({}), Coupon.deleteMany({}), Cart.deleteMany({}), Wishlist.deleteMany({}),
    Review.deleteMany({}), Order.deleteMany({}), Payment.deleteMany({}),
  ]);
  console.log('✔ Catalogue and shopping data cleared (users kept)');
}

async function seed() {
  await destroy();

  // The seed creates no users. Products are credited to an existing admin, if any.
  const admin = await User.findOne({ role: 'admin' }).select('_id').lean();

  /* Taxonomy */
  const categoryByName = new Map();
  const subCategoryByKey = new Map();

  for (const cat of data.categories) {
    const { subCategories, ...rest } = cat;
    const created = await Category.create(rest);
    categoryByName.set(created.name, created);

    for (const [index, subName] of subCategories.entries()) {
      const sub = await SubCategory.create({
        name: subName,
        category: created._id,
        displayOrder: index,
      });
      subCategoryByKey.set(`${created.name}::${subName}`, sub);
    }
  }
  console.log(`✔ ${categoryByName.size} categories and ${subCategoryByKey.size} sub-categories seeded`);

  /* Brands — created one by one so the slug hook runs. */
  for (const brand of data.brands) await Brand.create(brand);
  console.log(`✔ ${data.brands.length} brands seeded`);

  /* Products */
  let productCount = 0;
  for (const item of data.products) {
    const category = categoryByName.get(item.category);
    const subCategory = subCategoryByKey.get(`${item.category}::${item.subCategory}`);
    if (!category) {
      console.warn(`⚠ Skipping "${item.name}" — unknown category "${item.category}"`);
      continue;
    }

    await Product.create({
      ...item,
      category: category._id,
      subCategory: subCategory?._id,
      status: 'published',
      createdBy: admin?._id,
      sku: `SKU-${String(++productCount).padStart(5, '0')}`,
      images: item.images.map((img, i) => ({ ...img, isPrimary: i === 0, displayOrder: i })),
      meta: {
        title: `${item.name} | Premium Store`,
        description: item.shortDescription,
        keywords: item.tags,
      },
    });
  }
  console.log(`✔ ${productCount} products seeded`);

  await Banner.insertMany(data.banners);
  console.log(`✔ ${data.banners.length} hero banners seeded`);

  await Coupon.insertMany(data.coupons);
  console.log(`✔ ${data.coupons.length} coupons seeded`);
}

(async () => {
  try {
    env.assertValid();
    await connectDB();

    if (process.argv.includes('--destroy')) {
      await destroy();
    } else {
      await seed();
      console.log('\n🎉 Seeding complete. No users were created; run `npm run admin:create` for an admin account.\n');
    }
  } catch (err) {
    console.error(`✖ Seeding failed: ${err.message}`);
    console.error(err.stack);
    process.exitCode = 1;
  } finally {
    await disconnectDB();
    await mongoose.disconnect().catch(() => {});
  }
})();
