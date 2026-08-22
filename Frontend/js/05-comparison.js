/* 05-comparison.js
 * Pinnacle vs partner comparison page: odds/limit formatting, the
 * start-time window filter, table rendering, and the league + data loaders. */

function comparisonText(value, fallback = "—") {
  return value === null || value === undefined || value === ""
    ? fallback
    : String(value);
}

function formatAmericanOdds(value) {
  if (value === null || value === undefined || value === "") {
    return "—";
  }
  const number = Number(value);
  if (!Number.isFinite(number)) {
    return String(value);
  }
  return number > 0 ? `+${Math.round(number)}` : String(Math.round(number));
}

function formatComparisonLine(value) {
  if (value === null || value === undefined || value === "") {
    return "—";
  }
  const number = Number(value);
  if (!Number.isFinite(number)) {
    return String(value);
  }
  return number > 0 ? `+${number}` : String(number);
}

function formatComparisonLimit(value, currency = "USD") {
  const number = Number(value);
  if (!Number.isFinite(number)) {
    return "—";
  }
  return new Intl.NumberFormat("en-US", {
    style: "currency",
    currency: currency || "USD",
    maximumFractionDigits: Number.isInteger(number) ? 0 : 2,
  }).format(number);
}

function comparisonCell(text, className = "") {
  const cell = document.createElement("td");
  cell.textContent = text;
  if (className) {
    cell.className = className;
  }
  return cell;
}

/*
 * Pinnacle raises a limit as the game approaches: today the NFL fixtures are
 * three weeks out and capped at 750, while MLB games a few hours away sit
 * between 3,750 and 8,272. Comparing a standing league limit against a
 * far-out fixture therefore says nothing, so the window drops them.
 */
function comparisonWindowHours() {
  const raw = elements.comparisonWindow?.value ?? "24";
  if (raw === "all") {
    return Infinity;
  }
  const hours = Number(raw);
  return Number.isFinite(hours) && hours > 0 ? hours : 24;
}

function hoursUntilStart(section) {
  const start = new Date(section?.startTimeUtc);
  if (Number.isNaN(start.valueOf())) {
    return null;
  }
  return (start.getTime() - Date.now()) / 3600000;
}

function withinComparisonWindow(section, hours) {
  if (hours === Infinity) {
    return true;
  }
  const remaining = hoursUntilStart(section);
  /* A fixture with no usable start time is kept rather than silently dropped. */
  if (remaining === null) {
    return true;
  }
  return remaining <= hours;
}

function median(values) {
  if (!values.length) {
    return null;
  }
  const sorted = [...values].sort((a, b) => a - b);
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2
    ? sorted[middle]
    : (sorted[middle - 1] + sorted[middle]) / 2;
}

function renderPinnacleComparison(data) {
  state.comparison = data;

  const generated = new Date(data.generatedAt);
  elements.comparisonGeneratedAt.textContent = Number.isNaN(generated.valueOf())
    ? "—"
    : generated.toLocaleString([], {
        month: "short",
        day: "numeric",
        hour: "numeric",
        minute: "2-digit",
      });

  elements.comparisonContent.replaceChildren();

  const hours = comparisonWindowHours();
  const sections = (data.comparisons || []).filter((section) =>
    withinComparisonWindow(section, hours)
  );

  elements.comparisonFixtureCount.textContent = String(
    new Set(sections.map((section) => section.fixtureId ?? section.fixture)).size
  );
  elements.comparisonSectionCount.textContent = String(sections.length);

  if (!data.comparisons?.length) {
    const empty = document.createElement("p");
    empty.className = "comparison-empty";
    empty.textContent =
      `No current ${comparisonText(data.league, "league")} fixtures could be mapped between ${partnerLabel()} and Pinnacle.`;
    elements.comparisonContent.append(empty);
    return;
  }

  if (!sections.length) {
    const empty = document.createElement("p");
    empty.className = "comparison-empty";
    const total = data.comparisons.length;
    empty.textContent =
      `None of the ${total} mapped ${total === 1 ? "fixture" : "fixtures"} start within ` +
      `${hours} hours. Pinnacle's limits are low this far out, so comparing them ` +
      `to a standing limit would mislead. Widen the window to see them anyway.`;
    elements.comparisonContent.append(empty);
    return;
  }

  sections.forEach((section) => {
    const card = document.createElement("article");
    card.className = "comparison-card";

    const header = document.createElement("header");
    const titleWrap = document.createElement("div");
    const title = document.createElement("h3");
    title.textContent = comparisonText(section.fixture, `${comparisonText(data.league, "League")} fixture`);
    const meta = document.createElement("p");
    const start = new Date(section.startTimeUtc);
    meta.textContent = Number.isNaN(start.valueOf())
      ? `${partnerLabel()} game ${comparisonText(section.acesHighGameNumber)}`
      : `${start.toLocaleString([], {
          weekday: "short",
          hour: "numeric",
          minute: "2-digit",
        })} · ${partnerLabel()} game ${comparisonText(section.acesHighGameNumber)}`;
    titleWrap.append(title, meta);
    const period = document.createElement("span");
    period.className = "comparison-period";
    period.textContent = comparisonText(section.period);
    header.append(titleWrap, period);
    card.append(header);

    const wrap = document.createElement("div");
    wrap.className = "comparison-table-wrap";
    const table = document.createElement("table");
    table.className = "comparison-table";
    const head = document.createElement("thead");
    const headRow = document.createElement("tr");
    [
      "Market",
      "Selection",
      `${partnerLabel()} line`,
      `${partnerLabel()} odds`,
      "Pinnacle line",
      "Pinnacle odds",
    ].forEach((label) => {
      const th = document.createElement("th");
      th.textContent = label;
      headRow.append(th);
    });
    head.append(headRow);
    table.append(head);

    const body = document.createElement("tbody");
    (section.rows || []).forEach((row) => {
      const tr = document.createElement("tr");
      tr.append(
        comparisonCell(comparisonText(row.market)),
        comparisonCell(comparisonText(row.selection), "comparison-selection"),
        comparisonCell(formatComparisonLine(row.acesHigh?.line)),
        comparisonCell(formatAmericanOdds(row.acesHigh?.oddsAmerican)),
        comparisonCell(formatComparisonLine(row.pinnacle?.line)),
        comparisonCell(formatAmericanOdds(row.pinnacle?.oddsAmerican))
      );
      body.append(tr);
    });
    table.append(body);
    wrap.append(table);
    card.append(wrap);
    elements.comparisonContent.append(card);
  });
}

