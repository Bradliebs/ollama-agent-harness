# Release Notes — v0.2.0

**Date:** 2026-05-01
**Commits:** 14 | **Files changed:** 39 | **Lines:** +5,049 / -274
**Tests:** 365 passing across 48 suites

## Highlights

### Mycelial Context Router

A fungal/mycelium-inspired adaptive graph system that learns which combinations of tools, skills, and memories work best for different queries. Routes are reinforced when successful and decay when unused. The network grows with every conversation.

- Graph store with nodes (tools, skills, memories, agents, strategies) and weighted edges
- Spread activation from query through the graph, compact route selection
- Reinforcement based on tool success rates and response quality
- Semantic relevance via Ollama embeddings with keyword fallback
- New **Mycelium** tab (mushroom icon) showing nodes, edges, and episodes
- GET/DELETE `/api/mycelium` for graph inspection and reset

### Agent Identity

Give your agent a name, avatar, and personality. Switch between saved profiles instantly.

- 6 personality presets: professional, friendly, concise, mentor, creative, pirate
- 12 emoji avatars with visual picker
- Multi-profile save/load/delete with export/import as JSON
- Name and avatar shown in topbar, chat bubbles, and session history
- Personality-aware welcome screen greetings
- Model-specific profile suggestions when selecting a model

### Full Autonomy Mode

One-click button that sets `dontAsk` permission mode and enables all disabled tools. All 9 gated capabilities auto-grant for 8 hours at chat start. Kill switch (Ctrl+Shift+K) remains the emergency stop.

### Capability System

12 capability surfaces classified by posture with grant lifecycle, audit trail, and shell command allowlist.

- **9 gated:** arbitrary-shell, background-autonomous-jobs, self-modifying-code, multi-agent-swarm, desktop-control, browser-profile-access, auto-install-third-party-skills, email-sending, calendar-editing
- **3 blocked:** password-manager-access, live-broker-trading, internet-skill-marketplace
- **0 design-only:** all former design-only capabilities now have connectors
- Grant lifecycle: create, revoke, auto-expire with `grant.expired` audit events
- Shell command allowlist presets with path traversal rejection

### New Tools

| Tool | What it does | Default state |
|------|-------------|---------------|
| `desktop_screenshot` | Capture screen via platform-native commands | Disabled |
| `browser_bookmarks` | Read Chrome/Edge bookmarks (read-only) | Disabled |
| `install_skill` | Install skills from GitHub/Gist/GitLab URLs | Disabled |
| `email_draft` | Create .eml draft files for manual review | Disabled |
| `calendar_read` | Parse local .ics files for upcoming events | Enabled |

### Automation System

Full CRUD for scheduled jobs with an automation scheduler.

- Create, edit, toggle, delete jobs from the Runs tab or API
- AutomationScheduler with 60s heartbeat, idle gate, kill-switch guard
- Execute-due endpoint and run history with output viewer
- Scheduler settings in Settings panel (enable/disable, idle threshold)

### Beginner-Friendly Setup

- `start.bat` (Windows) and `start.sh` (Mac/Linux) — double-click to install and launch
- Automatic Node.js, npm, and Ollama detection with clear fix instructions
- Auto-opens browser after server starts
- Guided first-chat tutorial in the welcome screen (5 interactive steps)
- Complete beginner guide in START-HERE.md

### Speech Input

- Auto-send when mic button is toggled off (voice → send in one flow)
- Hourglass indicator on send button during the 300ms delay

## Other Changes

- Runner unit tests (13 tests for preset matching, injection attempts, path traversal)
- Grant endpoint error handling (try/catch on POST/DELETE)
- `findExpiredGrants` with auto-revoke preventing duplicate audit events
- Negative-case server tests for grant API
- File-discovery preset regex tightened to reject `..` path traversal
- README.md rewritten as clear user guide with quick start and reference
- START-HERE.md rewritten as complete beginner onboarding guide
- E2E personality test verifying name and personality in system prompt
- SSE test race condition fix (consume response body before assertions)
- Tool-success reinforcement in mycelium (tracks success/failure per tool call)
- Session metadata includes agent name and avatar

## Breaking Changes

None. All changes are additive.

## Upgrade Notes

- Version bump: 0.1.14 → 0.2.0
- New settings fields: `agentName`, `agentAvatar`, `agentPersonality`, `agentProfiles`, `automationScheduler`
- New storage paths: `.harness/mycelium/`, `.harness/desktop/`, `.harness/email/drafts/`
- 13 UI tabs (added Mycelium)
- All existing settings and data are preserved
