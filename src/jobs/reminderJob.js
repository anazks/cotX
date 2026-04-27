// reminderJob.js — Scheduled overdue quotation reminder emails.
//
// Architecture:
//   - A single cron heartbeat fires at 09:00 IST every day (the earliest any tenant fires)
//   - For each tenant, the heartbeat checks whether TODAY matches that tenant's reminder schedule
//   - If it matches, overdue quotes are grouped per creator and ONE email is sent per creator
//   - remindersSent[] on each Quotation prevents duplicate sends within the same cycle
//
// Per-tenant schedule (set in Admin → Manage Tenant → Settings → Reminder Settings):
//   frequency        : 'daily' | 'weekly' | 'monthly'
//   dayOfWeek        : 0–6 (0=Sun, 1=Mon … 6=Sat) — weekly only
//   dayOfMonth       : 1–28                         — monthly only
//   timeHour         : 0–23 IST                     — not enforced by cron (heartbeat fires at 09:00)
//                      Used as a display label for the admin. True time control = cron schedule.
//   overdueWindowDays: how many days past followUpDate to keep sending reminders (default 21)
//   isActive         : false = paused for this tenant
//
// Default for new tenants: weekly on Monday, 9 AM IST.
//
// Test trigger:
//   POST /api/admin/test-reminder-job  (super admin only)
//   Calls runReminderCheck(true) — ignores schedule, processes all active tenants immediately.

const cron                = require('node-cron')
const Quotation           = require('../models/Quotation')
const Tenant              = require('../models/Tenant')
const User                = require('../models/User')
const { sendReminderEmail } = require('./emailService')

// ── Default reminder settings ─────────────────
// Applied when a tenant has no reminderSettings stored yet (legacy tenants).
const DEFAULT_SETTINGS = {
  isActive:          true,
  frequency:         'weekly',
  dayOfWeek:         1,          // Monday
  dayOfMonth:        1,
  timeHour:          9,
  overdueWindowDays: 21,
}

// ── Should this tenant fire today? ────────────
// Returns true if today's date matches the tenant's configured schedule.
// forceFire = true bypasses the schedule check (used by the test trigger).
const shouldFireToday = (settings, forceFire = false) => {
  if (forceFire) return true
  if (!settings.isActive) return false

  const now        = new Date()
  const todayDow   = now.getDay()    // 0=Sun … 6=Sat
  const todayDate  = now.getDate()   // 1–31
  const frequency  = settings.frequency || 'weekly'

  if (frequency === 'daily')   return true
  if (frequency === 'weekly')  return todayDow === (settings.dayOfWeek ?? 1)
  if (frequency === 'monthly') return todayDate === (settings.dayOfMonth ?? 1)
  return false
}

