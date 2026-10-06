// Leçon 2 · Aller — built from Laura Caufour's LFL METHOD Leçon 2 sheets: the
// lesson (dialogue, grammar 1–4), the exercise sheet and her answer key.
//
// Her students are absolute beginners. Leçon 1 (silent letters, subject
// pronouns, être in the present) is what they already know, so no card uses a
// word or a structure she has not taught by the end of Leçon 2, and questions
// are asked her way, by intonation ("Où tu vas ?"), never by inversion.
//
// Each entry is [front, back, category, section]. The front is always the
// French; see imperatif.js for why.
//
// Card shapes:
//   "aller (présent) → je"               the paradigm; the line above comes from the shape
//   "voir (futur proche) → je"           the near future, same shape ("je vais voir")
//   "aller → Comment vous ___ ?"         aller in one of her sentences (ex. 1)
//   "être ou aller → Ils ___ ici à Sydney"   choose the verb, then conjugate it
//   "Tu vas au restaurant ? → oui"       answer yes in a full sentence (ex. 2)
//   "Je suis fatigué → au futur proche"  rewrite with aller + infinitive
//   "3 → en lettres"                     the numbers
//   "un enfant → deux", "la femme → au pluriel"   plural nouns
//   two-way phrase (E) and word (V) cards for the dialogue and her ex. 3 list
//
// WHY THE ÊTRE / ALLER CONTRAST IS ON GRAMMAR CARDS. Phrase cards are marked
// with typo tolerance, and suis is two letters from vais: "Je suis bien" passes
// for "Je vais bien" as Close enough, and so do "Je suis à la plage",
// "Je suis dîner au restaurant", "Comment tu es ?" (for "Comment tu vas ?")
// and "Comment est ta femme ?" on their cards. That is the very mistake her
// ATTENTION box is about. So her sentences where it matters (the dialogue's
// "Salut ! Comment tu vas ?" and "Comment va ta femme ? — elle est très
// fatiguée", ex. 4 "They are here in Sydney" and "I am going to have dinner
// at the restaurant", ex. 1 "je vais très bien, merci") are exact "être ou
// aller" gap cards, and the phrase cards are there for meaning. Her named mistake, "je suis aller", is still
// far enough from "je vais" to be marked wrong on a phrase card. Closing the
// gap on the phrase cards needs a change to the app's fuzzy marking, not to
// this file.
//
// Sampled, not transcribed: each card teaches something no other card does.
// Ex. 1 keeps the sentences that add something to the paradigm (a noun
// subject, ne … pas, ça, a question); ex. 2 one answer per pronoun switch
// (tu → je, vous → nous, tes → mes, a plural noun → ils, a name → elle); ex. 4
// the sentences a learner needs whole. Her ex. 1 no. 10 "Sabrina va habiter en
// France" is left out: "Damien va à la plage → au futur proche" already asks
// for a name with va before an infinitive.
//
// Not made into cards: ex. 5 (true or false) and ex. 6 (questions on the
// story) test memory of the dialogue, not French; ex. 7 (dictation) and ex. 8
// (oral answers) need the audio.
//
// Vocabulary is her ex. 3 list. Where she wrote a bare noun, the card carries
// its article, because a word card is marked on its article: un enfant and
// la femme, the articles her Leçon 2 sheet uses with them (une first appears
// in Leçon 3). Her "wife" and "woman" are one French word and so one card,
// "la femme" / "the woman / the wife": a front can exist only once. Her
// "what … ?" is learnt inside "Qu'est-ce que tu vas faire ?"; a bare "what"
// has too many French answers to mark. Her "children" is the plural cards'
// job.
//
// Where this departs from her sheets:
//   - Her answer key, ex. 6 no. 3, has "Il va a la plage" (à without its
//     accent). Ex. 6 is not used, so the slip is not copied; noted for Laura.
//   - The dialogue writes "A bientôt"; the card is "À bientôt !", as her own
//     answer key spells it.
//   - Her ATTENTION box writes "Tu vas à la plage?"; the notes give it
//     French's space before "?".
//   - Slips no card or note uses, for Laura: the dialogue's last line has no
//     "!" and "et toi ça va ?" lacks its comma; the translation has "very
//     good , thank you"; the dictation key (ex. 7) has "je vais très bien
//     merci" without its comma and "restaurant?" without its space.
//   - Her key answers ex. 4 "How are you?" with "Comment ça va ?", her
//     grammar with "Comment tu vas ?". Both are in: "Comment tu vas ?" is
//     asked with the hint "with tu, not ça", and "Ça va ?" (hint "with ça")
//     accepts "Comment ça va ?".
//   - "1 → en lettres" accepts une as well as her un, and the notes say why
//     (une plage). Une is accepted and shown, never asked for:
//     her Leçon 2 teaches only un, so a card that needs it waits for Leçon 3.
//   - Ex. 2: her key answers "Vous allez à Paris ensemble ?" with "Oui, nous
//     allons à Paris." The card also takes ensemble kept, in either place, and
//     every ex. 2 card takes its answer without the Oui: the instruction asks
//     for a full sentence, and both are right.
//   - The "être ou aller" and "→ au futur proche" cards are not exercises of
//     hers. They are built from her sentences and examples (ex. 4, the
//     dialogue, "Il va être fatigué", ex. 5 "Damien va aller à la plage"), and
//     every answer is the one in her sheets.
//   - Her plural rule shows la → les; the cards add le → les and l' → les,
//     the same rule on the other two articles she has used.

