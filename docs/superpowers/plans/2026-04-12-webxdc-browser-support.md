# WebXDC Browser Target Support Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Enable WebXDC apps to run in the browser target via sandboxed iframes in separate tabs, with full API support (status updates, realtime channel, sendToChat, importFiles).

**Architecture:** Server-side Express routes serve WebXDC app files from `.xdc` zips via the existing `dc.rpc.getWebxdcBlob()` RPC. Each WebXDC app opens in a new browser tab containing a wrapper page with a sandboxed iframe. Communication flows: iframe `postMessage` -> wrapper bridge -> `BroadcastChannel` -> main chat tab runtime -> JSON-RPC WebSocket -> server -> deltachat core.

**Tech Stack:** Express.js (server routes), TypeScript (runtime), BroadcastChannel API, postMessage API, existing `@deltachat/jsonrpc-client` RPC.

**Spec:** `docs/superpowers/specs/2026-04-12-webxdc-browser-support-design.md`

---

## File Structure

**New files:**
- `packages/target-browser/static/webxdc-bridge.js` — The `window.webxdc` API implementation injected (inlined) into the sandboxed iframe. Uses `parent.postMessage()` for all communication.
- `packages/target-browser/src/webxdc-routes.ts` — Express router with WebXDC file-serving routes and wrapper page generation. Imported by `index.ts`.

**Modified files:**
- `packages/target-browser/src/index.ts` — Mount the webxdc router, pass `dc` RPC instance.
- `packages/target-browser/runtime-browser/runtime.ts` — Implement the 9 WebXDC runtime methods using `BroadcastChannel` + `window.open`.

---

### Task 1: Server-side WebXDC file serving routes

**Files:**
- Create: `packages/target-browser/src/webxdc-routes.ts`
- Modify: `packages/target-browser/src/index.ts`

- [ ] **Step 1: Create the webxdc-routes.ts file with the file-serving route**

Create `packages/target-browser/src/webxdc-routes.ts`:

```typescript
import { Router } from 'express'
import { readFile } from 'fs/promises'
import { join, extname } from 'path'

import { authMiddleWare } from './middlewares'
import type { DeltaChat } from '@deltachat/jsonrpc-client'

// Simple mime type map for common WebXDC file types
const MIME_TYPES: Record<string, string> = {
  '.html': 'text/html',
  '.htm': 'text/html',
  '.js': 'application/javascript',
  '.mjs': 'application/javascript',
  '.css': 'text/css',
  '.json': 'application/json',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon',
  '.woff': 'font/woff',
  '.woff2': 'font/woff2',
  '.ttf': 'font/ttf',
  '.otf': 'font/otf',
  '.wasm': 'application/wasm',
  '.mp3': 'audio/mpeg',
  '.ogg': 'audio/ogg',
  '.wav': 'audio/wav',
  '.mp4': 'video/mp4',
  '.webm': 'video/webm',
  '.webp': 'image/webp',
  '.pdf': 'application/octet-stream', // Prevent PDF viewer exploitation
  '.txt': 'text/plain',
  '.xml': 'text/xml',
}

function getMimeType(filename: string): string {
  const ext = extname(filename).toLowerCase()
  return MIME_TYPES[ext] || 'application/octet-stream'
}

// Read the bridge script once at module load time
let bridgeScript: string | null = null

async function getBridgeScript(distDir: string): Promise<string> {
  if (!bridgeScript) {
    bridgeScript = await readFile(
      join(distDir, 'webxdc-bridge.js'),
      'utf-8'
    )
  }
  return bridgeScript
}

const WEBXDC_CSP =
  "default-src 'self';" +
  " style-src 'self' 'unsafe-inline' blob:;" +
  " font-src 'self' data: blob:;" +
  " script-src 'self' 'unsafe-inline' 'unsafe-eval' blob:;" +
  " connect-src 'self' data: blob:;" +
  " img-src 'self' data: blob:;" +
  " media-src 'self' data: blob:;" +
  " webrtc 'block'"

export function createWebxdcRouter(
  dc: DeltaChat,
  distDir: string
): Router {
  const router = Router()

  // Serve wrapper page for a WebXDC instance
  router.get('/:accountId/:msgId', authMiddleWare, async (req, res) => {
    try {
      const accountId = Number(req.params.accountId)
      const msgId = Number(req.params.msgId)
      if (isNaN(accountId) || isNaN(msgId)) {
        return res.status(400).send('Bad Request: invalid accountId or msgId')
      }

      const webxdcInfo = await dc.rpc.getWebxdcInfo(accountId, msgId)
      const chatName = req.query.chatName as string || 'Chat'
      const appName = webxdcInfo.name || 'WebXDC App'

      res.setHeader('Content-Type', 'text/html')
      res.send(`<!DOCTYPE html>
