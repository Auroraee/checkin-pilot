# CheckinPilot

CheckinPilot is a local-first Chrome extension for daily check-ins on compatible AI API panel sites. It only accesses sites that you add and authorize one origin at a time. Chrome must be running for scheduled work; missed days are never backfilled.

> Status: early `v0.1.0-rc` development. The verified integration target is `https://runanytime.hxi.me`. Do not publish a stable `v0.1.0` until the real scheduled-run acceptance gate in `docs/acceptance-v0.1.md` has passed.

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
- `runanytime.hxi.me` is the only verified v0.1 site adapter.
- Token-only New API deployments are not supported because CheckinPilot never stores dashboard tokens.
- Official Sub2API currently has no compatible daily check-in contract and is not supported by the generic adapter.

See [the discovery record](docs/discovery.md), [accepted architecture decisions](docs/adr), and [v0.1 acceptance gates](docs/acceptance-v0.1.md).

## License

Source-available under the [PolyForm Noncommercial License 1.0.0](LICENSE.md). Personal and license-covered noncommercial organizational use is allowed. Commercial use is prohibited without separate permission. This project is not OSI open source.
