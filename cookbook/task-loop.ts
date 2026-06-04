/**
 * task-loop.ts — CopilotForge Cookbook Recipe
 *
 * WHAT THIS DOES:
 *   Implements the autonomous dev loop pattern (Ralph Loop): read a plan
 *   from disk, pick the next pending task, implement it, validate the result,
 *   mark it done (with git commit) or failed, and repeat. State lives on
 *   disk — not in memory — so each iteration starts with fresh context.
 *
 * HARDENED FEATURES (Squad-inspired):
 *   - Safe git staging: stages only specific files, never `git add -A`
 *   - Graceful shutdown: check `.forge-stop` file or FORGE_STOP env var
 *   - 4-tier error escalation: retry → skip → pause → halt
 *   - Health summary: printed on exit and appended to forge-memory/decisions.md
 *   - Checkpoint persistence: `.forge-state.json` survives interruptions
 *   - Configurable max iterations via FORGE_MAX_ITERATIONS env var
 *
 * WHEN TO USE THIS:
 *   When you want an agent to work through an implementation plan
 *   autonomously — picking tasks, writing code, validating, and committing
 *   without human intervention between steps.
 *
 * HOW TO RUN:
 *   1. Create an IMPLEMENTATION_PLAN.md in your project root (see format below)
 *   2. npx ts-node cookbook/task-loop.ts
 *
 * PREREQUISITES:
 *   - Node.js 18+
 *   - TypeScript 5+
 *   - git initialized in the project
 *   - An IMPLEMENTATION_PLAN.md file (format shown in code)
 *
 * EXPECTED OUTPUT:
 *   [Ralph] Loaded 3 tasks from IMPLEMENTATION_PLAN.md
 *   [Ralph] === Iteration 1/10 ===
 *   [Ralph] Picked task: add-utils — "Create utility helpers"
 *   [Ralph] Implementing: add-utils...
 *   [Ralph] Validating: add-utils...
 *   [Ralph] ✅ Task add-utils passed — committing.
 *   [Ralph] === Iteration 2/10 ===
 *   ...
 *   [Ralph] 🏁 All tasks complete. 3 done, 0 failed.
 *   [Ralph] ═══════════════════════════════════
 *   [Ralph] 📊 Health Summary
 *   [Ralph]   Done:    3
 *   [Ralph]   Failed:  0
 *   [Ralph]   Pending: 0
 *   [Ralph]   Time:    12.4s
 *   [Ralph]   Reason:  all tasks complete
 *   [Ralph] ═══════════════════════════════════
 *
 * PLATFORM NOTES:
 *   - Windows: Use backslashes in paths or path.join() (both shown in code)
 *   - macOS/Linux: Forward slashes work natively
 *   - Environment variables: Use $env:VAR (PowerShell) or export VAR (bash)
 */

