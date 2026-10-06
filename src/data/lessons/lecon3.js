// Leçon 3 · Avoir — built from Laura Caufour's LFL METHOD sheets for Leçon 3:
// the lesson (À la librairie), its EXERCICES and her CORRECTION DES EXERCICES.
//
// Each entry is [front, back, category, section].
//
// The students are absolute beginners. By this lesson they have Leçon 1
// (silent letters, the subject pronouns, être) and Leçon 2 (aller, the near
// future, 1 to 5, plural nouns), so the cards use only those and this lesson.
// Questions go by intonation or qu'est-ce que, as hers do, never by inversion,
// and nothing is negative: the negation is Leçon 5's.
//
// Card shapes:
//   "avoir (présent) → nous"                    the paradigm; the line above it comes from its shape
//   "avoir → Mes enfants ___ un nouveau livre"  the form for a noun subject (her ex. 1)
//   "être ou avoir → Ma sœur ___ 7 ans"         choose the verb, then conjugate it
//   "J'ai 17 ans → la question, avec tu"        the question this sentence answers
//   "Tu as une idée ? → Oui, …"                 answer yes with the right subject pronoun (ex. 2, 3),
//                                               with or without the Oui the prompt already shows
//   "un, une ou des → Vous avez ___ idée ?"     the article, in a sentence from her dialogue
//   "8 → en lettres"                            the number in words
//   "un cadeau" / "a gift / a present"          words (ex. 4) and sentences (ex. 5, 6), both ways
//
// The je drill is "avoir (présent) → je", not "→ j'". The line above it says
// "with je" either way, and the elision is part of what is being asked: "je
// ai" is marked wrong, which is the lesson.
//
// AGE NEEDS EXACT CARDS. A phrase card is marked with a typo allowance, and
// "Elle est 17 ans" for "Elle a 17 ans", or "Quel âge tu es ?" for "Quel âge
// tu as ?", is inside it (tried: both "close enough"). A translation would
// pass the one mistake the rule exists to catch, so the rule is drilled by the
// "être ou avoir" gaps and by asking for the question itself, both marked
// exactly. The one age phrase kept as a translation is "J'ai 17 ans", which
// the allowance does refuse as "Je suis 17 ans" and as "J'ai 17".
//
// The answer-yes cards ask for a subject pronoun, as every answer in her key
// has one ("Les vendeurs ont une idée ?" → "Oui, ils ont une idée"), and the
// line above them says so; repeating the noun is not taken. Each also takes
// its answer without the Oui the prompt already shows, as Leçons 2 and 4 do.
//
// Vocabulary is her "Comment on dit … en français ?" list, each noun with its
// article, because the gender is part of the word (her section 2); where the
// article hides it (l', des), the gender is given in brackets. Three words
// from the dialogue that her exercises keep using are added: un vendeur, une
// librairie (a bookshop, not a library) and des écouteurs.
//
// Left out, because a typed card can't do them or shouldn't: ex. 7 and 8 (true
// or false, and questions on the story — they test memory of the dialogue, not
// French; ex. 8 no. 5 answers an either/or question with "Non, …", which never
// arises here), ex. 9 (dictation), ex. 10 and 11 (oral; her key says they are
// ex. 2 and 3 again, which are here). Ex. 1, 5 and 6 are sampled, not
// transcribed: a sentence is kept only if it teaches something no other card
// does.
//
// Where this departs from her sheets:
//   - Her article table has no l', though her own list has l'histoire. The
//     notes add it, and a card asks for it.
//   - Her table gives des a dash for its English. The notes say why instead:
//     English has no word there, and French can't leave it out.
//   - "Vous avez des enfants ?" takes both of her answers: "Oui, j'ai des
//     enfants" (ex. 2) and "Oui, nous avons des enfants" (ex. 3). Vous is one
//     person or several. "Vous êtes ensemble ?" takes only nous, as in her key:
//     together means more than one.
//   - "Tu es fatigué ?" also takes fatiguée, from a woman answering about
//     herself; "Ta sœur a 17 ans ?" also takes dix-sept.
//   - "J'ai 17 ans → la question" also takes "Tu as quel âge ?", the same
//     question by intonation, and "Quel âge as-tu ?" and "Quel âge est-ce
//     que tu as ?": she teaches neither inversion nor est-ce que, but both
//     are right. Her own answer is "Quel âge tu as ?".
//   - Ex. 5 no. 2 gets back its question mark ("Vous avez des enfants ?"; her
//     key ends it with a full stop). Its English adds "(vous)" to rule out
//     tu; her "Do you guys have children?" is kept as an answer, and "Do you
//     have any children?" and "Do you have kids?" (her own word for les
//     enfants, ex. 6 no. 15) also pass.
//   - Ex. 5 no. 7's English "to give for my father" is "to give to my
//     father", the wording of her dialogue translation; gift and present both
//     pass, and aussi as too, the way the aussi card has it. Ex. 5 no. 8 takes
//     discounts or promotions, her two translations of des promotions, with
//     earphones or earbuds for les écouteurs, as the word card has them.
//     Ex. 6 no. 1 takes "about" or "on" for sur. "A gift for my father" is
//     not taken: shown English side up it would point to "pour mon père",
//     and the card is there for "à faire à".
//   - "au deuxième étage" also takes the American "on the third floor".
//     French counts floors from the rez-de-chaussée, so her "second floor" is
//     the British count; the card says which is which.

