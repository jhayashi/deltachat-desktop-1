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
