import React from 'react'
import { createRoot } from 'react-dom/client'

import App from './App'
import FullMessageApp from './FullMessageApp'
import initSystemIntegration from './system-integration'
import { exp } from './experimental'
import {
  getLogger,
  printProcessLogLevelInfo,
  setLogHandler,
} from '../../shared/logger'
import { runtime } from '@deltachat-desktop/runtime-interface'

/**
 * Look up a `?fullMessage=<token>` payload that the opener stashed in
 * localStorage. The new tab does NOT open a JSON-RPC connection of
 * its own — the server only allows one active DC client at a time, so
 * a second `/ws/dc` connection would kick the original chat tab.
 * Instead the opener pre-fetched the message and handed it off via
 * localStorage; we read and clear the entry here.
 *
 * Returns `null` for "this isn't a full-message tab" so boot stays on
 * the normal path. Returns `'expired'` when the token is present but
 * has no payload (refreshed tab, expired handoff, or never written).
 */
type FullMessagePayload = {
  isContactRequest: boolean
  subject: string
  sender: string
  receiveTime: string
  html: string
}
function parseFullMessageParam():
  | { kind: 'payload'; data: FullMessagePayload }
  | { kind: 'expired' }
  | null {
  const raw = new URLSearchParams(window.location.search).get('fullMessage')
  if (!raw) return null
  // Token is a UUID or short random string — keep the regex permissive
  // but not so permissive that arbitrary user content in the query
  // would slip in.
  if (!/^[a-zA-Z0-9_-]{6,128}$/.test(raw)) return null

  let stored: string | null = null
  try {
    stored = localStorage.getItem(`fmsg:${raw}`)
    if (stored != null) {
      localStorage.removeItem(`fmsg:${raw}`)
    }
  } catch {
    // localStorage unavailable — treat as expired.
  }
  if (stored == null) return { kind: 'expired' }
  try {
    const parsed = JSON.parse(stored) as FullMessagePayload & {
      savedAt: number
    }
    return {
      kind: 'payload',
      data: {
        isContactRequest: !!parsed.isContactRequest,
        subject: String(parsed.subject ?? ''),
        sender: String(parsed.sender ?? ''),
        receiveTime: String(parsed.receiveTime ?? ''),
        html: String(parsed.html ?? ''),
      },
    }
  } catch {
    return { kind: 'expired' }
  }
}

async function main() {
  // eslint-disable-next-line @typescript-eslint/no-unused-expressions
  exp.help //make sure experimental.ts is used
  try {
    await runtime.initialize(setLogHandler, getLogger)
    printProcessLogLevelInfo()

    const fullMessage = parseFullMessageParam()
    const domNode = document.querySelector('#root')
    if (!domNode) {
      throw new Error('No element with ID root in the DOM. Cannot continue')
    }
    const root = createRoot(domNode)
    if (fullMessage) {
      // Standalone "show full message" tab — no system integration
      // (notifications, badge counter, webxdc) because this view is a
      // passive content viewer, not the chat client. We also avoid
      // touching `BackendRemote` here because importing
      // `backend-com.ts` would open a `/ws/dc` connection and steal
      // the chat tab's session.
      root.render(<FullMessageApp {...fullMessage} />)
    } else {
      initSystemIntegration()
      root.render(<App />)
    }
  } catch (error) {
    document.write(
      'Error while initialisation, please contact developers and look into the dev console for details:' +
        error
    )
    throw error
  }
}

main()
