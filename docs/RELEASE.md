# Release Guide

MMI Gateway should be published only after the package contract and tarball
consumer path pass.

## Local Checklist

```bash
npm ci
npm run typecheck
npm test
npm run build
npm run selftest
npm pack --dry-run
```

Then run a consumer smoke from a temporary project:

```bash
TARBALL="$(npm pack --silent)"
TMP="$(mktemp -d)"
cp "$TARBALL" "$TMP/"
cd "$TMP"
npm init -y
npm install "./$TARBALL"
npx mmi doctor --json
npx mmi selftest --json
npx mmi ingest --out ./run --text "release smoke" --json
npx mmi validate ./run --json
npx mmi handoff ./run --json
npx mmi recipes --json
```

## GitHub Install Smoke

The repository does not track `dist/`. The package `prepare` script must keep
GitHub installs runnable:

```bash
TMP="$(mktemp -d)"
cd "$TMP"
npm install -g github:baishiqi45-dotcom/mmi-gateway
mmi selftest --json
```

## Trusted Publishing

For public npm release, prefer npm trusted publishing with GitHub Actions OIDC
rather than long-lived npm tokens. Configure it after the final GitHub
repository identity is known.

The included workflow publishes on tags that match:

```bash
git tag mmi-gateway-v0.7.1
git push origin mmi-gateway-v0.7.1
```

Use `v0.7.1` for a GitHub-only release that should not trigger npm publish.

Expected release protections:

- CI runs typecheck, tests, build, pack dry-run, and consumer smoke.
- npm publishes with provenance.
- Confirm the `mmi-gateway` npm package name is still available before tagging
  the first public npm release.
- The packed package includes `dist/`, `schemas/`, `docs/`, `examples/`, CLI
  bin metadata, and no `.env`, `.key`, credential, or temporary files.
- No real provider API keys, live signed URLs, private paths, or customer data
  are present in logs, fixtures, examples, or release artifacts.
- The npm trusted publisher must point to `.github/workflows/publish.yml`
  and allow `npm publish`.
- npm trusted publishing currently requires npm CLI 11.5.1+ and Node 22.14.0+
  in the release environment; the publish workflow uses Node 24 and OIDC.

## Versioning

- Patch: docs, examples, bug fixes, provider bug fixes without contract changes.
- Minor: additive CLI/SDK/schema fields.
- Major: breaking provider interface or packet schema changes.

`ProviderAdapter` V1 must remain compatible until a named V2 interface is
introduced.
