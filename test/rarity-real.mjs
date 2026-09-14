// How distinctive are real questions, compared to content-free ones?
//
// The rarity gate was calibrated on the fixtures, where a genuine question
// always contains a word appearing in 10% or fewer sessions. Real vocabulary is
// far narrower — one subject, not ten — so the same number may not separate
// anything. This measures both sides against the REAL store, read-only.
//
//   node rarity-real.mjs

import { DatabaseSync } from "node:sqlite";
import { DEFAULT_SESSION_STORE, extractTerms, minRarity } from "../src/retrieval.mjs";

const db = new DatabaseSync(DEFAULT_SESSION_STORE, { readOnly: true });
const total = db.prepare(`SELECT COUNT(DISTINCT session_id) AS n FROM search_index`).get().n;
const dfStmt = db.prepare(
    `SELECT COUNT(DISTINCT session_id) AS n FROM search_index WHERE search_index MATCH ?`);

/** Share of sessions containing the question's rarest word. */
function rarest(text) {
    const terms = extractTerms(text);
    if (!terms.length) return null;
    let best = 1, word = null;
    for (const t of terms) {
        const r = dfStmt.get(`"${t}"`).n / total;
        if (r < best) { best = r; word = t; }
    }
    return { share: best, word, terms };
}

const CONTENT_FREE = [
    "can you check that part again and look at the changes before we start",
    "please look at this again and tell me what you think about it",
    "can you make the changes we talked about before and check them",
    "I need you to go over that part once more and see what changed",
    "have another look at what we did and let me know if it works",
    "can you start again from the beginning and check each part",
    "go back and look at the last change to see if it is right",
    "just check the thing we changed before and make sure it still works",
];

const rows = db.prepare(`
    SELECT session_id, user_message FROM turns
    WHERE user_message IS NOT NULL AND LENGTH(user_message) BETWEEN 60 AND 200
    ORDER BY session_id LIMIT 800`).all();
const seen = new Set();
const realQs = [];
for (const r of rows) {
    if (seen.has(r.session_id)) continue;
    seen.add(r.session_id);
    realQs.push(r.user_message);
    if (realQs.length >= 30) break;
}

const pct = (v) => `${(v * 100).toFixed(0)}%`;

function summarise(label, texts, show) {
    const vals = texts.map((t) => rarest(t)).filter(Boolean);
    const shares = vals.map((v) => v.share).sort((a, b) => a - b);
    console.log(`\n${label}  (n=${shares.length})`);
    console.log(`  min ${pct(shares[0])}   p25 ${pct(shares[Math.floor(shares.length * 0.25)])}   `
        + `median ${pct(shares[Math.floor(shares.length / 2)])}   `
        + `p75 ${pct(shares[Math.floor(shares.length * 0.75)])}   max ${pct(shares[shares.length - 1])}`);
    if (show) {
        for (const v of vals.sort((a, b) => a.share - b.share)) {
            console.log(`    ${pct(v.share).padStart(4)}  rarest "${v.word}"`);
        }
    }
    return shares;
}

console.log(`\nReal session store: ${total} sessions indexed`);
console.log(`Current rarity gate: block when the rarest word is in ${pct(minRarity())} or more of sessions`);

const real = summarise("Real sentences from real sessions", realQs, false);
const filler = summarise("Content-free questions", CONTENT_FREE, true);

console.log(`\nSeparation using the RAREST word`);
console.log(`  real questions, worst case   ${pct(real[real.length - 1])}`);
console.log(`  content-free, best case      ${pct(filler[0])}`);
if (filler[0] > real[real.length - 1]) {
    console.log(`  clean gap`);
} else {
    console.log(`  NO CLEAN GAP — one incidental rare word defeats this measure`);
}

// The rarest word is a minimum, so a single unusual word in an otherwise empty
// sentence passes. Try measures that describe the question as a whole.
function stats(text) {
    const terms = extractTerms(text);
    if (!terms.length) return null;
    const shares = terms.map((t) => dfStmt.get(`"${t}"`).n / total).sort((a, b) => a - b);
    const mean = shares.reduce((s, v) => s + v, 0) / shares.length;
    return {
        min: shares[0],
        second: shares[1] ?? shares[0],
        median: shares[Math.floor(shares.length / 2)],
        mean,
        // How many words are genuinely distinctive, not just the rarest one.
        distinctive: shares.filter((s) => s <= 0.25).length,
    };
}

const measures = ["min", "second", "median", "mean", "distinctive"];
const realStats = realQs.map(stats).filter(Boolean);
const fillerStats = CONTENT_FREE.map(stats).filter(Boolean);

console.log(`\nWhich measure separates the two groups?\n`);
console.log(`  measure       real worst   content-free best   separates?`);
console.log(`  ------------+------------+-------------------+-----------`);
for (const m of measures) {
    const r = realStats.map((s) => s[m]).sort((a, b) => a - b);
    const f = fillerStats.map((s) => s[m]).sort((a, b) => a - b);
    // For "distinctive" more is better, so the comparison flips.
    const more = m === "distinctive";
    const realWorst = more ? r[0] : r[r.length - 1];
    const fillerBest = more ? f[f.length - 1] : f[0];
    const ok = more ? realWorst > fillerBest : fillerBest > realWorst;
    const fmt = (v) => (more ? String(v).padStart(4) : pct(v).padStart(4));
    console.log(`  ${m.padEnd(12)}|    ${fmt(realWorst)}    |        ${fmt(fillerBest)}       |   ${ok ? "YES" : "no"}`);
}
console.log("");
db.close();
