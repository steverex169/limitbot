/* 12c-bet-alerts.js
 * The Bet Alerts page: the watched-agent list (each with the cents to move
 * and an optional minimum risk), the Save, and the log of alerts raised. */

function setBaMessage(text, kind) {
  const box = elements.baMessage;
  if (!box) {
    return;
  }
  box.textContent = text || "";
  box.hidden = !text;
  box.className = "message" + (kind ? ` ${kind}` : "");
}

async function loadBetAlerts() {
  if (!elements.baRules) {
    return;
  }
  let data;
  try {
    const response = await fetch("/api/bet-alerts", { cache: "no-store" });
    data = await response.json();
    if (!response.ok) {
      throw new Error(data.error || "Could not load bet alerts");
    }
  } catch (error) {
    setBaMessage(error.message, "error");
    return;
  }
  state.betAlerts = data;
  renderBaStatus(data);
  renderBaAgentPick(data);
  renderBaRules(data.rules || []);
  renderBaLog(data.log || []);
}

function renderBaStatus(data) {
  if (!elements.baStatus) {
    return;
  }
  elements.baStatus.textContent = data.enabled
    ? `Checks the open book every ${data.intervalSeconds || 30}s · alerts go to this site's Telegram recipients`
    : "Bet alerts are switched off on this deployment (BET_ALERTS=off).";
}

function renderBaAgentPick(data) {
  const pick = elements.baAgentPick;
  if (!pick) {
    return;
  }
  const watched = new Set((data.rules || []).map((r) => Number(r.agentId)));
  pick.replaceChildren();
  const first = document.createElement("option");
  first.value = "";
  first.textContent = "Add an agent…";
  pick.append(first);
  for (const agent of data.agents || []) {
    if (watched.has(Number(agent.id))) {
      continue;
    }
    const opt = document.createElement("option");
    opt.value = String(agent.id);
    opt.textContent = agent.name;
    pick.append(opt);
  }
}

function baRuleRow(rule) {
  const row = document.createElement("div");
  row.className = "ba-rule";
  row.dataset.agentId = rule.agentId;
  row.dataset.agentName = rule.agentName;

  const enable = document.createElement("label");
  enable.className = "ba-enable";
  const box = document.createElement("input");
  box.type = "checkbox";
  box.className = "ba-enabled";
  box.checked = rule.enabled !== false;
  const name = document.createElement("strong");
  name.textContent = rule.agentName;
  enable.append(box, name);

  const cents = document.createElement("label");
  cents.className = "ba-field";
  cents.append(document.createTextNode("move "));
  const centsIn = document.createElement("input");
  centsIn.type = "number";
  centsIn.min = "1";
  centsIn.max = "100";
  centsIn.step = "5";
  centsIn.value = rule.cents ?? 10;
  centsIn.className = "ba-cents";
  cents.append(centsIn, document.createTextNode("¢"));

  const min = document.createElement("label");
  min.className = "ba-field";
  min.append(document.createTextNode("min risk $"));
  const minIn = document.createElement("input");
  minIn.type = "number";
  minIn.min = "0";
  minIn.step = "50";
  minIn.value = rule.minRisk ?? 0;
  minIn.className = "ba-min";
  min.append(minIn);

  const note = document.createElement("small");
  note.className = "ba-note";
  note.textContent = rule.lastNote
    ? `${String(rule.lastRunAt || "").replace(/^\S+\s/, "")} — ${rule.lastNote}`
    : "not checked yet";

  const remove = document.createElement("button");
  remove.type = "button";
  remove.className = "link-button";
  remove.textContent = "Remove";
  remove.addEventListener("click", () => {
    row.remove();
    renderBaAgentPick({
      ...state.betAlerts,
      rules: [...elements.baRules.querySelectorAll(".ba-rule")].map((r) => ({
        agentId: r.dataset.agentId,
      })),
    });
  });

  row.append(enable, cents, min, note, remove);
  return row;
}

function renderBaRules(rules) {
  const host = elements.baRules;
  host.replaceChildren();
  if (!rules.length) {
    const empty = document.createElement("p");
    empty.className = "ramp-count";
    empty.textContent = "No agents watched yet. Add one above.";
    host.append(empty);
    return;
  }
  for (const rule of rules) {
    host.append(baRuleRow(rule));
  }
}

