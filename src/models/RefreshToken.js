// RefreshToken.js — MongoDB model for storing refresh tokens.
// One document per active session (one per login).
// Storing in DB means we can force-invalidate any session instantly —
// useful when a super admin deactivates a tenant or a user reports a stolen device.
//
// Place this file at: server/src/models/RefreshToken.js

const mongoose = require('mongoose')

const refreshTokenSchema = new mongoose.Schema(
  {
    // The actual token string — a random 64-byte hex value (not a JWT).
    // Stored as a bcrypt hash so even a DB breach cannot be used to forge sessions.
    token: {
      type:     String,
      required: true,
    },

    // Which user this session belongs to.
    userId: {
      type:     mongoose.Schema.Types.ObjectId,
      ref:      'User',
      required: true,
    },

    // tenantId copied here so we can invalidate all sessions
    // for an entire tenant in one query (e.g. tenant deactivated).
    tenantId: {
      type: String,
      default: null,
    },

    // When this refresh token itself expires.
    // After this date the token is rejected even if it exists in DB.
    // MongoDB TTL index auto-deletes the document after this time —
    // no manual cleanup job needed.
    expiresAt: {
      type:     Date,
      required: true,
      index:    { expireAfterSeconds: 0 }, // MongoDB TTL index
    },

    // Device/browser info — useful for showing "active sessions" to users later.
    userAgent: {
      type:    String,
      default: null,
    },
  },
  {
    timestamps: true, // createdAt = when they logged in
  }
)

// Index for fast lookup by userId (used when invalidating all sessions for a user)
refreshTokenSchema.index({ userId: 1 })

// Index for fast lookup by tenantId (used when deactivating a whole tenant)
refreshTokenSchema.index({ tenantId: 1 })

module.exports = mongoose.model('RefreshToken', refreshTokenSchema)
