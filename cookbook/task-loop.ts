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

import { readFileSync, writeFileSync, appendFileSync, existsSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { execSync } from "node:child_process";

// --- Types ---

type TaskStatus = "pending" | "done" | "failed";

interface Task {
  id: string;
  title: string;
  status: TaskStatus;
}

// --- Plan Parser ---

/**
 * Parses IMPLEMENTATION_PLAN.md into a list of tasks.
 * Expected format — one task per line:
 *   - [ ] task-id — Task title
 *   - [x] task-id — Task title        (done)
 *   - [!] task-id — Task title        (failed)
 */
function parsePlan(filePath: string): Task[] {
  const content = readFileSync(filePath, "utf-8");
  const tasks: Task[] = [];

  for (const rawLine of content.split(/\r?\n/)) {
    const line = rawLine.replace(/\s+$/, "");
    const match = line.match(/^- \[(.)\] (\S+)\s*[—\-]\s*(.+)$/);
    if (!match) continue;

    const [, marker, id, title] = match;
    let status: TaskStatus = "pending";
    if (marker === "x") status = "done";
    else if (marker === "!") status = "failed";

    tasks.push({ id, title: title.trim(), status });
  }

  return tasks;
}

/** Writes the task list back to IMPLEMENTATION_PLAN.md. */
function writePlan(filePath: string, tasks: Task[]): void {
  const lines = ["# Implementation Plan", ""];
  for (const task of tasks) {
    const marker = task.status === "done" ? "x" : task.status === "failed" ? "!" : " ";
    lines.push(`- [${marker}] ${task.id} — ${task.title}`);
  }
  writeFileSync(filePath, lines.join("\n") + "\n", "utf-8");
}

// --- Implementation — wired to the local Ollama Agent Harness CLI ---

const HARNESS_MODEL = process.env.HARNESS_MODEL ?? "gemma4:e4b";
const HARNESS_HOST = process.env.HARNESS_HOST ?? "http://localhost:11434";
const HARNESS_PERMISSION_MODE = process.env.HARNESS_PERMISSION_MODE ?? "acceptEdits";
const HARNESS_MAX_TURNS = process.env.HARNESS_MAX_TURNS ?? "30";
const HARNESS_VALIDATE_CMD = process.env.HARNESS_VALIDATE_CMD ?? "npm run typecheck";

/**
 * Build the prompt sent to the harness for a single task. The harness has
 * built-in file-edit tools and will work the task to completion under the
 * configured permission mode.
 */
function buildTaskPrompt(task: Task): string {
  return [
    `You are an autonomous coding agent inside the Ollama Agent Harness repository.`,
    `Your job is to ACTUALLY EDIT FILES using the available tools — not to chat.`,
    ``,
    `You MUST use these tools to do the work:`,
    `  - file_read   — read a file before editing it`,
    `  - file_write  — create or overwrite a file`,
    `  - file_edit   — make a targeted edit to an existing file`,
    `  - list_files  — list directory contents`,
    `  - grep        — search for patterns in files`,
    `  - bash        — run shell commands (tests, builds)`,
    ``,
    `If you finish without invoking any tool, you have FAILED the task.`,
    `Conversational replies are not acceptable. Make code changes.`,
    ``,
    `Task id:    ${task.id}`,
    `Task title: ${task.title}`,
    ``,
    `Workflow:`,
    `  1. Use list_files / grep / file_read to inspect the relevant code.`,
    `  2. Use file_write or file_edit to make the change.`,
    `  3. Optionally run \`npm run typecheck\` or \`npm test\` via bash.`,
    `  4. Briefly summarize what you changed and stop.`,
    ``,
    `Constraints:`,
    `  - Make the smallest change that satisfies the task.`,
    `  - Do not modify IMPLEMENTATION_PLAN.md, .forge-state.json, or files under .copilot-tracking/.`,
  ].join("\n");
}

/**
 * Called once per task. Shells out to the harness CLI in headless mode.
 * The CLI handles model calls, tool dispatch, file edits, and permissions.
 */
function implementTask(task: Task): void {
  const prompt = buildTaskPrompt(task).replace(/"/g, '\\"');
  const cmd = [
    "npx ts-node src/cli/index.ts",
    `--model "${HARNESS_MODEL}"`,
    `--host "${HARNESS_HOST}"`,
    `--mode ${HARNESS_PERMISSION_MODE}`,
    `--max-turns ${HARNESS_MAX_TURNS}`,
    `-p "${prompt}"`,
  ].join(" ");

  console.log(`[Ralph] >>> ${cmd}`);
  execSync(cmd, { stdio: "inherit" });
}

// --- Validation — runs the project's own checks ---

/**
 * Returns true when the configured validation command exits 0.
 * Override with HARNESS_VALIDATE_CMD (e.g. "npm test" or "npm run typecheck && npm test").
 */
function validateTask(task: Task): boolean {
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

    execSync(`git commit -m "${message}"`, { stdio: "pipe" });
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

// --- Ralph Loop ---

function ralphLoop(planPath: string, maxIterations: number = 10, dryRun: boolean = false): void {
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

  while (iteration < maxIterations) {
    iteration++;

    // Graceful shutdown check
    if (shouldStop()) {
      const tasks = parsePlan(planPath);
      writeHealthSummary(tasks, startTime, "graceful shutdown requested");
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
      implementTask(pending);
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
    const changedFiles = afterFiles.filter((f) => !beforeFiles.has(f) && !f.startsWith(".forge-state"));

    // Validate (skip if implement crashed; treat as failure)
    let passed = implementError ? false : validateTask(pending);

    // No-op guard: a task that changed zero files is almost certainly a
    // failed autonomous run (model refused, hallucinated completion, etc.).
    // Do not mark such a task done.
    if (passed && changedFiles.length === 0) {
      console.warn(`[Ralph] ⚠️ ${pending.id} validated clean but produced 0 file changes — treating as failed.`);
      passed = false;
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
      console.log(`[Ralph] ✅ Task ${pending.id} passed — committing ${changedFiles.length} file(s).`);
      gitCommit(`chore(autonomy): ${pending.id} — ${pending.title}`, changedFiles);
    } else {
      consecutiveFailures++;
      totalFailures++;
      console.log(`[Ralph] ❌ Task ${pending.id} failed — marked as failed, continuing.`);

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
