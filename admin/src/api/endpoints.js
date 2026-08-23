import api from './client';

export const authApi = {
  login: (payload) => api.post('/auth/admin/login', payload),
  logout: () => api.post('/auth/logout'),
  me: () => api.get('/auth/me'),
};

export const dashboardApi = {
  stats: () => api.get('/dashboard/stats'),
  // params: { range: 'month' | 'year' | 'all' | 'custom', from, to } — or legacy { days }.
  salesChart: (params = { range: 'month' }) =>
    api.get('/dashboard/sales-chart', { params: typeof params === 'number' ? { days: params } : params }),
  // All three accept the same { range, from, to } window; omitting it means all time.
  statusBreakdown: (params) => api.get('/dashboard/order-status-breakdown', { params }),
  paymentPreference: (params) => api.get('/dashboard/payment-preference', { params }),
  topProducts: (limit = 5, params) => api.get('/dashboard/top-products', { params: { limit, ...params } }),
  categoryPerformance: () => api.get('/dashboard/category-performance'),
  recentOrders: (limit = 8) => api.get('/dashboard/recent-orders', { params: { limit } }),
  lowStock: (limit = 10) => api.get('/dashboard/low-stock', { params: { limit } }),
};

export const productApi = {
  list: (params) => api.get('/products', { params: { ...params, adminView: true, status: params?.status || 'all' } }),
  detail: (id) => api.get(`/products/${id}`),
  create: (payload) => api.post('/products', payload),
  update: (id, payload) => api.patch(`/products/${id}`, payload),
  remove: (id) => api.delete(`/products/${id}`),
  setStatus: (id, status) => api.patch(`/products/${id}/status`, { status }),
  setStock: (id, stock) => api.patch(`/products/${id}/stock`, { stock }),
};

export const categoryApi = {
  list: () => api.get('/categories', { params: { includeInactive: true } }),
  create: (payload) => api.post('/categories', payload),
  update: (id, payload) => api.patch(`/categories/${id}`, payload),
  remove: (id) => api.delete(`/categories/${id}`),
};

export const subCategoryApi = {
  list: (categoryId) => api.get('/subcategories', { params: { category: categoryId, includeInactive: true } }),
  create: (payload) => api.post('/subcategories', payload),
  update: (id, payload) => api.patch(`/subcategories/${id}`, payload),
  remove: (id) => api.delete(`/subcategories/${id}`),
};

export const brandApi = {
  // includeInactive also asks the server for per-brand product counts.
  list: () => api.get('/brands', { params: { includeInactive: true } }),
  create: (payload) => api.post('/brands', payload),
  update: (id, payload) => api.patch(`/brands/${id}`, payload),
  remove: (id) => api.delete(`/brands/${id}`),
};

export const orderApi = {
  list: (params) => api.get('/orders/admin/all', { params }),
  detail: (id) => api.get(`/orders/${id}`),
  updateStatus: (id, payload) => api.patch(`/orders/${id}/status`, payload),
  // The one payment decision staff make: the refund has actually been sent.
  markRefunded: (id, payload) => api.patch(`/orders/${id}/mark-refunded`, payload),
  statuses: () => api.get('/orders/admin/statuses'),
  /**
   * Moving a return along its own ladder — a separate journey from the order's,
   * so a separate endpoint. `status` is one of out_for_pickup / refund_started /
   * refund_success / rejected; the server refuses anything the return's current
   * step does not allow.
   */
  updateReturnStatus: (id, payload) => api.patch(`/orders/${id}/return/status`, payload),
  returnStatuses: () => api.get('/orders/admin/return-statuses'),
};

/**
 * The picklist the storefront's cancel dialog offers. "Other" is not a row here —
 * it is the free-text escape hatch the dialog always shows underneath.
 */
export const cancellationReasonApi = {
  list: () => api.get('/cancellation-reasons', { params: { adminView: true } }),
  create: (payload) => api.post('/cancellation-reasons', payload),
  update: (id, payload) => api.patch(`/cancellation-reasons/${id}`, payload),
  remove: (id) => api.delete(`/cancellation-reasons/${id}`),
};

/**
 * The picklist the storefront's *return* dialog offers. Separate from the
 * cancellation list above on purpose: the two answer different questions, and
 * sharing rows would put "Wrong address selected" in front of somebody holding a
 * damaged parcel.
 */
export const returnReasonApi = {
  list: () => api.get('/return-reasons', { params: { adminView: true } }),
  create: (payload) => api.post('/return-reasons', payload),
  update: (id, payload) => api.patch(`/return-reasons/${id}`, payload),
  remove: (id) => api.delete(`/return-reasons/${id}`),
};

/**
 * The picklist the storefront's deactivation dialog offers. Same shape as the
 * cancellation list above, deliberately — the Reasons screen drives both through
 * one component, so the two objects have to answer to the same four calls.
 */
export const deactivationReasonApi = {
  list: () => api.get('/deactivation-reasons', { params: { adminView: true } }),
  create: (payload) => api.post('/deactivation-reasons', payload),
  update: (id, payload) => api.patch(`/deactivation-reasons/${id}`, payload),
  remove: (id) => api.delete(`/deactivation-reasons/${id}`),
};

