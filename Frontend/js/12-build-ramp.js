/* 12-build-ramp.js
 * Build a Ramp page: league grouping by AccessHigh tier, the league
 * picker and filter, the Pinnacle-share controls, and the tracked-limit
 * list with its change history. */

/* ---------------------------------------------------------------------------
 * Limit ramp builder
 *
 * A ramp is nothing new: it is several ordinary recurring schedules on the
 * same league and market at different times. What this saves is the clicking -
 * seven leagues by four markets by three steps is eighty-four schedules.
 * ------------------------------------------------------------------------ */

const rampWeekdays = [
  { value: 0, label: "Mon" },
  { value: 1, label: "Tue" },
  { value: 2, label: "Wed" },
  { value: 3, label: "Thu" },
  { value: 4, label: "Fri" },
  { value: 5, label: "Sat" },
  { value: 6, label: "Sun" },
];

/* A ramp rises, so each default step reads a later part of Pinnacle's day.
 * Leaving them all on "early" produced three identical limits - the times
 * changed and the numbers did not. */
function rampCheckbox(name, value, label, checked) {
  const wrap = document.createElement("label");
  wrap.className = "ramp-check";
  const input = document.createElement("input");
  input.type = "checkbox";
  input.name = name;
  input.value = String(value);
  input.checked = Boolean(checked);
  input.addEventListener("change", updateRampPreview);
  const text = document.createElement("span");
  text.textContent = label;
  wrap.append(input, text);
  return wrap;
}

function rampCheckedValues(host) {
  return [...(host?.querySelectorAll("input:checked") || [])].map(
    (input) => input.value
  );
}

/* AccessHigh files its leagues under four Summary tiers - Big Six, Mid-Level,
 * Minor, Novelty - and a league belongs to the last tier above it in the
 * payload. That is the same rule the dashboard's League dropdown uses, so both
 * agree on which league sits where.
 *
 * Only rows a limit can actually be written to: summary rows roll up their
 * children, and exotics are not editable at all. */
const rampTierOrder = ["BIG SIX", "MID-LEVEL", "MINOR", "NOVELTY"];

function rampTierRank(label) {
  const rank = rampTierOrder.indexOf(normalizeLimitKey(label));
  return rank === -1 ? rampTierOrder.length : rank;
}

function rampLeagueGroups() {
  const groups = new Map();
  let tier = "";

  for (const row of state.rows || []) {
    if (isParentLimitRow(row)) {
      tier = getRowDisplayName(row);
      continue;
    }
    if (isOtherLimitRow(row)) {
      continue;
    }
    if (
      row.rowType !== "League" ||
      row.editable === false ||
      !Array.isArray(row.editableFields) ||
      !row.editableFields.length
    ) {
      continue;
    }
    /* Only leagues Pinnacle can actually be read for. This account carries
       Baseball and Football, so the other four were rows somebody could tick,
       confirm, and only then be told nothing would ever be written to them. */
    if (
      state.trackableLeagues &&
      !state.trackableLeagues.has(rampLeagueLabel(row))
    ) {
      continue;
    }
    const label = tier || "Other leagues";
    if (!groups.has(label)) {
      groups.set(label, []);
    }
    groups.get(label).push(row);
  }

  for (const rows of groups.values()) {
    rows.sort((a, b) => rampLeagueLabel(a).localeCompare(rampLeagueLabel(b)));
  }

  /* Big Six first. In the payload's own order the first screenful was
   * Politics, Poker and Dog Racing, and the leagues that take real money were
   * below the fold. Array#sort is stable, so tiers this does not know about
   * keep the order AccessHigh sent them in. */
  return [...groups.entries()]
    .map(([label, rows]) => ({ label, rows }))
    .sort((a, b) => rampTierRank(a.label) - rampTierRank(b.label));
}

function rampLeagueRows() {
  return rampLeagueGroups().flatMap((group) => group.rows);
}

/*
 * Leagues arrive after the route has already rendered, so the picker has to be
 * told. Without this the page showed "no editable leagues" on a fresh load and
 * never recovered, because applyDashboardRoute had run before the agent was
 * even selected.
 */
function syncRampLeagues() {
  if (elements.buildRampView && !elements.buildRampView.hidden) {
    renderRampLeagues();
    /* The tracked list needs an agent, which is not known when the route
     * first renders. Leagues arriving means one now is. */
    loadTrackedLimits().catch(() => { });
  }
}

