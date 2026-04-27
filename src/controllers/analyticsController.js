// analyticsController.js — QuoteX dashboard analytics.
//
// Available to ALL authenticated users — no licence gate (removed in v8).
//
// ── Query parameters accepted ────────────────────────────────────
//   from          ISO date string  e.g. 2026-01-01
//   to            ISO date string  e.g. 2026-12-31
//   customerIds   comma-separated customer _ids  (empty = all)
//
// ── Future-proof (ignored until roles/teams are built) ───────────
//   userIds       comma-separated user _ids
//   teamIds       comma-separated team _ids
//
// ── Endpoints ────────────────────────────────────────────────────
//   GET /api/quotex/analytics            → getAnalytics
//   GET /api/quotex/analytics/customers  → getCustomersForFilter

const Quotation = require('../models/Quotation')
const mongoose  = require('mongoose')
const { getSubtreeUserIds } = require('./teamController')

const MONTH_NAMES = ['Jan','Feb','Mar','Apr','May','Jun',
                     'Jul','Aug','Sep','Oct','Nov','Dec']

// ── Server-side FX rate cache ─────────────────────────────────────
// Rates are fetched from Frankfurter once and cached for 6 hours.
// This means a VPS restart fetches fresh rates immediately,
// and subsequent dashboard loads within 6 hours use the cache.
// Cache is module-level — shared across all requests to this controller.
const FX_CACHE = {
  rates:     null,   // { USD: 1, EUR: 0.93, INR: 83.5, ... }
  fetchedAt: null,   // Date — when the cache was last populated
  TTL_MS:    6 * 60 * 60 * 1000,   // 6 hours in milliseconds
}

const isCacheValid = () =>
  FX_CACHE.rates &&
  FX_CACHE.fetchedAt &&
  (Date.now() - FX_CACHE.fetchedAt) < FX_CACHE.TTL_MS

// ── Build base $match filter (async — resolves team subtree) ──────
// Single function so every pipeline uses identical filtering.
// Handles role-based scoping: individual / team_lead / isTenantAdmin.
// viewUserId query param: lead drilling down to a specific member.
const buildBaseFilter = async (tenantId, query, user) => {
  const { from, to, customerIds, viewUserId } = query
  const filter = { tenantId }

  if (from || to) {
    filter.createdAt = {}
    if (from) filter.createdAt.$gte = new Date(from)
    if (to) {
      const toDate = new Date(to)
      toDate.setHours(23, 59, 59, 999)
      filter.createdAt.$lte = toDate
    }
  }

  if (customerIds) {
    const names = customerIds.split('|||').filter(Boolean)
    if (names.length > 0) {
      filter['customer.companyName'] = { $in: names }
    }
  }

  // viewUserId is an explicit override — always applied when present,
  // regardless of the user's role or admin status.
  // This lets tenant admins and team leads drill into a specific member's data.
  if (viewUserId) {
    filter.createdBy = viewUserId
  } else if (user && !user.isTenantAdmin && user.role !== 'super_admin') {
    // No explicit member selected — apply role-based default scoping
    if (user.role === 'team_lead') {
      const subtree = await getSubtreeUserIds(user._id, tenantId)
      filter.createdBy = { $in: [...subtree].map(id => id.toString()) }
    } else {
      // individual — own quotes only
      filter.createdBy = user._id.toString()
    }
    // isTenantAdmin without viewUserId → no createdBy filter → sees all tenant data
  }

  // Debug log — remove once filtering confirmed working
  console.log('[Analytics] buildBaseFilter createdBy:', JSON.stringify(filter.createdBy || 'all (no scope)'))
  return filter
}