import { readFileSync, writeFileSync, appendFileSync, existsSync, mkdirSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { execFileSync, execSync } from "node:child_process";

// --- Log mirror ---
//
// Every console line from the autonomy loop is mirrored to .forge-run.log
// so the web UI (and `Get-Content -Wait`) can stream progress without
// scraping a terminal. Truncated on each new run.
const LOG_PATH = ".forge-run.log";
try { writeFileSync(LOG_PATH, ""); } catch { /* best-effort */ }
function mirrorLine(prefix: string, line: string): void {
  try { appendFileSync(LOG_PATH, `[${new Date().toISOString()}] ${prefix} ${line}\n`); } catch { /* best-effort */ }
}
const _origLog = console.log.bind(console);
const _origWarn = console.warn.bind(console);
const _origErr = console.error.bind(console);
console.log = (...args: unknown[]): void => { _origLog(...args); mirrorLine("LOG ", args.map(String).join(" ")); };
console.warn = (...args: unknown[]): void => { _origWarn(...args); mirrorLine("WARN", args.map(String).join(" ")); };
console.error = (...args: unknown[]): void => { _origErr(...args); mirrorLine("ERR ", args.map(String).join(" ")); };

// --- Types ---

type TaskStatus = "pending" | "done" | "failed";

/**
 * Task kind controls the success contract.
 *   - "code"     (default): must produce ≥1 file change AND validation must pass
 *   - "research": validation must pass; 0-file-changes is allowed
 *   - "external": touches paths outside the repo. Loop auto-writes
 *                 `.forge-runbooks/{id}.md` from the task title/anchors so
 *                 there is always at least one tracked artifact, then runs
 *                 the model normally. Use for "look in C:\X and …" tasks.
 */
export type TaskKind = "code" | "research" | "external";

interface Task {
  id: string;
  title: string;
  status: TaskStatus;
  /** Files to embed (read-only) in the per-task prompt for context. */
  anchors: string[];
  /** Optional explicit target file the model should edit. */
  target?: string;
  /** Success contract for this task (default: "code"). */
  kind?: TaskKind;
}

// --- Plan Parser ---

/**
 * Parses IMPLEMENTATION_PLAN.md into a list of tasks.
 *
 * Top-level task format — one task per line:
 *   - [ ] task-id — Task title          (pending)
 *   - [x] task-id — Task title          (done)
 *   - [!] task-id — Task title          (failed)
 *
 * Optional indented sub-bullets attach context to the immediately
 * preceding task. They survive plan rewrites because writePlan re-emits
 * them verbatim.
 *   - anchor: relative/path/to/file.ts   (model gets this file inline)
 *   - target: relative/path/to/file.ts   (file the model should edit)
 *   - kind: code | research | external   (success contract; default: code)
 *       code     — must produce ≥1 file change AND validate (default).
 *       research — must validate; 0 file changes is allowed.
 *       external — touches paths outside the repo; loop pre-writes
 *                  .forge-runbooks/{id}.md so there is always a tracked
 *                  artifact for the model to record findings in.
 */
export function parsePlan(filePath: string): Task[] {
  const content = readFileSync(filePath, "utf-8");
  const tasks: Task[] = [];
  let current: Task | null = null;

  for (const rawLine of content.split(/\r?\n/)) {
    const line = rawLine.replace(/\s+$/, "");
    const taskMatch = line.match(/^- \[(.)\] (\S+)\s*[—\-]\s*(.+)$/);
    if (taskMatch) {
      const [, marker, id, title] = taskMatch;
      let status: TaskStatus = "pending";
      if (marker === "x") status = "done";
      else if (marker === "!") status = "failed";
      current = { id, title: title.trim(), status, anchors: [] };
      tasks.push(current);
      continue;
    }

    if (!current) continue;
    const anchorMatch = line.match(/^\s+- anchor:\s*(\S+)\s*$/);
    if (anchorMatch) {
      current.anchors.push(anchorMatch[1]);
      continue;
    }
    const targetMatch = line.match(/^\s+- target:\s*(\S+)\s*$/);
    if (targetMatch) {
      current.target = targetMatch[1];
      continue;
    }
    const kindMatch = line.match(/^\s+- kind:\s*(code|research|external)\s*$/i);
    if (kindMatch) {
      current.kind = kindMatch[1].toLowerCase() as TaskKind;
      continue;
    }
  }

  return tasks;
}

/** Writes the task list back to IMPLEMENTATION_PLAN.md, preserving anchors and target sub-bullets. */
export function writePlan(filePath: string, tasks: Task[]): void {
  const lines = ["# Implementation Plan", ""];
  for (const task of tasks) {
    const marker = task.status === "done" ? "x" : task.status === "failed" ? "!" : " ";
    lines.push(`- [${marker}] ${task.id} — ${task.title}`);
    for (const anchor of task.anchors) {
      lines.push(`  - anchor: ${anchor}`);
    }
    if (task.target) {
      lines.push(`  - target: ${task.target}`);
    }
    if (task.kind && task.kind !== "code") {
      lines.push(`  - kind: ${task.kind}`);
    }
  }
  writeFileSync(filePath, lines.join("\n") + "\n", "utf-8");
}

/**
 * For `kind: external` tasks: ensure `.forge-runbooks/{id}.md` exists with
 * a stub the model can fill in. This guarantees the task has at least one
 * tracked artifact (avoiding the "0 file changes = failed" trap) and gives
 * the model a structured place to record its findings about paths outside
 * the repo. Idempotent.
 */
export function ensureRunbook(task: Task): void {
  const dir = ".forge-runbooks";
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
  const path = join(dir, `${task.id}.md`);
  if (existsSync(path)) return;
  const anchorLines = task.anchors.length > 0
    ? task.anchors.map((a) => `- ${a}`).join("\n")
    : "_(no anchors declared)_";
  const stub = `# Runbook: ${task.id}\n\n` +
    `**Task:** ${task.title}\n\n` +
    `**Kind:** external (touches paths outside this repo)\n\n` +
    `**Anchors:**\n${anchorLines}\n\n` +
    `## Findings\n\n_To be filled in by the agent._\n\n` +
    `## Actions taken\n\n_To be filled in by the agent._\n\n` +
    `## Follow-ups for the user\n\n_To be filled in by the agent._\n`;
  writeFileSync(path, stub, "utf-8");
  console.log(`[Ralph] 📓 Wrote external-task runbook: ${path}`);
}

// --- Implementation — wired to the local Ollama Agent Harness CLI ---

const HARNESS_MODEL = process.env.HARNESS_MODEL ?? "gemma4:e4b";
const HARNESS_HOST = process.env.HARNESS_HOST ?? "http://localhost:11434";
const HARNESS_BACKEND = process.env.HARNESS_BACKEND ?? "ollama";
const HARNESS_PERMISSION_MODE = process.env.HARNESS_PERMISSION_MODE ?? "acceptEdits";
const requestedMaxTurns = parseInt(process.env.HARNESS_MAX_TURNS ?? "30", 10);
const requestedUnproductiveTurnLimit = parseInt(process.env.HARNESS_UNPRODUCTIVE_TURN_LIMIT ?? "6", 10);
// Mirror the /api/autonomy/start clamp so env-direct users cannot accidentally
// pass an unbounded stall limit (e.g. 100000) that would defeat the breaker.
const clampedUnproductiveTurnLimit = Math.max(
  1,
  Math.min(100, Number.isFinite(requestedUnproductiveTurnLimit) ? requestedUnproductiveTurnLimit : 6),
);
const HARNESS_MAX_TURNS = String(Math.max(
  Number.isFinite(requestedMaxTurns) ? requestedMaxTurns : 30,
  clampedUnproductiveTurnLimit,
));
const HARNESS_UNPRODUCTIVE_TURN_LIMIT = String(clampedUnproductiveTurnLimit);
const HARNESS_VALIDATE_CMD = process.env.HARNESS_VALIDATE_CMD ?? "npm run typecheck";

/**
 * Build the prompt sent to the harness for a single task. When the task
 * declares anchors, their full file contents are embedded inline so the
 * model has zero need to explore — it can immediately call file_edit /
 * file_write. Without this, even strong agent models (Kimi K2.5,
 * gpt-oss:120b) get stuck in 30-turn read-everything loops.
 */
function buildTaskPrompt(task: Task): string {
  const anchorBlocks: string[] = [];
  for (const anchor of task.anchors) {
    try {
      const contents = readFileSync(anchor, "utf-8");
      const truncated = contents.length > MAX_ANCHOR_BYTES
        ? contents.slice(0, MAX_ANCHOR_BYTES) + `\n... [truncated at ${MAX_ANCHOR_BYTES} bytes]`
        : contents;
      anchorBlocks.push(
        `\n--- BEGIN FILE: ${anchor} ---\n${truncated}\n--- END FILE: ${anchor} ---\n`,
      );
    } catch (err) {
      anchorBlocks.push(`\n--- ANCHOR MISSING: ${anchor} (${err instanceof Error ? err.message : String(err)}) ---\n`);
    }
  }

  const visualReportPath = join(getBracknellDir(), BRACKNELL_VISUAL_REPORT_FILE);
  const targetLine = task.target
    ? `Target file (edit this exact path): ${task.target}`
    : requiresVisualBracknellReport(task)
      ? `Target file (edit this exact path): ${visualReportPath}`
      : `No explicit target file. Pick the most appropriate file from the anchors above.`;

  const sections: string[] = [
    `IMMEDIATE TASK — start working now. Do not ask for clarification. Do not greet me. Explore only what is needed to complete the task.`,
    ``,
    `Task: ${task.title}`,
    `Task id: ${task.id}`,
    ``,
  ];

  if (anchorBlocks.length > 0) {
    sections.push(
      `RELEVANT FILES (already read for you — do NOT re-read them unless you need current disk state):`,
      ...anchorBlocks,
      ``,
      targetLine,
      ``,
      `Required first action: use the most appropriate tool to make concrete progress.`,
      ``,
      `EDIT-STYLE RULES FOR CODE/TEXT FILES (critical):`,
      `  * Prefer file_edit over file_write. file_write replaces the ENTIRE file.`,
      `  * If the target file already has tests/code, ADD a new it(...)/test(...)/function block.`,
      `    Do NOT remove or modify existing tests, imports, or unrelated code.`,
      `  * Use file_write ONLY when the target file does not yet exist.`,
      `  * For file_edit, set old_string to a UNIQUE existing block (e.g. the closing \`});\``,
      `    of the relevant describe), and set new_string to that same block PLUS your`,
      `    additions. Never use empty old_string.`,
    );
  } else {
    if (requiresVisualBracknellReport(task)) {
      sections.push(
        `This is a Bracknell visual-report task. The final report must NOT be a Markdown file.`,
        targetLine,
        `Required deliverable: use file_write or file_edit on that exact target file as a polished, self-contained HTML report for Robyn.`,
        `Do not write the final report to C:\\AI\\AgentFiles. Do not create a Markdown final report.`,
        `Start from this HTML scaffold before refining the content: ${buildVisualReportScaffoldPrompt()}`,
        `Also update OUTPUT_MANIFEST.md and EMAIL_DRAFT.md with the visual report path and send/draft evidence.`,
        `After no more than three read/list/search calls, write the HTML target file even if it is only a first version, then refine it afterward.`,
        ``,
      );
    }
    sections.push(
      `Steps you MUST execute in this order:`,
      `  1. Inspect the relevant folder, files, or web sources named by the task.`,
      `  2. After no more than three read/list/search tool calls, create or update at least one requested deliverable file.`,
      `  3. Create, edit, export, or send the concrete deliverable requested by the task.`,
      `  4. Create or update a short verification artifact when the task is broad, external, or deliverable-focused.`,
      `  5. For external-folder delivery tasks, write the verification artifact inside the requested external folder.`,
      `  6. Reply with what changed, where it changed, and any remaining blockers.`,
    );
  }

  sections.push(
    ``,
    `Tool guidance: use file_read, file_write, file_edit, list_files, grep, bash, web_search, web_read, document_export, email_draft, and email_send when the task calls for them and permissions allow.`,
    `For file/folder inspection, prefer list_files, file_read, and grep. Do not use bash to run dir, ls, pwd, or shell pipelines for basic file inspection.`,
    `Forbidden unless directly required by the task: calendar_read, image_analyze, audio_transcribe, analyze_patterns, promote_pattern, reflect, consolidate, evolve, improve_skill.`,
    ``,
    `If you cannot complete the task, create a clear blocker note or verification artifact explaining exactly what stopped you.`,
    `Do not modify IMPLEMENTATION_PLAN.md, .forge-state.json, or .copilot-tracking/.`,
    `Make the smallest set of changes that satisfies the task, but do not skip required deliverables.`,
  );

  return sections.join("\n");
}

/** Hard cap per anchor file. Keeps prompts under typical 32K-128K context limits. */
const MAX_ANCHOR_BYTES = 24_000;
const BRACKNELL_REQUIRED_FILES = ["OUTPUT_MANIFEST.md", "READ_ME_FIRST.md"];
const BRACKNELL_VISUAL_REPORT_FILE = "ROBYN_VISUAL_REPORT.html";

function getBracknellDir(): string {
  return process.env.HARNESS_BRACKNELL_DIR ?? "C:\\AI\\Oracle\\Bracknell_Food_Business";
}

function isBracknellDeliveryTask(task: Task): boolean {
  const text = `${task.id} ${task.title}`.toLowerCase();
  return text.includes("bracknell") && text.includes("food");
}

function requiresVisualBracknellReport(task: Task): boolean {
  const text = `${task.id} ${task.title}`.toLowerCase();
  return isBracknellDeliveryTask(task)
    && (text.includes("visual") || text.includes("visually") || text.includes("html") || text.includes("don't use markdown") || text.includes("do not use markdown"));
}

function buildVisualReportScaffoldPrompt(): string {
  return "<!doctype html><html lang=\"en\"><head><meta charset=\"utf-8\"><meta name=\"viewport\" content=\"width=device-width, initial-scale=1\"><title>Robyn's Bracknell Food Business Launch Report</title><style>body{font-family:Segoe UI,Arial,sans-serif;margin:0;color:#1f2933;background:#fffaf1}header{padding:56px 24px;background:#24577a;color:white}main{max-width:1100px;margin:auto;padding:24px}.grid{display:grid;grid-template-columns:repeat(auto-fit,minmax(240px,1fr));gap:16px}.card{background:white;border:1px solid #d7cfc0;border-radius:8px;padding:16px}table{width:100%;border-collapse:collapse}th,td{padding:10px;border-bottom:1px solid #d7cfc0;text-align:left}</style></head><body><header><h1>Robyn's launch report</h1><p>Plain-English decision guide for the Bracknell food business.</p></header><main><section><h2>The short answer</h2><div class=\"grid\"><article class=\"card\"><h3>Best route</h3><p>Start small, prove safety, demand, and margin.</p></article><article class=\"card\"><h3>Main risk</h3><p>Operational complexity before food safety and costing are repeatable.</p></article></div></section><section><h2>90-day plan</h2><table><tr><th>Phase</th><th>Action</th></tr><tr><td>Week 1</td><td>Registration, allergen matrix, records, insurance.</td></tr><tr><td>Weeks 2-4</td><td>Test batches and soft launch.</td></tr><tr><td>Days 31-90</td><td>Repeatable sales rhythm.</td></tr></table></section></main></body></html>";
}

function startOfToday(): number {
  const now = new Date();
  return new Date(now.getFullYear(), now.getMonth(), now.getDate()).getTime();
}

function fileChangedSince(filePath: string, sinceMs: number): boolean {
  try {
    return statSync(filePath).mtimeMs >= sinceMs;
  } catch {
    return false;
  }
}

function collectChangedFilesSince(dir: string, sinceMs: number, maxFiles = 100): string[] {
  const found: string[] = [];
  const visit = (currentDir: string): void => {
    if (found.length >= maxFiles) return;
    let entries: string[] = [];
    try {
      entries = readdirSync(currentDir);
    } catch {
      return;
    }
    for (const entry of entries) {
      if (found.length >= maxFiles) return;
      const currentPath = join(currentDir, entry);
      let stats;
      try {
        stats = statSync(currentPath);
      } catch {
        continue;
      }
      if (stats.isDirectory()) {
        visit(currentPath);
      } else if (stats.mtimeMs >= sinceMs) {
        found.push(currentPath);
      }
    }
  };
  visit(dir);
  return found;
}

/**
 * Called once per task. Shells out to the harness CLI in headless mode.
 * The CLI handles model calls, tool dispatch, file edits, and permissions.
 *
 * HARNESS_TASK_TIMEOUT_MS caps wallclock per task so a runaway model that
 * burns its turn budget doing nothing useful cannot stall the autonomy loop.
 */
function implementTask(task: Task): void {
  const prompt = buildTaskPrompt(task);
  // Always pass the prompt via a temp file so anchor-file inlining (which
  // can produce 50+ KB prompts) doesn't hit Windows shell command-line
  // length limits. The CLI's --prompt-file flag handles either source.
  const promptPath = ".forge-prompt.txt";
  writeFileSync(promptPath, prompt, "utf-8");

  // Run the harness CLI from the harness repo's compiled output. The loop's
  // cwd is the user's project workspace, which has neither the CLI source nor
  // ts-node, so the old `npx ts-node src/cli/index.ts` (relative to cwd)
  // failed. HARNESS_HOME points at the harness repo; fall back to this file's
  // repo when launched directly for dogfooding.
  const harnessHome = process.env.HARNESS_HOME ?? join(__dirname, "..");
  const cliEntry = join(harnessHome, "dist", "cli", "index.js");
  const cliArgs = [
    cliEntry,
    "--backend", HARNESS_BACKEND,
    "--model", HARNESS_MODEL,
    "--host", HARNESS_HOST,
    "--mode", HARNESS_PERMISSION_MODE,
    "--max-turns", String(HARNESS_MAX_TURNS),
    "--unproductive-turn-limit", String(HARNESS_UNPRODUCTIVE_TURN_LIMIT),
    "--prompt-file", promptPath,
  ];

  const timeoutMs = parseInt(process.env.HARNESS_TASK_TIMEOUT_MS ?? "600000", 10);
  console.log(`[Ralph] >>> node ${cliArgs.join(" ")}`);
  console.log(`[Ralph] (per-task timeout: ${Math.round(timeoutMs / 1000)}s, prompt size: ${prompt.length} bytes, anchors: ${task.anchors.length})`);
  try {
    execFileSync(process.execPath, cliArgs, { stdio: "inherit", timeout: timeoutMs, killSignal: "SIGKILL" });
  } catch (err) {
    const e = err as { signal?: string; status?: number; message?: string };
    if (e?.signal === "SIGKILL" || e?.signal === "SIGTERM") {
      throw new Error(`harness CLI killed after ${timeoutMs}ms timeout`);
    }
    throw err;
  }
}

// --- Validation — runs the project's own checks ---

/**
 * Returns true when the configured validation command exits 0.
 * Override with HARNESS_VALIDATE_CMD (e.g. "npm test" or "npm run typecheck && npm test").
 */
function validateTask(task: Task): boolean {
  if (isBracknellDeliveryTask(task)) {
    const bracknellDir = getBracknellDir();
    const todayMs = startOfToday();
    const missing = BRACKNELL_REQUIRED_FILES.filter((fileName) => !fileChangedSince(join(bracknellDir, fileName), todayMs));
    const visualReportMissing = requiresVisualBracknellReport(task) && !fileChangedSince(join(bracknellDir, BRACKNELL_VISUAL_REPORT_FILE), todayMs);
    const emailDraftChanged = fileChangedSince(join(bracknellDir, "EMAIL_DRAFT.md"), todayMs);
    const manifestPath = join(bracknellDir, "OUTPUT_MANIFEST.md");
    const manifestText = existsSync(manifestPath) ? readFileSync(manifestPath, "utf-8") : "";
    const manifestMentionsEmail = /email_(send|draft)|sent|smtp|\.eml/i.test(manifestText);
    const changedToday = collectChangedFilesSince(bracknellDir, todayMs, 20);
    console.log(`[Ralph] Bracknell validation: ${changedToday.length} file(s) changed today in ${bracknellDir}.`);
    if (missing.length > 0) {
      console.warn(`[Ralph] Bracknell validation missing or stale: ${missing.join(", ")}.`);
      return false;
    }
    if (visualReportMissing) {
      console.warn(`[Ralph] Bracknell validation missing or stale: ${BRACKNELL_VISUAL_REPORT_FILE}.`);
      return false;
    }
    if (!emailDraftChanged && !manifestMentionsEmail) {
      console.warn("[Ralph] Bracknell validation needs EMAIL_DRAFT.md changed today or manifest evidence of email_send.");
      return false;
    }
    return true;
  }

  console.log(`[Ralph] Validating ${task.id} via: ${HARNESS_VALIDATE_CMD}`);
  try {
    execSync(HARNESS_VALIDATE_CMD, { stdio: "inherit" });
    return true;
  } catch {
    return false;
  }
}

// --- Git Helpers ---

function gitCommit(message: string, files: string[]): void {
  try {
    // Stage specific files only — NEVER git add -A
    for (const f of files) {
      execSync(`git add "${f}"`, { stdio: "pipe" });
    }
    // Always stage the plan file
    execSync('git add "IMPLEMENTATION_PLAN.md"', { stdio: "pipe" });

    // Safety check: verify staged file count
    const staged = execSync("git diff --cached --name-only", { stdio: "pipe" }).toString().trim();
    const fileCount = staged ? staged.split("\n").length : 0;
    if (fileCount > 20) {
      console.warn(`[Ralph] ⚠️ WARNING: ${fileCount} files staged — this seems too many for one task. Aborting commit.`);
      execSync("git reset HEAD", { stdio: "pipe" });
      return;
    }
    if (fileCount > 10) {
      console.warn(`[Ralph] ⚠️ Note: ${fileCount} files staged — more than usual for a single task.`);
    }

    execFileSync('git', ['commit', '-m', message], { stdio: 'pipe' });
  } catch {
    console.warn("[Ralph] Git commit skipped (no changes or git not configured).");
  }
}

// --- Graceful Shutdown ---

export function shouldStop(): boolean {
  if (existsSync(".forge-stop")) {
    console.log("[Ralph] 🛑 Stop signal detected (.forge-stop file). Shutting down gracefully.");
    return true;
  }
  if (process.env.FORGE_STOP === "1" || process.env.FORGE_STOP === "true") {
    console.log("[Ralph] 🛑 Stop signal detected (FORGE_STOP env). Shutting down gracefully.");
    return true;
  }
  return false;
}

// --- Checkpoint Persistence ---

interface LoopState {
  iteration: number;
  startedAt: string;
  lastTaskId: string;
  lastTaskTitle?: string;
  lastTaskStatus?: "pending" | "done" | "failed" | "running";
  lastTaskStartedAt?: string;
  lastTaskElapsedMs?: number;
  lastTaskTurns?: number;
  lastTaskFilesChanged?: number;
  totalDone: number;
  totalFailed: number;
  totalPending?: number;
}

function saveCheckpoint(state: LoopState): void {
  writeFileSync(".forge-state.json", JSON.stringify(state, null, 2), "utf-8");
}

function loadCheckpoint(): LoopState | null {
  if (!existsSync(".forge-state.json")) return null;
  try {
    return JSON.parse(readFileSync(".forge-state.json", "utf-8"));
  } catch {
    return null;
  }
}

// --- Iteration history ---

interface HistoryEntry {
  timestamp: string;
  iteration: number;
  taskId: string;
  taskTitle: string;
  status: "done" | "failed";
  elapsedMs: number;
  filesChanged: number;
  changedFiles: string[];
  model: string;
}

const HISTORY_PATH = ".forge-history.jsonl";

function appendHistoryEntry(entry: HistoryEntry): void {
  try {
    appendFileSync(HISTORY_PATH, JSON.stringify(entry) + "\n", "utf-8");
  } catch {
    // best-effort; never fail the loop because history disk write failed
  }
}

// --- Health Summary ---

function writeHealthSummary(tasks: Task[], startTime: number, reason: string): void {
  const elapsed = ((Date.now() - startTime) / 1000).toFixed(1);
  const done = tasks.filter((t) => t.status === "done").length;
  const failed = tasks.filter((t) => t.status === "failed").length;
  const pending = tasks.filter((t) => t.status === "pending").length;

  console.log();
  console.log("[Ralph] ═══════════════════════════════════");
  console.log("[Ralph] 📊 Health Summary");
  console.log(`[Ralph]   Done:    ${done}`);
  console.log(`[Ralph]   Failed:  ${failed}`);
  console.log(`[Ralph]   Pending: ${pending}`);
  console.log(`[Ralph]   Time:    ${elapsed}s`);
  console.log(`[Ralph]   Reason:  ${reason}`);
  console.log("[Ralph] ═══════════════════════════════════");

  // Write to forge-memory/decisions.md if it exists
  if (existsSync("forge-memory")) {
    const summary = `\n## Ralph Loop Run — ${new Date().toISOString()}\n- Done: ${done}, Failed: ${failed}, Pending: ${pending}\n- Time: ${elapsed}s\n- Exit reason: ${reason}\n`;
    const decisionsPath = join(".", "forge-memory", "decisions.md");
    if (existsSync(decisionsPath)) {
      appendFileSync(decisionsPath, summary, "utf-8");
    }
  }
}

// --- Ratchet Decision ---
//
// AutoResearch-style keep/revert gate for one autonomy iteration. A task is
// "ratcheted forward" (kept + committed) ONLY when a real check earned it:
// the implement step did not throw, validation passed, and — for code tasks —
// the work actually changed files. Anything short of that is reverted. This is
// the sequential sibling of src/agents/verifiedMerge's parallel gate: keep
// proven work, revert everything else, and record WHICH check earned the keep
// so the commit and logs carry honest provenance rather than a bare "done".
// Mirrors the harness honesty rule — no "done" without proof a check ran.

export type RatchetCode = "errored" | "validation-failed" | "no-file-changes" | "kept";

export interface RatchetInput {
  /** Did the implement step throw before producing verifiable work? */
  errored: boolean;
  /** Did the validation command pass? (Only meaningful when not errored.) */
  validated: boolean;
  /** Per-task success contract; "research" tasks may legitimately change 0 files. */
  kind?: TaskKind;
  /** Number of in-repo + external files the iteration changed. */
  changedFileCount: number;
  /** Human label of the check that gates the keep (e.g. the validate command). */
  validateLabel?: string;
}

export interface RatchetDecision {
  outcome: "keep" | "revert";
  code: RatchetCode;
  /** Plain-language, honest reason for the outcome. */
  reason: string;
  /** The concrete check that earned the keep — null on revert (nothing earned it). */
  earnedBy: string | null;
}

/**
 * Pure keep/revert verdict for one autonomy iteration. No I/O, no clock, no
 * globals — it decides purely from the facts the loop already gathered. Keep
 * iff the work neither errored nor failed validation and (for code tasks)
 * actually changed files; otherwise revert with an honest reason. On a keep,
 * `earnedBy` names the check that proved it.
 */
export function decideRatchet(input: RatchetInput): RatchetDecision {
  const { errored, validated, kind, changedFileCount } = input;
  const check = input.validateLabel?.trim() || "validation";
  if (errored) {
    return {
      outcome: "revert",
      code: "errored",
      reason: "implementation step threw before producing verifiable work",
      earnedBy: null,
    };
  }
  if (!validated) {
    return {
      outcome: "revert",
      code: "validation-failed",
      reason: `${check} failed — not keeping unproven work`,
      earnedBy: null,
    };
  }
  const requiresFileChanges = (kind ?? "code") !== "research";
  if (requiresFileChanges && changedFileCount === 0) {
    return {
      outcome: "revert",
      code: "no-file-changes",
      reason: `${check} passed but the task changed 0 files — no work to keep`,
      earnedBy: null,
    };
  }
  const evidence = requiresFileChanges
    ? `${check} passed with ${changedFileCount} file change(s)`
    : `${check} passed (research task — no file changes required)`;
  return { outcome: "keep", code: "kept", reason: evidence, earnedBy: evidence };
}

// --- Ralph Loop ---

/**
 * Optional dependency-injection hooks for tests. Production callers leave
 * these undefined and get the real implementations. The autonomy loop's
 * happy path is too slow + side-effecting (real harness CLI, real npm
 * typecheck) to exercise in jest, but the budget/halt control flow can
 * be covered by stubbing both.
 */
export interface RalphLoopHooks {
  implementTask?: (task: Task) => void;
  validateTask?: (task: Task) => boolean;
}

export function ralphLoop(planPath: string, maxIterations: number = 10, dryRun: boolean = false, hooks: RalphLoopHooks = {}): void {
  const doImplement = hooks.implementTask ?? implementTask;
  const doValidate = hooks.validateTask ?? validateTask;
  if (!existsSync(planPath)) {
    console.error(`[Ralph] Plan not found: ${planPath}`);
    console.error("[Ralph] Create an IMPLEMENTATION_PLAN.md with tasks like:");
    console.error("  - [ ] task-id \u2014 Task title");
    return;
  }

  if (dryRun) {
    console.log("[Ralph] DRY RUN \u2014 no model calls, no file edits, no git commits.");
  }

  const startTime = Date.now();
  let consecutiveFailures = 0;
  let totalFailures = 0;

  // Resume from checkpoint if available (skip in dry-run to keep state pristine)
  const checkpoint = dryRun ? null : loadCheckpoint();
  let iteration = checkpoint ? checkpoint.iteration : 0;
  if (checkpoint) {
    console.log(`[Ralph] Resuming from checkpoint — iteration ${checkpoint.iteration}, last task: ${checkpoint.lastTaskId}`);
  }
  const requestedIterations = parseInt(process.env.FORGE_REQUESTED_ITERATIONS ?? "", 10);
  const remainingIterationBudget = Math.max(0, maxIterations - iteration);
  const requestedBudgetText = Number.isFinite(requestedIterations) && requestedIterations > 0
    ? `${requestedIterations} requested task(s)`
    : `${remainingIterationBudget} task(s) available from current checkpoint`;
  console.log(`[Ralph] Run budget: ${requestedBudgetText}; checkpoint iteration ${iteration}; absolute stop iteration ${maxIterations}.`);

  while (iteration < maxIterations) {
    iteration++;

    // Graceful shutdown check
    if (shouldStop()) {
      const tasks = parsePlan(planPath);
      writeHealthSummary(tasks, startTime, "graceful shutdown requested");
      return;
    }

    // Wall-clock budget cap: HARNESS_TIME_BUDGET_MS hard-stops the loop
    // when total elapsed time exceeds the cap. Prevents a long-running
    // overnight autonomy session from burning paid backend tokens
    // unbounded. Disabled when env var is unset or 0.
    const timeBudgetMs = parseInt(process.env.HARNESS_TIME_BUDGET_MS ?? "0", 10);
    if (timeBudgetMs > 0 && Date.now() - startTime > timeBudgetMs) {
      const tasks = parsePlan(planPath);
      const elapsedSec = Math.round((Date.now() - startTime) / 1000);
      const budgetSec = Math.round(timeBudgetMs / 1000);
      console.warn(`[Ralph] 💰 Time budget exhausted: ${elapsedSec}s > ${budgetSec}s. Halting.`);
      writeHealthSummary(tasks, startTime, `time budget exhausted (${elapsedSec}s of ${budgetSec}s)`);
      return;
    }

    // Fresh read from disk on every iteration (key principle).
    const tasks = parsePlan(planPath);

    if (iteration === 1 || (checkpoint && iteration === checkpoint.iteration + 1)) {
      console.log(`[Ralph] Loaded ${tasks.length} tasks from ${planPath}`);
    }

    const pending = tasks.find((t) => t.status === "pending");
    if (!pending) {
      const done = tasks.filter((t) => t.status === "done").length;
      const failed = tasks.filter((t) => t.status === "failed").length;
      console.log(`[Ralph] 🏁 All tasks complete. ${done} done, ${failed} failed.`);
      writeHealthSummary(tasks, startTime, "all tasks complete");
      return;
    }

    console.log(`[Ralph] === Iteration ${iteration}/${maxIterations} ===`);
    console.log(`[Ralph] Picked task: ${pending.id} — "${pending.title}"`);
    if (dryRun) {
      console.log(`[Ralph] [dry-run] Would invoke harness CLI for ${pending.id}`);
      console.log(`[Ralph] [dry-run] Would validate via: ${process.env.HARNESS_VALIDATE_CMD ?? "npm run typecheck"}`);
      console.log(`[Ralph] [dry-run] Would commit changed files (none in dry-run)`);
      // Stop after one task in dry-run so the user sees a single full preview
      console.log("[Ralph] [dry-run] Stopping after one preview iteration.");
      return;
    }

    // Per-task progress: mark this task as running for live observers
    const taskStartedAt = Date.now();
    saveCheckpoint({
      iteration,
      startedAt: new Date(startTime).toISOString(),
      lastTaskId: pending.id,
      lastTaskTitle: pending.title,
      lastTaskStatus: "running",
      lastTaskStartedAt: new Date(taskStartedAt).toISOString(),
      totalDone: tasks.filter((t) => t.status === "done").length,
      totalFailed: tasks.filter((t) => t.status === "failed").length,
      totalPending: tasks.filter((t) => t.status === "pending").length,
    });

    // Snapshot the git HEAD before each iteration so a failed run can be
    // rolled back atomically. Disable by setting HARNESS_AUTONOMY_SNAPSHOT=0.
    // Stash includes untracked files so a half-applied edit doesn't leak
    // into the next iteration's beforeFiles set.
    const snapshotEnabled = process.env.HARNESS_AUTONOMY_SNAPSHOT !== "0";
    const preIterationHead = snapshotEnabled
      ? execSync("git rev-parse HEAD", { stdio: "pipe" }).toString().trim()
      : null;

    // Snapshot the working tree before implementation so we can stage
    // exactly the files this task touched (no `git add -A`).
    const beforeFiles = new Set(
      execSync("git status --porcelain", { stdio: "pipe" })
        .toString()
        .split("\n")
        .map((l) => l.slice(3).trim())
        .filter(Boolean),
    );

    // Implement
    let implementError: unknown = null;
    try {
      // External tasks touch paths outside the repo. Pre-write a runbook
      // so the loop has a tracked artifact regardless of whether the
      // model edits anything inside cwd. The model still runs normally
      // and is told (via the anchor) to update the runbook with results.
      if (pending.kind === "external") {
        ensureRunbook(pending);
      }
      doImplement(pending);
    } catch (err) {
      implementError = err;
      console.error(`[Ralph] implementTask threw for ${pending.id}:`, err instanceof Error ? err.message : err);
    }

    // Collect files changed during this iteration
    const afterFiles = execSync("git status --porcelain", { stdio: "pipe" })
      .toString()
      .split("\n")
      .map((l) => l.slice(3).trim())
      .filter(Boolean);
    const repoChangedFiles = afterFiles.filter((f) => !beforeFiles.has(f) && !f.startsWith(".forge-"));
    const externalChangedFiles = isBracknellDeliveryTask(pending)
      ? collectChangedFilesSince(getBracknellDir(), taskStartedAt).map((filePath) => `external:${filePath}`)
      : [];
    const changedFiles = [...repoChangedFiles, ...externalChangedFiles];

    // Validate (skip if implement crashed; treat as failure)
    const validated = implementError ? false : doValidate(pending);

    // AutoResearch-style ratchet gate: keep ONLY work a real check earned,
    // revert everything else, and record WHICH check earned the keep. The
    // no-op guard (a task that changed zero files is almost certainly a
    // failed run) lives inside decideRatchet, with "research" tasks exempt
    // since they are scored on validation alone.
    const ratchet = decideRatchet({
      errored: Boolean(implementError),
      validated,
      kind: pending.kind,
      changedFileCount: changedFiles.length,
      validateLabel: HARNESS_VALIDATE_CMD,
    });
    const passed = ratchet.outcome === "keep";
    if (ratchet.code === "no-file-changes") {
      console.warn(`[Ralph] ⚠️ ${pending.id}: ${ratchet.reason} — treating as failed.`);
      console.warn(`[Ralph]    Hint: if this task is research-only, add "  - kind: research" under it in the plan.`);
    }

    // Update status on disk
    const freshTasks = parsePlan(planPath);
    const target = freshTasks.find((t) => t.id === pending.id);
    if (target) {
      target.status = passed ? "done" : "failed";
      writePlan(planPath, freshTasks);
    }

    if (passed) {
      consecutiveFailures = 0;
      console.log(`[Ralph] ✅ Task ${pending.id} kept — ${ratchet.reason}. Committing ${changedFiles.length} file(s).`);
      if (changedFiles.length > 0) console.log(`[Ralph] Changed files: ${changedFiles.join(", ")}`);
      gitCommit(`chore(autonomy): ${pending.id} — ${pending.title}\n\nRatchet: kept — ${ratchet.earnedBy}`, changedFiles);
    } else {
      consecutiveFailures++;
      totalFailures++;
      console.log(`[Ralph] ❌ Task ${pending.id} reverted — ${ratchet.reason}.`);
      if (changedFiles.length > 0) console.log(`[Ralph] Changed files before restore: ${changedFiles.join(", ")}`);

      // Restore the working tree to the pre-iteration snapshot so the next
      // iteration starts from a clean state. Without this, half-applied
      // model edits and untracked files from the failed iteration would
      // bleed into the next iteration's beforeFiles diff.
      if (snapshotEnabled && preIterationHead) {
        try {
          // Drop any uncommitted edits and untracked files the model may
          // have created. Keep .forge-* (state, debug logs, history).
          execFileSync("git", ["reset", "--hard", preIterationHead], { stdio: "pipe" });
          execFileSync("git", ["clean", "-fd", "-e", ".forge-*"], { stdio: "pipe" });
          // Re-apply the failed marker to the plan because git reset wiped
          // the uncommitted plan edit. Without this, the next iteration
          // would pick the same task again and loop forever.
          const restoredTasks = parsePlan(planPath);
          const restoredTarget = restoredTasks.find((t) => t.id === pending.id);
          if (restoredTarget) {
            restoredTarget.status = "failed";
          } else {
            restoredTasks.push({ ...pending, status: "failed" });
          }
          writePlan(planPath, restoredTasks);
          console.log(`[Ralph] ↻ Snapshot restore: working tree reset to ${preIterationHead.slice(0, 8)}.`);
        } catch (err) {
          const msg = err instanceof Error ? err.message : String(err);
          console.warn(`[Ralph] ⚠️ Snapshot restore failed: ${msg}`);
        }
      }

      // Tier 3: Pause and warn after 3 consecutive failures
      if (consecutiveFailures >= 3) {
        console.warn("[Ralph] ⚠️ 3 consecutive failures — something may be wrong.");
        console.warn("[Ralph] Pausing for 10 seconds. Create .forge-stop to halt.");
        execSync('node -e "setTimeout(()=>{},10000)"', { stdio: "pipe" });
      }

      // Tier 4: Halt after 5 total failures
      if (totalFailures >= 5) {
        console.error("[Ralph] 🛑 5+ total failures — halting autonomous execution.");
        writeHealthSummary(freshTasks, startTime, "halted — too many failures");
        return;
      }
    }

    // Save checkpoint after each iteration
    const elapsedMs = Date.now() - taskStartedAt;
    saveCheckpoint({
      iteration,
      startedAt: new Date(startTime).toISOString(),
      lastTaskId: pending.id,
      lastTaskTitle: pending.title,
      lastTaskStatus: passed ? "done" : "failed",
      lastTaskStartedAt: new Date(taskStartedAt).toISOString(),
      lastTaskElapsedMs: elapsedMs,
      lastTaskFilesChanged: changedFiles.length,
      totalDone: freshTasks.filter((t) => t.status === "done").length,
      totalFailed: freshTasks.filter((t) => t.status === "failed").length,
      totalPending: freshTasks.filter((t) => t.status === "pending").length,
    });

    // Append an immutable history record so the UI / scripts can chart
    // throughput over time without scraping logs. JSONL keeps the format
    // append-only and trivially parseable.
    appendHistoryEntry({
      timestamp: new Date(taskStartedAt).toISOString(),
      iteration,
      taskId: pending.id,
      taskTitle: pending.title,
      status: passed ? "done" : "failed",
      elapsedMs,
      filesChanged: changedFiles.length,
      changedFiles: changedFiles.slice(0, 50),
      model: HARNESS_MODEL,
    });
  }

  const tasks = parsePlan(planPath);
  console.log(`[Ralph] ⚠️ Reached max iterations (${maxIterations}). Stopping.`);
  writeHealthSummary(tasks, startTime, `max iterations reached (${maxIterations})`);
}

// --- Entry Point ---

// Only run the loop when invoked as a script. Importing this module from
// tests must not start an autonomy run.
const isMain = require.main === module;
if (isMain) {
  const cliArgs = process.argv.slice(2);
  const dryRun = cliArgs.includes("--dry-run") || cliArgs.includes("-n");
  const maxIterations = parseInt(process.env.FORGE_MAX_ITERATIONS || "10", 10);
  const planFile = join(".", "IMPLEMENTATION_PLAN.md");
  ralphLoop(planFile, maxIterations, dryRun);
}
