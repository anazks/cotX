// createSuperAdmin.js — Creates the super admin account.
// Run once: node scripts/createSuperAdmin.js

require('dotenv').config()
const mongoose = require('mongoose')
const bcrypt   = require('bcryptjs')

const run = async () => {
  try {
    const MONGO_URI = process.env.MONGO_URI || 'mongodb://localhost:27017/rfqtool'
    console.log('Connecting to:', MONGO_URI)

    await mongoose.connect(MONGO_URI, {
      serverSelectionTimeoutMS: 5000,
    })
    console.log('✅ Connected to MongoDB')

    // Define a minimal user schema inline
    // This avoids any model loading issues
    const userSchema = new mongoose.Schema({
      firstName:        String,
      lastName:         String,
      email:            { type: String, unique: true },
      password:         String,
      role:             String,
      licence:          String,
      tenantId:         String,
      isActive:         { type: Boolean, default: true },
      lastLoginAt:      { type: Date, default: null },
      licenceExpiresAt: { type: Date, default: null },
      teamMembers:      { type: Array, default: [] },
    }, { timestamps: true })

    // Use existing model if already registered
    // otherwise create it fresh
    const User = mongoose.models.User || mongoose.model('User', userSchema)

    // Check if super admin already exists
    const existing = await User.findOne({ email: 'archana.n@sunserk.com' })
    if (existing) {
      console.log('⚠️  Super admin already exists:', existing.email)
      console.log('   Role:', existing.role)
      await mongoose.disconnect()
      process.exit(0)
    }

    // Hash password manually since we are not using the model hook
    const salt     = await bcrypt.genSalt(10)
    const hashed   = await bcrypt.hash('SuperAdmin@2025', salt)

    const superAdmin = await User.create({
      firstName: 'Super',
      lastName:  'Admin',
      email:     'archana.n@sunserk.com',
      password:  hashed,
      role:      'super_admin',
      licence:   'enterprise',
      tenantId:  'super_admin',
      isActive:  true,
    })

    console.log('✅ Super admin created successfully')
    console.log('   ID:      ', superAdmin._id)
    console.log('   Email:   ', superAdmin.email)
    console.log('   Role:    ', superAdmin.role)
    console.log('   Password: SuperAdmin@2025')

    await mongoose.disconnect()
    process.exit(0)

  } catch (error) {
    console.error('❌ Failed:', error.message)
    console.error(error)
    await mongoose.disconnect()
    process.exit(1)
  }
}

run()
