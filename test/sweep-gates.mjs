// Sweeps the two gates that decide whether a card reaches the screen:
//
//   cutoff  how much of the question a session must cover to count as related
//   score   how strong a hint must be before it is worth interrupting for
//
// Lowering only one moves the blockage to the other, so they have to be read
// together. `shown` and `right` are what matter; A3 and A4 are the cost side.
// Everything is restored before the process exits.
//
//   node sweep-gates.mjs

import { readFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { DB_DIR, REFERENCE_NOW } from "./generate.mjs";
import {
    setSessionStore, generateCandidates, buildHintCandidates,
    setMinCoverage, setCoverageFocus, DEFAULT_MIN_COVERAGE, DEFAULT_COVERAGE_FOCUS,
} from "../src/retrieval.mjs";
import { rankAndGate } from "../src/ranker.mjs";

const KEY_PATH = join(DB_DIR, "answer-key.json");
if (!existsSync(KEY_PATH)) {
    console.error("The fixture databases are missing.\n\nBuild them first:\n  node build.mjs\n");
    process.exit(1);
}
const key = JSON.parse(readFileSync(KEY_PATH, "utf8"));
for (const [name, file] of Object.entries(key.databases)) {
    key.databases[name] = join(DB_DIR, file);
}

const quiet = { cooldownMinutes: 0, globalCooldownMinutes: 0, holdoutRate: 0, epsilon: 0 };
const search = (task) => generateCandidates({ task, files: [], now: REFERENCE_NOW }).candidates;

function shownFor(query, sessionId, scoreThreshold) {
    return rankAndGate(buildHintCandidates(search(query), { files: [] }), {
        trigger: "test", sessionId, config: { ...quiet, scoreThreshold },
    }).shown;
}

function leaks(queries, sessionId, scoreThreshold) {
    let n = 0;
    for (const q of queries) if (shownFor(q, sessionId, scoreThreshold).length) n++;
    return n;
}

function topical(scoreThreshold) {
    setSessionStore(key.databases.core);
    let ranked = 0, shown = 0, right = 0;
    const bands = { easy: [0, 0], medium: [0, 0], hard: [0, 0] };
    for (const { query, acceptable, difficulty } of key.core.topical) {
        const candidates = search(query);
        const ids = candidates.map((c) => c.sessionId);
        const ok = ids.length > 0 && acceptable.includes(ids[0]);
        if (ok) ranked++;
        const b = bands[difficulty ?? "easy"];
        b[1]++; if (ok) b[0]++;

        const hints = rankAndGate(buildHintCandidates(candidates, { files: [] }), {
            trigger: "test", sessionId: "sweep", config: { ...quiet, scoreThreshold },
        }).shown;
        if (hints.length) {
            shown++;
            const target = hints[0].evidence?.sessionId ?? hints[0].action?.sessionId ?? null;
            if (target && acceptable.includes(target)) right++;
        }
    }
    const n = key.core.topical.length;
    return {
        ranked: ranked / n, shown: shown / n, right: right / n,
        easy: bands.easy[0] / bands.easy[1],
        medium: bands.medium[0] / bands.medium[1],
        hard: bands.hard[0] / bands.hard[1],
    };
}

function knownItemTop5() {
    setSessionStore(key.databases.core);
    let hit = 0;
    for (const { query, expect } of key.core.knownItem) {
        if (search(query).map((c) => c.sessionId).slice(0, 5).includes(expect)) hit++;
    }
    return hit / key.core.knownItem.length;
}

function sizeBias() {
    setSessionStore(key.databases.sizeBias);
    let wins = 0;
    for (const { query, short, long } of key.sizeBias.pairs) {
        const ids = search(query).map((c) => c.sessionId);
        const si = ids.indexOf(short), li = ids.indexOf(long);
        if (si !== -1 && (li === -1 || si < li)) wins++;
    }
    return wins / key.sizeBias.pairs.length;
}

const CUTOFF = [0.15, 0.20, 0.25, 0.30, 0.34];
const SCORE = [0.20, 0.25, 0.30, 0.35];

const pct = (v) => `${(v * 100).toFixed(0)}%`.padStart(4);

setCoverageFocus(DEFAULT_COVERAGE_FOCUS);

console.log(`\ncutoff x score threshold   (coverage focus ${DEFAULT_COVERAGE_FOCUS})\n`);
console.log(`  cutoff score |  A1   |  A2   | easy  med  hard | shown right |  A3   |  A4   |  A5`);
console.log(`  -------------+-------+-------+------------------+-------------+-------+-------+------`);

const winners = [];
for (const c of CUTOFF) {
    for (const s of SCORE) {
        setMinCoverage(c);
        const a1 = knownItemTop5();
        const a2 = topical(s);
        setSessionStore(key.databases.core);
        const a3 = leaks(key.core.impossible, "sweep-a3", s);
        setSessionStore(key.databases.sizeBias);
        const a4 = leaks(key.core.fillerOnly, "sweep-a4", s);
        const a5 = sizeBias();

        const pass = a1 >= 0.90 && a2.ranked >= 0.60 && a3 === 0 && a4 <= 1 && a5 >= 0.40;
        if (pass) winners.push({ c, s, right: a2.right, shown: a2.shown, ranked: a2.ranked });
        console.log(
            `   ${pct(c)}  ${pct(s)} | ${pct(a1)}  | ${pct(a2.ranked)}  |`
            + ` ${pct(a2.easy)} ${pct(a2.medium)} ${pct(a2.hard)} |`
            + ` ${pct(a2.shown)} ${pct(a2.right)} |`
            + ` ${String(a3).padStart(2)}/15 | ${String(a4).padStart(2)}/10 |`
            + ` ${pct(a5)}${pass ? "   ALL PASS" : ""}`);
    }
    console.log(`  -------------+-------+-------+------------------+-------------+-------+-------+------`);
}

setMinCoverage(DEFAULT_MIN_COVERAGE);
setCoverageFocus(DEFAULT_COVERAGE_FOCUS);

if (winners.length) {
    winners.sort((a, b) => b.right - a.right || a.shown - b.shown);
    const w = winners[0];
    console.log(`\nBest setting that passes every graded test:`);
    console.log(`  cutoff ${pct(w.c)}   score ${pct(w.s)}   ->  `
        + `a correct card on ${pct(w.right)} of questions, ranking ${pct(w.ranked)}`);
} else {
    console.log(`\nNo combination passes every graded test.`);
}
console.log("");
