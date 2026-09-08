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
// Laura's PDF is six pages of prose and worked tables. A panel you open
// mid-session is a different job: you are not reading it, you are checking one
// thing. So this keeps the paradigms, the pairs and the two rules people
// actually get wrong, and drops every sentence that only restates them.
//
// Sections render as: a `table` (header row + rows), `pairs` (two columns,
// used for contrasts like affirmative vs negative), `lines` (plain bullets),
// and an optional `note` above them.
export const NOTES = [
  {
    h: "The shape of it",
    note: "An order or a piece of advice. Only three persons, and the subject pronoun is never said — the only French tense that works that way.",
  },
  {
    h: "Regular forms",
    table: {
      cols: ["", "regarder", "finir", "prendre"],
      rows: [
        ["tu", "regarde", "finis", "prends"],
        ["nous", "regardons", "finissons", "prenons"],
        ["vous", "regardez", "finissez", "prenez"],
      ],
    },
    note: "The present indicative with the subject removed. -er verbs drop the -s of the tu form.",
  },
  {
    h: "The four irregulars",
    pairs: [
      ["être", "sois · soyons · soyez"],
      ["avoir", "aie · ayons · ayez"],
      ["aller", "va · allons · allez"],
      ["savoir", "sache · sachons · sachez"],
    ],
  },
  {
    h: "Negative",
    note: "ne + verb + pas.",
    lines: ["Ne regarde pas", "Ne finissons pas", "Ne prenez pas"],
  },
  {
    h: "Pronouns",
    note: "Affirmative: after the verb, joined by a hyphen, and me / te become moi / toi. Negative: back in front of the verb, in their ordinary form.",
    pairs: [
      ["Regarde-moi", "Ne me regarde pas"],
      ["Dis-moi", "Ne me dis pas"],
      ["Achète-le", "Ne l'achète pas"],
      ["Donne-lui", "Ne lui donne pas"],
      ["Prends-en", "N'en prends pas"],
      ["Réfléchis-y", "N'y réfléchis pas"],
      ["Parlons-en", "N'en parlons plus"],
    ],
  },
  {
    h: "Reflexive verbs",
    note: "The reflexive pronoun behaves like any other.",
    pairs: [
      ["Lève-toi", "Ne te lève pas"],
      ["Amuse-toi", "Ne t'amuse pas"],
      ["Levez-vous", "Ne vous levez pas"],
    ],
  },
  {
    h: "Two that catch people",
    lines: [
      "-er verbs and aller take an -s before en and y — Vas-y, Profites-en, Retournes-y, Penses-y",
      "With two pronouns, le / la / les come before moi / toi — Dis-le-moi, Donne-la-moi, Rappelle-le-moi",
    ],
  },
  {
    h: "Worth knowing by heart",
    pairs: [
      ["Dis-moi ce que tu as", "Tell me what's wrong"],
      ["Amuse-toi bien !", "Have fun!"],
      ["Allons-y !", "Let's go!"],
      ["Ne me parle pas comme ça !", "Don't talk to me like that!"],
      ["Profites-en bien !", "Make the most of it!"],
      ["Dis-le-moi !", "Tell me!"],
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
