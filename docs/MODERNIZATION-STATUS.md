---
title: Modernization Status
description: Implemented Windows-first changes, validation evidence, and remaining release gates
ms.date: 2026-09-15
---

## Scope

Windows-first onboarding and packaging, explicit local or cloud model selection,
measured efficiency, and portable core compatibility. This work preserves the
existing query loop, permission dispatcher, routing, and persistence contracts.
The six-phase roadmap is not complete, and these changes are not a release approval.

## Latest Checkpoint

As of 2026-09-15, package metadata remains 0.6.5 and this work targets `dev`,
not a new release. The September 14 cloud and final local gates below supersede
the earlier September 5 validation record. Earlier counts and unrun statements
are retained as historical evidence, not instructions to repeat GPU work.

- Full Jest: 316 suites, 3,759 tests passed, one skipped, exit 0 after draining
	pending test persistence writes before cleanup.
- Offline checks: 41 benchmark tests and 31 runtime/lifecycle/resume/dependency/app
	tests passed. Typecheck, beginner browser smoke and release archive dry run passed.
- Live cloud: original development 29/36; clarified development v2 36/36;
	frozen holdouts 12/24, unchanged and not rerun. Prompt changes prevent a
	like-for-like improvement claim. No local-model qualification is implied.
- Still pending: live UI/app/recovery qualification, actual disposable Windows
	install/reinstall/uninstall, hosted CI/macOS, user usability and release approval.

The September 15 pre-commit recheck passed all 347 tests in twelve changed Jest
suites, plus typecheck, version consistency, changelog and whitespace checks.
All sixteen refreshed Markdown documents passed YAML and relative-file-link
validation; the implementation plan's task entries and completion flags remained
unchanged. No inference request or GPU configuration change was needed.

Keep the user's separate GPU workload untouched. Do not run local inference,
restart shared model services or change GPU configuration to repeat these checks.

## Implemented

