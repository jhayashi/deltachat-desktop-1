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
