// Tool.js — Platform tool registry stored in MongoDB.
// Super admin creates and manages tools here.
// tools.js still used for feature definitions per licence tier.

const mongoose = require('mongoose')

const toolSchema = new mongoose.Schema(
  {
    code: {
      type: String, required: true, unique: true, trim: true, lowercase: true,
    },
    name: {
      type: String, required: true, trim: true,
    },
    description: {
      type: String, trim: true, default: '',
    },
    // Icon stored as base64 image
    icon: {
      fileBase64: { type: String, default: '' },
      fileName:   { type: String, default: '' },
      mimeType:   { type: String, default: '' },
    },
    // Emoji fallback when no icon image uploaded
    iconEmoji: {
      type: String, default: '🔧',
    },
    // active = fully built, clickable for users with access
    // coming_soon = visible to all but not clickable
    // inactive = hidden from launcher
    status: {
      type: String, enum: ['active', 'coming_soon', 'inactive'], default: 'active',
    },
    // Frontend route e.g. '/dashboard' for RFQ tool
    route: {
      type: String, default: '',
    },
    sortOrder: {
      type: Number, default: 99,
    },
  },
  { timestamps: true }
)

toolSchema.index({ code: 1 }, { unique: true })
toolSchema.index({ status: 1, sortOrder: 1 })

const Tool = mongoose.model('Tool', toolSchema)
module.exports = Tool
