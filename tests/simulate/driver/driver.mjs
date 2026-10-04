// The student. Drives the real built app in one persistent headless Chrome
// profile, sitting by sitting on a simulated clock, answering every card with
// the hidden memory model (model.mjs) and checking each answer against the
// card_reviews row the app writes.
//
// Usage: WORK=... node driver.mjs [--only S01,S02] [--profile dir] [--dry]
import { chromium } from "playwright-core";
import fs from "node:fs";
import path from "node:path";
import { Memory, unit } from "./model.mjs";
import { READ_STATE } from "./reader.mjs";

const WORK = process.env.WORK;
const DATA = path.join(WORK, "data");
const SHOTS = path.join(WORK, "screenshots");
const APP_DIR = path.join(WORK, "app");
const APP = "http://127.0.0.1:5190";
const DB = "http://127.0.0.1:5991";
const CHROME = `${process.env.HOME}/Library/Caches/ms-playwright/chromium-1208/chrome-mac-arm64/Google Chrome for Testing.app/Contents/MacOS/Google Chrome for Testing`;
const args = process.argv.slice(2);
const argVal = (k) => { const i = args.indexOf(k); return i >= 0 ? args[i + 1] : null; };
const PROFILE = argVal("--profile") || path.join(WORK, "profile");
const ONLY = argVal("--only") ? new Set(argVal("--only").split(",")) : null;
const MAX_ANSWERS_TEST = argVal("--max-answers") ? Number(argVal("--max-answers")) : Infinity;
const PREFIX = argVal("--prefix") || "driver";
const ANSWERS = path.join(DATA, `${PREFIX}-answers.jsonl`);
const EVENTS = path.join(DATA, `${PREFIX}-events.jsonl`);
const PROGRESS = path.join(DATA, `${PREFIX}-progress.json`);
const STUDENT = { name: "Nora Lindqvist", email: argVal("--email") || "nora.lindqvist@example.com" };
const FAKE_KEY = "sk-ant-api03-standin-NOT-A-REAL-KEY-0000000000000000";
const CAHIER = "/Users/mboryczka/Downloads/Cahier Matthew.txt";
const TARGET_MAX = 2500;

const { cleanFrenchPrompt, cleanEnglishPrompt, dropFinalPeriod } = await import(path.join(APP_DIR, "src/lib/cardText.js"));
const { RAW } = await import(path.join(APP_DIR, "src/data/cards.js"));
const { HANDWRITTEN } = await import(path.join(WORK, "servers/handwritten-cards.mjs"));

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const logEvent = (type, data = {}) => {
  const e = { realT: new Date().toISOString(), type, ...data };
  fs.appendFileSync(EVENTS, JSON.stringify(e) + "\n");
  if (!["answer-detail"].includes(type)) console.log(`[${type}]`, JSON.stringify(data).slice(0, 300));
};
const getJson = async (p, init) => (await fetch(`${DB}${p}`, init)).json();

