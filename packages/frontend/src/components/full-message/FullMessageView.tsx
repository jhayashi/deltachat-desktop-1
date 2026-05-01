import React, { useEffect, useState } from 'react'
import moment from 'moment'

import { BackendRemote, Type } from '../../backend-com'
import { getLogger } from '../../../../shared/logger'
import { renderMarkdown } from '../../utils/markdown/renderToReact'
import { fullParser } from '../../utils/markdown/parser'
import { TextLeafCtx, renderTextLeaf } from '../message/MessageParser'
import { detectPlaintext } from './detectPlaintext'

const log = getLogger('renderer/full-message-view')

/**
 * Standalone viewer for the "Show Full Message…" tab in the browser
 * target. Mirrors what the Electron edition does in a separate
 * BrowserWindow: shows subject + sender + receive time, then the full
 * body. For wrapped-plaintext bodies we render through the markdown
 * pipeline; for rich HTML email bodies we use a sandboxed iframe.
 */
export function FullMessageView({
  accountId,
  messageId,
}: {
  accountId: number
  messageId: number
}) {
  const [state, setState] = useState<
    | { kind: 'loading' }
    | { kind: 'error'; error: string }
    | {
        kind: 'ready'
        message: Type.Message
        html: string
      }
  >({ kind: 'loading' })

  useEffect(() => {
    let cancelled = false
    ;(async () => {
      try {
        const [message, html] = await Promise.all([
          BackendRemote.rpc.getMessage(accountId, messageId),
          BackendRemote.rpc.getMessageHtml(accountId, messageId),
        ])
        if (cancelled) return
        if (html == null) {
          setState({
            kind: 'error',
            error: 'Message has no full content available.',
          })
          return
        }
        setState({ kind: 'ready', message, html })
      } catch (err) {
        log.error('failed to load full message', err)
        if (cancelled) return
        setState({
          kind: 'error',
          error: err instanceof Error ? err.message : String(err),
        })
      }
    })()
    return () => {
      cancelled = true
    }
  }, [accountId, messageId])

  // Set the document title to the subject so the browser tab shows
  // something useful — falls back to a generic title before the
  // message loads.
  useEffect(() => {
    if (state.kind === 'ready') {
      document.title = state.message.subject || 'Full message'
    }
  }, [state])

  if (state.kind === 'loading') {
    return <div className='full-message-loading'>Loading…</div>
  }
  if (state.kind === 'error') {
    return (
      <div className='full-message-error' role='alert'>
        {state.error}
      </div>
    )
  }
  return <FullMessageReady message={state.message} html={state.html} />
}

function FullMessageReady({
  message,
  html,
}: {
  message: Type.Message
  html: string
}) {
  const subject = message.subject || ''
  const sender = message.overrideSenderName || message.sender.displayName
  const receiveTime = moment(message.receivedTimestamp * 1000).format('LLLL')

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
 * Render the unwrapped plaintext through the full markdown pipeline.
 * `tabindex: 0` so links inside the body are keyboard-focusable; the
 * leaf renderer wires linkify exactly as in the chat bubble.
 */
function PlaintextBody({ text }: { text: string }) {
  const ctx: TextLeafCtx = { tabindex: 0 }
  return (
    <div className='full-message-plaintext'>
      {renderMarkdown(text, fullParser, ctx, renderTextLeaf)}
    </div>
  )
}

/**
 * Render rich HTML email content in a sandboxed iframe. The CSP meta
 * tag injected at the top of the srcdoc blocks scripts, remote
 * stylesheets, and remote images — so a hostile email body cannot
 * fetch trackers or run JS. `sandbox="allow-same-origin"` is omitted
 * deliberately: with no allow-* tokens the iframe runs as a unique
 * origin with scripts disabled, which is what we want.
 */
function HtmlBody({ html }: { html: string }) {
  // Inject a strict CSP meta at the very top so the browser sees it
  // before any external-resource hint in the email body. `default-src
  // 'none'` denies everything; `style-src 'unsafe-inline'` is the only
  // concession because most email HTML uses inline `<style>` blocks
  // (we already filtered <style> out via detectPlaintext, so any HTML
  // that reaches here may need it).
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
