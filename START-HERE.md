# Start Here — Complete Beginner Guide

## What is this?

This is a local AI assistant that runs entirely on your computer. No cloud subscriptions, no API keys, no data leaving your machine. You chat with it in your browser, and it can read files, write code, search the web, and learn from your preferences.

## Setup (10 minutes, one time only)

### Step 1: Install Node.js

Node.js is the engine that runs this app. You only need to install it once.

1. Go to **<https://nodejs.org/>**
2. Click the big green **LTS** button (the one that says "Recommended for Most Users")
3. Run the downloaded installer
4. Click **Next** through every screen (all defaults are fine)
5. When it finishes, you're done with this step

**How to check it worked:** Open a terminal (see "How to open a terminal" below), type `node --version`, and press Enter. You should see a version number like `v20.x.x`.

### Step 2: Install Ollama

Ollama runs the AI models on your computer.

1. Go to **<https://ollama.com/>**
2. Click **Download** and install it
3. After installing, open a terminal and type:

   ```
   ollama pull llama3.2
   ```

4. Wait for the download to finish (it's about 2 GB)

**How to check it worked:** Type `ollama list` in the terminal. You should see `llama3.2` in the list.

### Step 3: Start the Harness

**Option A — Double-click (easiest):**

1. Find the file called `start.bat` in this folder
2. Double-click it
3. A black window will appear showing the setup progress
4. When it says "Starting Ollama Agent Harness", open your browser and go to **<http://127.0.0.1:4000>**

**Option B — Terminal:**

1. Open a terminal in this folder
2. Type these commands one at a time:

   ```
   npm install
   npm run ui
   ```

3. Open the URL shown in the terminal (usually **<http://127.0.0.1:3000>**)

### Step 4: Start chatting

1. In the browser, look at the **top bar** — pick a model from the dropdown (select `llama3.2`)
2. Type a message in the text box at the bottom
3. Press Enter or click the arrow button

That's it. You're using a local AI assistant.

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

| Icon | Tab | What it does |
|------|-----|-------------|
| 💬 | **Chats** | Your conversation history |
| 📁 | **Files** | Browse project files |
| ⚡ | **Skills** | Reusable AI capabilities |
| 🧠 | **Memory** | What the AI remembers |
| 🏛 | **Palace** | Semantic memory browser |
| 🔮 | **Discover** | Learned patterns |
| 📈 | **Learning** | Performance trends |
| 📦 | **Snaps** | Backup/restore |
| 🔎 | **RAG** | Search your files |
| 🛠 | **Tools** | Available tools and permissions |
| 📜 | **Runs** | Session history and automation |
| ⚙ | **Flows** | Automated workflows |
| 🍄 | **Mycelium** | Adaptive routing network |

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

## Common issues

### "Node.js was not found"

Install Node.js from <https://nodejs.org/> (click the green LTS button) and try again.

### "Ollama was not found"

Install Ollama from <https://ollama.com/> and pull a model with `ollama pull llama3.2`.

### "No models available"

Make sure Ollama is running. Open a terminal and type `ollama serve`. Then refresh the browser.

### The browser shows a blank page

Check the terminal window — it should show a URL like `http://127.0.0.1:3000`. Go to that exact URL.

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
