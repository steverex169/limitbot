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

    return !isCancelled;
  });

  /*
   * Team total is a real limit but rarely scheduled. Showing a column of
   * dashes cost width that Status and Detail needed, so it appears only when
   * something actually uses it and returns on its own the moment one is set.
   */
  const table = elements.scheduleRows.closest("table");
  if (table) {
    table.classList.toggle(
      "hide-team-total",
      !schedules.some((schedule) => schedule.field === "teamTotal")
    );
  }

  if (!schedules.length) {
    const row = document.createElement("tr");
    const cell = document.createElement("td");

    cell.colSpan = 15;
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
    const byField = new Map(
      group.map((schedule) => [schedule.field, schedule])
    );

    row.append(
      createTextCell(
        formatScheduleDateTime(first.createdAtUtc || first.createdAt)
      ),
      createTextCell(
        first.agentName ||
        state.agents.find(
          (agent) => Number(agent.id) === Number(first.accountId)
        )?.name ||
        `Agent ${first.accountId}`
      ),
      createTextCell(first.customerSupportAgent),
      createTextCell(first.leagueName || `League ${first.idLeague}`),
      createTextCell(
        `${describeSchedulePeriod(first)}${first.limitMode === "early" ? " (Early)" : ""}`
      )
    );

    for (const field of scheduleLimitFields) {
      row.append(createLimitValueCell(byField.get(field), field));
    }

    row.append(
      createTextCell(
        first.activityType === "immediate"
          ? "Immediate"
          : first.recurrence || "One time"
      ),
      createTextCell(
        first.activityType === "immediate"
          ? "—"
          : formatScheduleDateTime(first.scheduledForUtc || first.scheduledFor)
      ),
      createTextCell(describeGroupLastRun(group)),
      createGroupStatusCell(group),
      createGroupDetailCell(group)
    );

    const action = document.createElement("td");
    if (first.activityType === "immediate") {
      action.textContent = "—";
      action.className = "schedule-limit-empty";
      row.append(action);
      elements.scheduleRows.append(row);
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
    remove.style.marginLeft = "6px";

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
    row.append(action);
    elements.scheduleRows.append(row);
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
