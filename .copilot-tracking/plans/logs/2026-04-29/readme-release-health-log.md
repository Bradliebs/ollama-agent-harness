<!-- markdownlint-disable-file -->

# README Release Health Planning Log

## Decisions

* Add readiness checks to the existing web server instead of creating a separate script.
* Treat audio helper readiness as configured/not configured because transcription command validation without a file would be unreliable.
* Use `softprops/action-gh-release` for tag release asset upload.
* Bump to `0.1.2` so the automated release workflow can be exercised on a fresh tag.

## Status

Implementation, validation, push, tag, and release verification complete.

## Validation

* `npm test -- --runInBand src/web/server.test.ts` passed.
* `npm run typecheck` passed.
* `npm test -- --runInBand` passed after increasing the web server test suite timeout to 30 seconds.
* `npm run build` passed.
* `npm run smoke:ui -- http://127.0.0.1:3112/` passed.
* GitHub CI run `25099047534` passed on `master`.
* GitHub Release run `25099059116` passed for `v0.1.2`.

## Publish

* Commit `2253926` pushed to `master`.
* Tag `v0.1.2` pushed.
* Release asset `ollama-agent-harness-v0.1.2.zip` uploaded.
