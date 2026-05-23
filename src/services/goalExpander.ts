/**
 * Goal expander — meta-prompting for autonomous task decomposition.
 *
 * Takes a high-level user intent ("Build a wiki from D:\big.pdf",
 * "Research Acme's tech stack", "Set up a daily 9am check-in") and
 * expands it into an ordered list of plan-shaped tasks ready for
 * `cookbook/task-loop.ts` to consume.
 *
 * Design:
 *   - Deterministic heuristic decomposer (no model required) — works
 *     offline and in CI, mirrors the RAG fallback pattern.
 *   - Optional model refiner — when a chat client is provided, the
 *     heuristic skeleton is passed back through the model with a
 *     meta-prompt to refine titles, add anchors, and reorder.
 *   - Pure function over inputs: callers persist the result themselves
 *     (usually via `renderTasksAsPlanMarkdown` + appendFileSync).
 *
 * Intent shapes detected:
 *   - "ingest"   — process a file/folder into a structured artifact
 *                  (PDF → wiki, folder → index, etc). Mostly external/code.
 *   - "research" — investigate something and report. Mostly research kind.
 *   - "build"    — implement a feature or app. Code kind.
 *   - "schedule" — set up a recurring task. Code kind.
 *   - "generic"  — fallback: one external task with the raw intent.
 */

export type TaskKind = "code" | "research" | "external";

export interface PlanTask {
  id: string;
  title: string;
  kind?: TaskKind;
  anchors?: string[];
  target?: string;
}

export type IntentShape = "ingest" | "research" | "build" | "schedule" | "generic";

export interface ExpandGoalOptions {
  /** Already-existing task IDs to avoid collision when slugifying. */
  existingIds?: string[];
  /** Hard cap on task count (default 12). */
  maxTasks?: number;
}

export interface ExpansionResult {
  shape: IntentShape;
  tasks: PlanTask[];
  /** Human-readable rationale for the chosen decomposition. */
  rationale: string;
}

const INGEST_VERBS = ["ingest", "import", "load", "process", "split", "extract", "chunk", "summari", "wiki"];
const RESEARCH_VERBS = ["research", "investigate", "analyse", "analyze", "compare", "study", "audit", "survey", "review"];
const BUILD_VERBS = ["build", "create", "make", "implement", "add", "set up", "scaffold", "ship", "deploy"];
const SCHEDULE_VERBS = ["schedule", "every day", "every morning", "9am", "9 am", "daily", "nightly", "weekly", "remind"];

