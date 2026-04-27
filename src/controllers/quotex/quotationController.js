// quotationController.js — QuoteX quotation operations.
// Renamed from rfqController.js.
// Quote number format: QX-YEAR-TENANTCODE-INITIALS-SEQUENCE
// e.g. QX-2026-BI-RA-0042

const Quotation = require('../../models/Quotation')
const Customer  = require('../../models/Customer')
const Counter   = require('../../models/Counter')
const { getSubtreeUserIds } = require('../teamController')

// ── Helper — Derive tenant code from tenantId ─
// Takes the first letter of each underscore-separated word, uppercased.
// Single-word tenantIds use the first 3 letters.
//   bosch_india   → BI
//   tata_motors   → TM
//   msk_tools     → MT
//   mahindra      → MAH
const getTenantCode = (tenantId) => {
  const parts = tenantId.split('_').filter(Boolean)
  if (parts.length > 1) {
    return parts.map(p => p[0].toUpperCase()).join('')
  }
  return tenantId.slice(0, 3).toUpperCase()
}

// ── Helper — Derive user initials ─────────────
// First letter of firstName + first letter of lastName, uppercased.
// Falls back gracefully if either name part is missing.
//   firstName: "Ramesh", lastName: "Achar"  → RA
//   firstName: "Sunita", lastName: "Kumar"  → SK
const getUserInitials = (firstName, lastName) => {
  const f = (firstName || '').trim()
  const l = (lastName  || '').trim()
  if (f && l) return `${f[0]}${l[0]}`.toUpperCase()
  if (f)      return f.slice(0, 2).toUpperCase()
  return 'XX' // fallback — should never happen if User model enforces firstName/lastName
}

// ── Helper — Generate quote number (atomic) ───
// Format: QX-YEAR-TENANTCODE-INITIALS-SEQUENCE
// Uses MongoDB $inc on the Counter collection — atomic, no race condition.
// Two simultaneous requests for the same tenant+year always get different seq values.
const generateQuoteNumber = async (tenantId, year, firstName, lastName) => {
  const tenantCode = getTenantCode(tenantId)
  const initials   = getUserInitials(firstName, lastName)
  const counterId  = `${tenantId}_${year}`

  // findOneAndUpdate with $inc is atomic in MongoDB.
  // upsert: true creates the counter document if it does not exist yet.
  // new: true returns the document AFTER the increment.
  const counter = await Counter.findOneAndUpdate(
    { _id: counterId },
    { $inc: { seq: 1 } },
    { new: true, upsert: true }
  )

  const sequence = String(counter.seq).padStart(4, '0')
  return `QX-${year}-${tenantCode}-${initials}-${sequence}`
}

