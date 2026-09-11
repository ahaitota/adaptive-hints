# Adaptive Agent Hints — Implementation Plan

Goal: agent-proposed hint cards (grey boxes with accept/reject) that are ranked
against the user's *prior behaviour*, so the probability of acceptance is high.

Reference UI: an inline card with a title, an evidence line
("Similar to prior Copilot Chat ... (80% match)"), a Reject control, and a
`1 / 2` pager.

---

## Guiding principle

The bottleneck is **not** the ranking model. It is the absence of
accept/reject data. Every phase below is ordered so that the system starts
producing that data as early as possible.

---

## Phase 0 — Define the hint primitive

Before any retrieval or ML work, pin down the contract.

**Schema**

| Field | Meaning |
| --- | --- |
| `hint_id` | Stable ID for this impression |
| `type` | e.g. `reuse_chat`, `reuse_file_scope`, `repeat_validation` |
| `title` | One short line |
| `body` | Evidence, phrased so the user can judge it without clicking |
| `evidence` | Structured: what prior session / files triggered it |
| `score` | Final ranking score |
| `action` | What accepting actually does |
| `trigger_point` | Where it was shown |

**Trigger points** (discrete, not continuous): `session_start`,
`post_plan`, `pre_commit`, `on_idle`.

**Outcome states**: `accepted`, `rejected`, `ignored` (shown, never acted on),
`preempted` (user did the thing themselves without clicking).

**v1 types**: keep to 2–3. Suggested: *reuse prior chat*,
*reuse prior file scope*, *repeat prior validation step*.

**Verify:** hand-write 10 example hints; each must map unambiguously to
type + evidence + action.

---

## Phase 1 — Instrumentation (ship this alone, first)

This is the phase people skip, and the one that decides whether the rest works.

1. Log an **impression** row for every hint *rendered*, not just accepted ones.
2. Log outcome, `time_to_decision_ms`, and what the user did instead after a reject.
3. Log **suppressed candidates** — hints generated but gated out, with their
   score. Without these you can never evaluate the gate.
4. Add a **no-hint holdout** (5–10% of eligible trigger points show nothing)
   from day one.

**Verify:** replay a week of usage and reconstruct exactly which hints were
shown, in what order, and what happened to each.

---

## Phase 2 — Candidate generation (retrieval)

Source: the local session store (`~/.copilot/session-store.db`).

- **Text similarity** — FTS5 `search_index` over prior session summaries and
  first user messages. Cheap, already indexed. Establish this as the baseline
  *before* paying for embeddings; validate that embeddings actually beat it.
- **Structural similarity** — overlap in `session_files.file_path`, same
  repository, same branch pattern. Often a stronger and far cheaper signal
  than text.
- **Recency decay** — a 3-day-old session is worth much more than a
  6-month-old one. Exponential decay with a half-life on the order of days.

**Verify:** for 20 sessions you remember, check whether the top-1 retrieved
prior session is one you'd actually consider related. Target ≥60% before
moving on.

---

## Phase 3 — Gating (the biggest acceptance lever)

Acceptance rate is driven more by *showing fewer hints* than by better ranking.

- Absolute score threshold; **at most one hint per trigger point**.
- Cooldowns: per hint-type, per session, per day.
- Hard suppressors: user is mid-typing; user already did the suggested thing;
  this hint-type was rejected twice this week.
- The `1 / 2` pager in the reference UI is a smell — a queue of hints invites
  ignoring. Prefer one hint with high confidence.

**Verify:** simulate on logged data — precision@1 with the gate vs. without.

---

## Phase 4 — Personalization

Only after Phase 1 has accumulated ~200+ labeled impressions.

1. **Start with counters, not a model.** Beta-Bernoulli acceptance rate per
   `(user, hint_type, trigger_point)` with a prior. Multiply into the retrieval
   score. This alone captures "this user never accepts type X".
2. **Then** a small logistic regression / GBDT ranker over: retrieval score,
   recency, file overlap, hint type, trigger point, the user's historical
   accept rate for that type, time since last hint, session mode.
3. **Keep ~10% exploration** (ε-greedy). Otherwise you only ever learn about
   hints you already believed in, and the model calcifies.
4. Everything stays **local and per-user** — this is personal behavioural data.

**Verify:** offline replay shows lift in accept-rate over the Phase-3
heuristic on held-out weeks.

---

## Phase 5 — Evaluation

| Metric | Why it's there |
| --- | --- |
| Accept rate | The stated goal |
| **Hints shown per session** | Guards against gaming accept-rate by hiding |
| Ignore rate | Better annoyance signal than reject |
| Reject-then-do-it-anyway | Hint was right, presentation was wrong |
| Holdout task-completion delta | Whether hints *help*, not just get clicked |

