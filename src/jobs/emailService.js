// emailService.js — Central email service for Arc.
//
// Handles two email types:
//   1. Forgot Password  — sends a temporary password to the user's registered email
//   2. Reminder Emails  — sends grouped overdue quotation reminders to each creator
//
// ── Gmail SMTP Setup ─────────────────────────────────────────────────────────
// Add these to server/.env:
//
//   SMTP_USER=yourname@gmail.com
//   SMTP_PASS=xxxx xxxx xxxx xxxx     ← 16-character Gmail App Password (NOT your login password)
//   SMTP_FROM="Arc" <yourname@gmail.com>
//
// To generate a Gmail App Password:
//   1. Go to https://myaccount.google.com/security
//   2. Enable 2-Step Verification if not already done
//   3. Search "App Passwords" → Select app: Mail, device: Windows → Generate
//   4. Copy the 16-character code — paste as SMTP_PASS (spaces are fine)
//
// ── Outlook 365 (alternative) ─────────────────────────────────────────────────
// Change getTransporter() to use:
//   host: 'smtp.office365.com', port: 587, secure: false, tls: { ciphers: 'SSLv3' }
//   and remove: service: 'gmail'
//
// ── Activation ───────────────────────────────────────────────────────────────
// Server boots fine without SMTP credentials — emails are silently skipped.
// Add SMTP_USER + SMTP_PASS to .env to activate. No code change needed.

const nodemailer = require('nodemailer')

// ── Transporter (lazily created, cached) ─────────
let _transporter = null

const getTransporter = () => {
  if (_transporter) return _transporter

  if (!process.env.SMTP_USER || !process.env.SMTP_PASS) {
    console.warn('[Email] SMTP_USER or SMTP_PASS not set — all emails disabled')
    return null
  }

  _transporter = nodemailer.createTransport({
    service: 'gmail',           // nodemailer resolves host/port automatically for Gmail
    auth: {
      user: process.env.SMTP_USER,
      pass: process.env.SMTP_PASS,   // App Password — not your Gmail login password
    },
  })

  return _transporter
}

const fromAddress = () =>
  process.env.SMTP_FROM || `"Arc" <${process.env.SMTP_USER}>`

// ═══════════════════════════════════════════════════════════════════
// EMAIL TYPE 1 — Forgot Password
// Called by authController.forgotPassword()
// Sends a temporary password to the user's registered email address.
// ═══════════════════════════════════════════════════════════════════

const sendForgotPasswordEmail = async ({ to, userName, tempPassword }) => {
  const transporter = getTransporter()
  if (!transporter) {
    console.warn(`[Email] Skipping forgot-password email to ${to} — SMTP not configured`)
    return { sent: false, reason: 'SMTP not configured' }
  }

  const subject = 'Arc — Your Temporary Password'

  const html = `
    <div style="font-family: Arial, sans-serif; font-size: 14px; color: #333; max-width: 600px;">
      <div style="background-color: #1a3c5e; padding: 16px 24px; border-radius: 6px 6px 0 0;">
        <h2 style="color: #fff; margin: 0; font-size: 18px;">Password Reset</h2>
      </div>
      <div style="padding: 24px; border: 1px solid #ddd; border-top: none; border-radius: 0 0 6px 6px;">
        <p>Hello ${userName},</p>
        <p>A temporary password has been generated for your Arc account.</p>

        <div style="background-color: #1a3c5e; border-radius: 8px; padding: 16px 24px;
                    text-align: center; margin: 24px 0;">
          <p style="font-size: 11px; color: #BDD7EE; text-transform: uppercase;
                    letter-spacing: 1px; margin: 0 0 8px 0;">Your Temporary Password</p>
          <p style="font-size: 28px; font-weight: 700; color: #ffffff;
                    letter-spacing: 6px; margin: 0;">${tempPassword}</p>
        </div>

        <p>Please log in using this temporary password and change it immediately from your account settings.</p>
        <p style="color: #c62828; font-size: 13px;">
          ⚠️ This password gives full access to your account. Do not share it with anyone.
        </p>
        <p style="color: #888; font-size: 12px; margin-top: 24px; border-top: 1px solid #eee; padding-top: 16px;">
          If you did not request a password reset, please contact your administrator immediately.<br>
          This is an automated message from Arc — Sunserk Technology Solutions.
        </p>
      </div>
    </div>
  `

  try {
    await transporter.sendMail({ from: fromAddress(), to, subject, html })
    console.log(`[Email] Forgot-password email sent → ${to}`)
    return { sent: true }
  } catch (err) {
    console.error(`[Email] Failed to send forgot-password email to ${to}:`, err.message)
    return { sent: false, reason: err.message }
  }
}

