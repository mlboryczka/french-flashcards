// Which lines of a student's notes have already been read (2026-10-06). Pure,
// with no imports, so the server and the status checks share it.
//
// Every upload used to ask Claude to read every class again, and Claude
// writes the same line a little differently each time: a full stop, a
// capital, a label, "ne" dropped. On 4 September a re-upload of the owner's
// notebook added 44 cards they already had. Now one record per student keeps
// a short fingerprint of every line already read, grouped by class, and a run
// reads only lines not read before. The upload (paste or file, add or
// Replace), the linked notebook, the daily check, Check now, relinking and a
// copy of the doc all share it (notes_read, migration_016). So:
//
//   an unchanged re-upload reads nothing and adds nothing;
//   an updated notebook has only its new classes read;
//   a line added to an old class is read on its own, the class sent along so
//   Claude has the context;
//   a corrected line is read once, and its card then goes through the
//   matching rule (src/lib/sameCard.js), so a fixed typo adds no card;
//   a class whose date line was retyped is recognised by its lines and makes
//   no card, even when its new date, or its old one, is another class's too.
//
// The record fills itself the first time, without reading anything: a class
// whose date is on any of the student's cards (archived ones too), or that
// the linked notebook already read, counts as read, every line of it. This is
// decided class by class, for as long as the record has no lines for that
// class.

