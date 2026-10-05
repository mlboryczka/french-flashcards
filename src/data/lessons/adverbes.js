// Adjectif ou adverbe ? — adverbs from adjectives, and the adjective/adverb
// pairs English speakers mix up: relatif → relativement, bon or bien, coûter
// cher but chèrement acquis, -amment or -emment, adjectives with no -ment form,
// and the -ment false friends.
//
// Not from a teacher's sheet: written for this app, checked by several
// independent reviews (a native-teacher read, a dictionary check against
// Larousse / Le Robert / CNRTL, a marking check, a curriculum check) and
// reviewed card by card by the owner on 2026-09-24. 124 drafted cards became
// 81 under the imperatif lesson's rule that each card teaches something no
// other card does.
//
// Each entry is [front, back, category, section].
//
// Card shapes:
//   "relatif → adverbe"                  build the adverb from the adjective
//   "bon ou bien → Il parle ___ anglais" choose between two forms in a sentence
//   "cher → Ces chaussures coûtent ___"  the cue word in the right form (cher? chères? chèrement?)
//   "actuellement" / "currently / …"     false friends: French shown, English typed (one-way)
//
// The cue word never goes in parentheses: cleanFrenchPrompt strips a
// parenthetical from the prompt when it repeats a word of the answer, and in
// "cher → … coûtent ___" the answer IS the cue.
//
// These cards need EXACT marking, and get it: every French-answered grammar
// card (a → in the front) is matched exactly, accents aside — see
// matchAnswer's `exact` option. Under the old typo tolerance chères and
// chèrement passed for cher, évidamment for évidemment, relatifment for
// relativement: the very mistakes the lesson exists to catch.
//
// The accent in -ément (précisément) is still not checked, because accents
// are ignored everywhere so that students on English keyboards aren't marked
// down. That is why the -ément section keeps only three common words.

