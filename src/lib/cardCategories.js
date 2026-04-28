// Bidirectional card-category code mapping.
//
// DB stores single-letter codes (V/E/G/P) for compactness; the UI works
// in long form (vocab/expr/gram/pron). Defining both directions here
// keeps the two consumers (useUserDeck shaping reads, FlashcardApp seed
// writes) from drifting.

export const CAT_DB_TO_UI = { V: "vocab", E: "expr", G: "gram", P: "pron" };
export const CAT_UI_TO_DB = { vocab: "V", expr: "E", gram: "G", pron: "P" };
