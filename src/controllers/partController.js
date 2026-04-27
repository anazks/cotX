// partController.js — Platform-level parts master operations.
// Parts are shared company data accessible across all tools.
// All functions are tenantId-scoped — one tenant cannot see another's parts.

const xlsx = require('xlsx')
const Part = require('../models/Part')

// ── Helper — normalise Excel row headers ──────
const normaliseRow = (row) => {
  const n = {}
  for (const key in row) {
    n[key.toLowerCase().replace(/[\s_]/g, '')] = row[key]
  }
  return {
    partNumber:     n['partnumber'] || n['partno']  || n['part'] || '',
    description:    n['description'] || n['desc']   || '',
    specifications: n['specifications'] || n['specs'] || n['spec'] || '',
    unit:           n['unit'] || n['uom'] || 'Pieces',
  }
}

// ── FUNCTION 1 — Import parts from Excel into parts master ────────────
const importPartsFromExcel = async (req, res) => {
  try {
    if (!req.file) {
      return res.status(400).json({ message: 'Please upload an Excel file' })
    }

    const workbook = xlsx.read(req.file.buffer, { type: 'buffer' })
    const rows     = xlsx.utils.sheet_to_json(workbook.Sheets[workbook.SheetNames[0]])

    if (rows.length === 0) {
      return res.status(400).json({ message: 'The Excel file appears to be empty' })
    }

    const tenantId = req.user.tenantId
    let imported = 0, updated = 0, skipped = 0
    const skippedRows = []

    for (const row of rows) {
      const { partNumber, description, specifications, unit } = normaliseRow(row)

      if (!partNumber) {
        skipped++
        skippedRows.push({ row: JSON.stringify(row), reason: 'Missing part number' })
        continue
      }

      const result = await Part.findOneAndUpdate(
        { partNumber: partNumber.toUpperCase(), tenantId },
        { partNumber: partNumber.toUpperCase(), description, specifications, unit, tenantId },
        { upsert: true, new: true, setDefaultsOnInsert: true }
      )

      const timeDiff = result.updatedAt.getTime() - result.createdAt.getTime()
      timeDiff < 1000 ? imported++ : updated++
    }

    res.status(200).json({
      message: 'Import complete',
      imported, updated, skipped,
      total: rows.length,
      ...(skippedRows.length > 0 && { skippedDetails: skippedRows }),
    })

  } catch (error) {
    console.error('Parts import error:', error)
    res.status(500).json({ message: 'Import failed', error: error.message })
  }
}

// ── FUNCTION 2 — Look up a single part by part number ─────────────────
const lookupPart = async (req, res) => {
  try {
    const part = await Part.findOne({
      partNumber: req.params.partNumber.toUpperCase(),
      tenantId:   req.user.tenantId,
    })

    if (!part) return res.status(404).json({ message: 'Part not found' })
    res.status(200).json(part)

  } catch (error) {
    console.error('Part lookup error:', error)
    res.status(500).json({ message: 'Lookup failed', error: error.message })
  }
}

// ── FUNCTION 3 — Search parts (autocomplete) ──────────────────────────
const searchParts = async (req, res) => {
  try {
    const { q } = req.query
    if (!q || q.trim().length < 1) return res.status(200).json([])

    const parts = await Part.find({
      tenantId: req.user.tenantId,
      $or: [
        { partNumber:  { $regex: q.trim(), $options: 'i' } },
        { description: { $regex: q.trim(), $options: 'i' } },
      ],
    }).limit(10).sort({ partNumber: 1 })

    res.status(200).json(parts)

  } catch (error) {
    console.error('Part search error:', error)
    res.status(500).json({ message: 'Search failed', error: error.message })
  }
}