// ── Core logic — one tenant ───────────────────
// Finds all overdue quotations for a tenant, groups them by creator email,
// and sends ONE reminder email per creator.
// Returns a summary object for logging / API response.
const processOneTenant = async (tenant, forceFire = false) => {
  const settings = { ...DEFAULT_SETTINGS, ...(tenant.reminderSettings || {}) }

  if (!forceFire && !settings.isActive) {
    return { tenantId: tenant.tenantId, skipped: true, reason: 'reminders disabled' }
  }

  if (!shouldFireToday(settings, forceFire)) {
    return { tenantId: tenant.tenantId, skipped: true, reason: 'not scheduled today' }
  }

  const now     = new Date()
  const today   = new Date(now.getFullYear(), now.getMonth(), now.getDate())
  const cutoff  = new Date(today.getTime() - settings.overdueWindowDays * 24 * 60 * 60 * 1000)
  const todayStr = today.toISOString().split('T')[0]

  const overdue = await Quotation.find({
    tenantId:     tenant.tenantId,
    status:       { $in: ['Sent', 'In Progress'] },
    followUpDate: { $lt: today, $gte: cutoff },
  })

  if (overdue.length === 0) {
    return { tenantId: tenant.tenantId, skipped: false, processed: 0, emailsSent: 0 }
  }

  // Filter out quotes already reminded today
  const eligible = overdue.filter(q =>
    !(q.remindersSent && q.remindersSent.includes(todayStr))
  )

  if (eligible.length === 0) {
    return { tenantId: tenant.tenantId, skipped: false, processed: 0, emailsSent: 0,
             note: 'all already reminded today' }
  }

  // ── Group by creator email ────────────────
  const byEmail = {}   // { email: { userName, quotes: [quotation...] } }

  for (const q of eligible) {
    let recipientEmail = q.creatorEmail || null
    let recipientName  = q.createdByName || null

    if (!recipientEmail && q.createdBy) {
      try {
        const creator = await User.findById(q.createdBy).select('email firstName lastName').lean()
        if (creator) {
          recipientEmail = creator.email
          recipientName  = `${creator.firstName} ${creator.lastName}`
        }
      } catch {
        console.warn(`[Reminder] Could not find user for quotation ${q.quoteNumber}`)
      }
    }

    if (!recipientEmail) {
      console.warn(`[Reminder] No recipient email for ${q.quoteNumber} — skipping`)
      continue
    }

    if (!byEmail[recipientEmail]) {
      byEmail[recipientEmail] = { userName: recipientName, quotes: [] }
    }

    byEmail[recipientEmail].quotes.push({
      quoteId:      q._id,
      quoteNumber:  q.quoteNumber || '—',
      customerName: q.customer?.companyName || '—',
      followUpDate: q.followUpDate,
      status:       q.status,
    })
  }

  // ── Send one email per creator, mark quotes ────
  let emailsSent = 0
  const tenantName = tenant.companyName || tenant.tenantId

  for (const [email, { quotes }] of Object.entries(byEmail)) {
    const result = await sendReminderEmail({ to: email, quotes, tenantName })

    // Mark remindersSent on each quote in this batch — even if SMTP not configured,
    // so the test trigger does not flood when SMTP is off.
    if (result.sent || result.reason === 'SMTP not configured') {
      const quoteIds = quotes.map(q => q.quoteId)
      await Quotation.updateMany(
        { _id: { $in: quoteIds } },
        { $addToSet: { remindersSent: todayStr } }
      )
    }

    if (result.sent) emailsSent++
  }

  return {
    tenantId:   tenant.tenantId,
    skipped:    false,
    processed:  eligible.length,
    emailsSent,
  }
}

// ── Main entry point ──────────────────────────
// Called by the cron job and by the admin test trigger.
//
// forceFire = true     → bypass per-tenant schedule check (used by test trigger)
// tenantId  = string   → scope to ONE tenant only (used by admin "Run Now" button)
// tenantId  = null     → process ALL active tenants (used by cron heartbeat)
const runReminderCheck = async (forceFire = false, tenantId = null) => {
  const label = forceFire ? '[Reminder:TEST]' : '[Reminder]'
  const scope = tenantId ? `tenant: ${tenantId}` : 'all tenants'
  console.log(`${label} Starting reminder check (${scope})...`)

  try {
    // Scope query to one tenant when tenantId is provided
    const query = { isActive: true }
    if (tenantId) query.tenantId = tenantId

    const tenants = await Tenant.find(query)

    if (tenantId && tenants.length === 0) {
      throw new Error(`Tenant '${tenantId}' not found or is inactive`)
    }

    console.log(`${label} Processing ${tenants.length} active tenant(s)`)

    const results = []
    for (const tenant of tenants) {
      const result = await processOneTenant(tenant, forceFire)
      results.push(result)

      if (result.skipped) {
        console.log(`${label} [${tenant.tenantId}] Skipped — ${result.reason}`)
      } else {
        console.log(`${label} [${tenant.tenantId}] Processed ${result.processed} quote(s), sent ${result.emailsSent} email(s)`)
      }
    }

    console.log(`${label} Done.`)
    return results
  } catch (err) {
    console.error(`${label} Error during reminder check:`, err.message)
    throw err
  }
}

// ── Start the cron heartbeat ──────────────────
// Fires at 09:00 IST every day — the earliest time any tenant is configured to send.
// Each tenant's schedule is checked inside runReminderCheck → processOneTenant.
const startReminderJob = () => {
  console.log('[Reminder] Scheduling daily heartbeat at 09:00 IST')

  cron.schedule('0 9 * * *', () => {
    runReminderCheck(false)
  }, {
    timezone: 'Asia/Kolkata',
  })

  console.log('[Reminder] Reminder job scheduled ✅')
}

module.exports = { startReminderJob, runReminderCheck }
