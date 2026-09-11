// Builds the evaluation fixture databases.
//
// Three things this script has to get right, each of which would silently
// invalidate the tests if missed:
//
//  1. WRITE BOTH TABLES. Messages live in `turns`, but search reads only
//     `search_index`, and nothing copies between them — the real app populates
//     the index in its own code. A fixture with messages but no index returns
//     zero results for every query, which looks exactly like a broken ranker.
//
//  2. VARY SESSION SIZE. Real sessions run from 1 message to 329, median 4.
//     A fixture of uniformly-sized sessions cannot detect the size bias that
//     the real data shows (big sessions chosen 14.4x vs 3.0x), and hides how
//     the search engine's length normalisation behaves.
//
//  3. BE DETERMINISTIC. A fixed seed means rebuilding gives byte-identical
//     databases, so a change in test results is a change in the code and not
//     a reshuffle of the data.

import { DatabaseSync } from "node:sqlite";
import { existsSync, mkdirSync, rmSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { TOPICS, FILLER, renderTemplate } from "./topics.mjs";
import { UNCOMMON, UNCOMMON_ADVERBS, UNCOMMON_NOUNS, COMPOUND_A, COMPOUND_B, measurement, duration, ASK_FRAMES, REPLY_FRAMES } from "./language.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));
export const DB_DIR = join(HERE, "db");

/** Deterministic pseudo-random generator (mulberry32). */
function rng(seed) {
    let a = seed >>> 0;
    return () => {
        a |= 0; a = (a + 0x6d2b79f5) | 0;
        let t = Math.imul(a ^ (a >>> 15), 1 | a);
        t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
        return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
}

const pick = (r, arr) => arr[Math.floor(r() * arr.length)];

/**
 * The tail of rare words that real conversations contain.
 *
 * The real store has 9,658 words appearing in only one session out of 17,232
 * total. Crucially they are NOT nonsense — they are ordinary English used
 * occasionally, hyphenated compounds, and technical identifiers:
 *
 *   enabling, decimal, imperative, unscanned, acceptances,
 *   report-abuse, push-target, non-existent, auto-expand, tool_start_name
 *
 * An earlier version invented syllable strings ("xeldrovor") to fill this
 * role. The statistics matched but the text was unreadable, which made the
 * fixture impossible to trust by eye. These are built from real words instead.
 */
function rareWord(r) {
    const kind = r();
    if (kind < 0.45) return pick(r, UNCOMMON);
    if (kind < 0.8) return `${pick(r, COMPOUND_A)}-${pick(r, COMPOUND_B)}`;
    return measurement(r);
}

/**
 * Real session lengths are heavily skewed: median 4 messages, maximum 329.
 * Drawing from a long-tailed distribution reproduces that instead of a uniform
 * spread.
 */
function messageCount(r) {
    const u = r();
    if (u < 0.55) return 1 + Math.floor(r() * 5);    // 1-5   typical
    if (u < 0.85) return 6 + Math.floor(r() * 15);   // 6-20  medium
    if (u < 0.97) return 21 + Math.floor(r() * 40);  // 21-60 long
    return 61 + Math.floor(r() * 120);               // 61+   rare giants
}

/**
 * How many paragraphs one message contains.
 *
 * This matters more than it looks. Real messages average 2,184 characters —
 * long agent replies with several paragraphs, code and lists. An earlier
 * fixture used one-sentence messages averaging 292 characters, and that single
 * difference stopped it reproducing the filler-word bug entirely.
 *
 * The reason: the bug needs a session large enough to contain *every* common
 * word. In the real store exactly one session (1,036,874 characters) contains
 * all of "check, parts, started, changes, point" — and it is the session that
 * keeps surfacing as a confident "100% match" for questions about nothing in
 * particular. No fixture session was big enough to do that, so the fixture
 * quietly passed a test that fails in production.
 */
function paragraphCount(r) {
    const u = r();
    if (u < 0.4) return 1;                        // short exchange
    if (u < 0.75) return 2 + Math.floor(r() * 2); // typical reply
    if (u < 0.95) return 4 + Math.floor(r() * 4); // detailed answer
    return 8 + Math.floor(r() * 10);              // long explanation
}

/**
 * One message, written the way a person writes.
 *
 * The earlier version concatenated a topic sentence, a run of filler words and
 * a run of invented words, producing text like:
 *
 *   "titez hydration at 78 percent gives me a slack dough ... checking show
 *    parts case show than levain sourdough numo xeldrovor rivurn"
 *
 * The word statistics were right but it was not readable English, so nobody
 * could sanity-check the fixture by looking at it. This version wraps the
 * topic sentence in a real conversational frame and lets the filler and rare
 * words arrive naturally inside that sentence instead.
 */
function message(r, topic, isReply) {
    const weighted = () => topic.terms[Math.floor(r() ** 2 * topic.terms.length)];
    const one = () => {
        // Topic sentences are lower-case fragments; capitalise when one starts
        // a sentence, so the result reads as written English.
        const raw = renderTemplate(pick(r, topic.templates), topic);
        const core = raw.charAt(0).toUpperCase() + raw.slice(1) + ".";
        return pick(r, isReply ? REPLY_FRAMES : ASK_FRAMES)
            .replace("{s}", core)
            .replace("{u}", pick(r, UNCOMMON_ADVERBS))
            // {m} slots are always durations: "a couple of 25 degrees" reads
            // as obviously machine-assembled.
            .replace("{m}", duration(r))
            .replace("{c}", weighted());
    };
    // Several paragraphs per message, matching real message length. Replies
    // run longer than questions, as they do in practice.
    const n = isReply ? paragraphCount(r) : Math.max(1, paragraphCount(r) - 1);
    const parts = [one()];
    for (let i = 1; i < n; i++) {
        parts.push(r() < 0.5 ? one() : detailMessage(r, topic));
    }
    return parts.join(" ");
}

/**
 * A follow-up message that carries the topic's vocabulary and the rare-word
 * tail, so word frequencies stay realistic without wrecking readability.
 */
function detailMessage(r, topic) {
    const weighted = () => topic.terms[Math.floor(r() ** 2 * topic.terms.length)];
    const t1 = weighted(), t2 = weighted();
    const noun = () => pick(r, UNCOMMON_NOUNS);
    const compound = () => `${pick(r, COMPOUND_A)}-${pick(r, COMPOUND_B)}`;
    const shapes = [
        `Looking at the ${t1} more closely, the ${noun()} seems to be the problem.`,
        `I checked the ${t1} and the ${t2}, and the ${noun()} was clearly off.`,
        `The ${t1} settled after ${measurement(r)}, but the ${t2} still needs a ${compound()} tweak.`,
        `Worth noting the ${t1} behaves differently once the ${t2} is ${compound()}.`,
        `Same ${t1} problem as before, though the ${noun()} makes it harder to judge this time.`,
        `The ${noun()} between the ${t1} and the ${t2} is about ${measurement(r)}.`,
    ];
    return pick(r, shapes);
}

/**
 * A per-session subject phrase, so two sessions on the same topic are not near
 * duplicates.
 *
 * Without this, every session on a topic is built from the same nine
 * templates, so twenty baking sessions say nearly the same thing and exact
 * identification becomes almost impossible. Real sessions on one topic discuss
 * different specifics, which is what makes them identifiable.
 *
 * These are readable phrases rather than invented words, for the same reason
 * the rare-word tail is: a fixture nobody can read is a fixture nobody can
 * check.
 */
function sessionMarkers(r, count = 3) {
    const things = ["batch", "attempt", "session", "run", "setup", "project",
        "experiment", "round", "trial", "build"];
    const qualifiers = ["second", "third", "latest", "weekend", "evening",
        "winter", "summer", "practice", "backup", "spare"];
    return Array.from({ length: count }, () =>
        `${pick(r, qualifiers)} ${pick(r, things)} ${1 + Math.floor(r() * 40)}`);
}

// A fixed reference date, so rebuilding produces byte-identical databases.
// Using Date.now() made every rebuild differ, which would make a change in
// test results ambiguous: code change, or just a reshuffle of the data?
const REFERENCE_NOW = Date.parse("2026-09-01T12:00:00.000Z");

function isoDaysAgo(days) {
    return new Date(REFERENCE_NOW - days * 86_400_000).toISOString();
}

function createSchema(db) {
    db.exec(`
        CREATE TABLE sessions (
            id TEXT PRIMARY KEY, cwd TEXT, repository TEXT, host_type TEXT,
            branch TEXT, summary TEXT, created_at TEXT, updated_at TEXT
        );
        CREATE TABLE turns (
            id INTEGER PRIMARY KEY AUTOINCREMENT, session_id TEXT NOT NULL,
            turn_index INTEGER, user_message TEXT, assistant_response TEXT,
            timestamp TEXT, UNIQUE(session_id, turn_index)
        );
        CREATE TABLE session_files (
            id INTEGER PRIMARY KEY AUTOINCREMENT, session_id TEXT NOT NULL,
            file_path TEXT NOT NULL, tool_name TEXT, turn_index INTEGER,
            first_seen_at TEXT, UNIQUE(session_id, file_path)
        );
        CREATE TABLE checkpoints (
            id INTEGER PRIMARY KEY AUTOINCREMENT, session_id TEXT NOT NULL,
            checkpoint_number INTEGER, title TEXT, overview TEXT, history TEXT,
            work_done TEXT, technical_details TEXT, important_files TEXT,
            next_steps TEXT, created_at TEXT
        );
        CREATE VIRTUAL TABLE search_index USING fts5(
            content, session_id UNINDEXED, source_type UNINDEXED, source_id UNINDEXED
        );
    `);
}

/**
 * Insert one session into every table it belongs in.
 *
 * `indexed: false` deliberately skips the search index, to build the
 * "messages but no index" case that scenario A1 must detect.
 */
export function insertSession(db, s, { indexed = true } = {}) {
    db.prepare(
        `INSERT INTO sessions (id, cwd, repository, host_type, branch, summary, created_at, updated_at)
         VALUES (?,?,?,?,?,?,?,?)`,
    ).run(s.id, s.cwd ?? null, s.repository ?? null, null, s.branch ?? null,
        s.summary, s.createdAt, s.updatedAt);

    const insTurn = db.prepare(
        `INSERT INTO turns (session_id, turn_index, user_message, assistant_response, timestamp)
         VALUES (?,?,?,?,?)`,
    );
    const insIndex = db.prepare(`INSERT INTO search_index VALUES (?,?,?,?)`);

    s.turns.forEach((t, i) => {
        insTurn.run(s.id, i, t.user, t.assistant, s.updatedAt);
        // BOTH tables. Skipping this line is the mistake that makes a whole
        // fixture invisible to search.
        if (indexed) insIndex.run(`${t.user} ${t.assistant}`, s.id, "turn", String(i));
    });

    if (s.files?.length) {
        const insFile = db.prepare(
            `INSERT INTO session_files (session_id, file_path, tool_name, turn_index, first_seen_at)
             VALUES (?,?,?,?,?)`,
        );
        for (const f of s.files) insFile.run(s.id, f, "edit", 0, s.updatedAt);
    }

    if (s.checkpoint) {
        db.prepare(
            `INSERT INTO checkpoints (session_id, checkpoint_number, title, overview,
                work_done, technical_details, important_files, next_steps, created_at)
             VALUES (?,?,?,?,?,?,?,?,?)`,
        ).run(s.id, 1, s.checkpoint.title, s.checkpoint.overview, s.checkpoint.workDone ?? "",
            s.checkpoint.technical ?? "", (s.files ?? []).join(", "),
            s.checkpoint.nextSteps ?? "", s.updatedAt);
        if (indexed) {
            insIndex.run(s.checkpoint.overview, s.id, "checkpoint_overview", "1");
            if (s.checkpoint.nextSteps) {
                insIndex.run(s.checkpoint.nextSteps, s.id, "checkpoint_next_steps", "1");
            }
        }
    }
}

/**
 * Build the shared background: realistic sessions spread across all topics.
 *
 * `withGiant` adds one enormous long-running session. It is off by default
 * because such a session dominates every query — which is the real behaviour,
 * but it swamps the tests that measure whether retrieval can find the right
 * topic at all. It belongs in the databases that exist to measure domination
 * (the filler-word and size-bias tests), not in the one measuring accuracy.
 */
export function buildBackground(count, seed = 12345, { withGiant = false } = {}) {
    const r = rng(seed);
    const sessions = [];
    for (let i = 0; i < count; i++) {
        const topic = TOPICS[i % TOPICS.length]; // even spread, not random clumps
        const n = messageCount(r);
        // Words unique to this session, so it can be told apart from its
        // twenty topic-mates. Real sessions differ in their specifics.
        const markers = sessionMarkers(r);
        const turns = Array.from({ length: n }, (_, k) => ({
            // The marker phrase goes near the FRONT. Term extraction keeps only
            // the first 12 meaningful words of a question, so anything at the
            // end of a long message never reaches the search — which is why
            // appending markers had no effect on identification.
            user: `About the ${pick(r, markers)}. ${message(r, topic, false)}`,
            assistant: k % 2 === 0
                ? message(r, topic, true)
                : `${message(r, topic, true)} ${detailMessage(r, topic)}`,
        }));
        const ageDays = Math.floor(r() * 120);
        const iso = isoDaysAgo(ageDays);
        const s = {
            id: `bg-${topic.id}-${String(i).padStart(3, "0")}`,
            summary: `${topic.label}: ${renderTemplate(topic.templates[i % topic.templates.length], topic).slice(0, 60)}`,
            createdAt: iso,
            updatedAt: iso,
            turns,
        };
        // A fifth of sessions carry files, for the file-overlap tests.
        if (r() < 0.2) {
            s.repository = `example/${topic.id}-project`;
            s.branch = `feature/${topic.id}-${i}`;
            s.cwd = `C:/work/${topic.id}-project`;
            s.files = [
                `C:/work/${topic.id}-project/src/${topic.terms[0]}.ts`,
                `C:/work/${topic.id}-project/src/${topic.terms[1]}.ts`,
                `C:/work/${topic.id}-project/test/${topic.terms[2]}.test.ts`,
            ];
        }
        // A tenth carry a checkpoint with unfinished next steps.
        if (r() < 0.1) {
            s.checkpoint = {
                title: `${topic.label} checkpoint`,
                overview: message(r, topic, true),
                nextSteps: `still to do: ${message(r, topic, false)}`,
            };
        }
        sessions.push(s);
    }

    // A giant long-running session, which every real store seems to have.
    //
    // The real store has one of 1,036,874 characters — a conversation that ran
    // for weeks — and it is the ONLY session containing every common word.
    // That is what makes it match questions about nothing in particular at
    // "100%", and it is the actual mechanism behind the filler-word bug.
    //
    // Without one, the filler test passed on the fixture while failing 10
    // times out of 10 on real data. A fixture that quietly passes a test
    // production fails is worse than no fixture.
    if (withGiant) {
        sessions.push({
            id: "bg-giant-000",
            summary: `${TOPICS[0].label}: long running thread`,
            createdAt: isoDaysAgo(60),
            updatedAt: isoDaysAgo(2),
            turns: Array.from({ length: 320 }, (_, k) => ({
                // Cycles through every topic, as a long thread naturally drifts.
                user: message(r, TOPICS[k % TOPICS.length], false),
                assistant: message(r, TOPICS[k % TOPICS.length], true),
            })),
        });
    }

    return sessions;
}

export function openFresh(path) {
    mkdirSync(dirname(path), { recursive: true });
    if (existsSync(path)) rmSync(path, { force: true });
    const db = new DatabaseSync(path);
    createSchema(db);
    return db;
}

export { rng, message, detailMessage, isoDaysAgo, messageCount };