// ── FUNCTION 4 — Generate generic Excel template ──────────────────────
// Returns a downloadable xlsx with standard column headers.
// Used as fallback when tenant has no custom template uploaded.
const generateTemplate = async (req, res) => {
  try {
    const templateData = [{
      'Part Number':    'e.g. BRG-001',
      'Description':    'e.g. Deep Groove Ball Bearing',
      'Specifications': 'e.g. Inner Dia: 25mm',
      'Unit':           'Pieces',
      'Quantity':       10,
      'Unit Price':     0.00,
    }]

    const workbook  = xlsx.utils.book_new()
    const worksheet = xlsx.utils.json_to_sheet(templateData)

    worksheet['!cols'] = [
      { wch: 20 }, { wch: 35 }, { wch: 35 },
      { wch: 15 }, { wch: 12 }, { wch: 15 },
    ]

    xlsx.utils.book_append_sheet(workbook, worksheet, 'Parts')
    const buffer = xlsx.write(workbook, { type: 'buffer', bookType: 'xlsx' })

    res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet')
    res.setHeader('Content-Disposition', 'attachment; filename="parts-template.xlsx"')
    res.send(buffer)

  } catch (error) {
    console.error('Template generation error:', error)
    res.status(500).json({ message: 'Failed to generate template', error: error.message })
  }
}

// ── FUNCTION 5 — Get tenant-specific parts template ───────────────────
// If the tenant has uploaded a custom Excel template, return that.
// Otherwise return the generic template.
// Supports ?headersOnly=true to return column names as JSON (no download)
// — used by NewQuotation.jsx on mount to pre-load custom column headers.
const getTenantTemplate = async (req, res) => {
  try {
    const { tenantId } = req.user
    const Tenant = require('../models/Tenant')
    const tenant = await Tenant.findOne({ tenantId })

    // Headers-only mode — returns JSON, no file download
    if (req.query.headersOnly === 'true') {
      if (tenant?.excelTemplate?.fileBase64) {
        try {
          const buffer          = Buffer.from(tenant.excelTemplate.fileBase64, 'base64')
          const wb              = xlsx.read(buffer, { type: 'buffer' })
          const rows            = xlsx.utils.sheet_to_json(wb.Sheets[wb.SheetNames[0]], { header: 1 })
          const templateHeaders = rows.length > 0
            ? (rows[0] || []).map(String).filter(Boolean)
            : []
          return res.status(200).json({ templateHeaders })
        } catch (parseErr) {
          console.error('Could not parse tenant template headers:', parseErr.message)
          return res.status(200).json({ templateHeaders: [] })
        }
      }
      return res.status(200).json({
        templateHeaders: ['Part Number', 'Description', 'Specifications', 'Unit', 'Quantity', 'Unit Price'],
      })
    }

    // File download mode — stream tenant's custom template if uploaded
    if (tenant?.excelTemplate?.fileBase64) {
      const buffer = Buffer.from(tenant.excelTemplate.fileBase64, 'base64')
      res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet')
      res.setHeader('Content-Disposition', `attachment; filename="${tenant.excelTemplate.fileName || 'parts-template.xlsx'}"`)
      return res.send(buffer)
    }

    // No custom template — generate and return generic template
    const wb  = xlsx.utils.book_new()
    const ws  = xlsx.utils.aoa_to_sheet([
      ['Part Number', 'Description', 'Specifications', 'Unit', 'Quantity', 'Unit Price'],
      ['PART-001', 'Sample Part', 'Optional specs', 'Pieces', 10, 100],
    ])
    ws['!cols'] = [{ wch: 16 }, { wch: 28 }, { wch: 28 }, { wch: 12 }, { wch: 12 }, { wch: 14 }]
    xlsx.utils.book_append_sheet(wb, ws, 'Parts')
    const buffer = xlsx.write(wb, { type: 'buffer', bookType: 'xlsx' })

    res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet')
    res.setHeader('Content-Disposition', 'attachment; filename="parts-template.xlsx"')
    res.send(buffer)

  } catch (error) {
    console.error('Get tenant template error:', error)
    res.status(500).json({ message: 'Failed to get template', error: error.message })
  }
}