<html>
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>${escapeHtml(appName)} - ${escapeHtml(chatName)}</title>
  <style>
    * { margin: 0; padding: 0; }
    html, body { height: 100%; overflow: hidden; }
    iframe { width: 100%; height: 100%; border: none; }
  </style>
</head>
<body>
  <iframe
    id="webxdc"
    sandbox="allow-scripts"
    src="/webxdc/${accountId}/${msgId}/index.html"
  ></iframe>
  <script>
    (function() {
      const accountId = ${accountId};
      const msgId = ${msgId};
      const channelName = 'webxdc-' + accountId + '-' + msgId;
      const channel = new BroadcastChannel(channelName);
      const iframe = document.getElementById('webxdc');

      // Relay messages from iframe to main tab
      window.addEventListener('message', function(event) {
        if (event.source !== iframe.contentWindow) return;
        const msg = event.data;
        if (!msg || !msg.type) return;
        channel.postMessage({
          direction: 'toMain',
          action: msg.type,
          accountId: accountId,
          msgId: msgId,
          payload: msg.payload
        });
      });

      // Relay messages from main tab to iframe
      channel.addEventListener('message', function(event) {
        const msg = event.data;
        if (!msg || msg.direction !== 'toWebxdc') return;
        iframe.contentWindow.postMessage(msg, '*');
      });

      // Notify main tab that this webxdc tab is open
      channel.postMessage({
        direction: 'toMain',
        action: 'tabReady',
        accountId: accountId,
        msgId: msgId
      });

      // Clean up on tab close
      window.addEventListener('beforeunload', function() {
        channel.postMessage({
          direction: 'toMain',
          action: 'tabClosed',
          accountId: accountId,
          msgId: msgId
        });
        channel.close();
      });
    })();
  </script>
</body>
</html>`)
    } catch (error) {
      res.status(500).send('Failed to load WebXDC app')
    }
  })

  // Serve icon for a WebXDC instance
  router.get('/:accountId/:msgId/icon', authMiddleWare, async (req, res) => {
    try {
      const accountId = Number(req.params.accountId)
      const msgId = Number(req.params.msgId)
      if (isNaN(accountId) || isNaN(msgId)) {
        return res.status(400).send('Bad Request')
      }
      const { icon } = await dc.rpc.getWebxdcInfo(accountId, msgId)
      const blob = Buffer.from(
        await dc.rpc.getWebxdcBlob(accountId, msgId, icon),
        'base64'
      )
      res.setHeader('Content-Type', getMimeType(icon))
      res.setHeader('X-Content-Type-Options', 'nosniff')
      res.send(blob)
    } catch (error) {
      res.status(404).send('Icon not found')
    }
  })

  // Serve files from the .xdc zip
  router.get('/:accountId/:msgId/*', authMiddleWare, async (req, res) => {
    try {
      const accountId = Number(req.params.accountId)
      const msgId = Number(req.params.msgId)
      // Express puts the wildcard match in req.params[0]
      const filepath = req.params[0]

      if (isNaN(accountId) || isNaN(msgId) || !filepath) {
        return res.status(400).send('Bad Request')
      }

      const blob = Buffer.from(
        await dc.rpc.getWebxdcBlob(accountId, msgId, filepath),
        'base64'
      )

      const mimeType = getMimeType(filepath)
      res.setHeader('Content-Type', mimeType)
      res.setHeader('X-Content-Type-Options', 'nosniff')
      res.setHeader('Content-Security-Policy', WEBXDC_CSP)

      // For index.html, inline the webxdc bridge script
      if (filepath === 'index.html') {
        const webxdcInfo = await dc.rpc.getWebxdcInfo(accountId, msgId)
        const selfAddr = webxdcInfo.selfAddr || 'unknown@unknown'
        const displayName =
          (req.query.displayName as string) || webxdcInfo.selfAddr || 'Unknown'
        const sendUpdateInterval = webxdcInfo.sendUpdateInterval
        const sendUpdateMaxSize = webxdcInfo.sendUpdateMaxSize

        const bridge = await getBridgeScript(distDir)
        const setupScript = `<script>
