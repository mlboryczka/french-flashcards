// A throwaway Postgres built from the repo's own schema and every migration,
// for the few checks that must run the real SQL (2026-10-07). Only where this
// machine has Postgres installed (initdb, pg_ctl and psql on the PATH, as
// Homebrew's postgresql@16 puts them); elsewhere `localPostgres()` gives no
// database and says why, and the suite says the check didn't run. Nothing leaves the machine: the
// database lives in a temporary folder, listens on 127.0.0.1 only, on a free
// port and with no Unix socket (a temporary folder's path can be longer than
// a socket's 103 bytes), and is stopped and deleted by `stop()`.
//
// Supabase provides some things a plain Postgres lacks (the auth schema and
// its functions, three roles, pgcrypto); STUB adds the few the schema and
// migrations use.

import { spawnSync } from "node:child_process";
import { mkdtempSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");

const STUB = `
do $$ begin
  if not exists (select 1 from pg_roles where rolname = 'anon') then create role anon nologin; end if;
  if not exists (select 1 from pg_roles where rolname = 'authenticated') then create role authenticated nologin; end if;
  if not exists (select 1 from pg_roles where rolname = 'service_role') then create role service_role nologin bypassrls; end if;
end $$;
create schema auth;
create table auth.users (id uuid primary key, email text);
create function auth.uid() returns uuid language sql stable as $f$ select nullif(current_setting('request.jwt.claim.sub', true), '')::uuid $f$;
create function auth.jwt() returns jsonb language sql stable as $f$ select coalesce(nullif(current_setting('request.jwt.claims', true), ''), '{}')::jsonb $f$;
create function auth.email() returns text language sql stable as $f$ select auth.jwt() ->> 'email' $f$;
create function auth.role() returns text language sql stable as $f$ select coalesce(auth.jwt() ->> 'role', 'anon') $f$;
create extension if not exists pgcrypto;
`;

const has = (cmd) => spawnSync("sh", ["-c", `command -v ${cmd}`], { encoding: "utf8" }).status === 0;

const freePort = () =>
  new Promise((resolve, reject) => {
    const s = createServer();
    s.once("error", reject);
    s.listen(0, "127.0.0.1", () => { const { port } = s.address(); s.close(() => resolve(port)); });
  });

// { db: { sql(text) -> { ok, out, err }, stop() } }, or { db: null, why }
// when Postgres isn't here, won't start, or the schema won't load.
export async function localPostgres() {
  if (!["initdb", "pg_ctl", "psql"].every(has)) return { db: null, why: "no Postgres installed here" };
  const dir = mkdtempSync(join(tmpdir(), "ff-pg-"));
  const data = join(dir, "data");
  const port = await freePort();
  // LC_ALL: on a Mac, Postgres refuses to start without a locale set ("postmaster
  // became multithreaded during startup").
  const run = (cmd, args) => spawnSync(cmd, args, { encoding: "utf8", env: { ...process.env, LC_ALL: "C" } });
  const stop = () => {
    run("pg_ctl", ["-D", data, "-m", "immediate", "-w", "stop"]);
    rmSync(dir, { recursive: true, force: true });
  };
  const init = run("initdb", ["-D", data, "-U", "postgres", "--auth=trust", "-E", "UTF8", "--no-locale"]);
  if (init.status !== 0) { stop(); return { db: null, why: `initdb failed: ${(init.stderr || "").trim().split("\n")[0]}` }; }
  const start = run("pg_ctl", ["-D", data, "-l", join(dir, "log"), "-w", "-o", `-p ${port} -c listen_addresses=127.0.0.1 -c unix_socket_directories=''`, "start"]);
  if (start.status !== 0) { stop(); return { db: null, why: `Postgres wouldn't start: ${(start.stderr || "").trim().split("\n")[0]}` }; }
  const psql = (args) => {
    const r = run("psql", ["-X", "-q", "-A", "-t", "-v", "ON_ERROR_STOP=1", "-h", "127.0.0.1", "-p", String(port), "-U", "postgres", "-d", "postgres", ...args]);
    return { ok: r.status === 0, out: (r.stdout || "").trim(), err: (r.stderr || "").trim() };
  };
  const stub = join(dir, "stub.sql");
  writeFileSync(stub, STUB);
  const files = [stub, join(ROOT, "supabase", "schema.sql"),
    ...readdirSync(join(ROOT, "migrations")).filter((f) => f.endsWith(".sql")).sort().map((f) => join(ROOT, "migrations", f))];
  for (const f of files) {
    const r = psql(["-f", f]);
    if (!r.ok) { stop(); return { db: null, why: `${f.split("/").pop()} wouldn't load: ${r.err.split("\n")[0]}` }; }
  }
  return { db: { sql: (text) => psql(["-c", text]), stop } };
}