function rampLeagueLabel(row) {
  const name =
    row.leagueName || row.organizationLabel || `League ${row.idLeague}`;
  const period = row.periodDescription || "";
  /* organizationLabel already ends with the period on most rows, which is how
   * "Pro Football -- Full Game" became "... -- Full Game -- Full Game". */
  if (!period || name.endsWith(period)) {
    return name;
  }
  return `${name} -- ${period}`;
}

function rampRowKey(row) {
  return [
    row.idOrganization,
    row.idLeague,
    row.idSportType,
    row.periodNumber || 0,
  ].join(":");
}

function rampGroupHeading(label, section) {
  const head = document.createElement("div");
  head.className = "ramp-league-group-head";

  const name = document.createElement("span");
  name.className = "ramp-league-group-name";
  name.textContent = label;

  const all = document.createElement("button");
  all.type = "button";
  all.className = "link-button";
  all.textContent = "All";
  all.addEventListener("click", () => setRampLeagueChecks(section, true));

  const none = document.createElement("button");
  none.type = "button";
  none.className = "link-button";
  none.textContent = "None";
  none.addEventListener("click", () => setRampLeagueChecks(section, false));

  const count = document.createElement("span");
  count.className = "ramp-count ramp-league-group-count";

  head.append(name, all, none, count);
  return head;
}

function renderRampLeagues() {
  if (!elements.rampLeagues) {
    return;
  }
  const previous = new Set(rampCheckedValues(elements.rampLeagues));
  const groups = rampLeagueGroups();
  elements.rampLeagues.replaceChildren();

  if (!groups.length) {
    const empty = document.createElement("p");
    empty.className = "ramp-count ramp-empty";
    empty.textContent = !state.selectedAgentId
      ? "Select an agent on the left to load its leagues."
      : state.trackableLeagues && (state.rows || []).length
        ? "None of this agent's leagues are ones Pinnacle carries on this " +
          "account, so there is nothing here to follow."
        : "Loading leagues for this agent...";
    elements.rampLeagues.append(empty);
    updateRampPreview();
    return;
  }

  for (const group of groups) {
    const section = document.createElement("div");
    section.className = "ramp-league-group";

    const list = document.createElement("div");
    list.className = "ramp-league-list";
    for (const row of group.rows) {
      const key = rampRowKey(row);
      list.append(
        rampCheckbox("rampLeague", key, rampLeagueLabel(row), previous.has(key))
      );
    }

    section.append(rampGroupHeading(group.label, section), list);
    elements.rampLeagues.append(section);
  }

  /* Say why the list is short. Four of the seven leagues vanishing without
     explanation reads as a bug, and the reason is not guessable from here. */
  if (state.trackableLeagues) {
    const note = document.createElement("p");
    note.className = "ramp-count";
    note.textContent =
      "Only leagues Pinnacle carries on this account are listed" +
      (state.trackableLeagues.size
        ? ` (${[...state.trackableLeagues]
            .map((name) => name.replace(/ -- .*$/, ""))
            .sort()
            .join(", ")}).`
        : ".") +
      " Others cannot be tracked because there is nothing to follow.";
    elements.rampLeagues.append(note);
  }

  /* Re-applies the filter box, and updates the preview on its way out. */
  filterRampLeagues();
}

/* Ticks only what the filter is currently showing, so "Select all" after a
 * search means the search rather than all fifty-three. */
function setRampLeagueChecks(scope, checked) {
  (scope || elements.rampLeagues)
    ?.querySelectorAll(".ramp-check:not([hidden]) input")
    .forEach((input) => {
      input.checked = checked;
    });
  updateRampPreview();
}

function filterRampLeagues() {
  const query = (elements.rampLeagueSearch?.value || "").trim().toLowerCase();

  for (const group of
    elements.rampLeagues?.querySelectorAll(".ramp-league-group") || []) {
    /* Searching a tier name keeps the whole tier, so "big six" is one way to
     * reach the leagues that matter. */
    const tierMatches =
      !query ||
      (group.querySelector(".ramp-league-group-name")?.textContent || "")
        .toLowerCase()
        .includes(query);

    let visible = 0;
    for (const check of group.querySelectorAll(".ramp-check")) {
      /* Hidden, never removed: a league ticked before the search stays ticked
       * and is still submitted once the search is cleared. */
      const matches =
        tierMatches || check.textContent.toLowerCase().includes(query);
      check.hidden = !matches;
      if (matches) {
        visible += 1;
      }
    }
    group.hidden = !visible;
  }

  updateRampPreview();
}

function renderRampControls() {
  if (!elements.rampFields || elements.rampFields.childElementCount) {
    return;
  }
  for (const [field, label] of Object.entries(fieldLabels)) {
    elements.rampFields.append(
      rampCheckbox("rampField", field, label, true)
    );
  }
}

