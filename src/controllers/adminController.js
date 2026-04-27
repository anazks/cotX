// adminController.js — All super admin operations.

const crypto    = require('crypto')
const bcrypt    = require('bcryptjs')
const User      = require('../models/User')
const Tenant    = require('../models/Tenant')
const Quotation = require('../models/Quotation')
const Tool      = require('../models/Tool')
const { CORE_TOOL_CODE } = require('../config/platform')
const { TOOLS, ALL_TOOL_CODES, isValidTool, getToolFeatures } = require('../config/tools')
const {
  sendDeletionRequestEmail,
  sendDeletionCancelledEmail,
} = require('../jobs/emailService')

// Models that may not exist yet — require safely
let Customer, Part, Counter
try { Customer = require('../models/Customer') } catch { Customer = null }
try { Part     = require('../models/Part')     } catch { Part     = null }
try { Counter  = require('../models/Counter')  } catch { Counter  = null }

// ── HELPER — Calculate licence expiry ─────────
// Always sets expiry to the 1st of a month
const calculateExpiryDate = (startDate, validityMonths) => {
  const expiry = new Date(startDate)
  expiry.setMonth(expiry.getMonth() + parseInt(validityMonths))
  expiry.setDate(1)
  expiry.setHours(0, 0, 0, 0)
  return expiry
}

// ── FUNCTION 1 — Get all available tools ──────
const getTools = async (req, res) => {
  res.status(200).json({
    tools: Object.values(TOOLS).map(t => ({
      code: t.code, name: t.name,
      description: t.description, icon: t.icon,
    }))
  })
}

// ── FUNCTION 2 — Get admin dashboard stats ────
const getAdminStats = async (req, res) => {
  try {
    const allTenants    = await Tenant.find({})
    const totalTenants  = allTenants.length
    const activeTenants = allTenants.filter(t => t.isActive).length
    const totalUsers    = await User.countDocuments({ role: { $ne: 'super_admin' } })
    const activeUsers   = await User.countDocuments({
      role: { $ne: 'super_admin' }, isActive: true,
    })
    const totalQuotations = await Quotation.countDocuments({})

    const firstOfMonth = new Date()
    firstOfMonth.setDate(1)
    firstOfMonth.setHours(0, 0, 0, 0)
    const quotationsThisMonth = await Quotation.countDocuments({
      createdAt: { $gte: firstOfMonth },
    })

    const tenantBreakdown = await Promise.all(
      allTenants.map(async (tenant) => {
        const userCount = await User.countDocuments({
          tenantId: tenant.tenantId,
          role: { $ne: 'super_admin' },
        })
        const quoteCount = await Quotation.countDocuments({ tenantId: tenant.tenantId })
        const quotationsThisMonthForTenant = await Quotation.countDocuments({
          tenantId: tenant.tenantId,
          createdAt: { $gte: firstOfMonth },
        })
        const lastQuotation = await Quotation.findOne({ tenantId: tenant.tenantId })
          .sort({ createdAt: -1 }).select('createdAt')

        const toolSummary = (tenant.activeTools || []).map(t => ({
          toolCode: t.toolCode,
          name:     TOOLS[t.toolCode]?.name || t.toolCode,
          isActive: t.isActive,
        }))

        return {
          _id:           tenant._id,
          tenantId:      tenant.tenantId,
          companyName:   tenant.companyName,
          isActive:      tenant.isActive,
          userCount,
          maxUsers:      tenant.maxUsers,
          quoteCount,
          quotationsThisMonth: quotationsThisMonthForTenant,
          lastActivityAt: lastQuotation?.createdAt || null,
          activeTools:   toolSummary,
        }
      })
    )

    tenantBreakdown.sort((a, b) => b.quoteCount - a.quoteCount)

    res.status(200).json({
      summary: {
        totalTenants, activeTenants,
        totalUsers, activeUsers,
        totalQuotations, quotationsThisMonth,
      },
      tenants: tenantBreakdown,
    })
  } catch (error) {
    console.error('Admin stats error:', error)
    res.status(500).json({ message: 'Failed to fetch stats', error: error.message })
  }
}

// ── FUNCTION 3 — Get all tenants ──────────────
const getAllTenants = async (req, res) => {
  try {
    const tenants = await Tenant.find({}).sort({ createdAt: -1 })
    res.status(200).json({ total: tenants.length, tenants })
  } catch (error) {
    console.error('Get tenants error:', error)
    res.status(500).json({ message: 'Failed to fetch tenants', error: error.message })
  }
}

// ── FUNCTION 4 — Get single tenant ────────────
const getTenant = async (req, res) => {
  try {
    const tenant = await Tenant.findById(req.params.id)
    if (!tenant) {
      return res.status(404).json({ message: 'Tenant not found' })
    }
    const users = await User.find({
      tenantId: tenant.tenantId,
      role:     { $ne: 'super_admin' },
    }).select('-password').sort({ createdAt: -1 })

    const quoteCount = await Quotation.countDocuments({ tenantId: tenant.tenantId })

    // Return tenant without base64 file data (too large for list views)
    const tenantObj = tenant.toObject()
    if (tenantObj.excelTemplate) tenantObj.excelTemplate.fileBase64 = tenantObj.excelTemplate.fileBase64 ? '[uploaded]' : ''
    if (tenantObj.wordTemplate)   tenantObj.wordTemplate.fileBase64   = tenantObj.wordTemplate.fileBase64   ? '[uploaded]' : ''

    res.status(200).json({ tenant: tenantObj, users, quoteCount })
  } catch (error) {
    console.error('Get tenant error:', error)
    res.status(500).json({ message: 'Failed to fetch tenant', error: error.message })
  }
}

