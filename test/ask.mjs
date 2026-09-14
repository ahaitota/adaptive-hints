// Ask the fake session data a question by hand and see what comes back.
//
// Typing a question into a real Copilot chat searches the real session store,
// so it cannot be used to check these test results. This points the same
// retrieval code at a fixture database instead, and prints what it found and
// why. Nothing is written: the fixtures are opened read-only and the learning
// log is never touched.
//
//   node ask.mjs "the crust comes out pale and soft instead of crisp"
//   node ask.mjs --db dominance "check that part again"
//   node ask.mjs --gate "how do I renew my passport"
//
// --db     core (default) | dominance | paraphrase | recency
// --gate   also apply the show/hide rules, to see what a user would actually get
// --all    list every candidate, not just the top 5

import { existsSync } from "node:fs";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { DB_DIR, REFERENCE_NOW } from "./generate.mjs";
import {
    setSessionStore, generateCandidates, buildHintCandidates, extractTerms, minCoverage, minRarity,
} from "../src/retrieval.mjs";
import { rankAndGate } from "../src/ranker.mjs";

const DATABASES = {
    core: "core.db",
    dominance: "dominance.db",
    paraphrase: "paraphrase.db",
    recency: "recency.db",
};

const argv = process.argv.slice(2);
let dbName = "core", gate = false, showAll = false;
const words = [];
for (let i = 0; i < argv.length; i++) {
    if (argv[i] === "--db") dbName = argv[++i];
    else if (argv[i] === "--gate") gate = true;
    else if (argv[i] === "--all") showAll = true;
    else words.push(argv[i]);
}
const question = words.join(" ").trim();

if (!question) {
    console.error(`Ask the fake session data a question.

  node ask.mjs "the crust comes out pale and soft instead of crisp"

Options:
  --db <name>   which fake database: ${Object.keys(DATABASES).join(", ")} (default core)
  --gate        also apply the show/hide rules, to see what a user would get
  --all         list every candidate, not just the top 5
`);
    process.exit(1);
}

const dbFile = DATABASES[dbName];
if (!dbFile) {
    console.error(`Unknown database "${dbName}". Choose one of: ${Object.keys(DATABASES).join(", ")}`);
    process.exit(1);
}
const dbPath = join(DB_DIR, dbFile);
if (!existsSync(dbPath)) {
    console.error(`The fake databases are missing.\n\nBuild them first:\n  node build.mjs\n`);
    process.exit(1);
}

setSessionStore(dbPath);

/**
 * The sessions that came closest without passing the coverage rule.
 *
 * generateCandidates() discards these before returning, so this repeats the
 * same IDF-weighted coverage calculation to show what was thrown away and why.
 */
function nearMisses(path, terms, limit = 5) {
    if (!terms.length) return [];
    const db = new DatabaseSync(path, { readOnly: true });
    try {
        const total = db.prepare(
            `SELECT COUNT(DISTINCT session_id) AS n FROM search_index`).get().n || 1;
        const idf = new Map();
        const bySession = new Map();
        for (const t of terms) {
            const rows = db.prepare(
                `SELECT DISTINCT session_id FROM search_index WHERE search_index MATCH ?`).all(`"${t}"`);
            idf.set(t, Math.log(1 + (total - rows.length + 0.5) / (rows.length + 0.5)));
            for (const r of rows) {
                if (!bySession.has(r.session_id)) bySession.set(r.session_id, new Set());
                bySession.get(r.session_id).add(t);
            }
        }
        const totalWeight = terms.reduce((s, t) => s + idf.get(t), 0) || 1;
        const summaries = new Map(
            db.prepare(`SELECT id, summary FROM sessions`).all().map((r) => [r.id, r.summary]));

        return [...bySession.entries()]
            .map(([id, matched]) => ({
                id,
                matched: [...matched],
                summary: summaries.get(id) || null,
                cov: [...matched].reduce((s, t) => s + idf.get(t), 0) / totalWeight,
            }))
            .sort((a, b) => b.cov - a.cov)
            .slice(0, limit);
    } finally {
        db.close();
    }
}

