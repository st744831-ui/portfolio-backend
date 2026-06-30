// src/server.js — main Express application.
import express from 'express';
import helmet from 'helmet';
import cors from 'cors';
import cookieParser from 'cookie-parser';
import rateLimit from 'express-rate-limit';
import { doubleCsrf } from 'csrf-csrf';
import validator from 'validator';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { config, assertConfig } from './config.js';
import { Access } from './db.js';
import {
  signAccessToken,
  verifyAccessToken,
  signActionToken,
  verifyActionToken,
  signAdminJwt,
} from './tokens.js';
import { verifyPassword } from './password.js';
import { sendEmail, notifyRequestEmail, approvalEmail } from './email.js';
import { requireAdmin, clientMeta, ADMIN_COOKIE } from './middleware.js';
import { toCSV, toXLSX } from './export.js';

assertConfig();

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const app = express();
app.set('trust proxy', 1); // correct client IPs behind Render/Railway/Cloudflare

// ---------- Security middleware ----------
app.use(
  helmet({
    contentSecurityPolicy: false, // admin UI is self-hosted; relax for inline styles
    crossOriginResourcePolicy: { policy: 'cross-origin' },
  })
);
app.use(
  cors({
    origin(origin, cb) {
      // allow same-origin / curl (no origin) and configured origins
      if (!origin || config.corsOrigins.includes(origin)) return cb(null, true);
      cb(new Error('Not allowed by CORS'));
    },
    credentials: true,
  })
);
app.use(express.json({ limit: '64kb' }));
app.use(express.urlencoded({ extended: false, limit: '64kb' }));
app.use(cookieParser());

// ---------- Rate limiting ----------
const submitLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 8, // max 8 access requests per IP / 15 min
  standardHeaders: true,
  legacyHeaders: false,
  message: { ok: false, error: 'Too many requests. Please try again later.' },
});
const loginLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 10,
  standardHeaders: true,
  legacyHeaders: false,
  message: { ok: false, error: 'Too many login attempts. Try again later.' },
});
const apiLimiter = rateLimit({ windowMs: 60 * 1000, max: 120 });
app.use('/api/', apiLimiter);

// ---------- CSRF protection ----------
const { generateToken, doubleCsrfProtection } = doubleCsrf({
  getSecret: () => config.csrfSecret,
  // Sessionless double-submit. The identifier must be STABLE between the
  // request that issues the token and the one that submits it, so we use the
  // client IP (the cookie value changes once it's set, which would break it).
  getSessionIdentifier: (req) => req.ip || 'anon',
  cookieName: config.isProd ? '__Host-pa.csrf' : 'pa.csrf',
  cookieOptions: { sameSite: 'lax', secure: config.isProd, path: '/' },
  getCsrfTokenFromRequest: (req) => req.headers['x-csrf-token'],
});

// Hand out a CSRF token to the frontend before it submits the form.
app.get('/api/csrf', (req, res) => {
  res.json({ csrfToken: generateToken(req, res) });
});

const sanitize = (s, max = 2000) =>
  validator.escape(String(s ?? '').trim()).slice(0, max);

// =====================================================================
//  PUBLIC: submit an access request  (STEP 2, 3, 4)
// =====================================================================
app.post('/api/access-request', submitLimiter, doubleCsrfProtection, async (req, res) => {
  const b = req.body || {};
  const fullName = sanitize(b.fullName, 120);
  const companyName = sanitize(b.companyName, 160);
  const email = String(b.email ?? '').trim().toLowerCase();
  const phone = sanitize(b.phone, 40);
  const message = sanitize(b.message, 2000);

  // ---- Server-side validation (never trust the frontend) ----
  const errors = {};
  if (!fullName) errors.fullName = 'Full name is required.';
  if (!companyName) errors.companyName = 'Company name is required.';
  if (!email || !validator.isEmail(email)) errors.email = 'A valid business email is required.';
  if (phone && !validator.isMobilePhone(phone, 'any', { strictMode: false }) && phone.length < 6)
    errors.phone = 'Phone number looks invalid.';
  if (Object.keys(errors).length) return res.status(422).json({ ok: false, errors });

  const meta = clientMeta(req);
  const rec = Access.create({ fullName, companyName, email, phone, message, ...meta });

  // Build Approve/Reject action links for the email.
  const approveUrl = `${config.backendUrl}/api/email-action?token=${encodeURIComponent(
    signActionToken(rec.id, 'approve')
  )}`;
  const rejectUrl = `${config.backendUrl}/api/email-action?token=${encodeURIComponent(
    signActionToken(rec.id, 'reject')
  )}`;

  const mail = notifyRequestEmail(rec, approveUrl, rejectUrl);
  sendEmail({ to: config.notifyEmail, ...mail }); // fire-and-forget

  res.json({ ok: true, message: 'Request received. You will be notified by email once approved.' });
});

