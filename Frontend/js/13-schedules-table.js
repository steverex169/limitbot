/* 13-schedules-table.js
 * Current schedules table rendering and its status-filter and delete-all
 * controls. */

const expandedScheduleLeagues = new Set();

/* Which period tab is open per league. A league with schedules on more than one
 * period (Full game, 1st half, 2nd half, …) gets a tab per period on its
 * header; picking one shows only that period's entries, so they read
 * separately instead of all mixed in one list. Keyed by the league row key. */
const selectedSchedulePeriod = new Map();

function shortenPeriodLabel(description, periodNumber) {
  if (Number(periodNumber || 0) === 0) {
    return "FG";
  }
  const d = String(description || "").toLowerCase();
  if (/(1st|first)\s*half/.test(d)) return "1H";
  if (/(2nd|second)\s*half/.test(d)) return "2H";
  if (/(1st|first)\s*quarter/.test(d)) return "1Q";
  if (/(2nd|second)\s*quarter/.test(d)) return "2Q";
  if (/(3rd|third)\s*quarter/.test(d)) return "3Q";
  if (/(4th|fourth)\s*quarter/.test(d)) return "4Q";
  if (/(1st|first)\s*5|5\s*inning/.test(d)) return "F5";
  if (/quarter/.test(d)) return "Q";
  if (/inning/.test(d)) return "INN";
  const text = String(description || "").trim();
  return text ? text.replace(/\s+/g, " ").slice(0, 7) : `P${periodNumber}`;
}

function periodTitle(description, periodNumber) {
  if (Number(periodNumber || 0) === 0) {
    return "Full game";
  }
  return description || `Period ${periodNumber}`;
}

/* Tabs for a league that has schedules on more than one period. Each shows that
 * period's schedule count; picking one filters the rows to it. A single-period
 * league gets no tabs. */
function renderSchedulePeriodTabs(container, leagueKey, league, selected) {
  container.replaceChildren();
  if (league.periods.length <= 1) {
    return;
  }
  for (const pn of league.periods) {
    const btn = document.createElement("button");
    btn.type = "button";
    btn.className = "schedule-period-btn" + (pn === selected ? " is-active" : "");
    btn.textContent = shortenPeriodLabel(league.periodLabels.get(pn), pn);
    const count = league.periodCounts.get(pn) || 0;
    btn.title = `${periodTitle(league.periodLabels.get(pn), pn)} — ${count} schedule${count === 1 ? "" : "s"}`;
    btn.addEventListener("click", (event) => {
      event.stopPropagation();
      selectedSchedulePeriod.set(leagueKey, pn);
      expandedScheduleLeagues.add(leagueKey);
      renderSchedules();
    });
    container.append(btn);
  }
}

/*
 * The Time dropdown lists the times something is actually scheduled at, so it
 * can never offer an hour that matches nothing. The current choice is kept if
 * it still exists, and reset to "any" if the schedule it belonged to has gone.
 */
function populateScheduleTimeFilter(schedules) {
  const select = elements.scheduleTimeFilter;
  if (!select) {
    return;
  }

  const times = [
    ...new Set(schedules.map(scheduleTimeOfDay).filter(Boolean)),
  ].sort();

  const chosen = select.value;
  select.replaceChildren(new Option("Any time", "all"));
  for (const time of times) {
    select.append(new Option(formatScheduleClock(time), time));
  }
  select.value = times.includes(chosen) ? chosen : "all";
}

