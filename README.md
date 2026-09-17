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
│   ├── retrieval.mjs      search over the local session store│   ├── ranker.mjs         scoring, gating, exploration
│   ├── store.mjs          the learning log and settings
│   ├── renderer.mjs       the canvas panel
│   ├── prompt-filter.mjs  real prompts vs runtime-injected text
│   └── changed-files.mjs  files in play, from git
├── test/
│   ├── rules.test.mjs     deterministic tests for preference learning
│   ├── moments.test.mjs   which tool calls map to which moment
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
| **active** | 3 different sessions state it | offered on a card; applied only if you accept |
| **trusted** | 5 accepts in a row | applied automatically, without asking |
| **declined** | 3 declines in a row | not shown; returns to candidate if stated again |

Repetition and approval answer different questions. Repetition shows you
**meant** it. It cannot show that the rule was written down correctly, or that
firing it at that moment helps, because you were never asked. So confirmation
and silence are earned separately.

**Repetition earns the question, not the behaviour.** An active rule is not
applied until you accept it. Accepting applies it for the rest of that
conversation; the next one asks again, until five accepts in a row make it
trusted.

This was not the original design. Active rules used to be handed to the agent
with `follow for now`, on the reasoning that three separate statements had
already settled the matter and a click should judge something that had actually
happened. That reasoning had a hole:

> *"what if the person never accepts and it just stays there ignored, but the
> agent still follows them without user knowing?"*

Nothing expired. A card that was never clicked was applied in every session,
indefinitely, and the quieter the system got — auto-opening panel, no chat
mention, cards vanishing once answered — the less chance there was of ever
noticing. **Not clicking is not consent**, and a system that treats silence as
approval will eventually be wrong in a way nobody can see.

The cost is real: a preference you have stated three times does nothing until
you click. That is the right way round, because the failure is visible and
recoverable, where the other one is neither.

One rejection resets the streak and pulls a trusted rule back to asking. A rule
that is wrong once will be wrong again, and silence is exactly when being wrong
costs most. Accepts must be **consecutive** — six accepts around one rejection
earn nothing.

Declining it three times in a row stops it offering itself — the same mechanism
as accepting five times to earn silence, pointed the other way. An accept in
between resets the streak, so it takes three deliberate noes rather than one
mis-click.

Saying the preference again brings it back. There is no *turn off* button and
no *restore* button: both asked the user to manage storage, turning something
off left a dead card in the deck, and *turn off* read almost the same as
*decline*. A preference the user has turned away from is simply not shown.

**Coming back means returning to candidate, not to active.** `promote()` still
decides, so the three-session rule is never skipped on the way back. For a
preference with real history this is invisible — three sessions already vouched
for it, so the next promotion pass restores it immediately.

It matters for the thin case. A rule recorded by one session, then judged a
one-off and retired, used to come back as **active** the moment it was restated
— one session promoting its own rule, which is the single thing this design
promises cannot happen. Found by testing with a throwaway *"reply in Czech"*
preference.

### Undoing an observation the agent recorded

`remember_preference` only writes, and retiring keeps the evidence. So an agent
that recorded a one-off and then realised its mistake had no way to take it
back. Asked to, it agreed and then did nothing, because nothing existed to do
it with.

`preferences` now takes `forget`, with two limits:

- it removes only observations **this session** recorded, and
- only for a preference the user is **not being offered** — once three sessions
  confirm something, stopping it is the user's decision, not the agent's.

If no other session vouched for the rule, it is deleted outright. An agent can
undo its own misreading and nothing else: it can neither manufacture influence
nor erase anyone else's.

This happens **silently**. A candidate is invisible and unapplied, so there is
nothing to ask about — and *"shall I retire this rule?"* is meaningless to
anyone who has not read the code.

**The agent cannot retire a preference at all.** It once could, and used that
instead of the undo it actually needed. A preference three sessions confirmed
is the user's; the way to stop it is to decline the card three times, which the
user does deliberately and can reverse by saying the thing again. `forget` and
`retire` look similar and are opposites: one erases the agent's own guess, the
other overrides the user's settled preference.

### When a preference arrives

A preference carries the moment it belongs to, because the right moment is part
of the preference: *ask before committing* is useless after the commit.

