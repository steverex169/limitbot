/* 18-schedule-edit.js
 * Edits an existing grouped schedule without changing its destination. */

let editingScheduleGroup = [];

function showScheduleEditMessage(message = "") {
  if (!elements.scheduleEditMessage) {
    return;
  }
  elements.scheduleEditMessage.textContent = message;
  elements.scheduleEditMessage.hidden = !message;
}

function syncScheduleEditAllDays() {
  const selected = elements.scheduleEditDays.filter((day) => day.checked).length;
  elements.scheduleEditAllDays.checked = selected === 7;
  elements.scheduleEditAllDays.indeterminate = selected > 0 && selected < 7;
}

function scheduleEditLimitLabel(schedule) {
  const period = Number(schedule.periodNumber || 0)
    ? `Period ${schedule.periodNumber}`
    : "Full game";
  const field = fieldLabels[schedule.field] || schedule.field;
  return `${period} · ${field}${schedule.limitMode === "early" ? " · Early" : ""}`;
}

function openScheduleEditor(group) {
  if (!elements.scheduleEditDialog || !Array.isArray(group) || !group.length) {
    return;
  }
  if (group.some((schedule) =>
    schedule.activityType === "immediate" ||
    !["pending", "failed"].includes(String(schedule.status || "").toLowerCase())
  )) {
    showMessage("Only pending or failed schedules can be edited.", "error");
    return;
  }

  editingScheduleGroup = [...group];
  const first = group[0];
  const scope = first.targetScope === "all_agents"
    ? "All agents"
    : first.agentName || `Agent ${first.accountId}`;
  elements.scheduleEditSummary.textContent =
    `${first.leagueName || `League ${first.idLeague}`} · ${scope}. The destination and league stay fixed.`;
  elements.scheduleEditValues.replaceChildren();

  /*
   * Every limit type, not only the ones the schedule already carries. Showing
   * just the existing rows meant a schedule saved without a Total could never
   * gain one - the field to type it into did not exist. A blank row is simply
   * not scheduled; filling it in creates it.
   */
  const scheduledByField = new Map(
    group.map((schedule) => [schedule.field, schedule])
  );
  for (const field of ["spread", "moneyLine", "total", "teamTotal"]) {
    const schedule = scheduledByField.get(field);
    const row = document.createElement("label");
    row.className = "schedule-edit-value";
    const label = document.createElement("span");
    label.textContent = scheduleEditLimitLabel(schedule || { ...first, field });
    const input = document.createElement("input");
    input.type = "number";
    input.min = "0";
    input.max = "1000000000";
    input.step = "1";
    input.placeholder = schedule ? "" : "Not scheduled";
    input.value = schedule ? String(schedule.value) : "";
    if (schedule) {
      input.dataset.scheduleId = schedule.id;
    } else {
      input.dataset.scheduleField = field;
      row.classList.add("schedule-edit-value-empty");
    }
    input.setAttribute("aria-label", label.textContent);
    row.append(label, input);
    elements.scheduleEditValues.append(row);
  }

  elements.scheduleEditAgent.value = first.customerSupportAgent || "";
  elements.scheduleEditTime.value =
    first.recurrenceTime || first.scheduledTimeEt || "";
  const selectedDays = new Set((first.recurrenceDays || []).map(Number));
  for (const day of elements.scheduleEditDays) {
    day.checked = selectedDays.has(Number(day.value));
  }
  syncScheduleEditAllDays();
  showScheduleEditMessage();
  elements.scheduleEditDialog.showModal();
}

elements.scheduleEditAllDays?.addEventListener("change", () => {
  for (const day of elements.scheduleEditDays) {
    day.checked = elements.scheduleEditAllDays.checked;
  }
  syncScheduleEditAllDays();
});

for (const day of elements.scheduleEditDays) {
  day.addEventListener("change", syncScheduleEditAllDays);
}

elements.scheduleEditCancel?.addEventListener("click", () => {
  elements.scheduleEditDialog.close();
});

elements.scheduleEditForm?.addEventListener("submit", async (event) => {
  event.preventDefault();
  showScheduleEditMessage();

  const customerSupportAgent = elements.scheduleEditAgent.value.trim();
  const recurrenceTime = elements.scheduleEditTime.value;
  const valueInputs = [
    ...elements.scheduleEditValues.querySelectorAll('input[type="number"]'),
  ];
  /* A row with an id is updated; one left blank is skipped; one filled in
   * without an id is a limit type being added to this schedule. */
  const changes = valueInputs
    .filter((input) => input.dataset.scheduleId)
    .map((input) => ({
      id: input.dataset.scheduleId,
      value: Number(input.value),
    }));
  const additions = valueInputs
    .filter(
      (input) => !input.dataset.scheduleId && input.value.trim() !== ""
    )
    .map((input) => ({
      field: input.dataset.scheduleField,
      value: Number(input.value),
    }));

  if (!customerSupportAgent) {
    showScheduleEditMessage("Enter the Customer Support Agent name.");
    elements.scheduleEditAgent.focus();
    return;
  }
  if (!recurrenceTime) {
    showScheduleEditMessage("Select the time in U.S. Eastern time.");
    elements.scheduleEditTime.focus();
    return;
  }
  if ([...changes, ...additions].some((change) =>
    !Number.isInteger(change.value) || change.value < 0 || change.value > 1000000000
  )) {
    showScheduleEditMessage("Enter a valid whole-number limit for every row you fill in.");
    return;
  }
  if (!changes.length && !additions.length) {
    showScheduleEditMessage("Enter at least one limit.");
    return;
  }

  elements.scheduleEditSave.disabled = true;
  elements.scheduleEditSave.textContent = "Saving…";
  try {
    const response = await fetch("/api/schedules/edit", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        changes,
        additions,
        customerSupportAgent,
        recurrenceTime,
        recurrenceDays: elements.scheduleEditDays
          .filter((day) => day.checked)
          .map((day) => Number(day.value)),
      }),
    });
    const result = await response.json();
    if (!response.ok) {
      throw new Error(result.error || "The schedule could not be updated");
    }

    elements.scheduleEditDialog.close();
    editingScheduleGroup = [];
    state.schedulesAgentId = null;
    await loadSchedules(true);
    showMessage(result.message || "Schedule updated", "success");
  } catch (error) {
    showScheduleEditMessage(error.message);
  } finally {
    elements.scheduleEditSave.disabled = false;
    elements.scheduleEditSave.textContent = "Save schedule";
  }
});
