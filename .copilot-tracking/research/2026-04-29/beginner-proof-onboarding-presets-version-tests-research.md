<!-- markdownlint-disable-file -->

# Beginner Proof Onboarding Presets Version Tests Research

## Scope

Continue all Phase 5 suggestions from the prior run:

1. Guided First-Run Walkthrough.
2. Profile Preset Import Export.
3. Installed Version Panel.
4. Playwright Form Coverage.

## Assumptions

* Beginner-proof means visible controls, safe defaults, concrete status messages, and no JSON-only path for common profile sharing.
* Existing `.harness/output-validation-profiles.json` remains the source of truth for custom profiles.
* Release archives should carry provenance data so an installed build can show version, commit, asset, and digest without needing `.git`.

## Evidence Log

* `ui/index.html` already has first-run setup, output validation profile form, and settings sections where walkthrough, import/export, and version status fit naturally.
* `ui/app.js` already owns settings load, profile form serialization, trend download, and smoke-test-visible functions.
* `src/web/server.ts` already exposes `/api/settings`, `/api/output-validation/profiles`, and trend download endpoints.
* `.github/workflows/release.yml` packages a fixed file list and can add generated provenance before zipping.
* `scripts/release-smoke.js` verifies archive contents and compiled server startup.
* `scripts/ui-smoke.js` already has Playwright mode and static fallback, so interaction coverage can extend the existing smoke test.

## Selected Approach

* Add a welcome/settings walkthrough checklist in the UI with buttons that navigate to the relevant existing surfaces.
* Add custom profile preset download/import controls that operate through the existing JSON editor and save API.
* Add `/api/about` backed by `package.json`, optional `release-provenance.json`, and optional git commit detection.
* Generate `release-provenance.json` in the Release workflow before packaging and verify it in release smoke.
* Extend UI smoke with actual guided profile form interactions instead of presence-only checks.

## Success Criteria

* Beginners can follow an on-screen checklist for setup, profiles, trends, and version verification.
* Custom profiles can be exported and imported through visible controls without manual JSON editing.
* Settings/About shows installed version and best available provenance.
* Release archives include provenance and smoke validation checks it.
* Local and remote validation pass.