| Area | Change | Evidence |
| --- | --- | --- |
| Setup | Selected-provider readiness; configured credentials are not verified inference; optional services do not block unrelated chat | Setup/API tests and beginner browser smoke |
| Model choice | Fresh sessions and unavailable or unreadable saved choices require explicit selection; existing valid local/cloud choices are retained | Browser checks with cloud-first ordering, saved choice, missing model and settings failure; Send disabled without a selection |
| First response | Quick Test confirms model, provider, workspace and cloud cost warning; cancelled confirmation sends no request; incomplete/error output stays unverified | Browser smoke with six response outcomes, offline setup and active cancellation |
| Runtime | Node minimum 22.13.0; Node 24 LTS recommended; package, installer, CI and setup docs aligned | Runtime contract tests, typecheck and release archive checks |
| Launch | Source rebuilds; complete prebuilt releases bypass compilation; launchers preserve occupied ports; background Stop uses an owning supervisor, never a recorded PID | Twenty-five runtime/lifecycle checks including active-chat cancellation and supervisor loss in the built web server; actual installer execution still required |
| Background ownership | Cooperative shutdown with bounded forced fallback; tray discovers the actual owned port; maintenance refuses unresolved ownership | Real child-process, cross-installation, stale-marker, forced-stop warning, nested non-detached descendant and Windows tray tests |
| Maintenance exclusion | Installer and uninstaller hold an exclusive ownership marker across file operations; launcher and supervisor both check it; only the matching token releases it | Competing ownership, wrong-token release, supervisor-side rejection, failed-operation retention and fresh-install cross-process CLI tests; actual NSIS execution remains pending |
| Dependencies | Targeted compatible updates, Nodemailer 10, PDF.js 6.3.289 and an ExcelJS-scoped UUID 11.1.1 override | Zero npm audit vulnerabilities; three real-library mail/spreadsheet contracts; PDF loading-task cleanup migration and full Jest |
| Document outcomes | Twelve development contracts independently inspect JSON, CSV, XLSX, DOCX, PDF and read-only answers; PDF footers no longer create an extra page | Twelve adversarial grader tests and 36/36 offline scripted attempts through real tools; not live-model qualification |
| Frozen holdouts | Eight separately AI-authored tasks use distinct evidence and a pinned SHA-256; explicit holdout runner mode preserves the split and digest | Reference-artifact checks, digest mutation rejection, no-inference preflight and deliberately incorrect offline attempts checked; September cloud holdouts scored 12/24 |
| App outcome | A real query loop writes a small TypeScript app through permission-checked file tools; the installed compiler builds it and Chromium executes it | Calculations, invalid input and layout checked at 390px and 1440px; scripted client, not live-model or independent holdout evidence |
| Interrupted sessions | Resumed tool results preserve call IDs; real loop workers interrupted before/after result persistence resume in fresh processes | Two process integrations verify append-only history, denied replay and read-only reconciliation; scripted clients and fixture permissions, not automatic recovery |
| Partial transcripts | Resume exposes read diagnostics; browser rejects unavailable sessions and confirms partial recovery; continuation separates a torn tail from new events without rewriting history | Missing/unreadable/HTTP-error and declined-recovery browser checks preserve chat; checkpoint/tool/image fields survive; twelve persistence tests include concurrent appends and valid unterminated events |
| Benchmark telemetry | Worker startup, first useful output, request/schema bytes, completed-call usage/duration and worker peak RSS | Offline integration assertions; missing usage remains null and bytes are not presented as tokens |
| Context attribution | Serialized message bytes grouped by system/user/assistant/tool/other role; schema and array framing bytes recorded separately; stable call IDs link retries to context | Exact UTF-8, image/tool metadata, unknown-role and empty-context checks; real worker IPC and all 36 scripted outcomes retain attribution without adding message content to these counters |
| Raw request usage | Optional Ollama `chat` attempt events report retries, duration and raw terminal token counts; absent counts remain null | Real benchmark worker and SDK retry over loopback HTTP emits IPC events; failed-attempt unknown usage prevents a false complete total; other clients and methods remain outside coverage |
| Retry reliability | Structured SDK HTTP status takes precedence over message wording; an active backoff timer keeps standalone workers alive | HTTP 503 with arbitrary wording retries and completes; HTTP 400 with misleading transient wording does not retry; worker regression reproduced premature exit before repair |
| Client cancellation | Caller cancellation reaches the SDK transport before response headers arrive | Real loopback HTTP tests for `chat` and `chatStream`; an independent concurrent request remains usable |
| Installer compilation | Both tray shortcuts use an NSIS-supported minimized show mode | NSIS 3.08 compiled the final installer in a disposable Linux container; no installation executed |
| Efficiency reporting | Existing experiment CLI/history exposes all-attempt duration per passed attempt, including failed work and replicate counts | Report tests; missing token/cost/pass-count evidence remains null |
| Benchmark validity | Error or incomplete streams cannot pass from matching text; request and response-body deadlines abort stalled work | Focused evaluator tests, including stalled HTTP headers and body |
| MCP stdio | Newline framing by default; explicit legacy Content-Length; byte-safe UTF-8; version validation; pagination; timeout cancellation; request ID separation | Official SDK 1.30.0 fixture, legacy fixtures, split-byte, pagination, error and peer-observed cancellation tests |
| Portability CI | Windows/macOS Node 24 and Ubuntu Node 22.13 core/browser jobs added; existing Ubuntu gates retained; disposable Windows install/reinstall/uninstall job added | Configuration prepared, not executed on hosted runners |

MCP advertises the supported `2024-11-05` protocol. This is not an implementation
of every current MCP feature. Existing custom Content-Length servers must opt in
with `"framing": "content-length"` in their server definition.