// ── FUNCTION 1 — Create a new Quotation ───────
const createQuotation = async (req, res) => {
  try {
    const {
      customer,
      parts,
      termsAndConditions,
      attachments,
      currency,
      currencySymbol,
    } = req.body

    const tenantId = req.user.tenantId

    if (!customer || !customer.companyName) {
      return res.status(400).json({ message: 'Customer details are required' })
    }
    if (!parts || parts.length === 0) {
      return res.status(400).json({ message: 'At least one part is required' })
    }

    // Validate currency — must be a 3-letter ISO currency code (USD, INR, EUR etc.)
    // Prevents arbitrary strings reaching the PDF and corrupting output.
    // currencySymbol is free-form (symbols vary by locale) but capped at 5 chars.
    const VALID_CURRENCY = /^[A-Z]{3}$/
    if (currency && !VALID_CURRENCY.test(currency)) {
      return res.status(400).json({
        message: 'Currency must be a 3-letter ISO code (e.g. USD, INR, EUR)',
        field:   'currency',
      })
    }
    if (currencySymbol && currencySymbol.length > 5) {
      return res.status(400).json({
        message: 'Currency symbol must be 5 characters or fewer',
        field:   'currencySymbol',
      })
    }

    const calculatedParts = parts.map(part => {
      const qty   = parseFloat(part.quantity)  || 0
      const price = parseFloat(part.unitPrice) || 0
      return {
        partNumber:     part.partNumber     || '',
        description:    part.description    || '',
        specifications: part.specifications || '',
        unit:           part.unit           || 'Pieces',
        quantity:       qty,
        unitPrice:      price,
        totalPrice:     parseFloat((qty * price).toFixed(2)),
        customFields:   part.customFields   || {},
      }
    })

    const grandTotal = calculatedParts.reduce(
      (sum, part) => sum + (part.totalPrice || 0), 0
    )

    const year = new Date().getFullYear()

    const defaultFollowUpDate = new Date()
    defaultFollowUpDate.setDate(defaultFollowUpDate.getDate() + 7)

    // Atomic quote number — no retry loop needed.
    // Counter.$inc guarantees uniqueness without any race condition.
    const quoteNumber = await generateQuoteNumber(
      tenantId,
      year,
      req.user.firstName,
      req.user.lastName
    )

    const newQuotation = await Quotation.create({
      quoteNumber,
      customer,
      parts:              calculatedParts,
      grandTotal,
      currency:           currency           || 'USD',
      currencySymbol:     currencySymbol     || '$',
      termsAndConditions: termsAndConditions || 'Standard terms and conditions apply.',
      attachments:        attachments        || [],
      status:             'Draft',
      tenantId,
      createdBy:          req.user._id,
      createdByName:      `${req.user.firstName || ''} ${req.user.lastName || ''}`.trim(),
      creatorEmail:       req.user.email     || '',
      followUpDate:       defaultFollowUpDate,
    })

    // Auto-save customer to Customer Master
    if (customer.email) {
      await Customer.findOneAndUpdate(
        { email: customer.email, tenantId },
        {
          companyName: customer.companyName,
          contactName: customer.contactName || '',
          email:       customer.email,
          phone:       customer.phone       || '',
          address:     customer.address     || '',
          city:        customer.city        || '',
          country:     customer.country     || 'India',
          tenantId,
        },
        { upsert: true, new: true }
      )
    }

    res.status(201).json({
      message:   'Quotation created successfully',
      quotation: newQuotation,
      // Keep 'rfq' key for backwards compat with frontend success screen
    })

  } catch (error) {
    console.error('Create quotation error:', error)
    res.status(500).json({ message: 'Failed to create quotation', error: error.message })
  }
}

// ── FUNCTION 2 — Get all Quotations ───────────
const getAllQuotations = async (req, res) => {
  try {
    const tenantId = req.user.tenantId
    const filter = { tenantId }

    if (!req.user.isTenantAdmin && req.user.role !== 'super_admin') {
      if (req.user.role === 'team_lead') {
        const subtree = await getSubtreeUserIds(req.user._id, tenantId)
        filter.createdBy = { $in: [...subtree].map(id => id.toString()) }  // ensure strings
      } else {
        filter.createdBy = req.user._id.toString()
      }
    }

    const quotations = await Quotation.find(filter)
      .sort({ createdAt: -1 })
      .select('quoteNumber customer.companyName grandTotal status version createdAt')

    res.status(200).json({ total: quotations.length, quotations })

  } catch (error) {
    console.error('Get quotations error:', error)
    res.status(500).json({ message: 'Failed to fetch quotations', error: error.message })
  }
}

// ── FUNCTION 3 — Get single Quotation ─────────
const getQuotationById = async (req, res) => {
  try {
    const { id }   = req.params
    const tenantId = req.user.tenantId

    const quotation = await Quotation.findOne({ _id: id, tenantId })
    if (!quotation) {
      return res.status(404).json({ message: 'Quotation not found' })
    }

    res.status(200).json(quotation)

  } catch (error) {
    console.error('Get quotation error:', error)
    res.status(500).json({ message: 'Failed to fetch quotation', error: error.message })
  }
}

