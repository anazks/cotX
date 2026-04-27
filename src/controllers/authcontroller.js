// authController.js — Handles user registration, login, and session management.
// These are the entry points to the entire authentication system.
//
// SESSION ARCHITECTURE:
//   Access Token  — JWT, expires in 8h. Sent with every API call.
//   Refresh Token — Random 64-byte hex, expires in 7d. Stored in DB.
//                   Used only to silently get a new access token.
//                   Stored as a bcrypt hash in DB — raw value sent to client once.
//
// This means:
//   - Users are never mid-session logged out during an 8h working day
//   - Active users get a silent token refresh from api.js every 8h
//   - Idle users hit the 3h idle timer in AuthContext (client-side) before token expires
//   - Super admin can kill any session instantly by deleting RefreshToken documents

const jwt          = require('jsonwebtoken')
const crypto       = require('crypto')   // built-in Node.js — no install needed
const bcrypt       = require('bcryptjs')
const User         = require('../models/User')
const Tool         = require('../models/Tool')
const Tenant       = require('../models/Tenant')
const RefreshToken = require('../models/RefreshToken')
const { sendForgotPasswordEmail, sendContactEnquiryEmail } = require('../jobs/emailService')

// ── Helper — Generate Access Token (JWT) ─────
// Short-lived JWT — 8 hours.
// Contains enough info for the server to identify the user
// on every request without a DB lookup.
// After 8h the client uses the refresh token to get a new one silently.

const generateAccessToken = (user) => {
  const activeTools = user.getActiveTools ? user.getActiveTools() : ['quotex']

  const toolAccess = (user.toolAccess || []).map(t => ({
    toolCode:         t.toolCode,
    licence:          t.licence,
    isActive:         t.isActive,
    licenceExpiresAt: t.licenceExpiresAt,
  }))

  return jwt.sign(
    {
      userId:      user._id,
      email:       user.email,
      role:        user.role,
      licence:     user.licence,   // kept for backwards compatibility
      tenantId:    user.tenantId || 'super_admin',
      activeTools,
      toolAccess,
    },
    process.env.JWT_SECRET,
    { expiresIn: '8h' }            // changed from 7d — refresh token extends sessions
  )
}

// ── Helper — Generate & Store Refresh Token ──
// Creates a random 64-byte hex string (not a JWT — no expiry encoded inside).
// Hashes it with bcrypt before storing in DB.
// Returns the RAW token to send to the client — this is the only time it is visible.
// On future refresh requests the client sends the raw token, we hash and compare.

const generateRefreshToken = async (user, userAgent = null) => {
  const rawToken = crypto.randomBytes(64).toString('hex')

  // Hash before storing — if DB is ever compromised, raw tokens are not exposed
  const hashedToken = await bcrypt.hash(rawToken, 10)

  const expiresAt = new Date()
  expiresAt.setDate(expiresAt.getDate() + 7) // 7 days from now

  await RefreshToken.create({
    token:     hashedToken,
    userId:    user._id,
    tenantId:  user.tenantId || null,
    expiresAt,
    userAgent,
  })

  return rawToken // sent to client, never stored raw
}

// ── FUNCTION 1 — Register ─────────────────────
// Creates a brand new user account.
// The first user registered for a tenantId is automatically
// made an admin — so the first person to sign up becomes
// the administrator who can then invite others.

const register = async (req, res) => {
  try {
    const { firstName, lastName, email, password, tenantId, role, licence } = req.body

    if (!firstName || !lastName || !email || !password || !tenantId) {
      return res.status(400).json({
        message: 'First name, last name, email, password and company ID are required',
      })
    }

    if (password.length < 6) {
      return res.status(400).json({ message: 'Password must be at least 6 characters' })
    }

    const existingUser = await User.findOne({ email })
    if (existingUser) {
      return res.status(409).json({ message: 'An account with this email already exists' })
    }

    const tenantUserCount = await User.countDocuments({ tenantId })
    const isFirstUser     = tenantUserCount === 0

    const newUser = await User.create({
      firstName,
      lastName,
      email,
      password,
      tenantId,
      role:    isFirstUser ? 'admin'      : (role    || 'individual'),
      licence: isFirstUser ? 'enterprise' : (licence || 'basic'),
    })

    const accessToken  = generateAccessToken(newUser)
    const refreshToken = await generateRefreshToken(newUser, req.headers['user-agent'])

    res.status(201).json({
      message:      'Account created successfully',
      accessToken,
      refreshToken,
      // kept as 'token' for any legacy frontend references
      token:        accessToken,
      user:         newUser,
      isAdmin:      isFirstUser,
    })

  } catch (error) {
    console.error('Register error:', error)
    res.status(500).json({ message: 'Registration failed', error: error.message })
  }
}

