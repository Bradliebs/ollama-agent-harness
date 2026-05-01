<!-- markdownlint-disable-file -->

# Validation Templates Preview Walkthrough Release Verification Research

## Scope

Continue all prior Phase 5 suggestions:

1. One-click validation templates.
2. Validator preview panel.
3. Persist walkthrough progress.
4. Release verification action.

## Assumptions

* Beginner-proof means visible controls, no JSON-only path, clear status text, and reuse of existing persistence paths.
* Custom validation templates should install into `.harness/output-validation-profiles.json` rather than introduce a new profile store.
* Validator preview should be deterministic and local by calling the same validation engine used after chat responses.
* Release verification should avoid pretending to cryptographically verify the installed app when only release metadata is available locally.

## Evidence Log

* `src/core/outputValidation.ts` already exports built-in profiles, custom profile validation, and deterministic `validateOutput` behavior.
* `src/web/server.ts` already persists settings in `.harness/settings.json` and custom profiles in `.harness/output-validation-profiles.json`.
* `ui/app.js` already has guided profile form, preset import/export, and About panel code.
* `scripts/ui-smoke.js` already covers profile form creation, About, and walkthrough presence.
* `.github/workflows/release.yml` writes `release-provenance.json` before packaging, while release notes calculate the final asset SHA-256 after packaging.

## Selected Approach

* Add built-in custom-profile templates in core and expose them via the web API.
* Add install-template endpoint that merges/replaces one template in the existing custom profile file.
* Add preview endpoint that calls `validateOutput` with built-in and custom profiles.
* Add `walkthrough.completed` to persisted web settings and update it from checklist actions.
* Add release verification endpoint that reports provenance presence, commit, asset name, release URL, and whether a local asset SHA is present.

## Success Criteria

* Templates can be installed from Settings without editing JSON.
* Preview can validate pasted text against selected profiles and show score/findings.
* Walkthrough completion survives reload via `.harness/settings.json`.
* About panel has a visible verification action with honest local status.
* Local API tests, typecheck, Jest, build, UI smoke, release notes, and release smoke pass.