// ── FUNCTION 5 — Create new tenant ────────────
const createTenant = async (req, res) => {
  try {
    const {
      tenantId, companyName, address, gst,
      maxUsers, activeTools, pdfBranding,
      defaultFollowUpDays, defaultTerms, adminNotes,
    } = req.body

    if (!tenantId || !companyName) {
      return res.status(400).json({
        message: 'Tenant ID and company name are required',
      })
    }

    const existing = await Tenant.findOne({ tenantId })
    if (existing) {
      return res.status(409).json({
        message: `Tenant ID "${tenantId}" is already taken`,
      })
    }

    const validatedTools = (activeTools || [])
      .filter(t => t.toolCode)  // keep any tool that has a code
      .map(t => ({ toolCode: t.toolCode, isActive: t.isActive !== false }))

    if (validatedTools.length === 0) {
      validatedTools.push({ toolCode: 'quotex', isActive: true })
    }

    const newTenant = await Tenant.create({
      tenantId:            tenantId.toLowerCase().trim(),
      companyName,
      address:             address             || '',
      gst:                 gst                 || '',
      maxUsers:            maxUsers            || 5,
      activeTools:         validatedTools,
      // NEW TENANTS DEFAULT TO ACTIVE
      isActive:            true,
      defaultFollowUpDays: defaultFollowUpDays || 7,
      defaultTerms:        defaultTerms        || '',
      adminNotes:          adminNotes          || '',
      pdfBranding: {
        companyName:    pdfBranding?.companyName    || companyName,
        companyAddress: pdfBranding?.companyAddress || address || '',
        companyPhone:   pdfBranding?.companyPhone   || '',
        companyEmail:   pdfBranding?.companyEmail   || '',
        companyWebsite: pdfBranding?.companyWebsite || '',
        logoUrl:        pdfBranding?.logoUrl        || '',
        primaryColor:   pdfBranding?.primaryColor   || '#1a3c5e',
        footerNote:     pdfBranding?.footerNote     ||
          'This is a computer generated quotation. No signature required.',
      },
    })

    res.status(201).json({
      message: 'Tenant created successfully',
      tenant:  newTenant,
    })
  } catch (error) {
    console.error('Create tenant error:', error)
    res.status(500).json({ message: 'Failed to create tenant', error: error.message })
  }
}

// ── FUNCTION 6 — Update tenant settings ───────
const updateTenant = async (req, res) => {
  try {
    const tenant = await Tenant.findById(req.params.id)
    if (!tenant) {
      return res.status(404).json({ message: 'Tenant not found' })
    }

    const {
      companyName, address, gst, maxUsers,
      activeTools, isActive, pdfBranding,
      defaultFollowUpDays, defaultTerms, adminNotes,
    } = req.body

    // Validate activeTools if provided
    let validatedTools = tenant.activeTools
    if (activeTools) {
      validatedTools = activeTools
        .filter(t => t.toolCode)  // keep any tool that has a code
        .map(t => ({ toolCode: t.toolCode, isActive: t.isActive !== false }))
    }

    const updated = await Tenant.findByIdAndUpdate(
      req.params.id,
      {
        $set: {
          companyName:         companyName         || tenant.companyName,
          address:             address             !== undefined ? address : tenant.address,
          gst:                 gst                 !== undefined ? gst    : tenant.gst,
          maxUsers:            maxUsers            || tenant.maxUsers,
          activeTools:         validatedTools,
          isActive:            isActive            !== undefined ? isActive : tenant.isActive,
          defaultFollowUpDays: defaultFollowUpDays || tenant.defaultFollowUpDays,
          defaultTerms:        defaultTerms        !== undefined ? defaultTerms : tenant.defaultTerms,
          adminNotes:          adminNotes          !== undefined ? adminNotes  : tenant.adminNotes,
          // Merge incoming pdfBranding with existing DB values.
          // This preserves fields the frontend does not send (companyWebsite, logoUrl)
          // while updating only the fields that came in from the settings form.
          // Using spread: DB values first, then incoming — incoming wins on overlap.
          pdfBranding: {
            ...(tenant.pdfBranding || {}),
            ...(pdfBranding        || {}),
          },
        },
      },
      { returnDocument: 'after' }
    )

    res.status(200).json({
      message: 'Tenant updated successfully',
      tenant:  updated,
    })
  } catch (error) {
    console.error('Update tenant error:', error)
    res.status(500).json({ message: 'Failed to update tenant', error: error.message })
  }
}

// ── FUNCTION 7 — Toggle tenant active ─────────
const toggleTenant = async (req, res) => {
  try {
    const tenant = await Tenant.findById(req.params.id)
    if (!tenant) {
      return res.status(404).json({ message: 'Tenant not found' })
    }

    const updated = await Tenant.findByIdAndUpdate(
      req.params.id,
      { $set: { isActive: !tenant.isActive } },
      { returnDocument: 'after' }
    )

    res.status(200).json({
      message: `Tenant ${updated.isActive ? 'activated' : 'deactivated'} successfully`,
      tenant:  updated,
    })
  } catch (error) {
    console.error('Toggle tenant error:', error)
    res.status(500).json({ message: 'Failed to toggle tenant', error: error.message })
  }
}