The efficiency metric uses the evaluator's pass verdict; development outcome mode
also requires independent artifact/response checks. This is not evidence that
arbitrary real-world tasks succeeded. The local runner's task duration includes
worker startup and adds outcome-verifier duration; it excludes fixture setup and
cleanup. The separate `clientUsage` summary aggregates reported tokens across
recorded calls, including failed attempts. Missing call telemetry or usage leaves
its total and per-pass rate null; known partial usage remains visible. This is not
complete inference accounting: the client can normalize omitted counts to zero
in this compatibility summary. The separate `requestUsage` summary consumes raw
Ollama `chat` attempt events, including retries and failed attempts. Missing raw
counts remain null rather than becoming zero. Complete totals also require each
recorded client call to have linked raw requests, and every raw request to belong
to a recorded call; missing or legacy linkage leaves the total unknown while
preserving known partial usage. Workers are closed before report snapshots in
every benchmark mode, so termination evidence and queued IPC are drained.
It excludes `chatOnce`,
`chatStream`, other clients, daemon background work and cost. The offline outcome
fixture replaces `chat`, so it emits no raw requests and its raw total correctly
remains unknown. A separate real SDK/worker transport fixture now verifies raw
retry events over IPC without inference. The September cloud cohorts below also
exercised the raw event wiring live; the earlier local cohorts did not.
`efficiency.totalTokens` and `costUsd` remain null. Idle cost and unknown usage
remain unmeasured.

Each client call records message JSON bytes by role, plus array framing bytes
and tool-schema bytes. Images, tool-call arguments and other message metadata
are counted within their message role. These counters do not duplicate message
content, infer token counts or measure the entire SDK/HTTP envelope. They cannot
distinguish original instructions from a checkpoint when both use the system
role; source-level provenance and actual context-window occupancy remain open.

## Earlier Validation Recorded (2026-09-05)

- Final full Jest run: 316 suites passed; 3,759 tests passed, one skipped and zero failures. This includes client cancellation, structured retry status, raw attempt telemetry, resume diagnostics and the append-boundary repair.
- Twelve focused persistence tests passed. A regression first reproduced loss of the first event appended after a torn tail, then passed with the append-only separator repair. This is not power-loss durability or an exactly-once side-effect guarantee.
- Both real-process interruption/resume cases passed on Windows. Both CI jobs run them after compilation; hosted execution is still pending.
- Beginner browser smoke passed at 390px and 1440px, including explicit selection, unsupported tools, offline requests/setup, active cancellation and response recovery. Recovery checks preserve current chat on missing/unreadable transcripts, HTTP failure and declined partial recovery; accepted recovery retains all message fields and sends no model request. Chat requests are intercepted: this does not prove live inference works. Earlier fresh screenshots were inspected; resizing an open desktop navigation drawer can leave it covering the mobile view.
- Twenty-five Node runtime/lifecycle/packaging checks and three dependency contracts passed on Windows. The built web server selected a free port while an unrelated listener occupied the preferred port; Stop aborted an active chat and stopped only the owned server. Two additional process tests confirmed ordinary nested non-detached descendants terminate on Stop and supervisor loss while an unrelated process survives. This is not detached-service cleanup or graceful crash recovery.
- Portable supervisor and runtime checks passed in an offline Node 24 Debian container: nineteen passed and four Windows-only checks skipped. Sources were mounted read-only and tests ran against disposable copies. This is local Linux evidence, not execution of the full hosted CI matrix or macOS qualification.
- Maintenance tests passed for owner-only release, competing operations, failed-preparation retention, supervisor-side launch rejection and an initially absent installation path with spaces and apostrophes. The installer smoke now checks that successful maintenance removes its lease; its syntax passed, but the NSIS runtime assertion has not been exercised.
- The final combined outcome/process command passed 21 tests: twelve outcome graders, four usage controls, a real SDK/worker retry telemetry fixture, the 36-attempt offline runner, two interruption/resume cases and one compiled browser app. Both CI jobs run the app check after Chromium installation; hosted execution is pending.
- After the context-attribution changes, all eight tests in the telemetry/outcome integration file passed, including all 36 scripted real-tool attempts. Exact byte partitions, retry call IDs and missing-linkage controls passed. The earlier 21-test combined result predates these script-only additions; the full Jest suite was not rerun for them.
- The subsequent holdout and telemetry integration command passed nineteen tests: eleven holdout checks and eight existing telemetry/outcome checks. All 24 deliberately incorrect holdout attempts were recorded as failures, while 36 scripted development attempts passed. This is runner/grader validation, not candidate inference. Both CI jobs now include the holdout suite; workflow YAML and both entries were validated locally.
- npm audit was rerun against the current dependency tree and reported zero vulnerabilities; the three installed mail/spreadsheet contracts also passed again. No lockfile changes or installations were made during this recheck. This is not a comprehensive security audit or a fresh-install test.
- Local transport smoke passed: delayed headers, request body, abort before headers.
- Release dry run passed: build, staged archive, provenance, version metadata and checksum manifest. This does not execute the Windows installer.
- NSIS 3.08 compilation passed with the maintenance lease hooks in a disposable Debian container. The executable is 2,599,454 bytes with SHA-256 `50e128faa6e3b7762f383dabc69ab84fa71a06baf329ec784ade4a58e078a418`. It was not executed, signed or published.
- Typecheck, version consistency, changelog and whitespace gates passed; no version bump was made. Git reported line-ending conversion warnings, not whitespace errors.
- Local-only qualification runs were performed as described below. No paid request, model download, release publication, or git commit was performed.

