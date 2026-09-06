/* 12b-lm-autopilot.js
 * The LM247 per-game autopilot panel on Build a Ramp: the master switch, the
 * per-league on/off + share + markets, the Save, and the log of limits it has
 * moved. Its own file, loaded right after the tracker builder it sits above. */

const LM_AP_MARKET_LABELS = {
  moneyLine: "Money line",
  spread: "Spread",
  total: "Total",
  teamTotal: "Team total",
};

function setLmApMessage(text, kind) {
  const box = elements.lmApMessage;
  if (!box) {
    return;
  }
  box.textContent = text || "";
  box.hidden = !text;
  box.className = "message" + (kind ? ` ${kind}` : "");
}

async function loadLmAutopilot() {
  if (!elements.lmApLeagues) {
    return;
  }
  let data;
  try {
    const response = await fetch("/api/lm-autopilot", { cache: "no-store" });
    data = await response.json();
    if (!response.ok) {
      throw new Error(data.error || "Could not load the autopilot");
    }
  } catch (error) {
    setLmApMessage(error.message, "error");
    return;
  }
  state.lmAutopilot = data;
  renderLmApStatus(data);
  renderLmApLeagues(data);
  renderLmApLog(data.log || []);
}

function renderLmApStatus(data) {
  if (elements.lmApMaster) {
    elements.lmApMaster.checked = !!data.masterEnabled;
  }
  if (elements.lmApMasterLabel) {
    elements.lmApMasterLabel.textContent = data.masterEnabled ? "On" : "Off";
  }
  if (elements.lmApStatus) {
    if (!data.ready) {
      /* The credentials/enable flag are a deploy concern, so say plainly that
         the switch does nothing until they are set rather than letting it look
         broken. */
      elements.lmApStatus.textContent =
        "LM247 is not connected on this deployment — the switch will not write.";
      elements.lmApStatus.classList.add("lm-ap-warn");
    } else {
      elements.lmApStatus.textContent =
        `Checks Pinnacle every ${data.intervalMinutes || 5} min · ` +
        `rewrites once it moves more than ${data.minChangePercent || 8}% · store ${data.storeId}`;
      elements.lmApStatus.classList.remove("lm-ap-warn");
    }
  }
}

function renderLmApLeagues(data) {
  const host = elements.lmApLeagues;
  host.replaceChildren();
  const markets = data.markets || ["moneyLine", "spread", "total", "teamTotal"];

  for (const league of data.leagues || []) {
    const row = document.createElement("div");
    row.className = "lm-ap-league";
    row.dataset.slug = league.slug;

    const enable = document.createElement("label");
    enable.className = "lm-ap-enable";
    const enableBox = document.createElement("input");
    enableBox.type = "checkbox";
    enableBox.className = "lm-ap-enabled";
    enableBox.checked = !!league.enabled;
    const name = document.createElement("strong");
    name.textContent = league.leagueName;
    enable.append(enableBox, name);
    if (league.carried === false) {
      const warn = document.createElement("small");
      warn.className = "lm-ap-warn";
      warn.textContent = " not on LM247 right now";
      enable.append(warn);
    }

    const scaleWrap = document.createElement("label");
    scaleWrap.className = "lm-ap-scale";
    scaleWrap.append(document.createTextNode("% of Pinnacle "));
    const scale = document.createElement("input");
    scale.type = "number";
    scale.min = "1";
    scale.max = "200";
    scale.step = "5";
    scale.value = league.scalePercent ?? 70;
    scale.className = "lm-ap-scale-input";
    scaleWrap.append(scale);

    const marketWrap = document.createElement("div");
    marketWrap.className = "lm-ap-markets";
    for (const market of markets) {
      const m = document.createElement("label");
      const box = document.createElement("input");
      box.type = "checkbox";
      box.className = "lm-ap-market";
      box.value = market;
      box.checked = (league.markets || []).includes(market);
      m.append(box, document.createTextNode(LM_AP_MARKET_LABELS[market] || market));
      marketWrap.append(m);
    }

    row.append(enable, scaleWrap, marketWrap);
    host.append(row);
  }
}

