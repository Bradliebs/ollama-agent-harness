# 🏗️ Copilot Studio — Build Enterprise Agents from VS Code

> **What this does:** Walks you through building and managing Copilot Studio agents
> entirely from VS Code. Clone agents from the cloud, edit YAML locally, sync back.
>
> **When to use this:** When you want to build conversational or autonomous agents
> on Microsoft's enterprise platform with full version control.
>
> **Prerequisites:**
> - VS Code installed
> - [Copilot Studio extension](https://marketplace.visualstudio.com/items?itemName=microsoft-IsvExpTools.microsoft-copilot-studio) installed
> - Power Platform environment with Copilot Studio access
> - A Microsoft work or school account

---

## Step 1 — Install the Extension

1. Open VS Code
2. Go to Extensions (Ctrl+Shift+X)
3. Search for "Microsoft Copilot Studio"
4. Click **Install**

The extension adds agent-authoring capabilities directly in VS Code with YAML IntelliSense.

## Step 2 — Clone an Agent from Copilot Studio

1. Open the Command Palette (Ctrl+Shift+P)
2. Type "Copilot Studio: Clone Agent"
3. Sign in with your Power Platform account when prompted
4. Select the environment containing your agent
5. Choose the agent to clone

The agent's YAML definition downloads to your workspace. You'll see files like:
```
my-agent/
├── agent.yaml          ← Main agent definition
├── topics/             ← Conversation flows
│   ├── greeting.yaml
│   └── fallback.yaml
├── tools/              ← External tool definitions
├── knowledge/          ← Knowledge sources
└── triggers/           ← What activates the agent
```

## Step 3 — Edit Agent Components Locally

Edit any YAML file. The extension provides:
- **Syntax highlighting** for agent YAML
- **IntelliSense** — auto-complete for properties and values
- **Validation** — red squiggles for invalid configurations

### Example: Adding a new topic
Create a file in `topics/` with this structure:
```yaml
kind: Topic
name: order-status
description: Handles customer order status inquiries
trigger:
  kind: Intent
  description: User asks about their order status
actions:
  - kind: Message
    text: "I can help you check your order status. What's your order number?"
```

## Step 4 — Apply Changes to Copilot Studio

1. Open the Command Palette (Ctrl+Shift+P)
2. Type "Copilot Studio: Apply Changes"
3. Review the diff showing what will change
4. Confirm to push changes to your cloud environment

## Step 5 — Test Your Agent

1. Go to [Copilot Studio](https://copilotstudio.microsoft.com)
2. Open your agent
3. Click "Test" to try a conversation
4. Verify your changes work as expected

## Step 6 — Version Control with Git

Since agents are now local YAML files, you can:
```bash
git add .
git commit -m "feat: add order-status topic"
git push origin main
```

Use pull requests for team review of agent changes.

---

## Tips

- **Start by cloning an existing agent** rather than creating from scratch — it's easier to learn the YAML format by example.
- **Use GitHub Copilot or Claude Code** while editing YAML — they understand the Copilot Studio format and can suggest topics, tools, and triggers.
- **The extension syncs both ways** — you can clone (cloud → local) and apply (local → cloud).

## Learn More

- [Copilot Studio VS Code extension overview](https://learn.microsoft.com/microsoft-copilot-studio/visual-studio-code-extension-overview)
- [Edit agent components locally](https://learn.microsoft.com/microsoft-copilot-studio/visual-studio-code-extension-edit-agent-components)
- [Synchronize changes](https://learn.microsoft.com/microsoft-copilot-studio/visual-studio-code-extension-synchronization)
- [GitHub: microsoft/vscode-copilotstudio](https://github.com/microsoft/vscode-copilotstudio)
