// L'impératif — built from Laura Caufour's LFL METHOD lesson and exercise
// sheets (Le présent de l'impératif, EXERCICES).
//
// Each entry is [front, back, category, section].
//
// front is ALWAYS the French side and back the English one, because that is
// what the rest of the app assumes: speakFrench() reads card.f aloud and
// cleanFrenchPrompt(f, b) strips English glosses off the French. The
// translation cards therefore store the French as the front even though the
// exercise asks for English -> French; the direction toggle decides which
// side you are shown.
//
// Fronts do NOT say "(impératif)". The card wears its lesson as a badge in
// the corner instead, which carries the same context without spending the
// prompt on it — and the prompt is the part you are meant to read. The badge
// is what disambiguates "regarder -> tu" from a présent drill once these
// cards are mixed into the wider deck.
//
// EVERY card is a thing to produce, never a rule to recite. An earlier
// version had cards like "impératif : -er et aller devant en / y" answered by
// "prennent un -s" — a statement, not a question, and unanswerable in a
// typing box. Each of those rules is now carried by examples that make you
// apply it: the -s rule by Vas-y, Profites-en, Retournes-y, Regardes-en un
// and Penses-y, the pronoun-placement rules by the affirmative/negative
// pairs, and "three persons, no subject pronoun" by the paradigms themselves.
//
// Every French-answered card carries an arrow in its front. That is load
// bearing, not decoration: classifyCard() treats it as a conjugation drill,
// and FlashcardApp's answerLang() reads it to know the typed answer should be
// French rather than English.
//
// Two answers deliberately depart from the source PDF:
//   - Laura's pronoun table pairs "Vous lui donnez" with "Donne-lui". The
//     subject is vous, so the impératif is "Donnez-lui".
//   - Negation of "Prends une douche" is "Ne prends pas DE douche": the
//     partitive changes under negation, which a mechanical ne...pas wrap
//     would miss.

