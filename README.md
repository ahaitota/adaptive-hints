# adaptive-hints

Agent hint cards that are ranked against **your own prior sessions**, and that
learn from every accept / reject so the next hint is more likely to be one you
want.

Implements Phases 0–4 of the design plan.

## Project layout

```
adaptive-hints/
├── extension.mjs        entry point — must keep this name and location,
│                        the app discovers extensions by finding it
├── src/                 implementation
│   ├── rules.mjs          preferences learned across sessions
│   ├── retrieval.mjs      search over the local session store
│   ├── ranker.mjs         scoring, gating, exploration
│   ├── store.mjs          the learning log and settings
│   ├── renderer.mjs       the canvas panel
│   ├── prompt-filter.mjs  real prompts vs runtime-injected text
│   └── changed-files.mjs  files in play, from git
├── test/
│   ├── rules.test.mjs     deterministic tests for preference learning
│   └── observe.mjs        record, list and promote preferences by hand
├── local/               retrieval experiments and fixtures, not committed
├── artifacts/           your own data, never committed
└── .gitignore
```

Three things are deliberately kept out of version control: `artifacts/`, which
holds real repository names, file paths and quotes from your own sessions;
`local/`, which holds the retrieval evaluation suite and its 23 MB of generated
fixtures; and `docs/`, which holds local planning notes.

## Preferences learned across sessions

A new session starts knowing nothing about you. If you have asked thirteen
times to be answered in plain language, the fourteenth session still has to be
told. This is the part that remembers.

**An agent notices. Code confirms.**

One session cannot know whether a request is a standing preference or a one-off
— it has seen one conversation, and it has just been told the thing, which
makes it a poor judge of whether the thing matters. So the agent may only
record an **observation**, tagged with its session. Everything after that is
arithmetic over distinct session IDs, which one session cannot fake.

That guarantee is structural rather than a promise: `addObservation` has no
status field, and only `promote()` writes one. The first test in
`rules.test.mjs` fires fifty observations from a single session and asserts
that nothing is activated.

### Three stages

| Stage | Reached by | Behaviour |
| --- | --- | --- |
| **candidate** | fewer than 3 sessions | invisible, gathering evidence |
| **active** | 3 different sessions state it | applied, and asks each time |
| **trusted** | 5 accepts in a row | applied silently |

Repetition and approval answer different questions. Repetition shows you
**meant** it. It cannot show that the rule was written down correctly, or that
firing it at that moment helps, because you were never asked. So confirmation
and silence are earned separately.

One rejection resets the streak and pulls a trusted rule back to asking. A rule
that is wrong once will be wrong again, and silence is exactly when being wrong
costs most. Accepts must be **consecutive** — six accepts around one rejection
earn nothing.

Turning a rule off keeps its evidence and offers **restore**. That exists
because testing the button destroyed a real observation with no way back.

### Two sentences per rule

A rule holds an instruction and a question, because they have different
audiences:

| Field | Goes to | Example |
| --- | --- | --- |
| `rule` | the agent, as context | *Open the result so I can see it* |
| `ask` | the approval card | *Shall I open the result so you can see it?* |

Showing the instruction on the card reads as the user's own words quoted back
at them, which is a strange thing to be asked to approve. The instruction is
still shown underneath, so nothing is hidden. A later session may supply a
question an earlier one omitted, but cannot overwrite one that exists.

### No keyword matching

The agent is shown the current rule list at session start and either adds
weight to an existing id or writes a new one-line rule. Code only counts.

This matters because word matching cannot see that *"in simple words"*,
*"simpler"* and *"I don't understand"* are one preference. Measured on a real
session store: counting words found **one** preference; letting the agent group
them found **six**.

### Scope

A rule starts at the narrowest scope that fits and widens only on evidence —
the same preference seen in three different repositories becomes global. One
agent cannot decide something is universal, having seen one project.

### By hand

```
node test/observe.mjs --list
node test/observe.mjs --session <id> --rule "..." --when ... --quote "..."
node test/observe.mjs --promote
```