// ═══════════════════════════════════════════════════════════════════
// EMAIL TYPE 2 — Overdue Quotation Reminder (grouped per user)
// Called by reminderJob.js once per user per reminder cycle.
// quotes[] = array of { quoteNumber, customerName, followUpDate, status }
// All overdue quotes for a user arrive in one email — not one per quote.
// ═══════════════════════════════════════════════════════════════════

const sendReminderEmail = async ({ to, quotes, tenantName }) => {
  const transporter = getTransporter()
  if (!transporter) {
    console.warn(`[Email] Skipping reminder to ${to} — SMTP not configured`)
    return { sent: false, reason: 'SMTP not configured' }
  }

  const count   = quotes.length
  const subject = `Follow-up Reminder — ${count} Overdue Quotation${count > 1 ? 's' : ''}`

  const rows = quotes.map(q => {
    const due = new Date(q.followUpDate).toLocaleDateString('en-GB', {
      day: '2-digit', month: 'short', year: 'numeric',
    })
    return `
      <tr>
        <td style="padding: 8px 12px; border: 1px solid #ddd;">${q.quoteNumber || '—'}</td>
        <td style="padding: 8px 12px; border: 1px solid #ddd;">${q.customerName || '—'}</td>
        <td style="padding: 8px 12px; border: 1px solid #ddd; color: #c62828; font-weight: bold;">${due}</td>
        <td style="padding: 8px 12px; border: 1px solid #ddd;">${q.status || '—'}</td>
      </tr>`
  }).join('')

  const html = `
    <div style="font-family: Arial, sans-serif; font-size: 14px; color: #333; max-width: 680px;">
      <div style="background-color: #1a3c5e; padding: 16px 24px; border-radius: 6px 6px 0 0;">
        <h2 style="color: #fff; margin: 0; font-size: 18px;">Quotation Follow-up Reminder</h2>
        ${tenantName ? `<p style="color: #BDD7EE; margin: 4px 0 0 0; font-size: 13px;">${tenantName}</p>` : ''}
      </div>
      <div style="padding: 24px; border: 1px solid #ddd; border-top: none; border-radius: 0 0 6px 6px;">
        <p>You have <strong>${count} overdue quotation${count > 1 ? 's' : ''}</strong> requiring follow-up:</p>

        <table style="width: 100%; border-collapse: collapse; margin: 16px 0; font-size: 13px;">
          <thead>
            <tr style="background-color: #1a3c5e; color: #fff;">
              <th style="padding: 10px 12px; text-align: left; border: 1px solid #1a3c5e;">Quote Number</th>
              <th style="padding: 10px 12px; text-align: left; border: 1px solid #1a3c5e;">Customer</th>
              <th style="padding: 10px 12px; text-align: left; border: 1px solid #1a3c5e;">Follow-up Due</th>
              <th style="padding: 10px 12px; text-align: left; border: 1px solid #1a3c5e;">Status</th>
            </tr>
          </thead>
          <tbody>${rows}</tbody>
        </table>

        <p>For each quotation, please take one of these actions in Arc:</p>
        <ul style="font-size: 13px; line-height: 1.8;">
          <li>Contact the customer and update the quotation status</li>
          <li>Update the follow-up date if more time is needed</li>
          <li>Mark as <strong>Awarded</strong> or <strong>Not Awarded</strong> if concluded</li>
        </ul>

        <p style="color: #888; font-size: 12px; margin-top: 24px; border-top: 1px solid #eee; padding-top: 16px;">
          This is an automated reminder from Arc. Reminders stop when quotation status is updated
          or after the configured follow-up window has passed.<br>Sunserk Technology Solutions
        </p>
      </div>
    </div>
  `

  try {
    await transporter.sendMail({ from: fromAddress(), to, subject, html })
    console.log(`[Email] Reminder sent → ${to} (${count} quote${count > 1 ? 's' : ''})`)
    return { sent: true }
  } catch (err) {
    console.error(`[Email] Failed to send reminder to ${to}:`, err.message)
    return { sent: false, reason: err.message }
  }
}

