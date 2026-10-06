// The first-visit tour, step by step (owner, 2026-10-06). Tour.jsx shows
// them; FlashcardApp.jsx opens it on a student's first sign-in and from
// "Take the tour again".
//
// Each step lights one part of the page and says what to do there:
//   spot          what is lit: a selector, a list of them (lit together), or a
//                 function of the app's state returning either
//   until         the student does this step: the tour waits, and moves on by
//                 itself `delay` ms after this returns true. `pulse` is the
//                 thing to press, outlined
//   touch         on a step that explains, the lit part still works (the
//                 settings, the notes' tabs, a lesson's switch). Otherwise it
//                 is only to look at: a click there does nothing, so nothing
//                 opens under the dimming
//   keys          the student works the card on this step, so the keys are the
//                 app's (typing, Check, Continue, grading). On every other step
//                 the tour has them, so a key pressed to move on can't grade
//                 the card behind the dimming
//   skip          passed over when this returns true, checked once the page
//                 has settled after `enter` (a step about a graded card when
//                 nothing has been graded; a card when there is none)
//   enter, leave  set the page up for the step, and put it back afterwards.
//                 What enter returns is handed to `until`, `skip`, `title`
//                 and `body` as their second argument
//   title, body   the caption; **word** is bold. Either may be a function of
//                 the app's state
//   prefer        sides for the caption, in order of preference
//   pad, radius   space around the lit part, and its corners
//   settle        ms to wait before lighting anything, for a page still moving
//   center        no lit part: the caption sits in the middle
// The app's state is `tourState` in FlashcardApp.jsx; `act` is `tourActions`.
//
// The tour walks a new student through their first lesson: the first lesson
// of "Basic Lessons" (Lesson 1 · Être), whose cards every new deck has.

export const TOUR_LESSON = "lecon1";

const NAV = (page) => `[data-tour="nav-${page}"]`;
const CARD = '[data-tour="card"]';
const WELL = '[data-tour="well"]';
const STUDY_VIEW = [CARD, WELL];
const ANSWER_ROW = '[data-tour="answer-row"]';
const SHOW_ANSWER = '[data-tour="show-answer"]';
const CONTINUE = '[data-tour="continue"]';
const GRADE = '[data-tour="grade"]';

const MISSES = new Set(["wrong", "wrongArticle", "revealed"]);

