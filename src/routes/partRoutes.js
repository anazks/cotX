// partRoutes.js — Platform-level parts routes.
// Parts are shared company data accessible across all tools.
// Mounted at /api/parts in index.js

const express = require('express')
const router  = express.Router()
const { protect, requireFeature } = require('../middleware/auth')
const upload  = require('../middleware/upload')
const {
  importPartsFromExcel,
  lookupPart,
  searchParts,
  generateTemplate,
  bulkUploadParts,
  getTenantTemplate,
} = require('../controllers/partController')

// Tenant-specific template
router.get('/tenant-template', protect, getTenantTemplate)

// Generic template (backwards compatibility)
router.get('/generic-template', protect, generateTemplate)

// Bulk import into parts master — pro licence required
router.post('/import', protect, requireFeature('quotex', 'excel_import'), upload.single('file'), importPartsFromExcel)

// Bulk upload parts for new quotation — all users
router.post('/bulk-upload', protect, upload.single('file'), bulkUploadParts)

// Search parts
router.get('/search', protect, searchParts)

// Single part lookup
router.get('/:partNumber', protect, lookupPart)

module.exports = router