Rules live in `artifacts/rules.json`: plain text, readable, editable and
deletable without tooling, like the hint log.

## What it does

```
your task text  (auto: every prompt you submit — see "When hints appear")
      │
      ▼
┌─────────────────┐   term coverage + BM25 tie-break + file overlap + recency
│ retrieval.mjs   │   over ~/.copilot/session-store.db  (READ-ONLY)
└─────────────────┘
      │  scored prior sessions → typed hint candidates
      ▼
┌─────────────────┐   × Beta-Bernoulli acceptance rate for (type, trigger)
│ ranker.mjs      │   then gate: threshold, one-per-type, cooldown,
│                 │   reject-suppressor, max 1 visible, ε-greedy explore
└─────────────────┘
      │  at most one hint
      ▼
┌─────────────────┐   impressions, outcomes, suppressed candidates, holdouts
│ store.mjs       │   → artifacts/hint-log.jsonl   (append-only, inspectable)
└─────────────────┘
      │
      ▼
   canvas panel: Accept / Reject / Why this?
```

## Hint types

| Type | Status | Fires when | Evidence |
| --- | --- | --- | --- |
| `reuse_chat` | ✅ working | A prior session's text strongly matches the task | IDF-weighted coverage |
| `resume_next_steps` | ✅ working | A matching prior checkpoint left unfinished next steps | `checkpoints.next_steps` |
| `reuse_file_scope` | ✅ working | A prior session touched files you are currently changing | Jaccard on `session_files` |

### Where "files in play" come from

`changed-files.mjs` derives them from git: `diff --name-only HEAD` plus
untracked files, resolved to absolute paths against the repo root. That is the
closest available proxy for what a session is about, since the
`onUserPromptSubmitted` hook provides only `workingDirectory`.

Two constraints shaped it:

- **Never block the prompt.** Refreshes run in the background on a 30s TTL and
  callers get the previous answer immediately. The first prompt in a directory
  sees no files; every later one does. A synchronous `git diff` on the hot path
  would have added latency to every message for a signal that changes slowly.
- **Degrade silently.** Not a repo, git missing, timeout, or a diff over 200
  files all yield an empty list — which just means no file-scope hints. A
  sprawling diff says nothing about focus and would distort the overlap ratio.

File overlap is the most precise of the three signals: much harder to fake than
word overlap. In testing it scored **0.67** against `reuse_chat`'s **0.49** on
the same task, which is the intended ordering.

## When hints appear

Two triggers:

1. **Automatic** — an `onUserPromptSubmitted` hook runs the pipeline on every
   prompt you submit (trigger point `prompt_submitted`).

   `prompt-filter.mjs` decides what counts as a prompt. The hook also fires for
   text the *runtime* injects — autopilot reminders, system reminders,
   canvas/skill context — and retrieving against that is actively harmful:
   words like "task", "complete", "steps" and "error" appear in nearly every
   stored session, so coverage comes out high while relevance is nil. Observed
   before the fix: an autopilot reminder scored **92% coverage (11/12 terms)**
   and produced a confident, entirely irrelevant hint.

   The filter strips injected `<…>` blocks **first** (real messages arrive with
   context appended, so signature-matching the raw text would discard genuine
   prompts whenever a canvas is open), then rejects tagless runtime text,
   slash commands, and anything under `minPromptChars`.

   The gate handles the rest, so this stays quiet in practice.
   When a hint does survive, the panel updates and the agent is told via
   `additionalContext`.
2. **Manual** — ask the agent to `propose`, or open the canvas with a `task`.

Global off switch: `configure` with `{ "autoPropose": false }`.

## How a hint is scored

