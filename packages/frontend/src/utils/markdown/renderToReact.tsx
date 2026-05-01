import React from 'react'
import type Token from 'markdown-it/lib/token.mjs'
import type MarkdownIt from 'markdown-it'

import { getLogger } from '../../../../shared/logger.js'

const log = getLogger('renderer/markdown')

// Class names are defined in `packages/frontend/scss/message/_message-markdown.scss`
// as global styles. Using literal strings here (rather than a CSS Module
// import) keeps the renderer testable under ts-node ESM, which has no
// CSS-loader story.
const CLS = {
  paragraph: 'mm-paragraph',
  heading: 'mm-heading',
  code: 'mm-code',
  inlineCode: 'mm-inline-code',
  tableScroll: 'mm-table-scroll',
  table: 'mm-table',
} as const

// Allowed heading-tag set. markdown-it's heading_open token carries
// `tok.tag` as the string 'h1'..'h6'; this set lets us narrow safely to
// JSX intrinsic-element names without trusting an arbitrary string.
const HEADING_TAGS = new Set(['h1', 'h2', 'h3', 'h4', 'h5', 'h6'])
type HeadingTag = 'h1' | 'h2' | 'h3' | 'h4' | 'h5' | 'h6'

/**
 * Per-render context threaded through every level of the walker. The walker
 * does not own the meaning of `tabindex` / `suppressLinkify` / etc. — those
 * are interpreted by the {@link RenderTextLeafFn} the caller injects.
 */
export interface TextLeafCtx {
  tabindex: -1 | 0
  suppressLinkify?: boolean
  suppressBotCommands?: boolean
}

/**
 * Convert a flat text run into React nodes. Production callers pass the
 * linkify-aware implementation from `MessageParser.tsx`; tests can pass a
 * stub that emits plain `<span>` elements so the walker is unit-testable
 * without dragging in the full message-component chain.
 */
export type RenderTextLeafFn = (
  text: string,
  ctx: TextLeafCtx,
  parentKey: string
) => React.ReactNode[]

/**
 * Walk markdown-it tokens and produce a React node tree.
 *
 * Why a custom walker instead of markdown-it's HTML output:
 *   - keeps the existing linkifyjs / Link / EmailLink / TagLink /
 *     BotCommandSuggestion components in charge of URL-ish spans, with
 *     their punycode and invite-link safety still intact.
 *   - avoids dangerouslySetInnerHTML, so React's JSX escaping is the only
 *     XSS surface.
 *   - lets us emit stable React keys per token (positional within the
 *     parent token list) so reconciliation does not remount on re-renders.
 *
 * Bot commands inside formatting markers (`**`, `*`, `~~`, inline code) are
 * suppressed via {@link TextLeafCtx.suppressBotCommands}. See the comment
 * on `parseElements`'s options for the rationale.
 */
export function renderMarkdown(
  source: string,
  parser: MarkdownIt,
  ctx: TextLeafCtx,
  renderText: RenderTextLeafFn
): React.ReactNode[] {
  let tokens: Token[]
  try {
    tokens = parser.parse(source, {})
  } catch (err) {
    log.error('markdown parse failed, falling back to plain text', {
      input: source,
      err,
    })
    return renderText(source, ctx, 'fb')
  }
  return renderBlockTokens(tokens, ctx, '', renderText)
}

/**
 * Walk a slice of block-level tokens. `block` here means tokens that
 * appear at the top level of `parser.parse(...)` — paragraphs, fences,
 * tables, etc.
 */
