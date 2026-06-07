// Tiny curated catalog of MCP servers.
//
// This is intentionally a static list rather than a network call so the
// /api/mcp/catalog endpoint always works (no network dependency, no rate
// limit, no authentication). New entries land via PR.
//
// Each entry is a copy-paste-ready install hint plus a description.
// The Harness doesn't run MCP servers itself today; this surface is a
// discovery aid so users know what to wire when an MCP integration ships.

export interface McpCatalogEntry {
  /** Stable short name. */
  name: string;
  /** One-line description. */
  description: string;
  /** Tags for client-side filtering. */
  tags: string[];
  /** Suggested install / run command (npx, uvx, docker, etc.). */
  install: string;
  /** Project homepage. */
  homepage: string;
  /** Env vars the user must set before the server is usable. */
  requiresEnv: string[];
}

export const MCP_CATALOG: McpCatalogEntry[] = [
  {
    name: 'filesystem',
    description: 'Read, write, and search files in a sandboxed local directory.',
    tags: ['files', 'official'],
    install: 'npx -y @modelcontextprotocol/server-filesystem ${PWD}',
    homepage: 'https://github.com/modelcontextprotocol/servers/tree/main/src/filesystem',
    requiresEnv: [],
  },
  {
    name: 'github',
    description: 'Search code, manage issues and PRs on GitHub.',
    tags: ['dev', 'git', 'official'],
    install: 'npx -y @modelcontextprotocol/server-github',
    homepage: 'https://github.com/modelcontextprotocol/servers/tree/main/src/github',
    requiresEnv: ['GITHUB_PERSONAL_ACCESS_TOKEN'],
  },
  {
    name: 'git',
    description: 'Run git operations (log, diff, blame, show) on a local repo.',
    tags: ['git', 'official'],
    install: 'uvx mcp-server-git',
    homepage: 'https://github.com/modelcontextprotocol/servers/tree/main/src/git',
    requiresEnv: [],
  },
  {
    name: 'sqlite',
    description: 'Query and modify a local SQLite database.',
    tags: ['data', 'official'],
    install: 'uvx mcp-server-sqlite --db-path ${HOME}/data.sqlite',
    homepage: 'https://github.com/modelcontextprotocol/servers/tree/main/src/sqlite',
    requiresEnv: [],
  },
  {
    name: 'postgres',
    description: 'Read-only schema + query against a Postgres database.',
    tags: ['data', 'official'],
    install: 'uvx mcp-server-postgres ${DATABASE_URL}',
    homepage: 'https://github.com/modelcontextprotocol/servers/tree/main/src/postgres',
    requiresEnv: ['DATABASE_URL'],
  },
  {
    name: 'puppeteer',
    description: 'Control a headless Chromium for scraping and screenshots.',
    tags: ['web', 'browser', 'official'],
    install: 'npx -y @modelcontextprotocol/server-puppeteer',
    homepage: 'https://github.com/modelcontextprotocol/servers/tree/main/src/puppeteer',
    requiresEnv: [],
  },
  {
    name: 'memory',
    description: 'Persistent knowledge graph the agent can read and update.',
    tags: ['memory', 'official'],
    install: 'npx -y @modelcontextprotocol/server-memory',
    homepage: 'https://github.com/modelcontextprotocol/servers/tree/main/src/memory',
    requiresEnv: [],
  },
  {
    name: 'brave-search',
    description: 'Web search via the Brave Search API.',
    tags: ['web', 'search', 'official'],
    install: 'npx -y @modelcontextprotocol/server-brave-search',
    homepage: 'https://github.com/modelcontextprotocol/servers/tree/main/src/brave-search',
    requiresEnv: ['BRAVE_API_KEY'],
  },
  {
    name: 'fetch',
    description: 'Fetch any URL and return readable, model-friendly content.',
    tags: ['web', 'official'],
    install: 'uvx mcp-server-fetch',
    homepage: 'https://github.com/modelcontextprotocol/servers/tree/main/src/fetch',
    requiresEnv: [],
  },
  {
    name: 'time',
    description: 'Date / time / timezone arithmetic helpers.',
    tags: ['util', 'official'],
    install: 'uvx mcp-server-time',
    homepage: 'https://github.com/modelcontextprotocol/servers/tree/main/src/time',
    requiresEnv: [],
  },
  {
    name: 'slack',
    description: 'Read channels, post messages, and manage Slack threads.',
    tags: ['chat', 'official'],
    install: 'npx -y @modelcontextprotocol/server-slack',
    homepage: 'https://github.com/modelcontextprotocol/servers/tree/main/src/slack',
    requiresEnv: ['SLACK_BOT_TOKEN', 'SLACK_TEAM_ID'],
  },
  {
    name: 'google-maps',
    description: 'Geocoding, directions, and places via Google Maps.',
    tags: ['maps', 'official'],
    install: 'npx -y @modelcontextprotocol/server-google-maps',
    homepage: 'https://github.com/modelcontextprotocol/servers/tree/main/src/google-maps',
    requiresEnv: ['GOOGLE_MAPS_API_KEY'],
  },
  {
    name: 'google-calendar',
    description: 'Read, create, update, delete Google Calendar events across multiple accounts. Needs Google Cloud OAuth (one-time setup).',
    tags: ['calendar', 'google', 'community'],
    install: 'npx -y @cocal/google-calendar-mcp',
    homepage: 'https://github.com/nspady/google-calendar-mcp',
    requiresEnv: ['GOOGLE_OAUTH_CREDENTIALS'],
  },
  {
    name: 'gmail',
    description: 'Read, search, send, and manage Gmail messages and labels. Uses the same Google Cloud OAuth keys file as google-calendar.',
    tags: ['mail', 'gmail', 'google', 'community'],
    install: 'npx -y @gongrzhe/server-gmail-autoauth-mcp',
    homepage: 'https://github.com/GongRzhe/Gmail-MCP-Server',
    requiresEnv: [],
  },
  {
    name: 'ms-365',
    description: 'Microsoft 365 / Outlook: mail, calendar, OneDrive, contacts, To Do. Device-code login on first run — no Azure setup needed for personal accounts.',
    tags: ['calendar', 'mail', 'microsoft', 'outlook', 'community'],
    install: 'npx -y @softeria/ms-365-mcp-server --preset outlook',
    homepage: 'https://github.com/Softeria/ms-365-mcp-server',
    requiresEnv: [],
  },
  {
    name: 'playwright',
    description: 'Modern browser automation — handles JS-heavy sites, screenshots, scraping, form-fill. Better than puppeteer for current web.',
    tags: ['browser', 'automation', 'scraping', 'community'],
    install: 'npx -y @executeautomation/playwright-mcp-server',
    homepage: 'https://github.com/executeautomation/mcp-playwright',
    requiresEnv: [],
  },
  {
    name: 'duckduckgo',
    description: 'Web search via DuckDuckGo — no API key required. Complements brave-search.',
    tags: ['search', 'web', 'community'],
    install: 'npx -y duckduckgo-mcp-server',
    homepage: 'https://github.com/zhsama/duckduckgo-mpc-server',
    requiresEnv: [],
  },
  {
    name: 'youtube',
    description: 'Fetch YouTube transcripts and video metadata. Useful for "summarize this video" workflows.',
    tags: ['youtube', 'video', 'transcript', 'community'],
    install: 'npx -y @anaisbetts/mcp-youtube',
    homepage: 'https://github.com/anaisbetts/mcp-youtube',
    requiresEnv: [],
  },
];