// ── FUNCTION 8 — Upload Excel template ────────
// Receives base64 encoded file, stores in Tenant document
const uploadExcelTemplate = async (req, res) => {
  try {
    const { fileName, fileBase64 } = req.body

    if (!fileName || !fileBase64) {
      return res.status(400).json({ message: 'fileName and fileBase64 are required' })
    }

    if (!fileName.endsWith('.xlsx') && !fileName.endsWith('.xls')) {
      return res.status(400).json({ message: 'Only .xlsx or .xls files allowed' })
    }

    const updated = await Tenant.findByIdAndUpdate(
      req.params.id,
      {
        $set: {
          'excelTemplate.fileName':   fileName,
          'excelTemplate.fileBase64': fileBase64,
          'excelTemplate.uploadedAt': new Date(),
        }
      },
      { returnDocument: 'after' }
    )

    if (!updated) {
      return res.status(404).json({ message: 'Tenant not found' })
    }

    res.status(200).json({
      message:  'Excel template uploaded successfully',
      fileName: updated.excelTemplate.fileName,
      uploadedAt: updated.excelTemplate.uploadedAt,
    })
  } catch (error) {
    console.error('Upload excel template error:', error)
    res.status(500).json({ message: 'Failed to upload template', error: error.message })
  }
}

// ── FUNCTION 9 — Upload RFQ Word template ─────
const uploadWordTemplate = async (req, res) => {
  try {
    const { fileName, fileBase64 } = req.body

    if (!fileName || !fileBase64) {
      return res.status(400).json({ message: 'fileName and fileBase64 are required' })
    }

    if (!fileName.endsWith('.docx') && !fileName.endsWith('.doc')) {
      return res.status(400).json({ message: 'Only .docx or .doc files allowed' })
    }

    const updated = await Tenant.findByIdAndUpdate(
      req.params.id,
      {
        $set: {
          'wordTemplate.fileName':   fileName,
          'wordTemplate.fileBase64': fileBase64,
          'wordTemplate.uploadedAt': new Date(),
        }
      },
      { returnDocument: 'after' }
    )

    if (!updated) {
      return res.status(404).json({ message: 'Tenant not found' })
    }

    res.status(200).json({
      message:  'Word template uploaded successfully',
      fileName: updated.wordTemplate.fileName,
      uploadedAt: updated.wordTemplate.uploadedAt,
    })
  } catch (error) {
    console.error('Upload Word template error:', error)
    res.status(500).json({ message: 'Failed to upload template', error: error.message })
  }
}

// ── FUNCTION 10 — Download Excel template ─────
const downloadExcelTemplate = async (req, res) => {
  try {
    const tenant = await Tenant.findById(req.params.id).select('excelTemplate')
    if (!tenant || !tenant.excelTemplate?.fileBase64) {
      return res.status(404).json({ message: 'No Excel template uploaded for this tenant' })
    }

    const buffer = Buffer.from(tenant.excelTemplate.fileBase64, 'base64')
    res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet')
    res.setHeader('Content-Disposition', `attachment; filename="${tenant.excelTemplate.fileName}"`)
    res.send(buffer)
  } catch (error) {
    console.error('Download excel template error:', error)
    res.status(500).json({ message: 'Failed to download template', error: error.message })
  }
}