function renderBlockTokens(
  tokens: Token[],
  ctx: TextLeafCtx,
  prefix: string,
  renderText: RenderTextLeafFn
): React.ReactNode[] {
  const out: React.ReactNode[] = []
  let i = 0
  let n = 0
  while (i < tokens.length) {
    const tok = tokens[i]
    const key = `${prefix}b${n++}`
    switch (tok.type) {
      case 'paragraph_open': {
        const close = findClose(tokens, i, 'paragraph_close')
        const inner = tokens.slice(i + 1, close)
        // Wrap in a block-level div so consecutive paragraphs (separated
        // by a blank line in source) render as visually distinct blocks.
        // A bare Fragment would let two paragraphs collapse into one
        // running line. The class carries `margin-block: 0` so we do not
        // inherit the user-agent <p> spacing inside a chat bubble.
        out.push(
          <div key={key} className={CLS.paragraph}>
            {renderInline(inner, ctx, key + '/', renderText)}
          </div>
        )
        i = close + 1
        break
      }
      case 'heading_open': {
        const close = findClose(tokens, i, 'heading_close')
        const inner = tokens.slice(i + 1, close)
        // markdown-it's heading_open carries the level as `tok.tag`
        // ('h1'..'h6'). Narrow defensively before handing to JSX so a
        // malformed token can't render an arbitrary tag name.
        const tagName = HEADING_TAGS.has(tok.tag)
          ? (tok.tag as HeadingTag)
          : 'h6'
        const Tag = tagName
        out.push(
          <Tag key={key} className={`${CLS.heading} mm-${tagName}`}>
            {renderInline(inner, ctx, key + '/', renderText)}
          </Tag>
        )
        i = close + 1
        break
      }
      case 'fence':
      case 'code_block': {
        // Language hint deliberately ignored — no syntax highlighting in
        // chat. If we add it later, plumb tok.info here.
        // tabIndex makes overflow horizontally scrollable via keyboard;
        // role=region + aria-label gives screen readers a landmark.
        out.push(
          <pre
            key={key}
            className={CLS.code}
            tabIndex={0}
            role='region'
            aria-label='code block'
          >
            <code>{tok.content}</code>
          </pre>
        )
        i++
        break
      }
      case 'table_open': {
        const close = findClose(tokens, i, 'table_close')
        const inner = tokens.slice(i + 1, close)
        out.push(
          <div
            key={key}
            className={CLS.tableScroll}
            tabIndex={0}
            role='region'
            aria-label='table'
          >
            <table className={CLS.table}>
              {renderTableInner(inner, ctx, key + '/', renderText)}
            </table>
          </div>
        )
        i = close + 1
        break
      }
      default: {
        // Disabled rules pass their source through, usually as a paragraph.
        // Anything else we don't recognize gets logged and skipped to avoid
        // silently swallowing tokens.
        log.warn('unknown block token type', tok.type)
        i++
      }
    }
  }
  return out
}

/**
 * Build the rows of a table. The token sequence between `table_open` and
 * `table_close` is `thead_open ... thead_close tbody_open ... tbody_close`,
 * each containing `tr_open ... tr_close` with `th_open`/`td_open` children.
 */
function renderTableInner(
  tokens: Token[],
  ctx: TextLeafCtx,
  prefix: string,
  renderText: RenderTextLeafFn
): React.ReactNode[] {
  const out: React.ReactNode[] = []
  let i = 0
  let n = 0
  while (i < tokens.length) {
    const tok = tokens[i]
    const key = `${prefix}r${n++}`
    if (tok.type === 'thead_open') {
      const close = findClose(tokens, i, 'thead_close')
      out.push(
        <thead key={key}>
          {renderTableRows(
            tokens.slice(i + 1, close),
            ctx,
            key + '/',
            renderText
          )}
        </thead>
      )
      i = close + 1
    } else if (tok.type === 'tbody_open') {
      const close = findClose(tokens, i, 'tbody_close')
      out.push(
        <tbody key={key}>
          {renderTableRows(
            tokens.slice(i + 1, close),
            ctx,
            key + '/',
            renderText
          )}
        </tbody>
      )
      i = close + 1
    } else {
      i++
    }
  }
  return out
}

function renderTableRows(
  tokens: Token[],
  ctx: TextLeafCtx,
  prefix: string,
  renderText: RenderTextLeafFn
): React.ReactNode[] {
  const out: React.ReactNode[] = []
  let i = 0
  let n = 0
  while (i < tokens.length) {
    const tok = tokens[i]
    const key = `${prefix}tr${n++}`
    if (tok.type === 'tr_open') {
      const close = findClose(tokens, i, 'tr_close')
      out.push(
        <tr key={key}>
          {renderTableCells(
            tokens.slice(i + 1, close),
            ctx,
            key + '/',
            renderText
          )}
        </tr>
      )
      i = close + 1
    } else {
      i++
    }
  }
  return out
}