## Local Qualification

These are preliminary synthetic probes, not the planned end-to-end benchmark or
independently authored holdout. They use fresh temporary workspaces, explicit
local model names, no shell tools, no cloud credentials, and unchanged permission
and outcome checks. File tests permit only reading the two fixture paths and
writing the designated output. Each task has three attempts; failures count in
total time. Each attempt has a deadline and the runner has a 30-minute budget.

| Cohort | Verified passes | Total task time | Seconds per verified pass |
| --- | --- | --- | --- |
| Qwen3 1.7b: 20 structured JSON tasks | 60/60 | 132.989 s | 2.22 |
| Qwen3 1.7b: five file tasks | 4/15 | 120.796 s | 30.20 |
| Qwen3 1.7b: same file tasks, evidence capture rerun | 3/15 | 161.758 s | 53.92 |
| Gemma4 e4b: same file tasks and checks | 12/15 | 391.936 s | 32.66 |

Recorded environment: Windows, Node 24.13.0, Ollama 0.21.2, Intel i7-7700K,
51,491,545,088 bytes system RAM. Reports include model digests and initial model
residency. These are not paired cold/warm trials; the first Qwen JSON request
started with no resident model. GPU usage, peak memory, token totals and monetary
costs were not measured. No speedup or default-model change is justified by these
small cohorts.

File outcome checks independently read the resulting JSON and require unchanged
input. Retained Qwen traces include malformed JSON arguments and unauthorized
paths that were correctly denied. A `completed` loop event can accompany a wrong
artifact. A focused inline-parser check preserved nested JSON content exactly;
it did not reproduce truncation or establish the root cause of every live failure.
Neither model is qualified here for unattended beginner file-building work.

The new twelve-task development set adds sourced comparison, CSV/XLSX/DOCX/PDF,
absent evidence, verify-only work and checkpoint-fixture continuation. The
checkpoint case is not a real crash/resume test. Both Gemma development runs
stopped after the first three attempts timed out at 60 seconds each: 0/3 verified
passes per run, with 33 planned attempts not executed. The instrumented run
recorded worker startup at 1.3-2.0 seconds and entry into the first model call;
none returned a completed reply before the deadline. Ollama reported CPU
residency. The cause of the stall is unresolved; no larger deadline, fallback or
model-default change was used to obtain a passing result.

Read-only endpoint diagnosis found two different services on port 11434:
`127.0.0.1` reaches WSL Ubuntu Ollama 0.21.2, while `[::1]` reaches native Windows
Ollama 0.33.2. The benchmark uses the IPv4 WSL endpoint. The native service did
not list either permitted benchmark model and had an unrelated model resident;
it was not substituted. Native Windows logs cannot explain the WSL stall.

Raw synthetic no-tool requests also stalled: Gemma reached a 30-second deadline
without headers or chunks, and Qwen reached a 20-second deadline. Ubuntu's
latest bounded Qwen recheck also timed out after 20.012 seconds. The systemd
service remained active with a long-lived runner. A later snapshot showed
about 23 GB available WSL RAM and little swap usage, not current memory exhaustion.
The accessible journal showed metadata requests but no matching runner/loading
errors. These observations localize the failure below the harness loop, not its
root cause. A subsequently authorized single restart attempt using Ubuntu
`systemctl --no-ask-password restart ollama` was rejected with "Interactive
authentication required." No elevated retry was attempted, and no daemon
restart was performed by that command. The user subsequently restarted Ubuntu
Ollama manually. Systemd and the journal confirmed a new server PID, 93100,
active since 2026-09-05 17:58:29 BST. The IPv4 endpoint still reported version
0.21.2, and Qwen's installed digest and absence of remote-route metadata were
checked before a single no-tool request, `Reply with OK.`, with `num_predict:32`.
That request timed out after 20.014 seconds without response headers; token
usage remains unknown. No retries or benchmarks followed this probe.