1. **Text relevance** — `0.75 × coverage + 0.25 × normalizedBM25`.

   **Coverage** is the share of your query's *meaning* a prior session covers,
   measured as IDF-weighted term overlap: `Σ idf(matched) / Σ idf(all terms)`.

   It deliberately dominates, because raw BM25 magnitude is *not* an absolute
   relevance measure — it rewards rare terms, so a nonsense query containing
   one unusual word can outscore a genuinely related one (measured: a gibberish
   query scored 4.89 vs 1.72 for a good one).

   **normalizedBM25 is `s / (s + 8)`**, a saturating curve. It used to be
   `s / max(s in this result set)`, which threw away the only thing BM25 knew:
   how strong the match was. Measured on the fixtures — a real sentence's best
   hit scores about **32.9** and an unanswerable question's best hit about
   **5.4**, and dividing by the result-set maximum turned **both into exactly
   1.0**. Saturation maps them to 0.80 and 0.40 instead, without looking at the
   other results, so "best of a weak field" stays weak.

   `8` is the score that maps to 0.5, swept in `local/sweep-bm25.mjs`. Every
   value from 2 to 24 keeps all tests green, and 8 sits mid-range rather than at
   an edge. Be honest about the size of this: coverage carries 0.75 of the
   weight and the cutoff does most of the filtering, so on real data this
   changed recall not at all and false hits by at most one.

   Coverage is **IDF-weighted rather than a plain count** because counting
   terms equally lets filler carry the score. Measured case: a query about
   "fts / dense / retrieval / bm25" scored 67% while *every* topic-defining
   term missed — the matches were `use`, `show`, `exactly`, `these`. Weighting
   by IDF cut that query from 12 surviving candidates to 3, while leaving a
   genuinely good query at 100%.

   Candidates below `MIN_COVERAGE` (0.30) are dropped outright.

   Coverage is measured **twice** and blended 50/50: once over the whole
   session, once over the single best message in it. The session-wide figure is
   what a very long thread exploits — 490 messages contain every common word
   somewhere, so it reports 100% for a question it has nothing to do with. The
   single-message figure asks whether the subject was ever actually discussed
   in one place.

   Two further rules apply before a candidate survives:

   - **Rarity gate.** If the rarest word in the *question* appears in 40% or
     more of all sessions, nothing is returned at all (`task_too_generic`).
     A question of nothing but near-universal words cannot identify a session.
     Measured: genuine questions have a word in ≤10% of sessions, filler-only
     questions bottom out at 56%.
   - **Key term.** The highest-IDF word of the question must be among the
     matched terms, unless it appears nowhere in the store. Coverage is a ratio,
     so a candidate can clear the cutoff on supporting words while the one word
     that carries the subject is missing.
2. **Files** — combined as `0.65 × text + 0.35 × fileOverlap` when files are
   known; otherwise text carries the full weight (the overlap term carries no
   information then, so folding it back is more honest than penalising
   everything).
3. **Size** — multiplies by `1 − 0.20 × min(1, log10(chunks / median chunks))`.
   Only separates candidates that already cover the question equally well: a
   focused note and a 160-message thread containing the same sentence both
   reach 100% coverage, and without this the longer one wins on BM25 tie-break
   every time.
4. **Recency** — multiplies by `0.55 + 0.45 × 2^(-ageDays/14)`. Modulates, never
   dominates: a strong old match still beats a weak fresh one.
5. **Personalization** — multiplies by `0.5 + acceptanceRate`, the Beta(1,1)
   posterior mean for that `(hint type, trigger point)`.
   - never seen → 0.5 → **×1.00** (no effect; cold start is neutral)
   - always rejected → →0 → **×0.50**
   - always accepted → →1 → **×1.50**

## How the gate decides

Acceptance rate is driven more by *showing fewer hints* than by better ranking,
so the gate is deliberately aggressive:

| Rule | Default |
| --- | --- |
| Minimum final score | `0.30` |
| Max hints shown per trigger | `1` |
| One candidate per hint type | always |
| Cooldown per type | `30 min` |
| Global cooldown (any type) | `45 min` |
| Hard suppress after N rejects in 7d | `2` |
| Holdout (shown nothing, on purpose) | `8%` |
| ε-greedy exploration | `10%` |

