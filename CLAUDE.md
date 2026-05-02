# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Purpose of this fork

**This repo is a personal fork used solely to carry private changes forward as upstream evolves.** It is not used to contribute back to the public Delta Chat Desktop project. Don't propose upstream PRs, don't optimize for upstreamability, and don't apply the upstream-contribution conventions (conventional commits enforcement, changelog gate, etc.) as hard rules — they're documented below for context but are not load-bearing here.

### Remotes
- `origin` — `git@github.com:jhayashi/deltachat-desktop-1.git` (this private fork)
- `upstream` — `git@github.com:deltachat/deltachat-desktop.git` (the public Delta Chat Desktop repo)

### Branch layout
- `main` — 1:1 mirror of `upstream/main`. **Never commit to it directly.**
- `joe/markdown-and-webxdc` — long-lived personal branch. All private work lives here, rebased on top of `main` whenever upstream updates. PR #1 on the fork tracks this branch as a review/snapshot artifact.

### Upstream sync ritual

When pulling in upstream changes, use this sequence:

```sh
git fetch upstream
git checkout main && git merge --ff-only upstream/main && git push origin main
git checkout joe/markdown-and-webxdc && git rebase main
git push origin joe/markdown-and-webxdc --force-with-lease
```

`git rerere` is enabled on this clone (`git config rerere.enabled true`) so recurring conflict resolutions are remembered across rebases. After the rebase, run `pnpm install` to reconcile `pnpm-lock.yaml` if dependency conflicts came up.

Daily work happens on `joe/markdown-and-webxdc`. New private features can either commit directly on that branch or branch off it and squash-merge back.

## Repository Overview

Delta Chat Desktop is a chat application that ships in three editions sharing a single frontend codebase:

- **Electron** (`packages/target-electron`) — the default, production app users actually install.
- **Tauri** (`packages/target-tauri`) — WIP rewrite with a Rust backend (lower disk/RAM than Electron). Has its own Rust crates under `src-tauri/`.
- **Browser** (`packages/target-browser`) — experimental webserver + browser UI, used mainly for development and as the host for the Playwright E2E suite.

This is a pnpm workspace; commands are typically run from the repo root with the `-w` flag (workspace root) so they work regardless of cwd. Node `^22` and pnpm `>=9.6.0` are required (`engineStrict` is on).

## Common Commands

All commands run from the repo root unless noted. `-w` means "workspace root package".

### Develop (Electron)

```sh
pnpm dev                     # build + start Electron in debug mode (alias for dev:electron)
pnpm -w watch:electron       # terminal 1 — rebuild on change
pnpm -w start:electron       # terminal 2 — run; reload renderer with F5/Cmd+R after edits
pnpm -w build:electron       # one-off build (needed first time and after main-process changes)
pnpm -w debug:electron       # dev with --inspect
```

The renderer hot-reloads via F5/Cmd+R; **the main process does not** — rebuild and restart `start:electron` after editing `packages/target-electron/src/`.

### Develop (Browser / Tauri)

```sh
pnpm start:browser           # build + serve the browser edition
pnpm start:webserver         # server only
pnpm dev:tauri               # Tauri dev (requires Rust toolchain + linux system deps; see packages/target-tauri/README.md)
```

The browser target requires a self-signed cert at `packages/target-browser/data/certificate` and a `WEB_PASSWORD` env var (or `.env`). See `packages/target-browser/Readme.md`.

### Check / Fix / Test

```sh
pnpm -w check                # types + lint + format + target-version consistency
pnpm -w check:types          # tsc across all packages
pnpm -w check:lint           # eslint
pnpm -w check:format         # prettier --check
pnpm -w fix                  # eslint --fix and prettier --write
pnpm -w test                 # unit tests (pnpm -r --no-bail test across packages)
pnpm -w test-and-check       # test then check
pnpm -w e2e                  # builds browser target then runs Playwright E2E (see below)
pnpm -w e2e basic            # run only spec files matching "basic"
pnpm -w e2e --ui             # Playwright UI mode
pnpm -w e2e --project=non-chatmail
```

E2E setup: `cd packages/e2e-tests && npx playwright install --with-deps && cp _env .env`. The browser target must be set up (cert generated) but **must not be running** — the test runner starts it. Tests within a spec file are **not isolated** and order matters. Test accounts live in `packages/e2e-tests/data/accounts/` and can be deleted between runs.

### Linux dev sandbox

On Ubuntu 24.04+ Electron may fail to start due to AppArmor user-namespace restrictions. Run `./bin/setup-apparmor-dev.sh` once (and after Electron upgrades). This is a dev-only issue — packaged `.deb` ships its own profile.

### Multiple instances

By default the local dev build uses the same config dir as the installed app, which causes "Only one instance allowed. Quitting". Set `DC_TEST_DIR` in `packages/target-electron/.env` (template at `.env.example`) to use a separate dir. Order matters: you can launch a second instance with a different config dir only if it's started after the first.

## Architecture

### The runtime abstraction (most important concept)