It is said **once per moment per session**. Every edit fires `before_changes`
and `after_changes`, so repeating on each one meant the same lines arriving over
and over — and it filled the injection log, which keeps only the last ten
entries, pushing out anything worth reading. The same rule at a *different*
moment is still delivered there: a preference about committing must reach
commit time even if it was mentioned at session start.

| Moment | Fires when |
| --- | --- |
| `session_start` | the session begins |
| `before_changes` | just before a file is edited or created |
| `after_changes` | just after |
| `before_commit` | a shell command containing `git commit` or `git push` |
| `post_plan`, `every_prompt` | declared, not yet wired |

Tool calls are matched on the tool's **name and arguments**, not a fixed list of
tool names — a list would quietly stop matching the day a host renames one.

This was decoration for a while. Only `session_start` fired, so *"ask before
committing"* could be confirmed across four sessions and then ignored at every
commit. Four of five real preferences were affected. `moments.test.mjs` covers
the matching, including that the moment is *before* a commit rather than after.

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
deletable without tooling, like the hint log. Which cards have been answered in
a given conversation lives beside it in `artifacts/answered/<sessionId>.json`.
Both hold quotes from real conversations, so both are gitignored.

The agent never chooses where any of this goes. `remember_preference` takes
content only — no path — and the extension resolves
`$COPILOT_HOME/extensions/adaptive-hints/artifacts/rules.json`, falling back to
`~/.copilot`. One file for every session on purpose: confirming a preference
means counting **distinct sessions**, which is impossible if each session keeps
its own copy. Separation comes from the rows, which each carry their
`sessionId` and `repository`.

Every session runs its own copy of this extension, so that one file has many
writers. Measured with 12 concurrent processes doing load-change-save, **8 of
12 preferences were lost.** Writes therefore go through `updateRules()`, which
takes a best-effort lock, re-reads, applies the change and writes atomically.
Failing to get the lock is never a reason to discard what the user said, so
without it the behaviour is exactly what it was before; a lock left by a
crashed session is stolen after five seconds.

The atomic write needs one Windows-specific detail: `renameSync` throws `EPERM`
when another process holds the target, so it retries and then writes in place
rather than losing the change. The first version of this fix did not, and
crashed under the very concurrency it was added to survive. After: **16 of 16
concurrent writes survive.**

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
to walk through them: waiting for an answer first, then the ones already
applied silently.

Each card leads with the question and quotes your own words as evidence.
**Accept** and **Decline** are the only choices; a preference that is already
applied silently offers **Ask me again** instead.

The card used to show the instruction too — *"as a rule: Give me the commands
so I can run them myself"* under *"Would you like the commands, so you can run
them yourself?"* — which is the same sentence twice. The instruction is what
reaches the agent; the user only needs the question and the evidence behind it.

The deck holds only what is being offered or applied. Preferences still
gathering evidence have not been offered, so asking the user to react to them
would be asking about a decision the system has not made; and ones the user has
declined away are not kept as dead cards — a preference nobody wants should not
reappear at the end of the list. Both return on their own: one when a third
session confirms it, the other when the user states it again.

**A card appears only once the agent has actually been told.** The deck is
gated on the same per-session record that tracks what was said, so a visible
card means the preference is in effect *right now* — not merely stored.

This started as a visible inconsistency: the panel offered five cards the
moment a session opened, while the agent had only received one. Four of the
five were waiting on a moment that had not come round yet, and the agent
correctly mentioned just the one it had. Reported as *"why all of 5 showed in
one go? I wanted them to be shown only when it is really necessary."*

With the real preference set, one session now looks like this:

| Point in the session | Cards |
| --- | --- |
| Session opens | 1 — *explain in plain language* |
| About to commit | 2 — *ask first*, *give me the commands* |
| Just finished an edit | 1 — *open the result* |

It also answers a question the panel could not previously answer: *how do I
know when the agent gets the hint?* The card appearing **is** the notification.

### The panel opens itself, and the chat says nothing

Knowing a card exists is useless if the panel is closed. The agent used to be
told to mention it — *"the learned preferences currently in play can be
accepted or rejected in the Adaptive hints panel"* — which names a panel the
user has no way to find, and spends a line of the answer doing it.

