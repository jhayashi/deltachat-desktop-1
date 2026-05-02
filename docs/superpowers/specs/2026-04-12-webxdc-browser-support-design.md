# WebXDC Browser Target Support

## Summary

Implement WebXDC app support in the browser target (`target-browser`), enabling full WebXDC API functionality (status updates, realtime channel, sendToChat, importFiles) for apps running in sandboxed iframes opened in separate browser tabs.

## Architecture

```
Main Chat Tab                          WebXDC Tab (per app)
+-------------------------+            +---------------------------+
| runtime-browser/        |            | Wrapper page              |
|   runtime.ts            |            |   (server-rendered HTML)  |
|                         |            |                           |
| openWebxdc() --------window.open---->| <iframe sandbox=          |
|                         |            |   "allow-scripts">        |
| BroadcastChannel <------|----------->|   Bridge script           |
|   (per instance)        |            |     ^                     |
|                         |            |     | postMessage          |
| WebSocket to server     |            |     v                     |
|   (JSON-RPC)            |            |   WebXDC app              |
+-------------------------+            |     + webxdc.js bridge     |
                                       +---------------------------+
```

Communication chain:
```
WebXDC app (iframe)
  -> postMessage -> wrapper page bridge
  -> BroadcastChannel -> main chat tab runtime
  -> WebSocket -> server -> deltachat-rpc
```

And reverse for incoming events (status updates, realtime data).

## Components

### 1. Server: WebXDC file serving routes

**Location:** `packages/target-browser/src/index.ts` (add routes to existing Express app)

**Routes:**

- `GET /webxdc/:accountId/:msgId` — Serves the wrapper HTML page (not from zip)
- `GET /webxdc/:accountId/:msgId/*filepath` — Serves files from the `.xdc` zip via `dc.rpc.getWebxdcBlob(accountId, msgId, filename)`, which returns base64-encoded content

**Wrapper page generation:**
- Server-rendered HTML containing a full-viewport sandboxed iframe
- The iframe `src` points to `/webxdc/:accountId/:msgId/index.html`
- Embeds a bridge script that relays `postMessage` <-> `BroadcastChannel`
- Passes parameters (accountId, msgId, selfAddr, selfName, sendUpdateInterval, sendUpdateMaxSize) as `data-*` attributes on a DOM element

**File serving:**
- Uses `dc.rpc.getWebxdcBlob(accountId, msgId, filename)` to extract files — no manual zip handling needed
- For `index.html` specifically: appends the `webxdc.js` bridge script before `</html>` so the WebXDC API is available to the app
- Sets `Content-Type` based on file extension
- Sets `X-Content-Type-Options: nosniff`
- PDF files served as `application/octet-stream` to prevent PDF viewer exploitation

**Auth:** All routes protected by existing `authMiddleWare`.

### 2. `webxdc.js` bridge (injected into iframe)

**Location:** New file `packages/target-browser/static/webxdc.js` (bundled into dist, served by appending to `index.html`)

This script runs inside the sandboxed iframe and implements `window.webxdc`:

**Properties (from template values injected by server):**
- `webxdc.selfAddr`
- `webxdc.selfName`
- `webxdc.sendUpdateInterval`
- `webxdc.sendUpdateMaxSize`

**Methods (all communicate via `parent.postMessage`):**

- `setUpdateListener(callback, startSerial)` — Sends `{type: "setUpdateListener", startSerial}` to parent. Receives updates back via `message` events of type `statusUpdate`. Tracks `last_serial`. Returns a Promise that resolves after initial updates are delivered.
- `sendUpdate(update)` — Posts `{type: "sendUpdate", payload: update}` to parent.
- `joinRealtimeChannel()` — Posts `{type: "joinRealtimeChannel"}`. Returns a `RealtimeListener` with:
  - `send(data: Uint8Array)` — posts `{type: "realtimeSend", data: Array.from(data)}`
  - `leave()` — posts `{type: "realtimeLeave"}`, marks listener as trashed
  - `setListener(cb)` — registers callback for incoming realtime data