Frontend code (`packages/frontend`) does **not** talk to Electron, Tauri, or browser APIs directly. Instead it talks to a `Runtime` interface defined in `packages/runtime/runtime.ts`, and each target ships its own implementation:

- `packages/target-electron/runtime-electron/`
- `packages/target-tauri/runtime-tauri/`
- `packages/target-browser/runtime-browser/`

When adding capabilities that touch the host (file dialogs, notifications, log files, settings, opening URLs, etc.), the pattern is: extend the `Runtime` interface, then implement it in **all three** runtime packages. Frontend code calls it via `window.runtime` / `window.r`. The same applies to `BaseDeltaChat` connections — `createDeltaChatConnection` is provided by the runtime.

### Frontend → core JSON-RPC

The frontend talks to Delta Chat Core (the chat/network/crypto engine, separate Rust project at github.com/chatmail/core) over JSON-RPC via `@deltachat/jsonrpc-client` and `@deltachat/stdio-rpc-server` (versions pinned in `pnpm-workspace.yaml` catalog). The transport differs per target (stdio for Electron/Tauri, WebSocket `/ws/dc` for browser) but the client surface is identical — that's what the `Runtime.createDeltaChatConnection` abstraction buys.

For debugging RPC traffic: with debug logging enabled, run `exp.printCallCounterResult()` in the renderer DevTools console.

### Browser target endpoints (`packages/target-browser/Architecture.md`)

```
/                        app or login screen
/authenticate, /logout
/blobs/:accountId/:filename
/ws/dc                   deltachat jsonrpc
/ws/backend              runtime notifications
/backend-api             runtime functions returning results (RC_CONFIG, etc.)
```

### WebXDC (sandboxed in-chat apps)

WebXDC apps (https://webxdc.org/) run in isolated `BrowserWindow`s in Electron, served via a custom `webxdc://` protocol with CSP enforcement. The `webxdc.js` API is injected by a preload script. Entry point: `packages/target-electron/src/deltachat/webxdc.ts`. Full architecture in `docs/WEBXDC.md`. The Tauri target has its own implementation under `packages/target-tauri/webxdc-js-implementation/`. The browser target has been given an iframe-based implementation on this private fork (see `packages/target-browser/src/webxdc-routes.ts`, `packages/target-browser/static/webxdc-bridge.js`).

### Translations

Strings live in `_locales/*.json`. Sources are managed in the Android repo and Transifex — the desktop repo only consumes them via `pnpm -w translations:update`. For in-flight strings not yet upstreamed, add them to `_locales/_untranslated_en.json` (same syntax). `--translation-watch` (included in `pnpm start`) hot-reloads experimental strings.

In code:
- Static contexts (helpers, dialogs, anywhere outside React render): `window.static_translate`
- Functional components: `useTranslationFunction()` hook (re-renders on language change)
- Class component renders: `<i18nContext.Consumer>{tx => …}</i18nContext.Consumer>`

`window.static_translate`, the hook, and the context consumer are all the same function — when in doubt, use `static_translate`.

### Styles

Per-component `styles.module.css` (or `.scss`) imported as `import styles from './styles.module.css'`, colocated with the component. Class names camelCase. Prefer logical properties (`padding-inline-end`, `margin-inline-start`) over directional ones — RTL languages mirror the UI. Theming is done via CSS custom properties (`var(--primaryColor)`); SCSS generates them from a small base palette. There is still legacy global CSS — when modifying an old component, opportunistically migrate it. Full guide in `docs/STYLES.md`.

## Upstream-only conventions (for context, not enforced here)

These are upstream's contribution rules. They apply to PRs against `deltachat/deltachat-desktop`, not to work on this private fork — included here so you understand what upstream commits look like and can mirror the style if you want consistency.

- **Conventional Commits** (`feat:`, `fix:`, `change:`/`update:`, `remove:`, `docs:`, `test:`, `chore:`, `ci:`). Upstream's changelog is generated from them via `cliff.toml`.
- **Changelog gate**: upstream PRs must add a CHANGELOG.md entry, or include `#skip-changelog` (with a reason) in the PR description.
- **Public PR previews**: `#public-preview` in the PR description uploads the build to https://download.delta.chat/desktop/preview/.
- **Branch naming** for upstream write-access contributors: `<username>/<feature>`.
- **Merging upstream**: rebase your branch onto main; squash-merge default; rebase-merge allowed only if every commit is meaningful and conventional.
- **PR scope**: don't mix refactors with feature/bug work. The "Delta Chat Core" is meant to deliver data already shaped for the UI — if the UI is doing significant data massaging, that's usually a sign to push the work upstream into Core rather than build it here.

## Packaging

Production build: `NODE_ENV=production pnpm -w build`. Then in `packages/target-electron`: `pnpm pack:generate_config`, **`pnpm pack:patch-node-modules`** (required so `electron-builder`'s `afterPackHook` finds the rpc binaries), then `pnpm pack:{win,mac,linux,linux:dir}`. `NO_ASAR=true` for flatpak. macOS without certs: `export CSC_IDENTITY_AUTO_DISCOVERY=false`. Full details in `docs/DEVELOPMENT.md` and `RELEASE.md`.