The post-restart journal reported 434.6 MiB free GPU memory, below its stated
457.0 MiB minimum, and offloaded zero of 29 model layers to the RTX 3070.
Weights and KV cache were allocated on CPU; runner startup took 15.15 seconds.
The journal later recorded HTTP 500 for the cancelled request, but the client
received no HTTP status. CPU placement and startup consumed much of the deadline;
they do not establish the cause of the earlier stalls or prove warm inference
will succeed. No settings change, larger inference budget, model download or
native Windows Ollama disruption was performed. Controlled cold/warm and live
workflow qualification remain blocked pending a successful bounded probe.

The user subsequently confirmed another session was running a GPU test. The
post-restart observations therefore occurred under concurrent GPU load, not an
isolated qualification environment. This supports resource contention as a
contributor but does not establish the full cause of the timeout. Further local
inference probes and benchmarks are paused until that test finishes and resource
availability is rechecked. The other session's workload must remain untouched;
retain the failed probe separately from future isolated trials.

Offline scripted replies passed 36/36 and exposed the PDF footer defect, now
fixed. That establishes runner/tool wiring, not model capability. Telemetry records
request/schema bytes (not token estimates), completed-call provider usage and
durations, and worker peak RSS sampled at loop events. Peak memory before the
first event, Ollama process memory, concurrent daemon work and token usage from
incomplete calls are not captured. First useful output means a nonempty text event
or successful tool result, not independently verified task completion.

The bounded runner is [scripts/local-core-baseline.js](../scripts/local-core-baseline.js).
Run `node scripts/local-core-baseline.js --check` without inference. Live runs
require a new output path, an already installed local model, and a running Ollama
daemon. Local reports are under `results/local-*-2026-09-05.json`;
`results/` is ignored by Git and those raw traces are not release artifacts.

```powershell
node scripts/local-core-baseline.js results/new-core-run.json
node scripts/local-core-baseline.js --files results/new-file-run.json gemma4:e4b
node scripts/local-core-baseline.js --outcomes results/new-outcome-run.json gemma4:e4b
```

## Frozen Holdout Set

Eight tasks in [scripts/fixtures/modernization-holdout.json](../scripts/fixtures/modernization-holdout.json)
were authored by a separate general subagent without reading development cases,
tests, results, status documents or memory. The specialized dataset agent
declined to proceed without an interview and created nothing; the general
author received only the format and capability constraints. This is isolated
AI authorship, not human-independent review or statistical independence of the
underlying model. Expected answers were computed offline before candidate
execution. No candidate behavior was used to revise them.

The frozen SHA-256 is
`f8fed212d865078123ba858bf7b4b236732cefda137e0d95f5d4d78bff1a6291`.
The loader rejects any byte change. JSON, CSV, XLSX, DOCX, PDF, absent evidence,
read-only verification and continuation are covered. The existing artifact
verifier consumes task-specific fixtures without changing the development
answers. Reference artifacts verify text/cells/JSON and input preservation;
they do not prove visual document quality or model capability.

The negative-control responder returns only an incorrect "Done." without tools
or inference; all 24 attempts (eight tasks, three repeats) must fail. The live
runner uses the same deadlines, local model restrictions and permissions as
development mode. It records `held-out-ai-authored` and the dataset digest.
Do not tune the candidate or expected answers against holdout results; once
used for tuning, this set is no longer held out.

```powershell
node scripts/local-core-baseline.js --check-holdouts
node --test scripts/holdout-cases.test.js
```

After service recovery and a successful bounded synthetic probe, live execution
can use a new report path. This command has not been executed against a model:

```powershell
node scripts/local-core-baseline.js --holdouts results/new-holdout-run.json gemma4:e4b
```

## Cloud Workflow Qualification (2026-09-14)

Local inference remains paused because the user is running separate GPU tests.
The runner now accepts an explicit leading `--cloud` flag and model name. Without
that flag, its local-only allowlist and remote-route rejection remain unchanged.
Cloud mode requires matching installed model metadata with an HTTPS Ollama cloud
destination and a nonempty remote model name. Each worker rechecks this metadata
before constructing the client. There are no model downloads or local fallbacks.
This relies on the daemon honoring its advertised route; it is not GPU isolation
against a concurrent change to that route.

The existing IPv4 endpoint, `http://127.0.0.1:11434` (Ollama 0.21.2), advertised
`glm-5.2:cloud` as remote model `glm-5.2` at `https://ollama.com:443`.
A single synthetic probe returned HTTP 200 and `OK.` in 1.367 seconds. The probe
command exited 1 because its exact-text assertion expected `OK` without a period;
transport and inference completed. No service restart or local inference was used.

The subsequent runs used unchanged prompts, graders, permission checks, three
replicates, 60-second task deadlines and the existing infrastructure-failure stop
rule. Only synthetic task content and tool results were sent to the cloud.

| Split | Verified passes | Total task time | Seconds per verified pass |
| --- | --- | --- | --- |
| Twelve development tasks | 29/36 | 278.648 s | 9.61 |
| Eight frozen AI-authored holdouts | 12/24 | 251.107 s | 20.93 |

Both runs completed without timeouts or early infrastructure stops. These are raw
contract-verifier scores, not a general model ranking or an unattended-workflow
qualification. Development failures included unexpected source JSON structure,
worksheet-name mismatch and fenced JSON responses. Some failures concern exact
representation rather than incorrect arithmetic; graders were not relaxed.
The holdout dataset and its pinned digest were not changed or tuned after use.

Reports are stored separately under `results/` (Git-ignored):

- `cloud-development-glm-5.2-2026-09-14.json`
- `cloud-holdouts-glm-5.2-2026-09-14.json`

Reports identify `inferenceMode: ollama-cloud`, the remote host/model and the
limitation to cloud workflow evidence. Development recorded 59,680 raw reported
tokens across 99 linked requests. Monetary cost remains unknown; requests use the
daemon's signed-in cloud account and may consume its allowance.

Validation: compilation passed; 23 offline guard/holdout/telemetry checks passed
before live runs. The expanded six-test cloud suite then passed, including a
36-attempt offline real-tool run proving worker opt-in propagation and report
labels, plus worker rejection of local metadata before inference. CI entries now
include this offline suite; hosted CI has not run. The full Jest suite was not
rerun at that checkpoint; the follow-up results below supersede this gap.
No commit, release or global model-setting change
was performed.

To repeat a cloud development run, use a new report filename:

```powershell
node scripts/local-core-baseline.js --cloud --outcomes results/new-cloud-development.json glm-5.2:cloud
```

### Development Contract Revision and Local Gates

Follow-up inspection found that all three spreadsheet failures contained correct
cells on an explicitly named `Sheet1`. The exporter honored the tool call; the
grader required `Inventory` although the prompt specified only a document title.
The source-comparison prompt also left its expected flat source-ID array implicit.
These are benchmark-contract ambiguities, not demonstrated exporter defects.

The five affected development prompts now explicitly request the worksheet name,
flat JSON field structure, or raw JSON without Markdown fences. Graders were not
relaxed. Regression tests retain rejection of wrong sheet names, nested source
maps, fenced JSON, incorrect values and changed inputs. Runtime document behavior
was not changed. The revised dataset is `development-v2`; reports include its
version and a digest covering cases and shared fixture values:
`687c5073e3520a369f24a2513997eb29e619b5238b38246c3a64ea5bae968249`.

