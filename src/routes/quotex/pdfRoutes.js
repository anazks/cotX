// pdfRoutes.js — QuoteX PDF generation routes.
// Mounted at /api/quotex/pdf in index.js

const express  = require('express')
const router   = express.Router()
const { protect } = require('../../middleware/auth')
const { generatePDF } = require('../../controllers/pdfController')

router.get('/:id', protect, generatePDF)

module.exports = router