function renderSchedules() {
  elements.scheduleRows.replaceChildren();

  const statusFilter =
    elements.scheduleStatusFilter?.value || "active";
  const dayFilter = elements.scheduleDayFilter?.value || "all";
  const timeFilter = elements.scheduleTimeFilter?.value || "all";

  const byStatus = state.schedules.filter((schedule) => {
    const isCancelled =
      String(schedule.status || "").toLowerCase() === "cancelled";

    if (statusFilter === "all") {
      return true;
    }

    if (statusFilter === "cancelled") {
      return isCancelled;
    }

    return ["pending", "running", "failed"].includes(
      String(schedule.status || "").toLowerCase()
    );
  });

  /* The time list is built from what is actually scheduled rather than a
   * fixed set of hours, so it only ever offers times that will match
   * something. Built before the day filter narrows it, or choosing a day
   * would empty the list the operator is about to pick from. */
  populateScheduleTimeFilter(byStatus);

  const schedules = byStatus.filter((schedule) => {
    if (dayFilter !== "all") {
      if (!scheduleDays(schedule).includes(Number(dayFilter))) {
        return false;
      }
    }
    if (timeFilter !== "all" && scheduleTimeOfDay(schedule) !== timeFilter) {
      return false;
    }
    return true;
  });

  /*
   * Team total is a real limit but rarely scheduled. Showing a column of
   * dashes cost width that Status and Detail needed, so it appears only when
   * something actually uses it and returns on its own the moment one is set.
   */
  const table = elements.scheduleRows.closest("table");
  if (table) {
    const showTeamTotal = schedules.some(
      (schedule) => schedule.field === "teamTotal"
    );
    table.classList.toggle("hide-team-total", !showTeamTotal);
    table.querySelector(".full-game-heading")?.setAttribute(
      "colspan", showTeamTotal ? "4" : "3"
    );
    table.querySelector(".period-heading")?.setAttribute(
      "colspan", showTeamTotal ? "4" : "3"
    );
  }

  if (!schedules.length) {
    const row = document.createElement("tr");
    const cell = document.createElement("td");

    cell.colSpan = table?.classList.contains("hide-team-total") ? 11 : 13;
    cell.className = "empty-state";
    const filtered = dayFilter !== "all" || timeFilter !== "all";
    cell.textContent = filtered
      ? "Nothing scheduled for that day and time. Clear the filters to see the rest."
      : statusFilter === "cancelled"
        ? "No cancelled schedules."
        : statusFilter === "all"
          ? "No activity yet."
          : "No active activity.";

    row.append(cell);
    elements.scheduleRows.append(row);
    return;
  }

  // Bucket raw schedules by league, noting which periods each league carries.
  // Filtering by period at the schedule level (before grouping) keeps each
  // period's entries cleanly separate - a group key does not include the
  // period, so grouping first could otherwise merge two periods into one row.
  const groupedByLeague = new Map();
  for (const schedule of schedules) {
    const leagueKey = JSON.stringify([
      schedule.idLeague,
      schedule.idSportType,
      schedule.leagueName || "",
    ]);
    let league = groupedByLeague.get(leagueKey);
    if (!league) {
      league = {
        name: schedule.leagueName || `League ${schedule.idLeague}`,
        schedules: [],
        periodLabels: new Map(),
        periodCounts: new Map(),
      };
      groupedByLeague.set(leagueKey, league);
    }
    league.schedules.push(schedule);
    const pn = Number(schedule.periodNumber || 0);
    if (!league.periodLabels.has(pn)) {
      league.periodLabels.set(pn, schedule.periodDescription || "");
    }
  }

  for (const [leagueKey, league] of groupedByLeague) {
    // Periods present, Full game (0) first, then in period order.
    league.periods = [...league.periodLabels.keys()].sort((a, b) => a - b);

    // Which period tab is showing. Default to Full game when present.
    let selected = selectedSchedulePeriod.get(leagueKey);
    if (selected == null || !league.periodLabels.has(selected)) {
      selected = league.periods.includes(0) ? 0 : league.periods[0];
    }

    // Group each period's schedules on their own, in run order, and count them
    // for the tabs.
    const periodGroups = new Map();
    for (const pn of league.periods) {
      const groups = sortScheduleGroups(
        groupSchedules(
          league.schedules.filter((s) => Number(s.periodNumber || 0) === pn)
        )
      );
      periodGroups.set(pn, groups);
      league.periodCounts.set(pn, groups.length);
    }
    const displayGroups = periodGroups.get(selected) || [];

    const leagueHeader = document.createElement("tr");
    leagueHeader.className = "schedule-league-row";
    // Keep the cell a real table cell so the colSpan holds; the flex layout
    // lives on an inner wrapper. (display:flex on the <td> itself drops its
    // table-cell behaviour, which collapsed the header into the first column.)
    const leagueHeaderCell = document.createElement("td");
    leagueHeaderCell.colSpan = table?.classList.contains("hide-team-total")
      ? 11
      : 13;
    const leagueBar = document.createElement("div");
    leagueBar.className = "schedule-league-cell";

    const leagueToggle = document.createElement("button");
    leagueToggle.type = "button";
    leagueToggle.className = "schedule-league-toggle";
    const isExpanded = expandedScheduleLeagues.has(leagueKey);
    leagueToggle.setAttribute("aria-expanded", String(isExpanded));
    const chevron = document.createElement("span");
    chevron.className = "schedule-league-chevron";
    chevron.textContent = "›";
    const leagueTitle = document.createElement("strong");
    leagueTitle.textContent = league.name;
    leagueToggle.append(chevron, leagueTitle);
    leagueToggle.addEventListener("click", () => {
      if (expandedScheduleLeagues.has(leagueKey)) {
        expandedScheduleLeagues.delete(leagueKey);
      } else {
        expandedScheduleLeagues.add(leagueKey);
      }
      renderSchedules();
    });

    /* Period tabs (FG / 1H / 2H / …), shown only when the league spans more than
     * one period. Picking one shows just that period's entries. */
    const periodBar = document.createElement("span");
    periodBar.className = "schedule-period-buttons";
    renderSchedulePeriodTabs(periodBar, leagueKey, league, selected);

    const leagueCount = document.createElement("span");
    leagueCount.className = "schedule-league-count";
    leagueCount.textContent = `${displayGroups.length} ${displayGroups.length === 1 ? "schedule" : "schedules"}`;

    leagueBar.append(leagueToggle, periodBar, leagueCount);
    leagueHeaderCell.append(leagueBar);

    leagueHeader.append(leagueHeaderCell);
    elements.scheduleRows.append(leagueHeader);

    if (!isExpanded) {
      continue;
    }

    for (const group of displayGroups) {
      const first = group[0];
    const row = document.createElement("tr");
    row.className = "activity-grid-row";

    const leagueCell = document.createElement("td");
    const leagueName = document.createElement("strong");
    leagueName.textContent = first.leagueName || `League ${first.idLeague}`;
    leagueCell.append(leagueName);
    if (first.limitMode === "early") {
      const early = document.createElement("span");
      early.className = "activity-early-badge";
      early.textContent = "Early";
      leagueCell.append(early);
    }

    row.append(leagueCell);
    for (const periodLimits of [false, true]) {
      for (const field of scheduleLimitFields) {
        row.append(createMatrixLimitCell(group, field, periodLimits));
      }
    }
    row.append(
      createTextCell(describeScheduleTiming(first)),
      createTextCell(
        first.targetScope === "all_agents" ? "All agents" : "Selected agent"
      ),
      createGroupStatusCell(group)
    );

    const detailToggleCell = document.createElement("td");
    detailToggleCell.className = "activity-row-actions";
    const rowActions = document.createElement("div");
    rowActions.className = "activity-row-actions-inner";
    if (first.activityType !== "immediate") {
      const quickEdit = document.createElement("button");
      quickEdit.type = "button";
      quickEdit.className = "schedule-edit-button";
      quickEdit.textContent = "Edit";
      quickEdit.disabled = !group.every((schedule) =>
        ["pending", "failed"].includes(
          String(schedule.status || "").toLowerCase()
        )
      );
      quickEdit.addEventListener("click", () => openScheduleEditor(group));
      rowActions.append(quickEdit);
    }
    const detailToggle = document.createElement("button");
    detailToggle.type = "button";
    detailToggle.className = "activity-detail-toggle";
    detailToggle.textContent = "View";
    detailToggle.setAttribute("aria-expanded", "false");
    rowActions.append(detailToggle);
    detailToggleCell.append(rowActions);
    row.append(detailToggleCell);
    elements.scheduleRows.append(row);

    const detailRow = document.createElement("tr");
    detailRow.className = "activity-grid-detail-row";
    detailRow.hidden = true;
    const detailCell = document.createElement("td");
    detailCell.colSpan = table?.classList.contains("hide-team-total") ? 11 : 13;
    const detailContent = document.createElement("div");
    detailContent.className = "activity-grid-detail";
    const agentName =
      first.agentName ||
      state.agents.find(
        (agent) => Number(agent.id) === Number(first.accountId)
      )?.name ||
      `Agent ${first.accountId}`;
    const metadata = [
      ["Created", formatScheduleDateTime(first.createdAtUtc || first.createdAt)],
      ["Agent", agentName],
      ["CS agent", first.customerSupportAgent || "—"],
      [
        "Next run",
        first.activityType === "immediate"
          ? "—"
          : formatScheduleDateTime(first.scheduledForUtc || first.scheduledFor),
      ],
      ["Last run", describeGroupLastRun(group)],
      ["Executed", describeGroupRuns(group)],
    ];
    for (const [label, value] of metadata) {
      const item = document.createElement("div");
      item.className = "activity-detail-item";
      const term = document.createElement("span");
      term.textContent = label;
      const description = document.createElement("strong");
      description.textContent = value || "—";
      item.append(term, description);
      detailContent.append(item);
    }

    const notes = createGroupDetailCell(group);
    notes.className = "activity-detail-notes";
    if (!notes.textContent.trim()) {
      notes.textContent = "No additional notes.";
    }
    detailContent.append(notes);
    detailToggle.addEventListener("click", () => {
      detailRow.hidden = !detailRow.hidden;
      detailToggle.textContent = detailRow.hidden ? "View" : "Hide";
      detailToggle.setAttribute("aria-expanded", String(!detailRow.hidden));
    });

    if (first.activityType === "immediate") {
      detailCell.append(detailContent);
      detailRow.append(detailCell);
      elements.scheduleRows.append(detailRow);
      continue;
    }

    const cancellable = group.filter((schedule) =>
      ["pending", "failed"].includes(schedule.status)
    );
    const deletable = group.filter(
      (schedule) => schedule.status !== "running"
    );

    const cancel = document.createElement("button");
    cancel.type = "button";
    cancel.className = "schedule-cancel schedule-cancel-button";
    cancel.textContent = "Cancel";
    cancel.disabled = !cancellable.length;

    cancel.addEventListener("click", async () => {
      cancel.disabled = true;

      const { removed, failure } = await applyToGroup(
        cancellable,
        "/api/schedules/cancel"
      );

      if (removed.length) {
        const cancelledIds = new Set(removed);
        for (const schedule of state.schedules) {
          if (cancelledIds.has(schedule.id)) {
            schedule.status = "cancelled";
          }
        }
        renderSchedules();
        renderRows();
      }

      if (failure) {
        cancel.disabled = false;
        showMessage(failure.message, "error");
        return;
      }

      showMessage(
        `Cancelled ${removed.length} scheduled ${removed.length === 1 ? "limit" : "limits"}`,
        "success"
      );
    });

    const remove = document.createElement("button");
    remove.type = "button";
    remove.className = "schedule-cancel schedule-delete-button";
    remove.textContent = "Delete";
    remove.disabled = !deletable.length;

    remove.addEventListener("click", async () => {
      const leagueName = first.leagueName || `League ${first.idLeague}`;
      const limitNames = deletable
        .map((schedule) => fieldLabels[schedule.field] || schedule.field)
        .join(", ");

      if (
        !window.confirm(
          `Delete this schedule for ${leagueName} (${limitNames})? This removes ${deletable.length === 1 ? "it" : `all ${deletable.length}`} and cannot be undone.`
        )
      ) {
        return;
      }

      remove.disabled = true;
      cancel.disabled = true;
      remove.textContent = "Deleting...";

      const { removed, failure } = await applyToGroup(
        deletable,
        "/api/schedules/delete",
        (schedule) => ({ accountId: schedule.accountId })
      );

      if (removed.length) {
        const deletedIds = new Set(removed);
        state.schedules = state.schedules.filter(
          (schedule) => !deletedIds.has(schedule.id)
        );
      }

      if (failure) {
        remove.disabled = false;
        cancel.disabled = !cancellable.length;
        remove.textContent = "Delete";
        renderSchedules();
        renderRows();
        showMessage(failure.message, "error");
        return;
      }

      renderSchedules();
      renderRows();
      showMessage(
        `Deleted ${removed.length} scheduled ${removed.length === 1 ? "limit" : "limits"}`,
        "success"
      );
    });

    rowActions.append(cancel, remove);
    detailCell.append(detailContent);
    detailRow.append(detailCell);
      elements.scheduleRows.append(detailRow);
    }
  }
}