The cloud v2 run passed 36/36 attempts without timeouts, taking 201.494 seconds
across tasks (5.60 seconds per verified pass). It recorded 59,533 raw reported
tokens across 99 linked requests; monetary cost remains unknown. The report is
`results/cloud-development-v2-glm-5.2-2026-09-14.json`. This is a revised-task
result, not a like-for-like improvement over the original 29/36, a model ranking,
or independent generalization evidence. The frozen holdouts were not rerun or
modified and remain 12/24 on their original cloud cohort.

The expanded local validation pass completed:

- Full Jest: 316 suites, 3,759 passed tests, one skipped, process exit 0.
- All 41 offline development, holdout, telemetry and cloud-mode checks passed.
- All 31 runtime, lifecycle, interruption/resume, dependency and compiled-app
	integration checks passed on Windows, using disposable fixtures.
- Beginner browser smoke passed at mobile and desktop sizes with intercepted
	chat, including active cancellation and partial-session recovery.
- Typecheck and release archive dry run passed; the archive was staged in a
	temporary directory, not installed, signed or published.

The first full Jest pass reported all tests passing but exited 1. A captured
rerun exposed webhook persistence logging after suite teardown and a skills
test directory-removal race. The webhook route tests now await the existing
pending-write flush. Skills tests track and await real usage-write promises
before removing fixtures. Neither fix disables persistence or changes production
behavior. Both focused suites passed, followed by the clean full run above.
Complete failure and post-fix logs are retained as
`results/jest-gate-2026-09-14.log` and
`results/jest-gate-fixed-2026-09-14.log`.

Local inference and the user's GPU test remain untouched. The compiled app and
recovery integrations still use scripted clients; hosted CI, real installer
execution and live-model UI/app/recovery qualification remain separate gates.

## Remaining Work

1. Extend live cloud qualification beyond the clarified development contracts without tuning the frozen holdouts. Development v2 passed 36/36, while the original holdouts remain 12/24; controlled local trials remain pending. A separate compiled app fixture and interruption/resume checks use scripted clients; live-model app and recovery outcomes remain unqualified.
2. Diagnose the bounded live-model timeout and establish repeated end-to-end trials with controlled cold/warm cohorts. Existing results establish neither novice workflow reliability nor a general model ranking.
3. Extend telemetry beyond role-level context bytes to source provenance, actual context-window occupancy, complete usage aggregation, daemon/GPU memory and background load. Retry-to-call linkage is now checked before reporting complete recorded usage. Only then choose efficiency changes; no measured improvement is claimed yet.
4. Complete real document/build first-outcome verification in the beginner UI. Unsupported tools, offline operation and active cancellation now have browser fixtures, not real model/tool evidence.
5. Execute disposable Windows install, active same-version reinstall and active uninstall, preserving both external workspace and installation-local state. Compilation passed, but no disposable Windows runtime was available; neither Windows Sandbox nor the Hyper-V VM console executable was found. Separately validate cross-version upgrade, restricted privileges, offline installation, non-ASCII paths and crash recovery.
6. Execute the new Windows/macOS/Linux CI jobs. Local Windows checks and an isolated Linux lifecycle subset passed; hosted matrix and macOS execution remain unverified.
7. Validate detached or externally managed tool descendants and reconciliation after supervisor loss. Windows ordinary nested non-detached termination is now tested; preservation of in-flight tool state and automatic recovery are not established.
8. Validate beginner usability with real participants and record results. Signing and publication require separate credentials and explicit approval.

## Background Lifecycle

Session interruption checks run with `node --test scripts/resume.integration.test.js`
after compilation. Each stops a worker after a ledger write, either before its
tool result is saved or after it is saved, then resumes the JSONL session in a
new worker. The fixture deliberately proposes a duplicate write under fresh
read-only permissions: dispatch denies it, a read reconciles the artifact, and
the transcript prefix and single ledger entry remain unchanged. These checks
use scripted model replies and fixture-supplied permissions. They do not verify
the UI permission factory, provider acceptance of unresolved tool calls,
power-loss durability, or automatic reconciliation of side effects. Separate
tests now cover partial JSONL reads and subsequent append boundaries: valid
messages survive, damaged history stays visible in diagnostics, and original
bytes remain unchanged. Browser restoration asks before accepting partial
history and does not automatically execute any action.

