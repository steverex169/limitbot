/* 13-schedules-table.js
 * Activity Logs table rendering and its status-filter and delete-all
 * controls. */

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

  for (const group of groupSchedules(schedules)) {
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
    const detailToggle = document.createElement("button");
    detailToggle.type = "button";
    detailToggle.className = "activity-detail-toggle";
    detailToggle.textContent = "View";
    detailToggle.setAttribute("aria-expanded", "false");
    detailToggleCell.append(detailToggle);
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
    const action = document.createElement("div");
    action.className = "activity-detail-actions";

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
    cancel.className = "schedule-cancel";
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
    remove.className = "schedule-cancel";
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

    action.append(cancel, remove);
    detailContent.append(action);
    detailCell.append(detailContent);
    detailRow.append(detailCell);
    elements.scheduleRows.append(detailRow);
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