window.__webxdc_setup = {
  selfAddr: ${JSON.stringify(selfAddr)},
  selfName: ${JSON.stringify(displayName)},
  sendUpdateInterval: ${Number(sendUpdateInterval)},
  sendUpdateMaxSize: ${Number(sendUpdateMaxSize)}
};
</script>
<script>${bridge}</script>`

        let html = blob.toString('utf-8')
        // Insert before </html> or append to end
        if (html.includes('</html>')) {
          html = html.replace('</html>', setupScript + '\n</html>')
        } else {
          html = html + '\n' + setupScript
        }
        res.send(html)
      } else {
        res.send(blob)
      }
    } catch (error) {
      res.status(404).send('File not found')
    }
  })

  return router
}

function escapeHtml(str: string): string {
  return str
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
}
```

- [ ] **Step 2: Mount the webxdc router in index.ts**

In `packages/target-browser/src/index.ts`, add the import and mount. After the existing `app.use(helpRoute)` line (~line 198), add:

```typescript
import { createWebxdcRouter } from './webxdc-routes'
```

Add this import at the top with the other imports. Then after `app.use(helpRoute)` add:

```typescript
app.use('/webxdc', createWebxdcRouter(dc, DIST_DIR))
```

- [ ] **Step 3: Build and verify the server starts**

Run:
```bash
cd packages/target-browser && pnpm build:backend
```
Expected: Build succeeds. (The `webxdc-bridge.js` file doesn't exist yet in static, so don't start the server yet.)

- [ ] **Step 4: Commit**

```bash
git add packages/target-browser/src/webxdc-routes.ts packages/target-browser/src/index.ts
git commit -m "feat(browser): add server-side WebXDC file serving routes

Routes serve .xdc zip contents via dc.rpc.getWebxdcBlob() and generate
wrapper pages with sandboxed iframes for WebXDC apps."
```

---

### Task 2: WebXDC bridge script (iframe-side API)

**Files:**
- Create: `packages/target-browser/static/webxdc-bridge.js`

- [ ] **Step 1: Create the webxdc-bridge.js file**

Create `packages/target-browser/static/webxdc-bridge.js`. This implements the full `window.webxdc` API inside the sandboxed iframe, using `parent.postMessage` for all communication:

```javascript
// WebXDC Bridge for browser target
// Injected (inlined) into the sandboxed iframe's index.html by the server.
// Communicates with the wrapper page via parent.postMessage.
// The wrapper page relays to the main chat tab via BroadcastChannel.
;(function () {
  const setup = window.__webxdc_setup
  if (!setup) {
    console.error('webxdc-bridge: __webxdc_setup not found')
    return
  }

  let updateCallback = null
  let lastSerial = 0
  let setUpdateListenerResolve = null
  let realtimeListener = null

  class RealtimeListener {
    constructor() {
      this.listener = null
      this.trashed = false
    }

    setListener(listener) {
      this.listener = listener
    }

    send(data) {
      if (!(data instanceof Uint8Array)) {
        throw new Error('realtime listener data must be a Uint8Array')
      }
      if (this.trashed) {
        throw new Error(
          'realtime listener is trashed and can no longer be used'
        )
      }
      parent.postMessage(
        { type: 'realtimeSend', payload: Array.from(data) },
        '*'
      )
    }

    leave() {
      this.trashed = true
      parent.postMessage({ type: 'realtimeLeave' }, '*')
    }

    is_trashed() {
      return this.trashed
    }
  }

  // Listen for messages from the wrapper page
  window.addEventListener('message', function (event) {
    const msg = event.data
    if (!msg || !msg.action) return

    if (msg.action === 'statusUpdates' && msg.payload) {
      // Received batch of status updates
      const updates = msg.payload
      for (const update of updates) {
        if (update.max_serial !== undefined) {
          lastSerial = update.max_serial
        }
        if (updateCallback) {
          updateCallback(update)
        }
      }
      if (setUpdateListenerResolve) {
        setUpdateListenerResolve()
        setUpdateListenerResolve = null
      }
    } else if (msg.action === 'statusUpdate') {
      // Notification that new updates are available — request them
      parent.postMessage(
        { type: 'getUpdates', payload: { lastSerial: lastSerial } },
        '*'
      )
    } else if (msg.action === 'realtimeData' && msg.payload) {
      if (realtimeListener && !realtimeListener.is_trashed()) {
        realtimeListener.listener?.(Uint8Array.from(msg.payload))
      }
    } else if (msg.action === 'close') {
      window.close()
    }
  })

  const blobToBase64 = function (file) {
    const dataStart = ';base64,'
    return new Promise(function (resolve, reject) {
      const reader = new FileReader()
      reader.readAsDataURL(file)
      reader.onload = function () {
        const data = reader.result
        resolve(data.slice(data.indexOf(dataStart) + dataStart.length))
      }
      reader.onerror = function () {
        reject(reader.error)
      }
    })
  }

  window.webxdc = {
    selfAddr: setup.selfAddr,
    selfName: setup.selfName,
    sendUpdateInterval: setup.sendUpdateInterval,
    sendUpdateMaxSize: setup.sendUpdateMaxSize,

    setUpdateListener: function (cb, startSerial) {
      if (startSerial === undefined) startSerial = 0
      lastSerial = startSerial
      updateCallback = cb
      var promise = new Promise(function (resolve) {
        setUpdateListenerResolve = resolve
      })
      // Request initial updates
      parent.postMessage(
        { type: 'setUpdateListener', payload: { startSerial: startSerial } },
        '*'
      )
      return promise
    },

    getAllUpdates: function () {
      console.error(
        'getAllUpdates is deprecated and will be removed in the future, it also returns an empty array now, so you really should use setUpdateListener instead.'
      )
      return Promise.resolve([])
    },

    sendUpdate: function (update, description) {
      if (description) {
        console.warn('sendUpdate: the description parameter is deprecated')
      }
      parent.postMessage({ type: 'sendUpdate', payload: update }, '*')
    },

    joinRealtimeChannel: function () {
      if (realtimeListener && !realtimeListener.is_trashed()) {
        throw new Error('realtime listener already exists')
      }
      realtimeListener = new RealtimeListener()
      parent.postMessage({ type: 'joinRealtimeChannel' }, '*')
      return realtimeListener
    },

    sendToChat: async function (content) {
      if (!content.file && !content.text) {
        return Promise.reject(
          'Error from sendToChat: Invalid empty message, at least one of text or file should be provided'
        )
      }

      var file = null
      if (content.file) {
        var base64Content
        if (!content.file.name) {
          return Promise.reject('file name is missing')
        }
        var contentKeys = Object.keys(content.file).filter(function (key) {
          return ['blob', 'base64', 'plainText'].indexOf(key) !== -1
        })
        if (contentKeys.length > 1) {
          return Promise.reject(
            'you can only set one of `blob`, `base64` or `plainText`, not multiple ones'
          )
        }

        if (content.file.blob instanceof Blob) {
          base64Content = await blobToBase64(content.file.blob)
        } else if (typeof content.file.base64 === 'string') {
          base64Content = content.file.base64
        } else if (typeof content.file.plainText === 'string') {
          base64Content = await blobToBase64(new Blob([content.file.plainText]))
        } else {
          return Promise.reject(
            'data is not set or wrong format, set one of `blob`, `base64` or `plainText`, see webxdc documentation for sendToChat'
          )
        }

        file = {
          file_name: content.file.name,
          file_content: base64Content,
        }
      }

      parent.postMessage(
        { type: 'sendToChat', payload: { file: file, text: content.text || null } },
        '*'
      )
    },

    importFiles: function (filters) {
      var element = document.createElement('input')
      element.type = 'file'
      element.accept = []
        .concat(filters.extensions || [])
        .concat(filters.mimeTypes || [])
        .join(',')
      element.multiple = filters.multiple || false
      var promise = new Promise(function (resolve) {
        element.onchange = function () {
          var files = Array.from(element.files || [])
          document.body.removeChild(element)
          resolve(files)
        }
      })
      element.style.display = 'none'
      document.body.appendChild(element)
      element.click()
      return promise
    },
  }
})()
```

