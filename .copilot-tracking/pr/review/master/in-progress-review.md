<!-- markdownlint-disable-file -->
# PR Review Status: master

## Review Status

* Phase: Phase 3 - Collaborative Review Ready
* Last Updated: 2026-04-30
* Summary: Reviewed current `master` work against `origin/master`; findings focus on PDF/upload flows, permission defaults, OCR command handling, cleanup safety, and chat history payload limits.

## Branch and Metadata

* Normalized Branch: `master`
* Source Branch: `master`
* Base Branch: `origin/master`
* Linked Work Items: None identified
* Author-Declared Intent: Current commits add PDF reading/metadata/render/table tools, PDF attachment streaming, upload-directory controls, output-validation enhancements, release provenance, and related tests/docs.
* Assumptions: Review includes committed changes ahead of `origin/master` plus current untracked artifacts. Large release zip payloads are treated as repository hygiene risks unless explicitly intended.

## Commands and Actions Log

* ✅ Read applicable review guidance: `.github/skills/code-review/SKILL.md`, `.github/skills/harness-conventions/SKILL.md`, and Markdown instructions.
* ✅ Checked branch status with `git -C c:\AI\Harness status --short --branch`.
* ✅ Listed tracked changes with `git -C c:\AI\Harness diff --name-status origin/master`.
* ✅ Collected numstat with `git -C c:\AI\Harness diff --numstat origin/master`.
* ✅ Listed untracked files with `git -C c:\AI\Harness ls-files --others --exclude-standard`.
* ✅ Collected commit history with `git -C c:\AI\Harness log --oneline origin/master..HEAD`.
* ✅ Generated [pr-reference.xml](pr-reference.xml) with full diff excluding the large `release/published-v0.1.9/ollama-agent-harness-v0.1.9.zip` payload.
* ✅ Inspected implementation files directly, including [src/tools/pdfTool.ts](../../../src/tools/pdfTool.ts), [src/tools/pathResolution.ts](../../../src/tools/pathResolution.ts), [src/web/server.ts](../../../src/web/server.ts), [src/permissions/engine.ts](../../../src/permissions/engine.ts), [ui/app.js](../../../ui/app.js), and [ui/index.html](../../../ui/index.html).
* ✅ Ran focused functional-code-review subagent for an independent static pass.

## Commit History

* `922e68e` feat: pdf tables tool, render vision cookbook, ocr doctor probe, stream-extract ui, render tests
* `b6ba8ad` feat: pdf page render, sse extraction, ocr setting in ui, webfetch tests, cookbook readme
* `515c674` feat: extend pdf support with metadata, ocr fallback, web fetch, attachments, cookbook
* `9a95ebc` feat: add pdf_read tool for local PDF text extraction

## Diff Mapping

| File | Type | New Lines | Old Lines | Notes |
|---|---|---:|---:|---|
| [cookbook/README.md](../../../cookbook/README.md) | Modified | +12 | -0 | Cookbook docs |
| [cookbook/pdf-render-vision.ts](../../../cookbook/pdf-render-vision.ts) | Added | +59 | -0 | PDF render example |
| [cookbook/pdf-summarize.ts](../../../cookbook/pdf-summarize.ts) | Added | +53 | -0 | PDF summarize example |
| [package.json](../../../package.json) | Modified | +2 | -1 | Dependency/version metadata |
| [package-lock.json](../../../package-lock.json) | Modified | +599 | -15 | Lockfile update |
| [src/core/outputValidation.ts](../../../src/core/outputValidation.ts) | Modified | +21 | -6 | Output validation profiles |
| [src/core/outputValidation.test.ts](../../../src/core/outputValidation.test.ts) | Modified | +20 | -1 | Validation tests |
| [src/index.ts](../../../src/index.ts) | Modified | +2 | -2 | Exports/registration |
| [src/learning/evalTrace.ts](../../../src/learning/evalTrace.ts) | Modified | +292 | -0 | Eval trend and feedback tracking |
| [src/learning/evalTrace.test.ts](../../../src/learning/evalTrace.test.ts) | Modified | +105 | -1 | Eval trend tests |
| [src/permissions/engine.ts](../../../src/permissions/engine.ts) | Modified | +1 | -1 | Permission read-tool list |
| [src/permissions/engine.test.ts](../../../src/permissions/engine.test.ts) | Modified | +6 | -0 | Permission tests |
| [src/setup/health.ts](../../../src/setup/health.ts) | Modified | +56 | -0 | PDF OCR setup health |
| [src/tools/fileTools.ts](../../../src/tools/fileTools.ts) | Modified | +44 | -8 | Upload path fallback/listing |
| [src/tools/fileTools.test.ts](../../../src/tools/fileTools.test.ts) | Modified | +118 | -1 | Upload fallback tests |
| [src/tools/index.ts](../../../src/tools/index.ts) | Modified | +9 | -2 | Tool registration |
| [src/tools/multimodalTools.ts](../../../src/tools/multimodalTools.ts) | Modified | +3 | -10 | Media tool path handling |
| [src/tools/pdfRenderTool.test.ts](../../../src/tools/pdfRenderTool.test.ts) | Added | +66 | -0 | PDF render tests |
| [src/tools/pdfTool.test.ts](../../../src/tools/pdfTool.test.ts) | Added | +159 | -0 | PDF tool tests |
| [src/tools/pdfTool.ts](../../../src/tools/pdfTool.ts) | Added | +529 | -0 | PDF read/metadata/render/table extraction |
| [src/tools/webFetchTool.ts](../../../src/tools/webFetchTool.ts) | Modified | +25 | -1 | PDF fetch handling |
| [src/tools/webFetchTool.test.ts](../../../src/tools/webFetchTool.test.ts) | Added | +83 | -0 | Web fetch tests |
| [src/web/server.ts](../../../src/web/server.ts) | Modified | +378 | -27 | Settings, uploads, PDF stream, eval endpoints |
| [src/web/server.test.ts](../../../src/web/server.test.ts) | Modified | +520 | -1 | API tests |
| [ui/app.js](../../../ui/app.js) | Modified | +353 | -21 | Attachment/PDF streaming/settings UI |
| [ui/index.html](../../../ui/index.html) | Modified | +39 | -1 | Media settings UI |

