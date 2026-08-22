/* 06-trading-monitor.js
 * Trading Monitor page: state badges, score formatting, table rendering,
 * the 30-second auto-refresh, and its loaders. */

function setTradingMessage(message = "", type = "") {
  elements.tradingMessage.textContent = message;
  elements.tradingMessage.className = `message comparison-message ${type}`.trim();
  elements.tradingMessage.hidden = !message;
}

function tradingStateBadge(label, stateName) {
  const badge = document.createElement("span");
  badge.className = `trading-state trading-state-${stateName}`;
  badge.textContent = label;
  return badge;
}

function tradingScoreText(event) {
  const scores = Array.isArray(event.scores) ? event.scores : [];
  const score = [...scores].reverse().find(
    (item) => item.participant1Score !== null && item.participant2Score !== null
  );
  if (!score) {
    return "—";
  }
  return `${score.participant1Score}–${score.participant2Score}`;
}

function renderTradingMonitor(data) {
  state.tradingMonitor = data;
  elements.tradingEventCount.textContent = comparisonText(data.eventCount, "0");
  elements.tradingSuspendedCount.textContent = comparisonText(
    data.suspendedCount,
    "0"
  );
  elements.tradingActionCount.textContent = comparisonText(data.actionCount, "0");
  elements.tradingRows.replaceChildren();

  if (!data.events?.length) {
    const row = document.createElement("tr");
    const cell = document.createElement("td");
    cell.colSpan = 7;
    cell.className = "empty-state";
    cell.textContent = `No current ${comparisonText(data.league, "league")} events are mapped between ${partnerLabel()} and Pinnacle.`;
    row.append(cell);
    elements.tradingRows.append(row);
    return;
  }

  data.events.forEach((event) => {
    const row = document.createElement("tr");
    const fixture = document.createElement("td");
    const fixtureName = document.createElement("strong");
    const fixtureMeta = document.createElement("small");
    const mappingMeta = document.createElement("small");
    fixtureName.textContent = comparisonText(event.fixture);
    const start = new Date(event.startTimeUtc);
    fixtureMeta.textContent = Number.isNaN(start.valueOf())
      ? (event.periods || []).join(" · ")
      : `${start.toLocaleString([], {
          month: "short",
          day: "numeric",
          hour: "numeric",
          minute: "2-digit",
        })} · ${(event.periods || []).join(" · ")}`;
    const startDifference = event.mapping?.maxStartDifferenceMinutes;
    mappingMeta.textContent = event.mapping?.verified
      ? `Verified teams + start time (${comparisonText(startDifference, "0")} min difference)`
      : "Mapping not verified";
    mappingMeta.className = event.mapping?.verified
      ? "trading-evidence trading-evidence-ok"
      : "trading-evidence trading-evidence-warning";
    fixture.append(fixtureName, fixtureMeta, mappingMeta);

    const score = document.createElement("td");
    const scoreValue = document.createElement("strong");
    const clock = document.createElement("small");
    scoreValue.textContent = tradingScoreText(event);
    clock.textContent = [
      event.clock?.currentPeriod,
      event.clock?.remainingTimeInPeriod || event.clock?.remainingTime,
    ].filter(Boolean).join(" · ") || "Not live";
    score.append(scoreValue, clock);

    const gameStatus = document.createElement("td");
    gameStatus.append(tradingStateBadge(
      comparisonText(event.status?.name, event.status?.live ? "Live" : "Scheduled"),
      event.status?.live ? "live" : "neutral"
    ));

    const aces = document.createElement("td");
    aces.append(tradingStateBadge(
      event.acesHigh?.open ? "Open" : "Closed",
      event.acesHigh?.open ? "open" : "closed"
    ));

    const pinnacle = document.createElement("td");
    const pinnacleLabel = event.pinnacle?.staleOdds
      ? "Stale"
      : event.pinnacle?.suspended
      ? "Suspended"
      : event.pinnacle?.open
      ? "Open"
      : event.pinnacle?.hasOdds === false
      ? "Unavailable"
      : event.pinnacle?.quoteCount > 0
      ? "Closed"
      : "Unknown";
    const pinnacleState = event.pinnacle?.staleOdds
      ? "hold"
      : event.pinnacle?.suspended
      ? "suspend"
      : event.pinnacle?.open
      ? "open"
      : event.pinnacle?.hasOdds === false
      ? "hold"
      : event.pinnacle?.quoteCount > 0
      ? "closed"
      : "hold";
    pinnacle.append(tradingStateBadge(pinnacleLabel, pinnacleState));
    const pinnacleEvidence = document.createElement("small");
    pinnacleEvidence.className = "trading-evidence";
    pinnacleEvidence.textContent = `${comparisonText(
      event.pinnacle?.activeQuoteCount,
      "0"
    )}/${comparisonText(event.pinnacle?.quoteCount, "0")} active quotes`;
    pinnacle.append(pinnacleEvidence);

    const signal = document.createElement("td");
    signal.append(tradingStateBadge(
      comparisonText(event.recommendation),
      event.signal || "neutral"
    ));

    const updated = document.createElement("td");
    const updatedAt = new Date(event.pinnacle?.updatedAt || data.generatedAt);
    updated.textContent = Number.isNaN(updatedAt.valueOf())
      ? "—"
      : updatedAt.toLocaleTimeString([], { hour: "numeric", minute: "2-digit", second: "2-digit" });

    row.append(fixture, score, gameStatus, aces, pinnacle, signal, updated);
    elements.tradingRows.append(row);
  });
}

