// quotationRoutes.js — QuoteX quotation API routes.
// Mounted at /api/quotex/quotations in index.js

const express = require('express')
const router  = express.Router()
const { protect } = require('../../middleware/auth')

const {
  createQuotation,
  getAllQuotations,
  getQuotationById,
  updateQuotationStatus,
  getTrackerQuotations,
  createQuotationVersion,
} = require('../../controllers/quotex/quotationController')

router.post('/',              protect, createQuotation)
router.get('/tracker',        protect, getTrackerQuotations)
router.get('/',               protect, getAllQuotations)
router.get('/:id',            protect, getQuotationById)
router.patch('/:id/status',   protect, updateQuotationStatus)
router.post('/:id/version',   protect, createQuotationVersion)

module.exports = router
