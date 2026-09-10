/* 12d-logs.js
 * The Logs page: one readable row per limit event, newest first, applied or
 * not. Reads /api/logs and filters client-side. */

const LOGS_SOURCE_LABEL = { schedule: "Schedule", manual: "Manual", tracker: "Tracker" };

function setLogsMessage(text, kind) {
  const box = elements.logsMessage;
  if (!box) return;
  box.textContent = text || "";
  box.hidden = !text;
  box.className = "message" + (kind ? ` ${kind}` : "");
}

async function loadLogs() {
  if (!elements.logsTable) return;
  elements.logsTable.replaceChildren(makeLogsNote("Loading…"));
  let data;
  try {
    const response = await fetch("/api/logs", { cache: "no-store" });
    data = await response.json();
    if (!response.ok) throw new Error(data.error || "Could not load the log");
  } catch (error) {
    elements.logsTable.replaceChildren();
    setLogsMessage(error.message, "error");
    return;
  }
  setLogsMessage("");
  state.logs = data.log || [];
  renderLogs();
}

function makeLogsNote(text) {
  const p = document.createElement("p");
  p.className = "ramp-count";
  p.textContent = text;
  return p;
}

function renderLogs() {
  const host = elements.logsTable;
  if (!host) return;
  const filter = elements.logsFilter ? elements.logsFilter.value : "all";
  let rows = state.logs || [];
  if (filter === "failed") rows = rows.filter((r) => r.status === "failed");
  else if (filter !== "all") rows = rows.filter((r) => r.source === filter);

  host.replaceChildren();
  if (!rows.length) {
    host.append(makeLogsNote("Nothing to show for this filter."));
    return;
  }

  const num = (v) => (v == null ? "—" : Number(v).toLocaleString());
  const table = document.createElement("table");
  table.className = "logs-grid";
  const head = document.createElement("thead");
  const hr = document.createElement("tr");
  ["When", "Source", "League", "Market", "Change", "Applied to", "By", "Result"].forEach((h) => {
    const th = document.createElement("th");
    th.textContent = h;
    hr.append(th);
  });
  head.append(hr);
  table.append(head);

  const body = document.createElement("tbody");
  for (const r of rows) {
    const tr = document.createElement("tr");
    tr.classList.add(`log-${r.status}`);

    const market = r.market
      + (r.mode === "early" ? " (early)" : "")
      + (r.period ? ` · P${r.period}` : "");
    const change = r.oldValue != null && r.oldValue !== r.newValue
      ? `${num(r.oldValue)} → ${num(r.newValue)}`
      : num(r.newValue);
    const appliedTo = r.scope === "all_agents"
      ? (r.agents != null ? `All agents (${num(r.agents)} ag · ${num(r.customers)} cust)` : "All agents")
      : "Selected agent";
    const result = r.status === "failed" ? "FAILED"
      : r.status === "no_change" ? "no change" : "applied";

    const cells = [
      String(r.at || "").replace(/ ET$/, ""),
      LOGS_SOURCE_LABEL[r.source] || r.source,
      r.league,
      market,
      change,
      appliedTo,
      r.customerSupportAgent || "—",
      result,
    ];
    cells.forEach((value, i) => {
      const td = document.createElement("td");
      td.textContent = value;
      if (i === 7 && r.status === "failed" && r.note) {
        td.title = r.note;
      }
      tr.append(td);
    });
    body.append(tr);
  }
  table.append(body);
  host.append(table);
}

if (elements.logsFilter) {
  elements.logsFilter.addEventListener("change", renderLogs);
}
if (elements.logsRefresh) {
  elements.logsRefresh.addEventListener("click", () => loadLogs());
}