export const CARDS = [
  // ── 1. Feminine + -ment — one card per kind of feminine, plus the two exceptions
  ["relatif → adverbe", "relativement", "G", "feminine"],
  ["heureux → adverbe", "heureusement", "G", "feminine"],
  ["doux → adverbe", "doucement", "G", "feminine"],
  ["complet → adverbe", "complètement", "G", "feminine"],
  ["léger → adverbe", "légèrement", "G", "feminine"],
  ["franc → adverbe", "franchement", "G", "feminine"],
  ["frais → adverbe", "fraîchement", "G", "feminine"],
  ["naturel → adverbe", "naturellement", "G", "feminine"],
  ["public → adverbe", "publiquement", "G", "feminine"],
  ["fou → adverbe", "follement", "G", "feminine"],
  ["nouveau → Le directeur, ___ nommé, arrive lundi", "nouvellement", "G", "feminine"],
  ["gentil → adverbe", "gentiment", "G", "feminine"],
  ["bref → adverbe", "brièvement", "G", "feminine"],

  // ── 2. Ends in -é, -i, -u: -ment goes on the MASCULINE
  ["vrai → adverbe", "vraiment", "G", "vowel"],
  ["poli → adverbe", "poliment", "G", "vowel"],
  ["absolu → adverbe", "absolument", "G", "vowel"],
  ["carré → adverbe", "carrément", "G", "vowel"],

  // ── 3. -ément
  ["précis → adverbe", "précisément", "G", "ement"],
  ["profond → adverbe", "profondément", "G", "ement"],
  ["énorme → adverbe", "énormément", "G", "ement"],

  // ── 4. -ant → -amment, -ent → -emment
  ["évident → adverbe", "évidemment", "G", "amment"],
  ["fréquent → adverbe", "fréquemment", "G", "amment"],
  ["patient → adverbe", "patiemment", "G", "amment"],
  ["différent → adverbe", "différemment", "G", "amment"],
  ["courant → adverbe", "couramment", "G", "amment"],
  ["constant → adverbe", "constamment", "G", "amment"],
  ["suffisant → adverbe", "suffisamment", "G", "amment"],
  ["lent → adverbe", "lentement", "G", "amment"],

  // ── 5. The adverb is another word
  ["bon → adverbe", "bien", "G", "irregular"],
  ["mauvais → adverbe", "mal", "G", "irregular"],

  // ── 6. Adjective or adverb? The pairs people mix up
  ["bon ou bien → Il parle ___ anglais", "bien", "G", "choose"],
  ["bon ou bien → C'est un ___ professeur", "bon", "G", "choose"],
  ["bon ou bien → Tu as ___ fait de venir", "bien", "G", "choose"],
  ["bon ou bien → Ce gâteau est très ___", "bon", "G", "choose"],
  ["bon ou bien → Je me sens ___ ici", "bien", "G", "choose"],
  ["mauvais ou mal → J'ai ___ dormi", "mal", "G", "choose"],
  ["mauvais ou mal → C'est une ___ idée", "mauvaise", "G", "choose"],
  ["meilleur ou mieux → Elle chante ___ que moi", "mieux", "G", "choose"],
  ["meilleur ou mieux → Ce vin est ___ que l'autre", "meilleur", "G", "choose"],
  ["meilleur ou mieux → Je me sens ___ aujourd'hui", "mieux", "G", "choose"],
  ["meilleur ou mieux → C'est la ___ solution", "meilleure", "G", "choose"],
  ["meilleur ou mieux → Laisse la fenêtre ouverte, c'est ___ comme ça", "mieux", "G", "choose"],
  ["pire ou plus mal → Il conduit ___ que son frère", "plus mal", "G", "choose"],
  ["pire ou plus mal → Ce film est ___ que le premier", "pire / plus mauvais", "G", "choose"],
  ["rapide ou vite → Il conduit trop ___", "vite / rapidement", "G", "choose"],
  ["rapide ou vite → C'est une voiture très ___", "rapide", "G", "choose"],

  // ── 7. The adjective itself, used as an adverb — and it never agrees
  ["cher → Ces chaussures coûtent ___", "cher", "G", "invariable"],
  ["bon → Ces roses sentent ___", "bon", "G", "invariable"],
  ["fort → Elles parlent trop ___", "fort", "G", "invariable"],
  ["dur → Elles y croient ___ comme fer", "dur", "G", "invariable"],
  ["faux → Elle chante ___", "faux", "G", "invariable"],
  ["juste → Ils ont vu ___", "juste", "G", "invariable"],
  ["net → La voiture s'est arrêtée ___", "net", "G", "invariable"],
  ["clair → Maintenant, j'y vois ___", "clair", "G", "invariable"],
  ["gros → Elles ont gagné ___ au casino", "gros", "G", "invariable"],
  ["haut → Il dit tout ___ ce que les autres pensent tout bas", "haut", "G", "invariable"],

  // ── 8. Outside those set phrases: the -ment form, often with a shifted sense
  ["fort → Les prix ont ___ augmenté", "fortement", "G", "meaning"],
  ["dur → La région a été ___ touchée par la crise", "durement", "G", "meaning"],
  ["cher → Une victoire ___ acquise", "chèrement", "G", "meaning"],
  ["net → C'est ___ mieux", "nettement", "G", "meaning"],
  ["clair → Il a expliqué le problème ___", "clairement", "G", "meaning"],
  ["faux → Il a été ___ accusé", "faussement", "G", "meaning"],
  ["haut → C'est ___ improbable", "hautement", "G", "meaning"],
  ["juste → Tu parles de Paul ? ___, je voulais te parler de lui", "Justement", "G", "meaning"],
  ["exprès ou expressément → Désolé, je ne l'ai pas fait ___", "exprès", "G", "which"],
  ["exprès ou expressément → Il est ___ interdit de fumer ici", "expressément", "G", "which"],
  ["longtemps ou longuement → Je ne l'ai pas vu depuis ___", "longtemps", "G", "which"],
  ["longtemps ou longuement → Il a répondu ___ et en détail à nos questions", "longuement", "G", "which"],

  // ── 9. No -ment adverb: use a phrase
  ["intéressant → adverbe", "de façon intéressante / de manière intéressante / d'une façon intéressante / d'une manière intéressante", "G", "noadverb"],
  ["fâché → Il m'a regardé ___", "d'un air fâché / l'air fâché", "G", "noadverb"],

  // ── 10. False friends: the French is shown and the English is typed (one-way,
  //        because English→French kept marking right French wrong: "lately"
  //        is just as well récemment, which this lesson teaches)
  ["actuellement", "currently / at the moment / at present / presently / right now / nowadays / these days", "G", "fauxamis"],
  ["éventuellement", "possibly / maybe / perhaps / potentially / if need be / if necessary / if needed", "G", "fauxamis"],
  ["effectivement", "indeed / that's right / exactly / sure enough / in fact / really / actually", "G", "fauxamis"],
  ["forcément", "necessarily / inevitably / unavoidably / of course / obviously", "G", "fauxamis"],
  ["dernièrement", "lately / recently / of late / not long ago", "G", "fauxamis"],
  ["sensiblement", "noticeably / appreciably / significantly / considerably / markedly / roughly / approximately / more or less", "G", "fauxamis"],
  ["définitivement", "for good / permanently / once and for all", "G", "fauxamis"],
  ["incessamment", "any moment now / any minute now / any day now / very soon / shortly / imminently", "G", "fauxamis"],
  ["Tu as largement le temps", "you have plenty of time / you've got plenty of time / you have more than enough time / you have lots of time / you've got lots of time / you have loads of time / you have ample time / you've got more than enough time / you've got ample time", "G", "fauxamis"],

  // ── 11. "Finally": finalement (in the end) or enfin (at last)
  ["enfin ou finalement → On voulait aller en Italie, mais ___ on est allés en Espagne", "finalement", "G", "finally"],
  ["enfin ou finalement → ___ ! Ça fait une heure que je t'attends", "Enfin", "G", "finally"],
];

