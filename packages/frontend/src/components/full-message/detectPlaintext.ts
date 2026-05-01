/**
 * Decide whether the HTML returned by `BackendRemote.rpc.getMessageHtml`
 * is "wrapped plaintext" (DC core's wrapping for a long plaintext
 * message that core truncated in the chat bubble) versus a rich HTML
 * email body.
 *
 * Wrapped-plaintext is rendered through the markdown pipeline so the
 * user sees the same formatting they would in the chat bubble. Rich
 * HTML email bodies are rendered in a sandboxed iframe.
 *
 * The heuristic biases toward false-negatives (treating wrapped
 * plaintext as HTML) — a wrapped-plaintext message that ends up in the
 * iframe path renders as plain text inside the iframe, which is uglier
 * than the markdown view but still safe and readable. A false-positive
 * (treating real HTML as plaintext) would strip formatting silently,
 * which is worse.
 *
 * Implementation note: we parse with regex rather than DOMParser so
 * the detector runs unchanged in node-based unit tests. The HTML coming
 * out of DC core's truncation wrapping is mechanically generated and
 * extremely simple — the kinds of HTML that would defeat regex parsing
 * (CDATA, deeply-nested malformed markup) are exactly the kinds we
 * want to reject anyway.
 */

export interface PlaintextDetection {
  /** True when the body is a simple wrapper around plaintext content. */
  isPlaintext: boolean
  /**
   * The extracted plaintext when {@link isPlaintext} is true; the
   * caller should feed this into the markdown renderer. Undefined
   * otherwise.
   */
  text?: string
}

/**
 * Tags whose presence makes an HTML body "rich" — we don't try to
 * unwrap any HTML containing these. Kept intentionally narrow: the
 * goal is to recognise DC core's truncation wrapping, not to
 * heuristically render arbitrary email HTML.
 */
const RICH_HTML_TAGS = [
  'script',
  'style',
  'link',
  'table',
  'img',
  'video',
  'audio',
  'iframe',
  'object',
  'embed',
  'form',
  'input',
  'svg',
  'canvas',
] as const

/**
 * Tags allowed to appear in a wrapped-plaintext document. Anything
 * outside this set falls back to the iframe path.
 */
const ALLOWED_PLAINTEXT_TAGS = new Set([
  'html',
  'head',
  'meta',
  'title',
  'body',
  'pre',
  'p',
  'div',
  'br',
  'span',
  '!doctype',
])

/**
 * Cap on the size of HTML we will attempt to unwrap. Anything larger
 * gets the iframe treatment to avoid pathological regex cost on huge
 * bodies. 500 KB is a generous ceiling for chat messages — DC core's
 * plaintext truncation rarely produces output anywhere near that.
 */
const MAX_UNWRAP_SIZE = 500 * 1024

/** Match every HTML tag opener (or the doctype declaration). */
const TAG_RE = /<\/?([a-zA-Z!][\w-]*)\b([^>]*)>/g

/** Match an inline `style=` attribute (with or without quoted value). */
const STYLE_ATTR_RE = /\sstyle\s*=/i

/**
 * Replace the most common HTML entities with their literal
 * characters. DC core's wrapped-plaintext output almost always uses
 * these and very little else; numeric and hex character references
 * are also handled.
 */
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
    .replace(/&amp;/gi, '&') // keep &amp; last so we don't double-decode
}

/** Strip all HTML tags; preserve content between them, decode entities. */
function stripTags(html: string): string {
  // Drop the entire <head> block — it contains <meta>/<title> nodes
  // whose textContent we don't want to surface as message body. The
  // regex is non-greedy and case-insensitive.
  const noHead = html.replace(/<head\b[^>]*>[\s\S]*?<\/head>/gi, '')
  // Drop comments.
  const noComments = noHead.replace(/<!--[\s\S]*?-->/g, '')
  // Strip remaining tags. `<br>` becomes a newline so single-line
  // soft-breaks survive; everything else collapses to its text.
  const text = noComments
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<\/?[^>]+>/g, '')
  return decodeEntities(text)
}

export function detectPlaintext(html: string): PlaintextDetection {
  if (!html || html.length === 0) {
    return { isPlaintext: true, text: '' }
  }
  if (html.length > MAX_UNWRAP_SIZE) {
    return { isPlaintext: false }
  }

  // Bail on inline `style=` anywhere — signals styling intent the
  // markdown view can't honour.
  if (STYLE_ATTR_RE.test(html)) {
    return { isPlaintext: false }
  }

  // Walk every tag. Any rich tag → bail. Any tag outside the allow
  // list → bail. (We accept that this is a regex parser; HTML that
  // would defeat it is exactly the HTML we don't want to unwrap.)
  TAG_RE.lastIndex = 0
  let match: RegExpExecArray | null
  while ((match = TAG_RE.exec(html)) !== null) {
    const name = match[1].toLowerCase()
    if (RICH_HTML_TAGS.includes(name as any)) {
      return { isPlaintext: false }
    }
    if (!ALLOWED_PLAINTEXT_TAGS.has(name)) {
      return { isPlaintext: false }
    }
  }

  return { isPlaintext: true, text: stripTags(html) }
}
