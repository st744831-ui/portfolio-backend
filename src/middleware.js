// src/middleware.js — admin auth guard + request metadata helpers.
import { verifyAdminJwt } from './tokens.js';

const ADMIN_COOKIE = 'pa_admin';
export { ADMIN_COOKIE };

// Protects admin API routes. Accepts JWT from cookie or Authorization header.
export function requireAdmin(req, res, next) {
  const bearer = (req.headers.authorization || '').replace(/^Bearer\s+/i, '');
  const token = req.cookies?.[ADMIN_COOKIE] || bearer;
  const result = verifyAdminJwt(token);
  if (!result.valid) {
    return res.status(401).json({ ok: false, error: 'Unauthorized' });
  }
  req.admin = result.data;
  next();
}

// Best-effort client metadata for the notification email.
export function clientMeta(req) {
  const xff = (req.headers['x-forwarded-for'] || '').split(',')[0].trim();
  const ip = xff || req.socket?.remoteAddress || req.ip || '';
  return {
    ip: ip.replace(/^::ffff:/, ''),
    userAgent: req.headers['user-agent'] || '',
    // Common proxy/CDN country headers (Cloudflare, Vercel, etc.)
    country:
      req.headers['cf-ipcountry'] ||
      req.headers['x-vercel-ip-country'] ||
      req.headers['x-country-code'] ||
      '',
  };
}
