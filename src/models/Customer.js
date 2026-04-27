// Customer.js — This file defines what a "customer" looks like in our database.
// Every time a new customer appears in an RFQ for the first time,
// their details get saved here automatically — building your Customer Master list.

const mongoose = require('mongoose');

const customerSchema = new mongoose.Schema(
  {
    // The company name e.g. "Tata Motors Ltd"
    companyName: {
      type: String,
      required: true,
      trim: true,
    },

    // The specific person you are dealing with at that company
    // e.g. "Rajesh Kumar"
    contactName: {
      type: String,
      trim: true,
    },

    // Their work email address — used for sending the RFQ
    email: {
      type: String,
      required: true,
      trim: true,
      lowercase: true, // Automatically converts to lowercase
                       // so "Rajesh@TATA.com" and "rajesh@tata.com" 
                       // are treated as the same email
    },

    // Their phone number — optional but useful
    phone: {
      type: String,
      trim: true,
      default: '',
    },

    // Their full mailing address — will appear on the RFQ PDF
    address: {
      type: String,
      trim: true,
      default: '',
    },

    // City e.g. "Mumbai"
    city: {
      type: String,
      trim: true,
      default: '',
    },

    // Country e.g. "India"
    country: {
      type: String,
      trim: true,
      default: '', // Default to India since that is your base market
    },

    // Which tenant (company) this customer belongs to.
    // Just like in Part.js, this ensures Company A's customers
    // are never visible to Company B.
    tenantId: {
      type: String,
      required: true,
      trim: true,
    },

    // A simple flag to mark if this customer is still active.
    // Useful later if you want to archive old customers without deleting them.
    isActive: {
      type: Boolean,
      default: true, // All new customers start as active
    },
  },
  {
    // Automatically adds createdAt and updatedAt timestamps
    // to every customer record — same as we did in Part.js
    timestamps: true,
  }
);

// Create a combined index on companyName and tenantId.
// This makes the customer search/autocomplete very fast —
// when a user starts typing a company name, results appear instantly
// even if you have hundreds of customers saved.
customerSchema.index({ companyName: 1, tenantId: 1 });

// Also index by email per tenant — useful later when checking
// if a customer already exists before creating a duplicate.
customerSchema.index({ email: 1, tenantId: 1 });

// Package the schema into a usable model.
// Mongoose will create a collection called "customers" in MongoDB.
const Customer = mongoose.model('Customer', customerSchema);

module.exports = Customer;

