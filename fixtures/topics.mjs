// Topic library for the evaluation fixtures.
//
// The hardest requirement here is VOCABULARY SPREAD. Word rarity is computed
// from whatever is in the database, so a fixture of 200 sessions all about
// canvases and tests would make "canvas" a common word — exactly the defect
// being measured in the real store, reproduced at larger scale. Every number
// measured on such a fixture would be an artefact of the fixture.
//
// So: 10 unrelated domains, each with its own distinctive vocabulary, plus a
// shared pool of filler words that appear everywhere and should therefore
// carry almost no weight.

/** Words that appear across every topic. These must end up cheap. */
export const FILLER = [
    "this", "that", "with", "from", "have", "make", "need", "want", "should",
    "would", "could", "there", "where", "when", "what", "which", "into",
    "about", "after", "before", "again", "still", "just", "only", "also",
    "some", "more", "most", "other", "than", "then", "them", "they", "your",
    "work", "working", "look", "looking", "take", "takes", "give", "gives",
    "show", "shows", "use", "using", "used", "thing", "things", "part",
    "parts", "case", "cases", "point", "points", "check", "checking", "run",
    "running", "start", "started", "change", "changes", "issue", "issues",
];

/**
 * Ten domains. `terms` are the distinctive words for that domain; they appear
 * there and essentially nowhere else, so they stay rare and carry real weight.
 */
