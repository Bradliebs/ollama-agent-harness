---
name: home-iq
description: Passively get to know the user over time — distill durable facts about who they are, what they work on, and how they like to be helped from conversation history into USER.md and memory. The home-user analog of Microsoft Work IQ's implicit-memory layer. Use when the user asks you to learn about them, update what you know, get to know them, or remember what they've told you across sessions.
domain: personalization
confidence: high
source: "manual — Home IQ skill (Work IQ analog for a home user)"
risk_level: low
required_tools:
  - recall
  - remember
  - semantic_recall
  - file_read
  - file_write
  - file_edit
triggers:
  - "/home-iq"
  - "learn about me"
  - "get to know me"
  - "what do you know about me"
  - "update what you know about me"
  - "remember what I've told you"
  - "build my profile"
---

<!-- 👋 Human? This file is instructions for the agent, not a guide for you. -->

# Home IQ

> This skill teaches you to **get to know the user over time** — the home-user
> equivalent of Microsoft Work IQ's *implicit memory*. Work IQ infers durable
> insights about a person from their activity across an enterprise tenant. You
> do the same thing for one person on their own computer: quietly distill the
> durable, high-signal facts about who they are and how they like to be helped,
> and persist them so the relationship compounds across sessions.

## Core principle

You already have explicit memory (the `remember` tool) and identity files
(`USER.md`, `SOUL.md`). What this skill adds is the **implicit** pass: instead
of waiting to be told "remember X", you actively review the conversation,
extract what is durably true about the user, and write it down — carefully.

Two homes for what you learn:

- **`.harness/identity/USER.md`** — long-term, human-readable notes about the
  user: who they are, what they care about, recurring projects, tools they use,
  people and places that come up, how they prefer you to work. Edit this with
  the file tools. The user owns it and can read or change it anytime.
- **memory** (`remember` tool) — discrete, dated facts and patterns
  (`note` / `pattern` / `decision`). Use this for specific learnings rather than
  the standing profile.

## What counts as a durable fact

Record only things that will still be true and useful next week:

- **Identity & context** — their name, role, what they build, their environment
  (OS, stack, tools), recurring projects.
- **Preferences** — how they like answers (length, tone, autonomy), formats they
  favour, things they want you to avoid.
- **Recurring people, places, projects** — names that come up repeatedly and
  matter to the work.
- **Working patterns** — habits you've observed ("ships to `dev` then
  fast-forwards `master`", "prefers a skill over a doc").

Do **not** record:

- One-off chatter, transient task state, or anything tied to a single message.
- Guesses dressed up as facts. If you're unsure, either don't record it or
  record it explicitly flagged as tentative.
- Sensitive personal data (health, finances, credentials, anything private)
  unless the user has clearly asked you to remember it.

## The learn pass

When triggered (or when you've clearly learned something new and durable):

1. **Recall first.** Run `recall` (category `all`) and `semantic_recall` on the
   topic before writing anything. Read the current `.harness/identity/USER.md`
   with `file_read`. You are updating an existing picture, not starting fresh.
2. **Distil.** From the recent conversation, extract the durable facts using the
   rules above. Aim for a handful of high-signal items, not a transcript.
3. **Deduplicate.** Skip anything already captured. If a new fact *refines* an
   existing one, update it in place rather than appending a contradiction —
   the `remember` tool will warn you when an entry conflicts with an existing
   one; treat that warning as a prompt to reconcile, not to stack duplicates.
4. **Write.** Standing profile facts go to `USER.md` (via `file_edit` /
   `file_write`). Discrete dated learnings go through `remember` with the right
   category. Keep `USER.md` tidy and organised under clear headings.
5. **Report.** Tell the user, in one short list, exactly what you added or
   changed and where. They should never be surprised by what you've stored.

## Honesty & ownership rules

- Everything you record is plain text the user can read and edit. Never store
  anything you wouldn't show them.
- Never overwrite `USER.md` wholesale — read, then make surgical edits.
- Flag uncertainty instead of inventing a clean fact.
- When in doubt about whether something is too personal to store, ask first.
- This is **local only**. There is no tenant, no cross-app activity feed, no
  Graph. You learn from the conversation in front of you and the memory you've
  already saved — nothing else. Don't imply otherwise.

## Relationship to other capabilities

- `remember` / `recall` — the explicit memory primitives this skill orchestrates.
- `semantic_recall` — meaning-based lookup over saved memory (ccmem); use it to
  find related prior learnings before writing.
- `second-brain` skill — a *curated knowledge vault* the user feeds
  deliberately. Home IQ is different: it learns about *the user*, passively,
  from ordinary conversation. They complement each other.
- The self-learning heartbeat already compacts and de-duplicates memory in the
  background; this skill is the on-demand counterpart that adds *new* insight
  about the user rather than tidying what's there.
