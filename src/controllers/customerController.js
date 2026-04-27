// customerController.js — Handles all customer related operations.
// Two main jobs:
// 1. Save or update a customer in the Customer Master
// 2. Search customers by company name for the autocomplete feature

const Customer = require('../models/Customer');

// ─────────────────────────────────────────────
// FUNCTION 1 — Create or Update a Customer
// ─────────────────────────────────────────────
// This runs when a user submits an RFQ with customer details.
// If the customer already exists (matched by email + tenantId),
// their record is updated with any new information.
// If they are brand new, a fresh record is created.
// This way the Customer Master builds itself automatically
// just by creating RFQs — no separate data entry needed.

const saveCustomer = async (req, res) => {
  try {
    // Pull customer details from the request body.
    // The request body is the data sent from the frontend form —
    // like the filled-in fields on a paper form being handed to you.
    const {
      companyName,
      contactName,
      email,
      phone,
      address,
      city,
      country,
    } = req.body;

    // companyName and email are the minimum we need to save a customer.
    // Without these two fields a customer record is not useful.
    if (!companyName || !email) {
      return res.status(400).json({
        message: 'Company name and email are required',
      });
    }

    const tenantId = req.user.tenantId; // Will come from logged-in user in Phase 5

    // Search for an existing customer by email within this tenant.
    // Email is the most reliable unique identifier —
    // company names can change but emails are more stable.
    const existingCustomer = await Customer.findOne({ email, tenantId });

    if (existingCustomer) {
      // Customer already exists — update their details in case
      // anything has changed (new phone number, address etc.)
      // $set tells MongoDB to only update the specified fields
      // and leave everything else untouched.
      const updated = await Customer.findOneAndUpdate(
        { email, tenantId },
        {
          $set: {
            companyName,
            contactName,
            phone:   phone   || existingCustomer.phone,
            address: address || existingCustomer.address,
            city:    city    || existingCustomer.city,
            country: country || existingCustomer.country,
          },
        },
        { new: true } // Return the updated record, not the old one
      );

      return res.status(200).json({
        message: 'Customer updated',
        customer: updated,
        isNew: false, // Tell the frontend this was an existing customer
      });
    }

    // Customer does not exist — create a brand new record
    const newCustomer = await Customer.create({
      companyName,
      contactName,
      email,
      phone:   phone   || '',
      address: address || '',
      city:    city    || '',
      country: country || 'India',
      tenantId,
    });

    res.status(201).json({
      message: 'Customer saved to master',
      customer: newCustomer,
      isNew: true, // Tell the frontend this was a new customer
    });

  } catch (error) {
    console.error('Save customer error:', error);
    res.status(500).json({ message: 'Failed to save customer', error: error.message });
  }
};

// ─────────────────────────────────────────────
// FUNCTION 2 — Search Customers (Autocomplete)
// ─────────────────────────────────────────────
// This runs every time a user types into the customer name field
// on the RFQ form. It returns all customers whose company name
// contains the typed letters — like a live search filter.
//
// Example: user types "tat"
// Returns: ["Tata Motors", "Tata Steel", "Tata Consultancy"]

const searchCustomers = async (req, res) => {
  try {
    // The search term comes from the URL query string.
    // e.g. /api/customers/search?q=tat
    // req.query.q will be "tat"
    const { q } = req.query;

    // If nothing was typed yet, return empty results
    // rather than loading every single customer in the database
    if (!q || q.trim().length < 2) {
      return res.status(200).json([]);
    }

    const tenantId = req.user.tenantId;

    // $regex performs a partial text search — like Ctrl+F in a document.
    // "tat" will match "Tata", "tata", "TATA" anywhere in the name.
    // $options: 'i' makes it case-insensitive.
    // $options: 'i' means "ignore case" — so "tat", "TAT", "Tat" all match the same results.
    const customers = await Customer.find({
      tenantId,
      isActive: true, // Only return active customers
      companyName: {
        $regex: q.trim(),
        $options: 'i',
      },
    })
      .select('companyName contactName email phone address city country')
      // ^ Only return these specific fields — we don't need to send
      //   tenantId or internal MongoDB fields to the frontend
      .limit(10) // Never return more than 10 suggestions at once
      .sort({ companyName: 1 }); // Sort alphabetically A → Z

    res.status(200).json(customers);

  } catch (error) {
    console.error('Customer search error:', error);
    res.status(500).json({ message: 'Search failed', error: error.message });
  }
};

// ─────────────────────────────────────────────
// FUNCTION 3 — Get All Customers
// ─────────────────────────────────────────────
// Returns the full Customer Master list.
// Used later in the admin panel to view all saved customers.

const getAllCustomers = async (req, res) => {
  try {
    const tenantId = req.user.tenantId;

    const customers = await Customer.find({ tenantId, isActive: true })
      .sort({ companyName: 1 }) // Alphabetical order
      .select('companyName contactName email phone city country createdAt');

    res.status(200).json({
      total: customers.length,
      customers,
    });

  } catch (error) {
    console.error('Get customers error:', error);
    res.status(500).json({ message: 'Failed to fetch customers', error: error.message });
  }
};

// exports moved to bottom of file — see bulkUploadCustomers addition
// ─────────────────────────────────────────────
// FUNCTION 4 — Bulk Upload Customers (Super Admin)
// POST /api/admin/tenants/:tenantId/bulk-upload-customers
// tenantId comes from URL param — super admin scopes to chosen tenant.
// Exact duplicate (all fields match) → skip with reason.
// Email match but different fields → update.
// New email → create.
// Returns row-by-row result array.
// ─────────────────────────────────────────────
const xlsx = require('xlsx')
const multer = require('multer')

