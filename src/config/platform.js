// platform.js — SourceHUB server-side platform configuration.
// Location: server/src/config/platform.js
// Uses CommonJS (module.exports) for Node.js compatibility.
//
// To rename anything: change it HERE ONLY.
// All controllers, middleware and routes import from this file.

const PLATFORM = {
  name:    'SourceHUB',
  version: '1.0.0',
}

const TOOLS = {
  quotex: {
    code:    'quotex',      // toolCode stored in DB — user.toolAccess[].toolCode
    name:    'QuoteX',      // display name
    apiBase: '/api/quotex', // all QuoteX routes under this prefix
  },
  // Future tools added here:
  // negohelp: { code: 'negohelp', name: 'NegoHelp', apiBase: '/api/negohelp' },
}

// The protected tool code — this tool cannot be deleted from admin panel
const CORE_TOOL_CODE = TOOLS.quotex.code  // 'quotex'

module.exports = { PLATFORM, TOOLS, CORE_TOOL_CODE }
