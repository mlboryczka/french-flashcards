// The evaluation harness for repeated cards (2026-10-06), after the owner's
// "make sure the evaluation harness is catching this properly":
//
//   the morning check asking Claude about look-alike cards in study it hasn't
//   judged (api/_lib/statusDaily.js): at most a cap a student a day, newest
//   first, the verdicts kept in card_pairs and judged with at once, a failed
//   or late call leaving its pairs for tomorrow, nothing asked before
//   migration_016 or by the read-only morning check, and each student judged
//   on their own removals and corrections;
//
//   the test of Claude's same-or-different question (api/_lib/repeatsChecks.js):
//   its cases (the cards the 2026-10-06 clean-up put away, with the card each
//   repeats, and the keep-apart pairs), each asked three times, kept as kind
//   "repeats", when it is due, which daily schedule runs it, and the red dot's
//   rule for it (api/_lib/evalStatus.js);
//
//   scripts/record-cleanup-reasons.mjs, which writes why the clean-up put each
//   card away: a dry run only reads, --apply backs up first, writes only those
//   three columns on rows still out of study, refuses before migration_016,
//   and a second run writes nothing.
//
// Against tests/fake-supabase.mjs, a stand-in Supabase over HTTP for the
// script, and a stand-in for Anthropic that answers the same-or-different
// question from a rule the suite sets. No browser, nothing leaves the machine.
process.env.TZ = "America/New_York";

import { createServer } from "node:http";
import { createHash } from "node:crypto";
import { spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { checker } from "../check.mjs";
import { fakeSupabase } from "../fake-supabase.mjs";
import { simulate, USER_ID } from "../simulate/student.mjs";

const ck = checker();
const DAY = 86400000;
const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "..");

// ── The stand-in for Anthropic ────────────────────────────────────────────
// Answers the same-or-different question: "same" for pairs `claude.same`
// holds (by the two Frenches), "different" for the rest, unless `judge` says
// otherwise. `failIf(content)` fails a call (a 500, retried once by the SDK).
const claude = { calls: 0, pairsAsked: [], same: new Set(), judge: null, failIf: null, down: false };
const pairKey = (a, b) => [a, b].sort().join(" | ");
const server = createServer((req, res) => {
  let body = "";
  req.on("data", (c) => (body += c));
  req.on("end", () => {
    const json = JSON.parse(body || "{}");
    claude.calls++;
    const content = typeof json.messages?.[0]?.content === "string" ? json.messages[0].content : "";
    const reply = (text, code = 200) => {
      res.writeHead(code, { "content-type": "application/json" });
      res.end(code === 200 ? JSON.stringify({
        id: "msg", type: "message", role: "assistant", model: "test",
        content: [{ type: "text", text }], stop_reason: "end_turn", usage: { input_tokens: 1, output_tokens: 1 },
      }) : JSON.stringify({ type: "error", error: { type: "api_error", message: "stand-in down" } }));
    };
    if (!String(json.system || "").includes("keep one flashcard for each thing they learn")) return reply("", 500);
    if (claude.down || claude.failIf?.(content)) return reply("", 500);
    const pairs = [...content.matchAll(/Pair (\d+)\n {2}A: (".*?") = (".*?")\n {2}B: (".*?") = (".*?")(?:\n|$)/g)]
      .map((m) => ({ n: Number(m[1]), a: { front: JSON.parse(m[2]), back: JSON.parse(m[3]) }, b: { front: JSON.parse(m[4]), back: JSON.parse(m[5]) } }));
    claude.pairsAsked.push(...pairs);
    const judge = claude.judge || ((a, b) => (claude.same.has(pairKey(a.front, b.front)) ? "same" : "different"));
    reply(JSON.stringify({ verdicts: pairs.map((p) => ({ pair: p.n, verdict: judge(p.a, p.b) })) }));
  });
});
await new Promise((r) => server.listen(0, "127.0.0.1", r));
process.env.ANTHROPIC_BASE_URL = `http://127.0.0.1:${server.address().port}`;
const resetClaude = () => Object.assign(claude, { calls: 0, pairsAsked: [], judge: null, failIf: null, down: false });

const { checkEveryone, judgeLookalikes, loadStudent } = await import("../../api/_lib/statusDaily.js");
const { lookalikes, LOOKALIKES_PER_DAY } = await import("../../src/lib/statusChecks.js");
const { SAME_CARD_VERSION, SAME_CARD_MODEL, PAIRS_PER_CALL } = await import("../../api/_lib/sameCardQuestion.js");
const { cardIndex } = await import("../../src/lib/sameCard.js");
const {
  repeatsCases, repeatsJudge, runRepeatsTest, supabaseRepeatsStore, REPEATS_RUNS, REPEATS_PROMPT_VERSION, summarize,
} = await import("../../api/_lib/repeatsChecks.js");
const { KEEP_APART } = await import("../../api/_lib/keepApart.js");
const { isDue } = await import("../../api/_lib/evalRuns.js");
const { evalStatus } = await import("../../api/_lib/evalStatus.js");
process.env.ANTHROPIC_API_KEY = "sk-test";
const { runFirstDue } = await import("../../api/cahier-daily.js");

