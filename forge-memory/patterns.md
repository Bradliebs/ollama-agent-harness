# Forge Patterns

Reusable conventions for this project. Updated as the team learns what works.

## Stack Conventions

- TypeScript with strict mode enabled
- Node.js runtime
- `ollama` npm package (official Ollama JS library) for API communication
- Jest for testing with ts-jest transformer
- Async generators for streaming and the agent loop
- JSONL for session transcript storage

## Architecture Conventions (from Claude Code paper)

- **Minimal scaffolding, maximal operational harness** — The agent loop is a simple while-loop. Complexity lives in surrounding infrastructure (permissions, context, tools), not in decision scaffolding.
- **Deny-first safety** — Deny rules override allow rules. Unrecognized actions are denied or escalated.
- **Context as scarce resource** — Progressive management: budget reduction → snip → summarization. Cheaper strategies first.
- **Append-only state** — Session transcripts are append-only JSONL. Compaction appends summaries, never deletes.
- **Tool classification** — Read-only tools run in parallel. State-modifying tools are serialized.
- **Subagent isolation** — Subagents get isolated context. Only summary text returns to parent.
- **Composable extensibility** — Four mechanisms at graduated context costs: hooks (zero), skills (low), plugins (medium), MCP servers (high).

## File Structure

```
src/
  core/           # Agent loop (queryLoop), query pipeline
  tools/          # Tool definitions, dispatch, streaming executor
  permissions/    # Deny-first rule engine, permission modes
  context/        # Context assembly, compaction pipeline
  agents/         # Subagent delegation, isolation
  persistence/    # JSONL session storage, resume/fork
  extensibility/  # Skills, hooks, plugin loading
  types/          # Shared type definitions and interfaces
```

## Project-Specific Patterns

- Ollama API calls go through a single client abstraction layer
- All tool implementations conform to the `Tool` interface
- Permission rules are declarative (JSON/YAML config), not hardcoded
- Recovery mechanisms surface errors as tool results for the model to adapt
