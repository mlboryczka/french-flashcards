// What a grammar card is asking you to type, in plain English.
//
// A drill's front is shorthand: "vivre → je", "aller (subj) → que je",
// "devoir → imparfait (je)", "relatif → adverbe". Read quickly, "relatif"
// looks like a word to translate, and "vivre → je" never says which tense it
// wants. So every grammar card that asks for French gets one line above the
// prompt saying exactly what to write — the tense and the person by name, and
// the pronoun the answer starts with, because the answer includes it and
// "vis" alone is marked wrong against "je vis".
//
// Two sources, in this order:
//   1. The drill's own shape, for conjugation drills from any source (the
//      deck's, the cahier parser's "vivre (présent) → je", a lesson's
//      "finir (impératif) → tu"). Specific to the card, so it wins.
//   2. The lesson section's instruction (LESSON.instructions), for lesson
//      cards that are not conjugation drills: "Write the adverb …".
// Anything else gets no line.
//
// Pure, and no lesson import here, so the parser and the scripts can use the
// drill half; the lesson half is joined in cardInstructionFor (lessons/index).

const PERSONS = {
  "je": ["first person singular", "je"],
  "j'": ["first person singular", "je"],
  "tu": ["second person singular", "tu"],
  "il": ["third person singular", "il"],
  "elle": ["third person singular", "elle"],
  "il/elle": ["third person singular", "il or elle"],
  "on": ["third person singular", "on"],
  "nous": ["first person plural", "nous"],
  "vous": ["second person plural", "vous"],
  "ils": ["third person plural", "ils"],
  "elles": ["third person plural", "elles"],
  "ils/elles": ["third person plural", "ils or elles"],
  "que je": ["first person singular", "que je"],
  "que j'": ["first person singular", "que je"],
  "que tu": ["second person singular", "que tu"],
  "qu'il": ["third person singular", "qu'il"],
  "qu'elle": ["third person singular", "qu'elle"],
  "qu'il/elle": ["third person singular", "qu'il or qu'elle"],
  "que nous": ["first person plural", "que nous"],
  "que vous": ["second person plural", "que vous"],
  "qu'ils": ["third person plural", "qu'ils"],
  "qu'elles": ["third person plural", "qu'elles"],
  "qu'ils/elles": ["third person plural", "qu'ils or qu'elles"],
};

const TENSES = {
  "présent": "the present tense",
  "present": "the present tense",
  "imparfait": "the imperfect",
  "futur": "the future tense",
  "futur simple": "the future tense",
  "passé composé": "the passé composé",
  "plus-que-parfait": "the pluperfect (plus-que-parfait)",
  "conditionnel": "the present conditional",
  "conditionnel présent": "the present conditional",
  "conditionnel passé": "the past conditional",
  "subj": "the present subjunctive",
  "subjonctif": "the present subjunctive",
  "subjonctif présent": "the present subjunctive",
  "impératif": "imperative",
  "futur antérieur": "the future perfect (futur antérieur)",
  "futur proche": "the near future (futur proche)",
  "passé simple": "the passé simple",
  "passé récent": "the recent past (venir de)",
  "subjonctif passé": "the past subjunctive",
};

const PARTICIPLE = /^(?:pp|p\.p\.|participe passé|participe)$/i;

const norm = (s) => String(s || "").trim().toLowerCase().replace(/’/g, "'").replace(/\s+/g, " ");

// "vivre → je" → { verb, tense, person } or null. Accepts the three shapes
// the app's drills are written in:
//   verb → person                      (present tense by default)
//   verb (tense) → person              (the cahier parser, the lessons)
//   verb → tense (person)              (older cahier cards)
//   verb → pp | participe passé        (past participles)
export function parseDrill(front) {
  const text = norm(front);
  const arrow = text.split(" → ");
  if (arrow.length !== 2) return null;
  let [left, right] = arrow;

  let tense = null;
  const lt = left.match(/^(.+?)\s*\(([^)]+)\)$/);
  if (lt) {
    // A tense we can't name is not guessed at: "vivre (passé simple) → je"
    // must not be introduced as the present.
    if (!TENSES[lt[2].trim()]) return null;
    left = lt[1].trim(); tense = lt[2].trim();
  }
  if (!left || /\s{2,}|[.?!]/.test(left)) return null;

  if (PARTICIPLE.test(right)) return { verb: left, tense: "participle", person: null };

  let person = right;
  const rt = right.match(/^(.+?)\s*\(([^)]+)\)$/);
  if (rt && TENSES[rt[1].trim()]) {
    if (tense) return null;
    tense = rt[1].trim();
    person = rt[2].trim();
  }
  if (!PERSONS[person]) return null;
  return { verb: left, tense: tense || "présent", person };
}

