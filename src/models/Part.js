// Part.js — This file defines what a "part" looks like in our database.
// Think of this as designing a form template. Every part saved to the 
// database must follow this structure exactly.

const mongoose = require('mongoose');

// This is the "form template" — called a Schema in MongoDB language.
// Each field has a type (String, Number etc.) and rules (required or not).
const partSchema = new mongoose.Schema(
  {
    // The unique identifier for the part e.g. "BRG-6205-ZZ"
    partNumber: {
      type: String,
      required: true,  // Cannot save a part without this
      unique: true,    // No two parts can have the same part number
      trim: true,      // Automatically removes accidental spaces before/after
      uppercase: true, // Automatically converts to uppercase e.g. "brg-001" → "BRG-001"
    },

    // Human readable name e.g. "Deep Groove Ball Bearing"
    description: {
      type: String,
      required: true,
      trim: true,
       default: '', // If no specs provided, save an empty string instead of null
    },

    // Technical specifications e.g. "Inner Dia: 25mm, Outer Dia: 52mm"
    // Not required — some parts may not have detailed specs
    specifications: {
      type: String,
      trim: true,
      default: '', // If no specs provided, save an empty string instead of null
    },

    // The unit of measurement e.g. "Pieces", "Kg", "Metres"
    unit: {
      type: String,
      trim: true,
      default: 'Pieces',
    },

    // Which tenant (company/client) this part belongs to.
    // This is important for multi-tenant isolation —
    // Company A should never see Company B's parts list.
    // We'll use this field in every model going forward.
    tenantId: {
      type: String,
      required: true,
      trim: true,
    },
  },
  {
    // This tells Mongoose to automatically add two extra fields
    // to every part record:
    // "createdAt" — the date/time this part was first saved
    // "updatedAt" — the date/time this part was last changed
    // Very useful for tracking and debugging.
    timestamps: true,
  }
);

// This creates a searchable index on partNumber and tenantId together.
// Think of an index like the alphabetical tabs in a physical filing cabinet —
// it makes searching dramatically faster when you have thousands of parts.
partSchema.index({ partNumber: 1, tenantId: 1 });

// This line packages the schema into a "model" — a usable object
// that your routes and controllers can use to read/write parts data.
// "Part" is the name — Mongoose will create a collection called "parts" in MongoDB.
const Part = mongoose.model('Part', partSchema);

module.exports = Part;