export const CARDS = [
  ["regarder → tu", "regarde", "G", "forms"],
  ["regarder → nous", "regardons", "G", "forms"],
  ["regarder → vous", "regardez", "G", "forms"],
  ["finir → tu", "finis", "G", "forms"],
  ["finir → nous", "finissons", "G", "forms"],
  ["finir → vous", "finissez", "G", "forms"],
  ["prendre → tu", "prends", "G", "forms"],
  ["prendre → nous", "prenons", "G", "forms"],
  ["prendre → vous", "prenez", "G", "forms"],
  ["être → tu", "sois", "G", "irregular"],
  ["être → nous", "soyons", "G", "irregular"],
  ["être → vous", "soyez", "G", "irregular"],
  ["avoir → tu", "aie", "G", "irregular"],
  ["avoir → nous", "ayons", "G", "irregular"],
  ["avoir → vous", "ayez", "G", "irregular"],
  ["aller → tu", "va", "G", "irregular"],
  ["aller → nous", "allons", "G", "irregular"],
  ["aller → vous", "allez", "G", "irregular"],
  ["savoir → tu", "sache", "G", "irregular"],
  ["savoir → nous", "sachons", "G", "irregular"],
  ["savoir → vous", "sachez", "G", "irregular"],
  ["Tu me regardes → à l'impératif", "Regarde-moi", "G", "ind2imp"],
  ["Tu me dis → à l'impératif", "Dis-moi", "G", "ind2imp"],
  ["Tu y réfléchis → à l'impératif", "Réfléchis-y", "G", "ind2imp"],
  ["Tu l'achètes → à l'impératif", "Achète-le", "G", "ind2imp"],
  ["Vous lui donnez → à l'impératif", "Donnez-lui", "G", "ind2imp"],
  ["Tu en prends → à l'impératif", "Prends-en", "G", "ind2imp"],
  ["Vous nous attendez → à l'impératif", "Attendez-nous", "G", "ind2imp"],
  ["Nous en parlons → à l'impératif", "Parlons-en", "G", "ind2imp"],
  ["Regarde-moi → au négatif", "Ne me regarde pas", "G", "negative"],
  ["Dis-moi → au négatif", "Ne me dis pas", "G", "negative"],
  ["Réfléchis-y → au négatif", "N'y réfléchis pas", "G", "negative"],
  ["Achète-le → au négatif", "Ne l'achète pas", "G", "negative"],
  ["Donne-lui → au négatif", "Ne lui donne pas", "G", "negative"],
  ["Prends-en → au négatif", "N'en prends pas", "G", "negative"],
  ["Attendez-nous → au négatif", "Ne nous attendez pas", "G", "negative"],
  ["Parlons-en → au négatif", "N'en parlons plus", "G", "negative"],
  ["se lever → tu", "Lève-toi", "G", "pronominal"],
  ["se lever → nous", "Levons-nous", "G", "pronominal"],
  ["se lever → vous", "Levez-vous", "G", "pronominal"],
  ["se souvenir → tu", "Souviens-toi", "G", "pronominal"],
  ["s'amuser → tu", "Amuse-toi", "G", "pronominal"],
  ["se battre → tu", "Bats-toi", "G", "pronominal"],
  ["Lève-toi → au négatif", "Ne te lève pas", "G", "pronominal"],
  ["Amuse-toi → au négatif", "Ne t'amuse pas", "G", "pronominal"],
  ["Souvenons-nous → au négatif", "Ne nous souvenons pas", "G", "pronominal"],
  ["Battez-vous → au négatif", "Ne vous battez pas", "G", "pronominal"],
  ["Tu devrais aider ta sœur → à l'impératif", "Aide ta sœur", "G", "ex1"],
  ["Tu devrais prendre une douche → à l'impératif", "Prends une douche", "G", "ex1"],
  ["Tu devrais partir à l'heure → à l'impératif", "Pars à l'heure", "G", "ex1"],
  ["Vous devriez tenir la porte → à l'impératif", "Tenez la porte", "G", "ex1"],
  ["Vous devriez sortir de la maison → à l'impératif", "Sortez de la maison", "G", "ex1"],
  ["Aide ta sœur → au négatif", "N'aide pas ta sœur", "G", "ex2"],
  ["Prends une douche → au négatif", "Ne prends pas de douche", "G", "ex2"],
  ["Sois prudent → au négatif", "Ne sois pas prudent", "G", "ex2"],
  ["Allez à la banque → au négatif", "N'allez pas à la banque", "G", "ex2"],
  ["Dis-moi !", "Tell me!", "E", "ex3"],
  ["Réponds-moi !", "Answer me!", "E", "ex3"],
  ["Fais-moi un thé !", "Make me a tea!", "E", "ex3"],
  ["Attends-moi !", "Wait for me!", "E", "ex3"],
  ["Envoie-moi un email !", "Send me an email!", "E", "ex3"],
  ["Rends-moi mon livre !", "Give me my book back!", "E", "ex3"],
  ["Ne me dis pas ça.", "Don't tell me that.", "E", "ex4"],
  ["Ne me regarde pas comme ça.", "Don't look at me like that.", "E", "ex4"],
  ["Ne m'attends pas.", "Don't wait for me.", "E", "ex4"],
  ["Ne m'écris pas en anglais.", "Don't write to me in English.", "E", "ex4"],
  ["Ne me mens pas.", "Don't lie to me.", "E", "ex4"],
  ["Tu devrais te réveiller → à l'impératif", "Réveille-toi", "G", "ex5"],
  ["Tu devrais te souvenir → à l'impératif", "Souviens-toi", "G", "ex5"],
  ["Tu devrais t'habiller → à l'impératif", "Habille-toi", "G", "ex5"],
  ["Tu devrais t'asseoir → à l'impératif", "Assieds-toi", "G", "ex5"],
  ["Vous devriez vous taire → à l'impératif", "Taisez-vous", "G", "ex5"],
  ["Tu devrais l'acheter → à l'impératif", "Achète-le", "G", "ex6"],
  ["Vous devriez lui dire → à l'impératif", "Dites-lui", "G", "ex6"],
  ["Tu devrais en prendre plus → à l'impératif", "Prends-en plus", "G", "ex6"],
  ["Tu devrais y réfléchir → à l'impératif", "Réfléchis-y", "G", "ex6"],
  ["Vous devriez y aller → à l'impératif", "Allez-y", "G", "ex6"],
  ["Tu devrais leur envoyer un mail → à l'impératif", "Envoie-leur un mail", "G", "ex6"],
  ["Vous devriez le lire → à l'impératif", "Lisez-le", "G", "ex6"],
  ["Tu devrais m'en dire plus → à l'impératif", "Dis-m'en plus", "G", "ex7"],
  ["Tu devrais y aller → à l'impératif", "Vas-y", "G", "ex7"],
  ["Tu devrais en profiter → à l'impératif", "Profites-en", "G", "ex7"],
  ["Tu devrais lui en offrir un → à l'impératif", "Offre-lui-en un", "G", "ex7"],
  ["Tu devrais me le donner → à l'impératif", "Donne-le-moi", "G", "ex7"],
  ["Tu devrais te les couper plus courts → à l'impératif", "Coupe-les-toi plus courts", "G", "ex7"],
  ["Tu devrais me le rappeler plus tard → à l'impératif", "Rappelle-le-moi plus tard", "G", "ex7"],
  ["Vous devriez vous en occuper maintenant → à l'impératif", "Occupez-vous-en maintenant", "G", "ex7"],
  ["Vous devriez le lui dire → à l'impératif", "Dites-le-lui", "G", "ex7"],
  ["Mange-le.", "Eat it.", "E", "ex8"],
  ["Ne conduis pas trop vite !", "Don't drive too fast!", "E", "ex8"],
  ["Parle-lui-en.", "Talk to her about it.", "E", "ex8"],
  ["Donne-le-lui.", "Give it to him.", "E", "ex8"],
  ["Tais-toi !", "Shut up!", "E", "ex8"],
  ["Dépêche-toi !", "Hurry up!", "E", "ex8"],
  ["Ne sois pas timide !", "Don't be shy!", "E", "ex8"],
  ["Choisis-en un !", "Choose one!", "E", "ex8"],
  ["Dis-moi ce que tu as", "Tell me what's wrong", "E", "phrase"],
  ["Amuse-toi bien !", "Have fun!", "E", "phrase"],
  ["Ne vous disputez pas !", "Don't argue!", "E", "phrase"],
  ["Allons-y !", "Let's go!", "E", "phrase"],
  ["Ne me parle pas comme ça !", "Don't talk to me like that!", "E", "phrase"],
  ["Profites-en bien !", "Make the most of it!", "E", "phrase"],
  ["Rappelle-le-moi demain", "Remind me tomorrow", "E", "phrase"],
  ["Dis-le-moi !", "Tell me!", "E", "phrase"],
  ["Donne-les-moi", "Give them to me", "E", "phrase"],
  ["Tu devrais y retourner → à l'impératif", "Retournes-y", "G", "ex7"],
  ["Tu devrais en regarder un → à l'impératif", "Regardes-en un", "G", "ex7"],
  ["Tu devrais y penser → à l'impératif", "Penses-y", "G", "ex7"],
];

