// Building blocks for realistic conversation text.
//
// WHY THIS REPLACED INVENTED WORDS
//
// The first generator padded sentences with made-up syllable strings
// ("xeldrovor", "titez") to reproduce the long tail of rare words that real
// conversations contain. The statistics matched, but the text was unreadable
// and obviously fake, which made the whole fixture hard to trust.
//
// Checking the real store showed what its rare words actually are — 9,658 of
// 17,232 words appear in only one session, and they look like this:
//
//   enabling, decimal, charters, imperative, unscanned, acceptances
//   report-abuse, folder-groups, push-target, non-existent, auto-expand
//   tool_start_name, syncresultspoll, e.rows, itemtype, softmax
//
// Real English words used occasionally, technical identifiers, and hyphenated
// compounds. Never nonsense. So the tail is now built from those three kinds
// of word, which gives the same statistical spread with text a person can read.

/** Uncommon but genuine adverbs — these fill the "{u}" slot in a sentence. */
export const UNCOMMON_ADVERBS = [
    "gradually", "noticeably", "consistently", "occasionally", "eventually",
    "presumably", "arguably", "marginally", "substantially", "invariably",
    "reluctantly", "deliberately", "inadvertently", "persistently", "sporadically",
    "unhelpfully", "awkwardly", "stubbornly", "reliably", "unpredictably",
];

/** Uncommon but genuine nouns — these fill noun slots. */
export const UNCOMMON_NOUNS = [
    "workaround", "tradeoff", "threshold", "baseline", "discrepancy",
    "assumption", "constraint", "symptom", "remedy", "sequence",
    "variance", "tolerance", "clearance", "alignment", "calibration",
    "residue", "sediment", "friction", "leverage", "momentum",
    "batch", "interval", "duration", "frequency", "magnitude",
    "revision", "iteration", "adjustment", "correction", "replacement",
];

/** Both together, for the rare-word tail where part of speech does not matter. */
export const UNCOMMON = [...UNCOMMON_ADVERBS, ...UNCOMMON_NOUNS];

/** Hyphenated compounds, very common in real technical writing. */
export const COMPOUND_A = ["auto", "non", "semi", "re", "pre", "post", "multi",
    "single", "double", "half", "over", "under", "cross", "back", "front",
    "low", "high", "long", "short", "fine", "rough"];
export const COMPOUND_B = ["adjust", "tuned", "aligned", "fitted", "seated",
    "loaded", "spaced", "cured", "proofed", "rinsed", "tested", "checked",
    "mounted", "sealed", "trimmed", "sanded", "balanced", "primed", "soaked",
    "weighted"];

/** Numbers and measurements, which real conversations are full of. */
export function measurement(r) {
    // Plurals matter: "1 hours" is the kind of detail that makes generated
    // text obviously generated.
    const n = (max, unit) => {
        const v = 1 + Math.floor(r() * max);
        return `${v} ${unit}${v === 1 ? "" : "s"}`;
    };
    const kinds = [
        () => n(12, "hour"),
        () => n(55, "minute"),
        () => `${2 + Math.floor(r() * 30)} degrees`,
        () => `${10 + Math.floor(r() * 90)} percent`,
        () => `${1 + Math.floor(r() * 9)}.${Math.floor(r() * 9)} mm`,
        () => `${2 + Math.floor(r() * 20)} grams`,
        () => n(6, "week"),
        () => `version ${1 + Math.floor(r() * 4)}.${Math.floor(r() * 9)}`,
    ];
    return kinds[Math.floor(r() * kinds.length)]();
}

/**
 * Durations only, for sentence slots that require a length of time.
 * A general measurement produces "a couple of 25 degrees now", which reads as
 * obviously machine-assembled.
 */
export function duration(r) {
    const n = (max, unit) => {
        const v = 1 + Math.floor(r() * max);
        return `${v} ${unit}${v === 1 ? "" : "s"}`;
    };
    return [() => n(12, "hour"), () => n(45, "minute"), () => n(6, "week"),
        () => n(10, "day"), () => n(4, "month")][Math.floor(r() * 5)]();
}

/**
 * Sentence frames a person actually uses when asking for help. The topic
 * sentence is dropped into `{s}`; everything else is ordinary English.
 */
export const ASK_FRAMES = [
    "{s} Any idea what causes that?",
    "I keep running into this: {s} What would you check first?",
    "{s} It has been happening {u} for a couple of {m} now.",
    "Quick question. {s}",
    "{s} I tried the obvious things already and none of them helped.",
    "Not sure if this is normal. {s}",
    "{s} Is that expected, or have I done something wrong?",
    "{s} This started after I changed the setup.",
    "Following up on the same problem: {s}",
    "{s} It works fine most of the time, which makes it harder to pin down.",
];

export const REPLY_FRAMES = [
    "That usually comes down to one thing: {s} Worth checking the {c} setting before anything else.",
    "Two possibilities. {s} The second is more likely if it started {u}.",
    "{s} The {u} part is the clue here.",
    "Short answer, yes. {s} Give it about {m} and see if it settles.",
    "{s} I would change one thing at a time, otherwise you cannot tell what fixed it.",
    "This is a common one. {s} The {c} approach solves it in most cases.",
    "{s} If that does not help, the next thing to look at is the {c} side.",
    "Probably not a fault. {s} It is within normal {c} tolerance.",
    "{s} Worth noting this can take {m} to show any difference.",
    "{s} That matches what I would expect after a {c} adjustment.",
];
