const asyncHandler = require('../utils/asyncHandler');
const ApiError = require('../utils/ApiError');
const { sendSuccess, paginationMeta } = require('../utils/apiResponse');
const { Inquiry, JobApplication, NewsletterSubscriber } = require('../models');
const { sendInquiryAckEmail, sendInquiryReplyEmail } = require('../services/mail.service');
const broadcast = require('../realtime/broadcast');
const { dateFilter } = require('../utils/dateFilter');

/** Escapes a user string so it can be used inside a RegExp safely. */
const escapeRegex = (value) => String(value).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/**
 * POST /inquiries — public.
 * The acknowledgement email is fire-and-forget: SMTP being down must not turn a
 * saved inquiry into a failed submission.
 */
exports.createInquiry = asyncHandler(async (req, res) => {
  const inquiry = await Inquiry.create({
    name: req.body.name,
    email: req.body.email,
    phone: req.body.phone,
    subject: req.body.subject || '',
    message: req.body.message,
    meta: { ip: req.ip, userAgent: req.get('user-agent')?.slice(0, 300) },
  });

  broadcast.inquiryCreated(inquiry);

  sendInquiryAckEmail({
    to: inquiry.email,
    name: inquiry.name,
    email: inquiry.email,
    phone: inquiry.phone,
    subject: inquiry.subject,
    message: inquiry.message,
    receivedAt: inquiry.createdAt,
  }).catch(() => { });

  return sendSuccess(res, {
    statusCode: 201,
    message: 'Your message has been successfully submitted. We will get back to you soon.',
    // Nothing from the stored document is echoed back — the form only needs a receipt.
    data: { submitted: true },
  });
});

/** GET /inquiries (admin) — search + date range + sort, server-paginated. */
exports.listInquiries = asyncHandler(async (req, res) => {
  const page = Number(req.query.page) || 1;
  const limit = Number(req.query.limit) || 10;

  const filter = {};

  if (req.query.search?.trim()) {
    const pattern = new RegExp(escapeRegex(req.query.search.trim()), 'i');
    filter.$or = [{ name: pattern }, { email: pattern }, { subject: pattern }, { message: pattern }];
  }

  const created = dateFilter(req.query);
  if (created) filter.createdAt = created;

  if (req.query.status === 'unread') filter.isRead = false;
  else if (req.query.status === 'read') filter.isRead = true;

  const sort = req.query.sort === 'oldest' ? { createdAt: 1 } : { createdAt: -1 };

  const [inquiries, total] = await Promise.all([
    Inquiry.find(filter)
      .sort(sort)
      .skip((page - 1) * limit)
      .limit(limit)
      // Replies saved before `byName` existed can still be attributed this way.
      .populate('reply.by', 'name')
      .lean(),
    Inquiry.countDocuments(filter),
  ]);

  return sendSuccess(res, {
    message: 'Inquiries fetched',
    data: { inquiries },
    meta: paginationMeta({ total, page, limit }),
  });
});

/**
 * GET /inquiries/stats (admin) — the KPI tiles above the inbox.
 * Every tab's headline number is counted here so the page needs one request, not three.
 */
exports.inquiryStats = asyncHandler(async (_req, res) => {
  const [
    total,
    unread,
    careerApplications,
    newApplications,
    unreadApplications,
    subscribers,
    activeSubscribers,
  ] = await Promise.all([
    Inquiry.countDocuments(),
    Inquiry.countDocuments({ isRead: false }),
    JobApplication.countDocuments(),
    JobApplication.countDocuments({ status: 'new' }),
    // "Not yet looked at" — cleared by opening the profile *or* by moving the
    // application along, which is not the same as the `new` status above: a shortlisted
    // application has been read, and an unopened one is still unread whatever
    // stage it sits at.
    JobApplication.countDocuments({ isRead: false }),
    NewsletterSubscriber.countDocuments(),
    NewsletterSubscriber.countDocuments({ status: 'subscribed' }),
  ]);

  return sendSuccess(res, {
    message: 'Inquiry stats fetched',
    data: {
      stats: {
        total,
        unread,
        careerApplications,
        newApplications,
        unreadApplications,
        subscribers,
        activeSubscribers,
        // What the NEW badges in the panel's navigation count: the unread rows on
        // each tab, plus the sum the sidebar's single Inquiries badge shows.
        newBadges: {
          messages: unread,
          careers: unreadApplications,
          total: unread + unreadApplications,
        },
      },
    },
  });
});

/** GET /inquiries/:id (admin) — opening the detail dialog also marks it read. */
exports.getInquiry = asyncHandler(async (req, res) => {
  const inquiry = await Inquiry.findById(req.params.id);
  if (!inquiry) throw ApiError.notFound('Message not found');

  if (!inquiry.isRead) {
    inquiry.isRead = true;
    inquiry.readAt = new Date();
    await inquiry.save();
    broadcast.inquiryChanged('read', inquiry);
  }

  await inquiry.populate('reply.by', 'name');

  return sendSuccess(res, { message: 'Inquiry fetched', data: { inquiry } });
});

/** PATCH /inquiries/:id/read (admin)  { isRead } */
exports.setInquiryRead = asyncHandler(async (req, res) => {
  const inquiry = await Inquiry.findById(req.params.id);
  if (!inquiry) throw ApiError.notFound('Message not found');

  inquiry.isRead = req.body.isRead !== false;
  inquiry.readAt = inquiry.isRead ? new Date() : undefined;
  await inquiry.save();

  broadcast.inquiryChanged('read', inquiry);

  return sendSuccess(res, { message: inquiry.isRead ? 'Marked as read' : 'Marked as unread', data: { inquiry } });
});

/**
 * POST /inquiries/:id/reply (admin)
 * The reply is recorded whether or not SMTP delivered it, so the inbox always shows
 * what was said — `reply.delivered` tells the admin if it actually left the building.
 */
exports.replyToInquiry = asyncHandler(async (req, res) => {
  const inquiry = await Inquiry.findById(req.params.id);
  if (!inquiry) throw ApiError.notFound('Message not found');

  const delivered = await sendInquiryReplyEmail({
    to: inquiry.email,
    name: inquiry.name,
    subject: inquiry.subject,
    reply: req.body.message,
    originalMessage: inquiry.message,
    receivedAt: inquiry.createdAt,
  });

  inquiry.reply = {
    message: req.body.message,
    sentAt: new Date(),
    delivered: Boolean(delivered),
    by: req.user._id,
    byName: req.user.name,
  };
  inquiry.isRead = true;
  inquiry.readAt = inquiry.readAt || new Date();
  await inquiry.save();

  broadcast.inquiryChanged('replied', inquiry);

  return sendSuccess(res, {
    message: delivered
      ? 'Reply sent'
      : 'Reply saved, but the email could not be delivered — check the SMTP settings',
    data: { inquiry },
  });
});

/** DELETE /inquiries/:id (admin) */
exports.deleteInquiry = asyncHandler(async (req, res) => {
  const inquiry = await Inquiry.findById(req.params.id);
  if (!inquiry) throw ApiError.notFound('Message not found');

  await inquiry.deleteOne();
  broadcast.inquiryChanged('deleted', inquiry);

  return sendSuccess(res, { message: 'Message deleted' });
});