The **global** cooldown exists because a per-type cooldown alone lets one hint
of each type fire on consecutive prompts, which reads as a burst. Observed in
practice before the fix: two different types fired on back-to-back messages.

Everything rejected by the gate is logged with its reason, so the gate itself
can be evaluated later — not just the hints that survived it.

**Holdout** is deterministic per `(session, trigger, day)`, so it is stable
across reloads and gives a counterfactual to compare against.

**Exploration** matters: without it the log only ever contains hints the ranker
already ranked first, and the counters can never self-correct.

## Actions

| Action | Purpose |
| --- | --- |
| `remember_preference` | Record a durable preference the user stated. Cannot activate anything. |
| `preferences` | List learned preferences; merge or retire one. |
| `propose` | Retrieve → rank → gate → display. Logs an impression per hint shown. |
| `record_outcome` | `accepted` / `rejected` / `ignored` / `preempted`. Rejects unknown hint IDs. |
| `stats` | Phase-5 evaluation metrics + learned per-type counters. |
| `explain` | Dry run: show scoring and gating **without** displaying or logging. |
| `configure` | Read/set `autoPropose` (global off switch) and `minPromptChars`. |

Use `preempted` when the user did the suggested thing without clicking — that
is a *success* the accept/reject buttons would otherwise record as an ignore.

### What Accept does

1. Loads the prior session and queues a briefing (`artifacts/pending/<sessionId>.json`).
2. Posts a confirmation to the timeline via `session.log`, e.g.
   *"Hint accepted — context from "Diff mode experiment" (7.5 KB) will reach the
   agent with your next message."*
3. Delivers the briefing through `additionalContext` on the next prompt, then
   clears the queue and records it under "Accepted context sent to the agent".

The confirmation says **"will reach"** rather than "was sent" because at click
time the briefing is only queued — it is handed over on the next prompt. Saying
"sent" would imply the agent can act on it immediately, which it cannot.

`session.log` is used rather than `session.send` so the confirmation reads as
system feedback instead of a chat turn the user appears to have typed. Valid
levels are `info`, `warning`, `error` only; passing `debug` throws
`unsupported session log level` and kills the extension on startup.

## Panel

The panel shows **one learned preference at a time**, in a card, with a pager
to walk through them: waiting for an answer first, then already running
silently, then turned off.

Preferences still gathering evidence are **not shown**. They have not been
offered, so asking the user to react to them would be asking about a decision
the system has not made. The header counts them — *"2 still being learned"* —
and they appear the moment a third session confirms them.

Each card leads with the question, shows the instruction underneath, quotes
your own words as evidence, and says which stage it is in — *waiting for your
answer · 2/5 accepted*, *applied without asking*, *turned off*. Accept, reject,
merge, turn off and restore all live on the card, each with a tooltip saying
what it costs.

Cards are a fixed height with the buttons pinned to the bottom, and the panel
scales with its own width. Both exist because of how it felt to use: paging
between cards of different heights moved the buttons under the cursor, and the
panel sat stretched after a resize until the mouse entered it.

Two things used to sit here and no longer do. A **retrieval hint card** with a
"Why this?" score breakdown occupied this slot, which was the wrong way round —
the preferences are the thing that needs a decision. And a **Learning signal**
table reported accept rate, engagement and gate pass rate for hint types;
`summarize()` still computes those and the `stats` action still returns them,
for anyone reading offline.

Retrieval still runs and is still logged, but it has no card. The agent is told
about a relevant prior session and may mention it in passing; there is nothing
to click.

The removed breakdown grouped the score to show the chain rather than a flat
list, which is worth keeping in mind if it is ever rebuilt:

```
INGREDIENTS → RETRIEVAL SCORE
  term coverage    ×0.75
  bm25 tie-break   ×0.25
  = text match
  file overlap     0.65/0.35 split, or "unused, no files"
  recency          → ×(0.55 + 0.45r)
  = retrieval score
LEARNING → MULTIPLIER
  learned accept rate  (n=…)
  = 0.5 + rate
  = final score        retrieval × multiplier
```

