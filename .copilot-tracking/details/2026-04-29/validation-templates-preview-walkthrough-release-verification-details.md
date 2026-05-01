<!-- markdownlint-disable-file -->

# Validation Templates Preview Walkthrough Release Verification Details

## Phase A Details

* Add template definitions to `src/core/outputValidation.ts` as installable custom validation profiles.
* Extend server imports and endpoints for list/install behavior.
* Render template buttons in `ui/index.html` and handlers in `ui/app.js`.

## Phase B Details

* Expose `POST /api/output-validation/preview`.
* Return the full deterministic `OutputValidationResult` for UI display.
* Add UI controls near Output Validation settings.

## Phase C Details

* Add `walkthrough.completed` to `WebSettings` and persisted settings.
* Sanitize allowed step ids: `setup`, `validation`, `learning`, `about`.
* Update welcome checklist rendering based on persisted state.

## Phase D Details

* Add `GET /api/about/verify`.
* Return provenance fields and a local verification status.
* Render status in the About panel without requiring network access.

## Phase E Details

* Extend `src/web/server.test.ts` for new endpoints and persisted walkthrough settings.
* Extend `scripts/ui-smoke.js` for new controls/functions.
* Run focused tests, full validation, UI smoke, release smoke, and remote workflow verification.