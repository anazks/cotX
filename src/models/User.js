// User.js — Defines what a user account looks like in the database.
// Every person who logs into SourceHUB has a User record.
// This model controls three things:
// 1. Authentication — email and password for login
// 2. Role          — what data they can see
// 3. Licence       — which features they can use

const mongoose = require('mongoose')
const bcrypt   = require('bcryptjs')

const userSchema = new mongoose.Schema(
  {
    // ── Basic Info ────────────────────────────
    firstName: {
      type:     String,
      required: true,
      trim:     true,
    },

    lastName: {
      type:     String,
      required: true,
      trim:     true,
    },

    // Email is the unique identifier for login.
    // Stored in lowercase to prevent duplicate accounts
    // with different capitalisation e.g. "John@co.com" vs "john@co.com"
    email: {
      type:     String,
      required: true,
      unique:   true,
      trim:     true,
      lowercase: true,
    },

    // Password is NEVER stored as plain text.
    // It is always hashed (scrambled) before saving.
    // Think of hashing like a one-way lock —
    // you can lock it but never unlock it back to plain text.
    // To verify a password you hash what the user typed
    // and compare the two hashes.
    password: {
      type:     String,
      required: true,
      minlength: 6,
    },

    // ── Role ──────────────────────────────────
    // Controls what DATA the user can see in the tracker
    // individual  → only their own quotations
    // team_lead   → their own + their direct team members' quotations
    // group_lead  → all quotations within their tenant
    // admin       → everything + user management panel
    role: {
      type:    String,
      enum:    ['individual', 'team_lead', 'group_lead', 'admin', 'super_admin'],
      default: 'individual',
    },

    // ── Licence ───────────────────────────────
    // Controls which FEATURES the user can access
    // basic      → quotation creation, own tracker, PDF download
    // pro        → basic + analytics, versioning, team tracker
    // enterprise → pro + user management, all tenant data
    // Legacy single licence field — new code uses toolAccess[] instead.
    licence: {
      type:    String,
      enum:    ['basic', 'pro', 'enterprise'],
      default: 'basic',
    },

    licenceExpiresAt: {
      type:    Date,
      default: null,
    },

    // ── Per-tool access ───────────────────────
    // Each entry defines access to one tool for this user.
    // Licence and expiry are independent per tool.
    // A user can have pro licence for RFQ but basic for PO.
    toolAccess: [
      {
        // The tool code e.g. 'quotex', 'negohelp'
        toolCode: {
          type:     String,
          required: true,
          trim:     true,
        },
        // Licence tier for this specific tool
        licence: {
          type:    String,
          enum:    ['basic', 'pro', 'enterprise'],
          default: 'basic',
        },
        // Expiry date for this tool's licence — always 1st of month
        licenceExpiresAt: {
          type:    Date,
          default: null,
        },
        // Can be disabled per tool without removing access entirely
        isActive: {
          type:    Boolean,
          default: true,
        },
      }
    ],

    // ── Tenant ────────────────────────────────
    // tenantId is required for all users except super_admin
    // who operates across all tenants
    tenantId: {
      type:     String,
      required: false, // Not required for super_admin
      trim:     true,
      default:  '',
    },

    // ── Team Structure ────────────────────────
    // For team_lead role — list of user IDs they manage.
    // team_leads see their own quotations plus their team members'.
    teamMembers: [
      {
        type: mongoose.Schema.Types.ObjectId,
        ref:  'User',
      }
    ],

    // ── Account Status ────────────────────────
    // Inactive users cannot log in.
    // Admins can deactivate users without deleting their data.
    isActive: {
      type:    Boolean,
      default: true,
    },

    // ── Tenant Admin flag ─────────────────────
    // isTenantAdmin = true grants access to the Team Manager page
    // and allows creating/deactivating users within their tenant.
    // Orthogonal to role — a team_lead can also be isTenantAdmin.
    // Only one user per tenant should have this true (enforced in adminController).
    // Super admin sets this — tenant users cannot self-promote.
    isTenantAdmin: {
      type:    Boolean,
      default: false,
    },

    // ── reportingTo ───────────────────────────
    // The _id of the Team this user's lead reports to (set via Team model).
    // Stored here for fast upward traversal.
    // Null = root level (no parent lead).
    reportingTo: {
      type:    mongoose.Schema.Types.ObjectId,
      ref:     'Team',
      default: null,
    },

    // Date of last successful login — useful for
    // identifying inactive accounts
    lastLoginAt: {
      type:    Date,
      default: null,
    },
  },
  {
    timestamps: true, // Adds createdAt and updatedAt automatically
  }
)

