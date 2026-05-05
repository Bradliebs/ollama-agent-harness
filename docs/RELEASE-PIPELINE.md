# Release Pipeline Runbook

Operational reference for cutting and shipping a release of the Ollama Agent
Harness. Captures the four classes of failure that have actually bitten this
project so the next engineer does not rediscover them.

## Normal release

```powershell
# 1. Bump every version-bearing file together
npm run release:bump -- <new-version>

# 2. Add a `## Ollama Agent Harness v<new-version>` section to CHANGELOG.md
#    summarising the work that ships in this release.

# 3. Validate locally
npm run typecheck
npm test -- --runInBand
npm run verify:changelog
npm run release:dry-run

# 4. One-shot pre-flight (working tree clean + upstream sync + changelog +
#    versions match + typecheck + tag does not exist)
npm run release:ready

# 5. Commit, push, wait for green CI, then tag
git add -A
git commit -m "chore(release): bump to v<new-version>"
git push origin master
# wait for CI to go green at https://github.com/Bradliebs/ollama-agent-harness/actions
git tag -a v<new-version> -m "v<new-version>"
git push origin v<new-version>
```

The Release workflow runs automatically when a `v*.*.*` tag is pushed.

## Pre-flight gates

Three CI gates exist to refuse a bad release before it reaches the Publish
step. If any fail, fix the underlying issue rather than skipping the gate.

| Gate | Where | What it catches |
|------|-------|-----------------|
| `verify:changelog` | CI workflow | Tagged version has no `## ... v<version>` section in CHANGELOG.md |
| `release:dry-run` | CI workflow | Archive shape, provenance, sha manifest, and notes generation regress |
| Require successful CI on tagged commit | Release workflow | Tag was pushed but CI for the same commit did not conclude successfully |

## Failure modes seen in practice

### 1. `eventStore` same-millisecond ordering flake

* **Symptom:** every Release run between v0.3.20 and v0.3.26 failed at
  `src/persistence/eventStore.test.ts 'gets undo events'`.
* **Cause:** `queryEvents` sorted equal-timestamp events with a stable DESC
  sort, but `getUndoEvents` reverses the result. CI hosts emit events fast
  enough to land in the same millisecond, so ties rotated and one extra event
  slipped past the cutoff.
* **Fix:** `appendEvent` assigns a monotonic `seq` field and `queryEvents`
  ties on `seq`, with file-append-order as a fallback for legacy events
  written before `seq` existed. Pinned by a regression test that mocks
  `Date.toISOString()` to force ties.

### 2. Version mismatch across the four metadata files

* **Symptom:** `release:dry-run` fails with `verify:versions` printing
  `mismatch: installer FileVersion …`, `mismatch: release-provenance …`.
* **Cause:** `package.json` was bumped manually but `installer/harness-installer.nsi`
  and `release-provenance.json` were not updated to match.
* **Fix:** always use `npm run release:bump -- <version>`. The script updates
  all four files atomically.

### 3. Empty release notes after a tag push

* **Symptom:** GitHub Release has no body or only the auto-generated bullet.
* **Cause:** CHANGELOG had no `## ... v<version>` section matching the tag,
  and `scripts/release-notes.js` falls back to an empty section.
* **Fix:** add the CHANGELOG section before pushing the tag. CI now runs
  `npm run verify:changelog` to refuse this case.

### 4. Startup connector side effects in release smoke

* **Symptom:** `release:dry-run` or `smoke:bounded-news` runs fail because
  Telegram or Discord startup blocks the test harness.
* **Cause:** `npm run serve` initialises configured connectors at startup.
* **Fix:** export `HARNESS_DISABLE_STARTUP_CONNECTORS=1` before `npm run serve`
  for any release-validation flow. Production startup leaves the flag unset
  and connectors initialise normally. See
  [docs/OPERATING-SERVICES.md](OPERATING-SERVICES.md) §Release Smoke Override.

## Optional pre-push hook

To run `release:ready` automatically before pushing a release tag without
adding a Husky dependency, drop this script into `.git/hooks/pre-push` and
`chmod +x`:

```bash
#!/usr/bin/env bash
# Run release:ready when pushing a tag matching v*.*.*. Lets ordinary
# branch pushes through unchanged.
while read -r local_ref local_sha remote_ref remote_sha; do
  case "$remote_ref" in
    refs/tags/v[0-9]*.[0-9]*.[0-9]*)
      echo "Pre-push: $remote_ref triggers npm run release:ready"
      npm run release:ready || exit 1
      ;;
  esac
done
exit 0
```

`.git/hooks/` is per-checkout and intentionally not tracked, so each
contributor opts in. The hook is a defence in depth on top of the
release-workflow CI-status gate.

## Recovery procedures

### A failed Release workflow run

The Release workflow validates again before publishing. If it fails, the tag
exists on GitHub but the Release does not. Two options:

1. **Roll forward (recommended).** Fix the issue, bump to the next patch
   version, and tag again. Earlier failed runs stay in the GitHub Actions
   history as audit trail unless explicitly deleted.
2. **Force-recreate the same tag.** Only safe if no one has fetched the tag.
   Requires `git push --delete origin <tag>` and `git tag -d <tag>` before
   re-tagging. Avoid in shared branches.

### Cleaning up failed Release runs

```powershell
gh run list --workflow Release --limit 20
gh run delete <run-id>
```

Deletion is irreversible. Use only for noise reduction after the underlying
issue has been fixed and a successful release exists.

### Bumping back down

`npm run release:bump` does not validate that the new version is greater than
the previous. It will happily bump backwards. Don't.

## Files involved

| File | Role |
|------|------|
| `package.json` | npm package version |
| `package-lock.json` | Dependency lock (kept in sync by `release:bump`) |
| `installer/harness-installer.nsi` | NSIS installer `VIProductVersion`, `FileVersion`, `DisplayVersion` |
| `release-provenance.json` | Build provenance shipped inside the release archive |
| `CHANGELOG.md` | Per-version release notes; consumed by `release:notes` |
| `.github/workflows/ci.yml` | Validation on every `master` push and PR |
| `.github/workflows/release.yml` | Tag-driven publish |
| `scripts/bump-version.js` | Single-source version bumper (`release:bump`) |
| `scripts/check-changelog-version.js` | CHANGELOG section gate (`verify:changelog`) |
| `scripts/check-release-ready.js` | One-shot pre-tag readiness check (`release:ready`) |
| `scripts/verify-release-versions.js` | Version metadata cross-check (`verify:versions`) |
| `scripts/release-dry-run.js` | Local dry-run of the publish path (`release:dry-run`) |
| `scripts/release-notes.js` | CHANGELOG-driven note generator (`release:notes`) |
| `scripts/release-manifest.js` | SHA-256 manifest generator (`release:manifest`) |
| `scripts/generate-release-provenance.js` | Provenance generator (`release:provenance`) |
