// Pairs of cards that look alike and are two different things to learn: the
// right answer to Claude's same-or-different question is "different" for
// every one (2026-10-06). Fixed test data for the test of that question
// (api/_lib/repeatsChecks.js), beside the pairs known to be the same card,
// which come from the cards the 2026-10-06 clean-up put away, and the list
// items below (LIST_ITEMS), which are the same card too.
//
// The first eight are the plan's keep-apart pairs (the plan the owner
// approved: "there should be NO duplicates from reuploading an updated
// cahier"), the ones a rule loose enough to catch every repeat would have
// joined. The rest are the other kinds the question is told to keep apart, and
// words with two meanings from the demo deck. Each is written the way the
// card-writers meet it: card A the student has, card B just made from notes.
//
// A pair's `id` names its case from run to run, so don't reuse one for a
// different pair; add new pairs with new ids.

export const KEEP_APART = [
  { id: "ou", a: { front: "ou", back: "or" }, b: { front: "où", back: "where" } },
  { id: "la-poste", a: { front: "la poste", back: "the post office" }, b: { front: "le poste", back: "the position (job)" } },
  { id: "fin", a: { front: "fin", back: "the end" }, b: { front: "fin (adj)", back: "thin; fine" } },
  { id: "etat", a: { front: "un état", back: "a state; a condition" }, b: { front: "l'État", back: "the State (the government)" } },
  { id: "voler", a: { front: "voler", back: "to steal" }, b: { front: "voler", back: "to fly" } },
  { id: "planter", a: { front: "planter", back: "to plant" }, b: { front: "planter (fam)", back: "to ditch someone; to stand someone up" } },
  { id: "vieux", a: { front: "vieux", back: "old (masculine)" }, b: { front: "vieille", back: "old (feminine)" } },
  { id: "mieux", a: { front: "mieux (adv)", back: "better" }, b: { front: "encore meilleur / mieux", back: "even better" } },
  { id: "je-pense", a: { front: "je pense", back: "I think" }, b: { front: "Je pense !", back: "I think so! / You bet!" } },
  { id: "travaux", a: { front: "le travail", back: "work; the job" }, b: { front: "les travaux", back: "the roadworks; building work" } },
  { id: "le-feu", a: { front: "le feu (flammes)", back: "fire" }, b: { front: "le feu (circulation)", back: "a traffic light" } },
  { id: "casque", a: { front: "un casque (protection)", back: "a helmet" }, b: { front: "un casque (audio)", back: "headphones" } },
  { id: "louer", a: { front: "louer (un appartement)", back: "to rent" }, b: { front: "louer (quelqu'un)", back: "to praise" } },
  { id: "poids", a: { front: "perdre du poids", back: "to lose weight" }, b: { front: "prendre du poids", back: "to gain weight" } },
  { id: "amener", a: { front: "amener", back: "to bring (a person somewhere)" }, b: { front: "emmener", back: "to take (a person somewhere, away)" } },
  // A list only seems to hold these (2026-10-07). A card that is one item of
  // another card's list is the same card (the owner), but not a word inside
  // a sentence with a comma, different words grouped on one card, or another
  // meaning of the same spelling. All from the students' own decks.
  { id: "list-verbs", a: { front: "se lever, acheter, amener", back: "to get up, to buy, to bring/take" }, b: { front: "amener", back: "to bring (someone, towards here)" } },
  { id: "en-fait", a: { front: "En fait, ça veut dire que", back: "In fact, that means that" }, b: { front: "en fait", back: "actually / in fact" } },
  { id: "semaine", a: { front: "La semaine prochaine, il va faire froid", back: "Next week, it's going to be cold" }, b: { front: "la semaine prochaine", back: "next week" } },
  { id: "fin-fine", a: { front: "fin, fine", back: "thin; fine" }, b: { front: "fin (end)", back: "end" } },
  { id: "bon-mauvais", a: { front: "bon/mauvais", back: "right/wrong" }, b: { front: "bon (adj)", back: "good" } },
  { id: "boite", a: { front: "une boîte / un club", back: "a nightclub / a club" }, b: { front: "une boîte", back: "a box" } },
  { id: "on-est-alles", a: { front: "Mon frère et moi, on est allés", back: "My brother and I went" }, b: { front: "on est allés", back: "we went" } },
];

// The other way: a card that is one item of another card's list is that card
// (the owner, 2026-10-07: "à l'heure" beside "à temps / à l'heure" is one card
// twice). The right answer to the question is "same" for every one. The rule
// is sure of the first two by itself (src/lib/sameCard.js's isListPart); the
// rest have English worded differently, so only Claude can join them. All
// from the students' own decks; "après" is the owner's card that the lesson
// sync brought back beside "ensuite / après".
export const LIST_ITEMS = [
  { id: "a-l-heure", a: { front: "à temps / à l'heure", back: "on time" }, b: { front: "à l'heure", back: "on time" } },
  { id: "des-yeux", a: { front: "un œil, des yeux", back: "an eye, eyes" }, b: { front: "des yeux", back: "eyes" } },
  { id: "apres", a: { front: "ensuite / après", back: "then / afterwards" }, b: { front: "après", back: "after" } },
  { id: "enerve", a: { front: "énervé / fâché", back: "annoyed / angry" }, b: { front: "énervé", back: "annoyed; irritated" } },
  { id: "pays-bas", a: { front: "les Pays-Bas, la Hollande", back: "the Netherlands, Holland" }, b: { front: "les Pays-Bas", back: "the Netherlands" } },
  { id: "domaine", a: { front: "un secteur / un domaine", back: "a sector / a domain" }, b: { front: "un domaine", back: "a domain, a field, an area" } },
  { id: "cher", a: { front: "cher, chère (adj)", back: "dear / expensive" }, b: { front: "cher", back: "expensive" } },
];
