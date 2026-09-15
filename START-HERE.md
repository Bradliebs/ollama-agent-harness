---
title: Start Here
description: Windows-first setup with explicit local or cloud model selection and a confirmed first task
ms.date: 2026-09-15
---

## What is this?

This assistant runs in your browser with a server on your computer. Choose a local Ollama model for local inference, or configure a cloud provider. Cloud models send conversation data and permitted tool results to that provider and may incur charges. Web search, email, remote Ollama hosts, and other network tools also communicate outside your computer.

Windows is the primary installation target. Linux and macOS retain the portable core; native packaging and platform validation are separate release gates.

Normal harness use does not require administrator privileges or `sudo`. Run it
as your ordinary user. Installing system-wide prerequisites or maintaining a
separate Linux service may require a deliberate administrator action.

## Setup

Download and account setup time depends on your connection and chosen model. No model is downloaded by opening the setup panel.

### Step 1: Install Node.js

Node.js is the engine that runs this app. You only need to install it once.

1. Go to **<https://nodejs.org/>**
2. Choose **Node.js 24 LTS**. The minimum supported version is **22.13.0**.
3. Run the downloaded installer
4. Click **Next** through every screen (all defaults are fine)
5. When it finishes, you're done with this step

**How to check it worked:** Open a terminal (see "How to open a terminal" below), type `node --version`, and press Enter. Check that it meets the minimum above, for example `v24.x.x`.

### Step 2: Choose local or cloud inference

For local inference, install Ollama and download a model you choose. The example below is a starting point, not a measured recommendation for every tool task or computer.

1. Go to **<https://ollama.com/>**
2. Click **Download** and install it
3. After installing, open a terminal and type:

   ```
   ollama pull llama3.2
   ```