if (elements.comparisonWindow) {
  elements.comparisonWindow.addEventListener("change", () => {
    /* Filtering is done over data already in hand, so this is instant and
     * costs AccessHigh and OddsPapi nothing. */
    if (state.comparison) {
      renderPinnacleComparison(state.comparison);
    }
  });
}

function setComparisonMessage(message = "", type = "") {
  elements.comparisonMessage.textContent = message;
  elements.comparisonMessage.className = `message comparison-message ${type}`.trim();
  elements.comparisonMessage.hidden = !message;
}

async function loadComparisonLeagues(force = false) {
  if (!state.selectedAgentId) {
    return;
  }
  const accountId = state.selectedAgentId;
  if (
    !force &&
    Number(state.comparisonLeaguesAgentId) === Number(accountId) &&
    state.comparisonLeagues.length
  ) {
    return;
  }
  elements.comparisonLeague.disabled = true;
  elements.comparisonLeague.replaceChildren(new Option("Loading leagues...", ""));
  const params = new URLSearchParams({ accountId: String(accountId) });
  const response = await fetch(`/api/pinnacle-comparison/leagues?${params}`, {
    cache: "no-store",
  });
  const data = await response.json();
  if (!response.ok) {
    throw new Error(data.error || "Could not load comparison leagues");
  }
  if (Number(accountId) !== Number(state.selectedAgentId)) {
    return;
  }
  state.comparisonLeagues = data.leagues || [];
  state.comparisonLeaguesAgentId = accountId;
  const available = new Set(state.comparisonLeagues.map((league) => league.slug));
  if (!available.has(state.comparisonLeague)) {
    state.comparisonLeague = available.has("mlb")
      ? "mlb"
      : (state.comparisonLeagues[0]?.slug || "");
  }
  elements.comparisonLeague.replaceChildren();
  if (!state.comparisonLeagues.length) {
    elements.comparisonLeague.append(new Option("No mapped leagues", ""));
    setComparisonMessage(
      `No ${partnerLabel()} leagues for this agent overlap with the sports enabled in OddsPapi.`,
      "error"
    );
    return;
  }
  state.comparisonLeagues.forEach((league) => {
    elements.comparisonLeague.append(new Option(league.name, league.slug));
  });
  elements.comparisonLeague.value = state.comparisonLeague;
  elements.comparisonLeague.disabled = false;
}

async function loadPinnacleComparison(force = false) {
  if (!state.selectedAgentId || !state.comparisonLeague || state.comparisonLoading) {
    return;
  }
  if (
    !force &&
    state.comparison &&
    Number(state.comparisonAgentId) === Number(state.selectedAgentId) &&
    state.comparison.leagueSlug === state.comparisonLeague
  ) {
    renderPinnacleComparison(state.comparison);
    return;
  }

  const requestId = ++state.comparisonRequest;
  const accountId = state.selectedAgentId;
  state.comparisonLoading = true;
  elements.comparisonRefresh.disabled = true;
  elements.comparisonRefresh.textContent = "Refreshing...";
  const leagueName = state.comparisonLeagues.find(
    (league) => league.slug === state.comparisonLeague
  )?.name || "league";
  setComparisonMessage(`Loading current ${leagueName} lines and limits...`);

  try {
    const params = new URLSearchParams({
      accountId: String(accountId),
      league: state.comparisonLeague,
    });
    if (force) {
      params.set("refresh", "true");
    }
    const response = await fetch(`/api/pinnacle-comparison?${params}`, {
      cache: "no-store",
    });
    const data = await response.json();
    if (!response.ok) {
      throw new Error(data.error || "Could not load the league comparison");
    }
    if (
      requestId !== state.comparisonRequest ||
      Number(accountId) !== Number(state.selectedAgentId)
    ) {
      return;
    }
    state.comparisonAgentId = accountId;
    renderPinnacleComparison(data);
    setComparisonMessage("");
  } catch (error) {
    if (requestId === state.comparisonRequest) {
      setComparisonMessage(error.message, "error");
    }
    throw error;
  } finally {
    if (requestId === state.comparisonRequest) {
      state.comparisonLoading = false;
      elements.comparisonRefresh.disabled = false;
      elements.comparisonRefresh.textContent = "Refresh data";
    }
  }
}

