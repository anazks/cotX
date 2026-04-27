const express  = require('express')
const router   = express.Router()
const { protect } = require('../middleware/auth')

const {
  saveCustomer,
  searchCustomers,
  getAllCustomers,
} = require('../controllers/customerController')

router.post('/',       protect, saveCustomer)
router.get('/search',  protect, searchCustomers)
router.get('/',        protect, getAllCustomers)

module.exports = router