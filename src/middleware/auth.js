// auth.js — Authentication and authorisation middleware.
// Three middleware functions in one file:
//
// 1. protect      — verifies JWT token (authentication)
// 2. requireRole  — checks user role (authorisation)
// 3. requireFeature — checks licence (licence verification)
//
// These are used as "guards" on routes like this:
// router.get('/analytics', protect, requireFeature('analytics'), getAnalytics)
// That means: verify token → check licence → then run getAnalytics

const jwt    = require('jsonwebtoken')
const User   = require('../models/User')
const Tenant = require('../models/Tenant')

// ── MIDDLEWARE 1 — protect ────────────────────
// Verifies the JWT token on every protected request.
// If valid, attaches the full user object to req.user
// so controllers can access it without another DB query.
//
// The token is sent in the Authorization header like this:
// Authorization: Bearer eyJhbGciOiJIUzI1NiIs...
// "Bearer" is just a standard prefix — the token comes after it.

const protect = async (req, res, next) => {
  try {
    // ── Step 1 — Extract token from header ────
    const authHeader = req.headers.authorization

    if (!authHeader || !authHeader.startsWith('Bearer ')) {
      return res.status(401).json({
        message: 'Access denied. No token provided. Please log in.',
      })
    }

    // Remove "Bearer " prefix to get just the token string
    const token = authHeader.split(' ')[1]

    // ── Step 2 — Verify the token ─────────────
    // jwt.verify checks the signature and expiry.
    // If the token was tampered with or expired it throws an error.
    let decoded
    try {
      decoded = jwt.verify(token, process.env.JWT_SECRET)
    } catch (jwtError) {
      if (jwtError.name === 'TokenExpiredError') {
        return res.status(401).json({
          message: 'Your session has expired. Please log in again.',
        })
      }
      return res.status(401).json({
        message: 'Invalid token. Please log in again.',
      })
    }

    // ── Step 3 — Fetch fresh user from DB ─────
    // We fetch the user from the database rather than
    // trusting the token data entirely.
    // This catches cases where:
    // - The user was deactivated after the token was issued
    // - The user's role or licence was changed by an admin
    const user = await User.findById(decoded.userId)

    if (!user) {
      return res.status(401).json({
        message: 'User no longer exists. Please log in again.',
      })
    }

    if (!user.isActive) {
      return res.status(403).json({
        message: 'Your account has been deactivated. Contact your administrator.',
      })
    }

    // ── Check tenant is active ─────────────────
    // Blocks API calls for users whose tenant has been deactivated
    // even if they already hold a valid JWT token.
    // super_admin has no tenant record — skip.
    if (user.role !== 'super_admin') {
      const tenant = await Tenant.findOne({ tenantId: user.tenantId }).select('isActive')
      if (!tenant || !tenant.isActive) {
        return res.status(403).json({
          message: 'Your organisation account is currently inactive. Please contact support.',
        })
      }
    }

    // ── Step 4 — Attach user to request ───────
    // Every controller after this middleware can access
    // the logged-in user via req.user
    req.user = user

    // Pass control to the next middleware or controller
    next()

  } catch (error) {
    console.error('Auth middleware error:', error)
    res.status(500).json({
      message: 'Authentication error',
      error: error.message,
    })
  }
}

// ── MIDDLEWARE 2 — requireRole ────────────────
// Checks that the logged-in user has one of the allowed roles.
// Must be used AFTER protect middleware.
//
// Usage example:
// router.delete('/users/:id', protect, requireRole('admin'), deleteUser)
// Only admins can delete users.
//
// Pass multiple roles to allow any of them:
// requireRole('admin', 'group_lead')

const requireRole = (...allowedRoles) => {
  return (req, res, next) => {
    // req.user is set by the protect middleware above
    if (!req.user) {
      return res.status(401).json({ message: 'Not authenticated' })
    }

    if (!allowedRoles.includes(req.user.role)) {
      return res.status(403).json({
        message: `Access denied. This action requires one of these roles: ${allowedRoles.join(', ')}`,
        yourRole: req.user.role,
      })
    }

    next()
  }
}

// ── MIDDLEWARE 3 — requireFeature ─────────────
// Updated to check per-tool licence features.
// Usage: requireFeature('quotex', 'analytics')
// Checks if user's quotex tool licence includes a feature.

const requireFeature = (toolCode, feature) => {
  // Single-argument call: requireFeature('analytics') → defaults to quotex tool
  if (!feature) {
    feature  = toolCode
    toolCode = 'quotex'
  }

  return (req, res, next) => {
    if (!req.user) {
      return res.status(401).json({ message: 'Not authenticated' })
    }

    if (!req.user.hasToolFeature(toolCode, feature)) {
      return res.status(403).json({
        message:        `Your licence for ${toolCode.toUpperCase()} Tool does not include: ${feature}`,
        tool:           toolCode,
        requiredFeature: feature,
        upgradeMessage: 'Please contact your administrator to upgrade your licence.',
      })
    }

    next()
  }
}

// ── MIDDLEWARE 5 — requireTool ─────────────────
// Checks user has access to a specific tool at all.
// Used at the route level to block access to entire tool.
// e.g. router.use(protect, requireTool('quotex'))

const requireTool = (toolCode) => {
  return (req, res, next) => {
    if (!req.user) {
      return res.status(401).json({ message: 'Not authenticated' })
    }

    if (!req.user.hasTool(toolCode)) {
      return res.status(403).json({
        message: `You do not have access to the ${toolCode.toUpperCase()} Tool.`,
        tool:    toolCode,
      })
    }

    next()
  }
}


// ── MIDDLEWARE 4 — requireSuperAdmin ──────────
// Blocks access to super admin routes for all non-super_admin users.
// Used on all /api/admin/* routes.
// Think of it like a master key —
// only the building owner has it, not the tenants.

const requireSuperAdmin = (req, res, next) => {
  if (!req.user) {
    return res.status(401).json({ message: 'Not authenticated' })
  }

  if (req.user.role !== 'super_admin') {
    return res.status(403).json({
      message: 'Access denied. This area is restricted to system administrators.',
    })
  }

  next()
}

module.exports = {
  protect,
  requireRole,
  requireFeature,
  requireSuperAdmin,
  requireTool,
}