export const CARDS = [
  // ── 1. Aller in the present
  ["aller (présent) → je", "je vais", "G", "forms"],
  ["aller (présent) → tu", "tu vas", "G", "forms"],
  ["aller (présent) → il/elle", "il va", "G", "forms"],
  ["aller (présent) → nous", "nous allons", "G", "forms"],
  ["aller (présent) → vous", "vous allez", "G", "forms"],
  ["aller (présent) → ils/elles", "ils vont", "G", "forms"],

  // ── Ex. 1, in her sentences: what each adds is in the comment
  ["aller → Ma femme ne ___ pas très bien", "va", "G", "gaps"],          // ne … pas around the verb
  ["aller → Ça ___ très bien, merci !", "va", "G", "gaps"],              // ça takes the il / elle form
  ["aller → Mes enfants ___ à la plage aujourd'hui", "vont", "G", "gaps"], // a plural noun is ils
  ["aller → Comment vous ___ ?", "allez", "G", "gaps"],                  // the vous "How are you?"
  ["aller → Comment ___ James et Jessica ?", "vont", "G", "gaps"],       // verb before its subject (her ex. 4)

  // ── 2. How are you? · I'm good — and the rest of the dialogue's small talk
  ["Salut !", "Hi! / Hello! / Hey! (informal)", "E", "greetings"],
  // Three ways to ask or answer "how are you" share English, so each hint
  // names the subject wanted: without it, a right answer from the card next
  // door is marked wrong.
  ["Comment tu vas ?", "How are you? (with tu, not ça)", "E", "greetings"],
  ["Ça va ?", "How's it going? / Are you OK? / Are you good? / How are you? (with ça)", "E", "greetings"], // "are you good?" is her translation
  ["Je vais bien", "I'm good / I'm well / I'm fine / I'm doing well (with je)", "E", "greetings"],
  ["Comment va ta femme ?", "How's your wife? / How is your wife doing?", "E", "greetings"],
  ["Moi aussi", "Me too / Me as well", "E", "greetings"],
  ["À bientôt !", "See you soon!", "E", "greetings"],
  ["Au revoir", "Bye / Goodbye", "E", "greetings"],

  // ── 2. To go
  ["Je vais à la plage", "I'm going to the beach / I go to the beach", "E", "togo"],
  ["Où tu vas ?", "Where are you going? / Where do you go? (with tu)", "E", "togo"],

  // ── 2. The near future: only aller changes, the second verb stays as it is
  ["voir (futur proche) → je", "je vais voir", "G", "futur"],
  ["dîner (futur proche) → nous", "nous allons dîner", "G", "futur"],
  ["apprendre (futur proche) → ils/elles", "ils vont apprendre", "G", "futur"],
  ["Je suis fatigué → au futur proche", "Je vais être fatigué / Je vais être fatiguée", "G", "futur"], // a woman writes fatiguée
  ["Damien va à la plage → au futur proche", "Damien va aller à la plage", "G", "futur"],
  ["Qu'est-ce que tu vas faire ?", "What are you going to do? (with tu)", "E", "futurphrases"],
  ["Je vais dîner au restaurant", "I'm going to have dinner at the restaurant / I'm going to dine at the restaurant", "E", "futurphrases"],

  // ── Ex. 2: answer yes. One card per switch of person
  ["Tu vas au restaurant ? → oui", "Oui, je vais au restaurant / Je vais au restaurant", "G", "answers"],
  ["Vous allez à Paris ensemble ? → oui", "Oui, nous allons à Paris / Oui, nous allons à Paris ensemble / Oui, nous allons ensemble à Paris / Nous allons à Paris / Nous allons à Paris ensemble / Nous allons ensemble à Paris", "G", "answers"],
  ["Tu vas voir tes enfants ? → oui", "Oui, je vais voir mes enfants / Je vais voir mes enfants", "G", "answers"],
  ["Tes enfants vont apprendre le français ? → oui", "Oui, ils vont apprendre le français / Ils vont apprendre le français", "G", "answers"],
  ["Jessica va voir James ? → oui", "Oui, elle va voir James / Elle va voir James", "G", "answers"],

  // ── ATTENTION: être or aller? Each sentence allows only one of them
  ["être ou aller → Salut ! Comment tu ___ ?", "vas", "G", "etreoualler"],      // "how are you" is never Comment tu es
  ["être ou aller → Ça va ? Oui, je ___ très bien", "vais", "G", "etreoualler"],
  ["être ou aller → Comment va ta femme ? Elle ___ très fatiguée", "est", "G", "etreoualler"],
  ["être ou aller → Ils ___ ici à Sydney", "sont", "G", "etreoualler"],
  ["être ou aller → Je ___ dîner au restaurant", "vais", "G", "etreoualler"], // her box: "I am going to …" is never je suis

  // ── 3. Numbers 1 to 5
  ["1 → en lettres", "un / une", "G", "numbers"],
  ["2 → en lettres", "deux", "G", "numbers"],
  ["3 → en lettres", "trois", "G", "numbers"],
  ["4 → en lettres", "quatre", "G", "numbers"],
  ["5 → en lettres", "cinq", "G", "numbers"],

  // ── 4. Plural nouns: the silent -s, and the article that shows it
  ["un enfant → deux", "deux enfants", "G", "pluralnum"],
  ["une plage → quatre", "quatre plages", "G", "pluralnum"],
  ["la femme → au pluriel", "les femmes", "G", "plural"],
  ["le restaurant → au pluriel", "les restaurants", "G", "plural"],
  ["l'ami → au pluriel", "les amis", "G", "plural"],

  // ── Ex. 3: her word list
  ["aujourd'hui", "today", "V", "vocab"],
  ["je pense", "I think", "V", "vocab"],
  ["dîner", "to have dinner / to dine / to eat dinner", "V", "vocab"],
  ["un enfant", "a child / a kid", "V", "vocab"],
  ["fatigué", "tired (masc.)", "V", "vocab"],
  ["faire", "to do / to make", "V", "vocab"],
  ["merci", "thank you / thanks", "V", "vocab"],
  ["la femme", "the woman / the wife", "V", "vocab"],
  ["en fait", "actually / in fact", "V", "vocab"],
  ["la plage", "the beach", "V", "vocab"],
  ["beaucoup", "a lot / much", "V", "vocab"],
  ["un peu", "a bit / a little", "V", "vocab"],
  ["voir", "to see / to meet (someone)", "V", "vocab"],
  ["super", "great", "V", "vocab"],
  ["après", "after", "V", "vocab"],
];

