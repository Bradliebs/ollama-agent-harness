---
name: second-brain
description: Build and maintain a Karpathy-style LLM-maintained personal wiki (a "Second Brain") as plain markdown the user owns. Use when the user wants to set up a second brain, capture/ingest a source into their notes, ask their knowledge base a question, file decisions, or keep a personal wiki organized. Triggers on ingest/query/lint requests against the vault.
domain: knowledge
confidence: high
source: "manual — Second Brain skill"
risk_level: low
required_tools:
  - file_read
  - file_write
  - file_edit
triggers:
  - "/second-brain"
  - "second brain"
  - "ingest into my notes"
  - "add to my wiki"
  - "file this"
  - "what do my notes say about"
  - "lint my vault"
  - "consolidate my notes"
---

<!-- 👋 Human? This file is instructions for the agent, not a guide for you.
     For the human walkthrough, see docs/SECOND-BRAIN-SETUP.md -->

# Second Brain

> This skill teaches you to build and maintain a **Second Brain**: an
> LLM-maintained personal wiki in plain markdown, following the pattern Andrej
> Karpathy described. You own the wiki and keep it organized. The user provides
> sources and asks questions. Knowledge compounds — every ingest touches a few
> pages, every good question becomes a new page.

## Core principle

Three layers, clear ownership:

- **raw/** — immutable inputs the user provides. You append, you never delete or
  rewrite. This is the audit trail.
- **the wiki** (`10-Notes/`, `20-Projects/`, `30-Areas/`, `40-Resources/`) —
  owned and maintained by you. You summarize, link, file, and bookkeep.
- **the schema** (`AGENTS.md`, `_meta/conventions.md`) — co-evolved with the
  user. Propose changes; don't impose them.

House rules, always:

- One idea per page.
- Cite sources in frontmatter (`sources:`) and inline where it matters.
- Flag uncertainty explicitly — never paper over a gap with a plausible guess.
- Never delete from `raw/`.
- Summarize before filing — raw text goes to `raw/`, distilled knowledge to the
  wiki.
- Every new page links to at least one existing page (no orphans).

## Precondition: the vault must be writable

The vault is usually a folder **outside** the harness project directory. The
file tools can only write outside the project when the folder is on the
allow-list.

Before any file operation, confirm the vault path is reachable:

1. Attempt a tiny round-trip: `file_write` a temp file in the vault, `file_read`
   it back, then delete it.
2. If the write is **denied**, stop and tell the user to add the vault path to
   `allowedExternalPaths` in `.harness/settings.json` and restart the harness:

   ```json
   { "allowedExternalPaths": ["<absolute path to the vault>"] }
   ```

3. If the vault is inside the project directory, no allow-list entry is needed.

Do not proceed with bootstrap or ingest until the round-trip succeeds.

## Operation: bootstrap (first-time setup)

When the user has no vault yet, build the structure:

```
<vault>/
  AGENTS.md          # the schema — read first, every session
  README.md          # human-facing overview
  index.md           # top-level map of the wiki
  log.md             # dated, greppable activity log
  raw/               # immutable sources
    00-Inbox/        # unfiled captures awaiting processing
    50-Archive/      # retired-but-kept material
  10-Notes/
    entities/        # people, orgs, tools, products
    concepts/        # ideas, definitions, principles
  20-Projects/       # active, goal-bound work
  30-Areas/          # ongoing responsibilities (no end date)
  40-Resources/      # reference material by topic
  _meta/
    conventions.md   # style guide
    MOCs/            # Maps of Content (curated index pages)
    templates/       # page templates per type
```

Then write `AGENTS.md` and `_meta/conventions.md` (see below). Draft each, take
the user's edits, then save. Never silently overwrite an existing vault — if
files already exist, ask before changing them.

### AGENTS.md must define

1. The three layers and who owns each.
2. Folder conventions and naming (kebab-case filenames, one subject per page).
3. Page types and required YAML frontmatter:
   `title`, `type`, `created`, `updated`, `tags`, `sources`, `status`.
4. The three operations below.
5. Log format (dated, one line per action, greppable).
6. The house rules above.

### _meta/conventions.md must define

- Naming and `[[wiki-link]]` rules (every new page links somewhere).
- Allowed values for `type` and `status`.
- Tone: terse, factual, source-cited; uncertainty marked.
- When to make an MOC vs. a normal note.

## Operation: ingest `<source>`

Turn a raw input into filed knowledge.

1. Save the verbatim source to `raw/` (or `raw/00-Inbox/` if it needs triage).
   Give it a dated, descriptive filename. Never edit it after saving.
2. Read it. Extract entities and concepts.
3. For each entity/concept: create a new page in `10-Notes/entities|concepts/`
   or update an existing one. Distill — don't copy. Add `sources:` pointing at
   the raw file.
4. Add `[[wiki-links]]` connecting new pages to existing ones.
5. Update `index.md` if a new top-level subject appeared.
6. Append a dated entry to `log.md`: what was ingested, which pages changed.
7. Report: the raw file, the pages created/updated, the index change, the log
   entry. Then stop for review before filing anything further.

## Operation: query `<question>`

Answer from the vault, and capture the answer if it's worth keeping.

1. Start from `index.md`, then drill into relevant notes (`file_read`, search).
2. Synthesize an answer. Attribute each claim to a page or source. Mark
   anything the vault doesn't cover as a gap — do not invent.
3. If the answer is durable and reusable, propose filing it as a new page
   (often a `concept` note or an MOC) and link it in. Ask before creating.
4. If a source contradicts something already filed, surface the conflict
   explicitly rather than silently overwriting.

## Operation: lint

Audit the vault's health. Read-only unless the user approves fixes.

Check for and report:

- **Contradictions** — pages that disagree.
- **Orphans** — pages with no inbound or outbound links.
- **Stale** — pages whose `updated` is old relative to their `type`.
- **Missing** — pages lacking required frontmatter fields.
- **Inbox backlog** — unfiled items sitting in `raw/00-Inbox/`.

Report findings grouped by category, with the fix you'd propose for each. Apply
fixes only after the user approves. Append a dated lint summary to `log.md`.

## Optional: scheduled consolidation

If the user wants nightly upkeep, set up an automation that runs `lint`, files
anything in `00-Inbox/`, appends a dated summary to `log.md`, and leaves a short
note of anything needing the user's decision. Show the exact steps before
enabling it.

## Honesty notes

- This harness is local-first. There is no built-in Microsoft 365, Teams, or
  email connector — the Second Brain works on local files only. Don't claim
  integrations that don't exist.
- The separate "personal wiki" blueprint (`buildPersonalWiki`) is a read-only
  HTML *renderer* of semantic-memory entries — a viewer, not this maintained
  markdown vault. Don't conflate them.
</content>
