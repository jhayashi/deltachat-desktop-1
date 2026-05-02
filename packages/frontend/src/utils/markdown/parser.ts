import MarkdownIt from 'markdown-it'

/**
 * Markdown rules turned off in the chat renderer.
 *
 * Rule names verified against `markdown-it`'s actual rule registries — see
 * `md.block.ruler.__rules__` and `md.inline.ruler.__rules__` for the full
 * list. Common confusions worth flagging for future readers:
 *
 *   - `code` is the **indented** code-block rule, not inline backticks.
 *     Inline code is the rule named `backticks`. We disable `code` so that
 *     a chat user pasting log lines indented by spaces does not silently get
 *     a `<pre><code>` block.
 *   - There is no `strong` rule. `emphasis` covers both `*italic*` and
 *     `**bold**`.
 *   - `link` (the `[text](url)` inline rule) and `autolink` (`<url>`) are
 *     disabled so URL detection stays with linkifyjs — preserving the
 *     existing punycode-confirmation and invite-link routing.
 */
const COMMON_DISABLE = [
  // block rules off
  'code',
  'blockquote',
  'hr',
  'list',
  'reference',
  'html_block',
  // inline rules off
  'link',
  'image',
  'autolink',
  'html_inline',
] as const

// Headings are also block-level — keep them out of the inline parser so
// quotes can't render an `# H1` inside the line-clamped quote box.
const INLINE_ONLY_EXTRA_DISABLE = [
  'fence',
  'table',
  'heading',
  'lheading',
] as const

const COMMON_OPTIONS: MarkdownIt.Options = {
  // No raw HTML — escape `<b>` etc. as text. Critical: combined with our
  // token-walker (which never uses dangerouslySetInnerHTML), this is the
  // XSS-defense story.
  html: false,
  // Don't let markdown-it auto-link URLs. Linkifyjs handles that downstream
  // and provides the punycode/invite-link safety layer.
  linkify: false,
  // Smart quotes off — chat users routinely paste code/keys/IDs and
  // typographic substitutions corrupt them.
  typographer: false,
  // The `breaks: true` option only changes markdown-it's HTML renderer.
  // Since we walk tokens directly, the option has no effect on output;
  // softbreak → <br> mapping is handled in the renderer instead.
  breaks: false,
}

/**
 * Full markdown config: bold, italic, strikethrough, inline code, fenced
 * code, tables, and ATX/Setext headings (#, ##, …). Headings render at
 * body font-size — see _message-markdown.scss for the size-flat
 * treatment. Used in message bodies and profile statuses (NOT quotes).
 */
export const fullParser: MarkdownIt = new MarkdownIt(COMMON_OPTIONS).disable(
  COMMON_DISABLE as unknown as string[]
)

/**
 * Inline-only config: bold, italic, strikethrough, inline code. No fenced
 * code blocks, no tables. Used for non-interactive contexts (quotes) where
 * the container is line-clamped and a `<pre>` or `<table>` would blow out
 * the layout.
 */
export const inlineParser: MarkdownIt = new MarkdownIt(COMMON_OPTIONS).disable([
  ...COMMON_DISABLE,
  ...INLINE_ONLY_EXTRA_DISABLE,
] as unknown as string[])