function rampScalePercent() {
  const value = Number(elements.rampScale?.value);
  return Number.isFinite(value) && value > 0 ? Math.round(value) : 0;
}

function updateRampPreview() {
  if (!elements.rampPreview) {
    return;
  }

  const leagues = rampCheckedValues(elements.rampLeagues).length;
  const fields = rampCheckedValues(elements.rampFields).length;
  const total = leagues * fields;
  const scale = rampScalePercent();

  if (elements.rampLeagueCount) {
    const available = rampLeagueRows().length;
    const shown = elements.rampLeagues
      ? elements.rampLeagues.querySelectorAll(".ramp-check:not([hidden])").length
      : 0;
    /* Says how many the filter is hiding, so a count that has not moved while
     * "Select all" was pressed is explained rather than mysterious. */
    elements.rampLeagueCount.textContent = !available
      ? ""
      : shown < available
        ? `${leagues} of ${available} selected \u00b7 ${shown} shown`
        : `${leagues} of ${available} selected`;
  }

  if (elements.rampCreate) {
    elements.rampCreate.disabled = !total || !scale;
  }

  elements.rampPreview.textContent = !total
    ? "Choose the leagues and limit types to track. Only leagues Pinnacle data is kept for can be tracked."
    : !scale
      ? "Enter the share of Pinnacle to track."
      : `This tracks ${total.toLocaleString()} limit${total === 1 ? "" : "s"} at ${scale}% of Pinnacle: ` +
        `${leagues} league${leagues === 1 ? "" : "s"} x ${fields} limit type${fields === 1 ? "" : "s"}. ` +
        `Each one moves on its own as Pinnacle moves, so there is no ramp to set.`;
}

function setRampMessage(message = "", type = "") {
  if (!elements.rampMessage) {
    return;
  }
  elements.rampMessage.textContent = message;
  elements.rampMessage.className = `message ${type}`.trim();
  elements.rampMessage.hidden = !message;
}

async function loadTrackedLimits() {
  if (!state.selectedAgentId || !elements.rampTracked) {
    return;
  }
  try {
    const response = await fetch(
      `/api/trackers?${new URLSearchParams({ accountId: state.selectedAgentId })}`,
      { cache: "no-store" }
    );
    const data = await response.json();
    if (!response.ok) {
      throw new Error(data.error || "Could not load tracked limits");
    }
    state.trackers = Array.isArray(data.trackers) ? data.trackers : [];
    state.trackerHistory = Array.isArray(data.history) ? data.history : [];
    state.trackerSettings = data;
    state.trackableLeagues = Array.isArray(data.trackableLeagues)
      ? new Set(data.trackableLeagues)
      : null;
    /* The picker rendered before this arrived, so it is showing every league.
       Now that the supported set is known, draw it again. */
    renderRampLeagues();
    renderTrackedLimits();
    renderTrackerHistory();
  } catch (error) {
    setRampMessage(error.message, "error");
  }
}

/*
 * Every write the tracker has made, newest first. Read from the change log
 * rather than kept alongside it, so this cannot drift from what was actually
 * written.
 */
function renderTrackerHistory() {
  const host = elements.rampHistory;
  if (!host) {
    return;
  }
  host.replaceChildren();

  const history = state.trackerHistory || [];
  if (!history.length) {
    const empty = document.createElement("p");
    empty.className = "ramp-count";
    empty.textContent =
      "No tracked limit has changed yet. A change is recorded here the moment one is written.";
    host.append(empty);
    return;
  }

  const table = document.createElement("table");
  table.className = "ramp-tracked-table ramp-history-table";
  const head = document.createElement("thead");
  const headRow = document.createElement("tr");
  ["When (EST)", "League", "Period", "Market", "From", "To", "Move"]
    .forEach((label) => {
      const th = document.createElement("th");
      th.textContent = label;
      headRow.append(th);
    });
  head.append(headRow);
  table.append(head);

  const body = document.createElement("tbody");
  for (const entry of history) {
    const row = document.createElement("tr");
    const from = Number(entry.from);
    const to = Number(entry.to);
    /* Direction matters more than the delta: a limit coming down is the one
     * worth noticing at a glance. */
    let move = "—";
    let moveClass = "";
    if (Number.isFinite(from) && Number.isFinite(to) && from > 0) {
      const percent = Math.round(((to - from) / from) * 100);
      move = `${percent > 0 ? "+" : ""}${percent}%`;
      moveClass = percent < 0 ? "comparison-limit-over" : "";
    }
    const moveCell = comparisonCell(move, moveClass);

    row.append(
      comparisonCell(comparisonText(entry.at)),
      comparisonCell(comparisonText(entry.leagueName)),
      comparisonCell(comparisonText(entry.period, "Full Game")),
      comparisonCell(fieldLabels[entry.field] || entry.field),
      comparisonCell(
        Number.isFinite(from) ? from.toLocaleString() : "—"
      ),
      comparisonCell(Number.isFinite(to) ? to.toLocaleString() : "—"),
      moveCell
    );
    body.append(row);
  }
  table.append(body);
  host.append(table);
}

