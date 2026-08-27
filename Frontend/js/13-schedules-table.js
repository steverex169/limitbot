/* 13-schedules-table.js
 * Current schedules table rendering and its status-filter and delete-all
 * controls. */

const expandedScheduleLeagues = new Set();

function renderSchedules() {
  elements.scheduleRows.replaceChildren();

  const statusFilter =
    elements.scheduleStatusFilter?.value || "active";
  const schedules = state.schedules.filter((schedule) => {
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
    cell.textContent =
      statusFilter === "cancelled"
        ? "No cancelled schedules."
        : statusFilter === "all"
          ? "No activity yet."
          : "No active activity.";

    row.append(cell);
    elements.scheduleRows.append(row);
    return;
  }

  const groupedByLeague = new Map();
  for (const group of groupSchedules(schedules)) {
    const first = group[0];
    const leagueKey = JSON.stringify([
      first.idLeague,
      first.idSportType,
      first.leagueName || "",
    ]);
    const league = groupedByLeague.get(leagueKey);
    if (league) {
      league.groups.push(group);
    } else {
      groupedByLeague.set(leagueKey, {
        name: first.leagueName || `League ${first.idLeague}`,
        groups: [group],
      });
    }
  }

  /* Within a league, run order rather than the order they were created. */
  for (const league of groupedByLeague.values()) {
    league.groups = sortScheduleGroups(league.groups);
  }

  for (const [leagueKey, league] of groupedByLeague) {
    const leagueHeader = document.createElement("tr");
    leagueHeader.className = "schedule-league-row";
    const leagueHeaderCell = document.createElement("td");
    leagueHeaderCell.colSpan = table?.classList.contains("hide-team-total")
      ? 11
      : 13;
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
    const leagueCount = document.createElement("span");
    leagueCount.textContent = `${league.groups.length} ${league.groups.length === 1 ? "schedule" : "schedules"}`;
    leagueToggle.append(chevron, leagueTitle, leagueCount);
    leagueToggle.addEventListener("click", () => {
      if (expandedScheduleLeagues.has(leagueKey)) {
        expandedScheduleLeagues.delete(leagueKey);
      } else {
        expandedScheduleLeagues.add(leagueKey);
      }
      renderSchedules();
    });
    leagueHeaderCell.append(leagueToggle);
    leagueHeader.append(leagueHeaderCell);
    elements.scheduleRows.append(leagueHeader);

    if (!isExpanded) {
      continue;
    }

    for (const group of league.groups) {
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