- `sendToChat(content)` — Serializes file content (Blob/base64/plainText) to base64, posts to parent.
- `importFiles(filters)` — Creates hidden `<input type="file">` in iframe DOM (works with `allow-scripts` sandbox). Returns `Promise<File[]>`.
- `getAllUpdates()` — Deprecated stub returning `Promise.resolve([])` with console warning.

**Inlining requirement:** Since the iframe uses `sandbox="allow-scripts"` without `allow-same-origin`, it gets an opaque origin and cannot fetch scripts by URL from the server. Both the setup values and the `webxdc.js` code must be **inlined** into `index.html` when the server serves it. The server reads `webxdc.js` from disk once at startup, then for each `index.html` request, appends:
```html
<script>
  window.__webxdc_setup = {
    selfAddr: "...",
    selfName: "...",
    sendUpdateInterval: ...,
    sendUpdateMaxSize: ...
  };
</script>
<script>{webxdc.js contents}</script>
```

### 3. Wrapper page bridge script

**Location:** Inline in the server-generated wrapper HTML

The bridge runs in the wrapper page (outside the iframe, same origin as the server). It:

1. Listens for `message` events from the iframe (postMessage)
2. Translates them into `BroadcastChannel` messages to the main chat tab
3. Listens for `BroadcastChannel` messages from the main chat tab
4. Forwards them into the iframe via `iframe.contentWindow.postMessage`

**Message format on BroadcastChannel:**
```typescript
type WebxdcBroadcastMessage =
  // From WebXDC tab -> main tab
  | { direction: "toMain", action: "sendUpdate", accountId: number, msgId: number, payload: any }
  | { direction: "toMain", action: "setUpdateListener", accountId: number, msgId: number, startSerial: number }
  | { direction: "toMain", action: "joinRealtimeChannel", accountId: number, msgId: number }
  | { direction: "toMain", action: "realtimeSend", accountId: number, msgId: number, data: number[] }
  | { direction: "toMain", action: "realtimeLeave", accountId: number, msgId: number }
  | { direction: "toMain", action: "sendToChat", accountId: number, msgId: number, payload: any }
  // From main tab -> WebXDC tab
  | { direction: "toWebxdc", action: "statusUpdate", accountId: number, msgId: number }
  | { direction: "toWebxdc", action: "realtimeData", accountId: number, msgId: number, payload: number[] }
  | { direction: "toWebxdc", action: "messageChanged", accountId: number, msgId: number }
  | { direction: "toWebxdc", action: "close" }
```

**BroadcastChannel name:** `webxdc-{accountId}-{msgId}` (one channel per WebXDC instance).

### 4. Runtime methods (main chat tab)

**Location:** `packages/target-browser/runtime-browser/runtime.ts`

**State:** A `Map<string, { channel: BroadcastChannel }>` keyed by `"{accountId}.{msgId}"` tracking open WebXDC instances.

**Method implementations:**

- **`openWebxdc(msgId, params)`**
  - Key: `"{params.accountId}.{msgId}"`
  - If already open, try to focus (best-effort — browsers limit `window.focus()`)
  - Otherwise: `window.open('/webxdc/{accountId}/{msgId}', 'webxdc-{accountId}-{msgId}')`
  - Create `BroadcastChannel('webxdc-{accountId}-{msgId}')`
  - Listen for messages from WebXDC tab, handle:
    - `sendUpdate` -> call `dc.rpc.sendWebxdcStatusUpdate(accountId, msgId, payload)`
    - `setUpdateListener` -> fetch updates via `dc.rpc.getWebxdcStatusUpdates(accountId, msgId, startSerial)`, send back
    - `joinRealtimeChannel` -> call `dc.rpc.joinWebxdcRealtimeChannel(accountId, msgId)` (or equivalent)
    - `realtimeSend` -> call `dc.rpc.sendWebxdcRealtimeData(accountId, msgId, data)`
    - `realtimeLeave` -> call `dc.rpc.leaveWebxdcRealtimeChannel(accountId, msgId)`
    - `sendToChat` -> call appropriate RPC methods to send message

- **`notifyWebxdcStatusUpdate(accountId, instanceId)`**
  - Post `{direction: "toWebxdc", action: "statusUpdate"}` to the instance's BroadcastChannel

