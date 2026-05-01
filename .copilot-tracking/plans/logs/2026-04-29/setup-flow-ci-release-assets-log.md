<!-- markdownlint-disable-file -->

# Setup Flow CI Release Assets Planning Log

## Decisions

* Use the existing `/api/settings` persistence path for first-run setup.
* Keep first-run setup compact in the welcome panel instead of creating a separate route.
* Use GitHub Actions with Node 20 and existing npm scripts.
* Attach a generated zip artifact to `v0.1.0` after local validation.

## Status

Planning complete.
