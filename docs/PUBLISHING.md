# Publishing

## One-time setup

1. Create a publisher at <https://marketplace.visualstudio.com/manage> (the id must match `publisher` in `package.json` — currently `Z-PixelCode`).
2. Create an Azure DevOps Personal Access Token with **Marketplace → Manage** scope.
3. Install the packaging tool:

```bash
npm install -g @vscode/vsce
vsce login <publisher-id>
```

## Every release

```bash
# 1. bump the version and add a CHANGELOG entry
npm version patch --no-git-tag-version     # or minor / major

# 2. make sure the suites are green
node build/run-tests.cjs

# 3. build the VSIX (respects .vscodeignore)
vsce package

# 4. publish, or upload the .vsix through the web UI
vsce publish
```

Then tag it and attach the VSIX to a GitHub release:

```bash
git tag v0.15.3 && git push --tags
gh release create v0.15.3 dsh-vscode-bridge-0.15.3.vsix
```

## Repo hygiene

- The repo history was squashed to a single initial commit before open-sourcing (the early commits carried `.vsix` binaries). A pre-squash bundle is kept at `dist/pre-squash-backup.bundle` (untracked) for recovery.
- `dist/` holds local VSIX builds and is git-ignored; publish binaries through GitHub **Releases**, not commits.

## Pre-flight checklist

- [ ] `node build/run-tests.cjs` — all suites green
- [ ] `publisher` in `package.json` matches the marketplace publisher
- [ ] `repository`, `bugs`, `homepage` point at the real GitHub repo
- [ ] `icon` exists and is a **128×128 PNG** (marketplace requires PNG, not SVG)
- [ ] `README.md` renders correctly on the marketplace page (it is the listing body)
- [ ] `LICENSE` present
- [ ] version bumped + `CHANGELOG.md` updated
- [ ] no secrets, no absolute paths from a developer machine
      (`grep -rn "D:\\\\" src/` should only show the documented fallback candidates)
- [ ] install the built VSIX in a clean window and send one message + accept one change

## Notes for this extension

- There is **no build step**: the VSIX is the sources plus `assets/`. Verify with `vsce ls` that `test/`, `docs/`, `.github/` are excluded and `src/` is included.
- The extension **requires a local DeepSeek Harness install**; the listing must say so, and the `Requirements` section of the README is the canonical wording.
- `dsh-bridge.port` / `token` default to a demo value. Consider recommending a random token in the README, since the local MCP endpoint is a real HTTP server (bound to `127.0.0.1`).
