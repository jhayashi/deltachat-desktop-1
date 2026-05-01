import React, { useEffect } from 'react'

import {
  renderMarkdown,
  RenderTextLeafFn,
  TextLeafCtx,
} from '../../utils/markdown/renderToReact'
import { fullParser } from '../../utils/markdown/parser'
import { parseElements } from '../../utils/linkify/parseElements'
import { detectPlaintext } from './detectPlaintext'

/**
 * Props handed off from the opener tab via localStorage. The new tab
 * never fetches anything via JSON-RPC — opening a `/ws/dc` connection
 * would steal the chat tab's session, since the browser server only
 * allows one active DC client at a time. See `parseFullMessageParam`
 * in `main.tsx` for the handoff mechanism.
 */
export interface FullMessageViewProps {
  isContactRequest: boolean
  subject: string
  sender: string
  receiveTime: string
  /** HTML returned by `getMessageHtml` for the message. */
  html: string
}

/**
 * Standalone viewer for the "Show Full Message…" tab in the browser
 * target. Mirrors what the Electron edition does in a separate
 * BrowserWindow: shows subject + sender + receive time, then the full
 * body. For wrapped-plaintext bodies we render through the markdown
 * pipeline; for rich HTML email bodies we use a sandboxed iframe.
 */
export function FullMessageView({
  subject,
  sender,
  receiveTime,
  html,
}: FullMessageViewProps) {
  useEffect(() => {
    document.title = subject || 'Full message'
  }, [subject])

  const detection = detectPlaintext(html)

  return (
    <div className='full-message-view'>
      <header className='full-message-header'>
        {subject && <h1 className='full-message-subject'>{subject}</h1>}
        <div className='full-message-meta'>
          <span className='full-message-sender'>{sender}</span>
          <span className='full-message-time'>{receiveTime}</span>
        </div>
      </header>
      <main className='full-message-body'>
        {detection.isPlaintext ? (
          <PlaintextBody text={detection.text ?? ''} />
        ) : (
          <HtmlBody html={html} />
        )}
      </main>
    </div>
  )
}

/**
 * Standalone leaf renderer for the full-message view. Unlike the chat
 * bubble's renderer, this one does not depend on `<ChatProvider>` /
 * `useChat` / draft-message machinery — the standalone tab has no
 * chat shell and no JSON-RPC connection. URLs become plain
 * `target="_blank"` anchors; emails become `mailto:` anchors;
 * hashtags and bot commands fall back to plain spans (interaction
 * would route into chat state we don't have here).
 */
const renderFullMessageLeaf: RenderTextLeafFn = (
  text,
  ctx,
  parentKey
): React.ReactNode[] => {
  if (ctx.suppressLinkify) {
    return [<span key={`${parentKey}t0`}>{text}</span>]
  }
  const elements = parseElements(text, {
    suppressBotCommands: ctx.suppressBotCommands,
  })
  return elements.map((el, i) => {
    const key = `${parentKey}t${i}`
    switch (el.t) {
      case 'url': {
        // linkify returns the matched URL text; default to https for
        // schemeless matches. `noreferrer` strips Referer, `noopener`
        // blocks window.opener shenanigans on the destination page.
        const href = /^[a-z][a-z0-9+.-]*:/i.test(el.v)
          ? el.v
          : `https://${el.v}`
        return (
          <a key={key} href={href} target='_blank' rel='noreferrer noopener'>
            {el.v}
          </a>
        )
      }
      case 'email': {
        return (
          <a key={key} href={`mailto:${el.v}`}>
            {el.v}
          </a>
        )
      }
      case 'nl':
        return <span key={key}>{'\n'}</span>
      default:
        return <span key={key}>{el.v}</span>
    }
  })
}

/**
 * Render the unwrapped plaintext through the full markdown pipeline,
 * using the standalone leaf renderer above.
 */
function PlaintextBody({ text }: { text: string }) {
  const ctx: TextLeafCtx = { tabindex: 0 }
  return (
    <div className='full-message-plaintext'>
      {renderMarkdown(text, fullParser, ctx, renderFullMessageLeaf)}
    </div>
  )
}

/**
 * Render rich HTML email content in a sandboxed iframe. The CSP meta
 * tag injected at the top of the srcdoc blocks scripts, remote
 * stylesheets, and remote images — so a hostile email body cannot
 * fetch trackers or run JS. With `sandbox=""` (no allow-* tokens)
 * the iframe runs as a unique origin with scripts disabled.
 */
function HtmlBody({ html }: { html: string }) {
  const csp =
    "default-src 'none'; " +
    "style-src 'unsafe-inline'; " +
    'img-src cid: data:; ' +
    'font-src data:; ' +
    "frame-ancestors 'none'; " +
    "base-uri 'none'"
  const srcdoc =
    `<!doctype html><meta http-equiv="Content-Security-Policy" content="${csp}">` +
    html

  return (
    <iframe
      className='full-message-iframe'
      sandbox=''
      srcDoc={srcdoc}
      title='Full message'
    />
  )
}