export const isConjugationDrill = (front) => parseDrill(front) !== null;

// The instruction for a conjugation drill, or null if the front isn't one.
export function drillInstruction(front) {
  const d = parseDrill(front);
  if (!d) return null;
  if (d.tense === "participle") return "Give the past participle";
  const [who, pronoun] = PERSONS[d.person];
  // The imperative has no subject pronoun, so the person is named, not typed.
  if (d.tense === "impératif") return `Give the imperative, ${who} (the ${pronoun} form)`;
  // A subjunctive is written with its que: a cahier table expands to
  // "aller (subjonctif) → je" with "que j'aille" as the answer.
  if (isSubjunctive(d.tense) && !pronoun.startsWith("qu")) {
    return `Conjugate in ${TENSES[d.tense]}, ${who}, with ${queForm(pronoun)}`;
  }
  return `Conjugate in ${TENSES[d.tense]}, ${who}, with ${pronoun}`;
}

const isSubjunctive = (tense) => /^subj/.test(tense || "");
const STARTS_WITH_SUBJECT = /^(?:que\s+|qu'|qu’)?(?:je|j'|j’|tu|il|elle|on|nous|vous|ils|elles)(?:\s|$)|^(?:j'|j’|qu')/i;
// "je" + "irai" is "j'irai"; "que je" + "aille" is "que j'aille".
const withSubject = (subject, form) =>
  /(?:^|\s)(?:je|que)$/.test(subject) && /^[aeiouhéèêàâîôûœ]/i.test(form)
    ? `${subject.slice(0, -1)}'${form}`
    : `${subject} ${form}`;
const queForm = (pronoun) =>
  pronoun.split(" or ").map((p) => (/^[aeiouh]/.test(p) ? `qu'${p}` : `que ${p}`)).join(" or ");

// Other right answers to a drill, which the exact matcher would otherwise
// refuse: the other pronoun of an "il/elle" drill ("elle vit" for "il vit"),
// a subjunctive with or without its que ("j'aille" for "que j'aille") — the
// que is how the form is quoted, not what the drill tests — and, where the
// stored answer has no pronoun at all (the tutor writes "venir (subjonctif) →
// que je" / "vienne"), the answer with the pronoun the instruction asks for.
export function drillAlternates(front, back) {
  const d = parseDrill(front);
  if (!d) return [];
  const out = personAlternates(front, back);
  if (d.person && d.tense !== "impératif") {
    const subjects = PERSONS[d.person][1].split(" or ");
    const bare = String(back || "").replace(/\([^)]*\)/g, " ").split("/").map((x) => x.trim()).filter(Boolean);
    for (const a of bare) {
      if (STARTS_WITH_SUBJECT.test(a)) continue;
      for (const s of subjects) out.push(withSubject(s, a));
      if (isSubjunctive(d.tense)) for (const s of subjects) if (!/^qu/.test(s)) out.push(withSubject(queForm(s), a));
    }
  }
  if (isSubjunctive(d.tense)) {
    for (const a of [back, ...out].flatMap((x) => String(x || "").split("/")).map((x) => x.trim()).filter(Boolean)) {
      if (/^que\s+/i.test(a)) out.push(a.replace(/^que\s+/i, ""));
      else if (/^qu'/i.test(a)) out.push(a.replace(/^qu'/i, ""));
      else out.push(/^[aeiouhéè]/i.test(a) ? `qu'${a}` : `que ${a}`);
    }
  }
  return out;
}

// "il/elle" drills are answered "il vit"; "elle vit" is just as right, and
// was marked wrong. Returns the other pronoun's version(s) of the answer.
export function personAlternates(front, back) {
  const d = parseDrill(front);
  if (!d || !String(d.person).includes("/")) return [];
  const answers = String(back || "").split("/").map((s) => s.trim()).filter(Boolean);
  const swaps = [
    [/^il(?=\s)/i, "elle"], [/^elle(?=\s)/i, "il"],
    [/^ils(?=\s)/i, "elles"], [/^elles(?=\s)/i, "ils"],
    [/^qu'il(?=\s)/i, "qu'elle"], [/^qu'elle(?=\s)/i, "qu'il"],
    [/^qu'ils(?=\s)/i, "qu'elles"], [/^qu'elles(?=\s)/i, "qu'ils"],
  ];
  const out = [];
  for (const a of answers) {
    for (const [re, to] of swaps) {
      if (re.test(a)) { out.push(a.replace(re, to)); break; }
    }
  }
  return out;
}
