// Pairs of cards that look alike and are two different things to learn: the
// right answer to Claude's same-or-different question is "different" for
// every one (2026-10-06). Fixed test data for the test of that question
// (api/_lib/repeatsChecks.js), beside the pairs known to be the same card,
// which come from the cards the 2026-10-06 clean-up put away.
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
];