function renderTableCells(
  tokens: Token[],
  ctx: TextLeafCtx,
  prefix: string,
  renderText: RenderTextLeafFn
): React.ReactNode[] {
  const out: React.ReactNode[] = []
  let i = 0
  let n = 0
  while (i < tokens.length) {
    const tok = tokens[i]
    const key = `${prefix}c${n++}`
    if (tok.type === 'th_open' || tok.type === 'td_open') {
      const Tag = tok.type === 'th_open' ? 'th' : 'td'
      const closeType = tok.type === 'th_open' ? 'th_close' : 'td_close'
      const close = findClose(tokens, i, closeType)
      // Each cell has at most one `inline` child carrying the cell content.
      const cellContents = renderInline(
        tokens.slice(i + 1, close),
        ctx,
        key + '/',
        renderText
      )
      out.push(<Tag key={key}>{cellContents}</Tag>)
      i = close + 1
    } else {
      i++
    }
  }
  return out
}

/**
 * Render a span of block tokens that contain an `inline` token. This is
 * the common case for paragraph bodies and table cell contents. Walks the
 * inline token's children using {@link renderInlineChildren}.
 */
function renderInline(
  tokens: Token[],
  ctx: TextLeafCtx,
  prefix: string,
  renderText: RenderTextLeafFn
): React.ReactNode[] {
  const out: React.ReactNode[] = []
  let n = 0
  for (const tok of tokens) {
    if (tok.type === 'inline') {
      const key = `${prefix}i${n++}`
      out.push(
        ...renderInlineChildren(
          tok.children ?? [],
          ctx,
          key + '/',
          false,
          renderText
        )
      )
    }
  }
  return out
}

/**
 * Walk inline-token children of an `inline` token (the actual text +
 * formatting). `insideFormatting` propagates down through emphasis /
 * strong / strikethrough / inline-code so nested text leaves get their
 * bot-command tokens suppressed.
 */
function renderInlineChildren(
  tokens: Token[],
  ctx: TextLeafCtx,
  prefix: string,
  insideFormatting: boolean,
  renderText: RenderTextLeafFn
): React.ReactNode[] {
  const out: React.ReactNode[] = []
  let i = 0
  let n = 0
  // The leaf-level ctx propagates suppressBotCommands when we're inside
  // any formatting marker.
  const leafCtx: TextLeafCtx = insideFormatting
    ? { ...ctx, suppressBotCommands: true }
    : ctx
  while (i < tokens.length) {
    const tok = tokens[i]
    const key = `${prefix}n${n++}`
    switch (tok.type) {
      case 'text': {
        out.push(...renderText(tok.content, leafCtx, key))
        i++
        break
      }
      case 'softbreak':
      case 'hardbreak': {
        out.push(<br key={key} />)
        i++
        break
      }
      case 'code_inline': {
        // Inline code is opaque text — don't run linkify or markdown on
        // its content.
        out.push(
          <code key={key} className={CLS.inlineCode}>
            {tok.content}
          </code>
        )
        i++
        break
      }
      case 'strong_open': {
        const close = findClose(tokens, i, 'strong_close')
        const inner = tokens.slice(i + 1, close)
        out.push(
          <strong key={key}>
            {renderInlineChildren(inner, ctx, key + '/', true, renderText)}
          </strong>
        )
        i = close + 1
        break
      }
      case 'em_open': {
        const close = findClose(tokens, i, 'em_close')
        const inner = tokens.slice(i + 1, close)
        out.push(
          <em key={key}>
            {renderInlineChildren(inner, ctx, key + '/', true, renderText)}
          </em>
        )
        i = close + 1
        break
      }
      case 's_open': {
        const close = findClose(tokens, i, 's_close')
        const inner = tokens.slice(i + 1, close)
        out.push(
          <s key={key}>
            {renderInlineChildren(inner, ctx, key + '/', true, renderText)}
          </s>
        )
        i = close + 1
        break
      }
      default: {
        log.warn('unknown inline token type', tok.type)
        i++
      }
    }
  }
  return out
}

/**
 * Find the index of the matching close token, accounting for nesting via
 * the `level` field. Block tokens use `level` 0/1, inline tokens use it
 * differently — markdown-it's `nesting` field is what tells us depth, but
 * matching by type and counting open/close at the same level is the same
 * answer in practice.
 */
function findClose(
  tokens: Token[],
  openIdx: number,
  closeType: string
): number {
  const openType = tokens[openIdx].type
  let depth = 1
  for (let i = openIdx + 1; i < tokens.length; i++) {
    if (tokens[i].type === openType) depth++
    else if (tokens[i].type === closeType) {
      depth--
      if (depth === 0) return i
    }
  }
  // Malformed token stream — log and treat the rest of the slice as
  // contents to avoid an infinite loop in the caller.
  log.warn('no matching close token', { openIdx, openType, closeType })
  return tokens.length
}