export const TOPICS = [
    {
        id: "baking",
        label: "Sourdough baking",
        terms: ["sourdough", "starter", "levain", "hydration", "autolyse", "crumb",
            "banneton", "scoring", "bulk", "ferment", "rye", "spelt", "oven",
            "steam", "loaf", "proof", "dough", "flour", "yeast", "bake"],
        templates: [
            "my {t0} {t1} is sluggish after the fridge, feeding twice a day has not revived it",
            "the {t2} smells sharp and vinegary, is that over{t9} or under fed",
            "{t3} at 78 percent gives me a slack {t16} that spreads on the peel",
            "an hour of {t4} before adding salt improved the {t5} noticeably",
            "the {t6} sticks even with rice {t17}, should I dust more heavily",
            "{t7} at a shallow angle gives a better ear on the {t14}",
            "{t8} fermentation is finishing too fast in a warm kitchen",
            "swapping a third of the {t10} for {t11} changed the flavour a lot",
            "no {t13} in the {t12} means a pale crust and a thick shell",
        ],
    },
    {
        id: "kayaking",
        label: "Sea kayaking",
        terms: ["kayak", "paddle", "tide", "current", "eddy", "swell", "hatch",
            "skeg", "rudder", "capsize", "roll", "spraydeck", "buoyancy",
            "headland", "crossing", "chart", "compass", "landing", "surf", "coastline"],
        templates: [
            "planning a {t14} at slack water so the {t2} does not push me off course",
            "the {t3} runs hard around the {t13}, best to wait an hour",
            "practising a {t10} in flat water before trying it in {t18}",
            "my {t7} jams when sand gets into the housing",
            "the front {t6} leaked on a long paddle, the seal is worn",
            "reading the {t15} against the {t16} bearing to plan the {t17}",
            "a following {t5} makes the boat want to broach",
            "the {t11} keeps water out but the {t12} aid still matters",
            "found a sheltered {t4} behind the rocks to rest in",
        ],
    },
    {
        id: "piano",
        label: "Piano practice",
        terms: ["piano", "scales", "arpeggio", "sightreading", "metronome",
            "fingering", "pedal", "chord", "voicing", "tempo", "octave",
            "sonata", "etude", "phrasing", "dynamics", "staccato", "legato",
            "rubato", "keyboard", "practice"],
        templates: [
            "half an hour of {t1} and {t2} before anything else in the morning",
            "{t3} improves fastest with short unfamiliar pieces every day",
            "setting the {t4} slower exposed how uneven my {t5} was",
            "the {t6} blurs the harmony if I hold it through the {t7} change",
            "{t8} the inner voices makes the {t11} movement much clearer",
            "the {t9} marking is far faster than I can play cleanly",
            "jumping an {t10} accurately needs the wrist not the fingers",
            "the {t12} is technically hard but the {t13} is what makes it musical",
            "contrasting {t14} between {t15} and {t16} passages",
        ],
    },
    {
        id: "gardening",
        label: "Vegetable gardening",
        terms: ["compost", "mulch", "seedling", "transplant", "pruning", "trellis",
            "aphid", "blight", "germination", "perennial", "rootstock",
            "greenhouse", "irrigation", "loam", "nitrogen", "harvest", "sowing",
            "frost", "pollinator", "bed"],
        templates: [
            "turning the {t0} heap weekly speeds it up a lot",
            "a thick layer of {t1} kept the soil damp through the dry spell",
            "the {t2} got leggy under the window, not enough light",
            "{t3} them out after the last {t17} is safest",
            "hard {t4} in winter gave much better fruit this year",
            "the beans need a taller {t5} than I built",
            "{t6} on the broad beans, squashing them by hand for now",
            "late {t7} ruined the potatoes two years running",
            "{t8} rates were poor from last season's saved seed",
        ],
    },
    {
        id: "cycling",
        label: "Bicycle maintenance",
        terms: ["derailleur", "cassette", "chainring", "bottombracket", "headset",
            "spoke", "truing", "brake", "rotor", "caliper", "tubeless",
            "sealant", "cadence", "drivetrain", "bearing", "torque", "hub",
            "freehub", "shifter", "wheelset"],
        templates: [
            "the rear {t0} hangs slightly bent after the bike fell over",
            "a worn {t1} makes the chain skip under load",
            "creaking from the {t3} turned out to be a dry {t14}",
            "{t5} tension was uneven so the wheel needed {t6}",
            "the disc {t8} rubs the {t9} when the wheel is out of true",
            "{t10} tyres with fresh {t11} seal small punctures well",
            "keeping a steady {t12} matters more than raw power on climbs",
            "the whole {t13} was gritty after a wet winter",
            "checked every bolt to the correct {t15} setting",
        ],
    },
    {
        id: "photography",
        label: "Film photography",
        terms: ["aperture", "shutter", "exposure", "darkroom", "developer",
            "negative", "enlarger", "contrast", "grain", "emulsion", "fixer",
            "bracket", "rangefinder", "lightmeter", "pushprocess", "stopbath",
            "contactsheet", "dodging", "burning", "filmstock"],
        templates: [
            "shooting wide open makes the {t0} very shallow",
            "a slow {t1} handheld gives motion blur below a sixtieth",
            "the {t2} was two stops out across the whole roll",
            "mixing fresh {t4} made a visible difference to the {t8}",
            "the {t5} looked thin, probably underdeveloped",
            "printing with a higher {t7} grade rescued a flat frame",
            "{t14} two stops let me shoot indoors on slow {t19}",
            "{t17} the corners and {t18} the sky in the print",
            "a {t16} first, then decide which frames deserve a full print",
        ],
    },
    {
        id: "chess",
        label: "Chess study",
        terms: ["opening", "endgame", "middlegame", "gambit", "fianchetto",
            "zugzwang", "tempo", "pawnstructure", "outpost", "prophylaxis",
            "calculation", "blunder", "tactic", "positional", "sacrifice",
            "castling", "initiative", "counterplay", "repertoire", "notation"],
        templates: [
            "building a narrow {t0} rather than learning many lines badly",
            "{t1} technique matters more than memorising the first ten moves",
            "declining the {t3} led to a comfortable position",
            "the kingside {t4} took two moves but paid off later",
            "a clean {t5} finish where every move worsens the position",
            "losing a {t6} to reroute the knight was worth it",
            "the doubled pawns wrecked my {t7} on the queenside",
            "a knight {t8} on d5 that cannot be challenged",
            "{t9} first, stop their plan before starting mine",
        ],
    },
    {
        id: "language",
        label: "Language learning",
        terms: ["vocabulary", "conjugation", "declension", "immersion", "fluency",
            "pronunciation", "intonation", "grammar", "spacedrepetition",
            "flashcard", "listening", "dictation", "idiom", "cognate",
            "subjunctive", "aspect", "transcript", "shadowing", "accent", "phrase"],
        templates: [
            "reviewing {t0} with {t8} beats cramming lists",
            "irregular {t1} are the hardest part so far",
            "daily {t3} through podcasts helped more than textbooks",
            "{t5} improved once I started {t17} along with recordings",
            "the {t14} mood still catches me out in writing",
            "{t9} decks get unmanageable past about two thousand cards",
            "{t11} exercises exposed how much I was guessing while {t10}",
            "{t12} rarely translate literally and have to be learned whole",
            "false {t13} are more dangerous than unfamiliar words",
        ],
    },
    {
        id: "woodwork",
        label: "Woodworking",
        terms: ["dovetail", "mortise", "tenon", "chisel", "planing", "grain",
            "jointer", "sanding", "veneer", "lacquer", "clamp", "workbench",
            "kerf", "rip", "crosscut", "hardwood", "softwood", "warp", "glueup",
            "marking"],
        templates: [
            "cutting {t0} by hand is slow but the fit is worth it",
            "the {t1} and {t2} joint needs to be snug, not tight",
            "a sharp {t3} makes all the difference to clean shoulders",
            "{t4} against the {t5} tears out badly",
            "flattening one face on the {t6} before anything else",
            "the {t17} appeared after a week in a dry room",
            "dry fitting before the {t18} saved a mess",
            "too narrow a {t12} and the blade binds in the cut",
            "{t13} cuts follow the {t5}, {t14} cuts go across it",
        ],
    },
    {
        id: "astronomy",
        label: "Amateur astronomy",
        terms: ["telescope", "eyepiece", "aperture", "collimation", "mount",
            "tracking", "nebula", "cluster", "magnitude", "seeing", "transparency",
            "averted", "focalratio", "barlow", "dobsonian", "equatorial",
            "lightpollution", "meridian", "ephemeris", "darkadaptation"],
        templates: [
            "a bigger {t2} gathers more light which matters more than magnification",
            "{t3} was out after transport, stars looked like commas",
            "the {t4} drifts noticeably without {t5}",
            "the {t6} was faint but the {t7} nearby was obvious",
            "{t9} was poor so high power was useless",
            "{t11} vision picks up detail the direct view misses",
            "adding a {t13} doubles the effective magnification",
            "a {t14} is simple to use but does not track",
            "{t16} from town washes out everything below {t8} four",
        ],
    },
];

/** Fill a template's {tN} placeholders with that topic's terms. */
export function renderTemplate(template, topic) {
    return template.replace(/\{t(\d+)\}/g, (_, i) => topic.terms[Number(i)] ?? "");
}
