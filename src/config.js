// src/config.js — central config, loaded from environment (.env)
import dotenv from 'dotenv';
import crypto from 'node:crypto';

dotenv.config();

function req(name, fallback = undefined) {
  const v = process.env[name] ?? fallback;
  if (v === undefined || v === '') {
    // For secrets we don't want silent weak defaults in production.
    if (process.env.NODE_ENV === 'production') {
      throw new Error(`Missing required env var: ${name}`);
    }
    return fallback;
  }
  return v;
}

const isProd = process.env.NODE_ENV === 'production';

// In dev, auto-generate ephemeral secrets so the app boots without a .env.
const devSecret = (label) =>
  isProd ? undefined : crypto.createHash('sha256').update(`dev-${label}`).digest('hex');

export const config = {
  isProd,
  port: parseInt(process.env.PORT || '4000', 10),

  backendUrl: (process.env.BACKEND_PUBLIC_URL || 'http://localhost:4000').replace(/\/$/, ''),
  frontendUrl: (process.env.FRONTEND_PUBLIC_URL || 'http://localhost:5500').replace(/\/$/, ''),

  corsOrigins: (process.env.CORS_ORIGINS || 'http://localhost:5500,http://127.0.0.1:5500')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean),

  jwtSecret: req('JWT_SECRET', devSecret('jwt')),
  accessTokenSecret: req('ACCESS_TOKEN_SECRET', devSecret('access')),
  csrfSecret: req('CSRF_SECRET', devSecret('csrf')),
  accessTokenTtlDays: parseInt(process.env.ACCESS_TOKEN_TTL_DAYS || '30', 10),

  adminEmail: (process.env.ADMIN_EMAIL || 'admin@example.com').toLowerCase(),
  adminPassword: process.env.ADMIN_PASSWORD || (isProd ? undefined : 'admin'),
  adminPasswordHash: process.env.ADMIN_PASSWORD_HASH || '',

  notifyEmail: process.env.NOTIFY_EMAIL || process.env.ADMIN_EMAIL || 'admin@example.com',

  email: {
    provider: (process.env.EMAIL_PROVIDER || 'console').toLowerCase(),
    from: process.env.EMAIL_FROM || 'Portfolio <noreply@example.com>',
    resendApiKey: process.env.RESEND_API_KEY || '',
    sendgridApiKey: process.env.SENDGRID_API_KEY || '',
    smtp: {
      host: process.env.SMTP_HOST || '',
      port: parseInt(process.env.SMTP_PORT || '587', 10),
      secure: String(process.env.SMTP_SECURE || 'false') === 'true',
      user: process.env.SMTP_USER || '',
      pass: process.env.SMTP_PASS || '',
    },
  },
};

export function assertConfig() {
  const problems = [];
  if (config.isProd) {
    for (const k of ['jwtSecret', 'accessTokenSecret', 'csrfSecret']) {
      if (!config[k] || config[k].length < 16) problems.push(`Weak/missing ${k}`);
    }
    if (!config.adminPassword && !config.adminPasswordHash) {
      problems.push('Set ADMIN_PASSWORD or ADMIN_PASSWORD_HASH');
    }
  }
  if (problems.length) {
    console.error('\n[CONFIG ERROR]\n - ' + problems.join('\n - ') + '\n');
    process.exit(1);
  }
}