## Untracked Artifact Notes

* `.copilot-tracking/` contains many generated planning/review artifacts, including this review workspace.
* Root-level PDF `2604.14228v1.pdf` is untracked.
* `docs/VALIDATION-PROFILES.md`, `release-provenance.json`, release zips, release manifests, and release notes are untracked.
* `src/tools/pathResolution.ts` is untracked but imported by tracked source files, so it must be included before the branch can build cleanly from a fresh checkout.

## Instruction Files Reviewed

* `.github/skills/code-review/SKILL.md`: Applied to agent loop safety, permission gating, context budget, read-only tool classification, subagent isolation, type safety, and error recovery.
* `.github/skills/harness-conventions/SKILL.md`: Applied to deny-first permission posture, context-as-scarce-resource, tool dispatch classification, and append-only persistence expectations.
* `c:/Users/Brad/.vscode/extensions/ise-hve-essentials.hve-core-3.2.2/.github/instructions/hve-core/markdown.instructions.md`: Applied to generated tracking markdown; file begins with markdownlint disable per PR Review mode.

## Review Items

### 🔍 In Review

#### RI-001: Chat History Can Exceed Request Body Limit

* File: [ui/app.js](../../../ui/app.js#L6-L16), [ui/app.js](../../../ui/app.js#L1019), [src/web/server.ts](../../../src/web/server.ts#L36)
* Category: Reliability
* Severity: High

**Description**

The UI persists up to 50 messages at 200 KB each and sends `history: chatMessages.slice(0, -1)` on every `/api/chat` request. Express parses JSON with a 1 MB limit before server-side history trimming can run, so a few large tool/PDF outputs can make follow-up turns fail with a request-size error.

**Suggested Resolution**

Trim outbound history on the client to a byte budget below the server parser limit, or raise the parser limit and enforce a pre-query history budget before model execution. Add a regression test that sends near-limit history through `/api/chat`.

**Applicable Instructions**

* Harness conventions: context is scarce; large history/tool results must be bounded before they affect runtime reliability.

**User Decision**: Pending

**Follow-up Notes**: Candidate PR comment.

#### RI-002: Upload Cleanup With Zero Days Deletes Active Uploads

* File: [src/web/server.ts](../../../src/web/server.ts#L1262-L1285), [ui/index.html](../../../ui/index.html#L397-L405)
* Category: Reliability
* Severity: High

**Description**

`/api/uploads/cleanup` accepts `olderThanDays: 0`; `pruneUploads` computes `cutoffMs = Date.now()`, so nearly every existing file has `mtime < cutoffMs` and is deleted. The UI also presents `0` as a disabling value for auto-prune, which makes the manual cleanup semantics easy to misread.

**Suggested Resolution**

Reject `olderThanDays <= 0` for manual cleanup or treat it as a no-op. Keep `0 disables` only for auto-prune, and add an endpoint test for `olderThanDays: 0`.

**Applicable Instructions**

* Code review checklist: protect user data and cover edge cases that can cause data loss.

**User Decision**: Pending

**Follow-up Notes**: Candidate PR comment.

#### RI-003: Quoted PDF OCR Placeholder Produces Broken Arguments

* File: [src/tools/pdfTool.ts](../../../src/tools/pdfTool.ts#L253-L263), [ui/index.html](../../../ui/index.html#L381-L383), [src/tools/pdfTool.test.ts](../../../src/tools/pdfTool.test.ts#L88-L94)
* Category: Functional Correctness
* Severity: High

**Description**

The UI suggests `tesseract "{input}" - -l eng`, but `runPdfOcr` replaces `{input}` with `JSON.stringify(inputPath)`. A quoted template therefore renders as doubled quotes, such as `""C:\path\scan.pdf""`, and `stripQuotes` leaves quote characters in the argument. Typical OCR commands will fail to open the file. Existing tests only cover an unquoted `{input}` template.

**Suggested Resolution**

Use one consistent substitution model: either insert raw paths and require users to quote placeholders, or insert escaped path arguments and document templates without surrounding quotes. Add tests for the UI-recommended quoted template and paths containing spaces.

**Applicable Instructions**

* Code review checklist: validate external command invocation, edge cases, and tool error recovery.

**User Decision**: Pending

**Follow-up Notes**: Candidate PR comment.

#### RI-004: PDF Streaming Rejects External Upload Directories

* File: [src/web/server.ts](../../../src/web/server.ts#L373-L401), [src/web/server.ts](../../../src/web/server.ts#L1205-L1212), [ui/app.js](../../../ui/app.js#L928-L939)
* Category: Functional Correctness
* Severity: Medium

**Description**

Uploads can be configured outside the project via `HARNESS_UPLOADS_DIR` / media settings, and `/api/upload` returns that absolute path. `streamPdfExtract` sends that exact path to `/api/pdf/extract`, but the route rejects anything outside `process.cwd()`. The same PDF can be valid for `pdf_read` through `resolveProjectReadPath` while the UI streaming button fails.

**Suggested Resolution**

Resolve the route path through the same read-path helper used by PDF tools, including configured uploads directories, then keep extension and size checks. Add an API test with `HARNESS_UPLOADS_DIR` pointing outside the project.

**Applicable Instructions**

* Harness conventions: reuse existing helper APIs instead of duplicating subtly different path rules.

**User Decision**: Pending

**Follow-up Notes**: Candidate PR comment.

#### RI-005: PDF Streaming Lacks The PDF Size Cap

* File: [src/web/server.ts](../../../src/web/server.ts#L373-L401), [src/tools/pdfTool.ts](../../../src/tools/pdfTool.ts#L9-L10)
* Category: Reliability
* Severity: Medium

**Description**

`PdfReadTool` enforces `MAX_PDF_BYTES`, but `/api/pdf/extract` reads the entire file with `fs.readFile(resolved)` before streaming pages and has no equivalent size guard. A large in-project PDF can consume memory before the route emits any stream events.

**Suggested Resolution**

Stat the file before reading and reject PDFs over the same maximum used by the tool, or refactor the route to share a capped helper. Add a test for oversized PDFs.

**Applicable Instructions**

* Code review checklist: cap tool results and resource usage to protect context and process reliability.

**User Decision**: Pending

**Follow-up Notes**: Candidate PR comment.

#### RI-006: New Read-Only Tools Are Not Auto-Approved

* File: [src/permissions/engine.ts](../../../src/permissions/engine.ts#L3-L4), [src/tools/index.ts](../../../src/tools/index.ts#L32-L41)
* Category: Conventions
* Severity: Medium

**Description**

The new `pdf_read`, `pdf_metadata`, and `pdf_extract_tables` tools are registered with `isReadOnly: true`, but the permission engine uses a hardcoded `READ_TOOLS` set that does not include them. In default mode, attachment analysis that the UI explicitly tells users/models to perform will create permission prompts instead of following the read-only auto-approval contract.

**Suggested Resolution**

Add the new read-only tools to `READ_TOOLS`, or better, derive default approval from registered tool metadata so future read-only tools cannot drift. Add permission tests for the PDF tools.

**Applicable Instructions**

* Harness conventions: tool dispatch classification must be accurate; read-only tools should be concurrent-safe and default-allowed under the read-only policy.

**User Decision**: Pending

**Follow-up Notes**: Candidate PR comment.

### ✅ Approved for PR Comment

* None yet.

### ❌ Rejected / No Action

* None yet.

## Review Plan and Coverage

* ✅ Source PDF tools reviewed
* ✅ Upload path resolution reviewed
* ✅ Web upload/PDF streaming routes reviewed
* ✅ Permission defaults reviewed
* ✅ UI attachment/PDF streaming flow reviewed
* ✅ Independent static review pass completed
* 🔍 Release artifacts noted as repository hygiene concern; not deeply reviewed as functional code
* 🔍 Tests reviewed for coverage gaps around high-risk edge cases

## Next Steps

* [ ] Confirm which review items should be promoted to final PR comments.
* [ ] Optionally generate [handoff.md](handoff.md) after decisions are captured.
