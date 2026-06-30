// src/email.js — provider-agnostic email sending (resend | sendgrid | smtp | console).
import nodemailer from 'nodemailer';
import { config } from './config.js';

let smtpTransport = null;
function getSmtp() {
  if (!smtpTransport) {
    smtpTransport = nodemailer.createTransport({
      host: config.email.smtp.host,
      port: config.email.smtp.port,
      secure: config.email.smtp.secure,
      auth: config.email.smtp.user
        ? { user: config.email.smtp.user, pass: config.email.smtp.pass }
        : undefined,
    });
  }
  return smtpTransport;
}

export async function sendEmail({ to, subject, html, text }) {
  const provider = config.email.provider;
  const from = config.email.from;

  try {
    if (provider === 'resend') {
      const { Resend } = await import('resend');
      const resend = new Resend(config.email.resendApiKey);
      const { error } = await resend.emails.send({ from, to, subject, html, text });
      if (error) throw new Error(error.message || JSON.stringify(error));
      return { ok: true, provider };
    }

    if (provider === 'sendgrid') {
      const sg = (await import('@sendgrid/mail')).default;
      sg.setApiKey(config.email.sendgridApiKey);
      await sg.send({ to, from, subject, html, text });
      return { ok: true, provider };
    }

    if (provider === 'smtp') {
      await getSmtp().sendMail({ from, to, subject, html, text });
      return { ok: true, provider };
    }

    // console (default / local testing): log instead of sending.
    console.log('\n========== [EMAIL — console mode] ==========');
    console.log('From:', from);
    console.log('To:', to);
    console.log('Subject:', subject);
    console.log('--- text ---\n' + (text || '(html only)'));
    console.log('============================================\n');
    return { ok: true, provider: 'console' };
  } catch (err) {
    console.error(`[email] send failed via ${provider}:`, err.message);
    return { ok: false, error: err.message, provider };
  }
}

// ---------- Templates ----------
const wrap = (inner) => `
  <div style="font-family:-apple-system,Segoe UI,Roboto,Helvetica,Arial,sans-serif;background:#0e0f13;padding:32px 0;">
    <div style="max-width:560px;margin:0 auto;background:#16181f;border:1px solid #23262f;border-radius:16px;overflow:hidden;">
      <div style="padding:24px 28px;border-bottom:1px solid #23262f;">
        <span style="color:#c6f24e;font-weight:700;font-size:18px;letter-spacing:.3px;">Creative Shivam</span>
      </div>
      <div style="padding:28px;color:#d7dae2;font-size:15px;line-height:1.6;">${inner}</div>
      <div style="padding:18px 28px;border-top:1px solid #23262f;color:#6b6f7a;font-size:12px;">
        Sent automatically by your portfolio access system.
      </div>
    </div>
  </div>`;

const btn = (href, label, color) =>
  `<a href="${href}" style="display:inline-block;background:${color};color:#0e0f13;font-weight:700;
    text-decoration:none;padding:12px 22px;border-radius:10px;font-size:14px;">${label}</a>`;

const esc = (s) =>
  String(s ?? '—').replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));

export function notifyRequestEmail(rec, approveUrl, rejectUrl) {
  const d = new Date(rec.createdAt);
  const rows = [
    ['Name', rec.fullName],
    ['Company', rec.companyName],
    ['Email', rec.email],
    ['Phone', rec.phone || '—'],
    ['Message', rec.message || '—'],
    ['Date', d.toLocaleDateString()],
    ['Time', d.toLocaleTimeString()],
    ['Browser / Device', rec.userAgent || '—'],
    ['IP Address', rec.ip || '—'],
    ['Country', rec.country || '—'],
  ]
    .map(
      ([k, v]) =>
        `<tr><td style="padding:6px 12px 6px 0;color:#8a8f9b;white-space:nowrap;vertical-align:top;">${k}</td>
         <td style="padding:6px 0;color:#e8eaf0;">${esc(v)}</td></tr>`
    )
    .join('');

  const html = wrap(`
    <h2 style="margin:0 0 14px;color:#fff;font-size:20px;">New portfolio access request</h2>
    <table style="width:100%;border-collapse:collapse;font-size:14px;">${rows}</table>
    <div style="margin-top:24px;display:flex;gap:12px;">
      ${btn(approveUrl, '✓ Approve', '#c6f24e')}
      &nbsp;&nbsp;
      ${btn(rejectUrl, '✕ Reject', '#ff6b6b')}
    </div>
    <p style="margin-top:18px;font-size:12px;color:#6b6f7a;">Or manage everything in your admin dashboard.</p>
  `);

  const text = `New portfolio access request
Name: ${rec.fullName}
Company: ${rec.companyName}
Email: ${rec.email}
Phone: ${rec.phone || '-'}
Message: ${rec.message || '-'}
Date: ${d.toLocaleDateString()}  Time: ${d.toLocaleTimeString()}
Device: ${rec.userAgent || '-'}
IP: ${rec.ip || '-'}  Country: ${rec.country || '-'}

Approve: ${approveUrl}
Reject:  ${rejectUrl}`;

  return { subject: 'New Portfolio Access Request', html, text };
}

export function approvalEmail(viewUrl) {
  const html = wrap(`
    <h2 style="margin:0 0 14px;color:#fff;font-size:20px;">Portfolio access approved</h2>
    <p style="margin:0 0 8px;">Hello,</p>
    <p style="margin:0 0 20px;">Your portfolio access request has been approved.
       Click the button below to view all my private work.</p>
    ${btn(viewUrl, 'View Complete Portfolio', '#c6f24e')}
    <p style="margin-top:22px;font-size:12px;color:#6b6f7a;word-break:break-all;">
      Or paste this link: ${esc(viewUrl)}</p>
  `);
  const text = `Portfolio access approved

Hello,
Your portfolio access request has been approved.
View all my private work here:
${viewUrl}`;
  return { subject: 'Portfolio Access Approved', html, text };
}