// ── Two students and an account with no answers ───────────────────────────
// A: a simulated student studying by the app's rules, whose deck gains, near
// the end, "le cas" beside their "un cas" (the stand-in calls them one card),
// "Naza" again (deleted by the owner, logged in parse_corrections), and
// "La gomme" again (removed in the app, migration_016). B: another student
// with a "Naza" of their own and no corrections. C has never answered.
const rec = simulate({ days: 40, seed: 7, cards: 260, student: "typical" });
const end = Date.parse(rec.answers.at(-1).answered_at) + 3600000;
const at = (daysBack) => new Date(end - daysBack * DAY).toISOString();
const B = "00000000-0000-0000-0000-0000000000bb";
const C = "00000000-0000-0000-0000-0000000000cc";
claude.same.add(pairKey("un cas", "le cas"));

function world({ migrated = true, extraA = [] } = {}) {
  let id = 50000;
  const card = (user, row) => ({ user_id: user, category: "V", dates: [], source: "cahier-upload", fsrs_state: 0, en_fsrs_state: 0, created_at: at(30), id: id++, ...row });
  const planted = [
    card(USER_ID, { front: "un cas", back: "an instance", created_at: at(20) }),
    card(USER_ID, { front: "le cas", back: "the case", created_at: at(2) }),
    card(USER_ID, { front: "Naza", back: "Naza (a brand name)", created_at: at(3) }),
    card(USER_ID, { front: "la gomme", back: "the eraser", source: "archived:cahier-upload", created_at: at(30), ...(migrated ? { archived_reason: "removed", archived_at: at(10) } : {}) }),
    card(USER_ID, { front: "La gomme", back: "the rubber (eraser)", created_at: at(4) }),
    ...extraA.map((row) => card(USER_ID, row)),
  ];
  const bCards = [card(B, { front: "Naza", back: "Naza (a name)", created_at: at(3) }), card(B, { front: "la plage", back: "the beach", created_at: at(30) })];
  const bAnswer = { ...rec.answers.find((r) => r.counted), id: "b-answer-1", user_id: B, card_id: bCards[1].id };
  const db = fakeSupabase({
    migrated,
    tables: {
      user_cards: [...rec.cards, ...planted, ...bCards],
      card_reviews: [...rec.answers, bAnswer],
      dealt_sets: [...rec.deals],
      fsrs_settings: [rec.settings],
      parse_corrections: [
        { id: "pc1", user_id: USER_ID, action: "delete", category: "other", card_id: 3242, original_front: "Naza", original_back: "Naza (proper noun/brand name)", created_at: at(60) },
      ],
    },
  });
  db.auth = { admin: { listUsers: async () => ({ data: { users: [{ id: USER_ID, email: "a@example.com" }, { id: B, email: "b@example.com" }, { id: C, email: "c@example.com" }] }, error: null }) } };
  return db;
}
const byEmail = (reports) => Object.fromEntries(reports.map((r) => [r.user_email, r]));
const resultOf = (r, id) => r?.report?.results?.find((x) => x.id === id);
const judge = (extra = {}) => ({ apiKey: "sk-test", deadline: Date.now() + 60000, ...extra });

