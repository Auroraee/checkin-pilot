# CheckinPilot

CheckinPilot is an open-source, local-first Chrome extension for daily check-ins on compatible AI API panel sites. It only accesses sites that you add and authorize one origin at a time. Chrome must be running for scheduled work; missed days are never backfilled.

> Status: early `v0.1.0-rc` development. The verified integration target is `https://runanytime.hxi.me`. Do not publish a stable `v0.1.0` until the real scheduled-run acceptance gate in `docs/acceptance-v0.1.md` has passed.

## Quick start for users (no build required)

CheckinPilot is not yet published in the Chrome Web Store. To use it without downloading the source code or installing developer tools:

1. Open [GitHub Releases](https://github.com/Auroraee/checkin-pilot/releases) and download the newest `checkin-pilot-*-chrome.zip` file.
2. Extract the downloaded ZIP file to a folder that you will keep. Do not delete that folder while the extension is installed.
3. Open `chrome://extensions` in Chrome and turn on **Developer mode**.
4. Select **Load unpacked**, then choose the extracted folder that contains `manifest.json`.
5. Sign in to a supported API panel in Chrome, open CheckinPilot, and add the current site. Approve the one-site permission prompt, choose a daily time, and enable the schedule.

Keep Chrome running at the scheduled time. CheckinPilot uses your existing browser session, stores its settings and redacted history locally, and never asks you to paste a password, cookie, bearer token, dashboard token, or API key. Missed days are not backfilled. The only verified site in this release candidate is `https://runanytime.hxi.me`.

## Safety model

- No backend, analytics, telemetry, password storage, copied cookies, bearer tokens, dashboard tokens, or API keys.
- No install-time site access and no `<all_urls>` permission. Each HTTPS origin requires an explicit Chrome permission prompt.
- One active session-bound account per site. An account change stops automation until you explicitly rebind it.
- CAPTCHA and interactive Turnstile challenges are never bypassed.
- Supported proof-of-work is isolated in a cancellable worker with strict per-site daily limits.
- History is redacted, local-only, retained for 30 days, and capped at 100 records per site.

## Development

Requirements: Node.js 22 or newer, pnpm 11 or newer, and Chrome 114 or newer.

```powershell
pnpm install --frozen-lockfile
pnpm typecheck
pnpm test
pnpm build
pnpm zip
```

The unpacked extension is emitted under `.output/chrome-mv3`, and the release archive under `.output`.

## Platform scope

- New API deployments using the legacy browser session plus numeric `New-Api-User` header can be detected.
- New API deployments using the short-lived bearer login are supported through a same-origin page session: a temporary background tab (or an already open same-origin tab, which is never closed) runs `/api/user/auth/refresh` in its ISOLATED world; the bearer token stays inside the page and never enters extension messages, storage, logs, notifications or snapshots. No `cookies`, `webRequest`, `debugger` or `<all_urls>` permission is used.
- `runanytime.hxi.me` is the only verified v0.1 site adapter (modern bearer auth plus the private check-in PoW protocol).
- Official Sub2API currently has no compatible daily check-in contract and is not supported by the generic adapter.

See [the discovery record](docs/discovery.md), [accepted architecture decisions](docs/adr), the [modern New API auth decision](docs/modern-new-api-auth.md), and [v0.1 acceptance gates](docs/acceptance-v0.1.md).

## License

Licensed under the [Apache License 2.0](LICENSE). See [NOTICE](NOTICE) for attribution information.