// (exports moved to end of file — see sendContactEnquiryEmail below)

// ═══════════════════════════════════════════════════════════════════
// EMAIL TYPE 3 — Contact / Sales Enquiry
// Called by authController.contactEnquiry()
// Forwards the landing page contact form submission to admin@sunserk.com
// ═══════════════════════════════════════════════════════════════════

const sendContactEnquiryEmail = async ({ name, phone, email, message }) => {
  const transporter = getTransporter()
  if (!transporter) {
    console.warn('[Email] Skipping contact enquiry email — SMTP not configured')
    return { sent: false, reason: 'SMTP not configured' }
  }

  const subject = `Arc Enquiry — ${name}`

  const html = `
    <div style="font-family: Arial, sans-serif; font-size: 14px; color: #333; max-width: 600px;">
      <div style="background-color: #1a3c5e; padding: 16px 24px; border-radius: 6px 6px 0 0;">
        <h2 style="color: #fff; margin: 0; font-size: 18px;">New Arc Platform Enquiry</h2>
      </div>
      <div style="padding: 24px; border: 1px solid #ddd; border-top: none; border-radius: 0 0 6px 6px;">
        <p>A potential customer has submitted a contact form on the Arc landing page.</p>

        <table style="width: 100%; border-collapse: collapse; margin: 16px 0;">
          <tr>
            <td style="padding: 8px 12px; background: #f0f4f8; font-weight: bold; width: 30%; border: 1px solid #ddd;">Name</td>
            <td style="padding: 8px 12px; border: 1px solid #ddd;">${name}</td>
          </tr>
          <tr>
            <td style="padding: 8px 12px; background: #f0f4f8; font-weight: bold; border: 1px solid #ddd;">Email</td>
            <td style="padding: 8px 12px; border: 1px solid #ddd;"><a href="mailto:${email}">${email}</a></td>
          </tr>
          <tr>
            <td style="padding: 8px 12px; background: #f0f4f8; font-weight: bold; border: 1px solid #ddd;">Phone</td>
            <td style="padding: 8px 12px; border: 1px solid #ddd;">${phone || '—'}</td>
          </tr>
          <tr>
            <td style="padding: 8px 12px; background: #f0f4f8; font-weight: bold; border: 1px solid #ddd;">Message</td>
            <td style="padding: 8px 12px; border: 1px solid #ddd; white-space: pre-wrap;">${message || '—'}</td>
          </tr>
        </table>

        <p style="color: #888; font-size: 12px; margin-top: 24px; border-top: 1px solid #eee; padding-top: 16px;">
          This enquiry was submitted via the Arc landing page contact form.<br>
          Sunserk Technology Solutions
        </p>
      </div>
    </div>
  `

  try {
    await transporter.sendMail({
      from:    fromAddress(),
      to:      'admin@sunserk.com',
      replyTo: email,             // Reply goes directly to the enquirer
      subject,
      html,
    })
    console.log(`[Email] Contact enquiry forwarded to admin@sunserk.com from ${email}`)
    return { sent: true }
  } catch (err) {
    console.error('[Email] Failed to send contact enquiry:', err.message)
    return { sent: false, reason: err.message }
  }
}

// ═══════════════════════════════════════════════════════════════════
// EMAIL TYPE 4 — Tenant Deletion Request
// Called by adminController.requestTenantDeletion()
// Sends a confirmation link to SUPER_ADMIN_EMAIL.
// Link is valid for 24 hours. Clicking it executes full tenant deletion.
// ═══════════════════════════════════════════════════════════════════

