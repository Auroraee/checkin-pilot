# Privacy

CheckinPilot has no backend, analytics, advertising, or telemetry. Configuration and redacted check-in history stay in Chrome local extension storage.

The extension uses the browser's existing signed-in session directly for user-authorized origins. It does not read Chrome's cookie database, persist cookie values, or persist passwords, bearer tokens, dashboard tokens, or API keys.

For account binding, a narrow function running in the page context may read `localStorage.uid` or parse `localStorage.user`. Only a validated positive numeric user ID is allowed to cross into the extension. The raw value and all other user fields are discarded in the page context.

Sites that switched to New API's short-lived bearer login are handled through a same-origin page session: a self-contained script in the tab's ISOLATED world calls `/api/user/auth/refresh`, keeps the returned bearer token in its own local variables, and only normalized results cross back. The token never appears in extension messages, background storage, logs, notifications, or check-in snapshots, and no `cookies`, `webRequest`, `debugger`, or `<all_urls>` permission is used. When no same-origin tab is open, a temporary background tab is created for the run and always closed afterwards; tabs the user already has open are never closed.

Removing a site deletes its configuration, binding, and records and revokes its origin permission. A minimal proof-of-work usage tombstone may remain until local midnight solely to prevent same-day compute-budget reset by remove-and-add.