The background start/stop shortcuts use `scripts/background-server.js`. A local
IPC endpoint scoped to the canonical installation path and user home directory
admits one supervisor. The supervisor retains the child-process handle and does
not read a PID file to decide what to terminate. Startup output and the actual
chosen URL are in `.harness/background.log` under the installation directory.
"Launched" means a process was spawned, not that HTTP readiness was verified.

The tray queries the supervisor for its actual listening port and clears its URL
when unmanaged; it does not discover manually started foreground servers. The
release includes both shortcuts and the supervisor. Installer maintenance runs a
bundled helper that exclusively creates `.harness/maintenance.json` before
stopping the owned server. The marker blocks background launches until the
installer or uninstaller reaches its completion hook and releases it with the
matching token. The supervisor checks again after claiming its own marker to
cover launches that already passed the initial launcher check. Legacy PID files
and unreconciled background ownership still block maintenance. The disposable smoke is prepared to
exercise active reinstall/uninstall and preserve user state. Compilation, hosted
CI and actual NSIS installation are separate gates: compilation passed locally
in a disposable Linux container; hosted CI and Windows installation remain
unexecuted here.

Failed or interrupted maintenance retains its marker, including failure during
the initial stop check. A second installer cannot acquire that lease. Before
manually removing `.harness/maintenance.json`, confirm all installers and
uninstallers for this installation have exited and stop any foreground server.
Reconcile legacy or background ownership separately; do not use recorded PIDs as
authority to terminate processes. Then remove only the maintenance marker and
rerun setup to repair potentially partial files before launching. Do not delete
the `.harness` directory or other user state. The token prevents accidental
cross-operation release; it is not a security boundary against the same user.

A legacy `.harness/server.pid` blocks background launch. Confirm the old server
has stopped before removing that file; its PID is not proof of current ownership.
An interrupted supervisor can leave `.harness/background-owner.json`. Confirm
that its previous server has stopped before removing this marker and relaunching.
Normal Stop removes the marker. These refusals trade automatic recovery for
protection against duplicate servers and unrelated-process termination.

Stop requests cooperative shutdown through child IPC. The server rejects new chat,
aborts tracked chats and runs its bounded five-second cleanup. After seven seconds
the supervisor forcibly terminates an unresponsive child and reports possible
unsaved work in the Stop response and background log. On Windows, libuv assigns
the non-detached server to a kill-on-parent-exit job. Supervisor loss therefore
terminates the server before JavaScript cleanup; the integration test verifies
the child is gone, the ownership marker remains and an unrelated listener survives.
Separate Windows fixtures also verify two nested non-detached descendants exit
on Stop and supervisor loss. This is not graceful cancellation or guaranteed
cleanup of detached descendants, external services or every tool type.
The server remains non-detached to preserve this orphan-prevention behavior.
Stop active work in the UI first. Tool-state reconciliation, detached-service cleanup
and actual installer maintenance still need validation. Foreground servers must be stopped manually
before installation changes; the maintenance helper cannot prove they are absent.
The IPC endpoint is not a security boundary against another process running as
the same user. Use foreground launch and Ctrl+C when inspecting shutdown behavior.

## Compatibility Sources

- [MCP stdio transport](https://modelcontextprotocol.io/specification/2025-11-25/basic/transports): newline-delimited UTF-8 JSON.
- [MCP lifecycle](https://modelcontextprotocol.io/specification/2025-11-25/basic/lifecycle): version negotiation and timeout cancellation.
- [Official TypeScript SDK](https://github.com/modelcontextprotocol/typescript-sdk): pinned development fixture, not a production runtime replacement.
- [libuv Windows process implementation](https://github.com/libuv/libuv/blob/v1.51.0/src/win/process.c): non-detached children are assigned to a kill-on-parent-exit job; verified locally through the built-server fixture.

Do not enable cloud fallback, download models, change global Ollama settings, or
promote learned behavior merely to complete a benchmark. Cloud experiments need a
named provider, data scope and spending budget.

Removing provider environment variables does not disable Ollama cloud models:
the daemon can retain its own authentication. A local qualification must also
check the selected model route. Existing saved cloud choices remain explicit user
choices; merely listing available models must not choose a new cloud route.