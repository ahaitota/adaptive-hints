// Picks the BM25 saturation constant by measurement.
//
// BM25 has no upper bound, so it must be squashed into 0..1 before it can be
// added to coverage. It used to be divided by the largest value in the same
// result set, which threw away the only thing it knew — how strong the match
// was. `k` is the score that now maps to 0.5.
//
// Lower k = bm25 counts for more. Higher k = coverage dominates further.
//
//   node sweep-bm25.mjs

import { readFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { DB_DIR, REFERENCE_NOW } from "./generate.mjs";
import {
    setSessionStore, generateCandidates, buildHintCandidates,
    setBm25Saturation, DEFAULT_BM25_SATURATION,
} from "../src/retrieval.mjs";
import { rankAndGate } from "../src/ranker.mjs";

const KEY_PATH = join(DB_DIR, "answer-key.json");
if (!existsSync(KEY_PATH)) {
    console.error("The fixture databases are missing.\n\nBuild them first:\n  node build.mjs\n");
    process.exit(1);
}
const key = JSON.parse(readFileSync(KEY_PATH, "utf8"));
for (const [n, f] of Object.entries(key.databases)) key.databases[n] = join(DB_DIR, f);

const quiet = { cooldownMinutes: 0, globalCooldownMinutes: 0, holdoutRate: 0, epsilon: 0 };
const search = (t) => generateCandidates({ task: t, files: [], now: REFERENCE_NOW }).candidates;
const shownFor = (q, id) => rankAndGate(buildHintCandidates(search(q), { files: [] }),
    { trigger: "test", sessionId: id, config: quiet }).shown;

function a1() {
    setSessionStore(key.databases.core);
    let topic = 0, found = 0;
    for (const { query, expect } of key.core.knownItem) {
        const ids = search(query).map((c) => c.sessionId);
        if (ids[0] && ids[0].split("-")[1] === expect.split("-")[1]) topic++;
        if (ids.includes(expect)) found++;
    }
    const n = key.core.knownItem.length;
    return { topic: topic / n, found: found / n };
}

function a2() {
    setSessionStore(key.databases.core);
    let ranked = 0, right = 0;
    for (const { query, acceptable } of key.core.topical) {
        const cands = search(query);
        if (cands.length && acceptable.includes(cands[0].sessionId)) ranked++;
        const shown = rankAndGate(buildHintCandidates(cands, { files: [] }),
            { trigger: "test", sessionId: "sweep", config: quiet }).shown;
        const t = shown[0]?.evidence?.sessionId;
        if (t && acceptable.includes(t)) right++;
    }
    const n = key.core.topical.length;
    return { ranked: ranked / n, right: right / n };
}

function leaks(qs, id) {
    let n = 0;
    for (const q of qs) if (shownFor(q, id).length) n++;
    return n;
}

function a5() {
    setSessionStore(key.databases.sizeBias);
    let w = 0;
    for (const { query, short, long } of key.sizeBias.pairs) {
        const ids = search(query).map((c) => c.sessionId);
        const si = ids.indexOf(short), li = ids.indexOf(long);
        if (si !== -1 && (li === -1 || si < li)) w++;
    }
    return w / key.sizeBias.pairs.length;
}

function a7() {
    setSessionStore(key.databases.recency);
    let w = 0, gap = 0;
    for (const { query, recent, old } of key.recency.pairs) {
        const c = search(query);
        const r = c.find((x) => x.sessionId === recent);
        const o = c.find((x) => x.sessionId === old);
        if (r && (!o || r.retrievalScore >= o.retrievalScore)) w++;
        if (r && o) gap = Math.max(gap, Math.abs(r.retrievalScore - o.retrievalScore));
    }
    return { wins: w / key.recency.pairs.length, gap };
}

const pct = (v) => `${(v * 100).toFixed(0)}%`.padStart(4);

console.log(`\nChoosing the BM25 saturation constant k\n`);
console.log(`    k  |  A1 topic  found |  A2 ranked shown-right |  A3   |  A4   |  A5   |  A7 gap`);
console.log(`  -----+------------------+------------------------+-------+-------+-------+---------`);

for (const k of [2, 4, 6, 8, 12, 16, 24]) {
    setBm25Saturation(k);
    const r1 = a1(), r2 = a2();
    setSessionStore(key.databases.core);
    const l3 = leaks(key.core.impossible, "s3");
    setSessionStore(key.databases.sizeBias);
    const l4 = leaks(key.core.fillerOnly, "s4");
    const r5 = a5(), r7 = a7();
    const ok = r1.topic >= 0.9 && r1.found >= 0.9 && r2.ranked >= 0.6
        && l3 === 0 && l4 <= 1 && r5 >= 0.4 && r7.wins >= 0.95 && r7.gap < 0.45;
    console.log(`   ${String(k).padStart(2)}  |   ${pct(r1.topic)}   ${pct(r1.found)}  |`
        + `    ${pct(r2.ranked)}      ${pct(r2.right)}     |`
        + ` ${String(l3).padStart(2)}/15 | ${String(l4).padStart(2)}/10 | ${pct(r5)}  |`
        + `  ${r7.gap.toFixed(3)}${ok ? "   ALL PASS" : ""}`);
}

setBm25Saturation(DEFAULT_BM25_SATURATION);
console.log(`
  A1 needs 90% on both      A2 ranked needs 60%     A3 needs 0/15
  A4 needs 0-1/10           A5 needs 40%            A7 gap under 0.45
  shown-right = a card appears AND points at the right subject
`);
