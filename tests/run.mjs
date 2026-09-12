#!/usr/bin/env node
// Test runner: starts the mock Supabase and the Vite dev server, runs every
// suite in tests/suites, and cleans up.
//
//   npm test                 all suites
//   npm test -- layout       only suites whose name contains "layout"
//
// Suites that need no browser (logic, apply-splits, auth, dates, serving, progress) run first
// and fast — see NEEDS_BROWSER below, which is the list that decides.

import { spawn } from "node:child_process";
import { readdirSync, writeFileSync, rmSync, existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = join(HERE, "..");
const ENV_FILE = join(ROOT, ".env.local");
const NEEDS_BROWSER = (name) => !["logic", "apply-splits", "auth", "dates", "serving", "progress"].includes(name);

const filter = process.argv.slice(2).filter((a) => !a.startsWith("-"));
const suites = readdirSync(join(HERE, "suites"))
  .filter((f) => f.endsWith(".mjs"))
  .map((f) => f.replace(/\.mjs$/, ""))
  .filter((n) => filter.length === 0 || filter.some((f) => n.includes(f)))
  .sort((a, b) => Number(NEEDS_BROWSER(a)) - Number(NEEDS_BROWSER(b)));

if (suites.length === 0) {
  console.error(`No suites match ${JSON.stringify(filter)}`);
  process.exit(1);
}

const children = [];
let envWritten = false;

function cleanup() {
  for (const c of children) {
    try { process.kill(-c.pid, "SIGKILL"); } catch {}
  }
  if (envWritten) { try { rmSync(ENV_FILE); } catch {} }
}
process.on("exit", cleanup);
for (const sig of ["SIGINT", "SIGTERM"]) process.on(sig, () => { cleanup(); process.exit(130); });

function background(cmd, args, opts = {}) {
  const c = spawn(cmd, args, { cwd: ROOT, detached: true, stdio: "ignore", ...opts });
  children.push(c);
  return c;
}

async function waitFor(url, label, timeoutMs = 45000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      await fetch(url);
      return;
    } catch {
      await new Promise((r) => setTimeout(r, 300));
    }
  }
  throw new Error(`${label} did not come up at ${url} within ${timeoutMs}ms`);
}

function runSuite(name) {
  return new Promise((resolve) => {
    const c = spawn(process.execPath, [join(HERE, "suites", `${name}.mjs`)], {
      cwd: ROOT,
      stdio: "inherit",
      env: { ...process.env, NO_PROXY: "*" },
    });
    c.on("exit", (code) => resolve(code === 0));
  });
}

if (suites.some(NEEDS_BROWSER)) {
  if (existsSync(ENV_FILE)) {
    console.error(
      `Refusing to overwrite ${ENV_FILE}. Move it aside — the browser suites need to point the app at the mock.`
    );
    process.exit(1);
  }
  writeFileSync(
    ENV_FILE,
    "VITE_SUPABASE_URL=http://127.0.0.1:5999\nVITE_SUPABASE_ANON_KEY=test.key\n"
  );
  envWritten = true;

  background(process.execPath, [join(HERE, "mock-supabase.mjs")]);
  await waitFor("http://127.0.0.1:5999/rest/v1/user_cards", "mock Supabase");

  background("npx", ["vite", "--port", "5173", "--strictPort"]);
  await waitFor("http://localhost:5173/", "vite dev server");
}

const failed = [];
for (const name of suites) {
  console.log(`\n\x1b[1m▸ ${name}\x1b[0m`);
  if (!(await runSuite(name))) failed.push(name);
}

console.log("");
if (failed.length) {
  console.log(`\x1b[31m${failed.length} of ${suites.length} suites failed: ${failed.join(", ")}\x1b[0m`);
  process.exit(1);
}
console.log(`\x1b[32mall ${suites.length} suites passed\x1b[0m`);
process.exit(0);