// The notes: her lesson, translated into English and rebuilt on 2026-10-04 to
// the notes rules in .claude/skills/building-lessons/SKILL.md, on the
// impératif's structure and the adverbs' wording. Six tabs:
//   Use          her section 2: what aller is for (how are you, to go, the
//                near future), with her examples
//   Forms        her section 1, the present of aller; then a name or a noun as
//                the subject (her ex. 1) and answering yes (her ex. 2)
//   Future       the near future: her formula, and putting a sentence in the
//                near future
//   Être         her ATTENTION box, then être or aller
//   Numbers      her section 3
//   Plural       her section 4
// No word list: the word and phrase cards are how the words are learned
// (owner, 2026-10-05).
// Every example is hers (lesson, dialogue, exercises or answer key) except
// the two present-tense sentences the near-future note starts from, "il est
// fatigué" and "Damien va à la plage" (made from her "Il va être fatigué" and
// her ex. 5 "Damien va aller à la plage"), "une plage", "le restaurant → les
// restaurants" and "l'ami → les amis". "Comment ça va ?", "Où tu vas ?",
// "Comment vont James et Jessica ?", the ex. 2 questions and answers, "Ils
// sont ici" and "Je vais dîner au restaurant" are from her answer key.
//
// Sentences that are not hers, kept because cards need them:
//   - Forms, "With a name or a noun": "With a name or a noun, use the il or
//     elle form for one person, and the ils or elles form for two or more. Ça
//     ("it") takes the il form too." Her ex. 1 asks for it (ma femme, mes
//     enfants, ça, James et Jessica); her lesson never says it.
//   - Forms, "Answering yes": "In the answer, tu becomes je, and tes ("your")
//     becomes mes ("my"). Vous, said to two or more people, becomes nous. A
//     name or a noun before the verb becomes il, elle, ils or elles." Her
//     ex. 2 key shows it; she never says it.
//   - Future: "Only aller changes with the person." Her examples show it;
//     her formula doesn't say it. The next sentence, "The second verb stays in
//     the infinitive, the form the dictionary gives: voir, "to see"", is her
//     formula with "infinitive" explained. The word stays because the
//     instruction line on the two rewrite cards says "aller + infinitive".
//   - Future, "Putting a sentence in the near future": both notes ("Swap the
//     verb for aller in the same form, then add the verb in its dictionary
//     form…" and "When the verb is aller, you get aller twice…"). The
//     rewrite cards are built from her sentences, not an exercise of hers.
//   - Être, "Être or aller?": all three notes ("To ask how someone is, and to
//     answer with bien, "well", use aller…", "To describe someone with a
//     word like fatigué, "tired", use être, even when the question used
//     aller…", "To say where someone is, use être… To say where they are
//     going, use aller…"). Her ATTENTION box says what not to write; the
//     cards also ask when être IS right. The choice is told by the words, not
//     the meaning (bien takes aller, fatiguée takes être), because "how is
//     she doing?" alone would point to va on "Elle ___ très fatiguée". The
//     lead, the table above it and "The trap" are hers.
//   - Numbers: "and 1 is une before a feminine word: une plage, "a beach"".
//     "1 → en lettres" accepts une and "une plage → quatre" shows it; her
//     Leçon 2 teaches only un.
//   - Plural: "and le, la or l' ("the") becomes les". Her example shows
//     la → les; the cards also ask le → les and l' → les.
//
// The Être lead, "To say "I am going", say "I go": je vais", is her
// ATTENTION box's rule without its Leçon 1 pointer. It does not say "French
// has no I am going form": the Forms table gives je vais as "I am going".
//
// Cut from the earlier notes, as helping no card: how the numbers are said
// (she says to listen to the audio; the cards are typed); the silent -s of
// the plural, also pronunciation; and the pointers to Leçon 1 ("French has no
// be + -ing tense (Leçon 1)"), replaced by saying the point where it is used.
//
// Her lesson translates "Je vais voir ma femme" as "I'm going to meet my
// wife"; the notes say "see", as her dialogue translation does, because voir is
// to see and the card for it is answered "to see".
export const NOTES = [
  {
    tab: "Use",
    h: "1 · What aller is for",
    blocks: [
      { t: "lead", v: "Aller means \"to go\", and French also uses it to ask and answer how someone is, and to say what someone is going to do." },
      { t: "sub", v: "How are you? · I'm good" },
      { t: "pairs", head: ["French", "English"], v: [
        ["Comment tu vas ?", "How are you?"],
        ["Comment ça va ?", "How are you?"],
        ["Ça va ? · Ça va !", "Are you good? · All good!"],
        ["Je vais bien", "I'm good"],
        ["Comment va ta femme ?", "How's your wife?"],
      ]},
      { t: "sub", v: "To go" },
      { t: "pairs", head: ["French", "English"], v: [
        ["Je vais à la plage", "I'm going to the beach · I go to the beach"],
        ["Nous allons au restaurant", "We're going to the restaurant"],
        ["Ils vont à Paris", "They are going to Paris"],
        ["Où tu vas ?", "Where are you going?"],
      ]},
      { t: "sub", v: "The near future" },
      { t: "pairs", head: ["French", "English"], v: [
        ["Je vais voir ma femme", "I'm going to see my wife"],
        ["Qu'est-ce que tu vas faire ?", "What are you going to do?"],
        ["Il va être fatigué", "He's going to be tired"],
      ]},
    ],
  },
  {
    tab: "Forms",
    h: "2 · Aller in the present",
    blocks: [
      { t: "lead", v: "Aller, \"to go\", has a form for each person, and each form has two meanings in English: *je vais* is \"I go\" and \"I am going\"." },
      { t: "table", bold: 0,
        cols: ["French", "English"],
        rows: [
          ["je vais", "I go · I am going"],
          ["tu vas", "you go · you are going"],
          ["il / elle va", "he / she goes · is going"],
          ["nous allons", "we go · we are going"],
          ["vous allez", "you go · you are going"],
          ["ils / elles vont", "they go · they are going"],
        ]},
      { t: "sub", v: "With a name or a noun" },
      { t: "note", v: "With a name or a noun, use the il or elle form for one person, and the ils or elles form for two or more. Ça (\"it\") takes the il form too." },
      { t: "pairs", head: ["French", "English"], v: [
        ["Ma femme ne va pas très bien", "My wife isn't very well"],
        ["Mes enfants vont très bien", "My children are very well"],
        ["Comment vont James et Jessica ?", "How are James and Jessica?"],
        ["Ça va !", "All good!"],
      ]},
      { t: "sub", v: "Answering yes" },
      { t: "note", v: "In the answer, tu becomes je, and tes (\"your\") becomes mes (\"my\"). Vous, said to two or more people, becomes nous. A name or a noun before the verb becomes il, elle, ils or elles." },
      { t: "table", bold: 1,
        cols: ["Question", "Answer"],
        rows: [
          ["Tu vas bien ?", "Oui, je vais bien"],
          ["Tu vas voir tes enfants ?", "Oui, je vais voir mes enfants"],
          ["Vous allez dîner ensemble ?", "Oui, nous allons dîner ensemble"],
          ["James va à la plage ?", "Oui, il va à la plage"],
        ]},
    ],
  },
  {
    tab: "Future",
    h: "3 · The near future",
    blocks: [
      { t: "lead", v: "To say what someone is going to do, put aller in the present before a second verb: *je vais voir*, \"I'm going to see\"." },
      { t: "note", v: "Only aller changes with the person. The second verb stays in the infinitive, the form the dictionary gives: *voir*, \"to see\"." },
      { t: "pairs", head: ["French", "English"], v: [
        ["Qu'est-ce que tu vas faire ?", "What are you going to do?"],
        ["Nous allons dîner au restaurant", "We're going to have dinner at the restaurant"],
        ["Ils vont apprendre le français", "They're going to learn French"],
      ]},
      { t: "sub", v: "Putting a sentence in the near future" },
      { t: "note", v: "Swap the verb for aller in the same form, then add the verb in its dictionary form: *il est fatigué*, \"he is tired\", becomes *il va être fatigué*, \"he is going to be tired\"." },
      { t: "note", v: "When the verb is aller, you get aller twice: *Damien va à la plage*, \"Damien goes to the beach\", becomes *Damien va aller à la plage*, \"Damien is going to go to the beach\"." },
    ],
  },
  {
    tab: "Être",
    h: "4 · I am going: être or aller",
    blocks: [
      { t: "lead", v: "To say \"I am going\", say \"I go\": *je vais*." },
      { t: "table", bold: 1,
        cols: ["English", "French"],
        rows: [
          ["I am going to the beach", "Je vais à la plage"],
          ["You are going to the restaurant", "Tu vas au restaurant"],
          ["Are you going to the beach?", "Tu vas à la plage ?"],
          ["I am going to have dinner at the restaurant", "Je vais dîner au restaurant"],
        ]},
      { t: "note", v: "**The trap:** \"I am going\" is never *je suis aller*. Nobody would understand you." },
      { t: "sub", v: "Être or aller?" },
      { t: "note", v: "To ask how someone is, and to answer with bien, \"well\", use aller: *comment tu vas ?*, \"how are you?\"; *je vais très bien*, \"I'm very good\"." },
      { t: "note", v: "To describe someone with a word like fatigué, \"tired\", use être, even when the question used aller: *comment va ta femme ? Elle est très fatiguée*, \"how's your wife? She's very tired\"." },
      { t: "note", v: "To say where someone is, use être: *ils sont ici*, \"they are here\". To say where they are going, use aller: *ils vont à Paris*, \"they are going to Paris\"." },
    ],
  },
  {
    tab: "Numbers",
    h: "5 · Numbers 1 to 5",
    blocks: [
      { t: "lead", v: "The numbers 1 to 5 are un, deux, trois, quatre and cinq, and 1 is une before a feminine word: *une plage*, \"a beach\"." },
      { t: "table", bold: 1,
        cols: ["Number", "In words"],
        rows: [
          ["1", "un · une"],
          ["2", "deux"],
          ["3", "trois"],
          ["4", "quatre"],
          ["5", "cinq"],
        ]},
    ],
  },
  {
    tab: "Plural",
    h: "6 · Plural nouns",
    blocks: [
      { t: "lead", v: "To make a noun plural, add an -s, and le, la or l' (\"the\") becomes les." },
      { t: "pairs", head: ["Singular", "Plural"], v: [
        ["un enfant", "deux enfants"],
        ["un ami", "trois amis"],
        ["la femme", "les femmes"],
        ["le restaurant", "les restaurants"],
        ["l'ami", "les amis"],
      ]},
    ],
  },
];

