import { DesktopSettingsType } from '../../../shared/shared-types'

/**
 * Persist callback shape used by migrations. Real callers pass
 * `runtime.setDesktopSetting`; tests pass an in-memory recorder.
 */
export type SetDesktopSettingFn = (
  key: keyof DesktopSettingsType,
  value: string | number | boolean | undefined
) => Promise<void>

/**
 * Forward the legacy `experimentalEnableMarkdownInMessages` flag onto the
 * non-experimental `messageMarkdownEnabled` key, then clear the legacy key
 * so the migration is idempotent.
 *
 * Idempotency contract:
 *   - Run on every settings load, but only does work when legacy is set.
 *   - Once legacy is cleared, subsequent runs are a no-op.
 *   - Saves to `messageMarkdownEnabled` (e.g. via the toggle) MUST also
 *     clear legacy out-of-band — otherwise a write race could let this
 *     migration overwrite an explicit user preference on next launch.
 *     {@see SettingsStore.effect.setDesktopSetting}
 *
 * Mutates `desktopSettings` in place so the caller can use it without an
 * extra reload.
 */
export async function migrateLegacyMarkdownSetting(
  desktopSettings: DesktopSettingsType,
  persist: SetDesktopSettingFn
): Promise<void> {
  const legacy = desktopSettings.experimentalEnableMarkdownInMessages
  if (legacy === undefined) return
  await persist('messageMarkdownEnabled', legacy)
  await persist('experimentalEnableMarkdownInMessages', undefined)
  desktopSettings.messageMarkdownEnabled = legacy
  delete desktopSettings.experimentalEnableMarkdownInMessages
}
