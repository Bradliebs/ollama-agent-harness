<!-- markdownlint-disable-file -->
# Validation Trends About Manifest Auto Notice Public Exports Release Assertion Research

## Scope

Continue all v0.1.13 Phase 5 suggested work for v0.1.14:

1. Validation trend drill-down for auto-selected vs manually selected profiles.
2. About panel manifest link.
3. Auto-selection explanation notice.
4. Public validation API exports.
5. Release manifest CI assertion.

## Assumptions

* Keep changes minimal and consistent with the existing TypeScript/Jest/Express/static UI architecture.
* Use existing eval trace run storage for validation trend drill-down.
* Do not commit `.copilot-tracking`, generated release artifacts, or unrelated local files.
* Publish v0.1.14 after local validation passes.

## Evidence

* `src/learning/evalTrace.ts` records output validation eval runs and summarizes trends by profile/status.
* `src/web/server.ts` records validation events in `/api/chat`, exposes `/api/learning`, reads release manifests, and returns About metadata.
* `ui/app.js` renders About metadata, auto-selects validation profiles before chat, and renders output validation trends.
* `scripts/release-smoke.js` verifies optional companion manifest SHA against the release archive.
* `.github/workflows/release.yml` generates and publishes `*.zip.sha256.json` after release archive smoke.
* `src/index.ts` exports validation primitives but not `suggestOutputValidationProfile` or template metadata.

## Selected Approach

* Extend output validation eval run tags with a selection source tag: `auto-selected` or `manual-selected`.
* Thread selection source from `effectiveOutputValidationForMessage` into chat validation recording.
* Extend output validation trend summary/export with `bySelectionSource`.
* Render a compact source drill-down in the Learning tab.
* Render `manifestName` in About as a release-page link to the companion manifest.
* Emit an SSE event when auto-selection changes the profile, and render it in tool activity.
* Export validation suggestion and template APIs from `src/index.ts`.
* Harden `scripts/release-smoke.js` to assert manifest version, commit, manifestName, assetSize, SHA format, generatedAt, and releaseUrl when present.

## Success Criteria

* Focused tests cover eval trend source split, API auto-selection metadata, exports, and release manifest assertions.
* UI smoke covers manifest display, auto-selection notice support, and source drill-down markup.
* Typecheck, full Jest, build, UI smoke, and release smoke pass locally.
* v0.1.14 commit/tag/release are pushed and remote CI/release pass.

## Percent Complete

100% - research complete.
