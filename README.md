# CheckinPilot

**English** | [简体中文](README.zh-CN.md)

CheckinPilot is a Chrome extension that automatically claims the daily check-in reward on the AI API panel sites you choose. Set it up once, open Chrome as usual, and CheckinPilot checks you in every day — no passwords to paste, no scripts to run.

> Status: early release (`v0.1.0-rc`). The only fully verified site so far is [`https://runanytime.hxi.me`](https://runanytime.hxi.me).

## Highlights

- **Set it and forget it** — checks in automatically the first time you open Chrome each day, or inside a daily time window that you pick.
- **No secrets, ever** — it reuses the login session already in your browser. It never asks for your password, cookie, token, or API key.
- **Only the sites you approve** — it never touches a site until you add it, and each site requires Chrome's own permission prompt.
- **Everything stays on your computer** — no backend, no analytics, no telemetry; history is redacted and kept locally for 30 days.

## Requirements

- Google Chrome **114 or newer** (desktop).
- An account on a supported site (see [Supported sites](#supported-sites)).

## Install (about 3 minutes, no coding)

CheckinPilot is not yet in the Chrome Web Store, so you install it from a ZIP file:

1. Open [GitHub Releases](https://github.com/Auroraee/checkin-pilot/releases) and download the newest `checkin-pilot-*-chrome.zip`.
2. Right-click the ZIP → **Extract all…** and choose a folder you will keep (for example `Documents\CheckinPilot`). Do not delete this folder while the extension is installed.
3. Copy-paste `chrome://extensions` into Chrome's address bar and open it.
4. Turn on **Developer mode** (toggle at the top right).
5. Click **Load unpacked** and select the folder you just extracted (the one containing `manifest.json`).
6. (Recommended) Click the puzzle-piece icon in Chrome's toolbar and pin CheckinPilot for one-click access.

To update later: download the new ZIP, extract it over the same folder, then click the **Reload** icon on the CheckinPilot card in `chrome://extensions`.

To uninstall: click **Remove** on the CheckinPilot card, then delete the folder.

## Add your first site

1. In Chrome, **sign in** to the site you want to automate, as a normal web login.
2. While staying on that site's page, click the **CheckinPilot icon** in the toolbar.
3. Click **Add current site**. Chrome shows a permission prompt asking whether CheckinPilot may access this one site — choose **Allow**. (The popup may close when the prompt appears; that is normal, and CheckinPilot finishes adding the site on its own.)
4. Review the confirmation panel, then click **Confirm**.

Done — this site is now checked in automatically every day. Repeat the same steps for other sites.

## What happens each day

- By default (**startup mode**), CheckinPilot runs the daily check-in the first time you open Chrome each day.
- Prefer a fixed time? Switch to **window mode** in settings: pick a start and end time (default 08:00–10:00), and the check-in happens at a random moment inside that window while Chrome is running.
- If Chrome was closed during the window, CheckinPilot catches up the next time you open Chrome **that same day**. If Chrome is not opened at all that day, the day is simply skipped — missed check-ins are never backfilled.
- Sites are checked one by one; a site you already checked in manually today is skipped.
- You are notified only when something needs your attention (for example, you got logged out) or when a check-in ultimately fails. Success notifications are optional and off by default.

## Changing settings

Click the gear icon in the CheckinPilot popup (or right-click the extension icon → **Options**):

| Setting | What it does |
| --- | --- |
| Daily schedule | Startup mode, or a daily time window. Times follow this computer's clock. |
| Notify on success | Also notify when a check-in succeeds (off by default). |
| Manage sites | Pause/resume a site, or permanently remove it. |
| History | Redacted results of past check-ins, newest first (kept for 30 days). |

Pausing a site stops its automatic check-ins but keeps it configured, so you can still press **Check in now** manually. Removing a site is permanent and also revokes its permission.

## Supported sites

| Site / platform | Status |
| --- | --- |
| [`https://runanytime.hxi.me`](https://runanytime.hxi.me) | ✅ Verified — fully automatic check-in, including its proof-of-work step. |
| New API panels with the classic session login | ⚠️ Auto-detected — usually works; compatibility is verified per site at runtime. |
| Token-only New API logins, official Sub2API | ❌ Not supported. |

For a site whose check-in protocol is not supported, CheckinPilot offers **visit mode**: it briefly opens the site in a background tab once a day, in case the site grants the reward just from loading the page. Such results are recorded as "unverified" in history.

The interface language follows Chrome's UI language (English and 简体中文).

## FAQ

**Does it store my password or token?**
No. CheckinPilot reuses the login session already in your browser — there is nothing secret to paste, and no credentials are copied out of the site. See [PRIVACY.md](PRIVACY.md).

**What happens if I get logged out of a site?**
You get a notification asking you to sign in again on the site. Depending on the site, you may then need to open it and click **Update current site** in the popup to resume automation.

**Does it bypass CAPTCHA or Turnstile?**
Never. If a human-verification challenge appears, CheckinPilot stops and notifies you to check in on the site manually.

**Must I keep the extracted folder?**
Yes — Chrome loads the extension from that folder, so deleting it breaks the extension.

**What if I switch accounts on a site?**
Automation pauses until you confirm the new binding: open the site signed in with the new account, click **Update current site**, and confirm.

## Privacy & safety

- No backend, analytics, or telemetry; all data stays in your browser profile on this computer.
- No `<all_urls>` access — every site is individually approved through Chrome's permission prompt, HTTPS only.
- One account per site; an account switch halts automation until you re-confirm it.
- CAPTCHA and interactive Turnstile challenges are never bypassed.
- Supported proof-of-work runs in a cancellable worker with strict per-site daily limits.
- History is redacted, local-only, retained for 30 days, and capped at 100 records per site.

Full details: [PRIVACY.md](PRIVACY.md).

## For developers

Requirements: Node.js 22 or newer, pnpm 11 or newer, and Chrome 114 or newer.

```powershell
pnpm install --frozen-lockfile
pnpm typecheck
pnpm test
pnpm build     # unpacked extension in .output/chrome-mv3
pnpm zip       # release archive in .output
```

Further reading: [site discovery notes](docs/discovery.md), [architecture decisions](docs/adr), [modern New API auth](docs/modern-new-api-auth.md), and [v0.1 acceptance gates](docs/acceptance-v0.1.md).

## License

Licensed under the [Apache License 2.0](LICENSE). See [NOTICE](NOTICE) for attribution information.
