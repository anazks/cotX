// Counter.js — Atomic sequence counter for quote number generation.
// Location: server/src/models/Counter.js
//
// One document per tenantId + year combination.
// MongoDB's findOneAndUpdate with $inc is atomic — two simultaneous
// requests will always get different sequence numbers, eliminating
// the race condition that existed with the count-based approach.
//
// Example document in DB:
//   { _id: "bosch_india_2026", seq: 42 }
//
// The seq field starts at 0 and is incremented BEFORE returning,
// so the first quote gets seq: 1, the second gets seq: 2, etc.

const mongoose = require('mongoose')

const counterSchema = new mongoose.Schema(
  {
    // Composite key: tenantId_year e.g. "bosch_india_2026"
    // Stored as _id so MongoDB's built-in uniqueness guarantees apply
    _id: {
      type:     String,
      required: true,
    },

    // Current sequence value. Starts at 0, incremented atomically on each use.
    seq: {
      type:    Number,
      default: 0,
    },
  },
  {
    // No timestamps needed — this is a pure counter document
    timestamps: false,
    versionKey: false,
  }
)

module.exports = mongoose.model('Counter', counterSchema)
