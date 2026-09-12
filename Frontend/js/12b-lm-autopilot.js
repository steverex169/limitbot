/* 12b-lm-autopilot.js
 * Build a Ramp. On open it loads every game that starts TODAY across all
 * leagues and lays them out grouped by league: each game's markets show
 * Pinnacle's number and the target at your share, with a one-click Apply that
 * circles that game in LM247. The autopilot master switch keeps every enabled
 * league set on its own; the board is what you read and act on by hand. */

const LM_AP_MARKETS = [
  ["moneyLine", "ML"],
  ["spread", "Spread"],
  ["total", "Total"],
  ["teamTotal", "TT"],
];
const LM_AP_MARKET_LABELS = {
  moneyLine: "Money line", spread: "Spread", total: "Total", teamTotal: "Team total",
};

function setLmApMessage(text, kind) {
  const box = elements.lmApMessage;
  if (!box) {
    return;
  }
  box.textContent = text || "";
  box.hidden = !text;
  box.className = kind || "";

  /* Auto-dismiss after 3 seconds */
  if (text) {
    clearTimeout(box._dismissTimeout);
    box._dismissTimeout = setTimeout(() => {
      box.hidden = true;
      box.textContent = "";
    }, 3000);
  }
}

/* Pinnacle's number at our share, rounded to a hundred - the exact rule the
 * server uses (per_game_ramp.scale_limit), so a target recomputed live when
 * the share changes matches what a save would store and what Apply sends. */
function rampScaleLimit(pinnacle, pct) {
  const value = Number(pinnacle) * (Number(pct) / 100);
  if (!(value > 0)) {
    return 100;
  }
  return Math.max(100, Math.round(value / 100) * 100);
}

function rampTime(startsAt) {
  if (!startsAt) {
    return "";
  }
  const when = new Date(startsAt);
  if (isNaN(when.getTime())) {
    return "";
  }
  return when
    .toLocaleTimeString("en-US", {
      timeZone: "America/New_York", hour: "numeric", minute: "2-digit",
    })
    .replace(" AM", "a")
    .replace(" PM", "p");
}

function rampNum(value) {
  return value == null ? null : Number(value).toLocaleString();
}

/* --------------------------------------------------------------------------
 * Load: the config/state/log in one call, today's games in another, together.
 * ------------------------------------------------------------------------ */
async function loadLmAutopilot() {
  if (!elements.rampBoard) {
    return;
  }
  let view;
  let today;
  try {
    const [viewResp, todayResp] = await Promise.all([
      fetch("/api/lm-autopilot", { cache: "no-store" }),
      fetch("/api/lm-autopilot/today", { cache: "no-store" }),
    ]);
    view = await viewResp.json();
    today = await todayResp.json();
    if (!viewResp.ok) {
      throw new Error(view.error || "Could not load the autopilot");
    }
    if (!todayResp.ok) {
      throw new Error(today.error || "Could not load today's games");
    }
  } catch (error) {
    setLmApMessage(error.message, "error");
    return;
  }
  state.lmAutopilot = view;
  state.rampToday = today;
  renderRampBar(view, today);
  renderRampBoard(view, today);
  renderLmApLog(view.log || []);
}

function renderRampBar(view, today) {
  if (elements.lmApMaster) {
    elements.lmApMaster.checked = !!view.masterEnabled;
  }
  if (elements.lmApMasterLabel) {
    elements.lmApMasterLabel.textContent = view.masterEnabled ? "On" : "Off";
  }
  if (elements.rampAsOf) {
    const n = today.totalToday || 0;
    elements.rampAsOf.textContent = today.ready
      ? `${n} game${n === 1 ? "" : "s"} today · as of ${today.generatedAt || ""}`
      : "LM247 is not connected on this deployment";
  }
  if (elements.lmApStatus) {
    if (!view.ready) {
      elements.lmApStatus.textContent = "the switch will not write here";
      elements.lmApStatus.classList.add("lm-ap-warn");
    } else {
      elements.lmApStatus.textContent =
        `checks Pinnacle every ${view.intervalMinutes || 5} min · store ${view.storeId}`;
      elements.lmApStatus.classList.remove("lm-ap-warn");
    }
  }
}