// ── FUNCTION 11 — Download RFQ template ───────
const downloadWordTemplate = async (req, res) => {
  try {
    const tenant = await Tenant.findById(req.params.id).select('wordTemplate')
    if (!tenant || !tenant.wordTemplate?.fileBase64) {
      return res.status(404).json({ message: 'No Word template uploaded for this tenant' })
    }

    const buffer = Buffer.from(tenant.wordTemplate.fileBase64, 'base64')
    res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.wordprocessingml.document')
    res.setHeader('Content-Disposition', `attachment; filename="${tenant.wordTemplate.fileName}"`)
    res.send(buffer)
  } catch (error) {
    console.error('Download Word template error:', error)
    res.status(500).json({ message: 'Failed to download template', error: error.message })
  }
}
// ── FUNCTION — Upload tenant logo ──────────────
const uploadLogo = async (req, res) => {
  try {
    const { fileName, fileBase64, mimeType } = req.body

    if (!fileName || !fileBase64) {
      return res.status(400).json({ message: 'fileName and fileBase64 are required' })
    }

    // Validate it is an image
    const validTypes = ['image/png', 'image/jpeg', 'image/jpg', 'image/svg+xml', 'image/webp']
    const detectedType = mimeType || 'image/png'
    if (!validTypes.some(t => detectedType.includes(t.split('/')[1]))) {
      return res.status(400).json({ message: 'Only PNG, JPG, SVG or WebP images allowed' })
    }

    const updated = await Tenant.findByIdAndUpdate(
      req.params.id,
      {
        $set: {
          'logo.fileName':   fileName,
          'logo.fileBase64': fileBase64,
          'logo.mimeType':   detectedType,
          'logo.uploadedAt': new Date(),
        }
      },
      { returnDocument: 'after' }
    )

    if (!updated) {
      return res.status(404).json({ message: 'Tenant not found' })
    }

    res.status(200).json({
      message:    'Logo uploaded successfully',
      fileName:   updated.logo.fileName,
      uploadedAt: updated.logo.uploadedAt,
    })

  } catch (error) {
    console.error('Upload logo error:', error)
    res.status(500).json({ message: 'Failed to upload logo', error: error.message })
  }
}
// ── FUNCTION 12 — Create user ─────────────────
const createUser = async (req, res) => {
  try {
    const { tenantId, firstName, lastName, email, password, role, toolAccess } = req.body

    if (!tenantId || !firstName || !lastName || !email || !password) {
      return res.status(400).json({
        message: 'Tenant ID, name, email and password are required',
      })
    }

    const tenant = await Tenant.findOne({ tenantId })
    if (!tenant) {
      return res.status(404).json({ message: 'Tenant not found' })
    }

    // Block user creation if tenant is inactive
    if (!tenant.isActive) {
      return res.status(403).json({
        message: 'Cannot add users to an inactive tenant. Please activate the tenant first.',
      })
    }

    // Check user limit
    const currentCount = await User.countDocuments({
      tenantId, role: { $ne: 'super_admin' },
    })
    if (currentCount >= tenant.maxUsers) {
      return res.status(403).json({
        message: `Maximum user limit of ${tenant.maxUsers} reached for this tenant`,
      })
    }

    const existing = await User.findOne({ email })
    if (existing) {
      return res.status(409).json({ message: 'Email already in use' })
    }

    // Build toolAccess with per-tool expiry
    const tenantToolCodes = tenant.activeTools
      .filter(t => t.isActive)
      .map(t => t.toolCode)

    const validatedToolAccess = (toolAccess || [])
      .filter(t => t.toolCode && tenantToolCodes.includes(t.toolCode))
      .map(t => {
        const months = parseInt(t.validityMonths) || 12
        return {
          toolCode:         t.toolCode,
          licence:          t.licence || 'basic',
          licenceExpiresAt: calculateExpiryDate(new Date(), months),
          isActive:         true,
        }
      })

    // Default — assign all tenant tools with basic licence
    if (validatedToolAccess.length === 0) {
      tenantToolCodes.forEach(code => {
        validatedToolAccess.push({
          toolCode:         code,
          licence:          'basic',
          licenceExpiresAt: calculateExpiryDate(new Date(), 12),
          isActive:         true,
        })
      })
    }

    const quotexAccess  = validatedToolAccess.find(t => t.toolCode === 'quotex')
    const legacyLicence = quotexAccess?.licence || 'basic'

    const newUser = await User.create({
      firstName, lastName, email, password,
      role:       role || 'individual',
      licence:    legacyLicence,
      tenantId,
      toolAccess: validatedToolAccess,
      isActive:   true,
    })

    await Tenant.findOneAndUpdate(
      { tenantId },
      { $inc: { 'stats.totalUsers': 1 } }
    )

    res.status(201).json({ message: 'User created successfully', user: newUser })
  } catch (error) {
    console.error('Create user error:', error)
    res.status(500).json({ message: 'Failed to create user', error: error.message })
  }
}

// ── FUNCTION 13 — Get user ────────────────────
const getUser = async (req, res) => {
  try {
    const user = await User.findById(req.params.id).select('-password')
    if (!user) return res.status(404).json({ message: 'User not found' })
    res.status(200).json({ user })
  } catch (error) {
    res.status(500).json({ message: 'Failed to fetch user', error: error.message })
  }
}

// ── FUNCTION 14 — Update user ─────────────────
const updateUser = async (req, res) => {
  try {
    const { firstName, lastName, role, toolAccess, isActive } = req.body
    const user = await User.findById(req.params.id)
    if (!user) return res.status(404).json({ message: 'User not found' })

    let updatedToolAccess = user.toolAccess
    if (toolAccess) {
      updatedToolAccess = toolAccess
        .filter(t => t.toolCode)
        .map(t => {
          const months = parseInt(t.validityMonths) || 12
          return {
            toolCode:         t.toolCode,
            licence:          t.licence   || 'basic',
            licenceExpiresAt: t.licenceExpiresAt
              ? new Date(t.licenceExpiresAt)
              : calculateExpiryDate(new Date(), months),
            isActive: t.isActive !== false,
          }
        })

      const quotexAccess = updatedToolAccess.find(t => t.toolCode === 'quotex')
      if (quotexAccess) {
        await User.findByIdAndUpdate(req.params.id, {
          $set: { licence: quotexAccess.licence }
        })
      }
    }

    const updated = await User.findByIdAndUpdate(
      req.params.id,
      {
        $set: {
          firstName:  firstName  || user.firstName,
          lastName:   lastName   || user.lastName,
          role:       role       || user.role,
          toolAccess: updatedToolAccess,
          isActive:   isActive   !== undefined ? isActive : user.isActive,
        },
      },
      { returnDocument: 'after', select: '-password' }
    )

    res.status(200).json({ message: 'User updated successfully', user: updated })
  } catch (error) {
    res.status(500).json({ message: 'Failed to update user', error: error.message })
  }
}