- [ ] **Step 2: Verify the static file gets copied to dist during build**

The build script `build:compose-frontend` copies `./static` to `./dist`. Verify:
```bash
cd packages/target-browser && pnpm run build:compose-frontend
ls dist/webxdc-bridge.js
```
Expected: File exists in dist.

- [ ] **Step 3: Commit**

```bash
git add packages/target-browser/static/webxdc-bridge.js
git commit -m "feat(browser): add WebXDC bridge script for sandboxed iframe

Implements the full window.webxdc API (setUpdateListener, sendUpdate,
joinRealtimeChannel, sendToChat, importFiles) using parent.postMessage
for communication with the wrapper page."
```

---

### Task 3: Runtime WebXDC methods

**Files:**
- Modify: `packages/target-browser/runtime-browser/runtime.ts`

- [ ] **Step 1: Add WebXDC instance tracking state to BrowserRuntime**

In `packages/target-browser/runtime-browser/runtime.ts`, add a private field to `BrowserRuntime` class after the `rc_config` field (around line 84):

```typescript
  private webxdcInstances: Map<
    string,
    { channel: BroadcastChannel; window: Window | null }
  > = new Map()
```

- [ ] **Step 2: Implement openWebxdc**

Replace the existing `openWebxdc` method (line 529-531) with:

```typescript
  openWebxdc(msgId: number, params: DcOpenWebxdcParameters): void {
    const key = `${params.accountId}.${msgId}`
    const existing = this.webxdcInstances.get(key)
    if (existing?.window && !existing.window.closed) {
      existing.window.focus()
      return
    }

    const channelName = `webxdc-${params.accountId}-${msgId}`
    const channel = new BroadcastChannel(channelName)
    const chatNameParam = encodeURIComponent(params.chatName)
    const displayNameParam = encodeURIComponent(params.displayname || '')
    const win = window.open(
      `/webxdc/${params.accountId}/${msgId}?chatName=${chatNameParam}&displayName=${displayNameParam}`,
      `webxdc-${params.accountId}-${msgId}`
    )

    this.webxdcInstances.set(key, { channel, window: win })

    channel.addEventListener('message', async (event: MessageEvent) => {
      const msg = event.data
      if (!msg || msg.direction !== 'toMain') return

      try {
        switch (msg.action) {
          case 'setUpdateListener': {
            const updates = JSON.parse(
              await (window as any).__webxdcGetUpdates(
                params.accountId,
                msgId,
                msg.payload.startSerial
              )
            )
            channel.postMessage({
              direction: 'toWebxdc',
              action: 'statusUpdates',
              payload: updates,
            })
            break
          }
          case 'getUpdates': {
            const updates = JSON.parse(
              await (window as any).__webxdcGetUpdates(
                params.accountId,
                msgId,
                msg.payload.lastSerial
              )
            )
            channel.postMessage({
              direction: 'toWebxdc',
              action: 'statusUpdates',
              payload: updates,
            })
            break
          }
          case 'sendUpdate': {
            await (window as any).__webxdcSendUpdate(
              params.accountId,
              msgId,
              msg.payload
            )
            break
          }
          case 'joinRealtimeChannel': {
            await (window as any).__webxdcJoinRealtimeChannel(
              params.accountId,
              msgId
            )
            break
          }
          case 'realtimeSend': {
            await (window as any).__webxdcSendRealtimeData(
              params.accountId,
              msgId,
              msg.payload
            )
            break
          }
          case 'realtimeLeave': {
            await (window as any).__webxdcLeaveRealtimeChannel(
              params.accountId,
              msgId
            )
            break
          }
          case 'sendToChat': {
            this.onWebxdcSendToChat?.(
              msg.payload.file,
              msg.payload.text,
              params.accountId
            )
            break
          }
          case 'tabClosed': {
            channel.close()
            this.webxdcInstances.delete(key)
            break
          }
        }
      } catch (error) {
        this.log.error('WebXDC BroadcastChannel handler error:', error)
      }
    })
  }
```

