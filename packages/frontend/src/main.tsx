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
 * Match `?fullMessage=<accountId>:<messageId>` against the query string
 * the browser runtime's `openMessageHTML` opens. When the SPA boots
 * with this query present we render `<FullMessageApp>` instead of the
 * chat shell. The strict regex narrows the values so a stray query
 * param can't divert boot — both halves must be unsigned integers.
 */
function parseFullMessageParam(): {
  accountId: number
  messageId: number
} | null {
  const raw = new URLSearchParams(window.location.search).get('fullMessage')
  if (!raw) return null
  const m = raw.match(/^(\d+):(\d+)$/)
  if (!m) return null
  return { accountId: Number(m[1]), messageId: Number(m[2]) }
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
      // passive content viewer, not the chat client.
      root.render(
        <FullMessageApp
          accountId={fullMessage.accountId}
          messageId={fullMessage.messageId}
        />
      )
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