// ── FUNCTION 15 — Reset password ──────────────
const resetPassword = async (req, res) => {
  try {
    const { newPassword } = req.body
    if (!newPassword || newPassword.length < 6) {
      return res.status(400).json({ message: 'Password must be at least 6 characters' })
    }
    const user = await User.findById(req.params.id)
    if (!user) return res.status(404).json({ message: 'User not found' })

    const salt   = await bcrypt.genSalt(10)
    const hashed = await bcrypt.hash(newPassword, salt)

    await User.findByIdAndUpdate(req.params.id, { $set: { password: hashed } })
    res.status(200).json({
      message: 'Password reset successfully',
      email:   user.email,
      note:    'Share the new password with the user securely.',
    })
  } catch (error) {
    res.status(500).json({ message: 'Failed to reset password', error: error.message })
  }
}

// ── FUNCTION 16 — Toggle user ─────────────────
const toggleUser = async (req, res) => {
  try {
    const user = await User.findById(req.params.id)
    if (!user) return res.status(404).json({ message: 'User not found' })
    if (user.role === 'super_admin') {
      return res.status(403).json({ message: 'Cannot deactivate the super admin account' })
    }
    const updated = await User.findByIdAndUpdate(
      req.params.id,
      { $set: { isActive: !user.isActive } },
      { returnDocument: 'after', select: '-password' }
    )
    res.status(200).json({
      message: `User ${updated.isActive ? 'activated' : 'deactivated'}`,
      user:    updated,
    })
  } catch (error) {
    res.status(500).json({ message: 'Failed to toggle user', error: error.message })
  }
}



// ── TOOL CRUD ─────────────────────────────────────────────────────────
// These functions manage the Tool collection in MongoDB.
// The Tool collection drives the launcher and tool assignments.
// tools.js (config) is separate — it defines feature tiers per tool code.

const getAllTools = async (req, res) => {
  try {
    const tools = await Tool.find().sort({ sortOrder: 1, name: 1 })
    res.status(200).json({ tools })
  } catch (error) {
    console.error('Get all tools error:', error)
    res.status(500).json({ message: 'Failed to fetch tools', error: error.message })
  }
}

const createTool = async (req, res) => {
  try {
    const { code, name, description, iconEmoji, route, status, sortOrder } = req.body
    if (!code || !name) {
      return res.status(400).json({ message: 'Tool code and name are required' })
    }
    const existing = await Tool.findOne({ code: code.toLowerCase().trim() })
    if (existing) {
      return res.status(409).json({ message: `Tool with code "${code}" already exists` })
    }
    const tool = await Tool.create({
      code:        code.toLowerCase().trim(),
      name:        name.trim(),
      description: description?.trim() || '',
      iconEmoji:   iconEmoji || '🔧',
      route:       route?.trim() || '',
      status:      status || 'active',
      sortOrder:   Number(sortOrder) || 99,
    })
    res.status(201).json({ message: 'Tool created', tool })
  } catch (error) {
    console.error('Create tool error:', error)
    res.status(500).json({ message: 'Failed to create tool', error: error.message })
  }
}

const updateTool = async (req, res) => {
  try {
    const { name, description, iconEmoji, route, status, sortOrder } = req.body
    const tool = await Tool.findByIdAndUpdate(
      req.params.id,
      { $set: {
        name:        name?.trim(),
        description: description?.trim() || '',
        iconEmoji:   iconEmoji || '🔧',
        route:       route?.trim() || '',
        status,
        sortOrder:   Number(sortOrder) || 99,
      }},
      { new: true }
    )
    if (!tool) return res.status(404).json({ message: 'Tool not found' })
    res.status(200).json({ message: 'Tool updated', tool })
  } catch (error) {
    console.error('Update tool error:', error)
    res.status(500).json({ message: 'Failed to update tool', error: error.message })
  }
}

const uploadToolIcon = async (req, res) => {
  try {
    const { fileBase64, mimeType, fileName } = req.body
    if (!fileBase64) return res.status(400).json({ message: 'No icon data provided' })
    const tool = await Tool.findByIdAndUpdate(
      req.params.id,
      { $set: { icon: { fileBase64, mimeType: mimeType || 'image/png', fileName: fileName || 'icon', uploadedAt: new Date() } } },
      { new: true }
    )
    if (!tool) return res.status(404).json({ message: 'Tool not found' })
    res.status(200).json({ message: 'Icon uploaded', tool })
  } catch (error) {
    console.error('Upload tool icon error:', error)
    res.status(500).json({ message: 'Failed to upload icon', error: error.message })
  }
}

const deleteTool = async (req, res) => {
  try {
    const tool = await Tool.findById(req.params.id)
    if (!tool) return res.status(404).json({ message: 'Tool not found' })
    if (tool.code === CORE_TOOL_CODE) {
      return res.status(403).json({ message: `Cannot delete the core platform tool (${tool.code})` })
    }
    await Tool.findByIdAndDelete(req.params.id)
    res.status(200).json({ message: 'Tool deleted' })
  } catch (error) {
    console.error('Delete tool error:', error)
    res.status(500).json({ message: 'Failed to delete tool', error: error.message })
  }
}

