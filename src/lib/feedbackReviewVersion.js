// Which version of Claude's feedback review is current. View feedback asks for
// a fresh review of any open entry reviewed under an older one, so a change to
// what Claude may suggest reaches feedback already reviewed. Raise it when the
// review's choices change (api/_lib/feedbackReview.js).
//   1  correct the card, app problem, no change (2026-10-04)
//   2  adds removing the card (2026-10-04)
export const FEEDBACK_REVIEW_VERSION = 2;