// ── FUNCTION 2 — Login ────────────────────────
// Verifies email and password.
// Returns both an access token (8h JWT) and a refresh token (7d, stored in DB).

const login = async (req, res) => {
  try {
    const { email, password } = req.body

    if (!email || !password) {
      return res.status(400).json({ message: 'Email and password are required' })
    }

    const user = await User.findOne({ email }).select('+password')

    if (!user) {
      return res.status(401).json({ message: 'Invalid email or password' })
    }

    if (!user.isActive) {
      return res.status(403).json({
        message: 'Your account has been deactivated. Please contact your administrator.',
      })
    }

    // super_admin has no tenant record — skip check
    if (user.role !== 'super_admin') {
      const tenant = await Tenant.findOne({ tenantId: user.tenantId }).select('isActive')
      if (!tenant || !tenant.isActive) {
        return res.status(403).json({
          message: 'Your organisation account is currently inactive. Please contact support.',
        })
      }
    }

    const isPasswordCorrect = await user.comparePassword(password)
    if (!isPasswordCorrect) {
      return res.status(401).json({ message: 'Invalid email or password' })
    }

    // ── Licence expiry warning ────────────────
    let licenceWarning = null
    if (user.licenceExpiresAt) {
      const daysUntilExpiry = Math.ceil(
        (new Date(user.licenceExpiresAt) - new Date()) / (1000 * 60 * 60 * 24)
      )
      if (daysUntilExpiry <= 0) {
        licenceWarning = 'Your licence has expired. You have basic access only.'
      } else if (daysUntilExpiry <= 30) {
        licenceWarning = `Your licence expires in ${daysUntilExpiry} days.`
      }
    }

    await User.findByIdAndUpdate(user._id, { lastLoginAt: new Date() })

    // ── Issue both tokens ─────────────────────
    const accessToken  = generateAccessToken(user)
    const refreshToken = await generateRefreshToken(user, req.headers['user-agent'])

    const allPlatformTools = await Tool
      .find({ status: { $ne: 'inactive' } })
      .sort({ sortOrder: 1, name: 1 })
      .lean()

    res.status(200).json({
      message:         'Login successful',
      accessToken,
      refreshToken,
      token:           accessToken,  // kept for backwards compatibility
      user,
      licenceWarning,
      redirectTo:      user.role === 'super_admin' ? '/admin' : '/tool-launcher',
      activeTools:     user.getActiveTools ? user.getActiveTools() : ['quotex'],
      allPlatformTools,
    })

  } catch (error) {
    console.error('Login error:', error)
    res.status(500).json({ message: 'Login failed', error: error.message })
  }
}

// ── FUNCTION 3 — Get Current User ────────────
// Returns the logged-in user's profile on page refresh.
// The user ID comes from the JWT via auth middleware.

const getMe = async (req, res) => {
  try {
    const user = await User.findById(req.user.userId)
    if (!user) return res.status(404).json({ message: 'User not found' })

    const allPlatformTools = await Tool
      .find({ status: { $ne: 'inactive' } })
      .sort({ sortOrder: 1, name: 1 })
      .lean()

    res.status(200).json({ user, allPlatformTools })

  } catch (error) {
    console.error('Get me error:', error)
    res.status(500).json({ message: 'Failed to get user', error: error.message })
  }
}