// A line as it is compared: the same line retyped with other spacing, quotes,
// dashes or capitals is the same line. Accents and words are not.
export function normalizeLine(line) {
  return String(line ?? "")
    .normalize("NFC")
    .replace(/[​-‍﻿]/g, "")
    .replace(/ /g, " ")
    .replace(/[’‘`´]/g, "'")
    .replace(/[“”«»]/g, '"')
    .replace(/[–—]/g, "-")
    .replace(/^\s*(?:[•·▪◦*-]|\d+[.)])\s+/, "")
    .toLowerCase()
    .replace(/\s+/g, " ")
    .replace(/[\s.;,…]+$/, "")
    .trim();
}

// cyrb53: a 53-bit hash, plenty for a few thousand lines a student, and the
// same in the browser and on the server.
function cyrb53(str) {
  let h1 = 0xdeadbeef;
  let h2 = 0x41c6ce57;
  for (let i = 0; i < str.length; i++) {
    const ch = str.charCodeAt(i);
    h1 = Math.imul(h1 ^ ch, 2654435761);
    h2 = Math.imul(h2 ^ ch, 1597334677);
  }
  h1 = Math.imul(h1 ^ (h1 >>> 16), 2246822507) ^ Math.imul(h2 ^ (h2 >>> 13), 3266489909);
  h2 = Math.imul(h2 ^ (h2 >>> 16), 2246822507) ^ Math.imul(h1 ^ (h1 >>> 13), 3266489909);
  return 4294967296 * (2097151 & h2) + (h1 >>> 0);
}

export const lineFingerprint = (line) => cyrb53(normalizeLine(line)).toString(36);

// A section heading makes no card, so it is never a line to read.
const HEADING = /^(?:(?:vocabulaire|vocab|expressions?|prononciation|grammaire|et|&|\/|-|:|,)\s*)+$/i;

// The lines of a class worth reading: not blank, not a heading, each once.
export function classLines(text) {
  const seen = new Set();
  const out = [];
  for (const raw of String(text ?? "").split(/\r?\n/)) {
    const norm = normalizeLine(raw);
    if (!norm || HEADING.test(norm)) continue;
    const fp = lineFingerprint(raw);
    if (seen.has(fp)) continue;
    seen.add(fp);
    out.push({ text: raw.trim(), fp });
  }
  return out;
}

// Every class date on the student's cards, and every class the linked
// notebook already read: what the record is filled from.
export function readDatesFrom(rows = [], linkClasses = null) {
  const out = new Set();
  for (const row of rows) for (const d of Array.isArray(row?.dates) ? row.dates : []) if (typeof d === "string") out.add(d);
  for (const d of Object.keys(linkClasses || {})) out.add(d);
  return out;
}

// What a run has to read. `blocks` are the classes as sliced ({ date, text });
// `classes` the record ({ date: [fingerprint, ...] }); `readDates` the dates
// that count as read where the record has no lines for them.
//
// Each class comes back with:
//   lines       its lines, with fingerprints
//   newLines    the lines not read before (their text)
//   needsReading whether there is any
//   partial     whether some of it was read before, so Claude is told to
//               make cards only from the new lines
//   fpsAll      every line, recorded once the class is read
//   fpsKnown    the lines already read, recorded if this run can't read it
//   retypedFrom the date it had before, when its date line was retyped or it
//               moved onto another class's date
export function planReading({ blocks = [], classes = {}, readDates = new Set() }) {
  const record = classes || {};
  const planned = blocks.map((b) => ({ b, lines: classLines(b.text) }));

  // The lines each date in the record has left over: recorded under it, and
  // in no class of these notes that still has that date. A class whose date
  // line was retyped leaves all its lines over under its old date. So does
  // one of two classes that shared a date, when one of them is corrected: the
  // owner's linked notes have "Le 27 octobre 2025" twice, the first almost
  // certainly meant for the 28th (2026-10-06). The old date is still in the
  // notes then, so looking only at dates that had vanished missed the move,
  // and the corrected class was read again from scratch.
  const linesOnDate = new Map();
  for (const { b, lines } of planned) {
    if (!linesOnDate.has(b.date)) linesOnDate.set(b.date, new Set());
    for (const l of lines) linesOnDate.get(b.date).add(l.fp);
  }
  const leftOver = [];
  for (const [date, fps] of Object.entries(record)) {
    if (!Array.isArray(fps) || !fps.length) continue;
    const still = linesOnDate.get(date) || new Set();
    const left = new Set(fps.filter((fp) => !still.has(fp)));
    if (left.size >= 2) leftOver.push({ date, left });
  }

  return planned.map(({ b, lines }) => {
    const fpsAll = lines.map((l) => l.fp);
    let known;
    let seeded = false;
    let retypedFrom = null;
    if (Array.isArray(record[b.date])) {
      known = new Set(record[b.date]);
    } else if (readDates.has(b.date)) {
      known = new Set(fpsAll);
      seeded = true;
    } else {
      known = new Set();
    }
    // A class with lines not read under its own date may be a class that
    // moved: its date line retyped, or moved onto a date another class
    // already has. It is, when at least 80% of its lines (and at least 2) are
    // left over from one date. Those lines were read; any others are new.
    if (fpsAll.some((fp) => !known.has(fp))) {
      let best = null;
      let bestOverlap = 0;
      for (const { date, left } of leftOver) {
        if (date === b.date) continue;
        const overlap = fpsAll.filter((fp) => left.has(fp)).length;
        if (overlap > bestOverlap) { best = date; bestOverlap = overlap; }
      }
      if (best && bestOverlap >= 2 && bestOverlap >= Math.ceil(fpsAll.length * 0.8)) {
        retypedFrom = best;
        known = new Set([...known, ...record[best]]);
      }
    }
    const fresh = lines.filter((l) => !known.has(l.fp));
    return {
      date: b.date,
      text: b.text,
      lines,
      newLines: fresh.map((l) => l.text),
      needsReading: fresh.length > 0,
      partial: fresh.length > 0 && fresh.length < lines.length,
      fpsAll,
      fpsKnown: fpsAll.filter((fp) => known.has(fp)),
      seeded,
      retypedFrom,
    };
  });
}

// The record after a run. A class read and saved records every line; a class
// that waits (or that Claude couldn't read) keeps only the lines it had, and
// is listed even when that is none, so it is never taken as read just because
// its date is on a card. A class with nothing new records its lines too,
// which is how the record fills itself.
export function recordAfter(plan = [], classes = {}, { read = new Set(), waiting = new Set() } = {}) {
  const out = {};
  for (const [date, fps] of Object.entries(classes || {})) out[date] = Array.isArray(fps) ? [...fps] : [];
  for (const p of plan) {
    const done = !p.needsReading || (read.has(p.date) && !waiting.has(p.date));
    const add = done ? p.fpsAll : p.fpsKnown;
    out[p.date] = [...new Set([...(out[p.date] || []), ...add])];
  }
  return out;
}

// Whether two records hold the same lines, so an unchanged one isn't saved.
export function sameRecord(a = {}, b = {}) {
  const ka = Object.keys(a || {});
  if (ka.length !== Object.keys(b || {}).length) return false;
  for (const k of ka) {
    const x = a[k] || [];
    const y = b?.[k];
    if (!Array.isArray(y) || x.length !== y.length) return false;
    const set = new Set(y);
    if (!x.every((fp) => set.has(fp))) return false;
  }
  return true;
}

// The dates an upload covers, for "Replace my existing deck": each class's
// own date and, for a class whose date line was retyped, the date its cards
// carry. A retyped class is known by its lines: most of a recorded class's
// lines are in one class of the upload under another date. That holds on the
// run that notices the retyping and on every upload after it, so the cards of
// a retyped class are never taken out as if their class had gone.
export function datesCovered(plan = [], classes = {}) {
  const out = new Set();
  for (const p of plan) {
    out.add(p.date);
    if (p.retypedFrom) out.add(p.retypedFrom);
  }
  for (const [date, fps] of Object.entries(classes || {})) {
    if (out.has(date) || !Array.isArray(fps) || fps.length < 2) continue;
    const need = Math.ceil(fps.length * 0.8);
    if (plan.some((p) => p.fpsAll.filter((fp) => fps.includes(fp)).length >= need)) out.add(date);
  }
  return out;
}
