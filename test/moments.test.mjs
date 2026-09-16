// Does a tool call map to the moment a preference asked for?
//
// The `when` field was stored and then ignored: only session_start ever fired,
// so "ask before committing" could be confirmed across four sessions and still
// never reach the agent at the point a commit was about to happen. This covers
// the matching that decides whether a preference arrives at all.
//
// The function is small and lives in extension.mjs, which cannot be imported
// without starting a session — so it is duplicated here deliberately, and this
// test fails loudly if the two drift apart.
//
//   node moments.test.mjs

import { readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

let pass = 0, fail = 0;
function check(name, condition, detail = "") {
    if (condition) { pass++; console.log(`  PASS  ${name}`); }
    else { fail++; console.log(`  FAIL  ${name}${detail ? ` — ${detail}` : ""}`); }
}

// Kept identical to extension.mjs.
function momentForTool(toolName, toolArgs, phase) {
    const name = String(toolName || "").toLowerCase();
    let args = "";
    try {
        args = typeof toolArgs === "string" ? toolArgs : JSON.stringify(toolArgs ?? "");
    } catch {
        args = "";
    }
    const shell = /bash|shell|powershell|terminal|run_command|execute/.test(name);
    const edits = /edit|create|write|apply_patch|str_replace|insert/.test(name);

    if (shell && /\bgit\s+(commit|push)\b/.test(args)) {
        return phase === "pre" ? "before_commit" : null;
    }
    if (edits) return phase === "pre" ? "before_changes" : "after_changes";
    return null;
}

console.log(`\nWhich moment does a tool call belong to?`);
console.log("=".repeat(58));

// --- Committing ------------------------------------------------------------
check("a shell call that commits is 'before_commit'",
    momentForTool("bash", { command: "git commit -m 'x'" }, "pre") === "before_commit");
check("pushing counts too",
    momentForTool("powershell", { command: "git push origin main" }, "pre") === "before_commit");
check("the moment is BEFORE the commit, not after",
    momentForTool("bash", { command: "git commit -m 'x'" }, "post") === null,
    "asking to check with the user after committing is useless");
check("other git commands are not a commit",
    momentForTool("bash", { command: "git status" }, "pre") === null);
check("a commit mentioned in prose is not a commit", (() => {
    // "how do I commit this?" is a question, not a commit.
    return momentForTool("bash", { command: "echo how do I commit this" }, "pre") === null;
})());

// --- Changing code ---------------------------------------------------------
check("an edit is 'before_changes' beforehand",
    momentForTool("edit", { path: "a.js" }, "pre") === "before_changes");
check("...and 'after_changes' once it has run",
    momentForTool("edit", { path: "a.js" }, "post") === "after_changes");
check("creating a file counts as changing code",
    momentForTool("create", { path: "a.js" }, "pre") === "before_changes");
check("so does applying a patch",
    momentForTool("apply_patch", {}, "post") === "after_changes");

// --- Everything else stays silent ------------------------------------------
check("reading a file is not a moment", momentForTool("view", { path: "a.js" }, "pre") === null);
check("searching is not a moment", momentForTool("grep", { pattern: "x" }, "pre") === null);
check("an unknown tool is not a moment", momentForTool("something_new", {}, "pre") === null);
check("a missing tool name does not throw", momentForTool(undefined, undefined, "pre") === null);
check("arguments that cannot be serialised do not throw", (() => {
    const circular = {};
    circular.self = circular;
    return momentForTool("bash", circular, "pre") === null;
})());

// --- The copy above must match the real one --------------------------------
{
    const here = dirname(fileURLToPath(import.meta.url));
    const source = readFileSync(join(here, "..", "extension.mjs"), "utf8");
    const shellRe = source.includes("/bash|shell|powershell|terminal|run_command|execute/");
    const editRe = source.includes("/edit|create|write|apply_patch|str_replace|insert/");
    const gitRe = source.includes("/\\bgit\\s+(commit|push)\\b/");
    check("this test's copy still matches extension.mjs", shellRe && editRe && gitRe,
        "the patterns were changed in one place only");
}

console.log("=".repeat(58));
console.log(`${pass} passed, ${fail} failed\n`);
process.exit(fail ? 1 : 0);