function renderTrackedLimits() {
  const host = elements.rampTracked;
  if (!host) {
    return;
  }
  host.replaceChildren();

  const trackers = state.trackers || [];
  if (!trackers.length) {
    const empty = document.createElement("p");
    empty.className = "ramp-count";
    empty.textContent = state.selectedAgentId
      ? "Nothing is being tracked for this agent yet. Pick leagues and limit types, then start tracking."
      : "Select an agent on the left to see what it is tracking.";
    host.append(empty);
    return;
  }

  const settings = state.trackerSettings || {};
  const note = document.createElement("p");
  note.className = "ramp-count";
  note.textContent =
    `Checked every ${settings.intervalMinutes || 10} minutes against the ` +
    `${settings.basis === "median" ? "typical" : "lowest"} Pinnacle limit across ` +
    `fixtures starting within ${settings.windowHours || 12} hours. Games already ` +
    `under way are excluded, since Pinnacle's in-play limits are not comparable. ` +
    `A limit is only rewritten once Pinnacle has moved more than ` +
    `${settings.minChangePercent || 8}%. Lines and limits come from Pinnacle's ` +
    `own feed, so this is their whole board, not a sample of it.`;
  if (settings.sourceConfigured === false) {
    note.textContent =
      "The Pinnacle feed is not configured on this deployment, so nothing is " +
      "being checked. Set PINNACLE_API_USERNAME and PINNACLE_API_PASSWORD.";
  }
  host.append(note);

  const table = document.createElement("table");
  table.className = "ramp-tracked-table ramp-current-table";
  const head = document.createElement("thead");
  const headRow = document.createElement("tr");
  ["League", "Market", "Pinnacle line", "Pinnacle now", "Your limit", "Last checked", "What happened", ""]
    .forEach((label) => {
      const th = document.createElement("th");
      th.textContent = label;
      headRow.append(th);
    });
  head.append(headRow);
  table.append(head);

  const body = document.createElement("tbody");
  for (const tracker of trackers) {
    const row = document.createElement("tr");
    const stop = document.createElement("button");
    stop.type = "button";
    stop.className = "link-button";
    stop.textContent = "Stop";
    stop.addEventListener("click", async () => {
      stop.disabled = true;
      try {
        const response = await fetch("/api/trackers/delete", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ id: tracker.id }),
        });
        const data = await response.json();
        if (!response.ok) {
          throw new Error(data.error || "Could not stop tracking");
        }
        await loadTrackedLimits();
        setRampMessage(data.message, "success");
      } catch (error) {
        stop.disabled = false;
        setRampMessage(error.message, "error");
      }
    });
    const stopCell = document.createElement("td");
    stopCell.append(stop);

    row.append(
      comparisonCell(comparisonText(tracker.leagueName)),
      comparisonCell(
        `${fieldLabels[tracker.field] || tracker.field}` +
        (tracker.period && tracker.period !== "Full Game" ? ` (${tracker.period})` : "")
      ),
      /* The line the limit was read against. A 5,000 maximum means something
       * different at -3.5 than at -10.5, so showing the limit without it
       * invites the wrong conclusion about how much Pinnacle trusts it. */
      comparisonCell(comparisonText(tracker.pinnacleLine)),
      comparisonCell(
        tracker.pinnacle ? Number(tracker.pinnacle).toLocaleString() : "—"
      ),
      comparisonCell(
        tracker.value
          ? `${Number(tracker.value).toLocaleString()} (${tracker.scalePercent}%)`
          : `— (${tracker.scalePercent}%)`
      ),
      comparisonCell(
        /* The date is almost always today; the clock time is the part that
         * tells you whether the tracker is still running. */
        comparisonText(
          String(tracker.checkedAt || "").replace(/^\S+\s/, ""),
          "not yet"
        )
      ),
      comparisonCell(comparisonText(tracker.note, "waiting for first check")),
      stopCell
    );
    body.append(row);
  }
  table.append(body);
  host.append(table);
}

