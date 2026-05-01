import { BaseDeltaChat, DcEvent } from '@deltachat/jsonrpc-client'
import { runtime } from '@deltachat-desktop/runtime-interface'
import { clearNotificationsForChat } from './system-integration/notifications'
import { countCall } from './debug-tools'

export { T as Type } from '@deltachat/jsonrpc-client'

/**
 * Lazy-initialised JSON-RPC client. The connection (`/ws/dc` in the
 * browser target, stdio in Electron/Tauri) is opened the first time
 * any property is accessed — not at module load. This matters
 * because `import {BackendRemote} from './backend-com'` is
 * transitively pulled in by `App.tsx` and several system-integration
 * modules, which are imported even on boot paths that don't actually
 * use the chat backend (e.g. the standalone "show full message" tab
 * in the browser target). Opening a second `/ws/dc` connection there
 * would steal the chat tab's session — the browser server kicks the
 * previously-active client.
 *
 * The Proxy is transparent to consumers — `BackendRemote.rpc` and
 * `BackendRemote.on(...)` work exactly as before, just deferred to
 * first call.
 */
let _backendRemoteImpl: BaseDeltaChat<any> | null = null
function getBackendRemote(): BaseDeltaChat<any> {
  if (_backendRemoteImpl === null) {
    _backendRemoteImpl = runtime.createDeltaChatConnection(countCall)
  }
  return _backendRemoteImpl
}
export const BackendRemote: BaseDeltaChat<any> = new Proxy(
  {} as BaseDeltaChat<any>,
  {
    get(_target, prop, _receiver) {
      const real = getBackendRemote() as any
      const value = real[prop]
      // Bind methods so `this` resolves to the real instance even when
      // a caller destructures (e.g. `const {rpc} = BackendRemote`).
      return typeof value === 'function' ? value.bind(real) : value
    },
  }
)

/** Functions with side-effects */
export namespace EffectfulBackendActions {
  export async function removeAccount(account_id: number) {
    // unselect the account in the UI if its selected
    if (window.__selectedAccountId === account_id) {
      throw new Error(
        'Can not remove the selected account, please unselect it first'
      )
    }

    // remove the account
    await BackendRemote.rpc.removeAccount(account_id)

    // if successful remove webxdc data
    runtime.deleteWebxdcAccountData(account_id)
  }

  export async function blockChat(accountId: number, chatId: number) {
    await BackendRemote.rpc.blockChat(accountId, chatId)
    clearNotificationsForChat(accountId, chatId)
  }

  export async function deleteChat(accountId: number, chatId: number) {
    await BackendRemote.rpc.deleteChat(accountId, chatId)
    clearNotificationsForChat(accountId, chatId)
  }
}

type ContextEvents = { ALL: (event: DcEvent) => void } & {
  [Property in DcEvent['kind']]: (
    event: Extract<DcEvent, { kind: Property }>
  ) => void
}

/** For use in react useEffect hooks, already returns the cleanup function
 *
 * ```
 * // one event
 * useEffect(onDCEvent(accountId, 'Info', () => {}), [])
 * // multiple events
 * useEffect(() => {
 *   const cleanup = [
 *     onDCEvent(accountId, 'Info', () => {}),
 *     onDCEvent(accountId, 'IncomingMsg', () => {}),
 *     onDCEvent(accountId, 'ContactsChanged', () => {})
 *   ]
 *   return () => cleanup.forEach(off => off())
 * }, [])
 * ```
 */
export function onDCEvent<variant extends keyof ContextEvents>(
  accountId: number,
  eventType: variant,
  callback: ContextEvents[variant]
) {
  const emitter = BackendRemote.getContextEvents(accountId)
  emitter.on(eventType, callback)
  return () => {
    emitter.off(eventType, callback)
  }
}
