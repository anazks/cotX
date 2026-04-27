// debug_routes.js — Run from server/ folder to list ALL registered Express routes
// Usage: node debug_routes.js
// Place at: C:\Users\HP\Documents\rfq-tool\server\debug_routes.js

process.env.NODE_ENV = 'test'

// Suppress mongoose connection attempt
const mongoose = require('mongoose')
mongoose.connect = () => Promise.resolve()

// Load express app
const express = require('express')
const app = express()

// Load routes same way index.js does
const analyticsRoutes = require('./src/routes/quotex/analyticsRoutes')
app.use('/api/quotex/analytics', analyticsRoutes)

// Print all registered routes
console.log('\n=== Registered routes under /api/quotex/analytics ===')
analyticsRoutes.stack.forEach(layer => {
  if (layer.route) {
    const methods = Object.keys(layer.route.methods).join(', ').toUpperCase()
    console.log(`  ${methods.padEnd(6)} /api/quotex/analytics${layer.route.path}`)
  }
})
console.log('')
