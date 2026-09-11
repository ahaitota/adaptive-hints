// Distinguishing what the user actually typed from what the runtime injected.
//
// The onUserPromptSubmitted hook fires for text the runtime generates —
// autopilot reminders, system reminders, canvas/skill context — not just user
// input. Retrieving against that boilerplate is actively harmful: words like
// "task", "complete", "steps" and "error" appear in nearly every stored
// session, so term coverage comes out high while topical relevance is nil.
// Observed in practice: an autopilot reminder scored 92% coverage (11/12
// terms) and produced a confident, entirely irrelevant hint.
//
// Every such impression also pollutes the learning log with a hint the user
// was never going to accept, which drags the measured accept rate down and
// teaches the ranker the wrong thing.

const SYSTEM_PROMPT_SIGNATURES = [
    "you have not yet marked the task as complete",
    "keep working autonomously until the task is truly finished",
    "do not call task_complete if",
    "reminder: this session currently has an auto-generated",
    // Context this extension injects itself when a hint is accepted. Without
    // this the injected turn would trigger a fresh proposal, which would
    // inject again — an infinite loop.
    "[adaptive-hints:accepted]",
    "<system_reminder",
    "<system_notification",
    "<canvas-context",
    "<skill-context",
];

const BLOCK_TAGS = "system_reminder|system_notification|canvas-context|skill-context|current_datetime";

/** Remove injected context blocks, leaving whatever the user actually wrote. */
export function cleanPrompt(raw) {
    let t = String(raw ?? "");
    t = t.replace(new RegExp(`<(${BLOCK_TAGS})\\b[\\s\\S]*?<\\/\\1>`, "gi"), " ");
    t = t.replace(new RegExp(`<\\/?(${BLOCK_TAGS})\\b[^>]*>`, "gi"), " ");
    return t.replace(/\s+/g, " ").trim();
}

/** True when the text is runtime-generated rather than user-authored. */
export function isSystemGenerated(text) {
    const t = String(text ?? "").toLowerCase();
    return SYSTEM_PROMPT_SIGNATURES.some((sig) => t.includes(sig));
}

/**
 * Returns the user-authored task text, or null when the prompt should not
 * reach retrieval at all.
 */
export function extractUserTask(raw, { minChars = 25 } = {}) {
    // Strip injected blocks FIRST. Real user messages arrive with context
    // blocks appended, so checking signatures against the raw text would
    // discard genuine prompts whenever a canvas is open.
    const text = cleanPrompt(raw);
    if (!text) return null;
    // Now the signature check catches tagless runtime text (autopilot
    // reminders) and any malformed block that survived stripping.
    if (isSystemGenerated(text)) return null;
    if (text.length < minChars) return null;
    if (text.startsWith("/")) return null; // slash commands are not tasks
    return text;
}