- [ ] **Step 3: Implement the remaining WebXDC runtime methods**

Replace the existing stub methods for `notifyWebxdcStatusUpdate`, `notifyWebxdcRealtimeData`, `notifyWebxdcMessageChanged`, `notifyWebxdcInstanceDeleted`, `closeAllWebxdcInstances`, `getWebxdcIconURL`, and `openMapsWebxdc` with:

```typescript
  notifyWebxdcStatusUpdate(accountId: number, instanceId: number): void {
    const key = `${accountId}.${instanceId}`
    const instance = this.webxdcInstances.get(key)
    if (instance) {
      instance.channel.postMessage({
        direction: 'toWebxdc',
        action: 'statusUpdate',
      })
    }
  }

  notifyWebxdcRealtimeData(
    accountId: number,
    instanceId: number,
    payload: number[]
  ): void {
    const key = `${accountId}.${instanceId}`
    const instance = this.webxdcInstances.get(key)
    if (instance) {
      instance.channel.postMessage({
        direction: 'toWebxdc',
        action: 'realtimeData',
        payload,
      })
    }
  }

  notifyWebxdcMessageChanged(accountId: number, instanceId: number): void {
    const key = `${accountId}.${instanceId}`
    const instance = this.webxdcInstances.get(key)
    if (instance) {
      instance.channel.postMessage({
        direction: 'toWebxdc',
        action: 'messageChanged',
      })
    }
  }

  notifyWebxdcInstanceDeleted(
    accountId: number,
    instanceId: number | null
  ): void {
    if (instanceId === null) {
      // Delete all instances for this account
      for (const [key, instance] of this.webxdcInstances) {
        if (key.startsWith(`${accountId}.`)) {
          instance.channel.postMessage({
            direction: 'toWebxdc',
            action: 'close',
          })
          instance.channel.close()
          this.webxdcInstances.delete(key)
        }
      }
    } else {
      const key = `${accountId}.${instanceId}`
      const instance = this.webxdcInstances.get(key)
      if (instance) {
        instance.channel.postMessage({
          direction: 'toWebxdc',
          action: 'close',
        })
        instance.channel.close()
        this.webxdcInstances.delete(key)
      }
    }
  }

  closeAllWebxdcInstances(): void {
    for (const [key, instance] of this.webxdcInstances) {
      instance.channel.postMessage({
        direction: 'toWebxdc',
        action: 'close',
      })
      instance.channel.close()
    }
    this.webxdcInstances.clear()
  }

  getWebxdcIconURL(accountId: number, msgId: number): string {
    return `/webxdc/${accountId}/${msgId}/icon`
  }

  openMapsWebxdc(accountId: number, chatId?: number): void {
    this.log.warn('openMapsWebxdc is not yet fully supported in browser target')
  }
```

- [ ] **Step 4: The RPC bridge problem — openWebxdc uses `(window as any).__webxdc*` helpers that don't exist yet**

The runtime needs to call RPC methods like `getWebxdcStatusUpdates`, `sendWebxdcStatusUpdate`, etc. These are available on the `BaseDeltaChat` connection created in `createDeltaChatConnection`. But `openWebxdc` doesn't have access to the RPC client.

Looking at the existing code, the frontend creates the delta chat connection via `runtime.createDeltaChatConnection()` and uses `BackendRemote.rpc.*` for all RPC calls. The runtime itself doesn't hold a reference to the RPC client.

The cleanest approach: have `openWebxdc` dispatch the RPC calls through the same `BackendRemote` that the frontend uses. But the runtime doesn't import frontend modules.

