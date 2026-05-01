<!-- markdownlint-disable-file -->

# Validation Docs Trends Profiles Release Changes

## Related Plan

`.copilot-tracking/plans/2026-04-29/validation-docs-trends-profiles-release-plan.instructions.md`

## Implementation Date

2026-04-29

## Summary

Implemented documentation, validation trend summaries, custom deterministic output-validation profile authoring, and local release validation for v0.1.6.

## Modified

* `README.md` - added output-validation usage, profile descriptions, CLI example, custom profile JSON format, and structural-validation caveat.
* `CHANGELOG.md` - added v0.1.6 release notes.
* `package.json` - bumped version to 0.1.6.
* `package-lock.json` - bumped version metadata to 0.1.6.
* `src/core/outputValidation.ts` - added custom profile normalization, custom checks, and custom prompt instructions.
* `src/core/outputValidation.test.ts` - added custom profile and custom prompt tests.
* `src/core/queryLoop.ts` - passes custom profiles through prompt pairing and final-answer validation.
* `src/core/queryLoop.test.ts` - validates custom profile query loop behavior.
* `src/types/loop.ts` - adds custom profile config to output validation settings.
* `src/index.ts` - exports custom validation helpers and output-validation trend summaries.
* `src/learning/evalTrace.ts` - adds output-validation trend summaries by profile/status.
* `src/learning/evalTrace.test.ts` - covers output-validation trend summaries.
* `src/web/server.ts` - adds custom profile API, settings payload profile lists, custom profile file load/save, and validation trend API fields.
* `src/web/server.test.ts` - covers custom profile API, settings exposure, and validation trend payloads.
* `ui/index.html` - adds custom profile JSON authoring controls.
* `ui/app.js` - adds custom profile option rendering, profile save flow, and output-validation trend rendering.
* `scripts/ui-smoke.js` - checks custom profile authoring and trend UI hooks.

## Generated Locally

* `release/release-notes.md`
* `release/ollama-agent-harness-v0.1.6.zip`

## Validation

* `npm test -- --runInBand src/core/outputValidation.test.ts src/core/queryLoop.test.ts src/learning/evalTrace.test.ts src/web/server.test.ts src/cli/index.test.ts` - passed.
* `npm run typecheck` - passed.
* `npm test -- --runInBand` - passed.
* `npm run build` - passed.
* `npm run smoke:ui -- http://127.0.0.1:4318/` - passed.
* `npm run release:notes -- --version v0.1.6 --output release/release-notes.md` - passed.
* `npm run smoke:release -- release/ollama-agent-harness-v0.1.6.zip` - passed.
* GitHub CI run `25107060848` - passed.
* GitHub Release run `25107063547` - passed and published `v0.1.6`.

## Release Summary

Release `v0.1.6` is published at `https://github.com/Bradliebs/ollama-agent-harness/releases/tag/v0.1.6` with asset `ollama-agent-harness-v0.1.6.zip`.