export const CARDS = [
  // ── 1. Avoir in the present
  ["avoir (présent) → je", "j'ai", "G", "avoir"],
  ["avoir (présent) → tu", "tu as", "G", "avoir"],
  ["avoir (présent) → il/elle", "il a", "G", "avoir"],
  ["avoir (présent) → nous", "nous avons", "G", "avoir"],
  ["avoir (présent) → vous", "vous avez", "G", "avoir"],
  ["avoir (présent) → ils/elles", "ils ont", "G", "avoir"],

  // A plural noun as the subject, which the drills never show (ex. 1); a
  // singular one is in the être ou avoir gaps
  ["avoir → Mes enfants ___ un nouveau livre", "ont", "G", "avoirgap"],

  // Her note's own pair, the answer and then the question. The question is
  // asked for exactly: as a phrase card, "Quel âge tu es ?" passed as close
  // enough. "Quel âge as-tu ?" and "Quel âge est-ce que tu as ?" are right,
  // so they are taken, though she never asks for inversion or est-ce que.
  // The English lists both short forms because they are too short for the
  // typo allowance to take one for the other; each also accepts "… years
  // old".
  ["J'ai 17 ans.", "I'm 17 / I am 17", "E", "age"],
  ["J'ai 17 ans → la question, avec tu", "Quel âge tu as ? / Tu as quel âge ? / Quel âge as-tu ? / Quel âge est-ce que tu as ?", "G", "age"],

  // Age is avoir; a state or a place is être. Two of each, so neither verb
  // can be guessed every time and the rule is all there is to go on: a number
  // of years takes avoir.
  ["être ou avoir → Ma sœur ___ 7 ans", "a", "G", "etreavoir"],
  ["être ou avoir → Ils ___ 8 et 10 ans", "ont", "G", "etreavoir"],
  ["être ou avoir → Pourquoi vous ___ fatigués ?", "êtes", "G", "etreavoir"],
  ["être ou avoir → Les écouteurs ___ au deuxième étage", "sont", "G", "etreavoir"],

  // ── Answering yes (ex. 2): each card is a different pronoun switch
  ["Tu as une idée ? → Oui, …", "Oui, j'ai une idée / J'ai une idée", "G", "reply"],
  ["Vous avez des enfants ? → Oui, …", "Oui, j'ai des enfants / Oui, nous avons des enfants / J'ai des enfants / Nous avons des enfants", "G", "reply"],
  ["Ta sœur a 17 ans ? → Oui, …", "Oui, elle a 17 ans / Oui, elle a dix-sept ans / Elle a 17 ans / Elle a dix-sept ans", "G", "reply"],
  ["Les vendeurs ont une idée ? → Oui, …", "Oui, ils ont une idée / Ils ont une idée", "G", "reply"],
  ["Jessica et James ont des enfants ? → Oui, …", "Oui, ils ont des enfants / Ils ont des enfants", "G", "reply"],

  // Ex. 3 mixes in être and aller: the verb has to be recognised before it can be answered
  ["Tu vas à la librairie ? → Oui, …", "Oui, je vais à la librairie / Je vais à la librairie", "G", "mixed"],
  ["Tu es fatigué ? → Oui, …", "Oui, je suis fatigué / Oui, je suis fatiguée / Je suis fatigué / Je suis fatiguée", "G", "mixed"],
  ["Vous êtes ensemble ? → Oui, …", "Oui, nous sommes ensemble / Nous sommes ensemble", "G", "mixed"],
  ["Les livres sont sur la table ? → Oui, …", "Oui, ils sont sur la table / Ils sont sur la table", "G", "mixed"],

  // ── 2. Words, each noun with its article (ex. 4, and three from the dialogue)
  ["un cadeau", "a gift / a present", "V", "vocab"],
  ["un livre", "a book", "V", "vocab"],
  // l' and des hide the gender, so the card shows it
  ["l'histoire (f)", "the history / the story", "V", "vocab"],
  ["une idée", "an idea", "V", "vocab"],
  ["une sœur", "a sister", "V", "vocab"],
  ["mon père", "my father / my dad", "V", "vocab"],
  ["la ville", "the city / the town", "V", "vocab"],
  ["une table", "a table", "V", "vocab"],
  ["des promotions (f)", "discounts / promotions", "V", "vocab"],
  ["un vendeur", "a sales assistant / a shop assistant / a salesman / a salesperson", "V", "vocab"],
  ["une librairie", "a bookshop / a bookstore", "V", "vocab"],
  ["des écouteurs (m)", "earphones / earbuds", "V", "vocab"],
  ["les deux livres", "both books / the two books", "V", "vocab"],
  ["quelque chose", "something", "V", "vocab"],
  ["nouveau", "new (masc.)", "V", "vocab"],
  ["beau", "beautiful / handsome (masc.)", "V", "vocab"],
  ["sans", "without", "V", "vocab"],
  ["sans fil", "wireless", "V", "vocab"],
  ["aussi", "also / too / as well", "V", "vocab"],
  ["là-bas", "over there / there", "V", "vocab"],
  ["prendre", "to take", "V", "vocab"],
  ["au deuxième étage", "on the second floor / on the third floor (US)", "E", "vocab"],
  ["bien sûr", "of course / sure", "E", "vocab"],
  ["Bonne journée !", "Have a nice day! / Have a good day!", "E", "vocab"],

  // ── 3. The articles, in sentences from her dialogue and exercises. One card
  //       per form; the livre / livres pair differs only by a silent -s.
  ["le, la, l' ou les → Je vais prendre ___ livre et les écouteurs", "le", "G", "articles"],
  ["le, la, l' ou les → Les enfants vont prendre ___ livres", "les", "G", "articles"],
  ["le, la, l' ou les → Il est sur ___ table là-bas", "la", "G", "articles"],
  ["le, la, l' ou les → Vous avez des livres sur ___ histoire de France ?", "l'", "G", "articles"],
  ["un, une ou des → J'ai ___ cadeau à faire à mon père", "un", "G", "articles"],
  ["un, une ou des → Vous avez ___ idée ?", "une", "G", "articles"],
  ["un, une ou des → Nous avons ___ écouteurs sans fil", "des", "G", "articles"],

  // ── Sentences (ex. 5, 6), each for what no other card has:
  //    des where English has no word, qu'est-ce que with avoir, des beside les,
  //    and un cadeau à faire à, where English says "to give"
  ["Vous avez des enfants ?", "Do you have children? / Do you have any children? / Do you have kids? / Do you guys have children? (vous)", "E", "translate"],
  ["Qu'est-ce que vous avez sur Paris ?", "What do you have about Paris? / What do you have on Paris? (vous)", "E", "translate"],
  ["Ils ont des promotions sur les écouteurs.", "They have discounts on the earphones / They have promotions on the earphones / They have discounts on the earbuds / They have promotions on the earbuds", "E", "translate"],
  ["J'ai aussi un cadeau à faire à mon père.", "I also have a present to give to my father / I also have a gift to give to my father / I have a present to give to my father too / I have a gift to give to my father too", "E", "translate"],

  // ── 4. Numbers 6 to 10
  ["6 → en lettres", "six", "G", "numbers"],
  ["7 → en lettres", "sept", "G", "numbers"],
  ["8 → en lettres", "huit", "G", "numbers"],
  ["9 → en lettres", "neuf", "G", "numbers"],
  ["10 → en lettres", "dix", "G", "numbers"],
];

