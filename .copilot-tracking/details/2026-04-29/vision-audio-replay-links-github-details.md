<!-- markdownlint-disable-file -->

# Vision Audio Replay Links GitHub Details

## References

* Research: `.copilot-tracking/research/2026-04-29/vision-audio-replay-links-github-research.md`
* Plan: `.copilot-tracking/plans/2026-04-29/vision-audio-replay-links-github-plan.instructions.md`

## File Operations

* Add `src/tools/multimodalTools.ts`.
* Add `src/tools/multimodalTools.test.ts`.
* Modify `src/tools/index.ts` and `src/index.ts` exports.
* Modify `ui/app.js` for media tool guidance and replay run failure links.
* Modify `scripts/ui-smoke.js` for new static hooks.

## Validation Commands

* `npm test -- --runInBand src/tools/multimodalTools.test.ts src/web/server.test.ts src/learning/evalTrace.test.ts`
* `npm run typecheck`
* `npm test -- --runInBand`
* `npm run smoke:ui -- http://127.0.0.1:<port>/`

## GitHub Push Plan

* Check `git status --short` and remotes.
* Check `gh auth status` and `gh repo create` availability.
* Create a private repo named from `package.json` unless an existing remote or auth state dictates otherwise.
* Push the current branch after validation.