// ── FUNCTION — Update tenant reminder settings ──
// PATCH /api/admin/tenants/:id/reminder-settings
const updateReminderSettings = async (req, res) => {
  try {
    const tenant = await Tenant.findById(req.params.id)
    if (!tenant) return res.status(404).json({ message: 'Tenant not found' })

    const {
      isActive, frequency, dayOfWeek,
      dayOfMonth, timeHour, overdueWindowDays,
    } = req.body

    const validFrequencies = ['daily', 'weekly', 'monthly']
    if (frequency && !validFrequencies.includes(frequency)) {
      return res.status(400).json({ message: 'frequency must be daily, weekly, or monthly' })
    }

    const existing = tenant.reminderSettings || {}
    const merged = {
      isActive:          isActive          !== undefined ? isActive                    : (existing.isActive ?? true),
      frequency:         frequency         !== undefined ? frequency                   : (existing.frequency ?? 'weekly'),
      dayOfWeek:         dayOfWeek         !== undefined ? parseInt(dayOfWeek)         : (existing.dayOfWeek ?? 1),
      dayOfMonth:        dayOfMonth        !== undefined ? parseInt(dayOfMonth)        : (existing.dayOfMonth ?? 1),
      timeHour:          timeHour          !== undefined ? parseInt(timeHour)          : (existing.timeHour ?? 9),
      overdueWindowDays: overdueWindowDays !== undefined ? parseInt(overdueWindowDays) : (existing.overdueWindowDays ?? 21),
    }

    const updated = await Tenant.findByIdAndUpdate(
      req.params.id,
      { $set: { reminderSettings: merged } },
      { returnDocument: 'after' }
    )

    res.status(200).json({
      message:          'Reminder settings saved',
      reminderSettings: updated.reminderSettings,
    })
  } catch (error) {
    console.error('Update reminder settings error:', error)
    res.status(500).json({ message: 'Failed to save reminder settings', error: error.message })
  }
}

// ── FUNCTION — Trigger reminder job for ONE tenant immediately ──
// POST /api/admin/tenants/:id/test-reminder-job
// Scoped to the specific tenant only — does NOT fire for other tenants.
const triggerReminderJob = async (req, res) => {
  try {
    // Resolve tenantId string from the MongoDB _id in the URL param
    const tenant = await Tenant.findById(req.params.id).select('tenantId companyName isActive')
    if (!tenant) return res.status(404).json({ message: 'Tenant not found' })
    if (!tenant.isActive) return res.status(400).json({ message: 'Tenant is inactive — reminders are paused' })

    // Import here to avoid circular dependency with index.js startup order
    const { runReminderCheck } = require('../jobs/reminderJob')

    // Pass tenantId to scope the job to this tenant only, not all tenants
    const results = await runReminderCheck(true, tenant.tenantId)

    const totalProcessed = results.reduce((sum, r) => sum + (r.processed || 0), 0)
    const totalEmails    = results.reduce((sum, r) => sum + (r.emailsSent || 0), 0)

    res.status(200).json({
      message:       `Reminder job completed for ${tenant.companyName}. ${totalEmails} email(s) sent.`,
      summary:       { tenant: tenant.tenantId, totalProcessed, totalEmails },
      tenantResults: results,
    })
  } catch (error) {
    console.error('Trigger reminder job error:', error)
    res.status(500).json({ message: 'Reminder job failed', error: error.message })
  }
}

// ══════════════════════════════════════════════════════════════
// FUNCTION — Set Tenant Admin
// PATCH /api/admin/users/:id/set-admin
// Super admin only. Sets isTenantAdmin on a user.
// Clears isTenantAdmin from all other users in the same tenant first —
// enforcing the one-admin-per-tenant rule.
// ══════════════════════════════════════════════════════════════
const setTenantAdmin = async (req, res) => {
  try {
    const user = await User.findById(req.params.id).select('-password')
    if (!user) return res.status(404).json({ message: 'User not found' })
    if (user.role === 'super_admin') {
      return res.status(400).json({ message: 'Cannot set super_admin as tenant admin' })
    }

    // Clear existing admin in this tenant
    await User.updateMany(
      { tenantId: user.tenantId, isTenantAdmin: true },
      { $set: { isTenantAdmin: false } }
    )

    // Set new admin
    const updated = await User.findByIdAndUpdate(
      req.params.id,
      { $set: { isTenantAdmin: true } },
      { returnDocument: 'after', select: '-password' }
    )

    res.status(200).json({
      message: `${updated.firstName} ${updated.lastName} is now the tenant admin.`,
      user: updated,
    })
  } catch (err) {
    console.error('setTenantAdmin error:', err)
    res.status(500).json({ message: 'Failed to set tenant admin', error: err.message })
  }
}

