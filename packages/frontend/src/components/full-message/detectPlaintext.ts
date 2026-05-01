/**
 * Extract plaintext from the HTML returned by
 * `BackendRemote.rpc.getMessageHtml`. Delta Chat core wraps long
 * plaintext messages (and any messages flagged "show full message")
 * in HTML for storage; this function gets us back to a string we can
 * feed into the markdown pipeline.
 *
 * Two implementations live behind one entry point:
 *   - `extractPlaintextFromDom` — used at runtime in the browser. Uses
 *     `DOMParser` so we can walk the document, drop head/script/style
 *     subtrees, and reconstruct meaningful newlines from block-level
 *     elements and `<br>`. The node-walking approach is the only way
 *     to handle DC core's "<p>line</p><p>line</p>" wrapping pattern,
 *     which a naive tag-strip would collapse into a single run.
 *   - `extractPlaintextWithRegex` — fallback used when DOMParser is
 *     not available (Node-based unit tests). Less robust but covers
 *     the simple `<pre>...</pre>` wrapping case fully and the
 *     `<p>...</p><p>...</p>` case via close-tag-to-newline mapping.
 *
 * The previous incarnation of this file also ran a "is this plaintext
 * or rich HTML email" detection. We dropped that — the only
 * deployment target for this view is chat-with-Claude (and similar
 * markdown-only senders), so always treating content as markdown is
 * the right call. Real HTML emails will still render legibly enough
 * (their text content survives the extractor), and there's no risk
 * of a malformed HTML body running scripts because we never inject
 * the HTML into the DOM.
 */

/** Block-level tags that should produce a paragraph break in extracted text. */
const BLOCK_TAGS = new Set([
  'p',
  'div',
  'h1',
  'h2',
  'h3',
  'h4',
  'h5',
  'h6',
  'li',
  'ul',
  'ol',
  'tr',
  'blockquote',
  'pre',
  'section',
  'article',
])

/** Tags whose subtrees should be removed entirely before extraction. */
const STRIP_SUBTREE_TAGS = ['head', 'script', 'style', 'noscript', 'template']

function decodeEntities(s: string): string {
  return s
    .replace(/&#x([0-9a-f]+);/gi, (_m, hex) =>
      String.fromCodePoint(parseInt(hex, 16))
    )
    .replace(/&#(\d+);/g, (_m, dec) => String.fromCodePoint(parseInt(dec, 10)))
    .replace(/&nbsp;/gi, ' ')
    .replace(/&quot;/gi, '"')
    .replace(/&apos;/gi, "'")
    .replace(/&lt;/gi, '<')
    .replace(/&gt;/gi, '>')
    .replace(/&amp;/gi, '&')
}

/**
 * Walk a DOM subtree and return its text, preserving structure
 * meaningful for markdown: `<br>` becomes `\n`, block-level elements
 * are wrapped in newlines, and `<pre>` content is taken verbatim
 * (its `textContent` already preserves whitespace).
 */
function walkForText(node: Node): string {
  // Element.tagName casing: HTML parser uppercases element names. We
  // compare lowercase. Inside SVG/XML the casing differs but we don't
  // expect those in this code path.
  const TEXT_NODE = 3
  const ELEMENT_NODE = 1

  let out = ''
  for (const child of Array.from(node.childNodes)) {
    if (child.nodeType === TEXT_NODE) {
      out += child.textContent ?? ''
    } else if (child.nodeType === ELEMENT_NODE) {
      const elem = child as Element
      const tag = elem.tagName.toLowerCase()
      if (tag === 'br') {
        out += '\n'
      } else if (tag === 'pre') {
        // <pre> preserves whitespace inside; using textContent here
        // grabs the full inner text without the recursion stripping
        // it. Surround with paragraph breaks so the fenced block
        // stays separated from neighbours.
        out += '\n\n' + (elem.textContent ?? '') + '\n\n'
      } else if (BLOCK_TAGS.has(tag)) {
        out += '\n\n' + walkForText(elem) + '\n\n'
      } else {
        out += walkForText(elem)
      }
    }
  }
  return out
}

function extractPlaintextFromDom(html: string): string {
  const doc = new DOMParser().parseFromString(html, 'text/html')
  for (const tag of STRIP_SUBTREE_TAGS) {
    doc.querySelectorAll(tag).forEach(n => n.remove())
  }
  const body = doc.body
  if (!body) return ''
  const text = walkForText(body)
  // Collapse runs of 3+ newlines to exactly two; trim leading and
  // trailing whitespace. The walker emits paragraph breaks
  // generously, so this normalisation keeps the markdown source
  // tidy.
  return text.replace(/\n{3,}/g, '\n\n').trim()
}

/**
 * Regex fallback for environments without DOMParser (unit tests
 * running under Node). Maps close-block-tags to `\n\n` and `<br>` to
 * `\n` before stripping the rest. This is less precise than the DOM
 * walker — nested blocks produce extra newlines that the
 * normalisation step then collapses — but it's deterministic and
 * dependency-free.
 */
function extractPlaintextWithRegex(html: string): string {
  // Drop head/script/style/etc. blocks entirely.
  let s = html
  for (const tag of STRIP_SUBTREE_TAGS) {
    s = s.replace(new RegExp(`<${tag}\\b[^>]*>[\\s\\S]*?</${tag}>`, 'gi'), '')
  }
  // Drop comments.
  s = s.replace(/<!--[\s\S]*?-->/g, '')
  // <br> → newline.
  s = s.replace(/<br\s*\/?>/gi, '\n')
  // Close-block tags → paragraph break.
  for (const tag of BLOCK_TAGS) {
    s = s.replace(new RegExp(`</${tag}>`, 'gi'), '\n\n')
  }
  // Strip remaining tags.
  s = s.replace(/<\/?[a-zA-Z!][^>]*>/g, '')
  // Decode entities, normalise whitespace.
  return decodeEntities(s)
    .replace(/\n{3,}/g, '\n\n')
    .trim()
}

/**
 * Public API. Use the DOM-based extractor at runtime; fall back to
 * the regex one in environments without DOMParser. The extractor is
 * deliberately permissive — any HTML body produces some text output;
 * we don't try to distinguish "plaintext-wrapped-as-HTML" from "real
 * HTML email" because the markdown pipeline handles whatever we hand
 * it without crashing.
 */
export function extractPlaintext(html: string): string {
  if (!html) return ''
  if (typeof DOMParser !== 'undefined') {
    try {
      return extractPlaintextFromDom(html)
    } catch {
      // DOMParser failures fall back to regex — better to extract
      // something than crash the viewer.
    }
  }
  return extractPlaintextWithRegex(html)
}