// =====================================================================
//  PUBLIC: verify an access token (STEP 7)  -> frontend unlock
// =====================================================================
app.get('/api/verify-access', (req, res) => {
  const token = String(req.query.token || '');
  const result = verifyAccessToken(token);
  if (!result.valid) {
    return res.status(401).json({ ok: false, valid: false, reason: result.reason });
  }
  // Cross-check against DB: row must still exist and be approved with same token.
  const rec = Access.byToken(token);
  if (!rec || rec.status !== 'approved') {
    return res.status(401).json({ ok: false, valid: false, reason: 'revoked' });
  }
  Access.touch(rec.id);
  res.json({ ok: true, valid: true });
});

// =====================================================================
//  EMAIL ACTION: one-click Approve / Reject from the notification email
// =====================================================================
app.get('/api/email-action', async (req, res) => {
  const result = verifyActionToken(String(req.query.token || ''));
  if (!result.valid) {
    return res.status(400).send(htmlPage('Link expired', 'This action link is invalid or expired.'));
  }
  const { rid, action } = result.data;
  const rec = Access.byId(rid);
  if (!rec) return res.status(404).send(htmlPage('Not found', 'That request no longer exists.'));

  if (action === 'approve') {
    await approveRequest(rec);
    return res.send(htmlPage('Approved ✓', `${rec.fullName} (${rec.email}) has been approved and notified.`));
  }
  if (action === 'reject') {
    Access.setStatus(rec.id, 'rejected', { token: null, approvedAt: null });
    return res.send(htmlPage('Rejected', `${rec.fullName} (${rec.email}) has been rejected.`));
  }
  res.status(400).send(htmlPage('Unknown action', 'Nothing to do.'));
});

// Shared approval logic (STEP 6): generate token, persist, email user.
async function approveRequest(rec) {
  const token = signAccessToken(rec.id, rec.email);
  const updated = Access.setStatus(rec.id, 'approved', {
    token,
    approvedAt: new Date().toISOString(),
  });
  const viewUrl = `${config.frontendUrl}/work.html?token=${encodeURIComponent(token)}`;
  const mail = approvalEmail(viewUrl);
  await sendEmail({ to: rec.email, ...mail });
  return updated;
}

// =====================================================================
//  ADMIN AUTH (STEP 5)
// =====================================================================
app.post('/api/admin/login', loginLimiter, (req, res) => {
  const email = String(req.body?.email ?? '').trim().toLowerCase();
  const password = String(req.body?.password ?? '');

  const emailOk = email === config.adminEmail;
  const passOk = config.adminPasswordHash
    ? verifyPassword(password, config.adminPasswordHash)
    : password === config.adminPassword;

  if (!emailOk || !passOk) {
    return res.status(401).json({ ok: false, error: 'Invalid credentials.' });
  }
  const jwtToken = signAdminJwt();
  res.cookie(ADMIN_COOKIE, jwtToken, {
    httpOnly: true,
    sameSite: 'lax',
    secure: config.isProd,
    maxAge: 12 * 60 * 60 * 1000,
  });
  res.json({ ok: true, token: jwtToken });
});

app.post('/api/admin/logout', (req, res) => {
  res.clearCookie(ADMIN_COOKIE);
  res.json({ ok: true });
});

app.get('/api/admin/me', requireAdmin, (req, res) => {
  res.json({ ok: true, admin: { email: req.admin.email } });
});

