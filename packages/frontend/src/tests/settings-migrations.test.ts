import { expect } from 'chai'
import { describe, it } from 'mocha'
import { migrateLegacyMarkdownSetting } from '../stores/settings-migrations.js'
import { DesktopSettingsType } from '../../../shared/shared-types.js'
import { getDefaultState } from '../../../shared/state.js'

function recorder() {
  const calls: Array<[string, unknown]> = []
  return {
    calls,
    fn: async (key: string, value: unknown) => {
      calls.push([key, value])
    },
  }
}

function freshSettings(
  overrides: Partial<DesktopSettingsType> = {}
): DesktopSettingsType {
  // mirror the load-time merge: defaults overlaid with persisted values.
  return Object.assign(getDefaultState(), overrides) as DesktopSettingsType
}

describe('migrateLegacyMarkdownSetting', () => {
  it('forwards legacy=true → messageMarkdownEnabled=true and clears legacy', async () => {
    const settings = freshSettings({
      experimentalEnableMarkdownInMessages: true,
    })
    const rec = recorder()
    await migrateLegacyMarkdownSetting(settings, rec.fn as any)
    expect(rec.calls).to.deep.equal([
      ['messageMarkdownEnabled', true],
      ['experimentalEnableMarkdownInMessages', undefined],
    ])
    expect(settings.messageMarkdownEnabled).to.equal(true)
    expect(settings.experimentalEnableMarkdownInMessages).to.equal(undefined)
  })

  it('forwards legacy=false → messageMarkdownEnabled=false (preserves preference)', async () => {
    const settings = freshSettings({
      experimentalEnableMarkdownInMessages: false,
    })
    const rec = recorder()
    await migrateLegacyMarkdownSetting(settings, rec.fn as any)
    expect(rec.calls).to.deep.equal([
      ['messageMarkdownEnabled', false],
      ['experimentalEnableMarkdownInMessages', undefined],
    ])
    expect(settings.messageMarkdownEnabled).to.equal(false)
    expect(settings.experimentalEnableMarkdownInMessages).to.equal(undefined)
  })

  it('no-ops when legacy key is unset', async () => {
    const settings = freshSettings()
    expect(settings.experimentalEnableMarkdownInMessages).to.equal(undefined)
    expect(settings.messageMarkdownEnabled).to.equal(true) // default
    const rec = recorder()
    await migrateLegacyMarkdownSetting(settings, rec.fn as any)
    expect(rec.calls).to.deep.equal([])
    expect(settings.messageMarkdownEnabled).to.equal(true)
  })

  it('is idempotent across repeated runs', async () => {
    const settings = freshSettings({
      experimentalEnableMarkdownInMessages: false,
    })
    const rec = recorder()
    await migrateLegacyMarkdownSetting(settings, rec.fn as any)
    const callsAfterFirst = rec.calls.length
    await migrateLegacyMarkdownSetting(settings, rec.fn as any)
    expect(rec.calls.length).to.equal(callsAfterFirst) // second run = no-op
    expect(settings.messageMarkdownEnabled).to.equal(false)
  })
})
