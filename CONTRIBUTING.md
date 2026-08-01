# Contributing

Contributions are welcome for noncommercial use of the project.

By submitting a contribution, you agree to license it under the same PolyForm Noncommercial 1.0.0 terms that apply to the project. You retain copyright in your contribution. No contributor license agreement is required, and contributed code cannot be unilaterally relicensed by the maintainer for commercial distribution without the contributor's separate permission.

Before opening a pull request, run:

```powershell
pnpm typecheck
pnpm test
pnpm build
pnpm check:secrets
```

Never include real cookies, tokens, API keys, raw `localStorage.user` values, or unredacted network captures in source code, issues, fixtures, logs, or screenshots.