async function createRamp() {
  const rows = rampLeagueRows();
  const selected = new Set(rampCheckedValues(elements.rampLeagues));
  const targets = rows
    .filter((row) => selected.has(rampRowKey(row)))
    .map((row) => ({
      idOrganization: row.idOrganization,
      idLeague: row.idLeague,
      idSportType: row.idSportType,
      periodNumber: row.periodNumber || 0,
      leagueName: rampLeagueLabel(row),
      periodDescription: row.periodDescription,
      editableFields: row.editableFields,
    }));

  /*
   * A league's period markets are a separate row that the dashboard only
   * fetches when the league is expanded, so they are not in the picker.
   * Fetching them here means "all of MLB" really means all of it, rather
   * than quietly meaning full game only.
   */
  if (elements.rampIncludePeriods?.checked) {
    for (const row of rows.filter(
      (candidate) => candidate.hasPeriods && selected.has(rampRowKey(candidate))
    )) {
      try {
        const query = new URLSearchParams({
          accountId: row.accountId,
          idOrganization: row.idOrganization,
          idLeague: row.idLeague,
        });
        const response = await fetch(`/api/periods?${query}`, {
          cache: "no-store",
        });
        const data = await response.json();
        if (!response.ok) {
          continue;
        }
        for (const period of data.rows || []) {
          targets.push({
            idOrganization: period.idOrganization,
            idLeague: period.idLeague,
            idSportType: period.idSportType,
            periodNumber: period.periodNumber || 0,
            leagueName: rampLeagueLabel(row),
            periodDescription:
              period.periodDescription || period.leagueName,
            editableFields: period.editableFields,
          });
        }
      } catch {
        /* A league whose periods cannot be read still tracks its full game. */
      }
    }
  }

  const fields = rampCheckedValues(elements.rampFields);
  const agentName = elements.rampAgentName?.value.trim() || "";
  const scale = rampScalePercent();

  if (!targets.length) {
    setRampMessage("Select at least one league.", "error");
    return;
  }
  if (!fields.length) {
    setRampMessage("Select at least one limit type.", "error");
    return;
  }
  if (!agentName) {
    setRampMessage("Enter the Customer Support Agent name.", "error");
    return;
  }
  if (!scale) {
    setRampMessage("Enter the share of Pinnacle to track.", "error");
    return;
  }

  const total = targets.length * fields.length;
  const periodCount = targets.filter((t) => t.periodNumber).length;
  if (
    !window.confirm(
      `Track ${total.toLocaleString()} limit${total === 1 ? "" : "s"} at ${scale}% of Pinnacle?\n\n` +
      `Across ${targets.length} row${targets.length === 1 ? "" : "s"}` +
      (periodCount ? ` (${periodCount} of them period markets)` : "") +
      ` and ${fields.length} limit type${fields.length === 1 ? "" : "s"}.\n\n` +
      `These limits will be rewritten automatically whenever Pinnacle moves. ` +
      `Tracked limits are the one place the blue rule does not apply, because ` +
      `every write marks a limit blue and tracking could otherwise run once only.`
    )
  ) {
    return;
  }

  elements.rampCreate.disabled = true;
  const original = elements.rampCreate.textContent;
  elements.rampCreate.textContent = "Starting...";
  setRampMessage("");

  try {
    const response = await fetch("/api/trackers", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        accountId: state.selectedAgentId,
        targets,
        fields,
        scalePercent: scale,
        customerSupportAgent: agentName,
        limitMode: "normal",
      }),
    });
    const data = await response.json();
    if (!response.ok) {
      throw new Error(data.error || "Could not start tracking");
    }
    await loadTrackedLimits();
    const detail = (data.skipped || []).length
      ? ` Skipped: ${data.skipped.slice(0, 3).join("; ")}${data.skipped.length > 3 ? "..." : ""}`
      : "";
    setRampMessage(`${data.message}.${detail}`, "success");
  } catch (error) {
    setRampMessage(error.message, "error");
  } finally {
    elements.rampCreate.disabled = false;
    elements.rampCreate.textContent = original;
  }
}

if (elements.rampScale) {
  elements.rampScale.addEventListener("input", updateRampPreview);
}

if (elements.rampCreate) {
  renderRampControls();
  elements.rampCreate.addEventListener("click", createRamp);
  elements.rampSelectAll?.addEventListener("click", () =>
    setRampLeagueChecks(null, true)
  );
  elements.rampSelectNone?.addEventListener("click", () =>
    setRampLeagueChecks(null, false)
  );
  elements.rampLeagueSearch?.addEventListener("input", filterRampLeagues);
}