An earlier flat layout listed coverage, overlap and recency as if they were
peers of the retrieval score, which made it look like four independent factors
multiplied at the end. They are not: they are the inputs that *produce* the
retrieval score, and only the personal multiplier is applied on top. The
`explain` action still returns all of it.

## Configuring

`configure` reads or writes `artifacts/settings.json`. Saved gate overrides
apply to **both** automatic and manual proposals; a per-call `config` on
`propose` wins over them.

| Setting | Purpose |
| --- | --- |
| `autoPropose` | Global off switch for automatic hints |
| `minPromptChars` | Skip prompts shorter than this |
| `testMode` | Zero both cooldowns and the holdout; `false` restores defaults |
| `cooldownMinutes` / `globalCooldownMinutes` | Rate limits |
| `scoreThreshold` / `maxVisible` / `holdoutRate` / `epsilon` | Gate + learning knobs |
| `sessionStorePath` | Point retrieval at a fixture database; `null` restores the real one |

### Running against a fixture database

`sessionStorePath` moves **only the searched corpus**. The learning log,
settings and accepted-context queue stay where they are, so an evaluation run
cannot contaminate what the system has learned from real use.

This is deliberately narrower than `COPILOT_HOME`, which moves everything and
needs an app restart. Switching fixtures takes effect immediately.

Three guards, each for a mistake that costs a debugging session:

- **Path does not exist** → rejected with `store_not_found`.
- **`search_index` is empty** → rejected with `store_not_indexed`. This is the
  important one. Rows written to `turns` are *not* searchable until they are
  also written to `search_index` — there are no triggers, the app populates the
  index in its own code. A fixture built by filling in only `turns` returns
  zero results for every query, which looks exactly like a broken ranker.
- **Forgetting a fixture is active** → the panel shows a `FIXTURE DB` badge, and
  `configure`/`stats` report `activeSessionStore` and `usingFixture`.

The choice survives an extension reload, so a long evaluation run cannot
silently revert to the real store partway through.

**Isolation across experiments.** Tests that plant artificial sessions (long vs
short pairs, paraphrase pairs, date twins) need their own database, because a
plant left in a shared corpus becomes a false match for a later test. But each
fixture still needs a realistic background of ~200 varied sessions: word rarity
is computed from whatever is present, and in a 2-session database the rarest
possible word and a common word score identically (0.69 vs 0.69), so scoring
behaves nothing like production.

**Test mode** exists because the shipped defaults make the system almost
invisible — a 45-minute global cooldown plus an 8% holdout means you can use it
for an hour and see nothing, which is correct in production and useless when
you are trying to watch it work. It zeroes both cooldowns and the holdout so a
hint fires on every prompt, and the panel shows a **TEST MODE** badge so the
inflated `hintsPerSession` and `impressions` are not mistaken for real usage.

Set `maxVisible: 2` as well if you want to see the pager.

Turn it off with `configure({ testMode: false })`, which clears the overrides
rather than leaving zeroed cooldowns silently in place.

## Outcomes — what counts as a signal

| State | Meaning | Feeds learning? |
| --- | --- | --- |
| `accepted` | You clicked Accept | ✅ positive, weight 1 |
| `preempted` | You did the suggested thing without clicking | ✅ positive, weight 1 |
| `rejected` | You clicked Reject | ✅ negative, weight 1 |
| `ignored` | Explicitly recorded as ignored | ✅ negative, weight 1 |
| `agent_relevant` | The agent chose to surface it | ✅ positive, **weight 0.5** |
| `agent_irrelevant` | The agent chose *not* to surface it | ✅ negative, **weight 0.5** |
| `superseded` | A newer hint replaced it before you answered | ❌ **no signal** |
| `pending` | Still waiting | ❌ no signal |

### The agent as reranker

