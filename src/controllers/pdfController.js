// pdfController.js — Generates RFQ PDF from Word template or generic HTML.
//
// Flow:
//  1. Fetch RFQ + Tenant from DB (full documents — not the admin-stripped versions)
//  2. If tenant has a Word template (.docx):
//     a. Extract header/footer XML from the .docx zip via JSZip
//     b. Convert .docx body to HTML via mammoth
//     c. Clean mammoth output (fix split placeholders, strip leaked footer text)
//     d. Replace all {{PLACEHOLDERS}} in body HTML
//     e. Build final HTML with fixed header/footer bands
//  3. If no Word template — use generic HTML fallback
//  4. Render to PDF via Puppeteer
//
// Dependencies: npm install mammoth jszip   (in server/ folder)

const puppeteer       = require('puppeteer')
const Quotation             = require('../models/Quotation')
const Tenant          = require('../models/Tenant')
const generateQuotationHTML = require('../templates/quotationTemplate')

// ─────────────────────────────────────────────────────────────────────────────
// MAIN CONTROLLER
// ─────────────────────────────────────────────────────────────────────────────

const generatePDF = async (req, res) => {
  try {
    const { id }       = req.params
    const { tenantId } = req.user

    // Fetch full documents — DO NOT use the admin getTenant() which strips base64
    const quotation = await Quotation.findOne({ _id: id, tenantId })
    const tenant = await Tenant.findOne({ tenantId })

    if (!quotation) return res.status(404).json({ message: 'Quotation not found' })

    console.log('[PDF] tenantId:', tenantId)
    console.log('[PDF] wordTemplate:', tenant?.wordTemplate?.fileName || 'none')
    console.log('[PDF] logo field present:', !!tenant?.logo?.fileBase64)

    // ── Convert RFQ parts to plain objects immediately ─────────────────────
    // Mongoose subdocuments with Map fields MUST be converted with flattenMaps:true
    // before any field access. Otherwise customFields stays a Map instance and
    // Object.keys() returns Mongoose internal metadata keys, not actual data keys.
    const doc = quotation.toObject({ flattenMaps: true })
    console.log('[PDF] quoteNumber from DB:', doc.quoteNumber)
    console.log('[PDF] version:', doc.version)
    console.log('[PDF] parts count:', doc.parts?.length)
    if (doc.parts?.[0]?.customFields) {
      console.log('[PDF] sample customFields keys:', Object.keys(doc.parts[0].customFields))
    }

    let bodyHtml = ''

    if (tenant?.wordTemplate?.fileBase64) {
      bodyHtml = await buildBodyFromWordTemplate(tenant, doc)
      if (!bodyHtml) {
        console.log('[PDF] Word template conversion failed — falling back to generic')
      }
    }

    if (!bodyHtml) {
      // Generic fallback — uses pdfBranding colours
      bodyHtml = generateQuotationHTML(doc, tenant?.pdfBranding || null)
    }

    const finalHtml = assembleFinalHTML(bodyHtml, tenant)

    // ── Build Puppeteer header/footer templates ────────────────────────────
    // These render natively on every page — completely independent of the
    // Word template header/footer. Data comes from MongoDB (tenant branding
    // + logo). You can design the Word header/footer however you like for
    // visual reference — Puppeteer ignores it and uses these instead.
    const { headerTemplate, footerTemplate, marginTop, marginBottom } =
      buildPuppeteerHeaderFooter(tenant, doc)

    // ── Render to PDF via Puppeteer ────────────────────────────────────────
    // timeout: 30s — if Puppeteer hangs (bad template, memory pressure on VPS),
    // the request fails cleanly instead of hanging indefinitely.
    // browser is declared outside try so the finally block can always close it.
    const PDF_TIMEOUT_MS = 30000
    let browser
    try {
      browser = await puppeteer.launch({
        headless: 'new',
        args:     ['--no-sandbox', '--disable-setuid-sandbox'],
        timeout:  PDF_TIMEOUT_MS,
      })
      const page = await browser.newPage()

      // Set a per-page timeout — catches infinite-loading content
      page.setDefaultNavigationTimeout(PDF_TIMEOUT_MS)
      page.setDefaultTimeout(PDF_TIMEOUT_MS)

      await page.setContent(finalHtml, { waitUntil: 'networkidle0', timeout: PDF_TIMEOUT_MS })
      const pdf = await page.pdf({
        format:               'A4',
        printBackground:      true,
        displayHeaderFooter:  true,
        headerTemplate,
        footerTemplate,
        margin: {
          top:    marginTop,
          bottom: marginBottom,
          left:   '12mm',
          right:  '12mm',
        },
        timeout: PDF_TIMEOUT_MS,
      })

      res.setHeader('Content-Type', 'application/pdf')
      res.setHeader('Content-Disposition', `attachment; filename="${doc.quoteNumber}.pdf"`)
      res.send(pdf)

    } catch (puppeteerErr) {
      console.error('[PDF] Puppeteer error:', puppeteerErr.message)
      const isTimeout = puppeteerErr.message?.includes('timeout') ||
                        puppeteerErr.message?.includes('Timeout')
      res.status(500).json({
        message: isTimeout
          ? 'PDF generation timed out. The template may be too complex. Please try again.'
          : 'Failed to generate PDF',
        error: puppeteerErr.message,
      })
    } finally {
      // Always close the browser — even if PDF generation failed.
      // Without this, a hung Puppeteer process stays alive on the VPS
      // consuming memory until the server restarts.
      if (browser) {
        await browser.close().catch(e =>
          console.error('[PDF] Failed to close browser:', e.message)
        )
      }
    }

  } catch (err) {
    console.error('[PDF] Generation error:', err)
    res.status(500).json({ message: 'Failed to generate PDF', error: err.message })
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// LOGO HELPER
// Must be defined before extractWordHeaderFooter which calls it.
// ─────────────────────────────────────────────────────────────────────────────

const buildLogoHTML = (tenant) => {
  if (!tenant?.logo?.fileBase64 || tenant.logo.fileBase64 === '[uploaded]') return ''
  const mimeType = tenant.logo.mimeType || 'image/png'
  return `<img src="data:${mimeType};base64,${tenant.logo.fileBase64}" style="max-height:60px;width:auto;display:block;object-fit:contain;" alt="Logo">`
}

// ─────────────────────────────────────────────────────────────────────────────
// PLACEHOLDER MAP
// Single source of truth — used for both body and header/footer replacements.
// ─────────────────────────────────────────────────────────────────────────────

const buildPlaceholders = (doc, tenant) => {
  const branding = tenant?.pdfBranding || {}

  const formatDate = (d) => {
    if (!d) return '—'
    try {
      return new Date(d).toLocaleDateString('en-GB', {
        day: '2-digit', month: 'short', year: 'numeric',
      })
    } catch { return '—' }
  }

  const fmt = (v) => {
    if (v === null || v === undefined || v === '') return '0.00'
    return parseFloat(v).toLocaleString('en-IN', { minimumFractionDigits: 2 })
  }

  // Use non-empty fallback ('—') for ALL fields that appear in table cells.
  // If a value is empty, the cell becomes <p></p> which Step 5 strips,
  // causing the table row to visually collapse. '—' keeps the cell visible.
  return {
    '{{COMPANY_LOGO}}':     buildLogoHTML(tenant),
    '{{COMPANY_NAME}}':     branding.companyName    || tenant?.companyName || '',
    '{{COMPANY_ADDRESS}}':  branding.companyAddress || tenant?.address     || '',
    '{{COMPANY_PHONE}}':    branding.companyPhone   || '',
    '{{COMPANY_EMAIL}}':    branding.companyEmail   || '',
    '{{COMPANY_WEBSITE}}':  branding.companyWebsite || '',
    '{{FOOTER_NOTE}}':      branding.footerNote     || '',
    '{{QUOTE_NUMBER}}':       doc.quoteNumber      || '—',
    '{{QUOTE_DATE}}':         formatDate(doc.createdAt),
    '{{VERSION}}':          `V${doc.version    || 1}`,
    '{{CUSTOMER_NAME}}':    doc.customer?.companyName  || '—',
    '{{CUSTOMER_CONTACT}}': doc.customer?.contactName  || '—',
    '{{CUSTOMER_EMAIL}}':   doc.customer?.email        || '—',
    '{{CUSTOMER_PHONE}}':   doc.customer?.phone        || '—',
    '{{CUSTOMER_ADDRESS}}': doc.customer?.address      || '—',
    '{{CURRENCY}}':         doc.currency               || 'USD',
    '{{CURRENCY_SYMBOL}}':  doc.currencySymbol         || '$',
    '{{GRAND_TOTAL}}':      fmt(doc.grandTotal),
    '{{PARTS_COUNT}}':      String(doc.parts?.length   || 0),
    '{{TERMS}}': (() => {
      const SCHEMA_DEFAULT = 'Standard terms and conditions apply.'
      const terms       = (doc.termsAndConditions || '').trim()
      const tenantTerms = (tenant?.defaultTerms        || '').trim()
      const effective   = (terms && terms !== SCHEMA_DEFAULT)
                            ? terms : tenantTerms
      return effective.replace(/\n/g, '<br>')
    })(),
    '{{NOTES}}':      (doc.notes || '').replace(/\n/g, '<br>'),
    '{{CREATED_BY}}': '',
  }
}

const applyPlaceholders = (text, placeholders) => {
  let out = text
  for (const [key, val] of Object.entries(placeholders)) {
    // Use split/join — safer than regex when val contains special chars (e.g. base64)
    out = out.split(key).join(val)
  }
  return out
}

// ─────────────────────────────────────────────────────────────────────────────
// EXTRACT WORD HEADER / FOOTER
// Opens the .docx ZIP and reads header1.xml / footer1.xml directly.
// mammoth does not process these files — only the body document.xml is converted.
// ─────────────────────────────────────────────────────────────────────────────

const extractWordHeaderFooter = async (tenant, doc) => {
  const result = { headerHtml: '', footerHtml: '' }
  try {
    let JSZip
    try { JSZip = require('jszip') } catch {
      console.warn('[PDF] jszip not installed — run: npm install jszip')
      return result
    }

    const buffer = Buffer.from(tenant.wordTemplate.fileBase64, 'base64')
    const zip    = await JSZip.loadAsync(buffer)

    // List all files to find which header/footer numbers exist
    const zipFiles = Object.keys(zip.files)
    console.log('[PDF] docx zip files:', zipFiles.filter(f => f.startsWith('word/header') || f.startsWith('word/footer')))

    // Try header1 first (default), then header2 (sometimes used as default)
    const headerFile = zip.file('word/header1.xml') || zip.file('word/header2.xml') || zip.file('word/header3.xml')
    const footerFile = zip.file('word/footer1.xml') || zip.file('word/footer2.xml') || zip.file('word/footer3.xml')

    const placeholders = buildPlaceholders(doc, tenant)

    // Convert Word XML to plain text, stripping all XML tags
    // We deliberately do NOT pass this through mammoth — we want plain text only.
    // The img tag for COMPANY_LOGO is safe because we apply placeholders AFTER
    // stripping XML tags — so the placeholder text survives, then gets replaced
    // with the img tag value from buildPlaceholders.
    const xmlToLines = (xml) => {
      if (!xml) return []
      const text = xml
        .replace(/<w:br[^>]*>/gi, '\n')       // line breaks
        .replace(/<\/w:p>/gi, '\n')            // end of paragraph = newline
        .replace(/<w:tab[^>]*>/gi, ' ')        // tabs → space
        .replace(/<[^>]+>/g, '')               // strip ALL remaining XML tags
        .replace(/&amp;/g,  '&')
        .replace(/&lt;/g,   '<')
        .replace(/&gt;/g,   '>')
        .replace(/&quot;/g, '"')
        .replace(/&apos;/g, "'")
        .replace(/&#x[0-9a-fA-F]+;/g, ' ')    // other entities → space
        .replace(/\r/g, '')
      return text.split('\n').map(l => l.trim()).filter(Boolean)
    }

    const linesToHtml = (lines, placeholders) =>
      lines
        .map(l => applyPlaceholders(l, placeholders))
        .filter(l => l.trim())
        .map(l => `<span>${l}</span>`)
        .join(' &nbsp;|&nbsp; ')

    if (headerFile) {
      const xml   = await headerFile.async('text')
      const lines = xmlToLines(xml)
      console.log('[PDF] header lines:', lines)
      if (lines.length) result.headerHtml = linesToHtml(lines, placeholders)
    }

    if (footerFile) {
      const xml   = await footerFile.async('text')
      const lines = xmlToLines(xml)
      console.log('[PDF] footer lines:', lines)
      if (lines.length) result.footerHtml = linesToHtml(lines, placeholders)
    }

  } catch (err) {
    console.error('[PDF] extractWordHeaderFooter error:', err.message)
  }
  return result
}

// ─────────────────────────────────────────────────────────────────────────────
// BUILD BODY HTML FROM WORD TEMPLATE
// ─────────────────────────────────────────────────────────────────────────────

const buildBodyFromWordTemplate = async (tenant, doc) => {
  try {
    let mammoth
    try { mammoth = require('mammoth') } catch {
      console.error('[PDF] mammoth not installed — run: npm install mammoth')
      return null
    }

    const buffer = Buffer.from(tenant.wordTemplate.fileBase64, 'base64')

    const result = await mammoth.convertToHtml(
      { buffer },
      {
        styleMap: [
          'p[style-name="Heading 1"] => h1:fresh',
          'p[style-name="Heading 2"] => h2:fresh',
          'p[style-name="Heading 3"] => h3:fresh',
          'b => strong',
          'i => em',
          'u => u',
        ],
        includeDefaultStyleMap: true,
        convertImage: mammoth.images.inline(element =>
          element.read('base64').then(data => ({
            src: `data:${element.contentType};base64,${data}`,
          }))
        ),
      }
    )

    let html = result.value
    if (!html || !html.trim()) {
      console.error('[PDF] mammoth returned empty HTML')
      return null
    }

    // ── Step 1: Fix mammoth encoding issues ───────────────────────────────
    // mammoth sometimes HTML-encodes { and } characters
    html = html.replace(/&#x7B;/g, '{').replace(/&#x7D;/g, '}')
    // Also fix double-encoded versions
    html = html.replace(/&amp;#x7B;/g, '{').replace(/&amp;#x7D;/g, '}')

    // Debug: log all placeholders found after encoding fix
    const foundPH = (html.match(/\{\{[A-Z_]+\}\}/g) || [])
    console.log('[PDF] Placeholders found after Step 1:', [...new Set(foundPH)])

    // ── Step 2: Fix split placeholders ───────────────────────────────────
    // mammoth sometimes splits {{ PLACEHOLDER }} across multiple XML runs,
    // resulting in HTML like: {{<strong>COMPANY</strong>_NAME}}
    // Strip any HTML tags that appear INSIDE {{ }}
    html = html.replace(/\{\{([^}]*?)\}\}/g, (match) =>
      '{{' + match.slice(2, -2).replace(/<[^>]+>/g, '') + '}}'
    )

    // ── Step 3: Remove instructional text from old templates ──────────────
    ;[
      'The system will replace',
      'below with the actual parts list when generating the PDF',
      'Parts list will be inserted here',
    ].forEach(phrase => {
      html = html.replace(new RegExp(phrase.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'gi'), '')
    })

    // ── Step 4: Deduplicate PARTS_TABLE ───────────────────────────────────
    const PT = '{{PARTS_TABLE}}'
    const ptIdx = html.indexOf(PT)
    if (ptIdx !== -1) {
      html = html.slice(0, ptIdx + PT.length) +
             html.slice(ptIdx + PT.length).split(PT).join('')
    }

    // ── Step 5: Strip genuinely empty paragraphs ──────────────────────────
    // These are spacer paragraphs from the Word template (e.g. between sections).
    // Table cell placeholders will never be empty after Step 7 because
    // buildPlaceholders now uses '—' as fallback for all table cell fields,
    // so no cell will produce <p></p> that would collapse the table row.
    html = html.replace(/<p>\s*<\/p>/g, '')
    html = html.replace(/<p><strong>\s*<\/strong><\/p>/g, '')

    // ── Step 6: Build parts table ─────────────────────────────────────────
    // Pass primaryColor so the table header matches the tenant's branding colour.
    const primaryColor  = tenant?.pdfBranding?.primaryColor || '#1a3c5e'
    const partsTableHTML = buildPartsTable(doc, primaryColor)

    // ── Step 7: Apply all placeholder replacements ────────────────────────
    const placeholders = buildPlaceholders(doc, tenant)
    html = applyPlaceholders(html, placeholders)

    // Apply PARTS_TABLE last — it contains HTML with its own attributes
    // and must not go through the general placeholder loop
    html = html.split('{{PARTS_TABLE}}').join(partsTableHTML)

    // Debug: check if key values were substituted and if table structure exists
    console.log('[PDF] QUOTE_NUMBER in html:', html.includes(doc.quoteNumber || 'NONE'))
    console.log('[PDF] <table> tags count:', (html.match(/<table/g) || []).length)
    console.log('[PDF] Remaining {{}} after Step 7:', (html.match(/\{\{[A-Z_]+\}\}/g) || []))

    // ── Step 8: Strip leaked Word footer paragraphs AFTER replacement ──────
    // Now that all real {{PLACEHOLDERS}} have been replaced with actual values,
    // any paragraph still containing {{ }} is leaked footer/header junk from
    // the Word docx that mammoth accidentally included in the body output.
    // Safe to strip these now — real content has already been substituted.
    html = html.replace(/<p[^>]*>[^<]*\{\{[A-Z_]+\}\}[^<]*<\/p>/g, '')
    // Strip Word page-number field artifacts
    html = html.replace(/\bPage\s+PAGE\s*\d*/gi, '').replace(/\bPAGE\d*\b/g, '').replace(/\bNUMPAGES\b/g, '')

    console.log('[PDF] body HTML length after processing:', html.length)
    return html

  } catch (err) {
    console.error('[PDF] buildBodyFromWordTemplate error:', err.message, err.stack)
    return null
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// BUILD PARTS TABLE HTML
// doc.parts are already plain objects with flattenMaps:true applied.
// ─────────────────────────────────────────────────────────────────────────────

const buildPartsTable = (doc, primaryColor) => {
  // primaryColor comes from tenant.pdfBranding.primaryColor via the caller.
  // Falls back to the original default so existing behaviour is unchanged
  // if no branding colour is set by the tenant.
  const color       = primaryColor || '#1a3c5e'
  const colorBorder = color        // border uses same colour — consistent look
  const colorLight  = '#f0f4f8'   // grand total row background — kept neutral

  const parts = doc.parts || []
  if (parts.length === 0) return '<p><em>No parts listed</em></p>'

  // At this point parts are plain objects (toObject({flattenMaps:true}) was
  // called in generatePDF). customFields is a plain JS object, safe to use.
  const hasSpecs  = parts.some(p => p.specifications)
  const hasPrice  = parts.some(p => p.unitPrice)
  const hasTotal  = parts.some(p => p.totalPrice)

  // Collect all custom column keys across all parts
  // Skip any key starting with $ (Mongoose internal — shouldn't appear after
  // flattenMaps but guard anyway)
  const customKeySet = new Set()
  parts.forEach(p => {
    const cf = p.customFields
    if (cf && typeof cf === 'object' && !(cf instanceof Map)) {
      Object.keys(cf).forEach(k => {
        if (!k.startsWith('$') && cf[k] !== undefined && cf[k] !== '') {
          customKeySet.add(k)
        }
      })
    }
  })
  const customCols = Array.from(customKeySet)
  console.log('[PDF] customCols detected:', customCols)

  const cols = [
    '#', 'Part Number', 'Description',
    ...(hasSpecs ? ['Specifications'] : []),
    'Unit', 'Quantity',
    ...(hasPrice ? ['Unit Price']  : []),
    ...(hasTotal ? ['Total Price'] : []),
    ...customCols,
  ]

  const thStyle = `style="background:${color};color:#fff;padding:6px 8px;text-align:left;font-size:9px;font-weight:bold;white-space:nowrap;border:1px solid ${colorBorder};"`
  const tdStyle = 'style="padding:5px 8px;font-size:9px;border-bottom:1px solid #e0e0e0;vertical-align:middle;"'
  const numTd   = 'style="padding:5px 8px;font-size:9px;border-bottom:1px solid #e0e0e0;vertical-align:middle;text-align:right;"'

  const thead = `<tr>${cols.map(h => `<th ${thStyle}>${h}</th>`).join('')}</tr>`

  const fmt = (v) => v ? parseFloat(v).toLocaleString('en-IN', { minimumFractionDigits: 2 }) : '—'

  const tbody = parts.map((p, i) => {
    const cf = (p.customFields && typeof p.customFields === 'object') ? p.customFields : {}
    const cells = [
      `<td ${tdStyle}>${i + 1}</td>`,
      `<td ${tdStyle}>${p.partNumber || '—'}</td>`,
      `<td ${tdStyle}>${p.description || '—'}</td>`,
      ...(hasSpecs ? [`<td ${tdStyle}>${p.specifications || '—'}</td>`] : []),
      `<td ${tdStyle}>${p.unit || '—'}</td>`,
      `<td ${numTd}>${p.quantity ?? '—'}</td>`,
      ...(hasPrice ? [`<td ${numTd}>${fmt(p.unitPrice)}</td>`]  : []),
      ...(hasTotal ? [`<td ${numTd}>${fmt(p.totalPrice)}</td>`] : []),
      ...customCols.map(k => `<td ${tdStyle}>${cf[k] || '—'}</td>`),
    ]
    const rowBg = i % 2 === 1 ? 'background:#f8f9fa;' : ''
    return `<tr style="${rowBg}">${cells.join('')}</tr>`
  }).join('')

  const totalCells = cols.length
  const grandTotalRow = doc.grandTotal
    ? `<tr style="background:${colorLight};border-top:2px solid ${color};">
        <td colspan="${totalCells - 1}" ${tdStyle} style="text-align:right;font-weight:bold;padding:7px 8px;">
          Grand Total (${doc.currency || ''})
        </td>
        <td ${numTd} style="font-weight:bold;padding:7px 8px;">
          ${doc.currencySymbol || ''}${fmt(doc.grandTotal)}
        </td>
       </tr>`
    : ''

  return `<table style="width:100%;border-collapse:collapse;font-family:Arial,sans-serif;font-size:9px;">
    <thead>${thead}</thead>
    <tbody>${tbody}${grandTotalRow}</tbody>
  </table>`
}

// ─────────────────────────────────────────────────────────────────────────────
// PUPPETEER NATIVE HEADER / FOOTER
//
// Puppeteer's displayHeaderFooter renders HTML bands on every page natively.
// This is completely separate from the Word template header/footer.
// - Logo comes from tenant.logo.fileBase64 (MongoDB)
// - Company details come from tenant.pdfBranding (MongoDB)
// - No dependency on Word header/footer XML at all
//
// IMPORTANT Puppeteer header/footer rules:
// - Must be self-contained HTML with inline styles only (no external CSS)
// - Font size defaults to 0 — must be set explicitly on every element
// - Images must be base64 data URIs — no external URLs
// - Puppeteer injects special classes: .pageNumber, .totalPages, .date etc
// - The header/footer HTML is rendered in a separate context from the page
// ─────────────────────────────────────────────────────────────────────────────

const buildPuppeteerHeaderFooter = (tenant, doc) => {
  const branding     = tenant?.pdfBranding || {}
  const primaryColor = branding.primaryColor || '#1a3c5e'
  const companyName  = branding.companyName  || tenant?.companyName || ''
  const companyAddr  = branding.companyAddress || ''
  const companyPhone = branding.companyPhone   || ''
  const companyEmail = branding.companyEmail   || ''
  const footerNote   = branding.footerNote     || 'This is a computer generated quotation. No signature required.'

  // Logo as inline base64 — only way to render images in Puppeteer header
  const logoSrc = (tenant?.logo?.fileBase64 && tenant.logo.fileBase64 !== '[uploaded]')
    ? `data:${tenant.logo.mimeType || 'image/png'};base64,${tenant.logo.fileBase64}`
    : ''

  const hasLogo   = !!logoSrc
  const hasHeader = !!(companyName || hasLogo)

  // ── Dynamic margin calculation ────────────────────────────────────────────
  // Count how many lines of text appear in the left column of the header.
  // Each text line is ~4mm. Logo is capped at 22mm. Add 6mm padding top+bottom
  // and 4mm gap between the header border and the first body content line.
  const textLines = [companyName, companyAddr, companyPhone, companyEmail].filter(Boolean).length
  const textHeightMm  = Math.max(textLines * 4, 8)     // minimum 8mm for company name alone
  const logoHeightMm  = hasLogo ? 22 : 0               // logo capped at 22mm in CSS below
  const contentHeightMm = Math.max(textHeightMm, logoHeightMm)
  const headerHeightMm  = hasHeader ? contentHeightMm + 8 : 0  // +8mm = 4mm top + 4mm bottom padding
  const gapMm           = 6    // guaranteed white space between header border and body text
  const marginTopMm     = hasHeader ? headerHeightMm + gapMm : 14
  const marginBottomMm  = 16

  // ── Header template ───────────────────────────────────────────────────────
  // LEFT: Company name + address + contact details
  // RIGHT: Company logo
  // IMPORTANT Puppeteer header rules:
  //   - Inline styles only — no external CSS
  //   - font-size defaults to 0 on every element — must be set explicitly
  //   - Images must be base64 data URIs
  //   - height of this div must match marginTop minus gapMm
  const headerTemplate = hasHeader ? `
  <div style="
    width:100%;
    height:${headerHeightMm}mm;
    padding:4mm 12mm 4mm 12mm;
    display:flex;
    align-items:center;
    justify-content:space-between;
    border-bottom:2px solid ${primaryColor};
    font-family:Arial,sans-serif;
    font-size:9px;
    color:#333;
    box-sizing:border-box;
    background:#fff;
  ">
    <div style="flex:1;min-width:0;">
      <div style="font-size:13px;font-weight:bold;color:${primaryColor};line-height:1.3;">${companyName}</div>
      ${companyAddr  ? `<div style="font-size:8px;color:#555;margin-top:2px;line-height:1.3;">${companyAddr}</div>`  : ''}
      ${companyPhone ? `<div style="font-size:8px;color:#555;margin-top:1px;line-height:1.3;">Tel: ${companyPhone}</div>` : ''}
      ${companyEmail ? `<div style="font-size:8px;color:#555;margin-top:1px;line-height:1.3;">${companyEmail}</div>` : ''}
    </div>
    ${hasLogo ? `
    <div style="flex-shrink:0;margin-left:16px;display:flex;align-items:center;">
      <img src="${logoSrc}" style="
        max-height:${logoHeightMm}mm;
        max-width:50mm;
        width:auto;
        height:auto;
        display:block;
        object-fit:contain;
      ">
    </div>` : ''}
  </div>` : '<span></span>'

  // ── Footer template ───────────────────────────────────────────────────────
  const footerTemplate = `
  <div style="
    width:100%;
    height:${marginBottomMm}mm;
    padding:2mm 12mm;
    display:flex;
    align-items:center;
    justify-content:space-between;
    border-top:1px solid #ddd;
    font-family:Arial,sans-serif;
    font-size:8px;
    color:#888;
    box-sizing:border-box;
    background:#fff;
  ">
    <span style="font-size:8px;">${footerNote}</span>
    <span style="font-size:8px;">Page <span class="pageNumber"></span> of <span class="totalPages"></span></span>
  </div>`

  return {
    headerTemplate,
    footerTemplate,
    marginTop:    `${marginTopMm}mm`,
    marginBottom: `${marginBottomMm}mm`,
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// ASSEMBLE FINAL HTML DOCUMENT
// Body only — header/footer handled by Puppeteer natively.
// Margins must match what buildPuppeteerHeaderFooter returns.
// ─────────────────────────────────────────────────────────────────────────────

const assembleFinalHTML = (bodyHtml, tenant) => {
  // Read primaryColor from tenant branding — same source as buildPartsTable
  // and buildPuppeteerHeaderFooter. One colour, consistent everywhere.
  const primaryColor = tenant?.pdfBranding?.primaryColor || '#1a3c5e'

  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<style>
  :root {
    --primary: ${primaryColor};
  }
  * { box-sizing: border-box; }
  body {
    margin: 0;
    padding: 4px 0;
    font-family: Arial, sans-serif;
    font-size: 10px;
    color: #222;
  }
  table { border-collapse: collapse; width: 100%; }
  img   { max-width: 100%; height: auto; }
  p     { margin: 2px 0; }
  td, th { vertical-align: middle; }
  /* Apply primary colour to any table headers mammoth converts from Word.
     mammoth-generated th elements pick this up automatically. */
  th {
    background: var(--primary);
    color: #fff;
    padding: 6px 8px;
    font-size: 9px;
    text-align: left;
  }
</style>
</head>
<body>
<div id="quotation-body">
${bodyHtml}
</div>
</body>
</html>`
}

module.exports = { generatePDF }
