// src/tokens.js — signed access tokens (portfolio unlock) + admin JWT helpers.
import jwt from 'jsonwebtoken';
import crypto from 'node:crypto';
import { config } from './config.js';

// ---- Portfolio access token (given to an approved requester) ----
// Self-contained signed token: payload + HMAC signature. Verifiable
// server-side without a DB hit, but we also cross-check the DB row.
export function signAccessToken(requestId, email) {
  const exp = Date.now() + config.accessTokenTtlDays * 24 * 60 * 60 * 1000;
  const payload = Buffer.from(JSON.stringify({ rid: requestId, email, exp })).toString('base64url');
  const sig = crypto
    .createHmac('sha256', config.accessTokenSecret)
    .update(payload)
    .digest('base64url');
  return `${payload}.${sig}`;
}

export function verifyAccessToken(token) {
  if (!token || typeof token !== 'string' || !token.includes('.')) {
    return { valid: false, reason: 'malformed' };
  }
  const [payload, sig] = token.split('.');
  const expected = crypto
    .createHmac('sha256', config.accessTokenSecret)
    .update(payload)
    .digest('base64url');

  // Constant-time comparison to avoid timing attacks.
  const a = Buffer.from(sig);
  const b = Buffer.from(expected);
  if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) {
    return { valid: false, reason: 'bad-signature' };
  }

  let data;
  try {
    data = JSON.parse(Buffer.from(payload, 'base64url').toString('utf8'));
  } catch {
    return { valid: false, reason: 'malformed' };
  }
  if (!data.exp || Date.now() > data.exp) {
    return { valid: false, reason: 'expired' };
  }
  return { valid: true, data };
}

// ---- Short-lived one-time admin action tokens (Approve/Reject email links) ----
export function signActionToken(requestId, action) {
  return jwt.sign({ rid: requestId, action }, config.jwtSecret, {
    expiresIn: '7d',
    subject: 'email-action',
  });
}
export function verifyActionToken(token) {
  try {
    return { valid: true, data: jwt.verify(token, config.jwtSecret, { subject: 'email-action' }) };
  } catch (e) {
    return { valid: false, reason: e.name };
  }
}

// ---- Admin session JWT ----
export function signAdminJwt() {
  return jwt.sign({ role: 'admin', email: config.adminEmail }, config.jwtSecret, {
    expiresIn: '12h',
    subject: 'admin-session',
  });
}
export function verifyAdminJwt(token) {
  try {
    return { valid: true, data: jwt.verify(token, config.jwtSecret, { subject: 'admin-session' }) };
  } catch (e) {
    return { valid: false, reason: e.name };
  }
}