// ── FUNCTION 6 — Bulk upload parts for a new quotation ───────────────
// Reads column headers dynamically from row 1.
// Standard columns are mapped via fuzzy match (see FIELD_MAP).
// Unrecognised columns are stored as customFields on each part line.
const bulkUploadParts = async (req, res) => {
  try {
    console.log('[Parts] Bulk upload — user:', req.user?.email, 'tenantId:', req.user?.tenantId)

    if (!req.file) {
      return res.status(400).json({ message: 'Please upload an Excel file' })
    }

    const tenantId = req.user.tenantId
    const workbook = xlsx.read(req.file.buffer, { type: 'buffer' })
    const rows     = xlsx.utils.sheet_to_json(workbook.Sheets[workbook.SheetNames[0]], { header: 1 })

    if (!rows || rows.length < 2) {
      return res.status(400).json({
        message: 'Excel file must have at least a header row and one data row',
      })
    }

    const headers = rows[0].map(h => String(h || '').trim())
    if (headers.length === 0) {
      return res.status(400).json({ message: 'No column headers found in row 1' })
    }

    const normalise = (str) => str.toLowerCase().replace(/[^a-z0-9]/g, '').trim()

    const FIELD_MAP = {
      partNumber:     ['partnumber', 'partno', 'partcode', 'itemno', 'itemnumber', 'itemcode', 'code', 'sku', 'productcode', 'productno', 'materialno', 'materialcode', 'drawingno', 'drawingnumber'],
      description:    ['description', 'desc', 'itemdescription', 'partdescription', 'name', 'itemname', 'productname', 'title', 'partname', 'materialname', 'materialdescription'],
      specifications: ['specifications', 'specs', 'specification', 'spec', 'technicalspec', 'technicalspecification', 'details', 'remarks', 'comments', 'notes', 'dimension', 'dimensions'],
      unit:           ['unit', 'uom', 'unitofmeasure', 'unitofmeasurement', 'measure', 'qty unit', 'qtyunit'],
      quantity:       ['quantity', 'qty', 'requiredqty', 'requiredquantity', 'orderqty', 'orderquantity', 'nos', 'number', 'count', 'amount'],
      unitPrice:      ['unitprice', 'price', 'rate', 'unitrate', 'costperunit', 'unitcost', 'basicprice', 'listprice', 'quotedprice', 'quotedrate', 'offeredprice', 'offeredrate'],
    }

    const colIndexToField = {}
    const unmappedHeaders = []

    headers.forEach((header, idx) => {
      const norm = normalise(header)
      let matched = false
      for (const [fieldName, variants] of Object.entries(FIELD_MAP)) {
        if (variants.includes(norm)) {
          colIndexToField[idx] = fieldName
          matched = true
          break
        }
      }
      if (!matched) {
        colIndexToField[idx] = `custom_${header}`
        unmappedHeaders.push(header)
      }
    })

    const mappedFields  = Object.values(colIndexToField)
    const hasPartNumber = mappedFields.some(f => f === 'partNumber')
    const hasQuantity   = mappedFields.some(f => f === 'quantity')
    const hasUnitPrice  = mappedFields.some(f => f === 'unitPrice')

    const warnings = []
    if (!hasPartNumber) warnings.push('No Part Number column detected — rows will be added without part number lookup')
    if (!hasQuantity)   warnings.push('No Quantity column detected — total price cannot be calculated')
    if (!hasUnitPrice)  warnings.push('No Unit Price column detected — total price cannot be calculated')
    if (unmappedHeaders.length > 0) {
      warnings.push(`These columns were not recognised and will be added as custom fields: ${unmappedHeaders.join(', ')}`)
    }

    const parts    = []
    const newParts = []
    const dataRows = rows.slice(1).filter(row =>
      row.some(cell => cell !== null && cell !== undefined && String(cell).trim() !== '')
    )

    for (const row of dataRows) {
      const partData     = {}
      const customFields = {}

      headers.forEach((_, idx) => {
        const fieldName = colIndexToField[idx]
        const cellValue = row[idx]
        if (cellValue === null || cellValue === undefined) return
        const strValue = String(cellValue).trim()
        if (!strValue) return
        if (fieldName.startsWith('custom_')) {
          customFields[fieldName.replace('custom_', '')] = strValue
        } else {
          partData[fieldName] = strValue
        }
      })

      if (Object.keys(partData).length === 0 && Object.keys(customFields).length === 0) continue

      if (partData.partNumber) {
        const pn     = String(partData.partNumber).toUpperCase().trim()
        partData.partNumber = pn
        const dbPart = await Part.findOne({ partNumber: pn, tenantId })

        if (!dbPart) {
          try {
            await Part.create({
              partNumber:     pn,
              description:    partData.description    || '',
              specifications: partData.specifications || '',
              unit:           partData.unit           || 'Pieces',
              tenantId,
            })
            newParts.push(pn)
          } catch (createErr) {
            console.warn('[Parts] Part create skipped:', pn, createErr.message)
          }
        } else {
          if (!partData.description)    partData.description    = dbPart.description
          if (!partData.specifications) partData.specifications = dbPart.specifications
          if (!partData.unit)           partData.unit           = dbPart.unit
        }
      }

      const quantity   = parseFloat(partData.quantity)  || null
      const unitPrice  = parseFloat(partData.unitPrice) || null
      const totalPrice = (quantity && unitPrice)
        ? parseFloat((quantity * unitPrice).toFixed(2))
        : null

      parts.push({
        partNumber:     partData.partNumber     || '',
        description:    partData.description    || '',
        specifications: partData.specifications || '',
        unit:           partData.unit           || 'Pieces',
        quantity:       quantity                || '',
        unitPrice:      unitPrice               || '',
        totalPrice:     totalPrice              || '',
        _rawHeaders:    headers,
        _customFields:  Object.keys(customFields).length > 0 ? customFields : undefined,
      })
    }

    if (parts.length === 0) {
      return res.status(400).json({ message: 'No valid data rows found in the uploaded file' })
    }

    res.status(200).json({
      message:   `Successfully processed ${parts.length} part(s)`,
      parts, newParts, warnings, headers,
      totalRows: parts.length,
    })

  } catch (error) {
    console.error('[Parts] Bulk upload error:', error)
    res.status(500).json({ message: 'Failed to process file', error: error.message })
  }
}