// ══════════════════════════════════════════════════════════════
// FUNCTION — Replace User
// POST /api/admin/users/:id/replace
// Super admin only.
// Creates User B with same tenantId + toolAccess as User A.
// Remaps all quotations from User A to User B.
// Remaps team lead/member assignments.
// Deletes User A.
// ══════════════════════════════════════════════════════════════
const replaceUser = async (req, res) => {
  try {
    const { firstName, lastName, email, password } = req.body

    if (!firstName || !lastName || !email || !password) {
      return res.status(400).json({ message: 'firstName, lastName, email and password are required' })
    }
    if (password.length < 6) {
      return res.status(400).json({ message: 'Password must be at least 6 characters' })
    }

    // Load old user
    const oldUser = await User.findById(req.params.id)
    if (!oldUser) return res.status(404).json({ message: 'User to replace not found' })
    if (oldUser.role === 'super_admin') {
      return res.status(400).json({ message: 'Cannot replace super_admin' })
    }

    // Check new email is not already in use
    const emailTaken = await User.findOne({ email: email.toLowerCase() })
    if (emailTaken) {
      return res.status(409).json({ message: 'Email address is already registered' })
    }

    // Create new user — same tenant, same tool access, same role
    const salt   = await bcrypt.genSalt(10)
    const hashed = await bcrypt.hash(password, salt)

    const newUser = await User.create({
      firstName,
      lastName,
      email:        email.toLowerCase(),
      password:     hashed,
      tenantId:     oldUser.tenantId,
      role:         oldUser.role,
      toolAccess:   oldUser.toolAccess,
      isTenantAdmin: oldUser.isTenantAdmin,
      isActive:     true,
    })

    // Remap all quotations — createdBy points to new user
    // createdByName snapshot intentionally preserved (audit trail)
    const Quotation = require('../models/Quotation')
    const quotationResult = await Quotation.updateMany(
      { createdBy: oldUser._id },
      { $set: { createdBy: newUser._id, creatorEmail: newUser.email } }
    )

    // Remap team lead assignments
    const Team = require('../models/Team')
    await Team.updateMany(
      { leadId: oldUser._id },
      { $set: { leadId: newUser._id } }
    )

    // Remap team member assignments
    await Team.updateMany(
      { memberIds: oldUser._id },
      { $set: { 'memberIds.$[elem]': newUser._id } },
      { arrayFilters: [{ elem: oldUser._id }] }
    )

    // Delete old user
    await User.findByIdAndDelete(oldUser._id)

    res.status(200).json({
      message:         `User replaced successfully. ${quotationResult.modifiedCount} quotation(s) remapped.`,
      newUser:         { _id: newUser._id, firstName, lastName, email: newUser.email },
      quotationsRemapped: quotationResult.modifiedCount,
    })
  } catch (err) {
    console.error('replaceUser error:', err)
    res.status(500).json({ message: 'Failed to replace user', error: err.message })
  }
}

// ── FUNCTION — Request Tenant Deletion ────────
// POST /api/admin/tenants/:id/request-deletion
// Tenant must be deactivated first. If a pending request exists, blocks.
// Generates a one-time token, saves to tenant, sends email to SUPER_ADMIN_EMAIL.
const requestTenantDeletion = async (req, res) => {
  try {
    const tenant = await Tenant.findById(req.params.id)
    if (!tenant) return res.status(404).json({ message: 'Tenant not found' })

    if (tenant.isActive) {
      return res.status(400).json({
        message: 'Tenant must be deactivated before requesting deletion.',
      })
    }

    // Block if a valid pending request already exists
    if (tenant.deletionRequest) {
      const now = new Date()
      if (new Date(tenant.deletionRequest.expiresAt) > now) {
        return res.status(400).json({
          message: 'A deletion request is already pending for this tenant. Check your email for the confirmation link.',
          expiresAt: tenant.deletionRequest.expiresAt,
        })
      }
    }

    const superAdminEmail = process.env.SUPER_ADMIN_EMAIL
    if (!superAdminEmail) {
      return res.status(500).json({
        message: 'SUPER_ADMIN_EMAIL is not set in .env — cannot send deletion confirmation.',
      })
    }

    // Generate a cryptographically secure one-time token
    const token       = crypto.randomBytes(32).toString('hex')
    const requestedAt = new Date()
    const expiresAt   = new Date(requestedAt.getTime() + 24 * 60 * 60 * 1000) // +24h

    await Tenant.findByIdAndUpdate(req.params.id, {
      $set: {
        deletionRequest: { token, requestedAt, expiresAt },
      },
    })

    // Build the confirmation URL
    const baseUrl     = process.env.APP_BASE_URL || 'http://localhost:5000'
    const confirmUrl  = `${baseUrl}/api/auth/confirm-deletion?token=${token}`

    await sendDeletionRequestEmail({
      to:          superAdminEmail,
      tenantName:  tenant.companyName,
      tenantId:    tenant.tenantId,
      confirmUrl,
      expiresAt,
    })

    res.status(200).json({
      message:   'Deletion request created. A confirmation email has been sent to the super admin.',
      expiresAt,
    })
  } catch (err) {
    console.error('requestTenantDeletion error:', err)
    res.status(500).json({ message: 'Failed to create deletion request', error: err.message })
  }
}