// ════════════════════════════════════════════════════════════════
// ENDPOINT 1 — Main analytics (all 8 dashboard widgets)
// GET /api/quotex/analytics
// All aggregations run in parallel via Promise.all for performance.
// ════════════════════════════════════════════════════════════════
const getAnalytics = async (req, res) => {
  try {
    const tenantId   = req.user.tenantId
    const baseFilter = await buildBaseFilter(tenantId, req.query, req.user)

    const [
      totalQuotations,
      statusAgg,
      monthlyAgg,
      allStatusMonthlyAgg,
      speedAgg,
      lossReasonsAgg,
      topWinsAgg,
      topLossesAgg,
    ] = await Promise.all([

      // 1. Total quote count in period
      Quotation.countDocuments(baseFilter),

      // 2. Count + value per status, grouped by currency
      Quotation.aggregate([
        { $match: baseFilter },
        { $group: {
          _id:        { status: '$status', currency: { $ifNull: ['$currency', 'N/A'] } },
          count:      { $sum: 1 },
          totalValue: { $sum: '$grandTotal' },
        }},
      ]),

      // 3. Per-status per-month (for trend chart with status filter)
      Quotation.aggregate([
        { $match: baseFilter },
        { $group: {
          _id: {
            year:   { $year:  '$createdAt' },
            month:  { $month: '$createdAt' },
            status: '$status',
          },
          count:      { $sum: 1 },
          totalValue: { $sum: '$grandTotal' },
        }},
        { $sort: { '_id.year': 1, '_id.month': 1 } },
      ]),

      // 4. All-status monthly totals (for the "All" line in trend chart)
      Quotation.aggregate([
        { $match: baseFilter },
        { $group: {
          _id: {
            year:  { $year:  '$createdAt' },
            month: { $month: '$createdAt' },
          },
          count:      { $sum: 1 },
          totalValue: { $sum: '$grandTotal' },
        }},
        { $sort: { '_id.year': 1, '_id.month': 1 } },
      ]),

      // 5. Conversion speed histogram
      // Days between createdAt and updatedAt for closed quotes
      // Bucketed into 6 ranges for the histogram chart
      Quotation.aggregate([
        { $match: { ...baseFilter, status: { $in: ['Awarded', 'Not Awarded'] } } },
        { $addFields: {
          daysToClose: {
            $divide: [{ $subtract: ['$updatedAt', '$createdAt'] }, 86400000],
          },
        }},
        { $addFields: {
          bucket: {
            $switch: {
              branches: [
                { case: { $lte: ['$daysToClose', 7]  }, then: '0-7d'   },
                { case: { $lte: ['$daysToClose', 14] }, then: '8-14d'  },
                { case: { $lte: ['$daysToClose', 30] }, then: '15-30d' },
                { case: { $lte: ['$daysToClose', 60] }, then: '31-60d' },
                { case: { $lte: ['$daysToClose', 90] }, then: '61-90d' },
              ],
              default: '90d+',
            },
          },
        }},
        { $group: {
          _id:          '$bucket',
          count:        { $sum: 1 },
          avgDays:      { $avg: '$daysToClose' },
          awardedCount: { $sum: { $cond: [{ $eq: ['$status', 'Awarded'] }, 1, 0] } },
        }},
      ]),

      // 6. Loss reasons — top 10 by frequency (Pareto)
      Quotation.aggregate([
        { $match: { ...baseFilter, status: 'Not Awarded',
                    reasonForLoss: { $exists: true, $ne: '' } } },
        { $group: { _id: '$reasonForLoss', count: { $sum: 1 } } },
        { $sort: { count: -1 } },
        { $limit: 10 },
      ]),

      // 7. Top 5 wins by value
      Quotation.find({ ...baseFilter, status: 'Awarded' })
        .sort({ grandTotal: -1 })
        .limit(5)
        .select('quoteNumber customer.companyName grandTotal currency createdAt updatedAt')
        .lean(),

      // 8. Top 5 losses by value
      Quotation.find({ ...baseFilter, status: 'Not Awarded' })
        .sort({ grandTotal: -1 })
        .limit(5)
        .select('quoteNumber customer.companyName grandTotal currency reasonForLoss createdAt updatedAt')
        .lean(),
    ])

    // ── Status map — handles multi-currency grouping ────────────────
    // statusMap[status] = { count, byCurrency: { USD: 1000, INR: 50000, ... } }
    const statusMap = {}
    statusAgg.forEach(s => {
      const status   = s._id.status
      const currency = s._id.currency || 'N/A'
      if (!statusMap[status]) statusMap[status] = { count: 0, byCurrency: {} }
      statusMap[status].count += s.count
      statusMap[status].byCurrency[currency] =
        (statusMap[status].byCurrency[currency] || 0) + (s.totalValue || 0)
    })

    const awarded    = statusMap['Awarded']?.count    || 0
    const notAwarded = statusMap['Not Awarded']?.count || 0
    const resolved   = awarded + notAwarded
    const winRate    = resolved > 0 ? Math.round((awarded / resolved) * 100) : 0

    // Helper: merge all byCurrency maps across statuses into one total map
    const mergeCurrencies = (...maps) => {
      const merged = {}
      maps.forEach(m => {
        if (!m) return
        Object.entries(m).forEach(([cur, val]) => {
          merged[cur] = (merged[cur] || 0) + val
        })
      })
      return merged
    }
    const totalByCurrency = mergeCurrencies(
      ...Object.values(statusMap).map(s => s.byCurrency)
    )

    // Weighted average days to close across all buckets
    const avgDaysToClose = (() => {
      if (!speedAgg.length) return null
      const totalQ   = speedAgg.reduce((s, b) => s + b.count, 0)
      const weighted = speedAgg.reduce((s, b) => s + (b.avgDays * b.count), 0)
      return totalQ > 0 ? Math.round(weighted / totalQ) : null
    })()

    // Status breakdown cards — one entry per status in pipeline order
    const statusBreakdown = ['Draft','Sent','In Progress','Awarded','Not Awarded'].map(statusName => ({
      status:     statusName,
      count:      statusMap[statusName]?.count      || 0,
      byCurrency: statusMap[statusName]?.byCurrency || {},
    }))

    // ── Monthly trend ─────────────────────────────────────────────
    // Build month slots from all-status aggregation
    const monthMap = {}
    allStatusMonthlyAgg.forEach(item => {
      const key = `${item._id.year}-${String(item._id.month).padStart(2,'0')}`
      monthMap[key] = {
        month:      `${MONTH_NAMES[item._id.month - 1]} ${item._id.year}`,
        sortKey:    key,
        total:      item.count,
        totalValue: item.totalValue || 0,
      }
    })
    // Layer per-status counts into month slots
    monthlyAgg.forEach(item => {
      const key    = `${item._id.year}-${String(item._id.month).padStart(2,'0')}`
      const status = item._id.status
      if (!monthMap[key]) return
      monthMap[key][status]           = (monthMap[key][status] || 0) + item.count
      monthMap[key][`${status}Value`] = (monthMap[key][`${status}Value`] || 0) + (item.totalValue || 0)
    })
    const monthlyChartData = Object.values(monthMap)
      .sort((a, b) => a.sortKey.localeCompare(b.sortKey))
      .map(({ sortKey, ...rest }) => rest)

    // ── Speed histogram ───────────────────────────────────────────
    const BUCKET_ORDER = ['0-7d','8-14d','15-30d','31-60d','61-90d','90d+']
    const BUCKET_LABELS = {
      '0-7d':'0–7 days','8-14d':'8–14 days','15-30d':'15–30 days',
      '31-60d':'31–60 days','61-90d':'61–90 days','90d+':'90+ days',
    }
    const speedMap = {}
    speedAgg.forEach(b => { speedMap[b._id] = b })
    const speedHistogram = BUCKET_ORDER.map(key => ({
      range:        BUCKET_LABELS[key],
      count:        speedMap[key]?.count        || 0,
      awardedCount: speedMap[key]?.awardedCount || 0,
    }))

    // ── Pareto ────────────────────────────────────────────────────
    const totalLosses = lossReasonsAgg.reduce((s, r) => s + r.count, 0)
    let cumulative = 0
    const paretoData = lossReasonsAgg.map(r => {
      cumulative += r.count
      return {
        reason: r._id,
        count:  r.count,
        cumulativePercent: totalLosses > 0
          ? Math.round((cumulative / totalLosses) * 100) : 0,
      }
    })

    // ── Top 5 formatter ───────────────────────────────────────────
    const fmt = q => ({
      quoteNumber: q.quoteNumber,
      customer:    q.customer?.companyName || '—',
      value:       q.grandTotal || 0,
      currency:    q.currency || '',
      reason:      q.reasonForLoss || '',
      createdAt:   q.createdAt,
      closedAt:    q.updatedAt,
    })

    res.status(200).json({
      summary: {
        totalQuotations,
        totalByCurrency,
        awarded,
        awardedByCurrency:    statusMap['Awarded']?.byCurrency     || {},
        notAwarded,
        notAwardedByCurrency: statusMap['Not Awarded']?.byCurrency || {},
        inProgress:           statusMap['In Progress']?.count      || 0,
        inProgressByCurrency: statusMap['In Progress']?.byCurrency || {},
        sent:                 statusMap['Sent']?.count              || 0,
        sentByCurrency:       statusMap['Sent']?.byCurrency        || {},
        draft:                statusMap['Draft']?.count             || 0,
        winRate,
        avgDaysToClose,
      },
      statusBreakdown,
      monthlyChartData,
      speedHistogram,
      paretoData,
      topWins:   topWinsAgg.map(fmt),
      topLosses: topLossesAgg.map(fmt),
    })

  } catch (error) {
    console.error('Analytics error:', error)
    res.status(500).json({ message: 'Failed to fetch analytics', error: error.message })
  }
}

