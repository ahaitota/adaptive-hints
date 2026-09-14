// Read-only sanity check of the new retrieval settings against the REAL
// session store. Writes nothing, logs nothing, opens the database read-only.
//
// The fixtures are synthetic and were wrong twice before, so a setting that
// looks good there has to be checked against real data before being trusted.
//
//   node check-real.mjs

import { DatabaseSync } from "node:sqlite";
import {
    DEFAULT_SESSION_STORE, setSessionStore, generateCandidates, buildHintCandidates,
    extractTerms, minCoverage, minRarity, coverageFocus, sizePenalty,
    setMinCoverage, setMinRarity, setCoverageFocus, setSizePenalty,
    DEFAULT_MIN_COVERAGE, DEFAULT_MIN_RARITY, DEFAULT_COVERAGE_FOCUS, DEFAULT_SIZE_PENALTY,
} from "../src/retrieval.mjs";
import { rankAndGate, DEFAULT_CONFIG } from "../src/ranker.mjs";

// The settings as they were before this round of work, so "did I make it
// worse?" can be answered instead of assumed.
const BEFORE = {
    label: "before", minCoverage: 0.34, focus: 0, rarity: 1, size: 0, score: 0.35,
};
const AFTER = {
    label: "after", minCoverage: DEFAULT_MIN_COVERAGE, focus: DEFAULT_COVERAGE_FOCUS,
    rarity: DEFAULT_MIN_RARITY, size: DEFAULT_SIZE_PENALTY, score: DEFAULT_CONFIG.scoreThreshold,
};

function apply(s) {
    setMinCoverage(s.minCoverage);
    setCoverageFocus(s.focus);
    setMinRarity(s.rarity);
    setSizePenalty(s.size);
}

setSessionStore(DEFAULT_SESSION_STORE);
const db = new DatabaseSync(DEFAULT_SESSION_STORE, { readOnly: true });

const totalSessions = db.prepare(
    `SELECT COUNT(DISTINCT session_id) AS n FROM search_index`).get().n;
const sizes = db.prepare(`
    SELECT session_id, COUNT(*) AS chunks, SUM(LENGTH(content)) AS chars
    FROM search_index GROUP BY session_id ORDER BY chars DESC`).all();

console.log(`\nReal session store`);
console.log(`  sessions indexed   ${totalSessions}`);
console.log(`  largest session    ${sizes[0].chars.toLocaleString()} chars in ${sizes[0].chunks} messages`);
console.log(`  median session     ${sizes[Math.floor(sizes.length / 2)].chars.toLocaleString()} chars`);

// 1. Filler must stay silent. These are the words that actually appear
//    everywhere in THIS database, not a guessed list.
const FILLER = ["check", "change", "part", "look", "make", "work", "need", "want",
    "start", "point", "thing", "some", "after", "before", "give", "most", "again"];
const common = FILLER.filter((w) => {
    const n = db.prepare(
        `SELECT COUNT(DISTINCT session_id) AS n FROM search_index WHERE search_index MATCH ?`)
        .get(`"${w}"`).n;
    return n / totalSessions > 0.5;
});

const quiet = { cooldownMinutes: 0, globalCooldownMinutes: 0, holdoutRate: 0, epsilon: 0 };
function wouldShow(task, scoreThreshold) {
    const { candidates, reason } = generateCandidates({ task, files: [] });
    const shown = rankAndGate(buildHintCandidates(candidates, { files: [] }), {
        trigger: "test", sessionId: "check-real", config: { ...quiet, scoreThreshold },
    }).shown;
    return { shown, reason, candidates };
}

const IMPOSSIBLE = [
    "how do I renew my passport before travelling abroad",
    "what temperature should I roast a leg of lamb at",
    "which vaccinations are needed for tropical countries",
    "how long does concrete take to cure in cold weather",
    "what paperwork is needed to adopt a rescue greyhound",
    "how do I treat a bee sting on a child",
    "which insurance covers flooding in a basement",
    "what is involved in servicing a gas boiler",
];

const real = db.prepare(`
    SELECT session_id, user_message FROM turns
    WHERE user_message IS NOT NULL AND LENGTH(user_message) BETWEEN 60 AND 200
    ORDER BY session_id LIMIT 400`).all();
const seen = new Set();
const sample = [];
for (const r of real) {
    if (seen.has(r.session_id)) continue;
    seen.add(r.session_id);
    sample.push(r);
    if (sample.length >= 20) break;
}

const giant = sizes[0].session_id;

function measure(s) {
    apply(s);
    const rnd = (() => { let x = 7; return () => (x = (x * 1103515245 + 12345) % 2147483648) / 2147483648; })();

    let filler = 0;
    for (let i = 0; i < 10; i++) {
        const q = Array.from({ length: 9 }, () => common[Math.floor(rnd() * common.length)]).join(" ");
        if (wouldShow(q, s.score).shown.length) filler++;
    }

    const impossibleLeaks = [];
    for (const q of IMPOSSIBLE) {
        const { shown } = wouldShow(q, s.score);
        if (shown.length) impossibleLeaks.push({ q, body: shown[0].body });
    }

    let found = 0, shownCount = 0, giantWins = 0;
    for (const r of sample) {
        const { candidates, shown } = wouldShow(r.user_message, s.score);
        const ids = candidates.map((c) => c.sessionId);
        if (ids.slice(0, 5).includes(r.session_id)) found++;
        if (shown.length) shownCount++;
        if (candidates[0]?.sessionId === giant) giantWins++;
    }
    return { filler, impossibleLeaks, found, shownCount, giantWins };
}

const before = measure(BEFORE);
const after = measure(AFTER);
apply(AFTER);

const n = sample.length;
console.log(`
                                        before    after
  filler-only questions leaking          ${String(before.filler).padStart(2)}/10    ${String(after.filler).padStart(2)}/10     want 0
  impossible questions leaking           ${String(before.impossibleLeaks.length).padStart(2)}/${IMPOSSIBLE.length}     ${String(after.impossibleLeaks.length).padStart(2)}/${IMPOSSIBLE.length}      want 0
  own session found in top 5             ${String(before.found).padStart(2)}/${n}    ${String(after.found).padStart(2)}/${n}     higher is better
  a card would appear                    ${String(before.shownCount).padStart(2)}/${n}    ${String(after.shownCount).padStart(2)}/${n}
  giant session was top result           ${String(before.giantWins).padStart(2)}/${n}    ${String(after.giantWins).padStart(2)}/${n}     want 0`);

if (after.impossibleLeaks.length) {
    console.log(`\n  Impossible questions that still produce a hint:\n`);
    for (const l of after.impossibleLeaks) {
        console.log(`    "${l.q}"`);
        console.log(`      -> ${l.body.replace(/\s+/g, " ").slice(0, 96)}`);
    }
}

console.log(`
  Settings compared
    before   cutoff ${BEFORE.minCoverage}  focus ${BEFORE.focus}  rarity off  size 0     score ${BEFORE.score}
    after    cutoff ${AFTER.minCoverage}  focus ${AFTER.focus}  rarity ${AFTER.rarity}   size ${AFTER.size}   score ${AFTER.score}
`);

db.close();
