// analyticsRoutes.js — QuoteX analytics routes.
// Mounted at /api/quotex/analytics in index.js
//
// v8 change: requireFeature('quotex', 'analytics') removed.
// Dashboard is now visible to ALL users regardless of licence tier.

const express  = require('express')
const router   = express.Router()
const { protect } = require('../../middleware/auth')
const { getAnalytics, getCustomersForFilter, getFxRates } = require('../../controllers/analyticsController')

// All authenticated users can access analytics — no feature gate
router.get('/',         protect, getAnalytics)

// FX rates proxy — fetches from Frankfurter server-side to avoid browser CORS
// Cached server-side for 6 hours — safe to call on every dashboard load
router.get('/fx-rates',  protect, getFxRates)

// Returns distinct customers for the dashboard customer filter dropdown
router.get('/customers', protect, getCustomersForFilter)

module.exports = router
