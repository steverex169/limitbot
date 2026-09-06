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

function renderLmApGameLeagueOptions(data) {
  const select = elements.lmApGameLeague;
  if (!select) {
    return;
  }
  const current = select.value;
  select.replaceChildren();
  const first = document.createElement("option");
  first.value = "";
  first.textContent = "Choose a league…";
  select.append(first);
  for (const league of data.leagues || []) {
    const opt = document.createElement("option");
    opt.value = league.slug;
    opt.textContent = league.leagueName;
    select.append(opt);
  }
  select.value = current;
}

async function loadLmApGames(slug) {
  const pick = elements.lmApGamePick;
  const host = elements.lmApGames;
  if (!pick || !host) {
    return;
  }
  host.replaceChildren();
  pick.disabled = true;
  pick.replaceChildren(makeOption("", "Choose a game…"));
  state.lmApGamesBySlug = null;
  if (!slug) {
    return;
  }
  pick.replaceChildren(makeOption("", "Loading games…"));

  let data;
  try {
    const response = await fetch(
      `/api/lm-autopilot/games?${new URLSearchParams({ slug })}`,
      { cache: "no-store" }
    );
    data = await response.json();
    if (!response.ok) {
      throw new Error(data.error || "Could not load games");
    }
  } catch (error) {
    pick.replaceChildren(makeOption("", "Choose a game…"));
    host.replaceChildren(makeRampCount(error.message));
    return;
  }

  if (data.ready === false) {
    /* The games can only be matched once LM247 is connected. Say that plainly
       rather than letting an empty list read as "no games today". */
    pick.replaceChildren(makeOption("", "Choose a game…"));
    host.replaceChildren(
      makeRampCount("LM247 is not connected yet — once its login is added on the server, games appear here (the master switch can stay off while you pick them).")
    );
    return;
  }

  const games = data.games || [];
  state.lmApGamesData = data;
  pick.replaceChildren(makeOption("", `Choose a game… (${games.length})`));
  games.forEach((game, index) => {
    pick.append(makeOption(String(index), game.pinnacleEvent));
  });
  pick.disabled = games.length === 0;
  if (!games.length) {
    host.replaceChildren(makeRampCount("No matched games in the window right now."));
  }
}

function makeOption(value, text) {
  const opt = document.createElement("option");
  opt.value = value;
  opt.textContent = text;
  return opt;
}

function makeRampCount(text) {
  const p = document.createElement("p");
  p.className = "ramp-count";
  p.textContent = text;
  return p;
}

function renderLmApOneGame(index) {
  const host = elements.lmApGames;
  const data = state.lmApGamesData;
  host.replaceChildren();
  if (!data || index === "" || index == null) {
    return;
  }
  const game = (data.games || [])[Number(index)];
  if (!game) {
    return;
  }
  const card = document.createElement("div");
  card.className = "lm-ap-game";

  const head = document.createElement("div");
  head.className = "lm-ap-game-head";
  const title = document.createElement("strong");
  title.textContent = game.pinnacleEvent;
  head.append(title);
  if (game.hoursToStart != null) {
    const when = document.createElement("small");
    when.textContent = `${Number(game.hoursToStart).toFixed(1)}h to start`;
    head.append(when);
  }
  card.append(head);

  for (const limit of game.limits) {
    const row = document.createElement("div");
    row.className = "lm-ap-game-market";

    const label = document.createElement("span");
    label.className = "lm-ap-gm-name";
    label.textContent = LM_AP_MARKET_LABELS[limit.market] || limit.market;

    const pinny = document.createElement("span");
    pinny.className = "lm-ap-gm-pinny";
    pinny.textContent = `Pinnacle ${Number(limit.pinnacle).toLocaleString()}` +
      (limit.line ? ` (${limit.line})` : "");

    const input = document.createElement("input");
    input.type = "number";
    input.min = "0";
    input.step = "100";
    input.value = limit.target;
    input.className = "lm-ap-gm-input";
    input.setAttribute("aria-label",
      `${LM_AP_MARKET_LABELS[limit.market] || limit.market} limit`);

    const set = document.createElement("button");
    set.type = "button";
    set.className = "button secondary lm-ap-gm-set";
    set.textContent = "Set";
    set.addEventListener("click", () =>
      applyLmApGameLimit(set, {
        slug: data.slug,
        storeId: data.storeId,
        gameNumber: game.gameNumber,
        event: game.pinnacleEvent,
        market: limit.market,
        pinnacle: limit.pinnacle,
        amount: Number(input.value),
      })
    );

    row.append(label, pinny, input, set);
    card.append(row);
  }
  host.append(card);
}