// ---- Admin data ----
app.get('/api/admin/stats', requireAdmin, (req, res) => {
  res.json({ ok: true, stats: Access.stats() });
});

app.get('/api/admin/requests', requireAdmin, (req, res) => {
  const { status, search, page, pageSize } = req.query;
  const result = Access.list({
    status,
    search: search ? String(search) : '',
    page: parseInt(page || '1', 10),
    pageSize: Math.min(50, parseInt(pageSize || '10', 10)),
  });
  res.json({ ok: true, ...result });
});

app.get('/api/admin/requests/:id', requireAdmin, (req, res) => {
  const rec = Access.byId(parseInt(req.params.id, 10));
  if (!rec) return res.status(404).json({ ok: false, error: 'Not found' });
  res.json({ ok: true, request: rec });
});

app.post('/api/admin/requests/:id/approve', requireAdmin, async (req, res) => {
  const rec = Access.byId(parseInt(req.params.id, 10));
  if (!rec) return res.status(404).json({ ok: false, error: 'Not found' });
  const updated = await approveRequest(rec);
  res.json({ ok: true, request: updated });
});

app.post('/api/admin/requests/:id/reject', requireAdmin, (req, res) => {
  const rec = Access.byId(parseInt(req.params.id, 10));
  if (!rec) return res.status(404).json({ ok: false, error: 'Not found' });
  const updated = Access.setStatus(rec.id, 'rejected', { token: null, approvedAt: null });
  res.json({ ok: true, request: updated });
});

app.delete('/api/admin/requests/:id', requireAdmin, (req, res) => {
  const changes = Access.remove(parseInt(req.params.id, 10));
  res.json({ ok: changes > 0 });
});

// ---- Exports (STEP 9) ----
app.get('/api/admin/export.csv', requireAdmin, (req, res) => {
  const csv = toCSV(Access.all());
  res.setHeader('Content-Type', 'text/csv');
  res.setHeader('Content-Disposition', 'attachment; filename="portfolio-access.csv"');
  res.send(csv);
});

app.get('/api/admin/export.xlsx', requireAdmin, async (req, res) => {
  const buf = await toXLSX(Access.all());
  res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
  res.setHeader('Content-Disposition', 'attachment; filename="portfolio-access.xlsx"');
  res.send(Buffer.from(buf));
});

// ---------- Static admin dashboard ----------
app.use('/admin', express.static(path.join(__dirname, '..', 'public', 'admin')));
app.get('/admin', (req, res) =>
  res.sendFile(path.join(__dirname, '..', 'public', 'admin', 'index.html'))
);

app.get('/health', (req, res) => res.json({ ok: true }));

// Friendly HTML page for email-action responses.
function htmlPage(title, body) {
  return `<!doctype html><html><head><meta charset="utf-8">
  <meta name="viewport" content="width=device-width,initial-scale=1">
  <title>${title}</title>
  <style>body{margin:0;font-family:-apple-system,Segoe UI,Roboto,sans-serif;background:#0e0f13;color:#e8eaf0;
  display:flex;min-height:100vh;align-items:center;justify-content:center;}
  .card{background:#16181f;border:1px solid #23262f;border-radius:16px;padding:40px;max-width:420px;text-align:center;}
  h1{color:#c6f24e;font-size:24px;margin:0 0 12px;} p{color:#9aa0ac;line-height:1.6;}</style></head>
  <body><div class="card"><h1>${title}</h1><p>${body}</p></div></body></html>`;
}

// Error handler (CSRF + others)
app.use((err, req, res, next) => {
  if (err?.code === 'EBADCSRFTOKEN' || /csrf/i.test(err?.message || '')) {
    return res.status(403).json({ ok: false, error: 'Invalid CSRF token. Refresh and try again.' });
  }
  console.error(err);
  res.status(500).json({ ok: false, error: 'Server error' });
});

app.listen(config.port, () => {
  console.log(`\n  Portfolio access backend running on http://localhost:${config.port}`);
  console.log(`  Email provider: ${config.email.provider}`);
  console.log(`  Admin dashboard: http://localhost:${config.port}/admin\n`);
});
