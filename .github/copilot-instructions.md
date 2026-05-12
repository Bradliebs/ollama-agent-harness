# Copilot Instructions

Guidelines for AI assistants working in this project.

## Before You Write Code

- State your assumptions explicitly. If a request is ambiguous, ask — don't pick silently.
- If a simpler approach exists, say so before implementing the complex one.
- If something is unclear, stop and name what's confusing.

## Writing Code

- Minimum code that solves the problem. No features that weren't asked for.
- No abstractions for single-use code. No "flexibility" that wasn't requested.
- Match existing style and conventions in the file you're editing.
- Touch only what the request requires — don't improve adjacent code.

## After Writing Code

- Every changed line should trace directly to the request.
- If you made something unused with your changes, remove it.
- Don't remove pre-existing dead code unless asked.

## When in Doubt

Ask one focused question rather than making an assumption and writing 200 lines.