const PATH_PATTERN = /(?:^|\s|["'`])([A-Za-z]:[\\/][^\s"']+|\/[^\s"'/][^\s"']{2,})/g;
const URL_PATTERN = /\bhttps?:\/\/\S+/g;

export function detectIntent(intent: string): IntentShape {
  const lower = intent.toLowerCase();
  if (SCHEDULE_VERBS.some((v) => lower.includes(v))) return "schedule";
  if (INGEST_VERBS.some((v) => lower.includes(v))) return "ingest";
  if (RESEARCH_VERBS.some((v) => lower.includes(v))) return "research";
  if (BUILD_VERBS.some((v) => lower.includes(v))) return "build";
  return "generic";
}

/**
 * Lower-case, kebab-case, ASCII-only, hard-capped at 60 chars.
 * Suffixed with "-2", "-3" etc. when colliding with `taken`.
 */
export function slugify(input: string, taken: Set<string> = new Set()): string {
  const base = input
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 60) || "task";
  if (!taken.has(base)) {
    taken.add(base);
    return base;
  }
  let n = 2;
  while (taken.has(`${base}-${n}`)) n++;
  const out = `${base}-${n}`;
  taken.add(out);
  return out;
}

function extractPaths(intent: string): string[] {
  const matches: string[] = [];
  for (const m of intent.matchAll(PATH_PATTERN)) {
    if (m[1]) matches.push(m[1]);
  }
  return Array.from(new Set(matches));
}

function extractUrls(intent: string): string[] {
  const matches = intent.match(URL_PATTERN) ?? [];
  return Array.from(new Set(matches));
}

function pathIsExternalToRepo(p: string): boolean {
  return /^[A-Za-z]:[\\/]/.test(p) || p.startsWith("/");
}

/**
 * Heuristic decomposer — no model required. Emits a sensible skeleton
 * the user can run as-is or refine with the optional model pass.
 */
export function expandGoal(intent: string, options: ExpandGoalOptions = {}): ExpansionResult {
  const trimmed = intent.trim();
  if (!trimmed) {
    return { shape: "generic", tasks: [], rationale: "Empty intent." };
  }

  const shape = detectIntent(trimmed);
  const paths = extractPaths(trimmed);
  const urls = extractUrls(trimmed);
  const taken = new Set<string>(options.existingIds ?? []);
  const maxTasks = options.maxTasks ?? 12;

  const tasks: PlanTask[] = [];
  let rationale = "";

  switch (shape) {
    case "ingest": {
      const source = paths[0] ?? urls[0] ?? "the source material";
      const externalSource = paths.some(pathIsExternalToRepo) || urls.length > 0;
      tasks.push({
        id: slugify(`survey-${source}`, taken),
        title: `Survey ${source}: list contents, sizes, formats, and detected structure`,
        kind: externalSource ? "external" : "research",
        anchors: paths,
      });
      tasks.push({
        id: slugify(`outline-${source}`, taken),
        title: `Propose a chapter/section outline for ${source} and record it in the runbook`,
        kind: externalSource ? "external" : "research",
        anchors: paths,
      });
      tasks.push({
        id: slugify(`chunk-${source}`, taken),
        title: `Split ${source} into per-chapter artifacts under .harness/wiki/`,
        kind: "code",
      });
      tasks.push({
        id: slugify(`rag-${source}`, taken),
        title: `Build a RAG index over the chunked artifacts for later querying`,
        kind: "code",
      });
      tasks.push({
        id: slugify(`wiki-${source}`, taken),
        title: `Render a browsable wiki (index.html + per-chapter pages) into .harness/wiki/`,
        kind: "code",
      });
      tasks.push({
        id: slugify(`smoke-${source}`, taken),
        title: `Smoke-test the wiki: assert index links resolve and RAG returns ≥1 hit for a known phrase`,
        kind: "code",
      });
      rationale = `Detected ingest intent over ${paths.length} path(s) / ${urls.length} url(s). Default ingest pipeline: survey → outline → chunk → RAG → render → smoke.`;
      break;
    }

    case "research": {
      const subject = urls[0] ?? paths[0] ?? trimmed.replace(/^research\s+/i, "").slice(0, 80);
      tasks.push({
        id: slugify(`scope-${subject}`, taken),
        title: `Scope the research: define questions to answer, sources to consult, and acceptance criteria`,
        kind: "research",
      });
      tasks.push({
        id: slugify(`gather-${subject}`, taken),
        title: `Gather sources on ${subject} (web search, docs, repos) and record citations`,
        kind: "research",
      });
      tasks.push({
        id: slugify(`analyse-${subject}`, taken),
        title: `Analyse findings: extract claims, contradictions, and confidence levels`,
        kind: "research",
      });
      tasks.push({
        id: slugify(`report-${subject}`, taken),
        title: `Render a research report at .harness/research/${slugify(subject, new Set())}.html with sources, summary, and a one-paragraph answer`,
        kind: "code",
      });
      rationale = `Detected research intent. Pipeline: scope → gather → analyse → render.`;
      break;
    }

    case "build": {
      const what = trimmed.replace(/^(build|create|make|implement|add|set up|scaffold|ship|deploy)\s+/i, "").slice(0, 80);
      tasks.push({
        id: slugify(`design-${what}`, taken),
        title: `Design ${what}: write a short design note covering surface, contract, and one example`,
        kind: "code",
      });
      tasks.push({
        id: slugify(`scaffold-${what}`, taken),
        title: `Scaffold ${what} in src/ with empty exports and a placeholder test`,
        kind: "code",
      });
      tasks.push({
        id: slugify(`implement-${what}`, taken),
        title: `Implement ${what}: fill in the logic, keeping the test passing`,
        kind: "code",
      });
      tasks.push({
        id: slugify(`test-${what}`, taken),
        title: `Add real tests for ${what}: cover happy path, one edge case, one failure mode`,
        kind: "code",
      });
      tasks.push({
        id: slugify(`document-${what}`, taken),
        title: `Document ${what}: update README or the relevant doc with usage`,
        kind: "code",
      });
      rationale = `Detected build intent. Pipeline: design → scaffold → implement → test → document.`;
      break;
    }

    case "schedule": {
      const what = trimmed.replace(/^(schedule|set up)\s+/i, "").slice(0, 80);
      tasks.push({
        id: slugify(`design-trigger-${what}`, taken),
        title: `Design the recurring trigger for "${what}": choose interval, channel, and payload`,
        kind: "code",
      });
      tasks.push({
        id: slugify(`add-trigger-${what}`, taken),
        title: `Add the trigger entry to .harness/triggers/triggers.json and the supporting script under scripts/`,
        kind: "code",
      });
      tasks.push({
        id: slugify(`test-trigger-${what}`, taken),
        title: `Test the trigger fires once at the chosen interval and emits the expected message`,
        kind: "code",
      });
      rationale = `Detected schedule intent. Pipeline: design → add → test.`;
      break;
    }

    default: {
      tasks.push({
        id: slugify(trimmed.slice(0, 80), taken),
        title: trimmed,
        kind: "external",
      });
      rationale = `No recognised verb. Emitted a single external task so the autonomy loop produces a runbook for it.`;
    }
  }

  return { shape, tasks: tasks.slice(0, maxTasks), rationale };
}

/**
 * Renders a list of plan tasks as Markdown lines compatible with
 * `cookbook/task-loop.ts`'s parser. Always emits a trailing newline.
 *
 * Output format:
 *   - [ ] task-id — Task title
 *     - anchor: path/to/file
 *     - target: path/to/file
 *     - kind: research
 */
export function renderTasksAsPlanMarkdown(tasks: PlanTask[]): string {
  const lines: string[] = [];
  for (const task of tasks) {
    lines.push(`- [ ] ${task.id} — ${task.title}`);
    for (const anchor of task.anchors ?? []) {
      lines.push(`  - anchor: ${anchor}`);
    }
    if (task.target) {
      lines.push(`  - target: ${task.target}`);
    }
    if (task.kind && task.kind !== "code") {
      lines.push(`  - kind: ${task.kind}`);
    }
  }
  return lines.length ? lines.join("\n") + "\n" : "";
}
