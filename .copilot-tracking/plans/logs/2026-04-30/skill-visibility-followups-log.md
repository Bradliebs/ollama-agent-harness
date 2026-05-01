<!-- markdownlint-disable-file -->

# Skill Visibility Followups Planning Log

## Selected Path

Add diagnostics and source awareness while keeping runtime `.harness/skills` as the only mutable skill source.

## Alternatives Considered

* Merge `.github/skills` into runtime skills. Rejected because repo customization skills are shipped project knowledge, not user-created runtime skills.
* Make malformed skills load with defaults. Rejected because bad `SKILL.md` content should be visible as a diagnostic, not silently treated as valid.

## Discrepancy Log

* The initial API test expected `.github/skills/testing` to be a valid repo skill. Existing repo skills include some non-frontmatter documentation-style skill files, and valid repo skills use the frontmatter `name` rather than the folder name. The test was corrected to assert `copilotforge-planner` as the valid repo skill and leave invalid repo skill files as diagnostics.

## Validation Results

* Targeted Jest passed after the assertion correction: 2 suites and 52 tests.
* Typecheck passed.
* Full Jest passed: 36 suites and 228 tests.
* Build passed.
* UI smoke passed in Playwright mode with runtime skill source, repo skill source, diagnostics, and Open Skills function checks.
* VS Code diagnostics found no errors in changed files.

## Artifact Completion

* Research document: 100%
* Implementation plan: 100%
* Implementation details: 100%
* Planning log: 100%
* Changes log: 100%
* Review log: 100%