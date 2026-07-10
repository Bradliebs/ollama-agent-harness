---
title: Build a Second Brain with the Ollama Agent Harness
description: A prompt-driven setup guide. Paste each prompt into the harness chat and let the agent build and maintain a Karpathy-style LLM-maintained personal wiki for you.
author: Bradliebs
ms.date: 2026-06-05
---

# Build a Second Brain with the Ollama Agent Harness

## How to use this guide

This document is a series of prompts. You don't build anything yourself — the
agent does. For each step, paste the prompt into your harness chat, watch what
it produces, approve or adjust, then move to the next step.

By the end, the harness will own and maintain a Second Brain: a plain-markdown
personal wiki that grows denser every time you feed it a source or ask it a
good question.

> **Placeholders.** Prompts contain a few values in `<angle brackets>` — the
> agent's name, your vault path, and so on. Replace them before pasting, or
> tell the agent the values up front and let it substitute.

> **One bit of plumbing first.** The vault lives in a folder you choose, which
> is usually *outside* the harness project directory. The harness only writes
> outside its own project when that folder is on the allow-list. Do
> [Step 0b](#step-0b--allow-the-vault-folder-one-time-setup) before the agent
> tries to create files, or the first write will be denied.

## 1. What you're building

A **Second Brain** is a personal knowledge system that captures, organizes,
synthesizes, and retrieves what you've learned, decided, or want to remember —
without you having to remember it yourself.

The version here is a specific kind: an **LLM-maintained personal wiki**, based
on the pattern Andrej Karpathy described publicly. Three principles separate it
from a regular note-taking app:

1. **Three layers, clear ownership.** Raw sources are immutable inputs you
   provide. The wiki is owned and maintained by the agent. The schema is
   co-evolved between you and the agent.
2. **The agent is the librarian.** You provide sources and ask questions. The
   agent summarizes, cross-references, files, and bookkeeps. Keeping the wiki
   organized is the agent's job, not yours.
3. **Compounding knowledge.** Every ingest touches a handful of pages. Every
   good question becomes a new page. The wiki gets denser, not just bigger.

Why it's worth doing:

- **Your knowledge stops leaking.** Conversations, articles, and decisions
  become durable, linked pages the agent can recall instantly.
- **Context becomes free.** Every new question starts with the answers to the
  last hundred already on file.
- **Cross-reference becomes automatic.** When a new source contradicts
  something you filed months ago, the agent can flag it.
- **You own it.** The vault is plain markdown in a folder you control. It opens
  in Obsidian, VS Code, Notepad — anything. No lock-in.

## 2. What the harness brings to it

This guide leans on capabilities the harness already has:

- **File tools** — the agent reads, writes, edits, and searches files in the
  vault (`file_read`, `file_write`, `file_edit`).
- **Skills** — reusable workflows under `.harness/skills/`. The
  [`research`](../.github/skills/research/SKILL.md) and
  [`planner`](../.github/skills/planner/SKILL.md) skills pair well with a Second
  Brain. Invoke one explicitly with `Use the skill: <name> with input: ...`.
- **Memory** — semantic memory plus the mycelial context router, so the agent
  carries context between turns.
- **Automation** — schedulers/triggers can run a nightly consolidation pass
  while you're away.
- **Identity** — `.harness/identity/SOUL.md` (the agent's voice and values) and
  `.harness/identity/USER.md` (long-term notes about you).

> **Honest scope.** This harness is local-first. Unlike some hosted assistants,
> it has no built-in Microsoft 365, Teams, or email integration out of the box.
> The Second Brain here works entirely on your local files. If you later add
> connectors, the same vault and the same operations still apply.

## 3. The setup — hand it to the agent

Each step has a prompt to paste. After each one, the agent reports what it did
and waits. Approve, then move to the next prompt.

> **Tip.** Open this document side-by-side with the harness. You can tell the
> agent up front: "I'm going to paste a series of setup prompts. Acknowledge
> each one, do the work, then wait for the next."

### Step 0 — Brief the agent

Set the scene so the agent understands the project before the first command.

```text
I'm setting up a Second Brain — an LLM-maintained personal wiki using the
Karpathy pattern. I want you to build and configure it for me. You own the
wiki and keep it organized; I provide sources and ask questions.

I'll paste a series of setup prompts. For each one:
  1. Confirm what you're about to do.
  2. Do it.
  3. Report back briefly and wait for the next prompt.

My vault location will be: <C:\Users\<you>\OneDrive\Documents\SecondBrain>
Your name is: <Blue>
Ready?
```

### Step 0b — Allow the vault folder (one-time setup)

Because the vault is outside the harness project directory, add it to the
allow-list so the file tools can write there. Open `.harness/settings.json` in
the project root and add your vault path to `allowedExternalPaths`:

```json
{
  "allowedExternalPaths": [
    "C:\\Users\\<you>\\OneDrive\\Documents\\SecondBrain"
  ]
}
```

Save, then restart the harness so the setting loads. (If the vault lives
*inside* the project directory, you can skip this step.) You can confirm with:

```text
Try to write a file called .second-brain-check.txt in <vault path> containing
the word "ok", then read it back and delete it. Tell me whether the write,
read, and delete all succeeded.
```

If that round-trips cleanly, the allow-list is correct and you can continue.

### Step 1 — Build the vault structure

```text
Create my Second Brain vault at <vault path> with this structure:

  AGENTS.md, README.md, index.md, log.md
  raw/      00-Inbox/      50-Archive/
  10-Notes/entities/   10-Notes/concepts/
  20-Projects/   30-Areas/   40-Resources/
  _meta/conventions.md   _meta/MOCs/   _meta/templates/

For now just make the folders and empty placeholder files for AGENTS.md,
README.md, index.md, log.md, and _meta/conventions.md. We'll fill them in the
next prompts. Show me the tree when you're done.
```

### Step 2 — Write AGENTS.md (the schema)

`AGENTS.md` is the most important file in the vault. It tells any agent that
opens the folder how the vault is organized. It is read first on every session.

```text
Write AGENTS.md at the vault root following Karpathy's LLM-maintained wiki
pattern. Include sections for:

  1. Three layers (raw / wiki / schema) and who owns each.
  2. Folder conventions and naming rules.
  3. Page types and required YAML frontmatter:
       title, type, created, updated, tags, sources, status
  4. Operations:
       - ingest: raw -> summary + entity/concept updates + index update + log entry
       - query:  read index -> drill -> synthesize -> file good answers
       - lint:   contradictions / orphans / stale / missing
  5. Log format (greppable, dated entries).
  6. House rules: one idea per page, cite sources, flag uncertainty,
     never delete from raw/, summarize before filing.

Make it readable. Show me a draft, take my edits, then save.
```

### Step 3 — Write _meta/conventions.md (the style guide)

```text
Write _meta/conventions.md covering:

  - Page naming: kebab-case filenames; one concept or entity per page.
  - Linking: use [[wiki-links]] between pages; every new page links to at
    least one existing page so nothing is orphaned.
  - Frontmatter defaults and allowed values for `type` and `status`.
  - Tone: terse, factual, source-cited. Mark anything uncertain explicitly.
  - When to make a Map of Content (MOC) in _meta/MOCs/ vs. a normal note.

Draft it, take my edits, then save.
```

### Step 4 — Teach the three operations

This is where the wiki stops being folders and starts being a system. Have the
agent confirm it understands each operation as a repeatable routine.

```text
Restate the three operations from AGENTS.md back to me as concrete routines you
will run on request:

  - When I say "ingest <source>": where the raw copy goes, which pages you
    create or update, how you update index.md, and what you append to log.md.
  - When I ask a question: how you search the vault, synthesize an answer, and
    decide whether the answer is worth filing as a new page.
  - When I say "lint": what you check for (contradictions, orphans, stale
    pages, missing frontmatter) and how you report findings.

Keep each to a few lines. Don't change any files — just confirm the routines.
```

### Step 5 — First ingest (prove it works)

Pick something small and real — an article, a meeting note, a decision.

```text
Ingest this source into the vault, following the ingest routine exactly:

<paste an article, notes, or a link — or point me at a file in the vault's raw/ folder>

Show me: the raw file you saved, the entity/concept pages you created or
updated, the index.md change, and the log.md entry. Then stop and let me
review before filing anything else.
```

### Step 6 (optional) — Give the agent a voice

A Second Brain pairs well with a consistent identity. The harness stores this
in `.harness/identity/SOUL.md` (the agent's voice and values) and `USER.md`
(long-term notes about you).

```text
Draft a SOUL.md for yourself as my Second Brain librarian: terse, source-honest,
willing to push back when a new source contradicts the wiki, never deletes from
raw/. Show me the draft. When I approve it, save it to
.harness/identity/SOUL.md. Then start a short USER.md with what you've learned
about how I work so far.
```

### Step 7 (optional) — Schedule a nightly consolidation

Once the vault has content, let the agent maintain it on a schedule.

```text
Set up a nightly automation that runs the lint routine over the vault, files
anything sitting in 00-Inbox/, appends a dated summary to log.md, and leaves me
a short note of anything that needs my decision. Show me the schedule and the
exact steps it will run before you enable it.
```

## Where things live (recap)

| Thing | Location |
|---|---|
| The vault (your knowledge) | `<vault path>` — plain markdown you own |
| Schema (read first, every session) | `<vault path>/AGENTS.md` |
| Style guide | `<vault path>/_meta/conventions.md` |
| Raw, immutable sources | `<vault path>/raw/` |
| The activity log | `<vault path>/log.md` |
| Allow-list for the vault folder | `.harness/settings.json` → `allowedExternalPaths` |
| Agent voice / your profile | `.harness/identity/SOUL.md`, `.harness/identity/USER.md` |
| Reusable workflows | `.harness/skills/<name>/SKILL.md` |

## Related

- [Personal memory wiki blueprint](APEX-FEATURES.md) — a separate, read-only
  static renderer that turns existing semantic-memory entries into a browsable
  HTML wiki. Complementary to the maintained markdown vault built above.
- [Skills](SKILLS.md) — how the harness loads filesystem-based skills.
</content>
</invoke>