// ── Index ─────────────────────────────────────
// Fast lookup by email — used on every login request
userSchema.index({ email: 1 })

// Fast lookup by tenant — used when admin lists all users
userSchema.index({ tenantId: 1, role: 1 })

// ── Password Hashing ──────────────────────────
// This runs automatically BEFORE every save.
// If the password field has changed, it hashes the new password.
// This means plain text passwords are NEVER stored in the database.
//
// Example:
// User sets password "mypassword123"
// bcrypt converts it to "$2a$10$xK9mN3..."
// Only the hash is saved — the original is gone forever
userSchema.pre('save', async function () {
  // Only hash if password was actually changed
  if (!this.isModified('password')) return

  // Hash the password before saving
  const salt    = await bcrypt.genSalt(10)
  this.password = await bcrypt.hash(this.password, salt)
})

// ── Password Verification Method ─────────────
// Added to every User document as a helper method.
// Call it like: const isMatch = await user.comparePassword('typed password')
// Returns true if the typed password matches the stored hash.
userSchema.methods.comparePassword = async function (candidatePassword) {
  return bcrypt.compare(candidatePassword, this.password)
}

// ── Tool access check ─────────────────────────
// Check if user has access to a specific tool
// e.g. user.hasTool('rfq') → true/false
userSchema.methods.hasTool = function (toolCode) {
  if (!this.toolAccess || this.toolAccess.length === 0) {
    // Legacy fallback — default to quotex tool
    return toolCode === 'quotex'
  }

  const toolEntry = this.toolAccess.find(
    t => t.toolCode === toolCode && t.isActive
  )

  if (!toolEntry) return false

  // Check if this tool's licence has expired
  if (toolEntry.licenceExpiresAt && new Date() > new Date(toolEntry.licenceExpiresAt)) {
    return false
  }

  return true
}

// ── Tool feature check ────────────────────────
// Check if user's licence for a specific tool includes a feature
// e.g. user.hasToolFeature('rfq', 'analytics') → true/false
userSchema.methods.hasToolFeature = function (toolCode, feature) {
  const { getToolFeatures } = require('../config/tools')

  // Find this tool in user's toolAccess
  const toolEntry = this.toolAccess?.find(
    t => t.toolCode === toolCode && t.isActive
  )

  if (!toolEntry) {
    // Legacy fallback — check top-level licence field
    if (toolCode === 'quotex') {
      const features = getToolFeatures('quotex', this.licence || 'basic')
      return features.includes(feature)
    }
    return false
  }

  // Check licence expiry for this tool
  if (toolEntry.licenceExpiresAt && new Date() > new Date(toolEntry.licenceExpiresAt)) {
    // Expired — only basic features
    const basicFeatures = getToolFeatures(toolCode, 'basic')
    return basicFeatures.includes(feature)
  }

  const features = getToolFeatures(toolCode, toolEntry.licence)
  return features.includes(feature)
}

// Legacy hasFeature — checks quotex tool using top-level licence field
userSchema.methods.hasFeature = function (feature) {
  return this.hasToolFeature('quotex', feature)
}

// ── Get list of active tool codes for this user ──
userSchema.methods.getActiveTools = function () {
  if (!this.toolAccess || this.toolAccess.length === 0) {
      // Legacy users default to quotex tool
    return ['quotex']
  }

  const now = new Date()
  return this.toolAccess
    .filter(t =>
      t.isActive &&
      (!t.licenceExpiresAt || new Date(t.licenceExpiresAt) > now)
    )
    .map(t => t.toolCode)
}

// Strip password hash from every API response automatically.
userSchema.methods.toJSON = function () {
  const user = this.toObject()
  delete user.password
  return user
}

const User = mongoose.model('User', userSchema)

module.exports = User