// ── FUNCTION — Confirm Tenant Deletion (public, token-based) ──────────
// GET /api/auth/confirm-deletion?token=xxx
// Served as a browser-facing HTML page — no auth header needed.
// If token valid + within 24h → deletes ALL tenant data → shows success page.
// If expired or invalid → shows error page.
const confirmTenantDeletion = async (req, res) => {
  const { token } = req.query

  const renderPage = (title, body, isError = false) => `
<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>${title} — SourceHUB</title>
  <style>
    * { box-sizing: border-box; margin: 0; padding: 0; }
    body { font-family: Arial, sans-serif; background: #f0f4f8; min-height: 100vh;
           display: flex; align-items: center; justify-content: center; padding: 24px; }
    .card { background: #fff; border-radius: 12px; padding: 40px 48px; max-width: 520px;
            width: 100%; box-shadow: 0 4px 24px rgba(0,0,0,0.10); text-align: center; }
    .icon { font-size: 52px; margin-bottom: 20px; }
    h1 { font-size: 22px; color: ${isError ? '#c62828' : '#1a3c5e'}; margin-bottom: 12px; }
    p  { font-size: 14px; color: #555; line-height: 1.7; margin-bottom: 10px; }
    .tag { display: inline-block; background: ${isError ? '#ffebee' : '#e8f5e9'};
           color: ${isError ? '#c62828' : '#2e7d32'}; font-size: 13px; font-weight: 700;
           padding: 6px 16px; border-radius: 20px; margin-top: 8px; }
    .footer { margin-top: 28px; font-size: 12px; color: #aaa; }
  </style>
</head>
<body>
  <div class="card">
    ${body}
    <div class="footer">SourceHUB — Sunserk Technology Solutions</div>
  </div>
</body>
</html>`

  if (!token) {
    return res.status(400).send(renderPage('Invalid Link', `
      <div class="icon">⚠️</div>
      <h1>Invalid Link</h1>
      <p>No deletion token was provided. This link is invalid.</p>
      <span class="tag">No action taken</span>
    `, true))
  }

  try {
    // Find tenant with this exact token
    const tenant = await Tenant.findOne({ 'deletionRequest.token': token })

    if (!tenant) {
      return res.status(404).send(renderPage('Link Not Found', `
        <div class="icon">🔍</div>
        <h1>Link Not Found</h1>
        <p>This confirmation link is invalid or has already been used.</p>
        <span class="tag">No action taken</span>
      `, true))
    }

    // Check expiry
    const now = new Date()
    if (now > new Date(tenant.deletionRequest.expiresAt)) {
      // Clear the expired request so super admin can try again if needed
      await Tenant.findByIdAndUpdate(tenant._id, { $set: { deletionRequest: null } })

      return res.status(410).send(renderPage('Link Expired', `
        <div class="icon">⏰</div>
        <h1>Confirmation Link Expired</h1>
        <p>This deletion request was valid for 24 hours and has now expired.</p>
        <p>Tenant <strong>${tenant.companyName}</strong> has <strong>not</strong> been deleted.</p>
        <p>If you still want to delete this tenant, go to the Admin panel and submit a new deletion request.</p>
        <span class="tag">No action taken</span>
      `, true))
    }

    // ── Token valid and within 24h — execute full deletion ──
    const tenantId   = tenant.tenantId
    const tenantName = tenant.companyName

    // Count records before deletion (for the success page)
    const quotationCount = await Quotation.countDocuments({ tenantId })
    const userCount      = await User.countDocuments({ tenantId })
    const customerCount  = Customer ? await Customer.countDocuments({ tenantId }) : 0
    const partCount      = Part     ? await Part.countDocuments({ tenantId })     : 0

    // Delete all tenant data
    await Quotation.deleteMany({ tenantId })
    await User.deleteMany({ tenantId })
    if (Customer) await Customer.deleteMany({ tenantId })
    if (Part)     await Part.deleteMany({ tenantId })
    if (Counter) {
      // Counter _id format is "tenantId_year"
      await Counter.deleteMany({ _id: new RegExp(`^${tenantId}_`) })
    }
    // Delete the tenant record itself
    await Tenant.findByIdAndDelete(tenant._id)

    console.log(`[Deletion] Tenant "${tenantName}" (${tenantId}) permanently deleted.`)
    console.log(`[Deletion] Removed: ${quotationCount} quotations, ${userCount} users, ${customerCount} customers, ${partCount} parts.`)

    return res.status(200).send(renderPage('Tenant Deleted', `
      <div class="icon">✅</div>
      <h1>Tenant Permanently Deleted</h1>
      <p><strong>${tenantName}</strong> and all associated data have been permanently removed from SourceHUB.</p>
      <br>
      <p style="font-size:13px; color:#888;">
        Deleted: ${quotationCount} quotation${quotationCount !== 1 ? 's' : ''},
        ${userCount} user${userCount !== 1 ? 's' : ''},
        ${customerCount} customer${customerCount !== 1 ? 's' : ''},
        ${partCount} part${partCount !== 1 ? 's' : ''}
      </p>
      <span class="tag">Deletion complete</span>
    `))

  } catch (err) {
    console.error('confirmTenantDeletion error:', err)
    return res.status(500).send(renderPage('Server Error', `
      <div class="icon">❌</div>
      <h1>Something Went Wrong</h1>
      <p>An error occurred while processing the deletion. No data has been deleted.</p>
      <p>Please check the server logs and try again.</p>
      <span class="tag">Error: ${err.message}</span>
    `, true))
  }
}

module.exports = {
  getTools,
  getAllTools,
  createTool,
  updateTool,
  uploadToolIcon,
  deleteTool,
  getAdminStats,
  getAllTenants,
  getTenant,
  createTenant,
  updateTenant,
  toggleTenant,
  uploadExcelTemplate,
  uploadWordTemplate,
  downloadExcelTemplate,
  downloadWordTemplate,
  uploadLogo,
  createUser,
  getUser,
  updateUser,
  resetPassword,
  toggleUser,
  updateReminderSettings,
  triggerReminderJob,
  setTenantAdmin,
  replaceUser,
  requestTenantDeletion,
  confirmTenantDeletion,
}