// ════════════════════════════════════════════════════════════════
// ENDPOINT 2 — Customers for filter dropdown
// GET /api/quotex/analytics/customers
// Returns distinct customer names from this tenant's quotations.
// ════════════════════════════════════════════════════════════════
const getCustomersForFilter = async (req, res) => {
  try {
    const tenantId = req.user.tenantId
    const customers = await Quotation.aggregate([
      { $match: { tenantId } },
      { $group: {
        _id: '$customer.companyName',   // group by name — avoids ObjectId casting issues
      }},
      { $match: { _id: { $nin: [null, ''] } } },  // $nin avoids duplicate-key issue
      { $sort:  { _id: 1 } },
      { $project: { _id: 0, companyName: '$_id' } },
    ])
    res.status(200).json({ customers })
  } catch (error) {
    console.error('Customer filter error:', error)
    res.status(500).json({ message: 'Failed to fetch customers', error: error.message })
  }
}

// ════════════════════════════════════════════════════════════════
// ENDPOINT 3 — FX Rates proxy
// GET /api/quotex/analytics/fx-rates
//
// Fetches live rates from Frankfurter (ECB data) server-side and
// returns them to the browser. Proxying avoids browser CORS issues
// because server-to-server calls are not subject to CORS policy.
//
// Response: { rates: { USD: 1, EUR: 0.93, INR: 83.5, ... }, cached: bool }
//
// Cache: rates are cached for 6 hours server-side to avoid hammering
// the Frankfurter API on every dashboard load. Cache resets on server restart.
// ════════════════════════════════════════════════════════════════
const getFxRates = async (req, res) => {
  // Return cached rates if still valid
  if (isCacheValid()) {
    console.log('[FX Rates] Returning cached rates (age:',
      Math.round((Date.now() - FX_CACHE.fetchedAt) / 60000), 'min)')
    return res.status(200).json({ rates: FX_CACHE.rates, cached: true })
  }

  // Fetch rates using Node's built-in fetch (Node 18+).
  // Unlike https.request, fetch follows redirects automatically — solving
  // the 301 redirect issue from Frankfurter with zero extra code.
  // Your package.json shows Node v22 so this is fully supported.
  const fetchFromFrankfurter = async () => {
    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(), 10000)
    try {
      const resp = await fetch('https://api.frankfurter.dev/v1/latest?base=USD', {
        signal:  controller.signal,
        headers: { 'Accept': 'application/json', 'User-Agent': 'Arc/1.0' },
        redirect: 'follow',   // explicit — follow all 3xx automatically
      })
      if (!resp.ok) throw new Error(`Frankfurter returned HTTP ${resp.status}`)
      return await resp.json()
    } finally {
      clearTimeout(timer)
    }
  }

  try {
    console.log('[FX Rates] Fetching fresh rates from Frankfurter...')
    const data = await fetchFromFrankfurter()

    if (!data.rates || typeof data.rates !== 'object') {
      throw new Error('Unexpected response format from Frankfurter')
    }

    // Frankfurter omits the base (USD) — add it manually
    const rates = { USD: 1, ...data.rates }

    // Update cache
    FX_CACHE.rates     = rates
    FX_CACHE.fetchedAt = Date.now()

    console.log('[FX Rates] Rates fetched and cached. Currencies:', Object.keys(rates).length)
    res.status(200).json({ rates, cached: false })

  } catch (err) {
    // ── Structured failure log ────────────────────────────────────
    // This log format makes it easy to grep in production:
    //   grep "EXTERNAL_API_FAILURE" server.log
    // Tells admin: which API failed, why, and when.
    console.error(JSON.stringify({
      level:     'ERROR',
      event:     'EXTERNAL_API_FAILURE',
      api:       'Frankfurter FX Rates',
      url:       'https://api.frankfurter.dev/v1/latest?base=USD',
      reason:    err.message,
      action:    FX_CACHE.rates ? 'serving stale cache' : 'returning 503',
      timestamp: new Date().toISOString(),
    }))

    // Stale cache fallback — better than nothing for users
    if (FX_CACHE.rates) {
      return res.status(200).json({
        rates:  FX_CACHE.rates,
        cached: true,
        stale:  true,
        note:   'Rates may be outdated — live fetch failed: ' + err.message,
      })
    }

    // No cache — Dashboard shows "rates unavailable" banner gracefully
    res.status(503).json({
      message: 'Exchange rates temporarily unavailable',
      detail:  err.message,
    })
  }
}

// ── External connectivity test ────────────────────────────────────
// Called by /api/health/external to verify Frankfurter is reachable.
// Returns { ok: bool, latencyMs: number, error: string|null }
const testFrankfurterConnectivity = async () => {
  const start = Date.now()
  try {
    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(), 8000)
    const resp = await fetch('https://api.frankfurter.dev/v1/latest?base=USD', {
      signal: controller.signal, redirect: 'follow',
      headers: { 'Accept': 'application/json' },
    })
    clearTimeout(timer)
    return { ok: resp.ok, latencyMs: Date.now() - start, statusCode: resp.status, error: null }
  } catch (err) {
    return { ok: false, latencyMs: Date.now() - start, statusCode: null, error: err.message }
  }
}

module.exports = { getAnalytics, getCustomersForFilter, getFxRates, testFrankfurterConnectivity }