export const userApi = {
  list: (params) => api.get('/users', { params }),
  detail: (id) => api.get(`/users/${id}`),
  /**
   * Blocking and unblocking, and nothing else. An account its owner deactivated is
   * refused by this route — it comes back only through an approved reactivation
   * request, which is the one path that made the customer prove who they are.
   */
  setStatus: (id, status, blockedReason) =>
    api.patch(`/users/${id}/status`, { status, blockedReason }),
  setRole: (id, role) => api.patch(`/users/${id}/role`, { role }),

  /* ---- Reactivation queue ---- */
  // params: { page, limit, status: 'pending'|'approved'|'rejected'|'all', search }
  reactivationRequests: (params) => api.get('/users/reactivation-requests', { params }),
  // The detail call also returns the account's whole audit trail — that is what
  // the reviewer actually decides on.
  reactivationRequest: (id) => api.get(`/users/reactivation-requests/${id}`),
  // payload: { decision: 'approved'|'rejected', adminNotes?, rejectionReason? }
  decideReactivation: (id, payload) => api.patch(`/users/reactivation-requests/${id}`, payload),
};

export const bannerApi = {
  list: () => api.get('/banners', { params: { adminView: true } }),
  create: (payload) => api.post('/banners', payload),
  update: (id, payload) => api.patch(`/banners/${id}`, payload),
  remove: (id) => api.delete(`/banners/${id}`),
  reorder: (order) => api.patch('/banners/reorder', { order }),
};

export const couponApi = {
  list: (params) => api.get('/coupons', { params }),
  create: (payload) => api.post('/coupons', payload),
  update: (id, payload) => api.patch(`/coupons/${id}`, payload),
  remove: (id) => api.delete(`/coupons/${id}`),
};

export const inquiryApi = {
  // params: { page, limit, search, range: 'all'|'month'|'year'|'custom', from, to, sort, status }
  list: (params) => api.get('/inquiries', { params }),
  stats: () => api.get('/inquiries/stats'),
  // Reading one also marks it read, which is what refreshes the unread tile.
  detail: (id) => api.get(`/inquiries/${id}`),
  setRead: (id, isRead) => api.patch(`/inquiries/${id}/read`, { isRead }),
  reply: (id, message) => api.post(`/inquiries/${id}/reply`, { message }),
  remove: (id) => api.delete(`/inquiries/${id}`),
};

export const newsletterApi = {
  // params: { page, limit, search, status: 'all'|'subscribed'|'unsubscribed', sort, range, from, to }
  list: (params) => api.get('/newsletter', { params }),
  setStatus: (id, status) => api.patch(`/newsletter/${id}/status`, { status }),
  remove: (id) => api.delete(`/newsletter/${id}`),
};

export const careerApi = {
  positions: () => api.get('/careers/positions'),
  createPosition: (payload) => api.post('/careers/positions', payload),
  updatePosition: (id, payload) => api.patch(`/careers/positions/${id}`, payload),
  removePosition: (id) => api.delete(`/careers/positions/${id}`),

  /**
   * The admin list carries the switched-off levels too, so a retired option can be
   * put back — the public config only ever returns the active ones.
   */
  experienceLevels: () => api.get('/careers/experience-levels'),
  createExperienceLevel: (payload) => api.post('/careers/experience-levels', payload),
  updateExperienceLevel: (id, payload) => api.patch(`/careers/experience-levels/${id}`, payload),
  removeExperienceLevel: (id) => api.delete(`/careers/experience-levels/${id}`),

  // Public config doubles as the admin's source for experience labels + HR contact.
  config: () => api.get('/careers/config'),
  updateConfig: (payload) => api.patch('/careers/config', payload),

  // params: { page, limit, search, status, position, experience, sort, range, from, to }
  applications: (params) => api.get('/careers/applications', { params }),
  application: (id) => api.get(`/careers/applications/${id}`),
  /**
   * Resumes are admin-only, so they arrive as bytes over the authenticated client
   * rather than as a link the browser could follow on its own.
   */
  resume: (id, disposition = 'inline') =>
    api.get(`/careers/applications/${id}/resume`, {
      params: { disposition },
      responseType: 'blob',
    }),
  setApplicationStatus: (id, payload) => api.patch(`/careers/applications/${id}/status`, payload),
  removeApplication: (id) => api.delete(`/careers/applications/${id}`),
};

export const settingApi = {
  get: () => api.get('/settings'),
  update: (payload) => api.patch('/settings', payload),
};

export const uploadApi = {
  /** Single-file upload with a progress callback so each card shows its own bar. */
  image: (file, { kind = 'products', onProgress } = {}) => {
    const form = new FormData();
    form.append('image', file);
    form.append('kind', kind);
    return api.post('/uploads/image', form, {
      onUploadProgress: (event) => {
        if (!onProgress || !event.total) return;
        onProgress(Math.round((event.loaded * 100) / event.total));
      },
    });
  },
  /** Short-lived credentials for a browser → Cloudinary upload (see utils/media.js). */
  signature: (kind = 'products') => api.post('/uploads/signature', { kind }),
  /** Product clips ride the shared media route — one file per request, same progress contract. */
  video: (file, { kind = 'products', onProgress } = {}) => {
    const form = new FormData();
    form.append('file', file);
    form.append('kind', kind);
    return api.post('/uploads/media', form, {
      onUploadProgress: (event) => {
        if (!onProgress || !event.total) return;
        onProgress(Math.round((event.loaded * 100) / event.total));
      },
    });
  },
  /** `type: 'video'` picks the Cloudinary namespace the asset actually lives in. */
  remove: (publicId, { type = 'image' } = {}) =>
    api.delete(`/uploads/${publicId}`, { params: { type } }),
};
