import React, { useEffect, useLayoutEffect, useState } from 'react'
import moment from 'moment'

import { translate, LocaleData } from '../../shared/localize'
import { ThemeManager, ThemeContext } from './ThemeManager'
import { CrashScreen } from './components/screens/CrashScreen'
import { runtime } from '@deltachat-desktop/runtime-interface'
import { updateCoreStrings } from './stockStrings'
import { I18nContext } from './contexts/I18nContext'
import { FullMessageView } from './components/full-message/FullMessageView'

/**
 * Parallel SPA shell for the "Show Full Message…" tab. Mirrors the
 * `<App>` shell's context wiring (CrashScreen → ThemeContext → I18n)
 * but renders the standalone {@link FullMessageView} in place of
 * `<ScreenController>` — no chat list, no sidebar, no system
 * integration. The browser-target runtime opens this via
 * `window.open('/?fullMessage=accountId:messageId', '_blank')`.
 */
export default function FullMessageApp({
  accountId,
  messageId,
}: {
  accountId: number
  messageId: number
}) {
  return (
    <CrashScreen>
      <ThemeContextWrapper>
        <I18nContextWrapper>
          <FullMessageView accountId={accountId} messageId={messageId} />
        </I18nContextWrapper>
      </ThemeContextWrapper>
    </CrashScreen>
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
    updateCoreStrings()
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