// ── FUNCTION 4 — Update Quotation status ──────
const updateQuotationStatus = async (req, res) => {
  try {
    const { id }   = req.params
    const tenantId = req.user.tenantId
    const { status, reasonForLoss, notes, followUpDate } = req.body

    const quotation = await Quotation.findOne({ _id: id, tenantId })
    if (!quotation) {
      return res.status(404).json({ message: 'Quotation not found' })
    }

    if (status === 'Not Awarded' && !reasonForLoss?.trim()) {
      return res.status(400).json({
        message: 'Reason for loss is required when marking as Not Awarded',
        field:   'reasonForLoss',
      })
    }

    let awardedAt = quotation.awardedAt
    if (status === 'Awarded' && !quotation.awardedAt) {
      awardedAt = new Date()
    }

    let newFollowUpDate = followUpDate || quotation.followUpDate
    if (status === 'Sent' && !quotation.followUpDate && !followUpDate) {
      const sevenDays = new Date()
      sevenDays.setDate(sevenDays.getDate() + 7)
      newFollowUpDate = sevenDays
    }

    // Clear remindersSent when user explicitly changes followUpDate
    const followUpDateChanged = followUpDate &&
      quotation.followUpDate?.toISOString().split('T')[0] !==
      new Date(followUpDate).toISOString().split('T')[0]

    const updated = await Quotation.findOneAndUpdate(
      { _id: id, tenantId },
      {
        $set: {
          status,
          reasonForLoss: reasonForLoss || '',
          notes:         notes         || quotation.notes,
          followUpDate:  newFollowUpDate,
          awardedAt,
          ...(followUpDateChanged ? { remindersSent: [] } : {}),
        },
      },
      { new: true }
    )

    res.status(200).json({ message: 'Quotation updated successfully', quotation: updated })

  } catch (error) {
    console.error('Update quotation error:', error)
    res.status(500).json({ message: 'Failed to update quotation', error: error.message })
  }
}

// ── FUNCTION 5 — Get tracker Quotations ───────
// Data visibility scoping:
//   isTenantAdmin → all quotes in tenant
//   role=team_lead → own quotes + full subtree
//   individual     → own quotes only
//   viewUserId query param → show specific user's quotes (for lead drilling down)
const getTrackerQuotations = async (req, res) => {
  try {
    const tenantId = req.user.tenantId
    const filter   = { tenantId }

    // Apply status filter if provided
    if (req.query.status) filter.status = req.query.status

    // ── Scope by role ───────────────────────────
    // viewUserId is explicit override — always applied when present
    if (req.query.viewUserId) {
      filter.createdBy = req.query.viewUserId
    } else if (!req.user.isTenantAdmin && req.user.role !== 'super_admin') {
      if (req.user.role === 'team_lead') {
        const subtree = await getSubtreeUserIds(req.user._id, tenantId)
        filter.createdBy = { $in: [...subtree].map(id => id.toString()) }
      } else {
        filter.createdBy = req.user._id.toString()
      }
    }
    console.log('[Tracker] filter.createdBy:', JSON.stringify(filter.createdBy || 'all'))

    const allQuotations = await Quotation.find(filter)
      .sort({ createdAt: -1 })
      .select(
        'quoteNumber customer grandTotal currency currencySymbol ' +
        'status version followUpDate awardedAt originalQuoteId ' +
        'reasonForLoss notes createdAt createdBy createdByName'
      )

    const today     = new Date()
    const familyMap = {}

    allQuotations.forEach(q => {
      const qObj = q.toObject()

      qObj.isOverdue = (
        q.followUpDate &&
        new Date(q.followUpDate) < today &&
        ['Sent', 'In Progress'].includes(q.status)
      )

      const rootId = q.originalQuoteId
        ? q.originalQuoteId.toString()
        : q._id.toString()

      if (!familyMap[rootId]) {
        familyMap[rootId] = { latest: qObj, versions: [qObj] }
      } else {
        familyMap[rootId].versions.push(qObj)
        if (qObj.version > familyMap[rootId].latest.version) {
          familyMap[rootId].latest = qObj
        }
      }
    })

    const trackerRows = Object.values(familyMap).map(family => ({
      ...family.latest,
      allVersions:         family.versions.sort((a, b) => b.version - a.version),
      hasMultipleVersions: family.versions.length > 1,
    }))

    trackerRows.sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt))

    res.status(200).json({ total: trackerRows.length, quotations: trackerRows })

  } catch (error) {
    console.error('Get tracker quotations error:', error)
    res.status(500).json({ message: 'Failed to fetch quotations', error: error.message })
  }
}

