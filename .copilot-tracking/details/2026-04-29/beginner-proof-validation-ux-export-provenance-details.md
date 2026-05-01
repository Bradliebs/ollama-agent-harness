<!-- markdownlint-disable-file -->

# Beginner Proof Validation UX Export Provenance Details

## References

* Research: `.copilot-tracking/research/2026-04-29/beginner-proof-validation-ux-export-provenance-research.md`
* Plan: `.copilot-tracking/plans/2026-04-29/beginner-proof-validation-ux-export-provenance-plan.instructions.md`

## File Operations

* Modify `ui/index.html`, `ui/app.js`, and `scripts/ui-smoke.js` for guided profile authoring and trend export.
* Modify `src/learning/evalTrace.ts`, `src/learning/evalTrace.test.ts`, `src/web/server.ts`, and `src/web/server.test.ts` for trend export.
* Modify `scripts/release-notes.js` and `.github/workflows/release.yml` for release provenance.
* Update `README.md`, `CHANGELOG.md`, `package.json`, and `package-lock.json`.

## Validation Commands

* `npm test -- --runInBand src/learning/evalTrace.test.ts src/web/server.test.ts`
* `npm run typecheck`
* `npm test -- --runInBand`
* `npm run build`
* `npm run smoke:ui -- http://127.0.0.1:<port>/`
* `npm run release:notes -- --version v0.1.8 --asset release/ollama-agent-harness-v0.1.8.zip --output release/release-notes-v0.1.8.md`
* `npm run smoke:release -- release/ollama-agent-harness-v0.1.8.zip`