async function loadTradingLeagues(force = false) {
  if (!state.selectedAgentId) {
    return;
  }
  const accountId = state.selectedAgentId;
  if (
    !force &&
    Number(state.tradingLeaguesAgentId) === Number(accountId) &&
    state.tradingLeagues.length
  ) {
    return;
  }
  elements.tradingLeague.disabled = true;
  elements.tradingLeague.replaceChildren(new Option("Loading leagues...", ""));
  const params = new URLSearchParams({ accountId: String(accountId) });
  const response = await fetch(`/api/pinnacle-comparison/leagues?${params}`, {
    cache: "no-store",
  });
  const data = await response.json();
  if (!response.ok) {
    throw new Error(data.error || "Could not load trading leagues");
  }
  if (Number(accountId) !== Number(state.selectedAgentId)) {
    return;
  }
  state.tradingLeagues = data.leagues || [];
  state.tradingLeaguesAgentId = accountId;
  const available = new Set(state.tradingLeagues.map((league) => league.slug));
  if (!available.has(state.tradingLeague)) {
    state.tradingLeague = available.has("mlb")
      ? "mlb"
      : (state.tradingLeagues[0]?.slug || "");
  }
  elements.tradingLeague.replaceChildren();
  if (!state.tradingLeagues.length) {
    elements.tradingLeague.append(new Option("No mapped leagues", ""));
    setTradingMessage(`No ${partnerLabel()} leagues overlap with this OddsPapi account.`, "error");
    return;
  }
  state.tradingLeagues.forEach((league) => {
    elements.tradingLeague.append(new Option(league.name, league.slug));
  });
  elements.tradingLeague.value = state.tradingLeague;
  elements.tradingLeague.disabled = false;
}

function scheduleTradingRefresh() {
  if (tradingRefreshTimer) {
    clearTimeout(tradingRefreshTimer);
  }
  if (!isTradingMonitorRoute()) {
    tradingRefreshTimer = null;
    return;
  }
  tradingRefreshTimer = setTimeout(() => {
    // Ask the backend on every UI tick, while allowing its short cache to
    // protect AcesHigh and OddsPapi from unnecessary repeated requests.
    state.tradingMonitor = null;
    loadTradingMonitor(false).catch(() => { });
  }, 30000);
}

async function loadTradingMonitor(force = false) {
  if (!state.selectedAgentId || !state.tradingLeague || state.tradingLoading) {
    return;
  }
  if (
    !force &&
    state.tradingMonitor &&
    Number(state.tradingAgentId) === Number(state.selectedAgentId) &&
    state.tradingMonitor.leagueSlug === state.tradingLeague
  ) {
    renderTradingMonitor(state.tradingMonitor);
    scheduleTradingRefresh();
    return;
  }
  const requestId = ++state.tradingRequest;
  const accountId = state.selectedAgentId;
  state.tradingLoading = true;
  elements.tradingRefresh.disabled = true;
  elements.tradingRefresh.textContent = "Refreshing...";
  setTradingMessage("Loading mapped events and Pinnacle trading state...");
  try {
    const params = new URLSearchParams({
      accountId: String(accountId),
      league: state.tradingLeague,
    });
    if (force) {
      params.set("refresh", "true");
    }
    const response = await fetch(`/api/trading-monitor?${params}`, {
      cache: "no-store",
    });
    const data = await response.json();
    if (!response.ok) {
      throw new Error(data.error || "Could not load the trading monitor");
    }
    if (
      requestId !== state.tradingRequest ||
      Number(accountId) !== Number(state.selectedAgentId)
    ) {
      return;
    }
    state.tradingAgentId = accountId;
    renderTradingMonitor(data);
    setTradingMessage("");
  } catch (error) {
    if (requestId === state.tradingRequest) {
      setTradingMessage(error.message, "error");
    }
    throw error;
  } finally {
    if (requestId === state.tradingRequest) {
      state.tradingLoading = false;
      elements.tradingRefresh.disabled = false;
      elements.tradingRefresh.textContent = "Refresh";
      scheduleTradingRefresh();
    }
  }
}