const sendDeletionRequestEmail = async ({ to, tenantName, tenantId, confirmUrl, expiresAt }) => {
  const transporter = getTransporter()
  if (!transporter) {
    console.warn(`[Email] Skipping deletion request email — SMTP not configured`)
    return { sent: false, reason: 'SMTP not configured' }
  }

  const expiryStr = new Date(expiresAt).toLocaleString('en-GB', {
    day: '2-digit', month: 'short', year: 'numeric',
    hour: '2-digit', minute: '2-digit', timeZone: 'Asia/Kolkata',
  }) + ' IST'

  const subject = `⚠ Arc — Deletion Request for ${tenantName}`

  const html = `
    <div style="font-family: Arial, sans-serif; font-size: 14px; color: #333; max-width: 600px;">
      <div style="background-color: #c62828; padding: 16px 24px; border-radius: 6px 6px 0 0;">
        <h2 style="color: #fff; margin: 0; font-size: 18px;">⚠ Tenant Deletion Request</h2>
      </div>
      <div style="padding: 24px; border: 1px solid #ddd; border-top: none; border-radius: 0 0 6px 6px;">
        <p>A deletion request has been submitted for the following tenant:</p>

        <table style="width: 100%; border-collapse: collapse; margin: 16px 0;">
          <tr>
            <td style="padding: 10px 14px; background: #f0f4f8; font-weight: bold;
                       width: 35%; border: 1px solid #ddd;">Company Name</td>
            <td style="padding: 10px 14px; border: 1px solid #ddd;
                       font-weight: bold; color: #c62828;">${tenantName}</td>
          </tr>
          <tr>
            <td style="padding: 10px 14px; background: #f0f4f8; font-weight: bold;
                       border: 1px solid #ddd;">Tenant ID</td>
            <td style="padding: 10px 14px; border: 1px solid #ddd;
                       font-family: monospace;">${tenantId}</td>
          </tr>
          <tr>
            <td style="padding: 10px 14px; background: #f0f4f8; font-weight: bold;
                       border: 1px solid #ddd;">Link Expires</td>
            <td style="padding: 10px 14px; border: 1px solid #ddd;">${expiryStr}</td>
          </tr>
        </table>

        <div style="background: #fff8e1; border: 1px solid #f59e0b; border-radius: 8px;
                    padding: 16px; margin: 20px 0;">
          <p style="margin: 0; font-weight: bold; color: #856404;">⚠ This action is irreversible.</p>
          <p style="margin: 8px 0 0; color: #856404; font-size: 13px;">
            Clicking the button below will permanently delete ALL data for this tenant —
            quotations, customers, parts, users, and the tenant record itself.
            This cannot be undone.
          </p>
        </div>

        <p>If you submitted this request and want to proceed, click the button below.
           You have <strong>24 hours</strong> from when this email was sent.</p>

        <div style="text-align: center; margin: 28px 0;">
          <a href="${confirmUrl}"
             style="display: inline-block; background: #c62828; color: #fff;
                    text-decoration: none; padding: 14px 32px; border-radius: 8px;
                    font-weight: bold; font-size: 15px; letter-spacing: 0.3px;">
            Confirm Permanent Deletion
          </a>
        </div>

        <p style="font-size: 13px; color: #666;">
          If you did not request this deletion, do not click the button above.
          The link will automatically expire at ${expiryStr} and no action will be taken.
        </p>

        <p style="color: #888; font-size: 12px; margin-top: 24px;
                  border-top: 1px solid #eee; padding-top: 16px;">
          This is an automated security email from Arc.<br>
          Sunserk Technology Solutions
        </p>
      </div>
    </div>
  `

  try {
    await transporter.sendMail({ from: fromAddress(), to, subject, html })
    console.log(`[Email] Deletion request email sent → ${to} for tenant ${tenantId}`)
    return { sent: true }
  } catch (err) {
    console.error(`[Email] Failed to send deletion request email:`, err.message)
    return { sent: false, reason: err.message }
  }
}

// ── SMTP connectivity test ────────────────────────────────────────
// Called by /api/health/external to verify SMTP is reachable.
// Uses nodemailer's verify() — connects and authenticates but sends nothing.
// Returns { ok: bool, error: string|null, configured: bool }
const testSmtpConnectivity = async () => {
  if (!process.env.SMTP_USER || !process.env.SMTP_PASS) {
    return { ok: false, configured: false, error: 'SMTP_USER or SMTP_PASS not set in .env' }
  }
  const transporter = getTransporter()
  if (!transporter) {
    return { ok: false, configured: false, error: 'Transporter could not be created' }
  }
  try {
    await transporter.verify()
    return { ok: true, configured: true, error: null }
  } catch (err) {
    return { ok: false, configured: true, error: err.message }
  }
}

module.exports = {
  sendForgotPasswordEmail,
  sendReminderEmail,
  sendContactEnquiryEmail,
  sendDeletionRequestEmail,
  testSmtpConnectivity,
}
