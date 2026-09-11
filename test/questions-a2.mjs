// Hand-written questions for test A2.
//
// WHY THIS FILE EXISTS
//
// The first version of A2 generated its questions from the same templates used
// to build the sessions. Every one of the 50 questions then appeared word for
// word inside the data, so the test scored 100% while proving nothing beyond
// "the search can find text that is literally present" — which is what A1
// already measures. A circular test that always passes is worse than no test,
// because it creates false confidence.
//
// These questions are written by hand to behave like a real user:
//
//   - different words from the session text where a person would naturally
//     use different words ("my bread came out flat" rather than the session's
//     "the loaf spreads on the peel")
//   - real phrasing, including hedging and vagueness
//   - a mix of easy (shares distinctive vocabulary) and hard (describes the
//     same problem in everyday words)
//
// `difficulty` is recorded so results can be read per band. A system that only
// answers the easy band is doing lexical lookup; one that handles the hard
// band is doing something closer to understanding.

export const A2_QUESTIONS = [
    // --- baking -----------------------------------------------------------
    { topic: "baking", difficulty: "easy", q: "my sourdough starter has gone sluggish and will not rise" },
    { topic: "baking", difficulty: "easy", q: "what hydration should I use for a rye dough" },
    { topic: "baking", difficulty: "medium", q: "the crust comes out pale and soft instead of crisp" },
    { topic: "baking", difficulty: "medium", q: "my loaf spreads sideways in the oven instead of rising up" },
    { topic: "baking", difficulty: "hard", q: "the bread tastes far too sour lately, what am I doing wrong" },

    // --- kayaking ---------------------------------------------------------
    { topic: "kayaking", difficulty: "easy", q: "how do I plan a kayak crossing around the tide" },
    { topic: "kayaking", difficulty: "easy", q: "my skeg keeps jamming with grit in it" },
    { topic: "kayaking", difficulty: "medium", q: "the boat keeps turning sideways when waves come from behind" },
    { topic: "kayaking", difficulty: "medium", q: "water got into the front compartment on a long trip" },
    { topic: "kayaking", difficulty: "hard", q: "how do I get back upright without coming out of the boat" },

    // --- piano ------------------------------------------------------------
    { topic: "piano", difficulty: "easy", q: "how should I structure daily scales and arpeggio practice" },
    { topic: "piano", difficulty: "easy", q: "using the metronome shows my fingering is uneven" },
    { topic: "piano", difficulty: "medium", q: "the harmony sounds muddy when I hold the pedal too long" },
    { topic: "piano", difficulty: "medium", q: "the marked speed is much faster than I can play cleanly" },
    { topic: "piano", difficulty: "hard", q: "how do I get better at playing music I have never seen before" },

    // --- gardening --------------------------------------------------------
    { topic: "gardening", difficulty: "easy", q: "how often should I turn the compost heap" },
    { topic: "gardening", difficulty: "easy", q: "my seedlings are leggy and stretched towards the window" },
    { topic: "gardening", difficulty: "medium", q: "when is it safe to put plants outside after winter" },
    { topic: "gardening", difficulty: "medium", q: "small green insects all over the broad beans" },
    { topic: "gardening", difficulty: "hard", q: "the soil dries out within a day in hot weather" },

    // --- cycling ----------------------------------------------------------
    { topic: "cycling", difficulty: "easy", q: "the rear derailleur looks bent after the bike fell" },
    { topic: "cycling", difficulty: "easy", q: "worn cassette makes the chain skip under load" },
    { topic: "cycling", difficulty: "medium", q: "there is a creaking noise from the frame when pedalling hard" },
    { topic: "cycling", difficulty: "medium", q: "the wheel wobbles and the disc rubs on one side" },
    { topic: "cycling", difficulty: "hard", q: "my tyres keep going flat on gravel, is there a better setup" },

    // --- photography ------------------------------------------------------
    { topic: "photography", difficulty: "easy", q: "the exposure was wrong across the whole roll of film" },
    { topic: "photography", difficulty: "easy", q: "mixing fresh developer changed the grain noticeably" },
    { topic: "photography", difficulty: "medium", q: "my negatives look thin and washed out" },
    { topic: "photography", difficulty: "medium", q: "how do I make a flat looking print more punchy" },
    { topic: "photography", difficulty: "hard", q: "shooting indoors without flash on slow film" },

    // --- chess ------------------------------------------------------------
    { topic: "chess", difficulty: "easy", q: "how do I build an opening repertoire without memorising too much" },
    { topic: "chess", difficulty: "easy", q: "endgame technique versus memorising opening lines" },
    { topic: "chess", difficulty: "medium", q: "my pawn structure falls apart on the queenside" },
    { topic: "chess", difficulty: "medium", q: "a knight sitting on a square that cannot be attacked" },
    { topic: "chess", difficulty: "hard", q: "should I stop my opponent's plan or push my own first" },

    // --- language ---------------------------------------------------------
    { topic: "language", difficulty: "easy", q: "how do I revise vocabulary with spaced repetition" },
    { topic: "language", difficulty: "easy", q: "irregular conjugation is the hardest part for me" },
    { topic: "language", difficulty: "medium", q: "my pronunciation improved by copying recordings out loud" },
    { topic: "language", difficulty: "medium", q: "my flashcard deck has grown unmanageable" },
    { topic: "language", difficulty: "hard", q: "words that look the same in both languages but mean different things" },

    // --- woodwork ---------------------------------------------------------
    { topic: "woodwork", difficulty: "easy", q: "cutting dovetails by hand takes me ages" },
    { topic: "woodwork", difficulty: "easy", q: "the mortise and tenon fit is too tight" },
    { topic: "woodwork", difficulty: "medium", q: "the surface tears out when I plane in one direction" },
    { topic: "woodwork", difficulty: "medium", q: "the board twisted after a week indoors" },
    { topic: "woodwork", difficulty: "hard", q: "the blade keeps binding partway through a cut" },

    // --- astronomy --------------------------------------------------------
    { topic: "astronomy", difficulty: "easy", q: "does a bigger aperture matter more than magnification" },
    { topic: "astronomy", difficulty: "easy", q: "collimation was off after moving the telescope" },
    { topic: "astronomy", difficulty: "medium", q: "stars drift out of view without tracking" },
    { topic: "astronomy", difficulty: "medium", q: "faint objects are invisible from town" },
    { topic: "astronomy", difficulty: "hard", q: "high power made the image worse not better last night" },
];
