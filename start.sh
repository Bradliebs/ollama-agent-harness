#!/usr/bin/env bash
set -e

cd "$(dirname "$0")"

echo ""
echo "  ============================================"
echo "  🤖  Ollama Agent Harness — Setup & Launch"
echo "  ============================================"
echo ""

# Step 1: Check Node.js
if ! command -v node &>/dev/null; then
  echo "  ❌ Node.js was not found."
  echo ""
  echo "  To fix this:"
  echo "  • macOS:  brew install node"
  echo "  • Ubuntu: sudo apt install nodejs npm"
  echo "  • Or download from https://nodejs.org/ (LTS version)"
  echo ""
  exit 1
fi
echo "  ✅ Node.js $(node --version) found"

# Step 2: Check npm
if ! command -v npm &>/dev/null; then
  echo "  ❌ npm was not found. Install Node.js from https://nodejs.org/"
  exit 1
fi

# Step 3: Check Ollama
if ! command -v ollama &>/dev/null; then
  echo "  ⚠️  Ollama was not found in PATH."
  echo ""
  echo "  To fix this:"
  echo "  • macOS:  brew install ollama"
  echo "  • Linux:  curl -fsSL https://ollama.com/install.sh | sh"
  echo "  • Or download from https://ollama.com/"
  echo ""
  echo "  After installing, run: ollama pull llama3.2"
  echo ""
  read -rp "  Press Enter to continue anyway, or Ctrl+C to quit... "
else
  echo "  ✅ Ollama found: $(ollama --version 2>/dev/null || echo 'installed')"
fi

# Step 4: Install dependencies
if [ ! -d "node_modules" ]; then
  echo ""
  echo "  📦 Installing dependencies (first time only)..."
  npm ci
  echo "  ✅ Dependencies installed"
fi

# Step 5: Build
if [ ! -f "dist/web/server.js" ]; then
  echo ""
  echo "  🔨 Building from source (first time only)..."
  npm run build
  echo "  ✅ Build complete"
fi

# Step 6: Workspace — agent files go here, NOT in the harness repo
if [ -z "$HARNESS_PROJECT_DIR" ]; then
  DEFAULT_WS="$HOME/hermes-workspace"
  echo ""
  echo "  Where should the agent work? (its files, memory, outputs go here)"
  echo "  Press Enter for default: $DEFAULT_WS"
  echo ""
  read -rp "  Workspace folder: " WORKSPACE
  WORKSPACE="${WORKSPACE:-$DEFAULT_WS}"
  mkdir -p "$WORKSPACE"
  export HARNESS_PROJECT_DIR="$WORKSPACE"
  echo "  ✅ Workspace: $HARNESS_PROJECT_DIR"
else
  echo "  ✅ Workspace: $HARNESS_PROJECT_DIR"
fi

# Step 7: Launch
PORT="${PORT:-4300}"
echo ""
echo "  🚀 Starting Ollama Agent Harness..."
echo "  Open in your browser: http://127.0.0.1:${PORT}"
echo ""
echo "  Press Ctrl+C to stop the server."
echo "  ============================================"
echo ""

# Auto-open browser (best effort)
if command -v open &>/dev/null; then
  (sleep 2 && open "http://127.0.0.1:${PORT}") &
elif command -v xdg-open &>/dev/null; then
  (sleep 2 && xdg-open "http://127.0.0.1:${PORT}") &
fi

npm run serve
