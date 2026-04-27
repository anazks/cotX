const express  = require('express')
const router   = express.Router()
const { protect } = require('../middleware/auth')
const { register, login, getMe, forgotPassword, changePassword, refreshToken, logoutUser, contactEnquiry } = require('../controllers/authController')
const { confirmTenantDeletion } = require('../controllers/adminController')

// Forgot password — generates temp password, returns it (no email service yet)
router.post('/forgot-password', forgotPassword)

// Change password — requires valid token (logged in user changing their own password)
router.post('/change-password', protect, changePassword)
router.post('/register', register)
router.post('/login',    login)

// /me requires a valid token — uses protect middleware
router.get('/me', protect, getMe)

// Refresh access token — called silently by api.js when access token expires (401)
// No protect middleware — this is how a new access token is obtained without one
router.post('/refresh', refreshToken)

// Logout — deletes refresh token from DB, invalidating the session server-side
// No protect middleware — works even if access token has already expired
router.post('/logout', logoutUser)

// Contact enquiry — public route, no auth needed. Forwards form to archana.n@sunserk.com
router.post('/contact', contactEnquiry)

// ── Tenant deletion confirmation (public, token-based) ────────────
// Super admin clicks the link in the deletion request email.
// No auth header needed — the one-time token in the query string is the credential.
// Token expires after 24h. On success, ALL tenant data is permanently deleted.
router.get('/confirm-deletion', confirmTenantDeletion)

module.exports = router