export const LESSON = {
  id: "lecon2",
  title: "Lesson 2 · Aller",
  subtitle: "How are you, to go, the near future, numbers 1 to 5 and plurals",
  source: "LFL METHOD by Laura Caufour",
  cards: CARDS,
  notes: NOTES,
  // The order a student meets NEW cards in: each practice section straight
  // after the rule it drills, in the order of her grammar sections. The forms
  // of aller first, and her ex. 1 on them; then its three uses, each followed
  // by its phrases; her ex. 2 only after the near future, because three of its
  // questions are in it; the être or aller choice once every use of aller has
  // been met, since it tests all of them against être. Numbers come before
  // the plurals that count with them. Her word list comes straight after
  // ex. 1, before the first card that needs its words: the phrase cards ask
  // for femme, la plage, voir, dîner and faire in French, and "Elle ___ très
  // fatiguée" can't be decided without knowing fatiguée. In her course the
  // dialogue, read first, teaches them; the app has no dialogue. The drills
  // and ex. 1 need only aller, so they still come first. Reviews are
  // unaffected; FSRS schedules those.
  teachingOrder: [
    "forms", "gaps",
    "vocab",
    "greetings", "togo", "futur", "futurphrases", "answers", "etreoualler",
    "numbers", "pluralnum", "plural",
  ],
  // The line above a grammar card saying what to type (src/lib/cardInstruction.js).
  // The drills, "aller (présent) → je" and "voir (futur proche) → je", get
  // theirs from their shape, so the futur line is for its two rewrites only.
  // Phrase and word cards are translations and carry no line.
  instructions: {
    gaps: "Fill the gap with aller in the present tense",
    answers: "Answer yes, in a full sentence with a pronoun",
    futur: "Put this in the near future (aller + infinitive)",
    etreoualler: "Fill the gap with être or aller in the present",
    numbers: "Write this number in French, in words",
    pluralnum: "Write it in the plural, with this number",
    plural: "Write it in the plural",
  },
};

export default LESSON;