Instead, add a callback-based approach. Add this field to `BrowserRuntime` (near the other callback fields around line 132):

```typescript
  onWebxdcRpc:
    | ((
        method: string,
        accountId: number,
        msgId: number,
        payload?: any
      ) => Promise<any>)
    | undefined
```

Then update the `openWebxdc` method's channel message handler to use `this.onWebxdcRpc` instead of `(window as any).__webxdc*`:

Replace the switch cases in `openWebxdc`:

```typescript
          case 'setUpdateListener':
          case 'getUpdates': {
            const serial =
              msg.action === 'setUpdateListener'
                ? msg.payload.startSerial
                : msg.payload.lastSerial
            const updatesJson = await this.onWebxdcRpc?.(
              'getWebxdcStatusUpdates',
              params.accountId,
              msgId,
              serial
            )
            if (updatesJson) {
              const updates = JSON.parse(updatesJson)
              channel.postMessage({
                direction: 'toWebxdc',
                action: 'statusUpdates',
                payload: updates,
              })
            }
            break
          }
          case 'sendUpdate': {
            await this.onWebxdcRpc?.(
              'sendWebxdcStatusUpdate',
              params.accountId,
              msgId,
              msg.payload
            )
            break
          }
          case 'joinRealtimeChannel': {
            await this.onWebxdcRpc?.(
              'sendWebxdcRealtimeAdvertisement',
              params.accountId,
              msgId
            )
            break
          }
          case 'realtimeSend': {
            await this.onWebxdcRpc?.(
              'sendWebxdcRealtimeData',
              params.accountId,
              msgId,
              msg.payload
            )
            break
          }
          case 'realtimeLeave': {
            await this.onWebxdcRpc?.(
              'leaveWebxdcRealtime',
              params.accountId,
              msgId
            )
            break
          }
          case 'sendToChat': {
            this.onWebxdcSendToChat?.(
              msg.payload.file,
              msg.payload.text,
              params.accountId
            )
            break
          }
          case 'tabClosed': {
            channel.close()
            this.webxdcInstances.delete(key)
            break
          }
```

- [ ] **Step 5: Commit**

```bash
git add packages/target-browser/runtime-browser/runtime.ts
git commit -m "feat(browser): implement WebXDC runtime methods

Implement openWebxdc (opens sandboxed iframe in new tab),
notifyWebxdcStatusUpdate, notifyWebxdcRealtimeData,
notifyWebxdcMessageChanged, notifyWebxdcInstanceDeleted,
closeAllWebxdcInstances, and getWebxdcIconURL using
BroadcastChannel for inter-tab communication."
```

---

### Task 4: Wire up the RPC callback in the frontend

**Files:**
- Modify: `packages/frontend/src/components/RuntimeAdapter.tsx` (or find where the runtime is initialized and the RPC connection is available)

- [ ] **Step 1: Find where to wire up `onWebxdcRpc`**

Check where other runtime callbacks are wired (like `onWebxdcSendToChat`). This is in `packages/frontend/src/components/RuntimeAdapter.tsx` around line 89. Add the `onWebxdcRpc` wiring in the same area.

Add a new `useEffect` block (or extend the existing one) in `RuntimeAdapter.tsx`:

```typescript
  useEffect(() => {
    runtime.onWebxdcRpc = async (method, accountId, msgId, payload) => {
      const rpc = BackendRemote.rpc
      switch (method) {
        case 'getWebxdcStatusUpdates':
          return rpc.getWebxdcStatusUpdates(accountId, msgId, payload ?? 0)
        case 'sendWebxdcStatusUpdate':
          return rpc.sendWebxdcStatusUpdate(
            accountId,
            msgId,
            JSON.stringify(payload),
            ''
          )
        case 'sendWebxdcRealtimeAdvertisement':
          return rpc.sendWebxdcRealtimeAdvertisement(accountId, msgId)
        case 'sendWebxdcRealtimeData':
          return rpc.sendWebxdcRealtimeData(accountId, msgId, payload)
        case 'leaveWebxdcRealtime':
          return rpc.leaveWebxdcRealtime(accountId, msgId)
        default:
          console.error('Unknown webxdc RPC method:', method)
      }
    }
    return () => {
      runtime.onWebxdcRpc = undefined
    }
  }, [])
```