async function applyLmApGameLimit(button, payload) {
  if (!Number.isFinite(payload.amount) || payload.amount < 0) {
    setLmApMessage("Enter a valid amount.", "error");
    return;
  }
  button.disabled = true;
  const original = button.textContent;
  button.textContent = "Setting…";
  try {
    const response = await fetch("/api/lm-autopilot/set-game", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
    });
    const data = await response.json();
    if (!response.ok) {
      throw new Error(data.error || "Could not set the limit");
    }
    setLmApMessage(data.message, "success");
    button.textContent = "Set ✓";
    setTimeout(() => { button.textContent = original; button.disabled = false; }, 1500);
    loadLmAutopilot().catch(() => { });
  } catch (error) {
    setLmApMessage(error.message, "error");
    button.textContent = original;
    button.disabled = false;
  }
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
    row.className = "lm-ap-league-wrap";
    row.dataset.slug = league.slug;

    const main = document.createElement("div");
    main.className = "lm-ap-league";

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

    // Mode: all games, or per game.
    const mode = document.createElement("select");
    mode.className = "lm-ap-mode";
    mode.append(makeOption("all", "All games"));
    mode.append(makeOption("per_game", "Per game"));
    mode.value = league.mode === "per_game" ? "per_game" : "all";

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

    main.append(enable, mode, scaleWrap, marketWrap);
    row.append(main);

    // The per-game picker, hidden unless mode is per_game.
    const games = document.createElement("div");
    games.className = "lm-ap-pergame";
    games.hidden = mode.value !== "per_game";
    row.append(games);

    // Remember the saved per-game selection so a first render can pre-check.
    row._selectedGames = league.selectedGames || [];
    if (mode.value === "per_game") {
      loadPerGamePicker(league.slug, games, row._selectedGames, scale.value);
    }
    mode.addEventListener("change", () => {
      const on = mode.value === "per_game";
      games.hidden = !on;
      // The share field is the whole-league default in all-games mode; in
      // per-game mode each game carries its own, so dim the league one.
      scaleWrap.style.opacity = on ? "0.5" : "1";
      if (on && !games.dataset.loaded) {
        loadPerGamePicker(league.slug, games, row._selectedGames, scale.value);
      }
    });
    if (mode.value === "per_game") {
      scaleWrap.style.opacity = "0.5";
    }

    host.append(row);
  }
}

async function loadPerGamePicker(slug, host, selected, defaultShare) {
  host.dataset.loaded = "1";
  host.replaceChildren(makeRampCount("Loading games…"));
  let data;
  try {
    const response = await fetch(
      `/api/lm-autopilot/games?${new URLSearchParams({ slug })}`,
      { cache: "no-store" }
    );
    data = await response.json();
    if (!response.ok) {
      throw new Error(data.error || "Could not load games");
    }
  } catch (error) {
    host.replaceChildren(makeRampCount(error.message));
    host.dataset.loaded = "";
    return;
  }
  if (data.ready === false) {
    host.replaceChildren(
      makeRampCount("LM247 is not connected yet — once its login is added on the server, games appear here (the master switch can stay off while you pick them).")
    );
    host.dataset.loaded = "";
    return;
  }
  const chosen = new Map(
    (selected || []).map((g) => [Number(g.gameNumber), g.scalePercent])
  );
  host.replaceChildren();
  const games = data.games || [];
  if (!games.length) {
    host.append(makeRampCount("No matched games in the window right now."));
    return;
  }
  for (const game of games) {
    const line = document.createElement("label");
    line.className = "lm-ap-pg-row";
    line.dataset.gameNumber = game.gameNumber;
    line.dataset.event = game.pinnacleEvent;

    const box = document.createElement("input");
    box.type = "checkbox";
    box.className = "lm-ap-pg-check";
    box.checked = chosen.has(Number(game.gameNumber));

    const label = document.createElement("span");
    label.className = "lm-ap-pg-name";
    label.textContent = game.pinnacleEvent;

    const when = document.createElement("small");
    when.className = "lm-ap-pg-when";
    when.textContent = game.hoursToStart != null
      ? `${Number(game.hoursToStart).toFixed(0)}h` : "";

    const shareWrap = document.createElement("span");
    shareWrap.className = "lm-ap-pg-share";
    shareWrap.append(document.createTextNode("% "));
    const share = document.createElement("input");
    share.type = "number";
    share.min = "1";
    share.max = "200";
    share.step = "5";
    share.className = "lm-ap-pg-share-input";
    share.value = chosen.get(Number(game.gameNumber)) ?? defaultShare ?? 70;
    shareWrap.append(share);

    line.append(box, label, when, shareWrap);
    host.append(line);
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
  for (const row of elements.lmApLeagues.querySelectorAll(".lm-ap-league-wrap")) {
    const source = (state.lmAutopilot?.leagues || []).find(
      (l) => l.slug === row.dataset.slug
    );
    const mode = row.querySelector(".lm-ap-mode")?.value || "all";
    const selectedGames = mode === "per_game"
      ? [...row.querySelectorAll(".lm-ap-pg-row")]
          .filter((r) => r.querySelector(".lm-ap-pg-check")?.checked)
          .map((r) => ({
            gameNumber: Number(r.dataset.gameNumber),
            event: r.dataset.event,
            scalePercent: Number(r.querySelector(".lm-ap-pg-share-input")?.value) || 70,
          }))
      : [];
    leagues.push({
      slug: row.dataset.slug,
      leagueName: source ? source.leagueName : row.dataset.slug,
      enabled: row.querySelector(".lm-ap-enabled")?.checked || false,
      scalePercent: Number(row.querySelector(".lm-ap-scale-input")?.value) || 70,
      markets: [...row.querySelectorAll(".lm-ap-market")]
        .filter((b) => b.checked)
        .map((b) => b.value),
      mode,
      selectedGames,
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
