import { useCallback, useSyncExternalStore } from 'react'
import { C } from '@deltachat/jsonrpc-client'
import { DesktopSettingsType, RC_Config } from '../../../shared/shared-types'
import { BackendRemote, Type } from '../backend-com'
import { onReady } from '../onready'
import { runtime } from '@deltachat-desktop/runtime-interface'
import { Store, useStore } from './store'
import { throttledUpdateBadgeCounter } from '../system-integration/badge-counter'
import { migrateLegacyMarkdownSetting } from './settings-migrations'

export interface SettingsStoreState {
  accountId: number
  selfContact: Type.Contact
  settings: {
    [P in (typeof settingsKeys)[number]]: {
      mvbox_move: string
      configured_addr: string
      displayname: string
      selfstatus: string
      mdns_enabled: string
      show_emails: string
      bcc_self: string
      delete_device_after: string
      delete_server_after: string
      download_limit: string
      only_fetch_mvbox: string
      media_quality: string
      is_chatmail: '0' | '1'
      who_can_call_me: WhoCanCallMe
      'ui.mentions_enabled': '0' | '1'
    }[P]
  }
  desktopSettings: DesktopSettingsType
  rc: RC_Config
}

const settingsKeys = [
  'mvbox_move',
  'configured_addr',
  'displayname',
  'selfstatus',
  'mdns_enabled',
  'show_emails',
  'bcc_self',
  'delete_device_after',
  'delete_server_after',
  'download_limit',
  'only_fetch_mvbox',
  'media_quality',
  'is_chatmail',
  'who_can_call_me',
  'ui.mentions_enabled',
] as const

export const enum WhoCanCallMe {
  Everybody = '0',
  Contacts = '1',
  Nobody = '2',
}

export const mentionsEnabledDefaultVal: SettingsStoreState['settings']['ui.mentions_enabled'] =
  '1'

class SettingsStore extends Store<SettingsStoreState | null> {
  reducer = {
    setState: (newState: SettingsStoreState | null) => {
      this.setState(_state => {
        return newState
      }, 'set')
    },
    setSelfContact: (selfContact: Type.Contact) => {
      this.setState(state => {
        if (state === null) return
        return {
          ...state,
          selfContact,
        }
      }, 'setSelfContact')
    },
    setDesktopSetting: (
      key: keyof DesktopSettingsType,
      value: string | number | boolean
    ) => {
      this.setState(state => {
        if (state === null) {
          this.log.warn(
            'trying to update local version of desktop settings object, but it was not loaded yet'
          )
          return
        }
        return {
          ...state,
          desktopSettings: {
            ...state.desktopSettings,
            [key]: value,
          },
        }
      }, 'setDesktopSetting')
    },
    setCoreSetting: (
      key: keyof SettingsStoreState['settings'],
      value: string | boolean
    ) => {
      this.setState(state => {
        if (state === null) {
          this.log.warn(
            'trying to update local version of core settings object, but it was not loaded yet'
          )
          return
        }
        return {
          ...state,
          settings: {
            ...state.settings,
            [key]: value,
          },
        }
      }, 'setCoreSetting')
    },
  }
  effect = {
    clear: () => {
      this.reducer.setState(null)
      this.log.info('cleared settings store')
    },
    load: async () => {
      const accountId = window.__selectedAccountId
      if (accountId === undefined) {
        throw new Error('can not load settings when no account is selected')
      }

      const [settings, selfContact, desktopSettings] = await Promise.all([
        BackendRemote.rpc.batchGetConfig(
          accountId,
          settingsKeys as unknown as Array<(typeof settingsKeys)[number]>
        ) as Promise<SettingsStoreState['settings']>,
        BackendRemote.rpc.getContact(accountId, C.DC_CONTACT_ID_SELF),
        runtime.getDesktopSettings(),
      ])

      if (settings['ui.mentions_enabled'] == null) {
        settings['ui.mentions_enabled'] = mentionsEnabledDefaultVal
      }

      await migrateLegacyMarkdownSetting(
        desktopSettings,
        runtime.setDesktopSetting.bind(runtime)
      )

      const rc = runtime.getRC_Config()
      this.reducer.setState({
        settings,
        selfContact,
        accountId,
        desktopSettings,
        rc,
      })
    },
    loadCoreKey: async (
      accountId: number,
      key: keyof SettingsStoreState['settings']
    ) => {
      if (
        this.state &&
        this.state.accountId === accountId &&
        settingsKeys.includes(key)
      ) {
        const newValue = await BackendRemote.rpc.getConfig(
          this.state.accountId,
          key
        )
        // console.info('loadCoreKey', key, newValue)

        this.setState(state => {
          if (state === null || state.accountId !== accountId) {
            return
          }
          return { ...state, settings: { ...state.settings, [key]: newValue } }
        }, 'set')
      }
    },
    setDesktopSetting: async (
      key: keyof DesktopSettingsType,
      value: string | number | boolean
    ) => {
      try {
        if (key === 'messageMarkdownEnabled') {
          // Clear the legacy key BEFORE saving the new one. If the second
          // write fails (IPC drop on shutdown, etc.), we want the failure
          // mode to be "user's just-toggled preference didn't persist"
          // (recoverable: they re-toggle next launch) rather than
          // "preference saved, legacy still set" (unrecoverable: next
          // launch's migration overwrites the new value with the stale
          // legacy one). See settings-migrations.ts.
          await runtime.setDesktopSetting(
            'experimentalEnableMarkdownInMessages',
            undefined
          )
        }
        await runtime.setDesktopSetting(key, value)
        if (key === 'syncAllAccounts') {
          if (value) {
            BackendRemote.rpc.startIoForAllAccounts()
          } else {
            BackendRemote.rpc.stopIoForAllAccounts()
          }
          if (this.state?.accountId) {
            BackendRemote.rpc.startIo(this.state.accountId)
          }
          throttledUpdateBadgeCounter()
          window.__updateAccountListSidebar?.()
        }
        this.reducer.setDesktopSetting(key, value)
      } catch (error) {
        this.log.error('failed to apply desktop setting:', error)
      }
    },
    setCoreSetting: async (
      key: keyof SettingsStoreState['settings'],
      value: string | boolean
    ) => {
      try {
        if (!this.state) {
          throw new Error('no account selected')
        }
        await BackendRemote.rpc.setConfig(
          this.state.accountId,
          key,
          String(value)
        )
        this.reducer.setCoreSetting(key, value)
      } catch (error) {
        this.log.warn('setConfig failed:', error)
      }
    },
  }
}