4. Wait for the download to finish (it's about 2 GB)

**How to check it worked:** Type `ollama list` in the terminal. You should see `llama3.2` in the list.

For a supported cloud provider, you can skip the local model download, start the harness, and configure that provider's credentials in Settings before selecting its model. A configured key is not proof that the provider works. Ollama-hosted cloud models still need a reachable Ollama service and send data remotely.

If your GPU is busy with other work, select an Ollama cloud model instead of
loading a local model. Sign in on the same Ollama installation the harness uses;
see [Ollama Cloud Models](docs/MODEL-PRESETS.md#adding-an-ollama-cloud-model).
Cloud selection moves that model's inference off your GPU, not every optional
vision, audio or helper workload. Do not restart a shared Ollama service while
another session depends on it.

### Step 3: Start the Harness

**Option A — Double-click (easiest):**

1. Find the file called `start.bat` in this folder
2. Double-click it
3. A black window will appear showing the setup progress
4. Use the address printed after the server starts, normally **<http://127.0.0.1:4300>**. If the port is occupied, the server selects another one without stopping the process using it.

The launcher asks for a workspace for your files and memory. Keep it outside the installation folder. A source checkout rebuilds on launch; a complete prebuilt release does not need a source build.

**Option B — Terminal:**

1. Open a terminal in this folder
2. Type these commands one at a time:

   ```
   npm ci
   npm run ui
   ```

3. Open the URL shown in the terminal (usually **<http://127.0.0.1:3000>**). Always use the exact address the terminal prints — if a port is busy, it picks the next free one.

### Step 4: Confirm your first task

1. Select the model you configured in the top bar.
2. Open first-run setup and check Chat status. "Configured, not verified" means configuration checks passed, not that inference or tools have been tested. Optional audio, vision, and OCR are not text-chat requirements.
3. Choose **Quick Test** and review the model, provider, and workspace confirmation. Cancel sends no task. Cloud execution may incur charges.
4. Inspect the response and tool evidence. "Response received" is not independent verification of task correctness. An incomplete or failed request remains "not verified"; fix the reported issue and retry.

For ordinary chat, type in the message box and send. Use Stop to interrupt work. Review permission requests before allowing file changes, commands, or external actions.

### Optional background mode on Windows

Use [start-background.bat](start-background.bat) to keep the server running after
the launch window closes. Repeating it does not start a second managed server for
the same installation. The browser opens when the server is ready; its chosen URL
and startup errors are also recorded in `.harness/background.log`.

Stop active work in the UI before running [stop-server.bat](stop-server.bat).
It stops the server through its owning supervisor, not by trusting a saved PID.
An old PID file or abandoned ownership marker requires manual reconciliation;
follow [Background Lifecycle](docs/MODERNIZATION-STATUS.md#background-lifecycle)
before removing either file. Stop the server before upgrading or uninstalling.

## How to open a terminal

**Windows:**
- Press `Win + R`, type `cmd`, press Enter
- OR: Open the folder where this file is, click the address bar at the top, type `cmd`, press Enter

**Mac:**
- Press `Cmd + Space`, type `Terminal`, press Enter
- OR: Open Finder → Applications → Utilities → Terminal

## Your first conversation ideas

Not sure what to ask? Try these:

- "List the files in this project"
- "What's the weather in London?"
- "Help me write a Python script that counts words in a file"
- "Search the web for the latest news about AI"
- "Create a skill for code review"

## Understanding the interface

### Left sidebar (tabs)

The sidebar has **5 primary tabs** plus a **⋯ More** button for everything else.

**Primary:**

| Icon | Tab | What it does |
|------|-----|-------------|
| 💬 | **Chats** | Your conversation history |
| 📁 | **Files** | Browse project files |
| ⚡ | **Abilities** | Reusable AI capabilities |
| 🧠 | **Memory** | What the AI remembers |
| ⚙ | **Automations** | Automated multi-step workflows |

**Under ⋯ More** (grouped — hover an item for a one-line description):

- *Build & use:* Agents, Squads, Triggers, Tasks, Identity
- *Search & knowledge:* Search Files, Memory Bank, Discoveries, Code Intel
- *History & diagnostics:* Runs, Events, Activity Log, Learning, Health
- *Admin & backup:* Tools, Backups, Generated Files
- *Advanced:* Autonomy, AI Router, Commitments

If you want to know "what is the agent actually doing right now?" — open **⋯ More → 🛡 Activity Log** for a chronological list of every tool call.

### What is "Jarvis"?

Jarvis is not a separate app — it's the same harness with its **assistant features turned on**: an ambient background loop that produces a short **daily brief** (recent activity, things to look at), optional voice in/out, and chat channels like Telegram. When you launch with `start.bat` / `./start.sh`, these run by default (the "assistant profile"), and you'll see "Jarvis live" and "Jarvis voice controls" panels on the welcome screen. It's all optional — ignore those panels until you want a proactive assistant, or start a plain server with `HARNESS_PROFILE=` (empty) to keep them off.

### Right panel (Settings)

Click the ⚙ button in the top-right to open Settings. Here you can:

- Change the AI model
- Give your agent a **name** and **personality** (under "Agent Identity")
- Set the safety mode
- Configure media tools (image analysis, audio transcription)

## Give your agent a personality

1. Open **Settings** → **Agent Identity**
2. Type a name (like "Sage" or "Atlas")
3. Pick an emoji avatar
4. Choose a personality preset:
   - **Professional** — formal and structured
   - **Friendly** — warm and encouraging
   - **Concise** — minimal words, code-first
   - **Mentor** — teaches as it works
   - **Creative** — explores alternatives
   - **Pirate** — arr, gets the job done with flair

5. Click **💾 Save profile** to save it for later

## Safety

The harness has multiple safety layers:

| Feature | What it does |
|---------|-------------|
| **Permission mode** | Controls which tools need your approval |
| **Kill switch** | Ctrl+Shift+K instantly blocks all tool calls |
| **Capability grants** | High-risk actions need explicit approval |
| **Tool toggles** | Disable any tool individually |

For maximum autonomy, click **⚡ Full Autonomy** in Settings. This unlocks everything but keeps the kill switch as your emergency stop.

## Connecting email, calendars & other services

You can let the agent read and send email, look at your calendar, and plug in to other services. There are three levels — start at the top, it's the easiest.

### Email (Gmail & Outlook) — works today

The agent can **send email** and **read your inbox** for both Gmail and Outlook right away. No developer setup needed.

The one catch: you can't use your normal password. You need an **App Password** — a special 16-character password just for this app. This is normal and how Google and Microsoft want apps to log in.

1. **Get an App Password:**
   - **Gmail:** Google Account → Security → turn on **2-Step Verification** → then **App passwords** → create one → copy the 16 characters.
   - **Outlook:** Microsoft account → Security → **Advanced security options** → turn on two-step → **App passwords** → create one → copy it.
2. **Put it in the app:** open **Settings → Remote API Keys & Services** (the SMTP section) and fill in three boxes:

   | Box | Gmail | Outlook |
   |-----|-------|---------|
   | SMTP host | `smtp.gmail.com` | `smtp-mail.outlook.com` |
   | User | your full email address | your full email address |
   | Password | the **App Password** | the **App Password** |

That's it. Reading your inbox turns on automatically using the same login. Now you can say *"check my inbox"* or *"draft an email to…"*. Sending always asks you to approve first.

### Calendars

- **Simple (read-only, today):** the morning briefing can read a calendar **`.ics` file**. Export your calendar to an `.ics` file and the agent can list your upcoming events. It can read events, not create them.
- **Full calendar (create/edit events):** use an MCP server (next section) such as `google-calendar` or `ms-365`.

### The Connectors panel

Open **Settings → 🔌 Connectors** to see every service as a card. Each card tells you its honest state:

- **"Email live · OAuth planned"** — the email part works now (set up SMTP above).
- **"Connected"** — the live integration is running.
- **"Design stage"** — the full version is planned; use an MCP server for it now.

### Adding more services (MCP servers)

Anything not covered above — full Gmail, Outlook calendar, Spotify, Jira, your own API — is added as an **MCP server**: a small helper program that plugs in extra tools. Three ways, easiest first:

1. **Paste a command.** In the MCP panel, click **Manual setup**. Take an MCP server's install command from its README (e.g. `npx -y @softeria/ms-365-mcp-server`) and split it: the first word (`npx`) goes in **command**, the rest goes in **args**. Give it a short **server id**, add any keys it needs under **env**, then **Save**.
2. **Let the agent handle it.** In the same panel, **Find one** or **Create one** drafts a chat message asking the agent to locate or build a server for your need.
3. **Build your own.** Ask in chat: *"use the mcp-builder skill to build an MCP server for &lt;your thing&gt;"*.

After saving, click **Start**, then **Discover tools** — the new tools become available to the agent.

> **One safety step (on purpose):** the first time you **Start** an MCP server, the app asks for an **arbitrary-shell** grant. Starting a server runs a real program on your computer, so the harness will not do it silently — you allow it once in the capability settings. The kill switch (Ctrl+Shift+K) blocks all MCP servers instantly if you ever need it.

The gentlest one to try first is **`ms-365`** (Outlook mail *and* calendar) — it logs in by having you type a code on a webpage, with no key files to set up.

## Common issues

### "Node.js was not found"

Install Node.js from <https://nodejs.org/> (click the green LTS button) and try again.

### "Ollama was not found"

Install Ollama from <https://ollama.com/> and pull a model with `ollama pull llama3.2`.

### "No models available"

Make sure Ollama is running. Open a terminal and type `ollama serve`. Then refresh the browser.

### The browser shows a blank page

Check the terminal window — it should show a URL like `http://127.0.0.1:4300` (double-click `start.bat`) or `http://127.0.0.1:3000` (`npm run ui`). Go to whichever exact URL the terminal prints.

### How do I stop the server?

Press `Ctrl+C` in the terminal window, or close the terminal.

## Next steps

- Try different models: `ollama pull gemma2`, `ollama pull mistral`
- Install a vision model for image analysis: `ollama pull llava`
- Check [docs/MODEL-PRESETS.md](docs/MODEL-PRESETS.md) for recommended models
- Read the [README](README.md) for the full feature reference
- Explore the **Skills** tab — create custom AI capabilities
- Build a **RAG** index over your project files for semantic search

## New in v0.3.0

### Create documents

Ask Oracle to create CSV, Excel, Word, or PDF files. Just say:
- "Create an Excel spreadsheet with recipe costs"
- "Make a PDF business plan"

### Send emails

Configure SMTP in Settings → API Keys, then say:
- "Send an email to me@gmail.com with the project summary"
- Use `/schedule every 24h Send me a daily task digest` for recurring emails

### Telegram bot

Talk to Oracle from your phone:
1. Open Telegram → @BotFather → `/newbot` → copy the token
2. Settings → Telegram Bot → paste token → Connect
3. Send your bot a message, photo, or voice note

### Quick task management

- Type `/task Create a report` in chat to add tasks
- Type `/schedule every 6h Check hotel prices` for recurring jobs
- Use the task form in Mission Control → Autonomy Builder

### Background server

Use `start-background.bat` to keep the server running after closing the terminal.
Use `stop-server.bat` to stop it later.
