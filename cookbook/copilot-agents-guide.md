# 🧩 Custom Agents — Create Specialized GitHub Copilot Profiles

> **What this does:** Walks you through creating custom agent profiles
> (`.agent.md` files) for GitHub Copilot. Each agent gets its own
> personality, tools, and expertise.
>
> **When to use this:** When you want specialized AI assistants for
> different tasks — a test writer, a code reviewer, a documentation
> expert, a security auditor — each with tailored instructions.
>
> **Prerequisites:**
> - GitHub Copilot subscription (Pro, Pro+, Business, or Enterprise)
> - VS Code with GitHub Copilot extension, or access to GitHub.com

---

## Step 1 — Create the Agents Directory

In your repository, create a `.github/agents/` directory:

```bash
mkdir -p .github/agents
```

This is where all your custom agent profiles live.

## Step 2 — Create an Agent Profile

Create a file with the pattern `{name}.agent.md`. For example, `test-writer.agent.md`:

```bash
touch .github/agents/test-writer.agent.md
```

> **Naming rules:** Filenames can only contain: `.`, `-`, `_`, `a-z`, `A-Z`, `0-9`

## Step 3 — Configure the YAML Frontmatter

Open the file and add YAML frontmatter at the top:

```yaml
---
name: test-writer
description: Writes comprehensive tests with high coverage and clear descriptions
tools: ["read", "edit", "search", "shell"]
model: claude-sonnet-4
---
```

**Properties explained:**
| Property | Required | What it does |
|----------|----------|--------------|
| `name` | No | Display name (defaults to filename) |
| `description` | **Yes** | What the agent does — Copilot uses this to decide when to suggest it |
| `tools` | No | Which tools the agent can use (omit = all tools available) |
| `model` | No | AI model preference (VS Code/JetBrains only) |
| `mcp-servers` | No | MCP server configurations for extended capabilities |

## Step 4 — Write the System Prompt

Below the frontmatter, write instructions in Markdown:

```markdown
You are a testing specialist focused on improving code quality through
comprehensive testing. Your responsibilities:

- Analyze existing tests and identify coverage gaps
- Write unit tests, integration tests, and end-to-end tests
- Follow the project's existing test patterns and conventions
- Use the test framework already configured in the project
- Focus only on test files — avoid modifying production code
- Always include clear test descriptions

When writing tests:
1. Read the source file to understand the API
2. Check for existing tests to match the style
3. Write tests that cover happy paths, edge cases, and error cases
4. Run tests to verify they pass before finishing
```

## Step 5 — Commit and Use

```bash
git add .github/agents/test-writer.agent.md
git commit -m "feat: add test-writer custom agent"
git push
```

In VS Code: Open Copilot Chat → click the agents dropdown → select **test-writer**.

On GitHub.com: Go to the agents tab → select **test-writer** from the dropdown.

---

## More Examples

### Code Reviewer Agent
```yaml
---
name: code-reviewer
description: Reviews code for bugs, security issues, and best practices
tools: ["read", "search"]
---
You are a code review specialist. Review changes for:
- Logic errors and potential bugs
- Security vulnerabilities (injection, auth bypass, data exposure)
- Performance issues (N+1 queries, unnecessary allocations)
- Best practices for the language and framework in use

Only flag real issues. Never comment on style or formatting.
```

### Documentation Agent
```yaml
---
name: docs-writer
description: Writes and updates project documentation
tools: ["read", "edit", "search"]
---
You are a documentation specialist. Write clear, concise docs that:
- Explain the "why" not just the "what"
- Include code examples for every concept
- Use simple language (no jargon without definitions)
- Follow the project's existing documentation style
```

### Security Auditor Agent (with MCP)
```yaml
---
name: security-auditor
description: Audits code for security vulnerabilities and compliance issues
tools: ["read", "search", "security-scanner"]
mcp-servers:
  security-scanner:
    command: npx
    args: ["-y", "@example/security-mcp"]
---
You are a security specialist. Audit code for OWASP Top 10 vulnerabilities,
check dependency versions for known CVEs, and verify auth patterns.
```

---

## Tips

- **Start simple** — create one agent, use it, then iterate. You can always add more tools and instructions later.
- **The `description` matters most** — Copilot reads it to decide when to suggest the agent. Be specific about what tasks the agent handles.
- **Omit `tools` to give full access** — only restrict tools when you want the agent to be read-only or limited.
- **Custom agents work everywhere** — VS Code, JetBrains, Eclipse, Xcode, GitHub.com, and the Copilot CLI.
- **Combine with CopilotForge skills** — your custom agents can reference skills in `.github/skills/` for even more specialized behavior.

## Learn More

- [Create custom agents](https://docs.github.com/en/copilot/how-tos/use-copilot-agents/cloud-agent/create-custom-agents)
- [Test custom agents](https://docs.github.com/en/copilot/how-tos/use-copilot-agents/cloud-agent/test-custom-agents)
- [Add skills to agents](https://docs.github.com/en/copilot/how-tos/use-copilot-agents/cloud-agent/add-skills)
- [Custom agents configuration reference](https://docs.github.com/en/copilot/reference/custom-agents-configuration)
- [awesome-copilot agent examples](https://github.com/github/awesome-copilot/tree/main/agents)
