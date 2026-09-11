// Iframe renderer. The host draws no chrome around a canvas, so every
// affordance (accept, reject, pager, why-panel) is wired here and POSTs back
// to the extension's own loopback endpoints.

function esc(s) {
    return String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
}

export function renderHtml() {
    return `<!doctype html>
<html>
<head>
<meta charset="utf-8" />
<title>Adaptive hints</title>
<style>
  :root { color-scheme: light dark; }
  body {
    margin: 0;
    padding: 16px;
    background: var(--background-color-default, #0d1117);
    color: var(--text-color-default, #e6edf3);
    font-family: var(--font-sans, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif);
    font-size: var(--text-body-medium, 14px);
    line-height: var(--leading-body-medium, 20px);
  }
  h2 {
    font-size: var(--text-title-small, 16px);
    font-weight: var(--font-weight-semibold, 600);
    margin: 0 0 4px;
  }
  .sub { color: var(--text-color-muted, #8b949e); font-size: var(--text-body-small, 12px); margin-bottom: 16px; }
  .row { display: flex; gap: 10px; align-items: flex-start; margin-bottom: 12px; }
  .bulb {
    flex: 0 0 auto; width: 20px; text-align: center;
    color: var(--true-color-yellow, #d29922); padding-top: 14px; font-size: 15px;
  }
  .card {
    flex: 1 1 auto;
    border: 1px solid var(--border-color-default, #30363d);
    border-radius: 8px;
    padding: 12px 14px;
    background: var(--background-color-inset, rgba(255,255,255,0.02));
  }
  .card-head { display: flex; align-items: center; gap: 8px; }
  .title { font-weight: var(--font-weight-semibold, 600); flex: 1 1 auto; }
  .pager { display: flex; align-items: center; gap: 4px; font-size: var(--text-body-small, 12px); color: var(--text-color-muted, #8b949e); }
  .body { color: var(--text-color-muted, #8b949e); margin: 6px 0 12px; }
  .verdict {
    font-size: 11px; margin: -6px 0 12px; padding: 5px 8px; border-radius: 6px;
    border: 1px solid var(--border-color-default, #30363d);
    color: var(--text-color-muted, #8b949e);
  }
  .verdict.yes { border-color: var(--true-color-green, #3fb950); }
  .verdict.no { border-color: var(--true-color-red-muted, rgba(248,81,73,0.4)); }
  .actions { display: flex; align-items: center; gap: 8px; }
  .spacer { flex: 1 1 auto; }
  button {
    font-family: inherit; font-size: var(--text-body-small, 12px);
    border-radius: 6px; padding: 5px 12px; cursor: pointer;
    border: 1px solid var(--border-color-default, #30363d);
    background: transparent; color: var(--text-color-default, #e6edf3);
  }
  button:hover { border-color: var(--text-color-muted, #8b949e); }
  button.primary {
    border-color: var(--true-color-blue, #1f6feb);
    background: var(--true-color-blue-muted, rgba(31,111,235,0.15));
  }
  button:disabled { opacity: .45; cursor: default; }
  .why { margin-top: 10px; border-top: 1px solid var(--border-color-default, #30363d); padding-top: 8px; display: none; }
  .why.open { display: block; }
  .why table { width: 100%; border-collapse: collapse; font-size: var(--text-body-small, 12px); }
  .why td { padding: 2px 0; color: var(--text-color-muted, #8b949e); }
  .why td.v { text-align: right; color: var(--text-color-default, #e6edf3); font-family: var(--font-mono, monospace); }
  .why tr.group td { padding-top: 8px; font-size: 10px; text-transform: uppercase; letter-spacing: .04em; opacity: .65; }
  .why tr.sub td:first-child { padding-left: 12px; }
  .why tr.calc td { border-top: 1px solid var(--border-color-default, #30363d); padding-top: 4px; }
  .why tr.calc td, .why tr.calc td.v { color: var(--text-color-default, #e6edf3); font-weight: var(--font-weight-semibold, 600); }
  .why .formula { font-family: var(--font-mono, monospace); font-size: 10px; opacity: .6; }
  .empty {
    border: 1px dashed var(--border-color-default, #30363d);
    border-radius: 8px; padding: 16px; color: var(--text-color-muted, #8b949e);
  }
  .stats { margin-top: 20px; border-top: 1px solid var(--border-color-default, #30363d); padding-top: 12px; }
  .sent { margin-top: 20px; border-top: 1px solid var(--border-color-default, #30363d); padding-top: 12px; }
  .sent > details > summary {
    cursor: pointer; color: var(--text-color-muted, #8b949e);
    font-size: var(--text-body-small, 12px); list-style: none; user-select: none;
  }
  .sent > details > summary::-webkit-details-marker { display: none; }
  .sent > details > summary::before { content: "\\25B8"; display: inline-block; margin-right: 6px; transition: transform .12s; }
  .sent > details[open] > summary::before { transform: rotate(90deg); }
  .inj { border: 1px solid var(--border-color-default, #30363d); border-radius: 6px; margin-top: 8px; }
  .inj > summary {
    cursor: pointer; padding: 6px 10px; list-style: none; user-select: none;
    font-size: var(--text-body-small, 12px); color: var(--text-color-default, #e6edf3);
    display: flex; gap: 8px; align-items: baseline;
  }
  .inj > summary::-webkit-details-marker { display: none; }
  .inj > summary::before { content: "\\25B8"; color: var(--text-color-muted, #8b949e); transition: transform .12s; }
  .inj[open] > summary::before { transform: rotate(90deg); }
  .inj .when { color: var(--text-color-muted, #8b949e); }
  .inj .size { margin-left: auto; color: var(--text-color-muted, #8b949e); font-family: var(--font-mono, monospace); }
  .inj pre {
    margin: 0; padding: 10px; border-top: 1px solid var(--border-color-default, #30363d);
    white-space: pre-wrap; word-break: break-word;
    font-family: var(--font-mono, monospace); font-size: 11px; line-height: 1.45;
    color: var(--text-color-muted, #8b949e); max-height: 340px; overflow: auto;
  }
  .kind {
    display: inline-block; font-size: 10px; padding: 0 6px; border-radius: 10px;
    border: 1px solid var(--border-color-default, #30363d);
  }
  .stats table { width: 100%; border-collapse: collapse; font-size: var(--text-body-small, 12px); }
  .stats td { padding: 3px 0; color: var(--text-color-muted, #8b949e); }
  .stats td.v { text-align: right; font-family: var(--font-mono, monospace); color: var(--text-color-default, #e6edf3); }
  .badge {
    display: inline-block; font-size: 10px; padding: 1px 6px; border-radius: 10px;
    border: 1px solid var(--border-color-default, #30363d); color: var(--text-color-muted, #8b949e);
    margin-left: 6px; vertical-align: middle;
  }
  .done { color: var(--text-color-muted, #8b949e); font-size: var(--text-body-small, 12px); padding: 4px 0; }
  .testbadge {
    display: inline-block; font-size: 10px; padding: 1px 6px; border-radius: 10px;
    border: 1px solid var(--true-color-yellow, #d29922); color: var(--true-color-yellow, #d29922);
    margin-left: 6px; white-space: nowrap;
  }
</style>
</head>
<body>
<h2>Adaptive hints</h2>
<div class="sub" id="ctx">Loading…</div>
<div id="hints"></div>
<div class="sent">
  <details>
    <summary id="sentsum">Accepted context sent to the agent</summary>
    <div id="sentlist"></div>
  </details>
</div>
<div class="stats">
  <div class="sub" style="margin-bottom:6px">Learning signal</div>
  <table id="stats"></table>
</div>

<script>
const $ = (id) => document.getElementById(id);
let state = { hints: [], stats: {}, task: "", trigger: "", holdout: false, suppressed: [] };
let lastSig = null;
let page = 0;

function pct(v) { return v == null ? "–" : Math.round(v * 100) + "%"; }
function num(v) { return v == null ? "–" : (Math.round(v * 100) / 100); }
function esc(s) {
  return String(s ?? "").replace(/[&<>"']/g, c => ({ "&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;","'":"&#39;" }[c]));
}
function ago(ts) {
  const m = Math.round((Date.now() - ts) / 60000);
  if (m < 1) return "just now";
  if (m < 60) return m + " min ago";
  const h = Math.round(m / 60);
  return h < 24 ? h + " h ago" : Math.round(h / 24) + " d ago";
}

function renderSent() {
  const list = state.injections || [];
  $("sentsum").textContent = list.length
    ? \`Accepted context sent to the agent — \${list.length} message\${list.length === 1 ? "" : "s"}\`
    : "Accepted context sent to the agent — nothing yet";
  $("sentlist").innerHTML = list.map(i => \`
    <details class="inj" data-at="\${i.at}">
      <summary>
        <span class="kind">\${esc(i.kind)}</span>
        <span class="when">\${ago(i.at)}</span>
        <span class="size">\${i.text.length} chars</span>
      </summary>
      <pre>\${esc(i.text)}</pre>
    </details>\`).join("");
}

function render() {
  // The 4s poll re-renders, which would slam every <details> shut and lose
  // scroll position mid-read. Capture what the user has open, and skip the
  // rebuild entirely when nothing has actually changed.
  const openInj = new Set([...document.querySelectorAll(".inj[open]")].map(d => d.dataset.at));
  const sentEl = document.querySelector(".sent > details");
  const sentOpen = sentEl ? sentEl.open : false;
  const whyEl = document.getElementById("why");
  const whyOpen = whyEl ? whyEl.classList.contains("open") : false;
  const prevScroll = {};
  document.querySelectorAll(".inj[open] pre").forEach(p => {
    prevScroll[p.closest(".inj").dataset.at] = p.scrollTop;
  });

  renderInner();

  const sentEl2 = document.querySelector(".sent > details");
  if (sentEl2) sentEl2.open = sentOpen;
  document.querySelectorAll(".inj").forEach(d => {
    if (openInj.has(d.dataset.at)) {
      d.open = true;
      const pre = d.querySelector("pre");
      if (pre && prevScroll[d.dataset.at] != null) pre.scrollTop = prevScroll[d.dataset.at];
    }
  });
  const whyEl2 = document.getElementById("why");
  if (whyEl2 && whyOpen) whyEl2.classList.add("open");
}

function renderInner() {
  const undecided = state.hints.filter(h => !h.outcome);
  $("ctx").innerHTML = (state.task
    ? \`Task: "\${state.task}"  ·  trigger: \${state.trigger}\`
    : "No proposal yet. Ask the agent to propose hints.")
    + (state.testMode ? ' <span class="testbadge">TEST MODE — cooldowns &amp; holdout off</span>' : "")
    + (state.fixtureStore ? \` <span class="testbadge">FIXTURE DB — \${esc(state.fixtureStore.split(/[\\\\/]/).pop())}</span>\` : "");

  const box = $("hints");
  box.innerHTML = "";

  if (state.holdout) {
    box.innerHTML = '<div class="empty">Holdout arm — hints deliberately suppressed at this trigger point so accept-rate can be compared against showing nothing.</div>';
  } else if (!state.hints.length) {
    const why = state.suppressed.length
      ? \`\${state.suppressed.length} candidate(s) generated, all gated out (\${[...new Set(state.suppressed.map(s => s.reason))].join(", ")}).\`
      : "No candidates matched.";
    box.innerHTML = '<div class="empty">' + why + '</div>';
  } else if (!undecided.length) {
    box.innerHTML = '<div class="done">All hints in this proposal have been answered. Ask the agent to propose again.</div>';
  } else {
    if (page >= undecided.length) page = 0;
    const h = undecided[page];
    // Reconstruct the intermediates the score was built from, so the panel can
    // show the chain rather than a flat list of unrelated-looking numbers.
    const ev = h.evidence || {};
    const hasFiles = ev.fileOverlap != null && ev.fileOverlap > 0;
    const bm25 = (ev.textScore != null && ev.coverage != null)
      ? (ev.textScore - 0.75 * ev.coverage) / 0.25
      : null;
    const recFactor = ev.recency != null ? 0.55 + 0.45 * ev.recency : null;
    const el = document.createElement("div");
    el.className = "row";
    el.innerHTML = \`
      <div class="bulb">&#128161;</div>
      <div class="card">
        <div class="card-head">
          <div class="title">\${h.title}\${h.explore ? '<span class="badge">exploration</span>' : ''}</div>
          <div class="pager">
            <button \${undecided.length < 2 ? "disabled" : ""} data-nav="-1">&lt;</button>
            <span>\${page + 1} / \${undecided.length}</span>
            <button \${undecided.length < 2 ? "disabled" : ""} data-nav="1">&gt;</button>
          </div>
        </div>
        <div class="body">\${h.body}</div>
        \${h.agentJudgment ? \`<div class="verdict \${h.agentJudgment.verdict === "agent_relevant" ? "yes" : "no"}">
          Agent: \${h.agentJudgment.verdict === "agent_relevant" ? "relevant" : "not relevant"}\${h.agentJudgment.reason ? " — " + esc(h.agentJudgment.reason) : ""}
        </div>\` : ""}
        <div class="actions">
          <button data-why="1">Why this?</button>
          <div class="spacer"></div>
          <button class="primary" data-out="accepted">Accept</button>
          <button data-out="rejected">Reject</button>
        </div>
        <div class="why" id="why">
          <table>
            <tr class="group"><td colspan="2">ingredients &rarr; retrieval score</td></tr>
            <tr class="sub"><td>term coverage <span class="formula">×0.75</span></td><td class="v">\${pct(ev.coverage)}</td></tr>
            <tr class="sub"><td>bm25 tie-break <span class="formula">×0.25</span></td><td class="v">\${bm25 == null ? "–" : num(bm25)}</td></tr>
            <tr class="sub"><td>= text match</td><td class="v">\${num(ev.textScore)}</td></tr>
            <tr class="sub"><td>file overlap \${hasFiles ? '<span class="formula">0.65/0.35 split</span>' : '<span class="formula">unused, no files</span>'}</td><td class="v">\${hasFiles ? pct(ev.fileOverlap) : "–"}</td></tr>
            <tr class="sub"><td>recency <span class="formula">→ ×(0.55+0.45r)</span></td><td class="v">\${pct(ev.recency)} → ×\${recFactor == null ? "?" : num(recFactor)}</td></tr>
            <tr class="calc"><td>retrieval score</td><td class="v">\${num(h.retrievalScore)}</td></tr>
            <tr class="group"><td colspan="2">learning &rarr; multiplier</td></tr>
            <tr class="sub"><td>learned accept rate</td><td class="v">\${pct(h.acceptanceRate)} (n=\${h.observations})</td></tr>
            <tr class="sub"><td>= 0.5 + rate</td><td class="v">×\${num(h.personalMultiplier)}</td></tr>
            <tr class="calc"><td>final score <span class="formula">\${num(h.retrievalScore)} × \${num(h.personalMultiplier)}</span></td><td class="v">\${num(h.finalScore)}</td></tr>
          </table>
        </div>
      </div>\`;
    box.appendChild(el);

    el.querySelectorAll("[data-nav]").forEach(b => b.onclick = () => {
      page = (page + Number(b.dataset.nav) + undecided.length) % undecided.length;
      render();
    });
    el.querySelector("[data-why]").onclick = () => $("why").classList.toggle("open");
    el.querySelectorAll("[data-out]").forEach(b => b.onclick = async () => {
      el.querySelectorAll("button").forEach(x => x.disabled = true);
      await fetch("/outcome", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ hintId: h.hintId, outcome: b.dataset.out })
      });
      await load();
    });
  }

  const s = state.stats || {};
  const noSignal = !s.decided;
  renderSent();
  $("stats").innerHTML = \`
    <tr><td>accept rate\${noSignal ? " <i>(no clicks yet)</i>" : ""}</td><td class="v">\${pct(s.acceptRate)}</td></tr>
    <tr><td>ignore rate</td><td class="v">\${pct(s.ignoreRate)}</td></tr>
    <tr><td>engagement (clicked / shown)</td><td class="v">\${pct(s.engagementRate)}</td></tr>
    <tr><td>impressions</td><td class="v">\${s.impressions ?? 0}</td></tr>
    <tr><td>accepted / rejected / ignored</td><td class="v">\${s.accepted ?? 0} / \${s.rejected ?? 0} / \${s.ignored ?? 0}</td></tr>
    <tr><td>agent judged relevant / not</td><td class="v">\${s.agentRelevant ?? 0} / \${s.agentIrrelevant ?? 0}</td></tr>
    <tr><td>agent precision</td><td class="v">\${pct(s.agentPrecision)}</td></tr>
    <tr><td>unanswered (no signal)</td><td class="v">\${s.unanswered ?? 0}</td></tr>
    <tr><td>hints per session</td><td class="v">\${num(s.hintsPerSession)}</td></tr>
    <tr><td>suppressed candidates</td><td class="v">\${s.suppressedCount ?? 0}</td></tr>
    <tr><td>gate pass rate</td><td class="v">\${pct(s.gateSelectivity)}</td></tr>
    <tr><td>holdout triggers</td><td class="v">\${s.holdoutTriggers ?? 0}</td></tr>\`;
}

async function load() {
  try {
    const r = await fetch("/state");
    const next = await r.json();
    // Skip the whole re-render when nothing changed — the common case for a
    // poll, and the cheapest way to stop the UI fighting the user.
    const sig = JSON.stringify(next);
    if (sig === lastSig) return;
    lastSig = sig;
    state = next;
    render();
  } catch {
    // Server gone (extension reloaded). The poll below will recover.
  }
}

// SSE gives instant updates, but the connection dies whenever the extension
// reloads — which silently leaves the panel showing stale data. Reconnect on
// error, and poll as a safety net so the panel always converges.
let es = null;
function connect() {
  try { if (es) es.close(); } catch {}
  es = new EventSource("/events");
  es.onmessage = load;
  es.onerror = () => { try { es.close(); } catch {} ; setTimeout(connect, 3000); };
}
connect();
setInterval(load, 4000);
load();
</script>
</body>
</html>`;
}

export { esc };