function renderRampBoard(view, today) {
  const host = elements.rampBoard;
  host.replaceChildren();

  if (!today.ready) {
    host.append(rampNote(
      "LM247 is not connected on this deployment, so there are no games to " +
      "set here. This page runs on the BetWar site."
    ));
    return;
  }
  const leagues = today.leagues || [];
  if (!leagues.some((l) => (l.games || []).length) &&
      !leagues.some((l) => l.error)) {
    host.append(rampNote("No games start today in any league."));
    return;
  }

  for (const league of leagues) {
    host.append(renderRampLeague(league));
  }
}

function rampNote(text) {
  const p = document.createElement("p");
  p.className = "ramp-count";
  p.textContent = text;
  return p;
}

function renderRampLeague(league) {
  const wrap = document.createElement("div");
  wrap.className = "ramp-league";
  wrap.dataset.slug = league.slug;
  wrap.dataset.storeId = league.storeId || (state.rampToday?.storeId ?? "");

  // ---- League bar: auto toggle, count, share, market picks ----
  const bar = document.createElement("div");
  bar.className = "ramp-league-bar";

  const auto = document.createElement("label");
  auto.className = "ramp-league-auto";
  auto.title = "Let the autopilot keep this league set on its own";
  const autoBox = document.createElement("input");
  autoBox.type = "checkbox";
  autoBox.className = "rl-enabled";
  autoBox.checked = !!league.enabled;
  const name = document.createElement("strong");
  name.textContent = league.leagueName;
  auto.append(autoBox, name);

  const count = document.createElement("span");
  count.className = "ramp-league-count";
  count.textContent = `${(league.games || []).length} today`;

  const scaleWrap = document.createElement("label");
  scaleWrap.className = "ramp-league-scale";
  scaleWrap.append(document.createTextNode("% "));
  const scale = document.createElement("input");
  scale.type = "number";
  scale.min = "1";
  scale.max = "200";
  scale.step = "5";
  scale.value = league.scalePercent ?? 70;
  scale.className = "rl-scale";
  scale.title = "Share of Pinnacle's number";
  scaleWrap.append(scale);

  const marketWrap = document.createElement("span");
  marketWrap.className = "ramp-league-markets";
  for (const [key, label] of LM_AP_MARKETS) {
    const m = document.createElement("label");
    const box = document.createElement("input");
    box.type = "checkbox";
    box.className = "rl-market";
    box.value = key;
    box.checked = (league.markets || []).includes(key);
    m.append(box, document.createTextNode(label));
    marketWrap.append(m);
  }

  bar.append(auto, count, scaleWrap, marketWrap);
  wrap.append(bar);

  // ---- Body: error, empty, or the games table ----
  const body = document.createElement("div");
  body.className = "ramp-league-body";
  if (league.error) {
    const warn = rampNote(`Could not load: ${league.error}`);
    warn.classList.add("lm-ap-warn");
    body.append(warn);
  } else if (!(league.games || []).length) {
    body.append(rampNote("No games start today in this league."));
  } else {
    body.append(renderRampGames(league));
  }
  wrap.append(body);

  // ---- Wiring: live target recompute, dim off-markets, debounced save ----
  const recompute = () => recomputeLeagueTargets(wrap);
  scale.addEventListener("input", recompute);
  scale.addEventListener("change", scheduleRampSave);
  autoBox.addEventListener("change", scheduleRampSave);
  for (const box of marketWrap.querySelectorAll(".rl-market")) {
    box.addEventListener("change", () => {
      dimOffMarkets(wrap);
      scheduleRampSave();
    });
  }
  dimOffMarkets(wrap);
  return wrap;
}