// The notes are her four grammar sections, translated from her French and
// rebuilt on 2026-10-04 to the notes rules in the building-lessons skill:
// Use · Forms · Answering · Gender · Articles · Numbers. Use is her age note,
// with avoir sentences from her dialogue and exercises and, for être or
// avoir, four of her exercise sentences; Forms is her avoir table; Answering
// is her key's answers to ex. 2 and 3, none of them a card's; Gender is her
// gender section, with her examples (and un vendeur, from her dialogue, to
// pair with une sœur), and her dictionary tip last under "Detail ·
// advanced". No word list: the word cards are how the words are learned
// (owner, 2026-10-05); Articles is her table, with her examples in its
// cells; Numbers is her list.
//
// These sentences are NOT hers. Each says what her table, key or dialogue
// does without saying it, and a card needs it:
//   - Use: "and always says ans" ("J'ai 17" is marked wrong); the trap
//     sentence, "elle a 17 ans, never elle est 17 ans"; and "Use être to
//     describe someone with a word like fatigué, and to say where someone or
//     something is, but avoir to give an age", for the être ou avoir cards.
//   - Forms: the lead, "Avoir changes with each person"; "Je becomes j'
//     before a vowel" (her table shows J'ai without the reason); and "A name
//     or a noun takes the form for il, elle, ils or elles" (her ex. 1).
//   - Answering: the lead, "tu becomes je, vous becomes je or nous, and a
//     name or a noun becomes il, elle, ils or elles", which is what her key
//     does; "Vous is one person or several" (her Leçon 1 list says so, and her
//     key answers it both ways); "A man and a woman together are ils"; and
//     "For things, il and ils stand for masculine nouns, elle and elles for
//     feminine ones" (her dialogue's "Il est sur la table" is the book).
//   - Gender: "L' and des hide the gender, so the cards show it".
//   - Articles: "If a noun takes un, 'the' is le; if it takes une, 'the' is la";
//     "For more than one, le and la become les, and un and une become des"
//     (her table's plural column); the l' sentence (her table has no l',
//     though l'histoire is in her list); and "English often has no word for
//     des, but French never leaves it out" (her table gives des a dash).
export const NOTES = [
  {
    tab: "Use",
    h: "1 · What avoir is for",
    blocks: [
      { t: "lead", v: "Avoir means \"to have\", and French also uses it to say how old someone is." },
      { t: "pairs", head: ["French", "English"], v: [
        ["J'ai un cadeau à faire à mon père", "I have a present to give to my father"],
        ["Vous avez des enfants ?", "Do you have children?"],
        ["Qu'est-ce que vous avez sur Paris ?", "What do you have about Paris?"],
        ["Ils ont des promotions sur les écouteurs", "They have discounts on the earphones"],
      ]},
      { t: "sub", v: "Age" },
      { t: "note", v: "French gives an age with avoir, and always says ans, \"years\"." },
      { t: "pairs", head: ["French", "English"], v: [
        ["Quel âge tu as ?", "How old are you?"],
        ["J'ai 17 ans", "I'm 17"],
      ]},
      { t: "note", v: "**The trap:** English says \"she is 17\", but French says *elle a 17 ans*, never elle est 17 ans." },
      { t: "sub", v: "Être or avoir?" },
      { t: "note", v: "Use être, \"to be\", to describe someone with a word like fatigué, \"tired\", and to say where someone or something is, but avoir to give an age." },
      { t: "pairs", head: ["French", "English"], v: [
        ["Vous êtes fatigués ?", "Are you tired?"],
        ["Les livres sont sur la table", "The books are on the table"],
        ["Elle a 5 ans", "She is 5"],
        ["Mes enfants ont 4 et 6 ans", "My children are 4 and 6"],
      ]},
    ],
  },
  {
    tab: "Forms",
    h: "2 · Avoir in the present",
    blocks: [
      { t: "lead", v: "Avoir changes with each person: *j'ai*, \"I have\", but *nous avons*, \"we have\"." },
      { t: "table", caption: "Avoir · present tense", bold: 0,
        cols: ["French", "English"],
        rows: [
          ["J'ai", "I have"],
          ["Tu as", "You have"],
          ["Il, elle a", "He, she has"],
          ["Nous avons", "We have"],
          ["Vous avez", "You have"],
          ["Ils, elles ont", "They have"],
        ]},
      { t: "note", v: "Je becomes j' before a vowel: *j'ai*, \"I have\", never je ai." },
      { t: "note", v: "A name or a noun takes the form for il, elle, ils or elles: *ma sœur a une idée*, \"my sister has an idea\"; *James et Jessica ont deux enfants*, \"James and Jessica have two children\"." },
    ],
  },
  {
    tab: "Answering",
    h: "3 · Answering yes",
    blocks: [
      { t: "lead", v: "In your answer, tu becomes je, vous becomes je or nous, and a name or a noun becomes il, elle, ils or elles." },
      { t: "pairs", head: ["Question", "Answer"], v: [
        ["Tu as des enfants ?", "Oui, j'ai des enfants"],
        ["Tu es français ?", "Oui, je suis français"],
        ["Tu vas à la plage ?", "Oui, je vais à la plage"],
        ["Vous avez un problème ?", "Oui, j'ai un problème"],
        ["Vous êtes ici ?", "Oui, nous sommes ici"],
        ["Le vendeur a une idée ?", "Oui, il a une idée"],
        ["La sœur d'Élise a 17 ans ?", "Oui, elle a 17 ans"],
        ["Les enfants sont à la plage ?", "Oui, ils sont à la plage"],
        ["Jessica et James sont mariés ?", "Oui, ils sont mariés"],
      ]},
      { t: "note", v: "Vous is one person or several: one person answers with je, several with nous." },
      { t: "note", v: "A man and a woman together are ils, \"they\"." },
      { t: "note", v: "For things, il and ils stand for masculine nouns, elle and elles for feminine ones: *J'ai un nouveau livre. Il est sur la table*, \"I have a new book. It's on the table.\"" },
    ],
  },
  {
    tab: "Gender",
    h: "4 · Masculine or feminine",
    blocks: [
      { t: "lead", v: "Every French noun is masculine or feminine, so learn each one with un or une, \"a\"." },
      { t: "pairs", head: ["Masculine", "Feminine"], v: [
        ["un cadeau · a gift", "une idée · an idea"],
        ["un livre · a book", "une ville · a city"],
        ["un vendeur · a sales assistant", "une sœur · a sister"],
      ]},
      { t: "note", v: "The words in front of a noun change to match it: *mon père*, \"my father\", but *ma sœur*, \"my sister\". Words that describe it change too: nouveau, \"new\", and beau, \"beautiful\", are the forms for a masculine noun, as in *un nouveau livre*, \"a new book\"." },
      { t: "note", v: "L' and des hide the gender, so the cards show it: (m) for masculine, (f) for feminine." },
      { t: "sub", v: "Detail · advanced" },
      { t: "note", v: "To find a noun's gender, look it up in a dictionary such as wordreference.com." },
    ],
  },
  {
    tab: "Articles",
    h: "5 · The articles",
    blocks: [
      { t: "lead", v: "The words for \"the\" and \"a\" change with the noun: masculine, feminine or plural." },
      { t: "table", bold: 0,
        cols: ["", "the", "a, an"],
        rows: [
          ["Masculine", "le livre · the book", "un cadeau · a gift"],
          ["Feminine", "la ville · the city", "une sœur · a sister"],
          ["Plural", "les idées · the ideas", "des écouteurs · earphones"],
        ]},
      { t: "note", v: "If a noun takes un, \"the\" is le; if it takes une, \"the\" is la: *une table*, \"a table\", so *la table*, \"the table\"." },
      { t: "note", v: "For more than one, le and la become les, and un and une become des: *le livre*, \"the book\", but *les livres*, \"the books\"." },
      { t: "sub", v: "L' before a vowel" },
      { t: "note", v: "Le and la become l' before a vowel, and before most words that start with h: *une idée*, \"an idea\", but *l'idée*, \"the idea\"; *l'histoire*, \"the history\"." },
      { t: "sub", v: "Des · no word in English" },
      { t: "note", v: "English often has no word for des, but French never leaves it out: *j'ai des enfants*, \"I have children\"." },
    ],
  },
  {
    tab: "Numbers",
    h: "6 · Numbers 6 to 10",
    blocks: [
      { t: "lead", v: "The numbers 6 to 10 are six, sept, huit, neuf and dix." },
      { t: "table", bold: 1,
        cols: ["Number", "In words"],
        rows: [
          ["6", "six"],
          ["7", "sept"],
          ["8", "huit"],
          ["9", "neuf"],
          ["10", "dix"],
        ]},
    ],
  },
];

