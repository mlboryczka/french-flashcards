// How a stored card says which lesson card it is.
//
// Separate from the lesson catalogue itself because this is logic, not data:
// the sync reconciler needs it, and pulling in every lesson's cards to hash a
// string would make that module impossible to test on its own.
//
// A lesson card is tagged `lesson:<lessonId>#<cardKey>`, where the key hashes
// the front the LESSON ships. That key, not the stored front, is the card's
// identity. Identity used to BE the front, which meant correcting a typo on a
// lesson card made the sync unable to recognise it: the row was retired as "no
// longer in the lesson", taking its FSRS history with it, and the original
// uncorrected card was inserted in its place.

export const LESSON_SOURCE_PREFIX = "lesson:";

export const lessonSource = (id, cardKey) =>
  cardKey
    ? `${LESSON_SOURCE_PREFIX}${id}#${cardKey}`
    : `${LESSON_SOURCE_PREFIX}${id}`;

// Which lesson a stored card came from, or null for ordinary deck cards.
export const lessonIdOf = (card) =>
  typeof card?.source === "string" && card.source.startsWith(LESSON_SOURCE_PREFIX)
    ? card.source.slice(LESSON_SOURCE_PREFIX.length).split("#")[0]
    : null;

// The card's identity within its lesson, or null on a row written before keys
// existed. Those are matched by front instead — see reconcileLessons.
export const lessonCardKeyOf = (card) => {
  if (typeof card?.source !== "string") return null;
  if (!card.source.startsWith(LESSON_SOURCE_PREFIX)) return null;
  return card.source.slice(LESSON_SOURCE_PREFIX.length).split("#")[1] || null;
};

// djb2, base36. Short, and stable across reordering the lesson's array — an
// index would survive neither an insertion nor a reorder, and the whole point
// of the key is that it never moves.
export function lessonCardKey(front) {
  let h = 5381;
  const text = String(front ?? "");
  for (let i = 0; i < text.length; i++) h = ((h << 5) + h + text.charCodeAt(i)) | 0;
  return (h >>> 0).toString(36);
}
