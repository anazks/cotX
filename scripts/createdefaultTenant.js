// createDefaultTenant.js — Creates a tenant record for existing data.
// Run once: node scripts/createDefaultTenant.js

require('dotenv').config()
const mongoose = require('mongoose')

// Import models at the top — before connecting
const Tenant = require('../src/models/Tenant')

const run = async () => {
  try {
    const MONGO_URI = process.env.MONGO_URI || 'mongodb://localhost:27017/rfqtool'
    console.log('Connecting to:', MONGO_URI)

    await mongoose.connect(MONGO_URI, {
      serverSelectionTimeoutMS: 5000,
    })
    console.log('✅ Connected to MongoDB')

    const existing = await Tenant.findOne({ tenantId: 'yourcompany' })
    if (existing) {
      console.log('⚠️  Tenant already exists:', existing.companyName)
      await mongoose.disconnect()
      process.exit(0)
    }

    const tenant = await Tenant.create({
      tenantId:          'yourcompany',
      companyName:       'Your Company',
      contactName:       'Admin',
      licence:           'enterprise',
      maxUsers:          10,
      licenceStartDate:  new Date(),
      licenceExpiryDate: new Date('2027-01-01'),
      licenceValidity:   '12 Months',
      isActive:          true,
      pdfBranding: {
        companyName:  'Your Company Name',
        primaryColor: '#1a3c5e',
        footerNote:   'This is a computer generated quotation.',
      },
    })

    console.log('✅ Default tenant created:', tenant.companyName)
    await mongoose.disconnect()
    process.exit(0)

  } catch (error) {
    console.error('❌ Failed:', error.message)
    await mongoose.disconnect()
    process.exit(1)
  }
}

run()