console.log("\n  the morning check asks Claude about look-alikes it hasn't judged");
{
  resetClaude();
  const db = world();
  const reports = byEmail(await checkEveryone(db, { now: end, judge: judge({ cap: 3 }) }));
  const a = reports["a@example.com"];
  const j = a?.report?.judging;
  ck("the students who have answered are checked; the one who hasn't is left out", a && reports["b@example.com"] && !reports["c@example.com"]);
  ck("it asks about no more than the cap for a student", j?.asked === 3 && claude.pairsAsked.length === 3, JSON.stringify(j));
  ck("  the newest cards first: “le cas”, made two days ago, is asked about first",
     claude.pairsAsked.some((p) => pairKey(p.a.front, p.b.front) === pairKey("un cas", "le cas")), JSON.stringify(claude.pairsAsked.map((p) => [p.a.front, p.b.front])));
  const all = lookalikes({ cards: db.tables.user_cards.filter((c) => c.user_id === USER_ID), pairs: [] }).unjudged.length;
  ck("  and says what is left for tomorrow", j.left === all - 3 && j.answered === 3 && j.same === 1 && !j.error, `${all} look-alike pairs; ${JSON.stringify(j)}`);
  const kept = db.tables.card_pairs;
  ck("every verdict is kept: both cards' ids and text, the verdict, the question's version and model, from the check",
     kept.length === 3 && kept.every((p) => p.user_id === USER_ID && p.card_a != null && p.card_b != null && p.a_front && p.b_front && p.version === SAME_CARD_VERSION && p.model === SAME_CARD_MODEL && p.source === "check"),
     JSON.stringify(kept[0]));
  const repeats = resultOf(a, "repeats");
  ck("and the check judges with them at once: the pair Claude called one card fails it, named",
     repeats?.status === "fail" && /“un cas” and “le cas” are one card twice: Claude judged them the same card to learn/.test(repeats.details.join(" ")), repeats?.details?.[0]);
  const back = resultOf(a, "nothing-back");
  ck("the card the owner deleted and the card the student removed, both made again, fail the other check",
     back?.status === "fail" && back.details.some((d) => /“Naza” is back in study: you deleted it/.test(d)) && back.details.some((d) => /“La gomme” is back in study: you removed “la gomme”/.test(d)), back?.details?.join(" | "));
  const b = reports["b@example.com"];
  ck("another student's own “Naza” isn't the owner's deletion: their check doesn't fail for it", resultOf(b, "nothing-back")?.status !== "fail", resultOf(b, "nothing-back")?.summary);

  // The next morning: the next pairs, none asked twice.
  const first = claude.pairsAsked.map((p) => pairKey(p.a.front, p.b.front));
  claude.pairsAsked = [];
  const again = byEmail(await checkEveryone(db, { now: end, judge: judge({ cap: 3 }) }))["a@example.com"].report.judging;
  const second = claude.pairsAsked.map((p) => pairKey(p.a.front, p.b.front));
  ck("the next morning it asks about the next pairs, none it has judged", again.asked === 3 && second.every((k) => !first.includes(k)) && db.tables.card_pairs.length === 6,
     JSON.stringify({ first, second }));
  ck("  and fewer are left", again.left === all - 6, JSON.stringify(again));

  // The read-only morning check: no question, nothing written.
  resetClaude();
  const writes = () => db.calls.filter((c) => c.op && c.op !== "select").length;
  const w0 = writes();
  await checkEveryone(db, { now: end });
  ck("checked without `judge` (the morning check on the Mac, Check everyone now): no question, nothing written", claude.calls === 0 && writes() === w0, `${claude.calls} calls, ${writes() - w0} writes`);
}

