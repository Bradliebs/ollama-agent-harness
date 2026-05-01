# Start Here

## What is Ollama Agent Harness?

A local AI assistant that runs on your machine using [Ollama](https://ollama.com/) models. It provides a browser UI where you chat with a model that can read/write files, run shell commands, search the web, analyze images, and more — all governed by a permission system you control.

## First time setup

1. **Install Ollama** from <https://ollama.com/> and pull a model:

   ```powershell
   ollama pull llama3.2
   ```

2. **Install dependencies** in this project:

   ```powershell
   npm install
   ```

3. **Start the browser UI**:

   ```powershell
   npm run ui
   ```

4. **Open the URL** printed in the terminal (usually `http://127.0.0.1:3000`).

5. **Pick a model** from the dropdown in the Settings panel on the right side. If you pulled `llama3.2`, select it there.

6. **Start chatting** in the main panel. Type a message and press Enter.

## What you can do

### Chat with tools

The model can call tools during a conversation: read project files, write code, run commands, search the web. You control what it can do through the permission mode (Settings panel).

### Browse your project

The **Files** tab in the left sidebar shows your project tree. The model can read any file you point it to.

### Use skills

Skills are structured prompts that teach the model specific tasks. Check the **Skills** tab for installed skills, or create new ones from chat.

### Search your files

The **RAG** tab lets you build a local vector index over selected files, then search them semantically.

### Run workflows

The **Flows** tab runs declarative tool-call sequences. See `.harness/workflows/` for examples.

### Schedule automation

Create scheduled jobs from the **Runs** tab or the API. Jobs can run shell commands (if granted) on a timer.

## Safety defaults

* **Permission prompts** — the model asks before running medium/high-risk tools
* **Kill switch** — press Ctrl+Shift+K to block all tool calls instantly
* **Capability grants** — high-risk actions require explicit time-limited approval
* **Command allowlist** — background shell commands must match a preset pattern

## Where things are stored

| Location | What |
|----------|------|
| `.harness/settings.json` | Your configuration |
| `.harness/sessions/` | Chat transcripts |
| `.harness/skills/` | Installed skills |
| `.harness/memory/` | Agent memory |

## Common commands

| Command | What it does |
|---------|-------------|
| `npm run ui` | Start the browser UI (dev mode) |
| `npm run start -- -p "your prompt"` | CLI mode, single prompt |
| `npm run start -- --help` | Show all CLI flags |
| `npm run typecheck` | Type-check the source |
| `npm test -- --runInBand` | Run the test suite |
| `npm run build` | Compile TypeScript to dist/ |
| `npm run serve` | Start the UI from compiled dist/ |

## Next steps

* Open the **Settings** panel and explore the configuration options
* Try the **Skills** tab to see what skills are available
* Check [docs/MODEL-PRESETS.md](docs/MODEL-PRESETS.md) for recommended models
* Read the [README](README.md) for the full feature reference