const terms = extractTerms(question);
const { candidates, reason, droppedLowCoverage } = generateCandidates({
    task: question, files: [], now: REFERENCE_NOW,
});

console.log(`\nQuestion   "${question}"`);
console.log(`Database   ${dbFile}`);
console.log(`Searched   ${terms.length ? terms.join(", ") : "(nothing — every word was too common or too short)"}`);
console.log("=".repeat(70));

if (!candidates.length) {
    if (reason === "task_too_generic") {
        console.log(`\nNothing searched — every word in this question is too common to`);
        console.log(`identify a session. The rarest one appears in ${(minRarity() * 100).toFixed(0)}% or more of them.`);
        console.log(`\nThis is the intended answer: a question of nothing but ordinary words`);
        console.log(`carries no information about which session is wanted.\n`);
        process.exit(0);
    }

    const why = reason === "below_min_coverage"
        ? `${droppedLowCoverage} session(s) shared some words, but none reached the `
          + `${(minCoverage() * 100).toFixed(0)}% needed to count as related`
        : "no session contains any of these words";
    console.log(`\nNothing found — ${why}.`);

    // "Nothing found" has two very different causes: the subject is absent, or
    // the right session was found and then thrown away for being just under the
    // threshold. Without the near misses those look identical, and the second
    // case is the more interesting one.
    const near = nearMisses(dbPath, terms);
    if (near.length) {
        console.log(`\nClosest sessions that were rejected:\n`);
        for (const s of near) {
            console.log(`   ${s.id}   ${(s.cov * 100).toFixed(0)}%   matched [${s.matched.join(", ")}]`);
            if (s.summary) console.log(`      "${s.summary.slice(0, 80)}"`);
        }
        console.log(`\nIf these are about the right subject, the search did find them`);
        console.log(`and the ${(minCoverage() * 100).toFixed(0)}% rule discarded them.\n`);
    } else {
        console.log(`\nNo session shares any of these words.\n`);
    }
    process.exit(0);
}

const shown = showAll ? candidates : candidates.slice(0, 5);
console.log(`\n${candidates.length} session(s) matched. Showing ${shown.length}:\n`);

for (const [i, c] of shown.entries()) {
    const topic = c.sessionId.split("-")[1] || "?";
    console.log(`${i + 1}. ${c.sessionId}   topic: ${topic}`);
    console.log(`   score ${c.retrievalScore.toFixed(3)}   `
        + `match ${(c.coverage * 100).toFixed(0)}% (${c.matchedTerms} of ${c.totalTerms} words)   `
        + `recency ${c.recency.toFixed(2)}`);
    if (c.summary) console.log(`   "${c.summary.slice(0, 90)}"`);
    console.log(`   ...${c.snippet.replace(/\s+/g, " ").slice(0, 110)}...`);
    console.log("");
}

if (gate) {
    // Cooldowns and the holdout are disabled so a single question is not
    // silently suppressed by rules meant for a long live session.
    const hints = buildHintCandidates(candidates, { files: [] });
    const result = rankAndGate(hints, {
        trigger: "test", sessionId: "ask",
        config: { cooldownMinutes: 0, globalCooldownMinutes: 0, holdoutRate: 0, epsilon: 0 },
    });
    console.log("-".repeat(70));
    if (result.shown.length) {
        console.log(`\nA user would see ${result.shown.length} hint:\n`);
        for (const h of result.shown) {
            console.log(`   [${h.type}] ${h.title}`);
            console.log(`   score ${h.score.toFixed(2)} — ${String(h.body).replace(/\s+/g, " ").slice(0, 120)}`);
        }
    } else {
        console.log(`\nA user would see nothing: every candidate was below the score needed to show.`);
    }
    console.log("");
}