// ── FUNCTION 6 — Create new Quotation version ─
const createQuotationVersion = async (req, res) => {
  try {
    const { id }   = req.params
    const tenantId = req.user.tenantId

    const original = await Quotation.findOne({ _id: id, tenantId })
    if (!original) {
      return res.status(404).json({ message: 'Original quotation not found' })
    }

    if (!original.quoteNumber) {
      return res.status(400).json({
        message: 'Cannot version a quotation that has no quote number.',
      })
    }

    const rootId = original.originalQuoteId || original._id

    const latestVersion = await Quotation.findOne({
      tenantId,
      $or: [{ _id: rootId }, { originalQuoteId: rootId }],
    }).sort({ version: -1 })

    const nextVersion    = (latestVersion?.version || 1) + 1
    const baseNumber     = original.quoteNumber.replace(/-V\d+$/, '')
    const newQuoteNumber = `${baseNumber}-V${nextVersion}`

    const existing = await Quotation.findOne({ quoteNumber: newQuoteNumber, tenantId })
    if (existing) {
      return res.status(409).json({
        message: 'Version already exists. Please refresh and try again.',
      })
    }

    const newFollowUpDate = new Date()
    newFollowUpDate.setDate(newFollowUpDate.getDate() + 7)

    const submitted = req.body || {}

    let finalParts = original.parts
    let finalTotal = original.grandTotal

    if (submitted.parts?.length > 0) {
      finalParts = submitted.parts.map(part => {
        const qty   = parseFloat(part.quantity)  || 0
        const price = parseFloat(part.unitPrice) || 0
        return {
          partNumber:     part.partNumber     || '',
          description:    part.description    || '',
          specifications: part.specifications || '',
          unit:           part.unit           || 'Pieces',
          quantity:       qty,
          unitPrice:      price,
          totalPrice:     parseFloat((qty * price).toFixed(2)),
          customFields:   part.customFields   || {},
        }
      })
      finalTotal = finalParts.reduce((sum, p) => sum + (p.totalPrice || 0), 0)
    }

    const newVersion = await Quotation.create({
      customer:           submitted.customer           || original.customer,
      parts:              finalParts,
      grandTotal:         finalTotal,
      termsAndConditions: submitted.termsAndConditions || original.termsAndConditions,
      attachments:        original.attachments,
      currency:           submitted.currency           || original.currency,
      currencySymbol:     submitted.currencySymbol     || original.currencySymbol,
      quoteNumber:        newQuoteNumber,
      version:            nextVersion,
      status:             'Draft',
      originalQuoteId:    rootId,
      followUpDate:       newFollowUpDate,
      tenantId,
      createdBy:          req.user._id,
      createdByName:      `${req.user.firstName || ''} ${req.user.lastName || ''}`.trim(),
      creatorEmail:       req.user.email || '',
      awardedAt:          null,
      reasonForLoss:      '',
      notes:              '',
    })

    res.status(201).json({
      message:   `Version ${nextVersion} created successfully`,
      quotation: newVersion,
    })

  } catch (error) {
    console.error('Create version error:', error)
    res.status(500).json({ message: 'Failed to create new version', error: error.message })
  }
}

module.exports = {
  createQuotation,
  getAllQuotations,
  getQuotationById,
  updateQuotationStatus,
  getTrackerQuotations,
  createQuotationVersion,
}
