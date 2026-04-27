// teamRoutes.js — Team hierarchy routes for QuoteX.
// Mounted at /api/quotex/teams in index.js
//
// All routes require:
//   protect         — valid JWT
//   requireTenantAdmin — isTenantAdmin: true on the user (for write operations)
//   getTeams and getSubtree are readable by all authenticated users in the tenant.

const express = require('express')
const router  = express.Router()
const { protect } = require('../../middleware/auth')
const {
  getTeams,
  getTenantUsers,
  createTeam,
  updateTeam,
  deleteTeam,
  getSubtreeEndpoint,
} = require('../../controllers/teamController')

// ── Middleware — Tenant Admin check ───────────────────────────
// Only users with isTenantAdmin: true can create/modify teams.
// Read operations (getTeams, getSubtree) are open to all tenant users.
const requireTenantAdmin = (req, res, next) => {
  if (!req.user?.isTenantAdmin && req.user?.role !== 'super_admin') {
    return res.status(403).json({
      message: 'Team management requires tenant admin access.',
    })
  }
  next()
}

// ── Read routes — all authenticated users ─────────────────────
router.get('/',                  protect, getTeams)
router.get('/members',           protect, getTenantUsers)
router.get('/subtree/:userId',   protect, getSubtreeEndpoint)
router.get('/subtree',           protect, getSubtreeEndpoint)  // own subtree (no userId)

// ── Write routes — tenant admin only ─────────────────────────
router.post('/',                 protect, requireTenantAdmin, createTeam)
router.put('/:id',               protect, requireTenantAdmin, updateTeam)
router.delete('/:id',            protect, requireTenantAdmin, deleteTeam)

module.exports = router
