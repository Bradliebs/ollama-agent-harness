<!-- markdownlint-disable-file -->

# Skill Visibility Followups Research

## Scope

Continue all suggested work from the prior Phase 5 output:

1. Skill Save Confirmation Link
2. Skill Source Diagnostics
3. Skill Import Discovery

## Evidence Log

* `src/tools/skillTools.ts` writes runtime skills to `.harness/skills/<name>/SKILL.md`.
* `src/web/server.ts` serves only runtime skills from `.harness/skills` through `/api/skills`.
* `src/extensibility/skillLoader.ts` silently skips skill folders without a readable or parseable `SKILL.md`.
* `ui/app.js` renders a single Skills list and now refreshes it after skill-mutating tool results.
* Repo customization skills exist under `.github/skills/**/SKILL.md` and are not shown in the runtime Skills tab.

## Selected Approach

* Keep runtime skills authoritative for `skill`, `list_skills`, and deletion.
* Add diagnostics to the loader without changing its existing `loadSkillsDir` contract.
* Return runtime skills, runtime diagnostics, and repo/customization skill sources from `/api/skills`.
* Render runtime skills first, diagnostics next, and repo/customization skills as read-only reference items.
* Add a chat tool-result action that opens the Skills tab after a skill is saved.

## Success Criteria

* A saved skill result exposes an Open Skills action in chat.
* Malformed or skipped runtime skill folders are visible in the Skills tab.
* Repo `.github/skills` entries are visible separately from runtime `.harness/skills`.
* Targeted tests, typecheck, full Jest, build, UI smoke, and diagnostics pass.

## Artifact Completion

* Research document: 100%
* Implementation plan: 0%
* Implementation details: 0%
* Planning log: 0%
* Changes log: 0%
* Review log: 0%