// The student's true memory: deliberately NOT FSRS. Seeded (20260925) and
// counter-based, so a restart replays exactly: every random draw is a hash of
// the seed and what it is for (an item's trait, answer number n, ...).
export const SEED = 20260925;
const DAY = 86400000;
const HOUR = 3600000;

function hash32(str) {
  let h = 1779033703 ^ str.length;
  for (let i = 0; i < str.length; i++) {
    h = Math.imul(h ^ str.charCodeAt(i), 3432918353);
    h = (h << 13) | (h >>> 19);
  }
  h = Math.imul(h ^ (h >>> 16), 2246822507);
  h = Math.imul(h ^ (h >>> 13), 3266489909);
  return (h ^= h >>> 16) >>> 0;
}
function mulberry32(a) {
  return function () {
    a |= 0; a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
export const unit = (...parts) => mulberry32(hash32(`${SEED}|${parts.join("|")}`))();
export function normal(...parts) {
  const u1 = Math.max(1e-12, unit(...parts, "n1"));
  const u2 = unit(...parts, "n2");
  return Math.sqrt(-2 * Math.log(u1)) * Math.cos(2 * Math.PI * u2);
}

// kind: "vocab" | "expr" | "oneway"
export function traitsFor(key, kind, dir) {
  const m = Math.min(2.8, Math.max(0.35, Math.exp(normal("m", key) * 0.45)));
  const dirF = kind === "oneway" ? 0.7 : dir === "en" ? 0.55 : 1.0;
  const catF = kind === "expr" ? 0.8 : 1.0;
  return { m, dirF, catF };
}

export class Memory {
  constructor() { this.items = new Map(); }
  item(cardId, dir, kind, nDates) {
    const key = `${cardId}:${dir}`;
    let it = this.items.get(key);
    if (!it) {
      it = { key, cardId, dir, kind, nDates: Math.max(1, nDates || 1), ...traitsFor(key, kind, dir), S: null, lastShown: null, shown: 0 };
      this.items.set(key, it);
    }
    return it;
  }
  other(it) { return this.items.get(`${it.cardId}:${it.dir === "fr" ? "en" : "fr"}`) || null; }
  // What the student's memory says right now, before the answer.
  assess(it, now) {
    if (it.lastShown == null) {
      const b = it.kind === "oneway" ? 0.12 : it.dir === "fr" ? 0.22 : 0.08;
      const p = Math.min(0.8, 1 - Math.pow(1 - b, it.nDates));
      return { firstSight: true, t: null, p_raw: p, p, primed: false, retryBoost: false };
    }
    const t = (now - it.lastShown) / DAY;
    const p_raw = Math.pow(0.9, t / it.S);
    let p = p_raw;
    let primed = false, retryBoost = false;
    const o = this.other(it);
    if (it.kind !== "oneway" && o && o.lastShown != null && now - o.lastShown <= 12 * HOUR) {
      p = 1 - (1 - p) * 0.35; primed = true;
    }
    if (now - it.lastShown <= 2 * HOUR) { p = Math.max(p, 0.85); retryBoost = true; }
    return { firstSight: false, t, p_raw, p, primed, retryBoost };
  }
  // After the answer is shown. `right` is what the student actually recalled.
  update(it, a, right, now) {
    const S_before = it.S;
    if (a.firstSight) it.S = (right ? 1.2 : 0.4) * it.m * it.dirF * it.catF;
    else if (a.t >= 0.5) it.S = right ? it.S * (1.5 + 4.0 * (1 - a.p_raw)) : Math.max(0.3, it.S * 0.3);
    it.lastShown = now;
    it.shown++;
    return { S_before, S_after: it.S };
  }
  // True probability of recall now, without priming/retry effects (for "known" counts).
  pNow(it, now) {
    if (!it || it.lastShown == null) return null;
    return Math.pow(0.9, (now - it.lastShown) / DAY / it.S);
  }
  firstSightP(kind, dir, nDates) {
    const b = kind === "oneway" ? 0.12 : dir === "fr" ? 0.22 : 0.08;
    return Math.min(0.8, 1 - Math.pow(1 - b, Math.max(1, nDates || 1)));
  }
  toJSON() { return [...this.items.values()]; }
  static fromJSON(list) { const m = new Memory(); for (const it of list) m.items.set(it.key, it); return m; }
}