// The lesson itself, distilled to what fits beside a card you are stuck on.
//
// Built from Laura Caufour's PDF, translated. Six pages of prose and worked
// tables are a different job from a panel you open mid-session: you are not
// reading it, you are checking one thing. So this keeps the paradigms, the
// pairs and the rules people actually get wrong, and drops the sentences that
// only restate them.
//
// SHAPE. Four sections, one per numbered section of her lesson, each rendered
// as a tab. A section is an ORDERED list of blocks, because her material
// interleaves — a rule, its examples, then a caveat on those examples. The
// earlier fixed order (note, then table, then pairs, then lines) could not
// express that.
//
// Block types:
//   lead   the one sentence saying what this section is for
//   sub    a subheading within a section
//   note   a paragraph. Supports **bold** and *italic*
//   list   bullets; an item may be { v, ex } to carry its own example
//   forms  a labelled line of French specimens
//   pairs  two columns, `head` names them
//   table  `cols` + `rows`; `bold` picks the column that carries the weight
//
// EVERY EXAMPLE KEEPS ITS LABEL. Her PDF captions each specimen block
// ("Impératif présent", "Exemples :"). Stripping those captions while
// distilling left French words floating with nothing saying what they were —
// the single biggest source of confusion in review. Likewise every rule keeps
// an example: a rule stated in the abstract is a riddle.
//
// THREE ERRORS IN THE SOURCE ARE CORRECTED HERE, not reproduced:
//   - She pairs "Vous lui donnez" with "Donne-lui". The subject is vous, so
//     the imperative is "Donnez-lui" — which is also what the card says.
//   - "Ne faites pas de bêtises" was missing its exclamation mark.
//   - She calls "Dis-le-moi" an exception to pronoun order. It is not: it
//     obeys the same order as "Dis-le-lui" — direct object first, always. It
//     only looks exceptional because she never states the order, deferring to
//     a pronoun lesson this app does not have. The order is given instead.
//
// Two sentences here are NOT hers and carry rules her prose never states,
// only implies through its tables: the "take the present indicative and drop
// the subject pronoun" lead, and the me/te -> moi/toi table. Without them the
// sections were tables with nothing telling you what to do.
export const NOTES = [
  {
    tab: "Use",
    h: "1 · Presentation and use",
    blocks: [
      { t: "note", v: "The present imperative is used mainly to express an order or a piece of advice." },
      { t: "note", v: "It has two major specificities:" },
      { t: "list", v: [
        "It is made up of only 3 persons: 2nd person singular (tu), 1st person plural (nous), 2nd person plural (vous).",
        { v: "The personal pronoun is not expressed. It is the only tense in French that is used without mentioning the subject.",
          ex: "tu regardes → regarde" },
      ]},
      { t: "table", bold: 1,
        cols: ["Present indicative", "Present imperative"],
        rows: [
          ["Tu regardes", "Regarde"],
          ["Nous regardons", "Regardons"],
          ["Vous regardez", "Regardez"],
        ]},
      { t: "sub", v: "Second person · tu, vous" },
      { t: "note", v: "In the second person (tu and vous), the present imperative is used like the imperative in English." },
      { t: "pairs", head: ["French", "English"], v: [
        ["Arrête de faire du bruit !", "Stop making noise!"],
        ["Viens ici !", "Come here!"],
        ["Prenez votre manteau !", "Take your coat!"],
        ["Ne faites pas de bêtises !", "Don't do anything stupid!"],
      ]},
      { t: "sub", v: "First person plural · nous" },
      { t: "note", v: "In the first person plural (nous), it can be used to translate « let's » + base form." },
      { t: "pairs", head: ["French", "English"], v: [
        ["Allons-y", "Let's go"],
        ["Parlons-en", "Let's talk about it"],
      ]},
      { t: "note", v: "« on » + the present indicative says the same thing." },
      { t: "pairs", head: ["French", "English"], v: [
        ["On y va", "Let's go"],
        ["On en parle", "Let's talk about it"],
      ]},
    ],
  },
  {
    tab: "Forms",
    h: "2 · Formation",
    blocks: [
      { t: "lead", v: "Take the present indicative and drop the subject pronoun. That is the whole rule — with one wrinkle: -er verbs also drop the -s of the tu form." },
      { t: "sub", v: "Affirmative form" },
      { t: "note", v: "The three verbs below are one from each French verb family: **regarder** (-er), **finir** (-ir), **prendre** (everything else). The rule is the same for all three." },
      { t: "table", caption: "Present indicative", dense: true,
        cols: ["Person", "regarder", "finir", "prendre"],
        rows: [
          ["tu", "Tu regardes", "Tu finis", "Tu prends"],
          ["nous", "Nous regardons", "Nous finissons", "Nous prenons"],
          ["vous", "Vous regardez", "Vous finissez", "Vous prenez"],
        ]},
      { t: "table", caption: "Present imperative",
        cols: ["Person", "regarder", "finir", "prendre"],
        rows: [
          ["tu", "Regarde", "Finis", "Prends"],
          ["nous", "Regardons", "Finissons", "Prenons"],
          ["vous", "Regardez", "Finissez", "Prenez"],
        ]},
      { t: "sub", v: "Very irregular verbs" },
      { t: "pairs", head: ["Verb", "tu · nous · vous"], v: [
        ["Être", "Sois · Soyons · Soyez"],
        ["Avoir", "Aie · Ayons · Ayez"],
        ["Aller", "Va · Allons · Allez"],
        ["Savoir", "Sache · Sachons · Sachez"],
      ]},
      { t: "sub", v: "Negative form" },
      { t: "note", v: "Ne + verb in the imperative + pas / plus / jamais etc." },
      { t: "table", caption: "Present imperative · negative", dense: true,
        cols: ["Person", "regarder", "finir", "prendre"],
        rows: [
          ["tu", "Ne regarde pas", "Ne finis pas", "Ne prends pas"],
          ["nous", "Ne regardons pas", "Ne finissons pas", "Ne prenons pas"],
          ["vous", "Ne regardez pas", "Ne finissez pas", "Ne prenez pas"],
        ]},
    ],
  },
  {
    tab: "Pronouns",
    h: "3 · Use of object pronouns",
    blocks: [
      { t: "sub", v: "Affirmative form" },
      { t: "lead", v: "Object pronouns go after the verb, joined by a hyphen. Two of those pronouns change form when they move there." },
      { t: "table", bold: 1,
        cols: ["Normally", "After the verb"],
        rows: [
          ["me", "moi"],
          ["te", "toi"],
        ]},
      { t: "note", v: "Every other pronoun keeps its usual form: **le / la / l'**, **les**, **lui**, **leur**, **nous**, **vous**, **en**, **y**." },
      { t: "sub", v: "Direct object" },
      { t: "pairs", head: ["Indicative", "Imperative"], v: [
        ["Tu me regardes", "Regarde-moi"],
        ["Tu l'achètes", "Achète-le"],
        ["Vous nous attendez", "Attendez-nous"],
      ]},
      { t: "sub", v: "Indirect object · verbs of communication" },
      { t: "pairs", head: ["Indicative", "Imperative"], v: [
        ["Tu me dis", "Dis-moi"],
        ["Vous lui donnez", "Donnez-lui"],
        ["Tu nous envoies une lettre", "Envoie-nous une lettre"],
      ]},
      { t: "sub", v: "Other object pronouns" },
      { t: "pairs", head: ["Indicative", "Imperative"], v: [
        ["Tu y réfléchis", "Réfléchis-y"],
        ["Tu en prends", "Prends-en"],
        ["Nous en parlons", "Parlons-en"],
      ]},
      { t: "sub", v: "Negative form" },
      { t: "note", v: "In the negative form, on the other hand, object pronouns are used normally. They are therefore placed before the verb." },
      { t: "pairs", head: ["Affirmative", "Negative"], v: [
        ["Regarde-moi", "Ne me regarde pas"],
        ["Dis-moi", "Ne me dis pas"],
        ["Réfléchis-y", "N'y réfléchis pas"],
        ["Achète-le", "Ne l'achète pas"],
        ["Donne-lui", "Ne lui donne pas"],
        ["Prends-en", "N'en prends pas"],
        ["Attendez-nous", "Ne nous attendez pas"],
        ["Envoie-nous une lettre", "Ne nous envoie pas de lettre"],
        ["Parlons-en", "N'en parlons plus"],
      ]},
      { t: "sub", v: "Detail 1 · advanced" },
      { t: "note", v: "First-group verbs and the verb aller take an « s » in the second person singular when they are followed by the pronouns « en » and « y », to make pronunciation easier." },
      { t: "forms", label: "Examples", v: ["Profites-en bien !", "Retournes-y !", "Vas-y !"] },
      { t: "sub", v: "Detail 2 · advanced" },
      { t: "note", v: "When two pronouns are present, they follow the verb in this order. The hyphen is doubled, or an apostrophe is added (for « y » and « en »)." },
      { t: "table", bold: 1,
        cols: ["Order", "Pronouns"],
        rows: [
          ["1st", "le / la / les"],
          ["2nd", "moi / toi / lui / nous / vous / leur"],
          ["3rd", "y"],
          ["4th", "en"],
        ]},
      { t: "forms", label: "Examples", v: [
        "Dis-le-lui !", "Dis-le-moi.", "Donne-la-moi.",
        "Donne-les-leur.", "Ramène-m'en ce soir.", "Rappelle-le-moi demain.",
      ]},
      { t: "note", v: "**The trap:** in every other tense me and te come *first* — *Tu me le dis*. After the verb they come second and become moi and toi — *Dis-le-moi*." },
    ],
  },
  {
    tab: "Reflexive",
    h: "4 · Reflexive verbs",
    blocks: [
      { t: "lead", v: "The reflexive pronoun moves like any other. Affirmative: after the verb, and te becomes toi — *Lève-toi*. Negative: back in front of the verb, and toi returns to te — *Ne te lève pas*." },
      { t: "note", v: "nous and vous never change; only te does." },
      { t: "pairs", head: ["Affirmative", "Negative"], v: [
        ["Lève-toi", "Ne te lève pas"],
        ["Levons-nous", "Ne nous levons pas"],
        ["Levez-vous", "Ne vous levez pas"],
        ["Souviens-toi", "Ne te souviens pas"],
        ["Souvenons-nous", "Ne nous souvenons pas"],
        ["Souvenez-vous", "Ne vous souvenez pas"],
        ["Amuse-toi", "Ne t'amuse pas"],
        ["Amusons-nous", "Ne nous amusons pas"],
        ["Amusez-vous", "Ne vous amusez pas"],
        ["Bats-toi", "Ne te bats pas"],
        ["Battons-nous", "Ne nous battons pas"],
        ["Battez-vous", "Ne vous battez pas"],
      ]},
    ],
  },
];

export const LESSON = {
  id: "imperatif",
  title: "L'impératif",
  subtitle: "Orders and advice — three persons, no subject pronoun",
  source: "LFL METHOD by Laura Caufour",
  cards: CARDS,
  notes: NOTES,
};

export default LESSON;