function renderRampGames(league) {
  const table = document.createElement("table");
  table.className = "ramp-games";

  const thead = document.createElement("thead");
  const hr = document.createElement("tr");
  ["Game", "Time", ...LM_AP_MARKETS.map(([, l]) => l), ""].forEach((h, i) => {
    const th = document.createElement("th");
    th.textContent = h;
    if (i >= 2 && i < 2 + LM_AP_MARKETS.length) {
      th.dataset.market = LM_AP_MARKETS[i - 2][0];
      th.className = "rl-col";
    }
    hr.append(th);
  });
  thead.append(hr);
  table.append(thead);

  const tbody = document.createElement("tbody");
  for (const game of league.games) {
    const byMarket = {};
    for (const limit of game.limits || []) {
      byMarket[limit.market] = limit;
    }
    const tr = document.createElement("tr");
    tr.dataset.game = game.gameNumber;
    tr.dataset.event = game.pinnacleEvent;

    const nameCell = document.createElement("td");
    nameCell.className = "rl-game-name";
    nameCell.textContent = game.pinnacleEvent;
    tr.append(nameCell);

    const timeCell = document.createElement("td");
    timeCell.className = "rl-game-time";
    timeCell.textContent = rampTime(game.startsAt);
    if (game.hoursToStart != null) {
      timeCell.title = `${Number(game.hoursToStart).toFixed(1)}h to start`;
    }
    tr.append(timeCell);

    for (const [key] of LM_AP_MARKETS) {
      const td = document.createElement("td");
      td.className = "rl-cell";
      td.dataset.market = key;
      const limit = byMarket[key];
      if (!limit) {
        td.textContent = "—";
        td.classList.add("rl-cell-empty");
      } else {
        td.dataset.pinnacle = limit.pinnacle;
        const target = document.createElement("span");
        target.className = "rl-target";
        target.textContent = rampNum(limit.target);
        const pin = document.createElement("small");
        pin.className = "rl-pin";
        pin.textContent = rampNum(limit.pinnacle) +
          (limit.line != null ? ` · ${limit.line}` : "");
        td.append(target, pin);
      }
      tr.append(td);
    }

    const applyCell = document.createElement("td");
    applyCell.className = "rl-apply-cell";
    const apply = document.createElement("button");
    apply.type = "button";
    apply.className = "button secondary rl-apply";
    apply.textContent = "Apply";
    apply.addEventListener("click", () => applyRampGame(apply, tr));
    applyCell.append(apply);
    tr.append(applyCell);

    tbody.append(tr);
  }
  table.append(tbody);
  return table;
}

/* Recompute every target cell in a league from its current share, live as the
 * number is typed - no round trip, since the rounding rule is mirrored above. */
function recomputeLeagueTargets(leagueEl) {
  const pct = Number(leagueEl.querySelector(".rl-scale")?.value) || 0;
  for (const cell of leagueEl.querySelectorAll(".rl-cell")) {
    const pinnacle = cell.dataset.pinnacle;
    const target = cell.querySelector(".rl-target");
    if (pinnacle && target) {
      target.textContent = rampNum(rampScaleLimit(pinnacle, pct));
    }
  }
}

/* Grey the market columns this league is not set to write, so what the
 * autopilot and Apply will touch is obvious at a glance. */
function dimOffMarkets(leagueEl) {
  const on = new Set(
    [...leagueEl.querySelectorAll(".rl-market")]
      .filter((b) => b.checked)
      .map((b) => b.value)
  );
  for (const el of leagueEl.querySelectorAll(".rl-cell, .rl-col")) {
    el.classList.toggle("rl-off", !on.has(el.dataset.market));
  }
}

async function applyRampGame(button, row) {
  const leagueEl = row.closest(".ramp-league");
  const slug = leagueEl.dataset.slug;
  const storeId = leagueEl.dataset.storeId;
  const pct = Number(leagueEl.querySelector(".rl-scale")?.value) || 0;
  const on = new Set(
    [...leagueEl.querySelectorAll(".rl-market")]
      .filter((b) => b.checked)
      .map((b) => b.value)
  );
  const markets = [];
  for (const cell of row.querySelectorAll(".rl-cell")) {
    const key = cell.dataset.market;
    const pinnacle = cell.dataset.pinnacle;
    if (!on.has(key) || !pinnacle) {
      continue;
    }
    markets.push({
      market: key,
      pinnacle: Number(pinnacle),
      amount: rampScaleLimit(pinnacle, pct),
    });
  }
  if (!markets.length) {
    setLmApMessage("Tick at least one market for this league first.", "error");
    return;
  }

  button.disabled = true;
  const original = button.textContent;
  button.textContent = "Setting…";
  try {
    const response = await fetch("/api/lm-autopilot/apply-game", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        slug,
        storeId: Number(storeId) || undefined,
        gameNumber: Number(row.dataset.game),
        event: row.dataset.event,
        markets,
      }),
    });
    const data = await response.json();
    if (!response.ok) {
      throw new Error(data.error || "Could not set the limits");
    }
    setLmApMessage(data.message, data.applied ? "success" : "error");
    button.textContent = data.applied ? "Set ✓" : "Partial";
    setTimeout(() => { button.textContent = original; button.disabled = false; }, 1600);
    refreshLmApLogLive().catch(() => { });
  } catch (error) {
    setLmApMessage(error.message, "error");
    button.textContent = original;
    button.disabled = false;
  }
}

