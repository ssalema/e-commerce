const asyncHandler = require('../utils/asyncHandler');
const ApiError = require('../utils/ApiError');
const { sendSuccess } = require('../utils/apiResponse');
const env = require('../config/env');
const {
  uploadBuffer,
  uploadVideoBuffer,
  destroyAsset,
  isOwnedAsset,
  signUpload,
} = require('../config/cloudinary');
const { MAX_BYTES, VIDEO_ALLOWED } = require('../middleware/upload');

function assertEnabled() {
  if (!env.cloudinaryEnabled) {
    throw ApiError.serviceUnavailable(
      'Image uploads are not configured. Add your Cloudinary credentials to the server .env file.'
    );
  }
}

/** Where a shopper's own uploads go, and the only namespace they may write to. */
const CUSTOMER_FOLDER = 'reviews';

/**
 * Which folder this upload lands in.
 *
 * `kind` is a client-supplied field, so it is reduced to a plain slug rather than
 * pasted into a path as sent — but sanitising it was never the whole question.
 * These routes are open to any signed-in shopper, and letting one *choose* the
 * namespace meant a review photo could be filed under `products/`, where it
 * became indistinguishable from the catalogue's own artwork to anything scoping
 * by folder. So the choice is staff's: an admin still directs their uploads, and
 * everyone else lands in the customer namespace whatever they asked for.
 */
const folderFor = (kind, req) => {
  if (req?.user?.role !== 'admin') return `${env.cloudinary.folder}/${CUSTOMER_FOLDER}`;
  const slug = String(kind || '').toLowerCase().replace(/[^a-z0-9-]/g, '');
  return `${env.cloudinary.folder}/${slug || 'misc'}`;
};

/**
 * POST /uploads/image  (field: image)
 * The admin uploader posts one file per slot so each card can show its own progress bar.
 */
exports.uploadImage = asyncHandler(async (req, res) => {
  assertEnabled();
  if (!req.file) throw ApiError.badRequest('No image received');

  const image = await uploadBuffer(req.file.buffer, { folder: folderFor(req.body.kind, req) });

  return sendSuccess(res, { statusCode: 201, message: 'Image uploaded', data: { image } });
});

/** POST /uploads/images  (field: images, max 5) */
exports.uploadImages = asyncHandler(async (req, res) => {
  assertEnabled();
  if (!req.files?.length) throw ApiError.badRequest('No images received');

  const images = await Promise.all(
    req.files.map((file) => uploadBuffer(file.buffer, { folder: folderFor(req.body.kind, req) }))
  );

  return sendSuccess(res, {
    statusCode: 201,
    message: `${images.length} image(s) uploaded`,
    data: { images },
  });
});

/**
 * POST /uploads/media  (field: file)
 *
 * One photo *or* one short video, for shoppers attaching evidence to a review.
 * Images ride the same pipeline as everything else; videos keep their original
 * bytes and get a poster frame derived on delivery.
 */
exports.uploadMedia = asyncHandler(async (req, res) => {
  assertEnabled();
  if (!req.file) throw ApiError.badRequest('No file received');

  const isVideo = VIDEO_ALLOWED.includes(req.file.mimetype);
  // multer's cap is the video one; images are held to the tighter limit here.
  if (!isVideo && req.file.size > MAX_BYTES) {
    throw ApiError.badRequest('Image is too large (max 5MB)');
  }

  const folder = folderFor(req.body.kind, req);
  const asset = isVideo
    ? await uploadVideoBuffer(req.file.buffer, { folder })
    : await uploadBuffer(req.file.buffer, { folder });

  return sendSuccess(res, {
    statusCode: 201,
    message: isVideo ? 'Video uploaded' : 'Image uploaded',
    data: { media: { type: isVideo ? 'video' : 'image', ...asset } },
  });
});

/**
 * POST /uploads/signature (admin)
 *
 * Hands the panel a short-lived signature so a photo or clip can go straight from
 * the browser to Cloudinary. The signature is bound to the folder derived here —
 * the client cannot widen it — and Cloudinary rejects it about an hour after it
 * was issued, so a leaked one is worth nothing for long.
 */
exports.createUploadSignature = asyncHandler(async (req, res) => {
  assertEnabled();

  const signed = signUpload({ folder: folderFor(req.body.kind, req) });

  return sendSuccess(res, { message: 'Upload signature issued', data: { upload: signed } });
});

/**
 * DELETE /uploads/:publicId — public ids contain slashes, so the route uses a
 * wildcard and we rebuild the full id here.
 *
 * Cloudinary keeps images and videos in separate namespaces, so `?type=video`
 * says which one to destroy; without it a clip's id would match nothing.
 */
exports.deleteImage = asyncHandler(async (req, res) => {
  assertEnabled();
  const publicId = req.params.publicId || req.params[0];
  if (!publicId) throw ApiError.badRequest('publicId is required');
  const resourceType = req.query.type === 'video' ? 'video' : 'image';

  // Confine deletions to this project's folder so a crafted id can't reach other
  // assets. Matched with the separator attached — a bare prefix test would also
  // have accepted a neighbouring "premium-ecommerce-other/…" folder.
  if (!isOwnedAsset(publicId)) {
    throw ApiError.forbidden('You can only delete assets belonging to this store');
  }

  await destroyAsset(publicId, { resourceType });
  return sendSuccess(res, { message: resourceType === 'video' ? 'Video deleted' : 'Image deleted' });
});