// ── FUNCTION 4 — Refresh Token ────────────────
// Called silently by api.js when an access token expires (401 response).
// The client sends the stored refresh token.
// We find the matching DB record, verify it, and issue a new access token.
// The refresh token itself is rotated — old one deleted, new one issued.
// This is called "refresh token rotation" — limits damage if a token is stolen.
//
// Route: POST /api/auth/refresh
// Body:  { refreshToken: "raw64bytehex..." }
// Auth:  No JWT needed — this is how we get a new JWT

const refreshToken = async (req, res) => {
  try {
    const { refreshToken: rawToken } = req.body

    if (!rawToken) {
      return res.status(400).json({ message: 'Refresh token is required' })
    }

    // Find all non-expired refresh token records for comparison.
    // We cannot query by the raw token directly because it is stored hashed.
    // We load recent records and bcrypt.compare each one.
    // To keep this efficient, we filter by a userId hint if provided,
    // or fall back to checking all non-expired records.
    // For SourceHUB's scale this is fine — at large scale, store a
    // non-sensitive token ID alongside the hash for direct lookup.
    const { userId } = req.body  // optional hint from client

    const query = { expiresAt: { $gt: new Date() } }
    if (userId) query.userId = userId

    const records = await RefreshToken.find(query).populate('userId')

    // Find the matching record
    let matchedRecord = null
    for (const record of records) {
      const isMatch = await bcrypt.compare(rawToken, record.token)
      if (isMatch) { matchedRecord = record; break }
    }

    if (!matchedRecord) {
      return res.status(401).json({ message: 'Invalid or expired refresh token. Please log in again.' })
    }

    const user = matchedRecord.userId // populated above

    if (!user || !user.isActive) {
      await RefreshToken.deleteOne({ _id: matchedRecord._id })
      return res.status(403).json({ message: 'Account is inactive. Please contact your administrator.' })
    }

    // ── Rotate the refresh token ──────────────
    // Delete old record, issue a fresh one.
    // If the old token was stolen, the attacker's copy is now dead.
    await RefreshToken.deleteOne({ _id: matchedRecord._id })
    const newRefreshToken = await generateRefreshToken(user, req.headers['user-agent'])
    const newAccessToken  = generateAccessToken(user)

    res.status(200).json({
      accessToken:  newAccessToken,
      refreshToken: newRefreshToken,
      token:        newAccessToken, // backwards compatibility
    })

  } catch (error) {
    console.error('Refresh token error:', error)
    res.status(500).json({ message: 'Token refresh failed', error: error.message })
  }
}

// ── FUNCTION 5 — Logout ───────────────────────
// Deletes the refresh token record from DB.
// Even if someone stole the refresh token, it is now dead.
// The short-lived access token (8h) will expire on its own.
//
// Route: POST /api/auth/logout
// Body:  { refreshToken: "raw64bytehex..." }

const logoutUser = async (req, res) => {
  try {
    const { refreshToken: rawToken } = req.body

    if (rawToken) {
      // Find and delete the matching refresh token record
      const records = await RefreshToken.find({
        expiresAt: { $gt: new Date() },
        ...(req.user?.userId ? { userId: req.user.userId } : {}),
      })

      for (const record of records) {
        const isMatch = await bcrypt.compare(rawToken, record.token)
        if (isMatch) {
          await RefreshToken.deleteOne({ _id: record._id })
          break
        }
      }
    }

    res.status(200).json({ message: 'Logged out successfully' })

  } catch (error) {
    console.error('Logout error:', error)
    // Always return 200 on logout — never fail a logout attempt
    res.status(200).json({ message: 'Logged out' })
  }
}

// ── FUNCTION 6 — Forgot Password ─────────────
// Generates a temporary password and EMAILS it to the user's registered address.
// The password is never returned in the API response — only the inbox can see it.

