/**
 * code-apps-setup.ts — CopilotForge Cookbook Recipe
 *
 * WHAT THIS DOES:
 *   Checks prerequisites for Power Apps Code Apps development and guides
 *   you through the initial setup. Verifies Node.js, PAC CLI, and
 *   Power Platform authentication are properly configured.
 *
 * WHEN TO USE THIS:
 *   Before starting your first Code App. Catches missing dependencies
 *   early so you don't hit errors mid-setup.
 *
 * HOW TO RUN:
 *   npx ts-node cookbook/code-apps-setup.ts
 *   Or: node cookbook/code-apps-setup.ts (if compiled)
 *
 * PREREQUISITES:
 *   - Node.js 18+
 *
 * EXPECTED OUTPUT:
 *   🔍 Code Apps Prerequisites Check
 *   ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
 *   ✅ Node.js     v20.11.0 (LTS — good!)
 *   ✅ npm         v10.2.0
 *   ❌ PAC CLI     Not found — install: npm install -g @microsoft/pac-cli
 *   ⚠️  Auth       Run 'pac auth create' after installing PAC CLI
 *   ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
 */

import { execSync } from "node:child_process";

// --- ANSI helpers ---
const c = {
  reset: "\x1b[0m",
  bold: "\x1b[1m",
  dim: "\x1b[2m",
  green: "\x1b[32m",
  red: "\x1b[31m",
  yellow: "\x1b[33m",
  cyan: "\x1b[36m",
};

const ok = `${c.green}✅${c.reset}`;
const fail = `${c.red}❌${c.reset}`;
const warn = `${c.yellow}⚠️${c.reset}`;
const line = "━".repeat(44);

interface CheckResult {
  label: string;
  status: "ok" | "fail" | "warn";
  detail: string;
}

function runCmd(cmd: string): string | null {
  try {
    return execSync(cmd, { encoding: "utf8", stdio: ["pipe", "pipe", "pipe"] }).trim();
  } catch {
    return null;
  }
}

function checkNode(): CheckResult {
  const version = runCmd("node --version");
  if (!version) return { label: "Node.js", status: "fail", detail: "Not found — install from https://nodejs.org" };
  const major = parseInt(version.replace("v", "").split(".")[0], 10);
  if (major < 18) return { label: "Node.js", status: "warn", detail: `${version} (need 18+ LTS)` };
  return { label: "Node.js", status: "ok", detail: `${version} (LTS — good!)` };
}

function checkNpm(): CheckResult {
  const version = runCmd("npm --version");
  if (!version) return { label: "npm", status: "fail", detail: "Not found — comes with Node.js" };
  return { label: "npm", status: "ok", detail: `v${version}` };
}

function checkPac(): CheckResult {
  const version = runCmd("pac --version");
  if (!version) return { label: "PAC CLI", status: "fail", detail: "Not found — install: dotnet tool install -g Microsoft.PowerApps.CLI.Tool" };
  return { label: "PAC CLI", status: "ok", detail: version };
}

function checkPacAuth(): CheckResult {
  const output = runCmd("pac auth list");
  if (!output) return { label: "Auth", status: "warn", detail: "Run 'pac auth create' to authenticate" };
  if (output.includes("No profiles")) return { label: "Auth", status: "warn", detail: "No auth profiles — run 'pac auth create'" };
  return { label: "Auth", status: "ok", detail: "Authenticated" };
}

function formatResult(r: CheckResult): string {
  const icon = r.status === "ok" ? ok : r.status === "fail" ? fail : warn;
  return `  ${icon} ${r.label.padEnd(12)} ${c.dim}${r.detail}${c.reset}`;
}

// --- Main ---
console.log(`\n  ${c.bold}🔍 Code Apps Prerequisites Check${c.reset}`);
console.log(`  ${c.dim}${line}${c.reset}`);

const checks = [checkNode(), checkNpm(), checkPac(), checkPacAuth()];
checks.forEach((r) => console.log(formatResult(r)));

console.log(`  ${c.dim}${line}${c.reset}`);

const failures = checks.filter((r) => r.status === "fail");
const warnings = checks.filter((r) => r.status === "warn");

if (failures.length === 0 && warnings.length === 0) {
  console.log(`\n  ${c.green}${c.bold}All good!${c.reset} You're ready to create a Code App.`);
  console.log(`  Run: ${c.cyan}npx degit github:microsoft/PowerAppsCodeApps/templates/vite my-app${c.reset}\n`);
} else if (failures.length === 0) {
  console.log(`\n  ${c.yellow}${c.bold}Almost there!${c.reset} Fix the warnings above, then you're ready.`);
  console.log(`  Guide: ${c.cyan}cookbook/code-apps-guide.md${c.reset}\n`);
} else {
  console.log(`\n  ${c.red}${c.bold}Some things need fixing.${c.reset} See the ❌ items above.`);
  console.log(`  Guide: ${c.cyan}cookbook/code-apps-guide.md${c.reset}\n`);
}