/* --------------------------------------------------------------------------
 * Saving the config (auto on/off, share, markets per league). Debounced so
 * typing a share or ticking markets does not fire a save per keystroke.
 * ------------------------------------------------------------------------ */
let rampSaveTimer = null;
function scheduleRampSave() {
  if (rampSaveTimer) {
    clearTimeout(rampSaveTimer);
  }
  rampSaveTimer = setTimeout(() => { saveLmAutopilot(); }, 600);
}

function collectRampLeagues() {
  const leagues = [];
  for (const el of elements.rampBoard.querySelectorAll(".ramp-league")) {
    const slug = el.dataset.slug;
    const source = (state.rampToday?.leagues || []).find((l) => l.slug === slug);
    leagues.push({
      slug,
      leagueName: source ? source.leagueName : slug,
      enabled: el.querySelector(".rl-enabled")?.checked || false,
      scalePercent: Number(el.querySelector(".rl-scale")?.value) || 70,
      markets: [...el.querySelectorAll(".rl-market")]
        .filter((b) => b.checked)
        .map((b) => b.value),
      mode: "all",
      selectedGames: [],
    });
  }
  return leagues;
}

async function saveLmAutopilot() {
  if (!elements.rampBoard) {
    return;
  }
  const payload = {
    masterEnabled: elements.lmApMaster?.checked || false,
    leagues: collectRampLeagues(),
  };
  /* Turning the autopilot on is the one action that starts live writes across
   * a whole league, so it gets a confirm the per-league edits do not. */
  if (payload.masterEnabled && !state.lmAutopilot?.masterEnabled) {
    const on = payload.leagues.filter((l) => l.enabled && l.markets.length);
    const ok = window.confirm(
      "Turn the autopilot ON?\n\n" +
      `It will keep every game in ${on.length} league` +
      `${on.length === 1 ? "" : "s"} set to your share of Pinnacle, live, ` +
      "and re-check every few minutes. Turn it off here any time."
    );
    if (!ok) {
      if (elements.lmApMaster) {
        elements.lmApMaster.checked = false;
      }
      if (elements.lmApMasterLabel) {
        elements.lmApMasterLabel.textContent = "Off";
      }
      return;
    }
  }
  try {
    const response = await fetch("/api/lm-autopilot", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
    });
    const data = await response.json();
    if (!response.ok) {
      throw new Error(data.error || "Could not save");
    }
    // Keep the local copy in step so the next ON-confirm reads right.
    if (state.lmAutopilot) {
      state.lmAutopilot.masterEnabled = payload.masterEnabled;
    }
    setLmApMessage(data.message || "Saved", "success");
    setTimeout(() => setLmApMessage("", ""), 2000);
  } catch (error) {
    setLmApMessage(error.message, "error");
  }
}

/* --------------------------------------------------------------------------
 * The change log + a chime when a new limit lands (unchanged behaviour).
 * ------------------------------------------------------------------------ */
let lmApAudio = null;
let lmApLastSeenKey = null;

function lmApSoundEnabled() {
  return !elements.lmApSound || elements.lmApSound.checked;
}

function lmApUnlockAudio() {
  try {
    const Ctx = window.AudioContext || window.webkitAudioContext;
    if (!Ctx) {
      return;
    }
    if (!lmApAudio) {
      lmApAudio = new Ctx();
    }
    if (lmApAudio.state === "suspended") {
      lmApAudio.resume().catch(() => { });
    }
  } catch {
    /* no audio available - the log still updates */
  }
}

function lmApChime() {
  if (!lmApSoundEnabled()) {
    return;
  }
  lmApUnlockAudio();
  if (!lmApAudio || lmApAudio.state !== "running") {
    return;
  }
  const ctx = lmApAudio;
  const start = ctx.currentTime;
  [[880, 0], [1320, 0.16], [880, 0.5], [1320, 0.66]].forEach(([freq, at]) => {
    const osc = ctx.createOscillator();
    const gain = ctx.createGain();
    osc.type = "sine";
    osc.frequency.value = freq;
    gain.gain.setValueAtTime(0.0001, start + at);
    gain.gain.exponentialRampToValueAtTime(0.35, start + at + 0.02);
    gain.gain.exponentialRampToValueAtTime(0.0001, start + at + 0.15);
    osc.connect(gain).connect(ctx.destination);
    osc.start(start + at);
    osc.stop(start + at + 0.16);
  });
}