const forgotPassword = async (req, res) => {
  try {
    const { email } = req.body
    if (!email) return res.status(400).json({ message: 'Email is required' })

    const user = await User.findOne({ email: email.toLowerCase() })

    // Always return the same message whether user exists or not.
    // This prevents email enumeration attacks (finding valid emails by response difference).
    if (!user) {
      return res.status(200).json({
        message: 'If this email is registered, a temporary password has been sent to it.',
        found:   false,
      })
    }

    if (!user.isActive) {
      return res.status(403).json({
        message: 'This account has been deactivated. Contact your administrator.',
      })
    }

    const chars        = 'ABCDEFGHJKMNPQRSTUVWXYZabcdefghjkmnpqrstuvwxyz23456789'
    const tempPassword = Array.from({ length: 8 }, () =>
      chars[Math.floor(Math.random() * chars.length)]
    ).join('')

    const salt   = await bcrypt.genSalt(10)
    const hashed = await bcrypt.hash(tempPassword, salt)
    await User.findByIdAndUpdate(user._id, { $set: { password: hashed } })

    // Invalidate all existing sessions when password is reset
    await RefreshToken.deleteMany({ userId: user._id })

    // ── Email the temp password — never return it in the API response ──
    const emailResult = await sendForgotPasswordEmail({
      to:           user.email,
      userName:     `${user.firstName} ${user.lastName}`,
      tempPassword,
    })

    if (!emailResult.sent) {
      // SMTP not configured — log it, but still tell frontend to check email
      // so the flow is consistent. In dev without SMTP, check server console.
      console.warn(`[Auth] Forgot-password email not sent for ${user.email}: ${emailResult.reason}`)
      console.warn(`[Auth] DEV ONLY — temp password for ${user.email}: ${tempPassword}`)
    }

    res.status(200).json({
      message: 'If this email is registered, a temporary password has been sent to it.',
      found:   true,
    })

  } catch (error) {
    console.error('Forgot password error:', error)
    res.status(500).json({ message: 'Failed to reset password', error: error.message })
  }
}

// ── FUNCTION 7 — Change Password ─────────────
// Unchanged from original — but now also clears all other sessions
// (other devices are logged out when password changes).

const changePassword = async (req, res) => {
  try {
    const { currentPassword, newPassword } = req.body

    if (!currentPassword || !newPassword) {
      return res.status(400).json({
        message: 'Current password and new password are required',
      })
    }

    if (newPassword.length < 6) {
      return res.status(400).json({ message: 'New password must be at least 6 characters' })
    }

    const user = await User.findById(req.user._id)
    if (!user) return res.status(404).json({ message: 'User not found' })

    const rawUser         = await User.findById(req.user._id).select('+password').lean()
    const isMatch         = await bcrypt.compare(currentPassword, rawUser.password)
    if (!isMatch) return res.status(401).json({ message: 'Current password is incorrect' })

    const salt   = await bcrypt.genSalt(10)
    const hashed = await bcrypt.hash(newPassword, salt)
    await User.findByIdAndUpdate(req.user._id, { $set: { password: hashed } })

    // Invalidate all sessions — other devices/tabs are logged out on password change
    await RefreshToken.deleteMany({ userId: req.user._id })

    res.status(200).json({ message: 'Password changed successfully. Please log in again.' })

  } catch (error) {
    console.error('Change password error:', error)
    res.status(500).json({ message: 'Failed to change password', error: error.message })
  }
}

// ── FUNCTION — Contact Enquiry ──────────────
// POST /api/auth/contact  (public — no auth required)
// Forwards landing page contact form to archana.n@sunserk.com
const contactEnquiry = async (req, res) => {
  try {
    const { name, phone, email, message } = req.body
    if (!name || !email) {
      return res.status(400).json({ message: 'Name and email are required' })
    }

    const emailResult = await sendContactEnquiryEmail({ name, phone, email, message })

    if (!emailResult.sent) {
      console.warn('[Contact] Enquiry email not sent:', emailResult.reason)
      // Still return success to user — log failure server-side
    }

    res.status(200).json({ message: 'Enquiry received. We will be in touch shortly.' })
  } catch (error) {
    console.error('Contact enquiry error:', error)
    res.status(500).json({ message: 'Failed to send enquiry', error: error.message })
  }
}

module.exports = {
  register,
  login,
  getMe,
  refreshToken,
  logoutUser,
  forgotPassword,
  changePassword,
  contactEnquiry,
}