export const NOTES = [
  {
    tab: "Use",
    h: "1 · Adjective or adverb",
    blocks: [
      { t: "lead", v: "An adjective describes a person or thing, and agrees with it. An adverb describes an action, and never changes." },
      { t: "pairs", head: ["Adjective", "Adverb"], v: [
        ["C'est un bon professeur", "Il parle bien anglais"],
        ["C'est une mauvaise idée", "J'ai mal dormi"],
        ["Ce vin est meilleur", "Elle chante mieux que moi"],
        ["Ce film est pire (or plus mauvais)", "Il conduit plus mal"],
        ["Une voiture rapide", "Il conduit trop vite (or rapidement)"],
      ]},
      { t: "note", v: "To choose, ask what the word describes. A person or thing takes the adjective, even straight after être: *ce gâteau est très bon*. An action takes the adverb: *elle chante bien*." },
      { t: "sub", v: "Feeling good or bad" },
      { t: "note", v: "French uses bien, mal and mieux, not bon, mauvais and meilleur: *je me sens bien*, *je me sens mieux*, *je vais mal*. Don't confuse this with sentir, \"to smell\", which takes bon: *ça sent bon*." },
      { t: "sub", v: "After c'est" },
      { t: "note", v: "\"Good\" and \"better\" are usually bien and mieux: *c'est bien*, *c'est mieux comme ça*. Bon and meilleur are for food and drink: *c'est bon*, *c'est meilleur avec du citron*. On its own, *c'est bon* can also mean \"OK, that's fine\"." },
      { t: "sub", v: "Detail · advanced" },
      { t: "note", v: "Tout (\"completely\") becomes toute before a feminine adjective that starts with a consonant, and toutes if the adjective is plural: *elle est toute contente*, *elles sont toutes contentes*. In every other case it stays tout: *elle est tout étonnée*, *ils sont tout contents*." },
    ],
  },
  {
    tab: "Forms",
    h: "2 · Making an adverb",
    blocks: [
      { t: "lead", v: "Take the feminine form of the adjective and add -ment." },
      { t: "table", bold: 2,
        cols: ["Masculine", "Feminine", "Adverb"],
        rows: [
          ["relatif", "relative", "relativement"],
          ["heureux", "heureuse", "heureusement"],
          ["doux", "douce", "doucement"],
          ["complet", "complète", "complètement"],
          ["léger", "légère", "légèrement"],
          ["franc", "franche", "franchement"],
          ["frais", "fraîche", "fraîchement"],
          ["naturel", "naturelle", "naturellement"],
          ["public", "publique", "publiquement"],
          ["fou", "folle", "follement"],
          ["nouveau", "nouvelle", "nouvellement"],
        ]},
      { t: "note", v: "Adjectives that already end in -e just add -ment: *rapide → rapidement*, *facile → facilement*." },
      { t: "sub", v: "Adjectives ending in a vowel" },
      { t: "note", v: "If the feminine is just the masculine plus an -e after a vowel, drop that -e." },
      { t: "table", bold: 2,
        cols: ["Masculine", "Feminine", "Adverb"],
        rows: [
          ["vrai", "vraie", "vraiment"],
          ["poli", "polie", "poliment"],
          ["absolu", "absolue", "absolument"],
          ["carré", "carrée", "carrément"],
        ]},
      { t: "sub", v: "Adjectives ending in -ant or -ent" },
      { t: "note", v: "Replace -ant with -amment, and -ent with -emment: *évident → évidemment*, not évidentement." },
      { t: "pairs", head: ["From -ant", "From -ent"], v: [
        ["courant → couramment", "évident → évidemment"],
        ["constant → constamment", "fréquent → fréquemment"],
        ["suffisant → suffisamment", "patient → patiemment"],
        ["bruyant → bruyamment", "différent → différemment"],
      ]},
      { t: "note", v: "Two exceptions: *lent → lentement*, *présent → présentement*." },
      { t: "sub", v: "Irregular adverbs" },
      { t: "table", bold: 1,
        cols: ["Adjective", "Adverb"],
        rows: [
          ["bon", "bien"],
          ["mauvais", "mal"],
          ["gentil", "gentiment (not gentillement)"],
          ["bref", "brièvement (not brèvement)"],
        ]},
      { t: "sub", v: "Adjectives with no adverb" },
      { t: "note", v: "Some adjectives, like intéressant, have no adverb. Instead, say de façon + the adjective in the feminine: *de façon intéressante*, \"in an interesting way\". For how someone looks, say d'un air + the adjective, always masculine: *elle m'a regardé d'un air fâché*, \"she gave me an angry look\"." },
      { t: "sub", v: "Detail · advanced" },
      { t: "note", v: "A few adjectives take -ément instead of -ment. No rule says which, so learn them as you meet them." },
      { t: "forms", label: "Examples", v: ["précisément", "profondément", "énormément", "intensément", "communément", "aveuglément", "expressément"] },
    ],
  },
  {
    tab: "Expressions",
    h: "3 · The adjective as an adverb",
    blocks: [
      { t: "lead", v: "In some set expressions, the adjective itself is the adverb, and it never agrees: *ces chaussures coûtent cher*, \"these shoes cost a lot\"." },
      { t: "pairs", head: ["French", "English"], v: [
        ["coûter cher", "to cost a lot"],
        ["sentir bon / mauvais", "to smell good / bad"],
        ["parler fort / bas", "to speak loudly / quietly"],
        ["travailler dur", "to work hard"],
        ["croire dur comme fer", "to believe firmly"],
        ["chanter faux / juste", "to sing out of tune / in tune"],
        ["voir juste", "to be right, to guess right"],
        ["s'arrêter net", "to stop dead"],
        ["y voir clair", "to see clearly"],
        ["dire tout haut / penser tout bas", "to say aloud / think privately"],
        ["peser lourd", "to weigh a lot"],
        ["gagner gros", "to win big"],
        ["aller tout droit", "to go straight ahead"],
      ]},
      { t: "sub", v: "fort or fortement?" },
      { t: "note", v: "Fort and fortement mean different things, and you choose by meaning. If you mean loudly, use fort: *elles parlent trop fort*. If you mean sharply or strongly, use fortement: *les prix ont fortement augmenté*." },
      { t: "pairs", head: ["Without -ment", "With -ment"], v: [
        ["parler fort · loudly", "augmenter fortement · sharply"],
        ["croire dur comme fer · firmly", "durement touché · hard hit"],
        ["coûter cher · a lot", "chèrement acquis · dearly, hard-won"],
        ["s'arrêter net · dead", "nettement mieux · clearly, much"],
        ["y voir clair · clearly", "expliquer clairement · clearly"],
        ["chanter faux · out of tune", "faussement accusé · falsely"],
        ["voir juste · right", "justement · precisely, as it happens"],
        ["dire tout haut · aloud", "hautement improbable · highly"],
        ["faire exprès · on purpose", "expressément interdit · explicitly"],
      ]},
      { t: "sub", v: "longtemps or longuement" },
      { t: "note", v: "Longtemps means a long time, and is the one used after depuis, il y a and pendant: *je ne l'ai pas vu depuis longtemps*. Longuement means at length: *il a parlé longuement de son projet*." },
    ],
  },
  {
    tab: "False friends",
    h: "4 · Adverbs that don't mean what they look like",
    blocks: [
      { t: "lead", v: "These look like English words but mean something else. In brackets: the French for the English look-alike." },
      { t: "pairs", head: ["French", "Means"], v: [
        ["actuellement", "currently, at the moment — not \"actually\" (en fait)"],
        ["éventuellement", "possibly, if need be — not \"eventually\" (finalement)"],
        ["effectivement", "indeed, that's right — not \"effectively\" (efficacement)"],
        ["forcément", "necessarily, inevitably — not \"forcibly\" (de force). Pas forcément = not necessarily"],
        ["dernièrement", "lately, recently — not \"lastly\" (pour finir)"],
        ["sensiblement", "noticeably, or roughly — not \"sensibly\" (raisonnablement)"],
        ["définitivement", "for good, permanently — not \"definitely\" (sans aucun doute)"],
        ["incessamment", "any moment now — not \"incessantly\" (sans cesse)"],
        ["largement", "widely, largely — and also plenty: Tu as largement le temps (you've got plenty of time)"],
      ]},
      { t: "sub", v: "enfin or finalement" },
      { t: "note", v: "Enfin means \"at last\", after a wait: *Enfin, te voilà !* Finalement means \"in the end\", after a change of plan: *Finalement, on est restés à la maison*." },
    ],
  },
];