So the panel now **opens itself**, and the agent is told to say nothing:

> Do NOT mention them, the panel or this message to the user — the panel opens
> on its own and is the only place this belongs.

**Once per session, on the first card the user can answer.** Each session runs
its own extension process, so a module-level flag is already per-conversation.

The alternatives were worse:

| When | Why not |
| --- | --- |
| Every moment that fires | Up to four opens a session, and re-opening a panel the user closed is the agent arguing with them |
| At session start | The deck is usually empty then, so it opens on nothing |
| Never — mention it in chat | Names something the user cannot find, and costs a line of every answer |

A trusted preference never opens the panel. It earned silence by being accepted
five times running, and taking the screen would undo that. It only refreshes a
panel that is already open.

Closing the panel therefore means *not now*, and is respected for the rest of
the session — the same principle as declining a card rather than a Turn off
button.

### Seeing what is in force

Cards are momentary by design: they appear at their moment and leave once
answered. That left no way to answer *"which preferences are you following
right now?"* — a gap the auto-opening panel made worse, since the chat no
longer mentions them either.

The panel therefore carries a **Being followed now** list, collapsed by
default so it is not clutter. It shows everything the agent will act on this
session regardless of moment or whether its card was dismissed, with when each
applies and which have stopped asking:

```
Being followed now — 5
  Explain in plain language                              whole session
  Do not commit or push without asking first             before a commit
  Give me the commands so I can run them myself          before a commit
  Open the result so I can see it                        after a change
  Explain the approach and wait for approval             before a change
```

The same list is available to the agent through the `preferences` action, so
asking it in chat works too. Its description names that use explicitly —
without it the agent had no reason to think a tool for merging and retiring
could answer *"what rules are you applying?"*

Because of this, an empty panel now distinguishes *"nothing applies right
now"* from *"nothing learned yet"* — otherwise a quiet panel reads as a broken
one.

An answered card leaves the deck for the rest of the conversation, and the
preference is offered again in the next one — which is where the streak is
meant to build. That is not only so the click visibly does something: without
it, reloading the panel offered the same card again and answering twice
inflated the streak.

Answering also records **what it did**, in the list of what reached the agent.
Accepting a preference sends no new text — it is already being applied — so the
click showed up nowhere at all, and looked ignored. The entry now says the
preference is being followed, or that it will be offered again next session, or
that it has been declined enough times to stop offering itself.

Merging duplicates is **not** on the card. A dropdown there asked the user to
spot near-identical wordings and think about how preferences are stored;
judging whether two sentences mean the same thing is the agent's job. It is
asked occasionally at session start instead — only once there are several
preferences, and only sometimes, because usually there is nothing to do.

The card deliberately shows **none of the system's bookkeeping**. It carried
*"0/5 accepted · 5 more to stop asking"* and a header counting preferences by
stage; those numbers mean something to whoever wrote the gate and nothing to
anyone using it. The counting still happens, quietly. The one exception is a
preference that has earned silence, which says *"Applied automatically"* —
worth knowing, because otherwise it changes behaviour invisibly.

Cards are a fixed height with the buttons pinned to the bottom, and the panel
scales with its measured width and re-renders on resize. All three exist
because of how it felt to use: paging between cards of different heights moved
the buttons under the cursor, and the panel sat stretched after a resize until
the mouse entered it — setting the size was not enough, since nothing had
invalidated the frame.

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
| `superseded` | A newer hint replaced it before you answered | ❌ **no signal** |
| `pending` | Still waiting | ❌ no signal |

### Removed: the agent as reranker

`record_relevance` let the agent log its own verdict on each hint it was
offered, at half the weight of a user click. The reasoning was that the
judgment was free and already being made, and that user clicks are the scarcest
signal in the system.

It was removed with the rest of the retrieval UI. The judgment only mattered
for ranking cards that are no longer shown, so it was collecting data nobody
could act on. The 66 rows it wrote (65 irrelevant, 1 relevant) stay in the log
as history and are skipped at read time.

That ratio is itself the most useful thing it produced: given full
conversational context, the agent rejected **98%** of what keyword retrieval
scored highly enough to surface. That is a measurement of the retrieval half,
not of the agent.

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