function lmApLogKey(row) {
  return row ? `${row.changedAt}|${row.event}|${row.market}|${row.newValue}` : "";
}

function renderLmApLog(log) {
  const host = elements.lmApLog;
  if (!host) {
    return;
  }
  const newestKey = lmApLogKey(log[0]);
  if (lmApLastSeenKey === null) {
    lmApLastSeenKey = newestKey;
  } else if (newestKey && newestKey !== lmApLastSeenKey) {
    lmApLastSeenKey = newestKey;
    lmApChime();
  }
  if (log.length) {
    host.replaceChildren();
  } else if (host.querySelector("table")) {
    return;
  } else if (!host.textContent.trim()) {
    host.append(rampNote("No limit changes yet."));
    return;
  }
  const table = document.createElement("table");
  table.className = "ramp-tracked-table";
  const head = document.createElement("thead");
  const hr = document.createElement("tr");
  ["When", "League", "Game", "Market", "Pinnacle", "Limit set", ""].forEach((h) => {
    const th = document.createElement("th");
    th.textContent = h;
    hr.append(th);
  });
  head.append(hr);
  table.append(head);
  const move = (from, to) => {
    const a = rampNum(from);
    const b = rampNum(to);
    if (b == null) return "—";
    return a != null && a !== b ? `${a} → ${b}` : b;
  };
  const body = document.createElement("tbody");
  for (const row of log) {
    const tr = document.createElement("tr");
    const cells = [
      String(row.changedAt || "").replace(/^\S+\s/, ""),
      row.leagueName,
      row.event,
      LM_AP_MARKET_LABELS[row.market] || row.market,
      move(row.pinnacleOld, row.pinnacle),
      `${move(row.oldValue, row.newValue)}${row.scalePercent ? ` (${row.scalePercent}%)` : ""}`,
      row.outcome === "failed" ? "failed" : (row.note === "manual" ? "manual" : ""),
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

async function refreshLmApLogLive() {
  const view = elements.buildRampView;
  if (!view || view.hidden || !elements.lmApLog) {
    return;
  }
  try {
    const response = await fetch("/api/lm-autopilot/log", { cache: "no-store" });
    if (!response.ok) {
      return;
    }
    const data = await response.json();
    renderLmApLog(data.log || []);
  } catch {
    /* transient - the next tick tries again */
  }
}
setInterval(refreshLmApLogLive, 20000);

/* The board itself refreshes every few minutes so a game coming onto the slate
 * appears, and Pinnacle's numbers stay current, without a manual reload. */
setInterval(() => {
  const view = elements.buildRampView;
  if (view && !view.hidden) {
    loadLmAutopilot().catch(() => { });
  }
}, 3 * 60 * 1000);

["click", "keydown", "touchstart"].forEach((type) =>
  document.addEventListener(type, lmApUnlockAudio, { passive: true })
);

if (elements.lmApSound) {
  try {
    const saved = localStorage.getItem("lmApSound");
    if (saved !== null) {
      elements.lmApSound.checked = saved === "1";
    }
  } catch { /* storage unavailable - default stays on */ }
  elements.lmApSound.addEventListener("change", () => {
    try {
      localStorage.setItem("lmApSound", elements.lmApSound.checked ? "1" : "0");
    } catch { /* ignore */ }
    if (elements.lmApSound.checked) {
      lmApChime();
    }
  });
}

if (elements.rampRefresh) {
  elements.rampRefresh.addEventListener("click", () => {
    elements.rampRefresh.disabled = true;
    elements.rampRefresh.textContent = "Refreshing…";
    loadLmAutopilot().finally(() => {
      elements.rampRefresh.disabled = false;
      elements.rampRefresh.textContent = "Refresh";
    });
  });
}

if (elements.lmApMaster) {
  elements.lmApMaster.addEventListener("change", () => {
    if (elements.lmApMasterLabel) {
      elements.lmApMasterLabel.textContent = elements.lmApMaster.checked ? "On" : "Off";
    }
    /* Persist the switch the moment it is flipped, so OFF takes effect at once
     * and survives a reload; saveLmAutopilot() confirms before turning it ON. */
    saveLmAutopilot();
  });
}

/* Clear Recent Limit Changes log */
document.querySelector("#lmApLogClear")?.addEventListener("click", (e) => {
  e.stopPropagation();
  if (elements.lmApLog) {
    elements.lmApLog.replaceChildren();
    const note = rampNote("Log cleared.");
    if (note) elements.lmApLog.append(note);
  }
});
