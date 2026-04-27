// tools.js — Feature definitions per licence tier for each tool.
// This defines WHAT FEATURES each licence tier unlocks within a tool.
// Tool DISCOVERY (which tools exist) is now in MongoDB Tool collection.
// Tool IDENTIFICATION uses codes from platform.js.
//
// To add a new tool: add its code as a key below with feature tiers.

const TOOLS = {
  quotex: {
    code:        'quotex',
    name:        'QuoteX',
    description: 'Quotation generation and tracking',
    icon:        '📋',
    features: {
      basic: [
        'create_quotation',
        'view_own_tracker',
        'download_pdf',
        'customer_master',
        'part_lookup',
      ],
      pro: [
        'create_quotation',
        'view_own_tracker',
        'download_pdf',
        'customer_master',
        'part_lookup',
        'analytics',
        'versioning',
        'team_tracker',
        'excel_import',
        'bulk_upload',
      ],
      enterprise: [
        'create_quotation',
        'view_own_tracker',
        'download_pdf',
        'customer_master',
        'part_lookup',
        'analytics',
        'versioning',
        'team_tracker',
        'excel_import',
        'bulk_upload',
        'user_management',
        'all_tenant_data',
        'approval_workflow',
        'custom_pdf_template',
        'custom_excel_template',
      ],
    },
  },

  // Future tools added here:
  // negohelp: { code: 'negohelp', name: 'NegoHelp', features: { ... } },
}

const ALL_TOOL_CODES   = Object.keys(TOOLS)
const isValidTool      = (code) => !!TOOLS[code]
const getToolFeatures  = (toolCode, licence) => {
  const tool = TOOLS[toolCode]
  if (!tool) return []
  return tool.features[licence] || tool.features['basic'] || []
}

module.exports = { TOOLS, ALL_TOOL_CODES, isValidTool, getToolFeatures }
