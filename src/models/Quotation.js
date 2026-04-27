// Quotation.js — QuoteX quotation document model.
// Renamed from RFQ.js. MongoDB collection: 'quotations'
// A Quotation is the business document QuoteX creates and tracks.
// Note: the word 'quotation' refers to the document type.
// 'RFQ' (Request for Quotation) was the old name — now called Quotation.

const mongoose = require('mongoose')

// ── Part Line Schema ──────────────────────────
const partLineSchema = new mongoose.Schema({
  partNumber: {
    type:     String,
    required: true,
    trim:     true,
    uppercase: true,
  },
  description:    { type: String, trim: true, default: '' },
  specifications: { type: String, trim: true, default: '' },
  unit:           { type: String, default: 'Pieces' },
  quantity:       { type: Number, required: true, min: 0 },
  unitPrice:      { type: Number, required: true, min: 0 },
  totalPrice:     { type: Number, default: 0 },
  customFields:   { type: Map, of: String, default: {} },
}, { _id: false })

// ── Main Quotation Schema ─────────────────────
const quotationSchema = new mongoose.Schema(
  {
    // Quote number format: QX-YEAR-TENANTCODE-INITIALS-SEQUENCE
    // e.g. QX-2026-BI-RA-0042
    //   QX         — QuoteX tool prefix, always fixed
    //   2026       — year of creation
    //   BI         — tenant code derived from tenantId (first letter of each _ separated word)
    //   RA         — user initials (first letter of firstName + first letter of lastName)
    //   0042       — atomic sequence per tenant per year via Counter model ($inc)
    quoteNumber: {
      type:   String,
      unique: true,
      trim:   true,
    },

    customer: {
      customerId:  { type: String, default: '' },
      companyName: { type: String, required: true, trim: true },
      contactName: { type: String, trim: true, default: '' },
      email:       { type: String, trim: true, default: '' },
      phone:       { type: String, trim: true, default: '' },
      address:     { type: String, trim: true, default: '' },
      city:        { type: String, trim: true, default: '' },
      country:     { type: String, trim: true, default: 'India' },
    },

    parts: {
      type: [partLineSchema],
      validate: {
        validator: (parts) => parts.length > 0,
        message:   'A Quotation must have at least one part',
      },
    },

    grandTotal:     { type: Number, default: 0 },
    currency:       { type: String, default: 'USD' },
    currencySymbol: { type: String, default: '$' },

    termsAndConditions: {
      type:    String,
      default: 'Standard terms and conditions apply.',
    },

    attachments: [
      {
        fileName: { type: String },
        fileUrl:  { type: String },
        fileSize: { type: Number },
      },
    ],

    status: {
      type:    String,
      enum:    ['Draft', 'Sent', 'In Progress', 'Awarded', 'Not Awarded'],
      default: 'Draft',
    },

    version:       { type: Number, default: 1 },
    originalQuoteId: {
      type:    mongoose.Schema.Types.ObjectId,
      ref:     'Quotation',
      default: null,
    },

    followUpDate:  { type: Date, default: null },
    reasonForLoss: { type: String, trim: true, default: '' },
    awardedAt:     { type: Date, default: null },
    notes:         { type: String, trim: true, default: '' },

    tenantId:      { type: String, required: true, default: 'default' },
    createdBy:     { type: String, default: 'default' },
    createdByName: { type: String, default: '' },  // snapshot of firstName + lastName at creation
    creatorEmail:  { type: String, trim: true, default: '' },

    // Track reminder emails sent — array of ISO date strings (YYYY-MM-DD)
    remindersSent: { type: [String], default: [] },
  },
  { timestamps: true }
)

quotationSchema.index({ tenantId: 1, createdAt: -1 })
// Compound unique index on quoteNumber + tenantId
quotationSchema.index({ quoteNumber: 1, tenantId: 1 }, { unique: true, sparse: true })

const Quotation = mongoose.model('Quotation', quotationSchema)
module.exports = Quotation