onReady(() => {
  const updateSelfAvatar = async (accountId: number) => {
    if (accountId === window.__selectedAccountId) {
      const selfContact = await BackendRemote.rpc.getContact(
        accountId,
        C.DC_CONTACT_ID_SELF
      )
      SettingsStoreInstance.reducer.setSelfContact(selfContact)
    }
  }
  // SelfavatarChanged is marked as deprecated in jsonrpc api, but ConfigSynced does not have selfavatar yet
  // will probably change with https://github.com/deltachat/deltachat-core-rust/pull/5158
  BackendRemote.on('SelfavatarChanged', updateSelfAvatar)
  BackendRemote.on('ConfigSynced', (accountId, { key }) => {
    if (key === 'selfavatar') {
      updateSelfAvatar(accountId)
    }
    SettingsStoreInstance.effect.loadCoreKey(accountId, key as any)
  })
})

const SettingsStoreInstance = new SettingsStore(null, 'SettingsStore')
export const useSettingsStore = () => useStore(SettingsStoreInstance)

/**
 * Module-scope subscribe wrapper so its identity is stable across
 * renders. `useSyncExternalStore` keys its subscription on this
 * function's reference; recreating it per-render would unsubscribe and
 * resubscribe every time, churning the store's listener array
 * (`Store.unsubscribe` does an `indexOf` + `splice`).
 */
const subscribeToSettingsStore = (cb: () => void) =>
  SettingsStoreInstance.subscribe(cb)

/**
 * Subscribe to a single boolean desktop-setting via {@link useSyncExternalStore}.
 *
 * Why not `useSettingsStore()`: `useStore` re-renders the consumer on every
 * store change. Any settings page toggle, theme switch, or notification
 * volume change would re-render every visible message bubble. This selector
 * variant only re-renders when the selected boolean actually flips.
 *
 * The default applies before settings have loaded (boot-time) so callers
 * never observe `undefined`.
 */
export function useDesktopBoolSetting(
  key: keyof DesktopSettingsType,
  fallback: boolean
): boolean {
  // Snapshot is memoized on (key, fallback) so successive renders pass
  // the same reference — useSyncExternalStore reads the snapshot on every
  // render, but a stable function avoids forcing extra reconciliation.
  const getSnapshot = useCallback(() => {
    const v = SettingsStoreInstance.getState()?.desktopSettings[key]
    return typeof v === 'boolean' ? v : fallback
  }, [key, fallback])
  return useSyncExternalStore(
    subscribeToSettingsStore,
    getSnapshot,
    getSnapshot
  )
}

export default SettingsStoreInstance
