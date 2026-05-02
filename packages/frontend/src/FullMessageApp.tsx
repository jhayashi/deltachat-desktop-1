import React, { useEffect, useLayoutEffect, useState } from 'react'
import moment from 'moment'

import { translate, LocaleData } from '../../shared/localize'
import { ThemeManager, ThemeContext } from './ThemeManager'
import { CrashScreen } from './components/screens/CrashScreen'
import { runtime } from '@deltachat-desktop/runtime-interface'
import { I18nContext } from './contexts/I18nContext'
import { FullMessageView } from './components/full-message/FullMessageView'

/**
 * Discriminated union returned by `parseFullMessageParam` in
 * `main.tsx`. `payload` carries the pre-fetched message data the
 * opener stashed in localStorage; `expired` means the URL had a token
 * but no payload was found (tab refreshed, handoff cleared, etc.).
 */
export type FullMessageBoot =
  | {
      kind: 'payload'
      data: {
        isContactRequest: boolean
        subject: string
        sender: string
        receiveTime: string
        html: string
      }
    }
  | { kind: 'expired' }

/**
 * Parallel SPA shell for the "Show Full Message…" tab. Mirrors the
 * `<App>` shell's context wiring (CrashScreen → ThemeContext → I18n)
 * but renders the standalone {@link FullMessageView} in place of
 * `<ScreenController>` — no chat list, no sidebar, no system
 * integration, no JSON-RPC connection.
 */
export default function FullMessageApp(props: FullMessageBoot) {
  return (
    <CrashScreen>
      <ThemeContextWrapper>
        <I18nContextWrapper>
          {props.kind === 'expired' ? (
            <ExpiredView />
          ) : (
            <FullMessageView {...props.data} />
          )}
        </I18nContextWrapper>
      </ThemeContextWrapper>
    </CrashScreen>
  )
}

/**
 * Friendly state when the new tab is hit without a fresh payload —
 * usually because the user reloaded the standalone tab (the opener
 * cleared the localStorage entry on first read), or opened a stale
 * bookmarked URL. We can't refetch from here without stealing the
 * chat tab's connection, so the only path forward is reopening from
 * the chat.
 */
function ExpiredView() {
  return (
    <div className='full-message-error' role='alert'>
      <h1>This message viewer has expired.</h1>
      <p>
        Reopen "Show Full Message…" from the chat to view this message again.
      </p>
    </div>
  )
}

function I18nContextWrapper({ children }: { children: React.ReactElement }) {
  const [localeData, setLocaleData] = useState<LocaleData | null>(null)

  async function reloadLocaleData(locale: string) {
    const localeData = await runtime.getLocaleData(locale)
    window.localeData = localeData
    window.static_translate = translate(localeData.locale, localeData.messages)
    setLocaleData(localeData)
    moment.locale(localeData.locale)
  }

  useLayoutEffect(() => {
    ;(async () => {
      const desktop_settings = await runtime.getDesktopSettings()
      await reloadLocaleData(desktop_settings.locale || 'en')
    })()
  }, [])

  if (!localeData) return null
  return (
    <I18nContext.Provider
      value={{
        tx: window.static_translate,
        writingDirection: window.localeData.dir,
      }}
    >
      <div dir={window.localeData.dir}>{children}</div>
    </I18nContext.Provider>
  )
}

function ThemeContextWrapper({ children }: { children: React.ReactElement }) {
  const [theme_rand, setThemeRand] = useState(0)
  useEffect(() => {
    ThemeManager.setUpdateHook(() => setThemeRand(Math.random()))
    ThemeManager.refresh()
  }, [])

  return (
    <ThemeContext.Provider value={theme_rand}>{children}</ThemeContext.Provider>
  )
}