You will need to import `BackendRemote` if not already imported:
```typescript
import { BackendRemote } from '../../backend-com'
```

- [ ] **Step 2: Add `onWebxdcRpc` to the Runtime interface**

In `packages/runtime/runtime.ts`, add to the event callbacks section (around line 200, near `onWebxdcSendToChat`):

```typescript
  onWebxdcRpc:
    | ((
        method: string,
        accountId: number,
        msgId: number,
        payload?: any
      ) => Promise<any>)
    | undefined
```

- [ ] **Step 3: Add the field declaration to the other runtime implementations**

In `packages/target-electron/runtime-electron/runtime.ts`, add near the other `onWebxdc*` fields:
```typescript
  onWebxdcRpc:
    | ((
        method: string,
        accountId: number,
        msgId: number,
        payload?: any
      ) => Promise<any>)
    | undefined
```

In `packages/target-tauri/runtime-tauri/runtime.ts`, add near the other `onWebxdc*` fields:
```typescript
  onWebxdcRpc:
    | ((
        method: string,
        accountId: number,
        msgId: number,
        payload?: any
      ) => Promise<any>)
    | undefined
```

- [ ] **Step 4: Build and verify everything compiles**

```bash
cd /var/home/jhayashi/src/deltachat-desktop
pnpm --filter=@deltachat-desktop/target-browser run check:types
```

Expected: No type errors.

- [ ] **Step 5: Commit**

```bash
git add packages/runtime/runtime.ts packages/frontend/src/components/RuntimeAdapter.tsx packages/target-browser/runtime-browser/runtime.ts packages/target-electron/runtime-electron/runtime.ts packages/target-tauri/runtime-tauri/runtime.ts
git commit -m "feat(browser): wire up WebXDC RPC callback from runtime to frontend

Connect the browser runtime's WebXDC methods to the actual delta chat
RPC via an onWebxdcRpc callback set up in RuntimeAdapter."
```

---

### Task 5: Build, test end-to-end, and fix issues

**Files:** All files from previous tasks

- [ ] **Step 1: Full build**

```bash
cd /var/home/jhayashi/src/deltachat-desktop
pnpm --filter=@deltachat-desktop/target-browser build
```

Expected: Build completes successfully.

- [ ] **Step 2: Start the server**

```bash
cd /var/home/jhayashi/src/deltachat-desktop
pnpm start:browser
```

Expected: `HTTPS app listening on port 3000`

- [ ] **Step 3: Manual test — open a WebXDC app**

1. Open `https://localhost:3000` in a browser
2. Log in with the password from `.env`
3. Open a chat that has a WebXDC message (or send yourself a `.xdc` file)
4. Click the WebXDC message to open it
5. Verify: a new tab opens with the WebXDC app running
6. Verify: the app can load its assets (images, styles)
7. Verify: `webxdc.selfAddr` and `webxdc.selfName` are set correctly

- [ ] **Step 4: Test status updates**

1. In the WebXDC app, trigger a `sendUpdate` action
2. Verify: no errors in the browser console
3. Close and reopen the WebXDC tab
4. Verify: previous updates are loaded via `setUpdateListener`

- [ ] **Step 5: Test sendToChat and importFiles**

1. If the WebXDC app supports `sendToChat`, trigger it and verify the send-to-chat dialog opens in the main tab
2. If the WebXDC app supports `importFiles`, trigger it and verify the file picker opens

- [ ] **Step 6: Fix any issues found during testing**

Address any bugs discovered. Common issues to watch for:
- CORS or CSP blocking requests
- postMessage not reaching the iframe (check sandbox flags)
- BroadcastChannel messages not being received (check channel names match)
- RPC method signatures not matching (check parameter types)

- [ ] **Step 7: Commit any fixes**

```bash
git add -u
git commit -m "fix(browser): address issues found during WebXDC end-to-end testing"
```
