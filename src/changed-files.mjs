// Files currently in play, derived from git.
//
// `reuse_file_scope` needs a list of files the user is working on, and the
// hook only provides `workingDirectory`. This module turns that into a file
// list — uncommitted changes plus untracked files, which is the closest
// available proxy for "what this session is about".
//
// Two constraints shape the design:
//
//  1. It runs on the prompt hot path, so it must NEVER block. Refreshes happen
//     in the background and callers get the previous answer immediately. The
//     first prompt in a directory sees no files; every later one does.
//  2. It must degrade silently. Not a repo, git missing, huge diff, timeout —
//     all produce an empty list, which simply means no file-scope hints.

import { execFile } from "node:child_process";
import { join } from "node:path";

const TTL_MS = 30_000;
const GIT_TIMEOUT_MS = 2000;
// A sprawling diff says nothing useful about focus, and blows up the overlap
// calculation. Past this, treat it as "no signal".
const MAX_FILES = 200;

const cache = new Map(); // cwd -> { at, files, refreshing }

function git(args, cwd) {
    return new Promise((resolve) => {
        execFile(
            "git", args,
            { cwd, timeout: GIT_TIMEOUT_MS, windowsHide: true, maxBuffer: 4 * 1024 * 1024 },
            (err, stdout) => resolve(err ? null : String(stdout)),
        );
    });
}

async function refresh(cwd) {
    const entry = cache.get(cwd) ?? { at: 0, files: [] };
    if (entry.refreshing) return;
    entry.refreshing = true;
    cache.set(cwd, entry);
    try {
        const root = (await git(["rev-parse", "--show-toplevel"], cwd))?.trim();
        if (!root) {
            cache.set(cwd, { at: Date.now(), files: [], refreshing: false });
            return;
        }
        const [changed, untracked] = await Promise.all([
            git(["diff", "--name-only", "HEAD"], cwd),
            git(["ls-files", "--others", "--exclude-standard"], cwd),
        ]);
        const rel = [...new Set(
            `${changed ?? ""}\n${untracked ?? ""}`.split("\n").map((s) => s.trim()).filter(Boolean),
        )];
        const files = rel.length > MAX_FILES ? [] : rel.map((p) => join(root, p));
        cache.set(cwd, { at: Date.now(), files, refreshing: false });
    } catch {
        cache.set(cwd, { at: Date.now(), files: [], refreshing: false });
    }
}

/**
 * Files in play for a working directory. Returns immediately, possibly with a
 * slightly stale answer, and kicks off a background refresh when needed.
 */
export function changedFiles(cwd) {
    if (!cwd) return [];
    const entry = cache.get(cwd);
    if (!entry || Date.now() - entry.at >= TTL_MS) {
        refresh(cwd).catch(() => {});
    }
    return entry?.files ?? [];
}

/** Await a fresh result. For tests and manual inspection, not the hot path. */
export async function changedFilesNow(cwd) {
    if (!cwd) return [];
    await refresh(cwd);
    return cache.get(cwd)?.files ?? [];
}
