// quotationTemplate.js — Generic HTML fallback template for PDF generation.
// Used when a tenant has NOT uploaded a custom Word template.
// When a custom Word template IS uploaded, pdfController.js uses that instead.
// All styling is inline CSS — Puppeteer renders this as a standalone HTML page.

const generateQuotationHTML = (doc, branding = null) => {

  const companyName    = branding?.companyName    || 'Your Company Name'
  const companyAddress = branding?.companyAddress || ''
  const companyPhone   = branding?.companyPhone   || ''
  const companyEmail   = branding?.companyEmail   || ''
  const primaryColor   = branding?.primaryColor   || '#1a3c5e'
  const footerNote     = branding?.footerNote     || 'This is a computer generated quotation. No signature required.'
  const logoUrl        = branding?.logoUrl        || ''

  const formatCurrency = (amount) => {
    const symbol = doc.currencySymbol || '$'
    return `${symbol} ${parseFloat(amount || 0).toLocaleString(undefined, {
      minimumFractionDigits: 2,
      maximumFractionDigits: 2,
    })}`
  }

  const formatDate = (date) => {
    return new Date(date).toLocaleDateString('en-GB', {
      day: 'numeric', month: 'long', year: 'numeric',
    })
  }

  const partRows = doc.parts.map((part, index) => `
    <tr class="${index % 2 === 0 ? 'row-even' : 'row-odd'}">
      <td class="center">${index + 1}</td>
      <td class="bold">${part.partNumber}</td>
      <td>${part.description || '—'}</td>
      <td>${part.specifications || '—'}</td>
      <td class="center">${part.quantity}</td>
      <td class="center">${part.unit}</td>
      <td class="right">${formatCurrency(part.unitPrice)}</td>
      <td class="right bold">${formatCurrency(part.totalPrice)}</td>
    </tr>
  `).join('')

  const termsLines = (doc.termsAndConditions || '')
    .split('\n')
    .filter(line => line.trim())
    .map(line => `<p class="terms-line">${line}</p>`)
    .join('')

  return `
    <!DOCTYPE html>
    <html lang="en">
    <head>
      <meta charset="UTF-8">
      <title>Quotation ${doc.quoteNumber}</title>
      <style>
        * { margin: 0; padding: 0; box-sizing: border-box; }
        body { font-family: 'Segoe UI', Arial, sans-serif; font-size: 11px; color: #2c2c2c; padding: 32px 40px; line-height: 1.5; }

        .header { display: flex; justify-content: space-between; align-items: flex-start; margin-bottom: 24px; padding-bottom: 16px; border-bottom: 3px solid ${primaryColor}; }
        .company-name { font-size: 22px; font-weight: 700; color: #1a3c5e; margin-bottom: 4px; }
        .company-sub { font-size: 10px; color: #888; }

        .title-block { text-align: right; }
        .title-label { font-size: 28px; font-weight: 700; color: #1a3c5e; letter-spacing: 2px; }
        .quote-number { font-size: 13px; color: #2e75b6; font-weight: 600; margin-top: 4px; }
        .quote-date { font-size: 10px; color: #888; margin-top: 2px; }

        .info-row { display: flex; gap: 24px; margin-bottom: 24px; }
        .info-box { flex: 1; background: #f8f9fa; border: 1px solid #e0e0e0; border-radius: 6px; padding: 14px 16px; }
        .info-box-title { font-size: 9px; font-weight: 700; text-transform: uppercase; letter-spacing: 1px; color: #888; margin-bottom: 8px; }
        .info-value { font-size: 12px; font-weight: 600; color: #1a3c5e; margin-bottom: 2px; }
        .info-sub { font-size: 10px; color: #666; margin-bottom: 2px; }

        .table-title { font-size: 11px; font-weight: 700; text-transform: uppercase; letter-spacing: 1px; color: #1a3c5e; margin-bottom: 8px; }
        table { width: 100%; border-collapse: collapse; margin-bottom: 16px; }
        thead tr { background-color: ${primaryColor}; color: #ffffff; }
        thead th { padding: 8px 10px; text-align: left; font-size: 10px; font-weight: 600; letter-spacing: 0.5px; }
        tbody td { padding: 7px 10px; border-bottom: 1px solid #f0f0f0; font-size: 10px; vertical-align: top; }
        .row-even { background-color: #ffffff; }
        .row-odd  { background-color: #f8f9fa; }
        .center { text-align: center; }
        .right  { text-align: right; }
        .bold   { font-weight: 600; }

        .total-row { display: flex; justify-content: flex-end; margin-bottom: 24px; }
        .total-box { background: #1a3c5e; color: #ffffff; padding: 12px 20px; border-radius: 6px; display: flex; align-items: center; gap: 16px; }
        .total-label { font-size: 11px; font-weight: 600; letter-spacing: 1px; text-transform: uppercase; }
        .total-value { font-size: 18px; font-weight: 700; }

        .terms-section { margin-bottom: 24px; padding: 14px 16px; background: #f8f9fa; border: 1px solid #e0e0e0; border-radius: 6px; border-left: 4px solid #1a3c5e; }
        .terms-title { font-size: 9px; font-weight: 700; text-transform: uppercase; letter-spacing: 1px; color: #888; margin-bottom: 8px; }
        .terms-line { font-size: 10px; color: #555; margin-bottom: 4px; line-height: 1.6; }

        .footer { margin-top: 24px; padding-top: 12px; border-top: 1px solid #e0e0e0; display: flex; justify-content: space-between; align-items: center; }
        .footer-text { font-size: 9px; color: #aaa; }
        .footer-ref { font-size: 9px; color: #aaa; font-weight: 600; }
      </style>
    </head>
    <body>

      <div class="header">
        <div style="display:flex; align-items:center; gap:16px;">
          ${logoUrl ? `<img src="${logoUrl}" style="height:48px; object-fit:contain;" />` : ''}
          <div>
            <div class="company-name">${companyName}</div>
            ${companyAddress ? `<div class="company-sub">${companyAddress}</div>` : ''}
            ${companyPhone || companyEmail
              ? `<div class="company-sub">${[companyPhone, companyEmail].filter(Boolean).join(' | ')}</div>`
              : ''}
          </div>
        </div>
        <div class="title-block">
          <div class="title-label">QUOTATION</div>
          <div class="quote-number">${doc.quoteNumber}</div>
          <div class="quote-date">Date: ${formatDate(doc.createdAt)}</div>
        </div>
      </div>

      <div class="info-row">
        <div class="info-box">
          <div class="info-box-title">Bill To</div>
          <div class="info-value">${doc.customer.companyName}</div>
          ${doc.customer.contactName ? `<div class="info-sub">Attn: ${doc.customer.contactName}</div>` : ''}
          ${doc.customer.email       ? `<div class="info-sub">${doc.customer.email}</div>`             : ''}
          ${doc.customer.phone       ? `<div class="info-sub">${doc.customer.phone}</div>`             : ''}
          ${doc.customer.address     ? `<div class="info-sub">${doc.customer.address}</div>`           : ''}
          ${doc.customer.city        ? `<div class="info-sub">${doc.customer.city}, ${doc.customer.country}</div>` : ''}
        </div>
        <div class="info-box">
          <div class="info-box-title">Quotation Details</div>
          <div class="info-value">${doc.quoteNumber}</div>
          <div class="info-sub">Date: ${formatDate(doc.createdAt)}</div>
          <div class="info-sub">Status: ${doc.status}</div>
          <div class="info-sub">Version: V${doc.version}</div>
          <div class="info-sub">Currency: ${doc.currency || 'USD'}</div>
        </div>
      </div>

      <div class="table-title">Items Quoted</div>
      <table>
        <thead>
          <tr>
            <th style="width:4%">#</th>
            <th style="width:12%">Part No.</th>
            <th style="width:22%">Description</th>
            <th style="width:22%">Specifications</th>
            <th style="width:7%">Qty</th>
            <th style="width:7%">Unit</th>
            <th style="width:13%">Unit Price</th>
            <th style="width:13%">Total</th>
          </tr>
        </thead>
        <tbody>${partRows}</tbody>
      </table>

      <div class="total-row">
        <div class="total-box">
          <span class="total-label">Grand Total</span>
          <span class="total-value">${formatCurrency(doc.grandTotal)}</span>
        </div>
      </div>

      <div class="terms-section">
        <div class="terms-title">Terms & Conditions</div>
        ${termsLines}
      </div>

      <div class="footer">
        <div class="footer-text">${footerNote}</div>
        <div class="footer-ref">${doc.quoteNumber} | V${doc.version}</div>
      </div>

    </body>
    </html>
  `
}

module.exports = generateQuotationHTML
