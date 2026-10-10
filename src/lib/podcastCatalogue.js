// The podcasts the Podcasts module knows (2026-10-09). Pure, plain JS: the
// client reads it for names, the server (api/_lib/podcastSource.js and
// api/_lib/podcasts.js) for the feeds it may read.
//
// RFI's learner podcasts only, for now (owner, 2026-10-09). A Spotify link is
// accepted when its title matches an episode in one of these feeds, so the
// list is also the whole of what a student can add: anything else gets "Only
// RFI's learner podcasts can be added for now, such as Journal en français
// facile." The catalogue lives in code, as the lessons do (src/data/lessons),
// because the server can only match a Spotify title against feeds it already
// knows; the database keeps only the slug (podcast_follows.podcast,
// podcast_episodes.podcast, migration_017).
//
//   slug   the name the database keeps; never change one, or the follows and
//          episodes saved under it stop showing
//   name   as RFI writes it, shown on every page
//   by     the byline under a podcast's name
//   feed   RFI's own RSS feed (francaisfacile.rfi.fr, the only RFI host the
//          server will read)
//   dated  true for Journal en français facile, which is a news bulletin a
//          day: its episode page is headed with the long date ("Tuesday 6
//          October") and it has stories with start times. The others are one
//          short topic each and are headed with the episode's title.
//
// The limits every part of the module shares:
//   RETRY_DAYS    a passage missed or partly understood comes back this many
//                 days later (owner, 2026-10-09: 3)
//   MAX_PASSAGES  never more questions than this in one episode (owner,
//                 2026-10-09: 10). Episodes longer than 12 minutes are out of
//                 scope for now, and still get at most this many, spread over
//                 the whole episode.

export const PODCASTS = [
  { slug: 'journal-en-francais-facile', name: 'Journal en français facile', by: 'RFI',
    feed: 'https://francaisfacile.rfi.fr/fr/podcasts/journal-en-fran%C3%A7ais-facile/podcast',
    dated: true },
  { slug: 'les-mots-de-l-info', name: 'Les mots de l’info', by: 'RFI',
    feed: 'https://francaisfacile.rfi.fr/fr/podcasts/les-mots-de-l-info/podcast', dated: false },
  { slug: 'un-mot-une-histoire', name: 'Un mot, une histoire', by: 'RFI',
    feed: 'https://francaisfacile.rfi.fr/fr/podcasts/un-mot-une-histoire/podcast', dated: false },
];

export const podcastBySlug = (slug) => PODCASTS.find((p) => p.slug === slug) || null;

export const RETRY_DAYS = 3;
export const MAX_PASSAGES = 10;