export const LESSON = {
  id: "adverbes",
  title: "Adjectif ou adverbe ?",
  subtitle: "relatif → relativement, and when the adverb is another word",
  source: "Written for this app",
  // Nobody to credit, so the notes panel shows no line under the title
  // (owner, 2026-10-04). The Lessons page still says where it came from.
  creditInNotes: false,
  cards: CARDS,
  notes: NOTES,
  teachingOrder: [
    "feminine", "vowel", "ement", "amment",
    "irregular", "choose",
    "invariable", "meaning", "which", "noadverb",
    "fauxamis", "finally",
  ],
  // The line shown above each card saying what to type (see
  // src/lib/cardInstruction.js). Specific enough that "relatif" can't be read
  // as "translate this"; never so specific that it gives the answer away, so
  // the gap cards name the choice rather than the form.
  instructions: {
    feminine: "Write the adverb for this adjective",
    vowel: "Write the adverb for this adjective",
    ement: "Write the adverb for this adjective",
    amment: "Write the adverb for this adjective",
    irregular: "Write the adverb for this adjective",
    choose: "Fill in the correct form (adj or adv)",
    // The same words for both sections on purpose: "cher → … coûtent ___" and
    // "cher → … ___ acquise" must not say which of cher / chèrement is wanted.
    invariable: "Fill the gap using the word given, in the form that fits",
    meaning: "Fill the gap using the word given, in the form that fits",
    which: "Fill the gap with the right one of the two words",
    noadverb: "Write the adverb, or the phrase French uses instead",
    fauxamis: "Translate into English",
    finally: "Fill the gap with enfin or finalement",
  },
};

export default LESSON;