// ─── Schedule (America/New_York local times) ──────────────────────────────
function nyToMs(ymd, hm) {
  const fmt = new Intl.DateTimeFormat("en-CA", { timeZone: "America/New_York", year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", hourCycle: "h23" });
  for (const off of ["-04:00", "-05:00"]) {
    const d = new Date(`${ymd}T${hm}:00${off}`);
    if (fmt.format(d).replace(",", "") === `${ymd} ${hm}`) return d.getTime();
  }
  throw new Error(`bad local time ${ymd} ${hm}`);
}
const addDays = (ymd, n) => { const d = new Date(`${ymd}T12:00:00Z`); d.setUTCDate(d.getUTCDate() + n); return d.toISOString().slice(0, 10); };
function buildSchedule() {
  const S = [];
  const add = (o) => S.push({ id: `S${String(S.length + 1).padStart(2, "0")}`, blocks: 1, ...o });
  add({ date: "2026-09-25", time: "18:00", blocks: 4, onboarding: true, shots: ["last"] });
  add({ date: "2026-09-26", time: "09:00", blocks: 2 });
  add({ date: "2026-09-27", time: "21:30", blocks: 1 });
  add({ date: "2026-09-28", time: "07:45", blocks: 1 });
  add({ date: "2026-09-28", time: "19:00", blocks: 1 });
  add({ date: "2026-09-30", time: "12:30", blocks: 2 });
  add({ date: "2026-10-01", time: "23:50", blocks: 2, shots: ["last"] });
  add({ date: "2026-10-02", time: "08:00", blocks: 1, typing: true });
  add({ date: "2026-10-07", time: "18:00", blocks: 8, untilCaughtUp: true, shots: ["first", "last"] });
  const rot = ["07:30", "12:15", "20:45", "22:30"];
  for (let i = 0; i < 27; i++) {
    const d = addDays("2026-10-08", i);
    if (d === "2026-10-15" || d === "2026-10-24") continue;
    if (d === "2026-11-01") {
      add({ date: d, time: "00:30", blocks: 1, dst: true });
      add({ date: d, time: "23:30", blocks: 1, dst: true, shots: ["last"] });
      continue;
    }
    add({
      date: d, time: rot[i % 4], blocks: 1, secondPlanned: i % 3 === 2,
      typing: d === "2026-10-28", dirSwitch: d === "2026-10-20" ? "fr" : null,
      correction: d === "2026-10-12" ? "gotit-then-again" : d === "2026-10-26" ? "again-then-gotit" : null,
      shots: d === "2026-10-20" || d === "2026-11-03" ? ["last"] : undefined,
    });
  }
  return S;
}

// ─── What the student knows about each card (from the database) ───────────
const kindByFront = new Map();
for (const [f, , cat] of RAW) if (!kindByFront.has(f)) kindByFront.set(f, cat === "expr" ? "expr" : cat === "gram" ? "gram" : "vocab");
for (const list of Object.values(HANDWRITTEN)) for (const [f, , k] of list) if (!kindByFront.has(f)) kindByFront.set(f, k);
const isTwoWayRow = (row) => row.category === "V" || row.category === "E";
function kindOf(row) {
  if (!isTwoWayRow(row)) return "oneway";
  if (row.category === "E") return "expr";
  return kindByFront.get(row.front) === "expr" ? "expr" : "vocab";
}
const norm = (s) => (s == null ? s : String(s).replace(/ /g, " ").replace(/\s+/g, " ").trim());
let rowsById = new Map();
let promptIndex = new Map();
let studentId = null;
async function getStudentId() {
  if (studentId) return studentId;
  const u = (await getJson("/__users")).find((x) => x.email === STUDENT.email.toLowerCase());
  studentId = u?.id || null;
  return studentId;
}
async function studentRows() {
  const id = await getStudentId();
  return (await getJson("/__table/user_cards")).filter((r) => r.user_id === id);
}
async function rebuildIndex() {
  const rows = await studentRows();
  rowsById = new Map(rows.map((r) => [r.id, r]));
  promptIndex = new Map();
  for (const r of rows) {
    for (const dir of isTwoWayRow(r) ? ["fr", "en"] : ["fr"]) {
      const prompt = norm(dropFinalPeriod(dir === "fr" ? cleanFrenchPrompt(r.front, r.back) : cleanEnglishPrompt(r.back)));
      const answer = norm(dropFinalPeriod(dir === "fr" ? r.back : r.front));
      if (!promptIndex.has(prompt)) promptIndex.set(prompt, []);
      promptIndex.get(prompt).push({ cardId: r.id, dir, answer });
    }
  }
  return rows;
}
function identify(front, back, queueEntry) {
  let cands = promptIndex.get(norm(front)) || [];
  let how = "prompt";
  if (cands.length > 1 && back != null) {
    const byBack = cands.filter((c) => c.answer === norm(back));
    if (byBack.length >= 1) { cands = byBack; how = "prompt+answer"; }
  }
  if (cands.length > 1 && queueEntry) {
    const q = cands.filter((c) => c.cardId === queueEntry.row_id && c.dir === queueEntry.dir);
    if (q.length === 1) { cands = q; how = "ambiguous→queue"; }
  }
  if (cands.length === 1) return { ...cands[0], how, ambiguous: how !== "prompt" && how !== "prompt+answer" };
  return { cardId: queueEntry?.row_id ?? null, dir: queueEntry?.dir ?? null, how: cands.length ? "ambiguous-unresolved" : "no-text-match", ambiguous: true, nCands: cands.length };
}

// What a student types when they know it: the first meaning, no notes.
function stripParens(s) {
  let out = String(s || ""); let prev;
  do { prev = out; out = out.replace(/\([^()]*\)/g, " "); } while (out !== prev);
  return out.replace(/\(.*$/, " ").replace(/\)/g, " ").replace(/\s+/g, " ").trim();
}
function firstMeaning(ans, { drill = false } = {}) {
  let s = stripParens(ans) || ans;
  s = s.split("/")[0].trim();
  if (!drill) {
    const parts = s.split(/[,;|]/).map((x) => x.trim()).filter(Boolean);
    if (parts.length > 1 && parts.every((p) => p.split(/\s+/).length < 4 && p.length < 20)) s = parts[0];
  }
  return s.replace(/[.…]+$/, "").trim();
}

// ─── State ────────────────────────────────────────────────────────────────
const memory = new Memory();
let answerCount = 0;
let reviewRowsExpected = 0;
if (fs.existsSync(ANSWERS)) {
  for (const line of fs.readFileSync(ANSWERS, "utf8").split("\n").filter(Boolean)) {
    const a = JSON.parse(line);
    answerCount = Math.max(answerCount, a.n + 1);
    if (a.cardId == null) continue;
    const it = memory.item(a.cardId, a.dir, a.kind, a.nDates);
    it.S = a.S_after; it.lastShown = a.modelShownAt; it.shown++;
    if (a.writesRow) reviewRowsExpected++;
  }
}
const progress = fs.existsSync(PROGRESS) ? JSON.parse(fs.readFileSync(PROGRESS, "utf8")) : { done: [], blockId: 0, clockInstalled: false };
const saveProgress = () => fs.writeFileSync(PROGRESS, JSON.stringify(progress, null, 1));

// ─── Browser ──────────────────────────────────────────────────────────────
const ctx = await chromium.launchPersistentContext(PROFILE, {
  executablePath: CHROME, headless: true, timezoneId: "America/New_York", locale: "en-US",
  viewport: { width: 1400, height: 900 },
});
let page = null;
let inflight = 0;
const consoleErrors = [];
function attach(p) {
  p.on("console", (m) => {
    if (["error", "warning"].includes(m.type())) {
      const e = { type: m.type(), text: m.text().slice(0, 1000), loc: m.location()?.url?.slice(-60) };
      consoleErrors.push(e);
      logEvent("console", e);
    }
  });
  p.on("pageerror", (e) => logEvent("pageerror", { message: e.message, stack: String(e.stack || "").slice(0, 800) }));
  p.on("dialog", async (d) => { logEvent("dialog", { kind: d.type(), message: d.message() }); await d.accept().catch(() => {}); });
  p.on("request", (r) => { if (r.url().startsWith(DB) && r.method() !== "OPTIONS") inflight++; });
  p.on("requestfinished", async (r) => {
    if (!r.url().startsWith(DB) || r.method() === "OPTIONS") return;
    inflight--;
    const res = await r.response().catch(() => null);
    if (res && res.status() >= 400) logEvent("http-error", { method: r.method(), url: r.url().slice(0, 200), status: res.status(), body: (await res.text().catch(() => "")).slice(0, 500) });
  });
  p.on("requestfailed", (r) => {
    if (r.url().startsWith(DB) && r.method() !== "OPTIONS") inflight--;
    logEvent("request-failed", { method: r.method(), url: r.url().slice(0, 200), failure: r.failure()?.errorText });
  });
}
const read = (digest = false) => page.evaluate(READ_STATE, { digest });
async function waitFor(fn, { timeout = 15000, every = 25, what = "condition" } = {}) {
  const t0 = Date.now();
  for (;;) {
    const v = await fn();
    if (v) return v;
    if (Date.now() - t0 > timeout) throw new Error(`timeout waiting for ${what}`);
    await sleep(every);
  }
}
async function reviewsCount() { return (await getJson("/__count/card_reviews")).count; }
async function waitAllWrites(label) {
  await waitFor(async () => inflight <= 0, { timeout: 30000, what: `in-flight DB requests to finish (${label})` }).catch((e) => logEvent("warn", { msg: e.message, inflight }));
  await waitFor(async () => (await reviewsCount()) >= reviewRowsExpected, { timeout: 30000, what: "all card_reviews rows" }).catch(async (e) => logEvent("warn", { msg: e.message, have: await reviewsCount(), expected: reviewRowsExpected }));
  await sleep(150);
  if (inflight > 0) await waitFor(async () => inflight <= 0, { timeout: 30000, what: "late requests" }).catch(() => {});
}
async function shot(name) {
  const file = path.join(SHOTS, `${name}.png`);
  await page.screenshot({ path: file, fullPage: false }).catch((e) => logEvent("warn", { msg: `screenshot failed ${e.message}` }));
  logEvent("screenshot", { file });
  return file;
}
async function blurActive() { await page.evaluate(() => document.activeElement?.blur?.()); }
async function clickButton(text, within = null) {
  const ok = await page.evaluate(([t, w]) => {
    const root = w ? document.querySelector(w) : document;
    const b = [...root.querySelectorAll("button")].find((x) => x.innerText.trim() === t);
    if (!b) return false;
    b.click();
    return true;
  }, [text, within]);
  if (!ok) throw new Error(`button not found: ${text}`);
  await sleep(60);
  await blurActive();
}

// ─── Onboarding: sign up, connect a key, upload the cahier ────────────────
async function onboarding(s) {
  await page.waitForSelector('input[type="email"]', { timeout: 20000 });
  await page.fill('input[type="email"]', STUDENT.email);
  await clickButton("Send login link");
  await page.waitForSelector("text=Check your inbox", { timeout: 15000 });
  const magic = await getJson("/__magic");
  const m = magic.filter((x) => x.email === STUDENT.email && !x.used).at(-1);
  logEvent("magic-link", { email: STUDENT.email, link: m.link });
  await page.goto(m.link);
  // The app takes the session from the URL; lessons sync into the new deck.
  await waitFor(async () => page.evaluate(() => /CARD \d+ OF \d+/i.test(document.body.innerText) || /Welcome\./.test(document.body.innerText)), { timeout: 30000, what: "app after sign-in" });
  await sleep(1500);
  const afterSignIn = await page.evaluate(() => ({ url: location.href, text: document.body.innerText.slice(0, 400), ls: Object.keys(localStorage) }));
  logEvent("signed-in", afterSignIn);
  await waitFor(async () => page.evaluate(() => /CARD \d+ OF \d+/i.test(document.body.innerText)), { timeout: 30000, what: "study view (deck non-empty after lesson sync)" });
  await shot("S01-after-signin");
  // Connect a Claude key through the profile menu.
  const openProfile = async () => {
    const ok = await page.evaluate((letter) => {
      const b = [...document.querySelectorAll("aside button")].find((x) => x.innerText.trim() === letter);
      if (b) { b.click(); return true; }
      return false;
    }, STUDENT.email[0].toUpperCase());
    if (!ok) throw new Error("profile button not found");
    await sleep(150);
  };
  await openProfile();
  await clickButton("Connect Claude account");
  await page.waitForSelector("#anthropic-key-input", { timeout: 5000 });
  await page.fill("#anthropic-key-input", FAKE_KEY);
  await clickButton("Save key");
  await sleep(200);
  logEvent("key-connected", { stored: await page.evaluate(() => Object.keys(localStorage).filter((k) => k.startsWith("anthropic-key:"))) });
  // Upload the cahier as a file.
  await openProfile();
  await clickButton("Upload document");
  await page.waitForSelector("text=Upload your cahier", { timeout: 5000 });
  await clickButton("Upload file");
  await page.setInputFiles('input[type="file"]', CAHIER);
  await waitFor(async () => page.evaluate(() => /Cahier Matthew\.txt/.test(document.body.innerText)), { timeout: 10000, what: "file loaded in dialog" });
  const loadedText = await page.evaluate(() => [...document.querySelectorAll("div")].map((d) => d.innerText).find((t) => /characters loaded/.test(t)) || "");
  logEvent("upload-file-loaded", { text: loadedText.slice(0, 200) });
  const dialogs = [];
  const onDialog = (d) => dialogs.push(d.message());
  page.on("dialog", onDialog);
  await clickButton("Upload");
  const progressSeen = [];
  const t0 = Date.now();
  while (Date.now() - t0 < 180000) {
    const p = await page.evaluate(() => {
      const t = document.body.innerText;
      const m = t.match(/(Slicing your cahier…|Extracting cards from your lessons…[^\n]*|Saving [\d,]+ cards to your deck…)/);
      return { p: m ? m[1] : null, open: /Upload your cahier/.test(t), err: (t.match(/\n([^\n]*(failed|error|Error)[^\n]*)\n/) || [])[1] || null };
    });
    if (p.p && progressSeen.at(-1) !== p.p) progressSeen.push(p.p);
    if (dialogs.length) break;
    if (!p.open && !dialogs.length) { await sleep(300); if (!dialogs.length) break; }
    await sleep(100);
  }
  page.off("dialog", onDialog);
  logEvent("upload-done", { progress: progressSeen, alert: dialogs, seconds: (Date.now() - t0) / 1000 });
  await sleep(1500);
  await waitAllWrites("after upload");
  const rows = await rebuildIndex();
  const byCat = {}; const bySource = {};
  for (const r of rows) { byCat[r.category] = (byCat[r.category] || 0) + 1; bySource[(r.source || "").split("#")[0]] = (bySource[(r.source || "").split("#")[0]] || 0) + 1; }
  const dates = [...new Set(rows.flatMap((r) => r.dates || []))].sort();
  logEvent("deck-after-upload", { total: rows.length, byCat, bySource, classDates: dates.length, first: dates[0], last: dates.at(-1) });
  await shot("S01-after-upload");
}

// ─── Answering ────────────────────────────────────────────────────────────
function thinkMs(n, typing) { return Math.round((typing ? 6000 : 3000) + unit("think", n) * (typing ? 12000 : 9000)); }
async function newReviewRows(before) {
  return waitFor(async () => {
    const c = await reviewsCount();
    return c > before ? getJson(`/__table/card_reviews?from=${before}`) : null;
  }, { timeout: 15000, what: "card_reviews row for the answer" });
}
async function waitAdvance(prev, { timeout = 4000 } = {}) {
  const t0 = Date.now();
  while (Date.now() - t0 < timeout) {
    const st = await read();
    if (st.checkpoint || (st.idx != null && st.idx !== prev.idx)) return st;
    await sleep(20);
  }
  return null;
}
// Flip the card and wait until grading is offered (and its key handler is live).
async function flipCard() {
  await page.keyboard.press(" ");
  await waitFor(async () => { const s = await read(); return s.gotIt && s.back ? s : null; }, { timeout: 5000, what: "answer side after Space" });
  await sleep(80);
  return read();
}

let ctxS = null; // current sitting context
let clockInstalled = false;
const blockAnswers = { n: 0 };

async function answerOne(st, opts = {}) {
  if (answerCount >= MAX_ANSWERS_TEST) throw new Error("max answers reached (test mode)");
  const typing = !!ctxS.typing;
  const q = st.queue?.[st.idx] || null;
  const n = answerCount;
  const rec = {
    n, sitting: ctxS.id, sittingDate: ctxS.date, sittingTime: ctxS.time, block: progress.blockId, blockInSitting: ctxS.blockNo,
    counter: st.counter, idx: st.idx, blockLen: st.blockLen, retryMarker: st.retryMarker, queueEntry: q, mode: typing ? "typed" : "flip", unsavedNotice: st.unsaved,
    prompt: st.front, instruction: st.instruction,
  };
  let back = null;
  let st2 = st;
  if (!typing) {
    st2 = await flipCard();
    back = st2.back;
  }
  const id = identify(st.front, back, q);
  Object.assign(rec, { cardId: id.cardId, dir: id.dir, identifiedBy: id.how, ambiguous: id.ambiguous || false });
  if (q && (q.row_id !== id.cardId || q.dir !== id.dir)) rec.textVsQueueMismatch = { text: [id.cardId, id.dir], queue: [q.row_id, q.dir] };
  const row = rowsById.get(id.cardId);
  const kind = row ? kindOf(row) : "vocab";
  const nDates = row ? (row.dates || []).length : 1;
  Object.assign(rec, { dbCategory: row?.category, kind, nDates, answerText: back, source: row?.source });
  const it = memory.item(id.cardId, id.dir, kind, nDates);
  // Thinking / reading time, then the moment of answering.
  await page.clock.fastForward(thinkMs(n, typing));
  const tPress = await page.evaluate(() => Date.now());
  const a = memory.assess(it, tPress);
  const right = unit("answer", n) < a.p;
  Object.assign(rec, { simMs: tPress, simLocal: new Date(tPress).toLocaleString("en-US", { timeZone: "America/New_York", hour12: false }), firstSight: a.firstSight, t_days: a.t, p_raw: a.p_raw, p: a.p, primed: a.primed, retryBoost: a.retryBoost, S_before: it.S, modelRight: right, m: it.m });
  const before = await reviewsCount();
  let adv = null;
  let pressed = null;
  if (!typing) {
    pressed = opts.forcePress ?? (right ? "right" : "wrong");
    const key = pressed === "right" ? "ArrowRight" : "ArrowLeft";
    await page.keyboard.press(key);
    adv = await waitAdvance(st2);
    if (!adv) {
      const now = await read();
      rec.retryPress = { flipped: now.flipped, gotIt: now.gotIt };
      if (now.gotIt && now.idx === st2.idx) { await sleep(150); await page.keyboard.press(key); adv = await waitAdvance(st2, { timeout: 8000 }); }
    }
    if (!adv) throw new Error(`card did not advance after ${key} (n=${n})`);
  } else {
    // Typing: the model's recall decides what is typed.
    const ans = id.dir === "fr" ? row?.back : row?.front;
    const drill = id.dir === "fr" && String(row?.front || "").includes("→");
    let typed = null; let action;
    if (right) { typed = firstMeaning(ans, { drill }); action = "typed-answer"; }
    else if (unit("wrongmode", n) < 0.5) { action = "show-answer"; }
    else {
      // A plausible wrong word: another card's answer the same way round.
      const pool = [...rowsById.values()].filter((r) => r.id !== id.cardId && (id.dir === "fr" ? true : isTwoWayRow(r)) && (kindOf(r) === "oneway") === (kind === "oneway"));
      const other = pool[Math.floor(unit("wrongpick", n) * pool.length)];
      typed = firstMeaning(id.dir === "fr" ? other.back : other.front, { drill });
      action = "typed-wrong";
    }
    rec.typedAction = action; rec.typed = typed; rec.expected = ans;
    await page.waitForSelector('input[placeholder^="Type"]', { timeout: 5000 });
    if (action === "show-answer") {
      await clickButton("Show answer");
    } else {
      await page.fill('input[placeholder^="Type"]', typed);
      await page.press('input[placeholder^="Type"]', "Enter");
    }
    const res = await waitFor(async () => { const s = await read(); return s.typeResultText ? s : null; }, { timeout: 5000, what: "typed result" });
    rec.appVerdictText = res.typeResultText;
    rec.answerText = res.back;
    const appRight = /^✓/.test(res.typeResultText);
    rec.appRight = appRight;
    if (right && !appRight) rec.typedMismatch = "model-right-app-wrong";
    if (!right && appRight) rec.typedMismatch = "model-wrong-app-right";
    pressed = appRight ? "right" : "wrong";
    await sleep(100);
    await page.keyboard.press("Enter");
    adv = await waitAdvance(res);
    if (!adv) { await sleep(200); const now = await read(); if (now.idx === res.idx && !now.checkpoint && now.typeResultText) { await page.keyboard.press("Enter"); adv = await waitAdvance(res, { timeout: 8000 }); } }
    if (!adv) throw new Error(`typed card did not advance (n=${n})`);
  }
  rec.pressed = pressed;
  // The app's record of this answer.
  const rows = await newReviewRows(before);
  const r = rows[rows.length - 1];
  rec.review = r ? { id: r.id, card_id: r.card_id, direction: r.direction, counted: r.counted, correct: r.correct, rating: r.rating, answered_at: r.answered_at, state_before: r.state_before } : null;
  rec.reviewRowsNew = rows.length;
  rec.writesRow = true;
  reviewRowsExpected += 1;
  if (!r || r.card_id !== id.cardId || r.direction !== id.dir) rec.REVIEW_MISMATCH = { expected: [id.cardId, id.dir], got: r ? [r.card_id, r.direction] : null };
  if (r && r.correct !== (pressed === "right")) rec.GRADE_MISMATCH = { pressed, recorded: r.correct };
  // The student's memory after seeing the answer.
  const upd = memory.update(it, a, right, tPress);
  rec.S_after = upd.S_after; rec.modelShownAt = tPress;
  answerCount++;
  fs.appendFileSync(ANSWERS, JSON.stringify(rec) + "\n");
  if (rec.REVIEW_MISMATCH || rec.GRADE_MISMATCH || rec.textVsQueueMismatch || rec.ambiguous) logEvent("answer-flag", { n, flags: { rm: rec.REVIEW_MISMATCH, gm: rec.GRADE_MISMATCH, tq: rec.textVsQueueMismatch, amb: rec.identifiedBy } });
  return { adv, rec, it, a, right };
}

// Previous card, to correct a grade given by mistake.
async function correctionEpisode(st, kind) {
  // kind "gotit-then-again": the student didn't know it but pressed Got It.
  const wantModel = kind === "gotit-then-again" ? false : true;
  // Peek the model's verdict for this card before answering.
  const q = st.queue?.[st.idx];
  const id = identify(st.front, null, q);
  const row = rowsById.get(id.cardId);
  const it = memory.item(id.cardId, id.dir, row ? kindOf(row) : "vocab", row ? (row.dates || []).length : 1);
  const tNow = await page.evaluate(() => Date.now());
  const n = answerCount;
  const a0 = memory.assess(it, tNow + thinkMs(n, false));
  const willBeRight = unit("answer", n) < a0.p;
  if (willBeRight !== wantModel || st.retryMarker) return null; // not the right card for this episode
  const mistaken = kind === "gotit-then-again" ? "right" : "wrong";
  const first = await answerOne(st, { forcePress: mistaken });
  logEvent("correction-first-press", { n: first.rec.n, cardId: first.rec.cardId, dir: first.rec.dir, modelRight: first.rec.modelRight, pressed: mistaken, review: first.rec.review });
  if (first.adv.checkpoint) { logEvent("correction-abandoned", { reason: "block ended" }); return first; }
  await page.clock.fastForward(4000);
  await clickButton("Previous card");
  const back = await waitFor(async () => { const s = await read(); return s.idx === first.rec.idx && !s.flipped ? s : null; }, { timeout: 5000, what: "previous card on screen" });
  const again = await flipCard();
  await page.clock.fastForward(2500);
  const tPress = await page.evaluate(() => Date.now());
  const before = await reviewsCount();
  const beforeRow = (await getJson("/__table/card_reviews")).find((x) => x.id === first.rec.review.id);
  const key = first.rec.modelRight ? "ArrowRight" : "ArrowLeft";
  await page.keyboard.press(key);
  const adv = await waitAdvance(again);
  if (!adv) throw new Error("correction did not advance");
  await waitFor(async () => { const r = (await getJson("/__table/card_reviews")).find((x) => x.id === first.rec.review.id); return r && r.answered_at !== beforeRow.answered_at ? r : null; }, { timeout: 8000, what: "corrected review row" }).then((r) => {
    const rec = {
      n: answerCount, correctionOf: first.rec.n, sitting: ctxS.id, block: progress.blockId, blockInSitting: ctxS.blockNo, counter: back.counter, idx: back.idx,
      cardId: first.rec.cardId, dir: first.rec.dir, kind: first.rec.kind, nDates: first.rec.nDates, mode: "flip", prompt: back.front, answerText: again.back,
      simMs: tPress, pressed: first.rec.modelRight ? "right" : "wrong", modelRight: first.rec.modelRight, isCorrection: true,
      review: { id: r.id, card_id: r.card_id, direction: r.direction, counted: r.counted, correct: r.correct, rating: r.rating, answered_at: r.answered_at },
      rowsAdded: 0, writesRow: false, S_after: memory.items.get(`${first.rec.cardId}:${first.rec.dir}`).S, modelShownAt: tPress,
    };
    memory.items.get(`${first.rec.cardId}:${first.rec.dir}`).lastShown = tPress;
    answerCount++;
    fs.appendFileSync(ANSWERS, JSON.stringify(rec) + "\n");
    logEvent("correction-done", { n: rec.n, of: first.rec.n, row: rec.review, beforeRow: { correct: beforeRow.correct, rating: beforeRow.rating, answered_at: beforeRow.answered_at, stability_after: beforeRow.stability_after, due_after: beforeRow.due_after }, afterRow: { stability_after: r.stability_after, due_after: r.due_after } });
  });
  const after = await reviewsCount();
  if (after !== before) logEvent("correction-note", { msg: "row count changed on correction", before, after });
  return { adv };
}

// ─── Blocks and checkpoints ───────────────────────────────────────────────
async function blockStart() {
  await waitAllWrites("block start");
  const st = await read(true);
  progress.blockId++;
  const label = `block-${String(progress.blockId).padStart(3, "0")}`;
  await getJson(`/__snapshot/${label}`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ sitting: ctxS.id, blockNo: ctxS.blockNo, simMs: st.now, simLocal: st.local }) });
  fs.writeFileSync(path.join(DATA, "snapshots", `${label}-app.json`), JSON.stringify({ at: st.now, local: st.local, queue: st.queue, userCards: st.userCardsDigest }));
  // How stale is the deck the app dealt this block from?
  const dbRows = await studentRows();
  const dbBy = new Map(dbRows.map((r) => [r.id, r]));
  let differ = 0; const examples = [];
  for (const d of st.userCardsDigest || []) {
    const r = dbBy.get(d[0]);
    if (!r) { differ++; continue; }
    const same = (a, b) => (a == null && b == null) || (a != null && b != null && new Date(a).getTime() === new Date(b).getTime());
    if (d[1] !== r.fsrs_state || d[4] !== r.en_fsrs_state || !same(d[3], r.last_review) || !same(d[6], r.en_last_review)) {
      differ++;
      if (examples.length < 3) examples.push({ id: d[0], app: [d[1], d[3], d[4], d[6]], db: [r.fsrs_state, r.last_review, r.en_fsrs_state, r.en_last_review] });
    }
  }
  const buckets = {};
  for (const q of st.queue || []) buckets[q.bucket] = (buckets[q.bucket] || 0) + 1;
  logEvent("block-start", { block: progress.blockId, sitting: ctxS.id, blockNo: ctxS.blockNo, simLocal: st.local, counter: st.counter, queueLen: st.queue?.length, buckets, appDeckSize: st.userCardsDigest?.length, dbDeckSize: dbRows.length, appDeckRowsDifferingFromDb: differ, staleExamples: examples });
  saveProgress();
  return st;
}