if (elements.scheduleStatusFilter) {
  /* Changing the status can remove the times the Time filter was offering,
   * so the whole grid re-renders and the list is rebuilt with it. */
  for (const filter of [
    elements.scheduleDayFilter,
    elements.scheduleTimeFilter,
  ]) {
    filter?.addEventListener("change", () => {
      renderSchedules();
    });
  }

  elements.scheduleStatusFilter.addEventListener("change", () => {
    renderSchedules();
  });
}

if (elements.deleteAllSchedules) {
  elements.deleteAllSchedules.addEventListener("click", async () => {
    const accountId = state.selectedAgentId;

    if (!accountId) {
      showMessage("Select an agent first.", "error");
      return;
    }

    const scheduledRows = state.schedules.filter(
      (item) => item.activityType !== "immediate"
    );
    const count = scheduledRows.length;

    if (!count) {
      showMessage("There are no schedules to delete.", "error");
      return;
    }

    /*
     * Deleting the history cannot be undone, so the agent and the count are
     * both named in the prompt rather than asking a bare "are you sure".
     */
    const agentName =
      state.agents.find(
        (agent) => Number(agent.id) === Number(accountId)
      )?.name || `Account ${accountId}`;

    if (
      !window.confirm(
        `Delete all ${count} schedule${count === 1 ? "" : "s"} for ${agentName}? This cannot be undone.`
      )
    ) {
      return;
    }

    elements.deleteAllSchedules.disabled = true;
    elements.deleteAllSchedules.textContent = "Deleting...";

    try {
      const response = await fetch("/api/schedules/delete-all", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
        },
        body: JSON.stringify({ accountId }),
      });

      const data = await response.json();

      if (!response.ok) {
        throw new Error(data.error || "Could not delete the schedules");
      }

      state.schedules = state.schedules.filter(
        (item) => item.activityType === "immediate"
      );
      state.schedulesAgentId = null;
      renderSchedules();
      renderRows();
      showMessage(data.message, "success");
      // A running job survives the delete, so reload rather than trusting
      // the emptied list.
      loadSchedules().catch(() => { });
    } catch (error) {
      showMessage(error.message, "error");
    } finally {
      elements.deleteAllSchedules.disabled = false;
      elements.deleteAllSchedules.textContent = "Delete schedules";
    }
  });
}