- **`notifyWebxdcRealtimeData(accountId, instanceId, payload)`**
  - Post `{direction: "toWebxdc", action: "realtimeData", payload}` to the instance's BroadcastChannel

- **`notifyWebxdcMessageChanged(accountId, instanceId)`**
  - Post `{direction: "toWebxdc", action: "messageChanged"}` to the instance's BroadcastChannel

- **`notifyWebxdcInstanceDeleted(accountId, instanceId)`**
  - Post `{direction: "toWebxdc", action: "close"}`, close channel, remove from map

- **`closeAllWebxdcInstances()`**
  - Post close to all channels, clear map

- **`getWebxdcIconURL(accountId, msgId)`**
  - Return `"/webxdc/{accountId}/{msgId}/icon"` — served by a dedicated sub-route that calls `dc.rpc.getWebxdcInfo()` then `dc.rpc.getWebxdcBlob()` for the icon

- **`deleteWebxdcAccountData(accountId)`**
  - No-op — sandboxed iframes with opaque origins have no persistent data to clean

- **`openMapsWebxdc(accountId, chatId)`**
  - Call `dc.rpc.initWebxdcIntegration(accountId, chatId)` to get or create the maps instance, then call `openWebxdc` with the returned message ID. Falls back to logging an error if maps integration is unavailable.

### 5. Update flow detail

When a WebXDC tab first opens and the app calls `setUpdateListener(cb, startSerial)`:

1. `webxdc.js` posts `{type: "setUpdateListener", startSerial}` to parent
2. Wrapper bridge relays to main tab via BroadcastChannel
3. Main tab runtime calls `dc.rpc.getWebxdcStatusUpdates(accountId, msgId, startSerial)` to get existing updates
4. Sends each update back via BroadcastChannel -> bridge -> postMessage to iframe
5. `webxdc.js` calls the app's callback for each update, tracks `last_serial`

When a new status update arrives (from another device/contact):

1. Backend fires `WebxdcStatusUpdate` event -> frontend's `initWebxdc` handler calls `runtime.notifyWebxdcStatusUpdate(accountId, instanceId)`
2. Runtime posts notification to BroadcastChannel
3. Wrapper bridge forwards to iframe via postMessage
4. `webxdc.js` fetches new updates (posts `getUpdates` request with `last_serial`)
5. Main tab runtime fetches via RPC and sends back

## Security

- **Iframe sandbox:** `sandbox="allow-scripts"` without `allow-same-origin` gives opaque origin — no access to parent cookies, localStorage, or DOM
- **CSP on served files:** `default-src 'self'; script-src 'self' 'unsafe-inline' 'unsafe-eval' blob:; style-src 'self' 'unsafe-inline' blob:; img-src 'self' data: blob:; connect-src 'self' data: blob:; font-src 'self' data: blob:; media-src 'self' data: blob:` — Note: with an opaque origin, `'self'` won't match the server origin, so network requests are effectively blocked. The CSP is defense-in-depth.
- **Auth:** All `/webxdc/` routes require authentication via existing session middleware
- **PDF protection:** PDF files served as `application/octet-stream`
- **No network access:** Sandboxed iframe with opaque origin can't make fetch/XHR to the server. `connect-src 'self'` in the opaque origin context effectively blocks all network requests.
- **postMessage origin checking:** Bridge script validates message origins

## Files to create/modify

**New files:**
- `packages/target-browser/static/webxdc.js` — WebXDC API bridge for iframe

**Modified files:**
- `packages/target-browser/src/index.ts` — Add `/webxdc/` Express routes + wrapper page generation
- `packages/target-browser/runtime-browser/runtime.ts` — Implement 9 WebXDC runtime methods
- `packages/target-browser/bin/build.js` — Ensure `webxdc.js` is included in dist (if needed)

## Out of scope

- Internet access for integrated apps (maps.xdc) — can be added later
- Window bounds persistence — not meaningful for browser tabs
- Desktop-specific features (drag-out, tray icon)
- `desktopDragFileOut` API — Electron-only feature
