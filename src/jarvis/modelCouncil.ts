// Model Council — parallel Ollama dispatch with arbitration.
//
// Three modes:
//
//   * vote     — N models answer the same prompt; pick the most-agreed answer
//                (longest-common-substring or majority-token vote).
//   * debate   — N models answer; an arbiter model reads all answers and picks one,
//                explaining the choice.
//   * arbiter  — N models answer; a stronger arbiter synthesizes a new answer.
//
// The point: with local Ollama you can run several small models in parallel
// for free. Quality on a 7B–14B local stack lifts substantially when three
// models vote vs. one model answering alone.
//
// Implementation is transport-agnostic: callers pass in an `invoke` function
// of shape `(model, prompt) => Promise<string>` so this module stays
// dependency-free and trivially testable. Wire it to the existing
// `OllamaClient` or `OpenAIClient` at the call site.

export type CouncilMode = 'vote' | 'debate' | 'arbiter';

export interface CouncilMember {
  model: string;
  /** Optional weight (1.0 default). Higher weight breaks ties first. */
  weight?: number;
}

export interface CouncilOptions {
  members: CouncilMember[];
  mode: CouncilMode;
  /** For debate / arbiter modes. */
  arbiter?: string;
  /** Per-member timeout. */
  perMemberTimeoutMs?: number;
}

export interface CouncilAnswer {
  model: string;
  text: string;
  latencyMs: number;
  error?: string;
}

export interface CouncilResult {
  mode: CouncilMode;
  answers: CouncilAnswer[];
  chosen: CouncilAnswer;
  rationale: string;
  arbiterText?: string;
}

export type Invoke = (model: string, prompt: string) => Promise<string>;

const DEFAULT_TIMEOUT = 60_000;

export async function runCouncil(prompt: string, options: CouncilOptions, invoke: Invoke): Promise<CouncilResult> {
  if (options.members.length === 0) throw new Error('Model council requires at least one member.');
  const timeout = options.perMemberTimeoutMs ?? DEFAULT_TIMEOUT;

  const answers = await Promise.all(options.members.map(async (member): Promise<CouncilAnswer> => {
    const start = Date.now();
    try {
      const text = await withTimeout(invoke(member.model, prompt), timeout, member.model);
      return { model: member.model, text, latencyMs: Date.now() - start };
    } catch (err) {
      return { model: member.model, text: '', latencyMs: Date.now() - start, error: (err as Error).message };
    }
  }));

  const usable = answers.filter((a) => !a.error && a.text.trim().length > 0);
  if (usable.length === 0) {
    return { mode: options.mode, answers, chosen: answers[0], rationale: 'No member returned a usable answer.' };
  }

  if (options.mode === 'vote') {
    const chosen = pickByVote(usable, options.members);
    return {
      mode: 'vote',
      answers,
      chosen,
      rationale: `vote: ${usable.length} members responded; selected ${chosen.model} by majority-token agreement`,
    };
  }

  if (!options.arbiter) {
    throw new Error(`Council mode "${options.mode}" requires an arbiter model.`);
  }

  const arbiterPrompt = buildArbiterPrompt(prompt, usable, options.mode);
  const arbiterText = await withTimeout(invoke(options.arbiter, arbiterPrompt), timeout, options.arbiter);

  if (options.mode === 'debate') {
    const idx = parseDebateChoice(arbiterText, usable.length);
    const chosen = idx !== undefined ? usable[idx] : usable[0];
    return {
      mode: 'debate',
      answers,
      chosen,
      arbiterText,
      rationale: idx !== undefined ? `debate: arbiter ${options.arbiter} selected member ${idx + 1} (${chosen.model})` : `debate: arbiter response unparseable, fell back to first member`,
    };
  }

  // arbiter — synthesize a new answer
  return {
    mode: 'arbiter',
    answers,
    chosen: { model: options.arbiter, text: arbiterText, latencyMs: 0 },
    arbiterText,
    rationale: `arbiter: ${options.arbiter} synthesized a new answer from ${usable.length} member responses`,
  };
}

function pickByVote(answers: CouncilAnswer[], members: CouncilMember[]): CouncilAnswer {
  // Token-overlap voting: for each pair, count shared informative tokens.
  // The answer with the highest summed overlap with the others wins.
  const tokens = answers.map((a) => tokenize(a.text));
  const scores = answers.map((_, i) => {
    let total = 0;
    for (let j = 0; j < answers.length; j++) {
      if (i === j) continue;
      total += overlap(tokens[i], tokens[j]);
    }
    const member = members.find((m) => m.model === answers[i].model);
    return { idx: i, score: total * (member?.weight ?? 1) };
  });
  scores.sort((a, b) => b.score - a.score);
  return answers[scores[0].idx];
}

function tokenize(text: string): Set<string> {
  return new Set(
    text
      .toLowerCase()
      .replace(/[^a-z0-9\s]/g, ' ')
      .split(/\s+/)
      .filter((t) => t.length > 3),
  );
}

function overlap(a: Set<string>, b: Set<string>): number {
  let n = 0;
  for (const t of a) if (b.has(t)) n++;
  return n;
}

function buildArbiterPrompt(originalPrompt: string, answers: CouncilAnswer[], mode: CouncilMode): string {
  const lines: string[] = [];
  lines.push(`You are an arbiter for a model council. The original prompt was:`);
  lines.push('');
  lines.push(originalPrompt);
  lines.push('');
  lines.push(`The following ${answers.length} member models answered:`);
  answers.forEach((a, i) => {
    lines.push('');
    lines.push(`### Member ${i + 1} — ${a.model}`);
    lines.push(a.text);
  });
  lines.push('');
  if (mode === 'debate') {
    lines.push(`Pick the single best answer. Reply with ONLY a JSON object: {"choice": <1-based index>, "reason": "<one sentence>"}`);
  } else {
    lines.push(`Synthesize the best possible final answer combining the strengths of the member responses. Be concise. Do not mention the council.`);
  }
  return lines.join('\n');
}

function parseDebateChoice(arbiterText: string, count: number): number | undefined {
  const match = arbiterText.match(/"choice"\s*:\s*(\d+)/);
  if (!match) return undefined;
  const choice = parseInt(match[1], 10);
  if (Number.isNaN(choice) || choice < 1 || choice > count) return undefined;
  return choice - 1;
}

function withTimeout<T>(promise: Promise<T>, ms: number, label: string): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`Council member ${label} timed out after ${ms}ms`)), ms);
    promise.then(
      (v) => { clearTimeout(timer); resolve(v); },
      (e) => { clearTimeout(timer); reject(e); },
    );
  });
}
