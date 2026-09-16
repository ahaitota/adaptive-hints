// Which instructions does the user repeat across different sessions?
//
// A remark made once is a remark. The same instruction given in three separate
// conversations is a standing preference — and repetition is close to the
// definition of "worth reusing", without needing a model to judge it.
//
// Two cues combined:
//   shape       the sentence tells the agent what to do or not do
//   repetition  it shows up in more than one session
//
// Read-only. Writes nothing.
//
//   node repeated-guidance.mjs

import { DatabaseSync } from "node:sqlite";
import { DEFAULT_SESSION_STORE, extractTerms } from "../src/retrieval.mjs";
import { extractUserTask } from "../src/prompt-filter.mjs";

// Words that mark a sentence as telling the agent what to do, rather than
// asking it something. Deliberately small: a long list would match everything.
const RULE_CUES = /\b(always|never|don'?t|do not|instead|prefer|make sure|should not|shouldn'?t|must|avoid|stop|only|first|before you|from now on|please do|remember to)\b/i;
const QUESTION = /^(what|how|why|when|where|which|who|can you|could you|is |are |does |do you|did you)\b/i;

// The session store keeps whatever was submitted, which includes skill
// documentation, system reminders and other runtime text — not just what the
// person typed. That text repeats WORD FOR WORD across sessions, while a human
// rephrases, so without this filter repetition finds the boilerplate and misses
// the person. Measured: the top "standing preferences" were all lines from the
// canvas-authoring skill, such as "Bind to loopback only".
const DOC_SHAPE = /^[-*>#|]|^\d+\.\s|\*\*|`{1,3}[a-z_]|\{|\}|::|^\s*$/i;

function userSentences(message) {
    const task = extractUserTask(message, { minChars: 1 });
    if (!task) return [];
    return task.split(/(?<=[.!?])\s+|\n+/)
        .map((s) => s.replace(/\s+/g, " ").trim())
        .filter((s) => !DOC_SHAPE.test(s));
}

const db = new DatabaseSync(DEFAULT_SESSION_STORE, { readOnly: true });
const totalSessions = db.prepare(
    `SELECT COUNT(DISTINCT session_id) AS n FROM search_index`).get().n || 1;
const dfStmt = db.prepare(
    `SELECT COUNT(DISTINCT session_id) AS n FROM search_index WHERE search_index MATCH ?`);
const dfCache = new Map();
const idf = (t) => {
    if (!dfCache.has(t)) {
        let df = 0;
        try { df = dfStmt.get(`"${t}"`).n; } catch { df = 0; }
        dfCache.set(t, Math.log(1 + (totalSessions - df + 0.5) / (df + 0.5)));
    }
    return dfCache.get(t);
};

const turns = db.prepare(`
    SELECT session_id, user_message FROM turns WHERE user_message IS NOT NULL`).all();

const candidates = [];
for (const t of turns) {
    for (const s of userSentences(t.user_message)) {
        if (s.length < 15 || s.length > 220) continue;
        if (QUESTION.test(s)) continue;          // asking, not instructing
        if (!RULE_CUES.test(s)) continue;        // no instruction shape
        // Signature: the sentence's most distinctive words.
        const terms = [...new Set(extractTerms(s, 40))]
            .filter((w) => idf(w) > 1.2)
            .sort((a, b) => idf(b) - idf(a))
            .slice(0, 5);
        if (terms.length < 2) continue;
        candidates.push({ session: t.session_id, text: s, sig: new Set(terms) });
    }
}
db.close();

// Group sentences that share most of their distinctive words.
const groups = [];
for (const c of candidates) {
    let placed = false;
    for (const g of groups) {
        let shared = 0;
        for (const w of c.sig) if (g.sig.has(w)) shared++;
        const j = shared / (c.sig.size + g.sig.size - shared);
        if (j >= 0.4) {
            g.members.push(c);
            g.sessions.add(c.session);
            for (const w of c.sig) g.sig.add(w);
            placed = true;
            break;
        }
    }
    if (!placed) groups.push({ sig: new Set(c.sig), members: [c], sessions: new Set([c.session]) });
}

const repeated = groups.filter((g) => g.sessions.size >= 2)
    .sort((a, b) => b.sessions.size - a.sessions.size || b.members.length - a.members.length);

console.log(`\nInstruction-shaped sentences found: ${candidates.length}`);
console.log(`Distinct groups: ${groups.length}`);
console.log(`Groups repeated across 2+ sessions: ${repeated.length}\n`);

if (!repeated.length) {
    console.log(`  Nothing repeats across sessions yet.\n`);
} else {
    console.log(`Standing preferences, most repeated first:\n`);
    for (const g of repeated.slice(0, 12)) {
        console.log(`  [${g.sessions.size} sessions, ${g.members.length} times]`);
        for (const m of g.members.slice(0, 3)) {
            console.log(`     "${m.text.slice(0, 96)}"`);
        }
        console.log("");
    }
}

const once = groups.filter((g) => g.sessions.size === 1).length;
console.log(`For contrast, ${once} instruction-shaped sentences appear in only one session.`);
console.log(`Those are decisions about one task; the repeated ones are how this person`);
console.log(`wants to be worked with.\n`);