// ── FUNCTION 7 — Bulk Upload Parts for Tenant (Super Admin) ──────────
// POST /api/admin/tenants/:tenantId/bulk-upload-parts
// Like bulkUploadParts but:
//   - tenantId comes from URL param (not req.user.tenantId)
//   - Uses the tenant's uploaded Excel template headers for column mapping
//   - Saves to Part master (importPartsFromExcel style), not to a quotation
//   - Returns row-by-row result with imported/updated/skipped/error status
//
// Column mapping reuses the same FIELD_MAP fuzzy logic from bulkUploadParts.
// Unrecognised columns are ignored (not stored — Part master has fixed fields).
//
// Duplicate handling:
//   - Exact match (partNumber + all fields same) → skip
//   - partNumber exists but fields differ → update
//   - New partNumber → create
const bulkUploadPartsForTenant = async (req, res) => {
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
      workbook.Sheets[workbook.SheetNames[0]], { header: 1, defval: '' }
    )

    if (!rows || rows.length < 2) {
      return res.status(400).json({ message: 'File must have a header row and at least one data row' })
    }

    const headers = rows[0].map(h => String(h || '').trim()).filter(Boolean)
    if (headers.length === 0) {
      return res.status(400).json({ message: 'No column headers found in row 1' })
    }

    // Same FIELD_MAP as bulkUploadParts — reuse fuzzy matching
    const normalise = str => str.toLowerCase().replace(/[^a-z0-9]/g, '').trim()

    const FIELD_MAP = {
      partNumber:     ['partnumber','partno','partcode','itemno','itemnumber','itemcode','code','sku','productcode','productno','materialno','materialcode','drawingno','drawingnumber'],
      description:    ['description','desc','itemdescription','partdescription','name','itemname','productname','title','partname','materialname','materialdescription'],
      specifications: ['specifications','specs','specification','spec','technicalspec','technicalspecification','details','remarks','comments','notes','dimension','dimensions'],
      unit:           ['unit','uom','unitofmeasure','unitofmeasurement','measure','qtyunit'],
    }

    // Map each column index to a field name
    const colToField = {}
    headers.forEach((header, idx) => {
      const norm = normalise(header)
      for (const [field, variants] of Object.entries(FIELD_MAP)) {
        if (variants.includes(norm)) { colToField[idx] = field; break }
      }
      // Unrecognised columns are skipped — Part master has fixed schema
    })

    const hasPartNumber = Object.values(colToField).includes('partNumber')
    if (!hasPartNumber) {
      return res.status(400).json({
        message: 'No Part Number column detected. Please check your Excel headers match the template.',
      })
    }

    const results = []
    let imported = 0, updated = 0, skipped = 0, errors = 0

    const dataRows = rows.slice(1).filter(row =>
      row.some(cell => cell !== null && cell !== undefined && String(cell).trim() !== '')
    )

    for (let i = 0; i < dataRows.length; i++) {
      const rowNum = i + 2
      const row    = dataRows[i]
      const d      = {}

      headers.forEach((_, idx) => {
        const field = colToField[idx]
        if (!field) return
        const val = String(row[idx] || '').trim()
        if (val) d[field] = val
      })

      if (!d.partNumber) {
        errors++
        results.push({ row: rowNum, status: 'error', data: d, reason: 'Missing Part Number' })
        continue
      }

      const pn = d.partNumber.toUpperCase().trim()

      const existing = await Part.findOne({ partNumber: pn, tenantId })

      if (existing) {
        const exact =
          (existing.description    || '') === (d.description    || '') &&
          (existing.specifications || '') === (d.specifications || '') &&
          (existing.unit           || 'Pieces') === (d.unit || existing.unit || 'Pieces')

        if (exact) {
          skipped++
          results.push({ row: rowNum, status: 'skipped', data: d, reason: 'Exact duplicate — record unchanged' })
          continue
        }

        await Part.findOneAndUpdate(
          { partNumber: pn, tenantId },
          { $set: {
            description:    d.description    || existing.description,
            specifications: d.specifications || existing.specifications,
            unit:           d.unit           || existing.unit,
          }},
          { new: true }
        )
        updated++
        results.push({ row: rowNum, status: 'updated', data: { partNumber: pn, ...d } })

      } else {
        await Part.create({
          partNumber:     pn,
          description:    d.description    || '',
          specifications: d.specifications || '',
          unit:           d.unit           || 'Pieces',
          tenantId,
        })
        imported++
        results.push({ row: rowNum, status: 'imported', data: { partNumber: pn, ...d } })
      }
    }

    res.status(200).json({
      message: `Upload complete — ${imported} imported, ${updated} updated, ${skipped} skipped, ${errors} errors`,
      summary: { total: dataRows.length, imported, updated, skipped, errors },
      results,
    })

  } catch (err) {
    console.error('Bulk upload parts for tenant error:', err)
    res.status(500).json({ message: 'Bulk upload failed', error: err.message })
  }
}

