'use strict'

// Where the omnibox sends free-form text that is not a URL.
const SEARCH_URL = 'https://duckduckgo.com/?q=%s'

/**
 * Turn whatever the user typed into the address bar into a URL.
 * Returns null for empty input.
 */
function normalizeInput (input) {
  const s = (input || '').trim()
  if (!s) return null

  // Already a URL with a scheme we understand.
  if (/^(https?|file|about|data|view-source|chrome):/i.test(s)) return s
  if (/^[a-zA-Z][\w+.-]*:\/\//.test(s)) return s

  // localhost:3000, 127.0.0.1:8080
  if (/^localhost(:\d+)?([/?#].*)?$/i.test(s)) return 'http://' + s
  if (/^\d{1,3}(\.\d{1,3}){3}(:\d+)?([/?#].*)?$/.test(s)) return 'http://' + s

  // example.com, example.com/path, sub.example.co.uk?q=1
  if (!/\s/.test(s) && /^[^\s/?#:]+\.[^\s/?#:]{2,}(:\d+)?([/?#].*)?$/.test(s)) {
    return 'https://' + s
  }

  // Anything else is a search.
  return SEARCH_URL.replace('%s', encodeURIComponent(s))
}

module.exports = { normalizeInput, SEARCH_URL }