The agent is already doing LLM reranking, informally: the hook hands it each
surviving hint and it decides whether to surface it, using the whole
conversation as context that keyword retrieval cannot see. That judgment used
to be discarded. `record_relevance` captures it.

This matters because it is **free** — the decision is already being made — and
because it does not require the user to click anything, which is the scarcest
signal in the system. Weighted at 0.5 because the agent is *predicting* the
user's reaction rather than observing it.

**An agent judgment never dismisses the card.** It is a ranking signal, not a
decision made on the user's behalf. Because the agent records its verdict
within seconds of the prompt, treating it as a decision made cards vanish
before the user could read them — reported as *"the hint disappears in about
10 seconds"*. The card now stays until the user clicks, and displays the
agent's verdict and reasoning instead:

> *Agent: not relevant — 74% match on generic terms; prior session was about
> TRX merging*

Showing it rather than hiding it also makes the most valuable case
expressible: a user who accepts a hint the agent called irrelevant is
disagreeing with the reranker, which is the sharpest feedback available.

**Supersession is deliberately not an outcome.** A hint scrolling out of the
panel because a newer one arrived says nothing about what you thought — you may
never have opened the panel. Counting it as a miss creates a feedback loop that
drives every hint type toward zero regardless of quality.

This was observed in production: 40 impressions produced 39 auto-generated
"ignored" rows and **zero real clicks**, from which the system had "learned" a
7% accept rate (n=13) for `resume_next_steps` and was suppressing it at ×0.57.
With the fix, the same log yields n=0 and a neutral ×1.00 — the honest answer
when nobody has clicked anything.

`acceptRate` is therefore computed over *decisions*, not impressions. Dividing
by impressions would report 0% for a user who simply never opened the panel.
`engagementRate` (clicked ÷ shown) is the metric that reveals that case.

`stats` reports the full Phase-5 table, not just accept rate:

- `acceptRate` — the stated goal, over *decisions* not impressions
- `engagementRate` — clicked ÷ shown; catches "user never opened the panel"
- `unanswered` — impressions with no signal either way
- `hintsPerSession` — guards against gaming accept-rate by simply hiding hints
- `ignoreRate` — a better annoyance signal than reject
- `gateSelectivity` — shown ÷ (shown + suppressed)
- `holdoutTriggers` — size of the counterfactual arm

## Data

- Log (**user-global**): `~/.copilot/extensions/adaptive-hints/artifacts/hint-log.jsonl`
- Active proposal (**per session**): `.../artifacts/proposals/<sessionId>.json`
- Settings: `.../artifacts/settings.json`
- Reads `~/.copilot/session-store.db` **read-only**; never writes to it.

The split is deliberate. The learning log is global because learning across
sessions is the entire point. The *active proposal* is UI state for one
conversation: it was originally a single shared `current-proposal.json`, which
meant whichever session fired last took over every open panel — a chat could
display another session's task and hints. Measured at the time: 38 of 42
impressions came from sessions other than the one being viewed.

Everything stays local and per-user. Delete the artifacts directory to reset
all learning.

## Known limitations

- `acceptRate` is a proxy. Optimizing it directly produces clickbait hints;
  that is what the holdout arm is there to catch.
- Counters are per `(type, trigger)`, not per topic. A ranker over the full
  feature set (Phase 4.2) is the next step, and needs ~200+ labeled
  impressions first.
- Cold start falls back to pure retrieval with a *stricter* effective gate,
  which is the intended direction.
- **Nothing measures whether a preference was learned correctly.** The tests
  cover everything that decides whether to *trust* the agent's judgement — the
  counting, the stages, the scope — but not the judgement itself. A rule
  recorded from a misread conversation would still need three sessions and five
  accepts before it could act silently, which is the point, but no test catches
  a badly worded rule.
- **Preferences need three sessions before they do anything.** On a fresh
  machine the feature is invisible for a while. Backfilling from existing
  session history (`local/backfill.mjs`) is how it starts with something.
