const multer = require('multer');
const ApiError = require('../utils/ApiError');

const ALLOWED = ['image/jpeg', 'image/jpg', 'image/png', 'image/gif'];
const MAX_BYTES = 5 * 1024 * 1024;

// Memory storage: buffers stream straight to Cloudinary, nothing touches local disk.
const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: MAX_BYTES, files: 5 },
  fileFilter(_req, file, cb) {
    if (!ALLOWED.includes(file.mimetype)) {
      return cb(ApiError.badRequest('Only JPG, JPEG, PNG and GIF images are allowed'));
    }
    cb(null, true);
  },
});

/* ---------------- Review attachments (photo or video) ---------------- */

const VIDEO_ALLOWED = ['video/mp4'];
const VIDEO_MAX_BYTES = 30 * 1024 * 1024;

/**
 * One file per request, image or video.
 *
 * multer applies a single size cap per instance, so the ceiling here is the video
 * one and the tighter image limit is enforced in the controller once the buffer —
 * and its mimetype — are both in hand. `uploadMaxLabel` is left on the request so
 * a rejection names the limit that was actually exceeded rather than the other one.
 */
const mediaUpload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: VIDEO_MAX_BYTES, files: 1 },
  fileFilter(req, file, cb) {
    const isVideo = VIDEO_ALLOWED.includes(file.mimetype);
    if (!isVideo && !ALLOWED.includes(file.mimetype)) {
      return cb(ApiError.badRequest('Only JPG, JPEG, PNG, GIF images and MP4 videos are allowed'));
    }
    req.uploadMaxLabel = isVideo ? '30MB' : '5MB';
    cb(null, true);
  },
});

/* ---------------- Resumes (careers form) ---------------- */

const RESUME_MIMES = [
  'application/pdf',
  'application/msword', // .doc
  'application/vnd.openxmlformats-officedocument.wordprocessingml.document', // .docx
];
const RESUME_MAX_BYTES = 5 * 1024 * 1024;

/**
 * Generic types browsers send for a .doc they cannot identify. Accepted only
 * alongside a matching extension, never on their own.
 */
const RESUME_GENERIC_MIMES = ['application/octet-stream', 'application/x-msdownload', ''];

const resumeUpload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: RESUME_MAX_BYTES, files: 1 },
  fileFilter(_req, file, cb) {
    /**
     * Both halves have to agree, and that is the whole point.
     *
     * Accepting *either* signal meant "payload.html declared as application/pdf"
     * passed on the mimetype while keeping its .html extension — and the
     * extension is what Cloudinary stores and later serves the file as, so the
     * resume came back to staff as text/html. Requiring the pair means the name
     * a browser will act on and the type the uploader claimed can never disagree.
     *
     * The generic types some browsers send for .doc are still tolerated, but only
     * because the extension has to back them up.
     */
    const extension = (String(file.originalname || '').match(/\.([a-z0-9]+)$/i)?.[1] || '').toLowerCase();
    const extensionOk = ['pdf', 'doc', 'docx'].includes(extension);
    const mimeOk =
      RESUME_MIMES.includes(file.mimetype) || RESUME_GENERIC_MIMES.includes(file.mimetype || '');

    if (!extensionOk || !mimeOk) {
      return cb(ApiError.badRequest('Only PDF, DOC and DOCX resumes are allowed'));
    }
    cb(null, true);
  },
});

module.exports = {
  uploadSingle: upload.single('image'),
  uploadMultiple: upload.array('images', 5),
  uploadMedia: mediaUpload.single('file'),
  uploadResume: resumeUpload.single('resume'),
  MAX_BYTES,
  ALLOWED,
  VIDEO_ALLOWED,
  VIDEO_MAX_BYTES,
  RESUME_MAX_BYTES,
  RESUME_MIMES,
};
