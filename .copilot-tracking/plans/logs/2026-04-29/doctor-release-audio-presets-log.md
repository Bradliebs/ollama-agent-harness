<!-- markdownlint-disable-file -->

# Doctor Release Audio Presets Planning Log

## Decisions

* Use a shared setup health module for web and CLI to keep readiness behavior consistent.
* Validate audio command execution only when the user provides a sample audio file path.
* Treat release archive smoke as a packaging gate before release publication.
* Update archive startup to use compiled `dist` output.

## Status

Implementation, validation, push, tag, and release verification complete.

## Validation

* `npm test -- --runInBand src/setup/health.test.ts src/web/server.test.ts src/cli/index.test.ts` passed.
* `npm run typecheck` passed.
* `npm test -- --runInBand` passed.
* `npm run build` passed.
* `npm run smoke:ui -- http://127.0.0.1:3113/` passed.
* Local `npm run smoke:release -- release/ollama-agent-harness-v0.1.3.zip` passed.
* GitHub CI run `25099866591` passed on `master`.
* GitHub Release run `25099880671` passed for `v0.1.3`, including the new `Smoke release archive` step.

## Publish

* Commit `c069787` pushed to `master`.
* Tag `v0.1.3` pushed.
* Release asset `ollama-agent-harness-v0.1.3.zip` uploaded.