function renderLmApLog(log) {
  const host = elements.lmApLog;
  if (!host) {
    return;
  }
  host.replaceChildren();
  if (!log.length) {
    const empty = document.createElement("p");
    empty.className = "ramp-count";
    empty.textContent = "No limit changes yet.";
    host.append(empty);
    return;
  }
  const table = document.createElement("table");
  table.className = "ramp-tracked-table";
  const head = document.createElement("thead");
  const hr = document.createElement("tr");
  ["When", "League", "Game", "Market", "Pinnacle", "Set to", ""].forEach((h) => {
    const th = document.createElement("th");
    th.textContent = h;
    hr.append(th);
  });
  head.append(hr);
  table.append(head);
  const body = document.createElement("tbody");
  for (const row of log) {
    const tr = document.createElement("tr");
    const cells = [
      String(row.changedAt || "").replace(/^\S+\s/, ""),
      row.leagueName,
      row.event,
      LM_AP_MARKET_LABELS[row.market] || row.market,
      row.pinnacle ? Number(row.pinnacle).toLocaleString() : "—",
      `${Number(row.newValue).toLocaleString()} (${row.scalePercent}%)`,
      row.outcome === "failed" ? "failed" : "",
    ];
    for (const value of cells) {
      const td = document.createElement("td");
      td.textContent = value;
      tr.append(td);
    }
    if (row.outcome === "failed") {
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

async function saveLmAutopilot() {
  if (!elements.lmApLeagues) {
    return;
  }
  const leagues = [];
  for (const row of elements.lmApLeagues.querySelectorAll(".lm-ap-league")) {
    const source = (state.lmAutopilot?.leagues || []).find(
      (l) => l.slug === row.dataset.slug
    );
    leagues.push({
      slug: row.dataset.slug,
      leagueName: source ? source.leagueName : row.dataset.slug,
      enabled: row.querySelector(".lm-ap-enabled")?.checked || false,
      scalePercent: Number(row.querySelector(".lm-ap-scale-input")?.value) || 70,
      markets: [...row.querySelectorAll(".lm-ap-market")]
        .filter((b) => b.checked)
        .map((b) => b.value),
    });
  }
  const payload = {
    masterEnabled: elements.lmApMaster?.checked || false,
    leagues,
  };
  /* Turning the master on is the one action here that starts real writes on a
     live book, so it gets a confirm the per-league edits do not. */
  if (payload.masterEnabled && !state.lmAutopilot?.masterEnabled) {
    const on = leagues.filter((l) => l.enabled && l.markets.length);
    const ok = window.confirm(
      `Turn the LM247 autopilot ON?\n\n` +
      `It will start setting per-game limits on ${on.length} league` +
      `${on.length === 1 ? "" : "s"} from Pinnacle, live. ` +
      `Turn it off here at any time.`
    );
    if (!ok) {
      return;
    }
  }

  if (elements.lmApSave) {
    elements.lmApSave.disabled = true;
    elements.lmApSave.textContent = "Saving…";
  }
  try {
    const response = await fetch("/api/lm-autopilot", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
    });
    const data = await response.json();
    if (!response.ok) {
      throw new Error(data.error || "Could not save the autopilot");
    }
    setLmApMessage(data.message || "Saved", "success");
    await loadLmAutopilot();
  } catch (error) {
    setLmApMessage(error.message, "error");
  } finally {
    if (elements.lmApSave) {
      elements.lmApSave.disabled = false;
      elements.lmApSave.textContent = "Save autopilot";
    }
  }
}

if (elements.lmApSave) {
  elements.lmApSave.addEventListener("click", saveLmAutopilot);
}
if (elements.lmApMaster) {
  elements.lmApMaster.addEventListener("change", () => {
    if (elements.lmApMasterLabel) {
      elements.lmApMasterLabel.textContent = elements.lmApMaster.checked ? "On" : "Off";
    }
  });
}
