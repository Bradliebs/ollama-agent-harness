<!-- markdownlint-disable-file -->

# Beginner Proof Validation UX Export Provenance Research

## Scope

Continue all prior Phase 5 suggestions and make them beginner-proof:

1. Visual Profile Form Editing.
2. Validation Trend Export.
3. Release Provenance Notes.

## Evidence Log

* `ui/index.html` exposes custom output profiles mainly as a JSON textarea.
* `ui/app.js` validates the JSON, but users still need to hand-author profile objects.
* `/api/learning` already returns `outputValidationTrend`, but there is no direct download endpoint for trend data.
* `scripts/release-notes.js` generates release notes from changes logs or changelog, but does not include commit SHA or asset digest metadata.

## Selected Approach

* Add a guided profile form with defaults, one editable check row, and add/update behavior that writes valid JSON for the existing save API.
* Keep the JSON textarea as an advanced escape hatch so existing power-user workflows still work.
* Add `/api/learning/output-validation-trends/download` to export trend JSON with generated metadata and raw runs.
* Add a Learning panel download button for validation trends.
* Extend release-note generation with optional asset provenance: commit SHA, asset path, size, and SHA-256 digest.

## Beginner-Proof Criteria

* A user can create a custom validation profile without typing JSON syntax.
* Error messages name the field that needs attention.
* Trend export is a visible button, not an internal file path.
* Release notes identify what code and asset were validated.