console.log("\n  a question Claude can't answer leaves its pairs for tomorrow");
{
  resetClaude();
  const db = world();
  claude.down = true;
  const r = byEmail(await checkEveryone(db, { now: end, judge: judge() }))["a@example.com"];
  const j = r.report.judging;
  ck("Claude down: nothing kept, and the report says Claude couldn't be asked", db.tables.card_pairs.length === 0 && /Claude couldn't be asked about \d+/.test(j.error || "") && j.answered === 0, JSON.stringify(j));
  ck("  every pair still left for tomorrow", j.left === j.asked && j.asked > 0);
  ck("  and the check waits rather than passing or failing on a guess", resultOf(r, "repeats").status === "wait", resultOf(r, "repeats").summary);

  // More than one call: one fails, the other's verdicts are kept.
  resetClaude();
  // Sixty pairs like "un livre W" (a scarlet volume) and "le livre W" (the
  // red book): alike once the article is set aside, not surely one card,
  // and each W far from the others.
  const word = (i) => [...createHash("sha1").update(String(i)).digest("hex").slice(0, 8)].map((h) => String.fromCharCode(97 + parseInt(h, 16))).join("");
  const many = Array.from({ length: 60 }, (_, i) => [
    { front: `un livre ${word(i)}`, back: "a scarlet volume", created_at: at(20) },
    { front: `le livre ${word(i)}`, back: "the red book", created_at: at(1) },
  ]).flat();
  const db2 = world({ extraA: many });
  const unjudged = lookalikes({ cards: db2.tables.user_cards.filter((c) => c.user_id === USER_ID), pairs: [] }).unjudged;
  const firstCall = unjudged.slice(0, PAIRS_PER_CALL).map((p) => p.b.front);
  claude.failIf = (content) => content.includes(JSON.stringify(firstCall[0]));
  const r2 = byEmail(await checkEveryone(db2, { now: end, judge: judge({ cap: 120 }) }))["a@example.com"].report.judging;
  ck(`(${unjudged.length} pairs, so two calls of up to ${PAIRS_PER_CALL})`, unjudged.length > PAIRS_PER_CALL && unjudged.length <= 120);
  ck("one call failing leaves only its own pairs unjudged; the other call's are kept",
     db2.tables.card_pairs.length === unjudged.length - PAIRS_PER_CALL && r2.answered === unjudged.length - PAIRS_PER_CALL && /No answer about 50/.test(r2.error || ""), JSON.stringify(r2));
  ck("  and they are left for tomorrow", r2.left === PAIRS_PER_CALL, JSON.stringify(r2));
  claude.failIf = null;
  claude.pairsAsked = [];
  const r3 = byEmail(await checkEveryone(db2, { now: end, judge: judge({ cap: 120 }) }))["a@example.com"].report.judging;
  ck("  the next morning those are asked again, and nothing else", r3.asked === PAIRS_PER_CALL && r3.left === 0 && !r3.error, JSON.stringify(r3));

  // No time left: nothing started.
  resetClaude();
  const db3 = world();
  const late = byEmail(await checkEveryone(db3, { now: end, judge: judge({ startBy: Date.now() - 1000 }) }))["a@example.com"].report.judging;
  ck("past its start time the run asks nothing, and says so", claude.calls === 0 && late.asked === 0 && late.left > 0 && /no time left/.test(late.skipped || ""), JSON.stringify(late));
}

console.log("\n  before migration_016");
{
  resetClaude();
  const db = world({ migrated: false });
  const reports = byEmail(await checkEveryone(db, { now: end, judge: judge() }));
  const a = reports["a@example.com"];
  ck("nothing is asked: there is nowhere to keep a verdict", claude.calls === 0 && /migration_016/.test(a.report.judging?.skipped || ""), JSON.stringify(a.report.judging));
  ck("the look-alike check waits", resultOf(a, "repeats").status === "wait" && /migration_016/.test(resultOf(a, "repeats").summary), resultOf(a, "repeats").summary);
  const back = resultOf(a, "nothing-back");
  ck("the owner's deletion, made again, still fails: parse_corrections is there already", back.status === "fail" && back.details.some((d) => /“Naza”/.test(d)), back.summary);
  ck("  but the removal the record can't hold yet isn't claimed", !back.details.some((d) => /gomme/.test(d)), back.details.join(" | "));
  const rec0 = await loadStudent(db, { id: USER_ID, email: "a@example.com" });
  ck("the record says the table is missing, not empty", rec0.pairsTable === false && rec0.pairs === null && Array.isArray(rec0.corrections));
}

console.log("\n  the near search, as the morning check asks it");
{
  // Drills answer in French. Compared as English, "ils vivent" and "ils
  // suivent" share "ils", and every "→ ils/elles" drill was put to Claude
  // beside every other (95 of the 958 pairs the owner's deck raised).
  const drills = [
    { id: 1, front: "vivre (présent) → ils/elles", back: "ils vivent" },
    { id: 2, front: "suivre (présent) → ils/elles", back: "ils suivent" },
    { id: 3, front: "vendre (présent) → ils/elles", back: "ils vendent" },
    { id: 4, front: "aller → il/elle", back: "il va" },
    { id: 5, front: "aller (présent) → il/elle", back: "il va" },
  ];
  const idx = cardIndex(drills);
  const near = (id) => idx.near(drills.find((d) => d.id === id)).map((c) => c.id);
  ck("drills of different verbs are not look-alikes", !near(1).includes(2) && !near(1).includes(3) && !near(2).includes(3), JSON.stringify([near(1), near(2)]));
  ck("the same drill with and without its tense still is", near(4).includes(5), JSON.stringify(near(4)));
  ck("and a phrase one word longer, its English agreeing, still is",
     cardIndex([{ id: 1, front: "je suis allé au marché", back: "I went to the market" }]).near({ id: 2, front: "je suis allé au grand marché", back: "I went to the big market" }).length === 1);
}

console.log("\n  judgeLookalikes on its own");
{
  // The cap is a student's, not the run's.
  let asked = 0;
  const fake = { from: () => ({ insert: async () => ({ error: null }) }) };
  const recs = [1, 2].map((n) => ({
    student: { id: `s${n}` }, pairsTable: true, pairs: [],
    cards: [{ id: n * 10, front: "un cas", back: "an instance" }, { id: n * 10 + 1, front: "le cas", back: "the case" }, { id: n * 10 + 2, front: "la poste", back: "the post office" }, { id: n * 10 + 3, front: "le poste", back: "the job" }],
  }));
  await judgeLookalikes(fake, recs, { apiKey: "k", cap: 1, ask: async ({ pairs }) => { asked += pairs.length; return pairs.map(() => "different"); } });
  ck("each student gets up to the cap, in one question for the whole run", asked === 2 && recs.every((r) => r.judging.asked === 1 && r.judging.left === 1), JSON.stringify(recs.map((r) => r.judging)));
  const failing = { from: () => ({ insert: async () => ({ error: { message: "no room" } }) }) };
  const r = { student: { id: "s3" }, pairsTable: true, pairs: [], cards: recs[0].cards };
  await judgeLookalikes(failing, [r], { apiKey: "k", ask: async ({ pairs }) => pairs.map(() => "same") });
  ck("verdicts that can't be kept aren't judged with, and the report says why", r.pairs.length === 0 && /couldn't be kept: no room/.test(r.judging.error), JSON.stringify(r.judging));
  ck("the daily cap is a few hundred a student", LOOKALIKES_PER_DAY === 200);
}

console.log("\n  the test of Claude's same-or-different question");
{
  const duplicates = [
    { id: 3425, front: "rends-moi mon livre", back: "give me back my book", merged_into: 17247 },
    { id: 2670, front: "manquer / rater", back: "to miss", merged_into: 14827 },
    { id: 17643, front: "ouvert", back: "opened", merged_into: 6247 },
  ];
  const kept = [
    { id: 17247, front: "Rends-moi mon livre !", back: "Give me my book back!" },
    { id: 14827, front: "manquer", back: "to miss" },
    { id: 6247, front: "ouvert (adj)", back: "open" },
  ];
  const cases = repeatsCases({ duplicates, kept });
  ck("its cases: each card put away as a repeat with the card it repeats, said to be the same",
     cases.filter((c) => c.says === "same").length === 3 && cases.some((c) => c.id === "dup:2670" && c.a.front === "manquer" && c.b.front === "manquer / rater"));
  ck("and every keep-apart pair, said to be different", cases.filter((c) => c.says === "different").length === KEEP_APART.length && KEEP_APART.length >= 8);
  ck("  the plan's eight among them", ["ou", "la-poste", "fin", "etat", "voler", "planter", "vieux", "mieux"].every((id) => cases.some((c) => c.id === `apart:${id}`)));
  ck("  in the same mixed order every run", JSON.stringify(repeatsCases({ duplicates, kept }).map((c) => c.id)) === JSON.stringify(cases.map((c) => c.id)) &&
     cases.slice(0, 6).some((c) => c.says === "same") !== cases.slice(0, 6).every((c) => c.says === "same"));
  // The keep-apart pairs are what the card-writers would ask about: none is
  // surely one card, and most are near look-alikes.
  const nearOnes = KEEP_APART.filter((p) => cardIndex([{ ...p.a, id: 1 }]).near({ ...p.b, id: 2 }).length > 0);
  ck("  no keep-apart pair is surely one card by the rule, and most are put to Claude in real use", KEEP_APART.every((p) => !cardIndex([p.a]).sure(p.b)) && nearOnes.length >= KEEP_APART.length - 3, `${nearOnes.length} of ${KEEP_APART.length} near`);

  const memory = ({ missing = false } = {}) => {
    const s = { saved: [] };
    const gone = { missing: true };
    return Object.assign(s, {
      async duplicates() { return missing ? gone : { rows: duplicates }; },
      async cards(ids) { return { rows: kept.filter((k) => ids.includes(k.id)) }; },
      async runs() { return missing ? gone : { rows: [...s.saved].reverse() }; },
      async saveRun(row) { const run = { id: `run${s.saved.length + 1}`, ran_at: new Date().toISOString(), ...row }; s.saved.push(run); return { row: run }; },
    });
  };
  resetClaude();
  // Claude right on everything but "ouvert" (says different every time) and
  // "voler" (says same once in three).
  let volerAsked = 0;
  claude.judge = (a, b) => {
    const k = pairKey(a.front, b.front);
    if (k === pairKey("ouvert (adj)", "ouvert")) return "different";
    if (a.front === "voler" && b.front === "voler") return ++volerAsked === 2 ? "same" : "different";
    return cases.find((c) => pairKey(c.a.front, c.b.front) === k && c.a.back === a.back)?.says || "different";
  };
  const store = memory();
  const out = await runRepeatsTest({ store, apiKey: "sk-test", deadline: Date.now() + 60000 });
  const run = store.saved[0];
  ck(`every case is asked ${REPEATS_RUNS} times, the way the app asks (rounds of one question each)`,
     run && run.results.every((c) => c.got.length === REPEATS_RUNS && c.got.every((v) => v === "same" || v === "different")) && claude.calls === REPEATS_RUNS, `${claude.calls} calls`);
  ck("the run is kept as kind “repeats”, with the question's version and model",
     run.kind === "repeats" && run.version === SAME_CARD_VERSION && run.version === REPEATS_PROMPT_VERSION && run.model === SAME_CARD_MODEL);
  const o = (id) => repeatsJudge(run.results.find((c) => c.id === id));
  ck("a case Claude gets right every time passes, wrong every time fails, and one in between is mixed",
     o("dup:2670") === "pass" && o("dup:17643") === "fail" && o("apart:voler") === "mixed", [o("dup:2670"), o("dup:17643"), o("apart:voler")].join(", "));
  ck("and the run is counted", out.summary.cases === cases.length && out.summary.never === 1 && out.summary.sometimes === 1 && out.summary.every === cases.length - 2 &&
     run.passed === out.summary.every && out.summary.same_cases === 3, JSON.stringify(out.summary));
  ck("each case keeps both cards' text, for naming it later", run.results.every((c) => c.a?.front && c.b?.front));

  resetClaude();
  const before = await runRepeatsTest({ store: memory({ missing: true }), apiKey: "sk-test" });
  ck("before migration_016 it waits, and asks nothing", /migration_016/.test(before.skipped || "") && claude.calls === 0, JSON.stringify(before));
  claude.down = true;
  const s2 = memory();
  const down = await runRepeatsTest({ store: s2, apiKey: "sk-test", deadline: Date.now() + 60000 });
  ck("Claude down: nothing kept, and it says why", /Claude couldn't be asked/.test(down.skipped || "") && s2.saved.length === 0, JSON.stringify(down));
  resetClaude();

  // Due: the other tests' rule.
  const latest = { ran_at: new Date().toISOString(), version: REPEATS_PROMPT_VERSION };
  ck("due when never run, not the day after a run, due a week later, and due when the question changes",
     isDue(null, REPEATS_PROMPT_VERSION) && !isDue(latest, REPEATS_PROMPT_VERSION, Date.now() + DAY) &&
     isDue(latest, REPEATS_PROMPT_VERSION, Date.now() + 7 * DAY) && isDue({ ...latest, version: "0000000" }, REPEATS_PROMPT_VERSION));

  // On Supabase: before and after migration_016.
  const old = fakeSupabase({ migrated: false, tables: { user_cards: [{ id: 1, user_id: USER_ID, front: "x", back: "y" }], eval_runs: [] } });
  ck("on the database before migration_016, the store says it's waiting", (await supabaseRepeatsStore(old).duplicates()).missing === true);
  const fresh = fakeSupabase({ tables: {
    user_cards: [
      { id: 1, user_id: USER_ID, front: "manquer / rater", back: "to miss", source: "archived:cahier-upload", archived_reason: "duplicate", merged_into: 2 },
      { id: 2, user_id: USER_ID, front: "manquer", back: "to miss", source: "cahier-upload" },
      { id: 3, user_id: USER_ID, front: "Naza", back: "Naza", source: "archived:cahier-upload", archived_reason: "removed", merged_into: null },
      { id: 4, user_id: USER_ID, front: "x", back: "y", source: "archived:cahier-upload", archived_reason: "duplicate", merged_into: null },
    ],
    eval_runs: [],
  } });
  const st = supabaseRepeatsStore(fresh);
  const d = await st.duplicates();
  ck("after it, the cases are the cards put away as a repeat that name the card they repeat", d.rows?.length === 1 && d.rows[0].id === 1, JSON.stringify(d));
  resetClaude();
  claude.judge = () => "same";
  const real = await runRepeatsTest({ store: st, apiKey: "sk-test", deadline: Date.now() + 60000 });
  ck("and a run is kept in eval_runs", real.run?.kind === "repeats" && fresh.tables.eval_runs.length === 1 && fresh.tables.eval_runs[0].results.some((c) => c.id === "dup:1"), JSON.stringify(real.summary));
  resetClaude();
}

console.log("\n  the red dot, as for the other tests");
{
  const caseOf = (id, says, got, a = "ou", b = "où") => ({ id, says, a: { front: a, back: "x" }, b: { front: b, back: "y" }, got });
  const runs = (prevVersion, latestVersion) => [
    { id: "r1", kind: "repeats", ran_at: "2026-10-07T15:00:00Z", version: prevVersion, cases: 2, passed: 2, summary: {}, results: [caseOf("apart:ou", "different", ["different", "different", "different"]), caseOf("dup:1", "same", ["same", "same", "same"], "manquer", "manquer / rater")] },
    { id: "r2", kind: "repeats", ran_at: "2026-10-14T15:00:00Z", version: latestVersion, cases: 2, passed: 0, summary: {}, results: [caseOf("apart:ou", "different", ["same", "same", "different"]), caseOf("dup:1", "same", ["different", "different", "different"], "manquer", "manquer / rater")] },
  ];
  const changed = await evalStatus(fakeSupabase({ tables: { eval_runs: runs("aaaaaaa", "bbbbbbb") } }));
  ck("a case that passed before a change to the question and fails after it is named, in plain words",
     changed.repeats.regressions.length === 2 &&
     changed.repeats.regressions.some((l) => /it calls “ou” and “où” the same card, which it kept apart before/.test(l)) &&
     changed.repeats.regressions.some((l) => /it calls “manquer” and “manquer \/ rater” two different cards, which it judged one card before/.test(l)),
     changed.repeats.regressions.join(" | "));
  ck("  with its last run", changed.repeats.latest?.version === "bbbbbbb");
  const same = await evalStatus(fakeSupabase({ tables: { eval_runs: runs("bbbbbbb", "bbbbbbb") } }));
  ck("between two runs of the same question nothing is named: that is chance", same.repeats.regressions.length === 0);
}

console.log("\n  which daily schedule runs it");
{
  const quiet = { log: console.log };
  console.log = () => {};
  const ran = [];
  const fakeTest = (kind, { due = true, skipped = null, missing = false } = {}) => ({
    store: { runs: async () => (missing ? { missing: true } : { rows: due ? [] : [{ ran_at: new Date().toISOString(), version: "v" }] }) },
    version: "v",
    run: async () => { ran.push(kind); return skipped ? { skipped } : { run: { id: kind }, summary: {} }; },
  });
  const tests = (spec) => (kind) => fakeTest(kind, spec[kind] || {});
  const step = async (order, spec) => { ran.length = 0; const r = await runFirstDue(order, tests(spec)); return { r, ran: [...ran] }; };
  const s1 = await step(["answers", "repeats"], { answers: { due: false } });
  const s2 = await step(["answers", "repeats"], {});
  const s3 = await step(["notes", "repeats"], { notes: { skipped: "No corrections to test yet." } });
  const s4 = await step(["notes", "repeats"], { notes: { due: false }, repeats: { due: false } });
  const s5 = await step(["answers", "repeats"], { answers: { missing: true }, repeats: { missing: true } });
  console.log = quiet.log;
  ck("a schedule whose own test isn't due runs the look-alike test", s1.r.test === "repeats" && s1.ran.join() === "repeats", JSON.stringify(s1));
  ck("its own test comes first when due, and the other waits", s2.r.test === "answers" && s2.ran.join() === "answers", JSON.stringify(s2));
  ck("its own test with nothing to test gives way", s3.r.test === "repeats" && s3.ran.join() === "notes,repeats", JSON.stringify(s3));
  ck("nothing due: nothing runs", s4.r.skipped === "not due" && s4.ran.length === 0);
  ck("before migration_015: says so", s5.r.skipped === "migration_015 not run" && s5.ran.length === 0);
  const vercel = JSON.parse(fs.readFileSync(path.join(ROOT, "vercel.json"), "utf8"));
  ck("no new schedule: four, each daily", vercel.crons.length === 4 && vercel.crons.every((c) => /^0 \d+ \* \* \*$/.test(c.schedule)));
}

console.log("\n  scripts/record-cleanup-reasons.mjs");
{
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "cleanup-reasons-"));
  const OWNER = "11111111-1111-1111-1111-111111111111";
  const row = (id, front, back, source = "archived:cahier-upload", extra = {}) => ({ id, user_id: OWNER, front, back, source, archived_reason: null, archived_at: null, merged_into: null, ...extra });
  const rows = new Map([
    row(3425, "rends-moi mon livre", "give me back my book"),
    row(17247, "Rends-moi mon livre !", "Give me my book back!", "lesson:lecon1#abc"),
    row(2670, "manquer / rater", "to miss"),
    row(14827, "rater", "to miss (a train)", "cahier-upload"),
    row(14828, "manquer", "to miss", "cahier-upload"),
    row(16650, "après", "after", "lesson:lecon2#46u"),
    row(3836, "ensuite / après", "then / afterwards", "cahier-upload"),
    row(15732, "Naza", "Naza (proper noun)"),
    row(15050, "Je parle jamais de Pierre.", "I never talk about Pierre"),
    row(2808, "Je parle jamais de Pierre", "I never talk about Pierre", "cahier-upload"),
  ].map((r) => [r.id, r]));
  const plan = {
    plan: { owner: [
      { user: "owner@example.com", kind: "lesson", keep: [17247], archive: [3425], note: "finder#1" },
      { user: "owner@example.com", kind: "list", keep: [14827, 14828], archive: [2670], note: "list->singles" },
      { user: "owner@example.com", kind: "spelling", keep: [3836], archive: [16650], note: "finder#28" },
    ] },
    resurrected: [{ archive: [15732], why: "deleted by the owner" }, { archive: [15050], unarchive: [2808], why: "the owner's correction" }],
  };
  const backupRows = [...rows.values()].map((r) => ({ ...r, source: r.source.replace(/^archived:/, "") }));
  fs.writeFileSync(path.join(dir, "plan.json"), JSON.stringify(plan));
  const backupFile = path.join(dir, "cleanup-duplicates-2026-10-06T22-43-16-564Z.json");
  fs.writeFileSync(backupFile, JSON.stringify({ note: "before", rows: backupRows }));

  const state = { migrated: false, requests: [], backupSeenAtFirstWrite: null };
  const KEY = "stand-in-service-key";
  const db = createServer((req, res) => {
    let body = "";
    req.on("data", (c) => (body += c));
    req.on("end", () => {
      const url = new URL(req.url, "http://x");
      state.requests.push({ method: req.method, path: url.pathname, query: url.search, body: body ? JSON.parse(body) : null });
      const send = (code, json) => { res.writeHead(code, { "content-type": "application/json" }); res.end(JSON.stringify(json)); };
      if (req.headers.apikey !== KEY) return send(401, { message: "no key" });
      if (url.pathname !== "/rest/v1/user_cards") return send(404, { code: "PGRST205" });
      const cols = (url.searchParams.get("select") || "").split(",");
      if (!state.migrated && cols.some((c) => ["archived_reason", "archived_at", "merged_into"].includes(c))) return send(400, { code: "42703", message: "column user_cards.archived_reason does not exist" });
      if (req.method === "GET") {
        const ids = (url.searchParams.get("id") || "").replace(/^in\.\(|\)$/g, "").split(",").map(Number);
        return send(200, ids.map((id) => rows.get(id)).filter(Boolean).map((r) => Object.fromEntries(cols.map((c) => [c, r[c] ?? null]))));
      }
      if (req.method === "PATCH") {
        if (state.backupSeenAtFirstWrite === null) state.backupSeenAtFirstWrite = fs.readdirSync(path.join(dir, "out")).length;
        const id = Number(url.searchParams.get("id").replace("eq.", ""));
        const r = rows.get(id);
        const ok = r && r.user_id === url.searchParams.get("user_id").replace("eq.", "") && r.source.startsWith("archived:") &&
          url.searchParams.get("source") === "like.archived:*" && url.searchParams.get("archived_reason") === "is.null" && r.archived_reason == null;
        if (!ok) return send(200, []);
        Object.assign(r, JSON.parse(body));
        return send(200, [r]);
      }
      return send(405, { message: "no" });
    });
  });
  await new Promise((r) => db.listen(0, "127.0.0.1", r));
  const SCRIPT = path.join(ROOT, "scripts", "record-cleanup-reasons.mjs");
  const run = (extra = []) => new Promise((resolve) => {
    const c = spawn(process.execPath, [SCRIPT, "--plan", path.join(dir, "plan.json"), "--backup", backupFile, "--backups-dir", path.join(dir, "out"), ...extra], {
      env: { PATH: process.env.PATH, HOME: process.env.HOME, SUPABASE_URL: `http://127.0.0.1:${db.address().port}`, SUPABASE_SERVICE_ROLE_KEY: KEY },
    });
    let out = "";
    c.stdout.on("data", (d) => (out += d));
    c.stderr.on("data", (d) => (out += d));
    c.on("exit", (code) => resolve({ code, out }));
  });

  const dry = await run();
  ck("a dry run before migration_016 says what it would write, and that the migration comes first",
     dry.code === 0 && /3425 “rends-moi mon livre”: repeats 17247/.test(dry.out) && /migration_016 hasn't been run yet/.test(dry.out), dry.out.split("\n").slice(0, 3).join(" | "));
  ck("  a list card is the repeat of the kept card the rule finds closest", /2670 “manquer \/ rater”: repeats 14828 “manquer”/.test(dry.out), dry.out.match(/2670[^\n]*/)?.[0]);
  ck("  a deleted card that came back is marked removed; the uncorrected copy repeats the corrected card",
     /15732 “Naza”: removed/.test(dry.out) && /15050 “Je parle jamais de Pierre\.”: repeats 2808/.test(dry.out));
  ck("  a card back in study since (a lesson took it over) is left alone, and said so", /16650 “après”: back in study since the clean-up, left alone/.test(dry.out));
  ck("  and it only read", state.requests.every((q) => q.method === "GET"));
  const refused = await run(["--apply"]);
  ck("--apply before migration_016 refuses and writes nothing", refused.code === 1 && state.requests.every((q) => q.method === "GET"), refused.out.trim().split("\n").at(-1));

  state.migrated = true;
  state.requests = [];
  const dry2 = await run();
  ck("after it, a dry run still only reads", dry2.code === 0 && /Dry run: nothing written/.test(dry2.out) && state.requests.every((q) => q.method === "GET"));
  const applied = await run(["--apply"]);
  const patches = state.requests.filter((q) => q.method === "PATCH");
  ck("--apply writes the four it can", applied.code === 0 && patches.length === 4 && /Recorded 4 of 4/.test(applied.out), applied.out.trim().split("\n").at(-1));
  ck("  backing every row up before the first write", state.backupSeenAtFirstWrite === 1 && JSON.parse(fs.readFileSync(path.join(dir, "out", fs.readdirSync(path.join(dir, "out"))[0]), "utf8")).rows.length === 4);
  ck("  only the reason, the card it repeats and when", patches.every((q) => Object.keys(q.body).sort().join() === "archived_at,archived_reason,merged_into" && q.body.archived_at === "2026-10-06T22:43:16.564Z"));
  ck("  only on a row still out of study with no reason yet", patches.every((q) => /source=like.archived/.test(q.query) && /archived_reason=is.null/.test(q.query)));
  ck("  and the rows say it", rows.get(3425).archived_reason === "duplicate" && rows.get(3425).merged_into === 17247 && rows.get(15732).archived_reason === "removed" && rows.get(15732).merged_into === null &&
     rows.get(15050).merged_into === 2808 && rows.get(16650).archived_reason === null && rows.get(17247).source === "lesson:lecon1#abc");
  state.requests = [];
  const twice = await run(["--apply"]);
  ck("a second --apply writes nothing", twice.code === 0 && !state.requests.some((q) => q.method === "PATCH") && /already recorded/.test(twice.out), twice.out.trim().split("\n").at(-1));
  db.close();
  fs.rmSync(dir, { recursive: true, force: true });
}

server.close();
const n = ck.fails();
console.log(n ? `\n  FAILED: ${n}` : "\n  all checks passed");
process.exit(n ? 1 : 0);