---

## Phase 6 — Rollout

Heuristic gate → counters → ranker, behind a flag, with a global off switch
and a per-type mute in settings.

---

## Risks to decide on now

1. **Accept-rate is a proxy, not the goal.** Optimizing it directly produces
   clickbait hints and a system that only suggests the safe, obvious thing.
   Pair it with the holdout metric.
2. **Selection bias / feedback loop.** You only observe outcomes for hints you
   showed. The exploration slice in Phase 4 is not optional.
3. **Cold start.** New user, new repo → no counters. Fall back to population
   priors and a *stricter* gate, not a looser one.

---

## What to cut from v1

No embeddings (FTS + file overlap first), no ML model (counters first), one
hint type, one trigger point. That reaches real accept/reject data far sooner
— and that data is the actual bottleneck.

---

## Status

Phases 0–4 are implemented as a working canvas extension:
`~/.copilot/extensions/adaptive-hints/`. See `README.md` in that folder.

**Shipped beyond the original plan**, after testing exposed the need:

- **Automatic trigger** — an `onUserPromptSubmitted` hook fires the pipeline on
  every submitted prompt (`prompt_submitted`), with a global `autoPropose` off
  switch. Hints no longer require asking for them.
- **Term coverage replaces raw BM25 as the text score.** Measured on the real
  store: a gibberish query scored BM25 4.89 while a genuinely good query scored
  1.72, because BM25 rewards rare terms. Normalizing by the result-set maximum
  additionally forced the top hit to ~1.0 regardless of absolute quality — so
  "bake sourdough bread" produced a confident hint. Coverage
  (`matchedTerms / queryTerms`, minimum 0.34) fixes both and makes the "N%
  match" figure checkable by the user.
- **`propose` no longer destroys an unanswered hint.** It now gates first and
  only supersedes the previous proposal when a new hint actually survives.
  Without this, auto-firing on every prompt would blank the panel and log
  "ignored" outcomes the user never chose — corrupting the exact signal the
  system learns from.
- **Prompt filtering (`prompt-filter.mjs`).** The hook fires for runtime-injected
  text too, not just user input. Retrieving against an autopilot reminder scored
  **92% coverage (11/12 terms)** and produced a confident, irrelevant hint —
  because "task", "complete", "steps" and "error" appear in nearly every stored
  session. Injected blocks are now stripped *before* signature matching, so
  genuine prompts survive when a canvas is open.
- **Global cooldown (10 min).** The per-type cooldown allowed one hint of each
  type on consecutive prompts; two fired back-to-back in real use. The gate now
  rate-limits across all types.

### Lesson worth keeping

All production failures so far were **input, bookkeeping and plumbing**
problems, not ranking problems: the system retrieved against the wrong text,
rate-limited along the wrong axis, counted its own bookkeeping as user
feedback, scoped panel state too broadly, and decoded HTTP bodies per chunk.
None would have been caught by tuning the model. This is the argument for
Phase 1 instrumentation and for logging suppressed candidates — the evidence
came from reading what the system actually did.

- **Supersession was being counted as user rejection.** 40 impressions produced
  39 auto-generated "ignored" rows and **zero real clicks**, yet the system had
  "learned" a 7% accept rate (n=13) for `resume_next_steps` and was suppressing
  it at ×0.57. Silence from a side panel the user may never have opened is not
  a negative signal. Supersession is now its own event kind, excluded from the
  posterior; the same log now yields n=0 and a neutral ×1.00.
  `acceptRate` is computed over decisions, and a new `engagementRate`
  (clicked ÷ shown) exposes the "nobody is looking" case that the old
  accept-rate silently mislabelled as "everybody hates it".
- **Global cooldown raised 10 → 45 min** after measuring 7.6 hints/session at
  0% engagement. At that volume the dominant failure is noise, not ranking.
- **The active proposal was global; it is now per session.** A single shared
  `current-proposal.json` meant whichever session fired last took over every
  open panel, so a chat could display another session's task and hints —
  measured at 38 of 42 impressions originating outside the session being
  viewed. State is now keyed `proposals/<sessionId>.json`. The learning log
  stays global on purpose; only the panel's UI state is session-scoped.
- **UTF-8 corruption in the canvas HTTP server.** `POST /outcome` read its body
  with `body += chunk`, which decodes each TCP chunk independently — a
  multi-byte character split across a chunk boundary becomes two U+FFFD
  replacement characters. Found via an accepted hint pointing at a prior
  session that had hit the identical bug. Fixed with `Buffer.concat(chunks)`
  decoded once, plus a 64 KB cap (the reader was previously unbounded).
  Verified by mutation test: the old reader turns `café` into `caf<27><27>`,
  the new one keeps it intact.
