// index.js — Arc API server entry point.
// Route structure:
//   /api/auth/*              — platform authentication
//   /api/admin/*             — platform administration (super admin)
//   /api/customers/*         — platform shared: customer master (all tools)
//   /api/parts/*             — platform shared: parts master (all tools)
//   /api/quotex/quotations/* — QuoteX tool: quotation documents
//   /api/quotex/pdf/*        — QuoteX tool: PDF generation
//   /api/quotex/analytics/*  — QuoteX tool: analytics dashboard
//
// Future tools follow same pattern:
//   /api/negohelp/*          — NegoHelp tool routes

const path = require('path')
const express = require('express')
const mongoose = require('mongoose')
const cors = require('cors')

// Load .env from the same directory as this file (server/)
// Using __dirname makes this work regardless of where `node` is invoked from.
require('dotenv').config({ path: path.join(__dirname, '.env') })

const app = express()

// ── CORS ──────────────────────────────────────
app.use(cors())

const ALLOWED_ORIGIN = process.env.FRONTEND_URL || 'https://cot-xui.vercel.app'

app.use((req, res, next) => {
  res.header('Access-Control-Allow-Origin', ALLOWED_ORIGIN)
  res.header('Access-Control-Allow-Methods', 'GET, POST, PUT, DELETE, PATCH, OPTIONS')
  res.header('Access-Control-Allow-Headers', 'Content-Type, Authorization')
  if (req.method === 'OPTIONS') return res.status(200).end()
  next()
})

// ── Body parsing ──────────────────────────────
// 25mb limit for base64 file uploads (logos, templates)
app.use(express.json({ limit: '25mb' }))
app.use(express.urlencoded({ extended: true, limit: '25mb' }))

// ── Platform-level routes ─────────────────────
const authRoutes = require('./src/routes/authRoutes')
const adminRoutes = require('./src/routes/adminRoutes')
const customerRoutes = require('./src/routes/customerRoutes')
const partRoutes = require('./src/routes/partRoutes')

app.use('/api/auth', authRoutes)
app.use('/api/admin', adminRoutes)
app.use('/api/customers', customerRoutes)
app.use('/api/parts', partRoutes)

// ── QuoteX tool routes ────────────────────────
const quotationRoutes = require('./src/routes/quotex/quotationRoutes')
const pdfRoutes = require('./src/routes/quotex/pdfRoutes')
const analyticsRoutes = require('./src/routes/quotex/analyticsRoutes')
const teamRoutes = require('./src/routes/quotex/teamRoutes')

app.use('/api/quotex/quotations', quotationRoutes)
app.use('/api/quotex/pdf', pdfRoutes)
app.use('/api/quotex/analytics', analyticsRoutes)
app.use('/api/quotex/teams', teamRoutes)

// ── Future tool routes added here ────────────
// const negoRoutes = require('./src/routes/negohelp/negoRoutes')
// app.use('/api/negohelp', negoRoutes)

// ── Health check ──────────────────────────────
// Used by uptime monitoring tools (UptimeRobot etc.) to verify the server is up.
// No auth required — must always respond, even if DB is slow.
// Returns 200 with server status and timestamp.
app.get('/api/health', (req, res) => {
  res.status(200).json({
    status: 'ok',
    service: 'Arc API',
    timestamp: new Date().toISOString(),
    uptime: Math.floor(process.uptime()) + 's',
  })
})

app.get('/', (req, res) => {
  res.send('Arc API is running ✅')
})

