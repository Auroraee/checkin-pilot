# Contributing

Contributions are welcome.

Unless you explicitly state otherwise, any contribution intentionally submitted for inclusion in this project is licensed under the Apache License 2.0, without additional terms or conditions. You retain copyright in your contribution. No contributor license agreement is currently required.

Before opening a pull request, run:

```powershell
pnpm typecheck
pnpm test
pnpm build
pnpm check:secrets
```

Never include real cookies, tokens, API keys, raw `localStorage.user` values, or unredacted network captures in source code, issues, fixtures, logs, or screenshots.