export const LESSON = {
  id: "lecon3",
  title: "Lesson 3 · Avoir",
  subtitle: "Avoir and age, the gender of nouns, the articles, 6 to 10",
  source: "LFL METHOD by Laura Caufour",
  cards: CARDS,
  notes: NOTES,
  // The order a student meets NEW cards in, following the notes tabs. Avoir
  // first, as her objective 1, with its exercises straight after: the noun
  // subjects, then age and the être / avoir choice that tests it, then the
  // answers. Then the words, each with its article, which is her gender
  // section put into practice; then the article gaps, once the nouns' genders
  // are known; then the sentences, which need all of it; the numbers last, as
  // on her sheet. Reviews are unaffected — FSRS schedules those.
  teachingOrder: [
    "avoir", "avoirgap", "age", "etreavoir", "reply", "mixed",
    "vocab", "articles", "translate",
    "numbers",
  ],
  // The line shown above a grammar card saying what to type (see
  // src/lib/cardInstruction.js). The drills get theirs from their own shape.
  // The word and sentence sections are two-way phrase cards and carry no line;
  // in "age" only the question card is a grammar card, so the line is its.
  // Both article cues share one line, so it never says which article.
  instructions: {
    avoirgap: "Fill the gap with avoir in the present tense",
    age: "Write the question this answers (not a yes/no one)",
    etreavoir: "Fill the gap with être or avoir in the present tense",
    reply: "Answer yes in a full sentence, with a subject pronoun",
    mixed: "Answer yes in a full sentence, with a subject pronoun",
    articles: "Fill the gap with the right article",
    numbers: "Write this number in French, in words",
  },
};

export default LESSON;