export function tourSteps(act, lesson) {
  const id = lesson.id;
  const name = lesson.title.split(" · ")[0]; // "Lesson 1"

  return [
    { id: "welcome", center: true,
      title: "Welcome to Déjà Review",
      body: "This short tour shows you how to study. It takes about a minute." },

    { id: "lessons", spot: NAV("lessons"), pulse: NAV("lessons"), pad: 0, radius: 6, delay: 250,
      until: (a) => a.mode === "lessons",
      enter: () => act.goCards(),
      title: "Start with a lesson",
      body: "Your course lessons are here. Click **Lessons**." },

    { id: "study", spot: `[data-tour-lesson="${id}"]`, pulse: `[data-tour-study="${id}"]`, delay: 250,
      prefer: ["bottom", "top", "right", "left"],
      until: (a) => a.mode === "study" && a.lessonFilter === id,
      enter: () => act.goLessons(),
      title: lesson.title,
      body: `Press **Study** to practise the cards from ${name}.` },

    { id: "answer", spot: STUDY_VIEW, pulse: (a) => (a.typeMode ? ANSWER_ROW : SHOW_ANSWER), delay: 700, keys: true,
      prefer: ["right", "left", "top", "bottom"],
      until: (a) => a.graded,
      skip: (a) => !a.hasCard || a.graded,
      enter: () => act.openLesson(id),
      title: "Answer the card",
      body: (a) => a.typeMode
        ? `Type the answer to **${a.front || "the card"}**, then press **Check**.`
        : `Think of the answer to **${a.front || "the card"}**, then press **Show answer** to check.` },

    // The caption is about the answer just given, kept from when the step
    // came up: once Continue is pressed the next card is on screen.
    { id: "result", spot: STUDY_VIEW, pulse: (a) => (a.typeMode ? CONTINUE : GRADE), delay: 250, keys: true,
      prefer: ["right", "left", "top", "bottom"],
      until: (a, was) => a.cardKey !== was.key,
      skip: (a) => !a.graded,
      enter: (a) => ({ key: a.cardKey, result: a.result, front: a.front, typeMode: a.typeMode }),
      title: (a, was) => !was.typeMode ? "Did you know it?"
        : was.result === "correct" ? "That’s right"
        : was.result === "close" ? "Close enough"
        : was.result === "revealed" ? "Here’s the answer"
        : "Not this time",
      body: (a, was) => !was.typeMode ? "Press **Got It** if you knew it before turning the card, or **Again** if you didn’t."
        : was.result === "correct" ? "Green means you got it. Press **Continue** for the next card."
        : was.result === "close" ? "A small typo still counts as right. Press **Continue** for the next card."
        : was.result === "revealed" ? "The card now shows the answer. Press **Continue** for the next card."
        : `Red means a miss. **${was.front || "This card"}** comes back later in this set for another go. Press **Continue**.` },

    { id: "show-answer", spot: STUDY_VIEW, pulse: SHOW_ANSWER, delay: 700, keys: true,
      prefer: ["right", "left", "top", "bottom"],
      until: (a) => a.graded,
      // Only on a card never answered that way round: on a card the student
      // knows (taking the tour again), it would teach them to record a miss.
      skip: (a) => a.graded || !a.hasCard || !a.cardNew,
      enter: () => act.openLesson(id),
      title: "Don’t know it?",
      body: (a) => a.typeMode
        ? "Press **Show answer**. The card comes back later in this set, so you get another go."
        : "Press **Show answer** to turn the card. If you didn’t know it, press **Again** and it comes back later in this set." },

    { id: "spacing", spot: STUDY_VIEW, prefer: ["right", "left", "top", "bottom"],
      enter: () => act.openLesson(id),
      title: "How cards come back",
      body: (a) => (a.typeMode && MISSES.has(a.result)
        ? "Get a card right and it comes back in a few days, then weeks, then months. Miss one, like this one, and it comes back later in this set and again in a day or two."
        : "Get a card right and it comes back in a few days, then weeks, then months. Miss one and it comes back later in this set and again in a day or two.") },

    { id: "notes-chip", spot: "[data-lesson-toggle]", pulse: "[data-lesson-toggle]", pad: 5, radius: 99, delay: 500,
      prefer: ["bottom", "right", "left"],
      until: (a) => a.notesOpen,
      enter: () => { act.openLesson(id); act.setNotes(false); },
      title: "Lesson notes",
      body: (a) => (a.notesBeside
        ? `Stuck on a rule? Click **Lesson notes** to read ${name} beside your cards.`
        : `Stuck on a rule? Click **Lesson notes** to read the rules of ${name}.`) },

    { id: "notes", spot: '[data-tour="notes"]', pad: 0, radius: 0, settle: 480, touch: true,
      prefer: ["left", "bottom"],
      enter: () => { act.openLesson(id); act.setNotes(true); },
      leave: () => act.setNotes(false),
      title: (a) => (a.notesBeside ? "The rules, beside your cards" : `The rules of ${name}`),
      body: (a) => (a.notesBeside
        ? "The notes stay open while you answer. Close them with **✕** when you’re done."
        : "Close them with **✕** to go back to your cards.") },

    { id: "settings", spot: ["[data-settings-toggle]", "[data-settings-menu]"], prefer: ["left", "bottom"], settle: 480, touch: true,
      enter: () => { act.openLesson(id); act.setNotes(false); act.setSettings(true); },
      leave: () => act.setSettings(false),
      title: "Settings",
      body: "Choose whether you type or flip, which way round the cards go, and how many cards come in a set." },

    { id: "daily-lessons", spot: `[data-tour-include="${id}"]`, pad: 8, radius: 10, touch: true,
      prefer: ["bottom", "top", "right", "left"],
      enter: () => act.goLessons(),
      title: "Lessons in your daily cards",
      body: (a) => (a.tourLessonOn
        ? `${name} is switched on, so its cards come up in Cards every day, like all the basic lessons. When your class reaches a lesson like L’impératif, switch it on here.`
        : "Switch on **In my daily cards** for each lesson your class reaches, and its cards come up in Cards every day.") },

    { id: "cards", spot: NAV("cards"), pad: 0, radius: 6,
      enter: () => act.goCards(),
      title: "Come back every day",
      body: "**Cards** gives you each day’s set from the lessons you’ve switched on and your own class notes." },

    { id: "stats", spot: NAV("stats"), pad: 0, radius: 6,
      title: "Your progress",
      body: "**Stats** shows your streak and how many of your cards you remember." },

    { id: "tutor", spot: NAV("tutor"), pad: 0, radius: 6,
      title: "Ask the tutor",
      body: "Stuck on a word or a sentence? Ask the **Tutor**. It can add the word to your cards for you." },

    { id: "upload", spot: ['[data-tour="avatar"]', '[data-tour="profile-menu"]'], mark: '[data-tour="upload"]',
      prefer: ["right", "top"],
      enter: () => act.setProfileMenu(true),
      leave: () => act.setProfileMenu(false),
      title: "Add your class notes",
      body: "Click your user icon at the bottom left, then **Upload document**. Each class you upload becomes new cards." },

    { id: "feedback", spot: "[data-feedback-toggle]", pad: 4, radius: 6, prefer: ["right", "top"],
      title: "Tell us what’s wrong",
      body: "A mistake on a card, or something not working? Write to us with **Send feedback**." },

    { id: "done", center: true,
      enter: () => act.openLesson(id),
      title: "You’re ready",
      body: `Carry on with ${name}. To take this tour again, click your user icon at the bottom left, then **Take the tour again**.` },
  ];
}