const bulkUploadCustomers = async (req, res) => {
  try {
    if (!req.file) {
      return res.status(400).json({ message: 'Please upload an Excel (.xlsx) file' })
    }

    const tenantId = req.params.tenantId
    if (!tenantId) {
      return res.status(400).json({ message: 'tenantId URL param is required' })
    }

    const workbook = xlsx.read(req.file.buffer, { type: 'buffer' })
    const rows     = xlsx.utils.sheet_to_json(
      workbook.Sheets[workbook.SheetNames[0]], { defval: '' }
    )

    if (!rows || rows.length === 0) {
      return res.status(400).json({ message: 'The Excel file is empty' })
    }

    // Normalise header variants to canonical field names
    const mapRow = (raw) => {
      const n = {}
      for (const k in raw) {
        n[k.toLowerCase().replace(/[\s_\-]/g, '')] = String(raw[k] || '').trim()
      }
      return {
        companyName: n['companyname'] || n['company']      || n['name']           || '',
        contactName: n['contactname'] || n['contact']      || n['contactperson']  || '',
        email:       n['email']       || n['emailaddress'] || n['mail']           || '',
        phone:       n['phone']       || n['mobile']       || n['tel']            || n['telephone'] || '',
        address:     n['address']     || n['addr']         || '',
        city:        n['city']        || n['location']     || '',
        country:     n['country']     || '',
      }
    }

    const results = []
    let imported = 0, updated = 0, skipped = 0, errors = 0

    for (let i = 0; i < rows.length; i++) {
      const rowNum = i + 2  // row 1 = header, data starts at row 2
      const d      = mapRow(rows[i])

      // Require companyName + email
      if (!d.companyName) {
        errors++
        results.push({ row: rowNum, status: 'error', data: d, reason: 'Missing Company Name' })
        continue
      }
      if (!d.email) {
        errors++
        results.push({ row: rowNum, status: 'error', data: d, reason: 'Missing Email' })
        continue
      }
      if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(d.email)) {
        errors++
        results.push({ row: rowNum, status: 'error', data: d, reason: 'Invalid email format' })
        continue
      }

      const existing = await Customer.findOne({
        email: d.email.toLowerCase(), tenantId,
      })

      if (existing) {
        // Check exact match on all fields
        const exact =
          existing.companyName === d.companyName &&
          (existing.contactName || '') === d.contactName &&
          (existing.phone       || '') === d.phone       &&
          (existing.address     || '') === d.address     &&
          (existing.city        || '') === d.city        &&
          (existing.country     || '') === d.country

        if (exact) {
          skipped++
          results.push({
            row: rowNum, status: 'skipped',
            data: d, reason: 'Exact duplicate — record unchanged',
          })
          continue
        }

        // Partial match — update changed fields
        await Customer.findOneAndUpdate(
          { email: d.email.toLowerCase(), tenantId },
          { $set: {
            companyName: d.companyName,
            contactName: d.contactName || existing.contactName,
            phone:       d.phone       || existing.phone,
            address:     d.address     || existing.address,
            city:        d.city        || existing.city,
            country:     d.country     || existing.country,
          }},
          { new: true }
        )
        updated++
        results.push({ row: rowNum, status: 'updated', data: d })

      } else {
        // New customer
        await Customer.create({
          companyName: d.companyName,
          contactName: d.contactName || '',
          email:       d.email.toLowerCase(),
          phone:       d.phone    || '',
          address:     d.address  || '',
          city:        d.city     || '',
          country:     d.country  || 'India',
          tenantId,
          isActive: true,
        })
        imported++
        results.push({ row: rowNum, status: 'imported', data: d })
      }
    }

    res.status(200).json({
      message: `Upload complete — ${imported} imported, ${updated} updated, ${skipped} skipped, ${errors} errors`,
      summary: { total: rows.length, imported, updated, skipped, errors },
      results,
    })

  } catch (err) {
    console.error('Bulk upload customers error:', err)
    res.status(500).json({ message: 'Bulk upload failed', error: err.message })
  }
}

// ─────────────────────────────────────────────
// FUNCTION 5 — Download Customer Upload Template
// GET /api/admin/tenants/:tenantId/bulk-upload-customers/template
// ─────────────────────────────────────────────
const downloadCustomerTemplate = async (req, res) => {
  try {
    const ws = xlsx.utils.json_to_sheet([{
      'Company Name': 'e.g. Tata Motors Ltd',
      'Contact Name': 'e.g. Rajesh Kumar',
      'Email':        'e.g. rajesh@tatamotors.com',
      'Phone':        'e.g. +91 98765 43210',
      'Address':      'e.g. 1 Bombay House, Mumbai',
      'City':         'e.g. Mumbai',
      'Country':      'e.g. India',
    }])
    ws['!cols'] = [
      { wch: 28 }, { wch: 22 }, { wch: 32 },
      { wch: 20 }, { wch: 38 }, { wch: 16 }, { wch: 16 },
    ]
    const wb = xlsx.utils.book_new()
    xlsx.utils.book_append_sheet(wb, ws, 'Customers')
    const buffer = xlsx.write(wb, { type: 'buffer', bookType: 'xlsx' })

    res.setHeader('Content-Type',
      'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet')
    res.setHeader('Content-Disposition',
      'attachment; filename="customer-upload-template.xlsx"')
    res.send(buffer)
  } catch (err) {
    console.error('Customer template error:', err)
    res.status(500).json({ message: 'Failed to generate template', error: err.message })
  }
}

module.exports = {
  saveCustomer,
  searchCustomers,
  getAllCustomers,
  bulkUploadCustomers,
  downloadCustomerTemplate,
}