// ── External dependency health check ─────────────────────────────
// GET /api/health/external  (super admin only in production — open here for simplicity)
//
// Checks all external APIs and SMTP in real time.
// Use this to diagnose "something stopped working" before users report it.
//
// Response shape:
// {
//   allHealthy: bool,
//   checks: {
//     frankfurter: { ok, latencyMs, statusCode, error },
//     smtp:         { ok, configured, error },
//   },
//   timestamp: ISO string
// }
app.get('/api/health/external', async (req, res) => {
  try {
    const { testFrankfurterConnectivity } = require('./src/controllers/analyticsController')
    const { testSmtpConnectivity } = require('./src/jobs/emailService')

    // Run both checks in parallel
    const [frankfurter, smtp] = await Promise.all([
      testFrankfurterConnectivity(),
      testSmtpConnectivity(),
    ])

    const allHealthy = frankfurter.ok && smtp.ok

    // Log result so it appears in server logs regardless of who called it
    if (!allHealthy) {
      console.error(JSON.stringify({
        level: 'WARN',
        event: 'HEALTH_CHECK_FAILED',
        frankfurter,
        smtp,
        timestamp: new Date().toISOString(),
      }))
    }

    res.status(allHealthy ? 200 : 207).json({
      allHealthy,
      checks: { frankfurter, smtp },
      timestamp: new Date().toISOString(),
      note: allHealthy
        ? 'All external dependencies are reachable.'
        : 'One or more external dependencies are unreachable — see checks for details.',
    })
  } catch (err) {
    res.status(500).json({ message: 'Health check failed', error: err.message })
  }
})

// ── Global error handler ──────────────────────
// Must be defined AFTER all routes — Express identifies error handlers
// by their four-argument signature (err, req, res, next).
// Catches any error thrown by a controller that was not caught locally.
// Without this, Express returns an HTML error page — the frontend
// receives HTML when it expects JSON and breaks silently.
app.use((err, req, res, next) => {
  console.error('[Global Error Handler]', err.stack || err.message)

  // Do not expose internal error details in production
  const isDev = process.env.NODE_ENV !== 'production'
  const message = err.message || 'An unexpected error occurred'
  const status = err.status || err.statusCode || 500

  res.status(status).json({
    message,
    ...(isDev ? { stack: err.stack } : {}),
  })
})

// ── Connect to MongoDB then start server ──────
const PORT = process.env.PORT || 5000
const MONGO_URI = process.env.MONGO_URI || 'mongodb://localhost:27017/Arc'

mongoose.connect(MONGO_URI)
  .then(() => {
    console.log('✅ Connected to MongoDB')
    app.listen(PORT, () => {
      console.log(`✅ Arc API running on http://localhost:${PORT}`)
    })

    // Start daily reminder email job (only when SMTP is configured)
    try {
      const { startReminderJob } = require('./src/jobs/reminderJob')
      startReminderJob()
    } catch (err) {
      console.warn('⚠️ Reminder job could not start:', err.message)
    }

    // ── Startup external dependency self-test ─────────────────────
    // Runs 5 seconds after boot to give the server time to settle.
    // Logs a structured warning if any external API is unreachable.
    // Does NOT prevent the server from starting — purely informational.
    setTimeout(async () => {
      try {
        const { testFrankfurterConnectivity } = require('./src/controllers/analyticsController')
        const { testSmtpConnectivity } = require('./src/jobs/emailService')

        const [frankfurter, smtp] = await Promise.all([
          testFrankfurterConnectivity(),
          testSmtpConnectivity(),
        ])

        if (frankfurter.ok) {
          console.log(`✅ Frankfurter FX API reachable (${frankfurter.latencyMs}ms)`)
        } else {
          console.error(JSON.stringify({
            level: 'WARN',
            event: 'EXTERNAL_API_FAILURE',
            api: 'Frankfurter FX Rates',
            url: 'https://api.frankfurter.dev/v1/latest?base=USD',
            reason: frankfurter.error || `HTTP ${frankfurter.statusCode}`,
            action: 'Dashboard will show original currencies until resolved',
            timestamp: new Date().toISOString(),
          }))
        }

        if (smtp.ok) {
          console.log('✅ SMTP reachable — email features active')
        } else if (!smtp.configured) {
          console.warn('⚠️  SMTP not configured — forgot-password and reminder emails disabled')
        } else {
          console.error(JSON.stringify({
            level: 'WARN',
            event: 'EXTERNAL_API_FAILURE',
            api: 'Gmail SMTP',
            host: 'smtp.gmail.com',
            reason: smtp.error,
            action: 'Forgot-password and reminder emails will fail until resolved',
            timestamp: new Date().toISOString(),
          }))
        }
      } catch (err) {
        console.warn('⚠️  Startup self-test failed:', err.message)
      }
    }, 5000)
  })
  .catch((err) => {
    console.error('❌ MongoDB connection failed:', err.message)
  })
