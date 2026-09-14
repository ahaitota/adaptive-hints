// Tunes the coverage cutoff against the REAL session store, read-only.
//
// The fixtures cannot settle this. They contain ten hobby topics, so a question
// about passports shares nothing with them. A real store is one narrow subject,
// where "rescue", "cure" and "covers" all occur in ordinary technical talk — so
// an off-topic question still partially matches.
//
// Questions are only counted as false hints when a genuinely distinctive word
// of theirs appears ZERO times in the store. Anything else may be a correct
// match: this conversation itself discusses passports and sourdough, so hints
// pointing at it are right, not leaks.
//
//   node tune-real.mjs

import { DatabaseSync } from "node:sqlite";
import {
    DEFAULT_SESSION_STORE, setSessionStore, generateCandidates, buildHintCandidates,
    setMinCoverage, setCoverageFocus, setMinRarity, setSizePenalty,
    DEFAULT_MIN_COVERAGE, DEFAULT_COVERAGE_FOCUS, DEFAULT_MIN_RARITY, DEFAULT_SIZE_PENALTY,
} from "../src/retrieval.mjs";
import { rankAndGate, DEFAULT_CONFIG } from "../src/ranker.mjs";

setSessionStore(DEFAULT_SESSION_STORE);
setCoverageFocus(DEFAULT_COVERAGE_FOCUS);
setMinRarity(DEFAULT_MIN_RARITY);
setSizePenalty(DEFAULT_SIZE_PENALTY);

const db = new DatabaseSync(DEFAULT_SESSION_STORE, { readOnly: true });
const dfStmt = db.prepare(
    `SELECT COUNT(DISTINCT session_id) AS n FROM search_index WHERE search_index MATCH ?`);
const df = (w) => dfStmt.get(`"${w}"`).n;

const CANDIDATE_QUESTIONS = [
    ["how do I renew my passport before travelling abroad", "passport"],
    ["what temperature should I roast a leg of lamb at", "lamb"],
    ["which vaccinations are needed for tropical countries", "vaccinations"],
    ["how long does concrete take to cure in cold weather", "concrete"],
    ["what paperwork is needed to adopt a rescue greyhound", "greyhound"],
    ["how do I treat a bee sting on a child", "sting"],
    ["which insurance covers flooding in a basement", "flooding"],
    ["what is involved in servicing a gas boiler", "boiler"],
    ["what is the best way to remove limescale from a kettle", "limescale"],
    ["how do I descale an espresso machine safely", "espresso"],
    ["which knots are used for climbing anchors", "knots"],
    ["what is the notice period for ending a tenancy", "tenancy"],
];

const clean = CANDIDATE_QUESTIONS.filter(([, w]) => df(w) === 0);
const dirty = CANDIDATE_QUESTIONS.filter(([, w]) => df(w) > 0);

console.log(`\nOff-topic questions usable as false-hint tests: ${clean.length} of ${CANDIDATE_QUESTIONS.length}`);
if (dirty.length) {
    console.log(`Excluded, because the store really does discuss them:`);
    for (const [q, w] of dirty) console.log(`   "${w}" appears in ${df(w)} session(s)  —  ${q.slice(0, 50)}`);
}

// Real sentences from the middle of real sessions: the recall side.
const rows = db.prepare(`
    SELECT session_id, user_message FROM turns
    WHERE user_message IS NOT NULL AND LENGTH(user_message) BETWEEN 60 AND 200
    ORDER BY session_id LIMIT 600`).all();
const seen = new Set();
const sample = [];
for (const r of rows) {
    if (seen.has(r.session_id)) continue;
    seen.add(r.session_id);
    sample.push(r);
    if (sample.length >= 25) break;
}

const quiet = { cooldownMinutes: 0, globalCooldownMinutes: 0, holdoutRate: 0, epsilon: 0 };
function shown(task, score) {
    const { candidates } = generateCandidates({ task, files: [] });
    const hints = rankAndGate(buildHintCandidates(candidates, { files: [] }), {
        trigger: "test", sessionId: "tune-real", config: { ...quiet, scoreThreshold: score },
    }).shown;
    return { hints, candidates };
}

const CUTOFF = [0.20, 0.25, 0.30, 0.34, 0.40];
const SCORE = [0.25, 0.30, 0.35];

console.log(`\n  cutoff score | false hints | own session top5 | card appears | weakest match shown`);
console.log(`  -------------+-------------+------------------+--------------+--------------------`);

for (const c of CUTOFF) {
    for (const s of SCORE) {
        setMinCoverage(c);
        let falseHits = 0, weakest = 1;
        for (const [q] of clean) {
            const { hints } = shown(q, s);
            if (hints.length) falseHits++;
        }
        let top5 = 0, cards = 0;
        for (const r of sample) {
            const { hints, candidates } = shown(r.user_message, s);
            if (candidates.map((x) => x.sessionId).slice(0, 5).includes(r.session_id)) top5++;
            if (hints.length) {
                cards++;
                const cov = hints[0].evidence?.coverage;
                if (typeof cov === "number" && cov < weakest) weakest = cov;
            }
        }
        console.log(
            `   ${String(Math.round(c * 100)).padStart(3)}%  ${String(Math.round(s * 100)).padStart(3)}% |`
            + `    ${String(falseHits).padStart(2)}/${clean.length}     |`
            + `      ${String(top5).padStart(2)}/${sample.length}       |`
            + `    ${String(cards).padStart(2)}/${sample.length}     |`
            + `   ${cards ? `${Math.round(weakest * 100)}%` : "n/a"}`);
    }
    console.log(`  -------------+-------------+------------------+--------------+--------------------`);
}

setMinCoverage(DEFAULT_MIN_COVERAGE);
console.log(`
  false hints        off-topic questions that produced a card   want 0
  own session top5   recall on real sentences                   higher is better
  card appears       how often a card would show at all
  weakest match      the lowest "% match" a user would be shown
`);
db.close();