async function readCheckpoint(st) {
  const cp = st.checkpoint;
  const t = cp.text;
  const summary = (t.match(/(\d+) answers?(?:, (\d+) right first time)?/) || []);
  const areas = [];
  const re = /(Last two weeks of class|Older classes|L'impératif|Adjectif ou adverbe \?|Lesson)\n([^\n]*)\n([\d,]+) of ([\d,]+) seen · about ([\d,]+) remembered/g;
  let m;
  while ((m = re.exec(t))) areas.push({ area: m[1], delta: m[2], seen: +m[3].replace(/,/g, ""), total: +m[4].replace(/,/g, ""), aboutRemembered: +m[5].replace(/,/g, "") });
  return { text: t, answers: summary[1] ? +summary[1] : null, rightFirst: summary[2] ? +summary[2] : null, areas, caughtUp: /You're all caught up/.test(t), hasContinue: cp.hasContinue };
}

async function studyBlock() {
  let st = await waitFor(async () => { const s = await read(); return s.counter || s.checkpoint || s.emptyCaughtUp ? s : null; }, { timeout: 30000, what: "a card or checkpoint" });
  if (st.emptyCaughtUp) { logEvent("empty-caught-up", { simLocal: st.local }); return { caughtUp: true, empty: true }; }
  if (st.checkpoint) return { checkpoint: await readCheckpoint(st) };
  st = await blockStart();
  let answered = 0;
  let correctionDone = !ctxS.correction || ctxS.blockNo > 1;
  let switched = !ctxS.dirSwitch || ctxS.dirSwitched;
  if (ctxS.typing && !st.typeInput) {
    // Switch to typing before the first card is seen.
    await page.evaluate(() => document.querySelector("[data-type-toggle]").click()); await blurActive();
    await waitFor(async () => (await read()).typeInput, { timeout: 5000, what: "typing mode on" });
    logEvent("typing-on", { simLocal: (await read()).local });
  }
  for (;;) {
    st = await read();
    if (st.checkpoint) break;
    if (st.emptyCaughtUp) break;
    if (!st.counter) { await sleep(50); continue; }
    if (!switched && st.idx >= 20) {
      const beforeQ = st.queue;
      await clickButton(ctxS.dirSwitch === "fr" ? "French → English" : "English → French");
      await sleep(300);
      const after = await read();
      ctxS.dirSwitched = true; switched = true;
      logEvent("direction-switch", { to: ctxS.dirSwitch, atIdx: st.idx, counterBefore: st.counter, counterAfter: after.counter, queueBefore: beforeQ, queueAfter: after.queue });
      continue;
    }
    if (!correctionDone && st.idx >= 8 && !st.retryMarker) {
      const r = await correctionEpisode(st, ctxS.correction);
      if (r) { correctionDone = true; answered++; continue; }
    }
    const { adv } = await answerOne(st);
    answered++;
    if (adv.checkpoint) break;
  }
  st = await waitFor(async () => { const s = await read(); return s.checkpoint ? s : null; }, { timeout: 10000, what: "checkpoint" });
  await waitAllWrites("checkpoint");
  st = await read();
  const cp = await readCheckpoint(st);
  return { answered, checkpoint: cp, st };
}

function modelKnown(now, rows) {
  // The student's true chance of knowing each card right now: both ways for a
  // word or phrase. `seenOnly` restricts to cards the app counts as seen.
  const out = { allCards: 0, seenCardsModel: 0, seenCardsModelUnseenSideZero: 0 };
  for (const r of rows) {
    const dirs = isTwoWayRow(r) ? ["fr", "en"] : ["fr"];
    const kind = kindOf(r);
    const ps = dirs.map((d) => {
      const it = memory.items.get(`${r.id}:${d}`);
      const p = memory.pNow(it, now);
      return p == null ? { p: memory.firstSightP(kind, d, (r.dates || []).length), seen: false } : { p, seen: true };
    });
    const both = ps.reduce((x, y) => x * y.p, 1);
    out.allCards += both;
    const appSeen = dirs.some((d) => (d === "fr" ? r.fsrs_state : r.en_fsrs_state) !== 0);
    if (appSeen) {
      out.seenCardsModel += both;
      out.seenCardsModelUnseenSideZero += ps.reduce((x, y) => x * (y.seen ? y.p : 0), 1);
    }
  }
  return out;
}

async function runSitting(s, sittingIndex, schedule) {
  ctxS = { ...s, blockNo: 0 };
  await waitAllWrites(`before ${s.id}`);
  const target = nyToMs(s.date, s.time);
  // The fake clock belongs to this browser process: install once per run, then jump.
  if (!clockInstalled) { await ctx.clock.install({ time: target }); clockInstalled = true; }
  else await ctx.clock.setSystemTime(target);
  if (page) { await page.close().catch(() => {}); page = null; }
  page = await ctx.newPage();
  inflight = 0;
  attach(page);
  await page.goto(APP, { waitUntil: "domcontentloaded" });
  const pageNow = await page.evaluate(() => ({ now: Date.now(), local: new Date().toString() }));
  logEvent("sitting-start", { id: s.id, date: s.date, time: s.time, intended: new Date(target).toISOString(), pageLocal: pageNow.local, driftMs: pageNow.now - target, answersSoFar: answerCount });
  if (Math.abs(pageNow.now - target) > 120000) throw new Error(`page clock off by ${pageNow.now - target} ms`);
  if (s.onboarding) {
    await onboarding(s);
    // New students start in typing mode; this one prefers flipping.
    const st = await read();
    if (st.typeInput) { await page.evaluate(() => document.querySelector("[data-type-toggle]").click()); await blurActive(); await waitFor(async () => !(await read()).typeInput, { timeout: 5000, what: "flip mode" }); logEvent("flip-mode-chosen", {}); }
  } else {
    await rebuildIndex();
  }
  const st0 = await waitFor(async () => { const x = await read(); return x.counter || x.checkpoint || x.emptyCaughtUp ? x : null; }, { timeout: 30000, what: "study view" });
  logEvent("study-view", { counter: st0.counter, dir: st0.dir, typeModeOn: st0.typeModeOn, local: st0.local });
  if (st0.dir && st0.dir !== "mix") { logEvent("direction-not-mixed-on-load", { dir: st0.dir }); await clickButton("Mixed"); }
  let planned = s.blocks;
  if (s.secondPlanned) {
    const remainingFirst = schedule.slice(sittingIndex + 1).length;
    const projected = answerCount + 50 * (1 + 1) + 50 * remainingFirst;
    if (projected <= TARGET_MAX) planned = 2;
    else logEvent("second-block-skipped", { id: s.id, projected, reason: `would exceed ${TARGET_MAX}` });
  }
  const results = [];
  for (let b = 1; b <= planned; b++) {
    ctxS.blockNo = b;
    const r = await studyBlock();
    if (r.empty) { results.push({ block: b, empty: true }); break; }
    const cp = r.checkpoint;
    const now = r.st?.now ?? (await read()).now;
    await getJson(`/__snapshot/cp-${String(progress.blockId).padStart(3, "0")}`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ sitting: s.id, blockNo: b, simMs: now }) });
    const rows = await studentRows();
    const known = modelKnown(now, rows);
    logEvent("checkpoint", { sitting: s.id, blockNo: b, block: progress.blockId, simLocal: r.st?.local, answered: r.answered, ...cp, text: undefined, rawText: cp.text, modelKnown: known });
    results.push({ block: b, answered: r.answered, cp });
    const wantShot = (s.shots || []).includes("last") && (b === planned || !cp.hasContinue) || ((s.shots || []).includes("first") && b === 1);
    if (wantShot) await shot(`${s.id}-${s.date}-block${b}-checkpoint`);
    if (!cp.hasContinue) { logEvent("caught-up", { sitting: s.id, blockNo: b, text: cp.text }); break; }
    if (b < planned) {
      await page.clock.fastForward(15000);
      await clickButton("Continue", "[data-checkpoint]");
      await sleep(200);
    }
  }
  if (s.typing) {
    // Back to flipping for the days after.
    await page.evaluate(() => document.querySelector("[data-type-toggle]").click()); await blurActive(); await sleep(200);
    logEvent("typing-off", { stored: await page.evaluate(() => localStorage.getItem("study-mode")) });
  }
  await waitAllWrites(`end of ${s.id}`);
  progress.done.push(s.id);
  saveProgress();
  logEvent("sitting-end", { id: s.id, answersSoFar: answerCount, blocks: results.length, consoleErrorsSoFar: consoleErrors.length });
}

// ─── Main ─────────────────────────────────────────────────────────────────
const schedule = buildSchedule();
fs.writeFileSync(path.join(DATA, `${PREFIX}-schedule.json`), JSON.stringify(schedule, null, 1));
try {
  for (let i = 0; i < schedule.length; i++) {
    const s = schedule[i];
    if (progress.done.includes(s.id)) continue;
    if (ONLY && !ONLY.has(s.id)) continue;
    await runSitting(s, i, schedule);
  }
  logEvent("run-complete", { answers: answerCount });
} catch (e) {
  logEvent("driver-error", { message: e.message, stack: String(e.stack).slice(0, 2000) });
  if (page) await shot(`error-${Date.now()}`);
  if (page) fs.writeFileSync(path.join(DATA, `${PREFIX}-error-state.json`), JSON.stringify(await read(true).catch(() => null)));
  process.exitCode = 1;
} finally {
  await waitAllWrites("exit").catch(() => {});
  await ctx.close().catch(() => {});
}