function addBaAgent() {
  const pick = elements.baAgentPick;
  if (!pick || !pick.value) {
    return;
  }
  const agent = (state.betAlerts?.agents || []).find(
    (a) => String(a.id) === pick.value
  );
  if (!agent) {
    return;
  }
  const host = elements.baRules;
  const empty = host.querySelector(".ramp-count");
  if (empty) {
    empty.remove();
  }
  host.append(baRuleRow({ agentId: agent.id, agentName: agent.name, cents: 10, minRisk: 0, enabled: true }));
  pick.value = "";
  renderBaAgentPick({
    ...state.betAlerts,
    rules: [...host.querySelectorAll(".ba-rule")].map((r) => ({ agentId: r.dataset.agentId })),
  });
}

async function saveBetAlerts() {
  const rules = [...(elements.baRules?.querySelectorAll(".ba-rule") || [])].map((r) => ({
    agentId: Number(r.dataset.agentId),
    agentName: r.dataset.agentName,
    cents: Number(r.querySelector(".ba-cents")?.value) || 10,
    minRisk: Number(r.querySelector(".ba-min")?.value) || 0,
    enabled: r.querySelector(".ba-enabled")?.checked !== false,
  }));
  if (elements.baSave) {
    elements.baSave.disabled = true;
    elements.baSave.textContent = "Saving…";
  }
  try {
    const response = await fetch("/api/bet-alerts", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ rules }),
    });
    const data = await response.json();
    if (!response.ok) {
      throw new Error(data.error || "Could not save");
    }
    setBaMessage(data.message || "Saved", "success");
    await loadBetAlerts();
  } catch (error) {
    setBaMessage(error.message, "error");
  } finally {
    if (elements.baSave) {
      elements.baSave.disabled = false;
      elements.baSave.textContent = "Save watch list";
    }
  }
}

function renderBaLog(log) {
  const host = elements.baLog;
  if (!host) {
    return;
  }
  host.replaceChildren();
  if (!log.length) {
    const empty = document.createElement("p");
    empty.className = "ramp-count";
    empty.textContent = "No alerts yet. The first pass records the open book silently; only bets placed after that are announced.";
    host.append(empty);
    return;
  }
  const money = (v) => (v == null ? "—" : `$${Number(v).toLocaleString()}`);
  const table = document.createElement("table");
  table.className = "ramp-tracked-table";
  const head = document.createElement("thead");
  const hr = document.createElement("tr");
  ["When", "Agent", "Player", "Bet", "Game", "Risk / Win", "Move", ""].forEach((h) => {
    const th = document.createElement("th");
    th.textContent = h;
    hr.append(th);
  });
  head.append(hr);
  table.append(head);
  const body = document.createElement("tbody");
  for (const row of log) {
    const tr = document.createElement("tr");
    [
      String(row.at || "").replace(/^\S+\s/, ""),
      row.agentName,
      row.player,
      `${row.description}${row.market ? ` · ${row.market}` : ""}${row.wagerType && row.wagerType !== "Straight" ? ` · ${row.wagerType}` : ""}`,
      `${row.league ? row.league + ": " : ""}${row.matchup || ""}${row.gameTime ? ` (${row.gameTime})` : ""}`,
      `${money(row.risk)} / ${money(row.toWin)}`,
      `${row.cents}¢`,
      row.notified ? "sent" : "not sent",
    ].forEach((value) => {
      const td = document.createElement("td");
      td.textContent = value;
      tr.append(td);
    });
    if (!row.notified) {
      tr.classList.add("lm-ap-failed");
      if (row.note) {
        tr.title = row.note;
      }
    }
    body.append(tr);
  }
  table.append(body);
  host.append(table);
}

/* Live log while the page is open; cheap endpoint, no upstream calls. */
async function refreshBaLogLive() {
  const view = elements.betAlertsView;
  if (!view || view.hidden || !elements.baLog) {
    return;
  }
  try {
    const response = await fetch("/api/bet-alerts/log", { cache: "no-store" });
    if (response.ok) {
      renderBaLog((await response.json()).log || []);
    }
  } catch {
    /* next tick */
  }
}
setInterval(refreshBaLogLive, 20000);

if (elements.baAdd) {
  elements.baAdd.addEventListener("click", addBaAgent);
}
if (elements.baSave) {
  elements.baSave.addEventListener("click", saveBetAlerts);
}