// ── FUNCTION 8 — Download Parts Upload Template for Tenant ────────────
// GET /api/admin/tenants/:tenantId/bulk-upload-parts/template
// Returns the tenant's custom Excel template if uploaded, else generic template.
// Super admin uses this to get the right column format before uploading.
const downloadPartsTemplateForTenant = async (req, res) => {
  try {
    const tenantId = req.params.tenantId
    const Tenant   = require('../models/Tenant')
    const tenant   = await Tenant.findOne({ tenantId })

    // Return tenant's own custom template if available
    if (tenant?.excelTemplate?.fileBase64) {
      const buffer = Buffer.from(tenant.excelTemplate.fileBase64, 'base64')
      res.setHeader('Content-Type',
        'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet')
      res.setHeader('Content-Disposition',
        `attachment; filename="${tenant.excelTemplate.fileName || 'parts-template.xlsx'}"`)
      return res.send(buffer)
    }

    // No custom template — return standard template
    const ws = xlsx.utils.aoa_to_sheet([
      ['Part Number', 'Description', 'Specifications', 'Unit'],
      ['PART-001', 'Sample Part', 'Optional specs', 'Pieces'],
    ])
    ws['!cols'] = [{ wch: 18 }, { wch: 30 }, { wch: 30 }, { wch: 12 }]
    const wb = xlsx.utils.book_new()
    xlsx.utils.book_append_sheet(wb, ws, 'Parts')
    const buffer = xlsx.write(wb, { type: 'buffer', bookType: 'xlsx' })

    res.setHeader('Content-Type',
      'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet')
    res.setHeader('Content-Disposition',
      'attachment; filename="parts-upload-template.xlsx"')
    res.send(buffer)

  } catch (err) {
    console.error('Parts template for tenant error:', err)
    res.status(500).json({ message: 'Failed to get parts template', error: err.message })
  }
}

module.exports = {
  importPartsFromExcel,
  lookupPart,
  searchParts,
  generateTemplate,
  bulkUploadParts,
  getTenantTemplate,
  bulkUploadPartsForTenant,
  downloadPartsTemplateForTenant,
}
