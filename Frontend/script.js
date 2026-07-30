const state = {
  agents: [],
  selectedAgentId: null,
  rows: [],
  filteredRows: [],
  pending: new Map(),
  schedules: [],
  periodRows: new Map(),
  expandedRows: new Set(),
  activeChange: null,
};

const pendingStorageKey = "aceshighPendingLimitEdits";
let preferenceSaveTimer = null;
let agentSearchTimer = null;
let agentSearchRequest = 0;

const elements = {
  loginView: document.querySelector("#loginView"),
  loginForm: document.querySelector("#loginForm"),
  username: document.querySelector("#username"),
  password: document.querySelector("#password"),
  loginMessage: document.querySelector("#loginMessage"),
  loginButton: document.querySelector("#loginButton"),
  dashboardHeader: document.querySelector("#dashboardHeader"),
  dashboardView: document.querySelector("#dashboardView"),
  logoutButton: document.querySelector("#logoutButton"),
  agentSelect: document.querySelector("#agentSelect"),
  agentSearch: document.querySelector("#agentSearch"),
  agentSearchResults: document.querySelector("#agentSearchResults"),
  accountName: document.querySelector("#accountName"),
  accountId: document.querySelector("#accountId"),
  rowCount: document.querySelector("#rowCount"),
  visibleCount: document.querySelector("#visibleCount"),
  pendingCount: document.querySelector("#pendingCount"),
  searchInput: document.querySelector("#searchInput"),
  rowTypeFilter: document.querySelector("#rowTypeFilter"),
  leagueRows: document.querySelector("#leagueRows"),
  message: document.querySelector("#message"),
  dialog: document.querySelector("#confirmDialog"),
  confirmTitle: document.querySelector("#confirmTitle"),
  confirmText: document.querySelector("#confirmText"),
  oldValue: document.querySelector("#oldValue"),
  newValue: document.querySelector("#newValue"),
  scheduleTime: document.querySelector("#scheduleTime"),
  confirmSchedule: document.querySelector("#confirmSchedule"),
  confirmSave: document.querySelector("#confirmSave"),
  scheduleStatusDialog: document.querySelector("#scheduleStatusDialog"),
  scheduleStatusEyebrow: document.querySelector("#scheduleStatusEyebrow"),
  scheduleStatusTitle: document.querySelector("#scheduleStatusTitle"),
  scheduleStatusText: document.querySelector("#scheduleStatusText"),
  scheduleProgress: document.querySelector("#scheduleProgress"),
  closeScheduleStatus: document.querySelector("#closeScheduleStatus"),
};

const fieldLabels = {
  spread: "Spread",
  moneyLine: "Money line",
  total: "Total",
  teamTotal: "Team total",
};

function rowKey(row) {
  return `${row.accountId}:${row.idOrganization}:${row.idLeague}:${row.idSportType}:${row.periodNumber || 0}`;
}

function inputKey(row, field) {
  return `${rowKey(row)}:${field}`;
}

function savePendingToLocalStorage() {
  const storedChanges = [...state.pending.values()].map((change) => ({
    accountId: change.row.accountId,
    idOrganization: change.row.idOrganization,
    idLeague: change.row.idLeague,
    idSportType: change.row.idSportType,
    periodNumber: change.row.periodNumber || 0,
    field: change.field,
    oldValue: change.oldValue,
    newValue: change.newValue,
  }));
  localStorage.setItem(pendingStorageKey, JSON.stringify(storedChanges));
}

function restorePendingFromLocalStorage() {
  state.pending.clear();
  let storedChanges = [];
  try {
    storedChanges = JSON.parse(localStorage.getItem(pendingStorageKey) || "[]");
  } catch {
    localStorage.removeItem(pendingStorageKey);
    return;
  }

  for (const stored of storedChanges) {
    const row = state.rows.find(
      (candidate) =>
        Number(candidate.accountId) === Number(stored.accountId) &&
        Number(candidate.idOrganization) === Number(stored.idOrganization) &&
        Number(candidate.idLeague) === Number(stored.idLeague) &&
        Number(candidate.idSportType) === Number(stored.idSportType) &&
        Number(candidate.periodNumber || 0) === Number(stored.periodNumber || 0)
    );
    if (
      !row ||
      !row.editableFields.includes(stored.field) ||
      row[stored.field] === stored.newValue
    ) {
      continue;
    }
    state.pending.set(inputKey(row, stored.field), {
      row,
      field: stored.field,
      oldValue: row[stored.field],
      newValue: stored.newValue,
    });
  }
  savePendingToLocalStorage();
}

function clearPendingChanges() {
  state.pending.clear();
  localStorage.removeItem(pendingStorageKey);
}

function showMessage(text, type = "") {
  elements.message.textContent = text;
  elements.message.className = `message ${type}`.trim();
  elements.message.hidden = false;
}

function clearMessage() {
  elements.message.hidden = true;
}

function updateCounters() {
  elements.rowCount.textContent = state.rows.length;
  elements.visibleCount.textContent = state.filteredRows.length;
  elements.pendingCount.textContent = state.pending.size;
}

function createTextCell(text) {
  const cell = document.createElement("td");
  cell.textContent = text || "—";
  return cell;
}

function createLimitCell(row, field) {
  const cell = document.createElement("td");
  const input = document.createElement("input");
  const originalValue = row[field];
  const key = inputKey(row, field);
  const pendingChange = state.pending.get(key);
  const scheduledChanges = state.schedules.filter(
    (schedule) =>
      Number(schedule.accountId) === Number(row.accountId) &&
      Number(schedule.idOrganization) === Number(row.idOrganization) &&
      Number(schedule.idLeague) === Number(row.idLeague) &&
      Number(schedule.idSportType) === Number(row.idSportType) &&
      Number(schedule.periodNumber || 0) === Number(row.periodNumber || 0) &&
      schedule.field === field
  );
  const latestSchedule = scheduledChanges.at(-1);

  input.className = "limit-input";
  input.type = "number";
  input.min = "0";
  input.step = "1";
  input.value =
    pendingChange?.newValue ??
    (["pending", "running"].includes(latestSchedule?.status)
      ? latestSchedule.value
      : originalValue) ??
    "";
  input.disabled =
    !row.editableFields.includes(field) ||
    ["pending", "running"].includes(latestSchedule?.status);
  if (pendingChange) {
    input.classList.add("changed");
  }
  if (input.disabled) {
    input.title =
      ["pending", "running"].includes(latestSchedule?.status)
        ? "This limit is locked until its scheduled change finishes"
        : row.disabledReason;
  }
  input.dataset.field = field;
  input.dataset.rowKey = rowKey(row);
  input.setAttribute("aria-label", `${fieldLabels[field]} for ${row.leagueName}`);

  input.addEventListener("input", () => {
    const typedValue = input.value === "" ? null : Number(input.value);
    if (typedValue !== null && !Number.isInteger(typedValue)) {
      return;
    }

    if (typedValue === originalValue || (typedValue === null && originalValue == null)) {
      state.pending.delete(key);
      input.classList.remove("changed");
    } else {
      state.pending.set(key, {
        row,
        field,
        oldValue: originalValue,
        newValue: typedValue,
      });
      input.classList.add("changed");
    }

    updateCounters();
    savePendingToLocalStorage();
    const saveButton = input.closest("tr").querySelector(".save-button");
    saveButton.disabled = ![...state.pending.keys()].some((pendingKey) =>
      pendingKey.startsWith(`${rowKey(row)}:`)
    );
  });

  cell.append(input);
  return cell;
}

function openConfirmation(row) {
  const changes = [...state.pending.values()].filter(
    (change) => rowKey(change.row) === rowKey(row)
  );

  if (changes.length !== 1) {
    showMessage("Change exactly one limit at a time for this league.", "error");
    return;
  }

  const change = changes[0];
  if (change.newValue === null || change.newValue < 0) {
    showMessage("Enter a valid whole-number limit before saving.", "error");
    return;
  }

  state.activeChange = change;
  elements.confirmTitle.textContent = `Update ${fieldLabels[change.field]}?`;
  elements.confirmText.textContent =
    `${row.leagueName} · Account ${row.accountId} · Organization ${row.idOrganization}`;
  elements.oldValue.textContent = change.oldValue ?? "Not set";
  elements.newValue.textContent = change.newValue.toLocaleString();
  elements.scheduleTime.value = "";
  elements.dialog.showModal();
}

function renderRows() {
  elements.leagueRows.replaceChildren();

  if (!state.filteredRows.length) {
    const row = document.createElement("tr");
    const cell = document.createElement("td");
    cell.colSpan = 7;
    cell.className = "empty-state";
    cell.textContent = "No editable leagues match the current filters.";
    row.append(cell);
    elements.leagueRows.append(row);
    updateCounters();
    return;
  }

  const displayRows = [];
  for (const row of state.filteredRows) {
    displayRows.push(row);
    if (state.expandedRows.has(rowKey(row))) {
      displayRows.push(...(state.periodRows.get(rowKey(row)) || []));
    }
  }

  for (const row of displayRows) {
    const tableRow = document.createElement("tr");
    tableRow.className = `row-level-${row.level || 0}`;

    const nameCell = document.createElement("td");
    nameCell.className = "league-name";
    if (row.hasPeriods) {
      const expandButton = document.createElement("button");
      expandButton.className = "expand-button";
      expandButton.type = "button";
      expandButton.textContent = state.expandedRows.has(rowKey(row)) ? "−" : "+";
      expandButton.setAttribute(
        "aria-label",
        `${state.expandedRows.has(rowKey(row)) ? "Collapse" : "Expand"} ${row.leagueName}`
      );
      expandButton.addEventListener("click", () => togglePeriods(row));
      nameCell.append(expandButton);
    }
    const name = document.createElement("strong");
    name.textContent = row.leagueName || row.organizationLabel || "Unnamed league";
    const ids = document.createElement("small");
    ids.textContent = `League ${row.idLeague} · Organization ${row.idOrganization}`;
    const badge = document.createElement("span");
    badge.className = "type-badge";
    badge.textContent = row.rowType;
    nameCell.append(name, ids, badge);

    tableRow.append(
      nameCell,
      createTextCell(row.periodDescription),
      createLimitCell(row, "spread"),
      createLimitCell(row, "moneyLine"),
      createLimitCell(row, "total"),
      createLimitCell(row, "teamTotal")
    );

    const actionCell = document.createElement("td");
    const saveButton = document.createElement("button");
    saveButton.className = "save-button";
    saveButton.type = "button";
    saveButton.textContent = "Save";
    saveButton.disabled = ![...state.pending.keys()].some((pendingKey) =>
      pendingKey.startsWith(`${rowKey(row)}:`)
    );
    saveButton.addEventListener("click", () => openConfirmation(row));
    actionCell.append(saveButton);
    tableRow.append(actionCell);

    elements.leagueRows.append(tableRow);
  }

  updateCounters();
}

async function togglePeriods(row) {
  const key = rowKey(row);
  if (state.expandedRows.has(key)) {
    state.expandedRows.delete(key);
    renderRows();
    return;
  }

  if (!state.periodRows.has(key)) {
    const query = new URLSearchParams({
      accountId: row.accountId,
      idOrganization: row.idOrganization,
      idLeague: row.idLeague,
    });
    const response = await fetch(`/api/periods?${query}`, { cache: "no-store" });
    const data = await response.json();
    if (!response.ok) {
      showMessage(data.error || "Could not load league periods", "error");
      return;
    }
    state.periodRows.set(key, data.rows);
  }
  state.expandedRows.add(key);
  renderRows();
}

function applyFilters() {
  const query = elements.searchInput.value.trim().toLowerCase();
  const rowType = elements.rowTypeFilter.value;

  state.filteredRows = state.rows.filter((row) => {
    const matchesType = rowType === "all" || row.rowType === rowType;
    const haystack = [
      row.leagueName,
      row.organizationLabel,
      row.periodDescription,
      row.idLeague,
      row.idOrganization,
    ]
      .join(" ")
      .toLowerCase();

    return matchesType && (!query || haystack.includes(query));
  });

  renderRows();
}

async function loadLeagues() {
  const accountId = state.selectedAgentId;
  if (!accountId) {
    return;
  }
  clearMessage();
  const query = new URLSearchParams({ accountId });
  const [response, scheduleResponse] = await Promise.all([
    fetch(`/api/leagues?${query}`, { cache: "no-store" }),
    fetch(`/api/schedules?${query}`, { cache: "no-store" }),
  ]);
  if (!response.ok || !scheduleResponse.ok) {
    throw new Error("Could not load editable leagues");
  }

  const data = await response.json();
  const scheduleData = await scheduleResponse.json();
  if (accountId !== state.selectedAgentId) {
    return;
  }
  state.rows = data.rows;
  state.schedules = scheduleData.schedules;
  state.filteredRows = data.rows;
  restorePendingFromLocalStorage();
  applyFilters();
}

async function loadAgents() {
  const response = await fetch("/api/agents", { cache: "no-store" });
  const data = await response.json();
  if (!response.ok || !data.agents?.length) {
    throw new Error(data.error || "Could not load agents");
  }

  state.agents = data.agents;
  const preferences = data.preferences || {};
  elements.accountName.textContent = data.parentName;
  elements.accountId.textContent = `Account ${data.parentId}`;
  elements.agentSelect.replaceChildren();
  for (const agent of state.agents) {
    const option = document.createElement("option");
    option.value = agent.id;
    const hierarchyIndent = "\u00a0\u00a0\u00a0".repeat(agent.depth || 0);
    const branchMarker = agent.hasChildren ? "▾ " : "\u00a0\u00a0";
    option.textContent =
      `${hierarchyIndent}${branchMarker}${agent.name} (${agent.count ?? 0})`;
    elements.agentSelect.append(option);
  }

  elements.searchInput.value = preferences.searchQuery || "";
  elements.rowTypeFilter.value = ["all", "League", "Summary"].includes(
    preferences.rowTypeFilter
  ) ? preferences.rowTypeFilter : "all";
  const defaultAgent =
    state.agents.find(
      (agent) => Number(agent.id) === Number(preferences.selectedAgentId)
    ) ||
    state.agents.find((agent) => Number(agent.id) === Number(data.parentId)) ||
    state.agents[0];
  state.selectedAgentId = Number(defaultAgent.id);
  elements.agentSelect.value = String(defaultAgent.id);
  elements.agentSelect.disabled = false;
  await loadLeagues();
}

function renderAgentSearchResults(agents) {
  elements.agentSearchResults.replaceChildren();
  if (!agents.length) {
    const empty = document.createElement("div");
    empty.className = "agent-search-empty";
    empty.textContent = "No matching agents";
    elements.agentSearchResults.append(empty);
    elements.agentSearchResults.hidden = false;
    return;
  }

  for (const agent of agents) {
    const result = document.createElement("button");
    result.type = "button";
    result.className = "agent-search-result";
    result.setAttribute("role", "option");
    const name = document.createElement("strong");
    name.textContent = agent.name;
    result.append(name);
    result.addEventListener("click", () => selectAgent(agent));
    elements.agentSearchResults.append(result);
  }
  elements.agentSearchResults.hidden = false;
}

async function searchAgents() {
  const searchValue = elements.agentSearch.value.trim();
  const requestId = ++agentSearchRequest;
  if (!searchValue) {
    elements.agentSearchResults.hidden = true;
    elements.agentSearchResults.replaceChildren();
    return;
  }

  const response = await fetch(
    `/api/agent-search?${new URLSearchParams({ q: searchValue })}`,
    { cache: "no-store" }
  );
  const data = await response.json();
  if (requestId !== agentSearchRequest) {
    return;
  }
  if (!response.ok) {
    throw new Error(data.error || "Could not search agents");
  }
  renderAgentSearchResults(data.agents || []);
}

async function selectAgent(agent) {
  state.selectedAgentId = Number(agent.id);
  if (!state.agents.some((item) => Number(item.id) === state.selectedAgentId)) {
    state.agents.push(agent);
    const option = document.createElement("option");
    option.value = agent.id;
    option.textContent = `${agent.name} (${agent.count ?? 0})`;
    elements.agentSelect.append(option);
  }
  elements.agentSelect.value = String(state.selectedAgentId);
  elements.agentSearch.value = agent.name;
  elements.agentSearchResults.hidden = true;
  savePreferences({ selectedAgentId: state.selectedAgentId }).catch(
    (error) => showMessage(error.message, "error")
  );
  state.periodRows.clear();
  state.expandedRows.clear();
  state.activeChange = null;
  elements.leagueRows.innerHTML =
    '<tr><td colspan="7" class="empty-state">Loading leagues...</td></tr>';
  try {
    await loadLeagues();
  } catch (error) {
    showMessage(error.message, "error");
  }
}

async function savePreferences(preferences) {
  const response = await fetch("/api/preferences", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(preferences),
  });
  if (!response.ok && response.status !== 401) {
    const data = await response.json();
    throw new Error(data.error || "Could not save preferences");
  }
}

function queueFilterPreferences() {
  clearTimeout(preferenceSaveTimer);
  preferenceSaveTimer = setTimeout(() => {
    savePreferences({
      searchQuery: elements.searchInput.value,
      rowTypeFilter: elements.rowTypeFilter.value,
    }).catch((error) => showMessage(error.message, "error"));
  }, 300);
}

async function refreshScheduleStatuses() {
  const accountId = state.selectedAgentId;
  if (!accountId) {
    return;
  }
  const query = new URLSearchParams({ accountId });
  const response = await fetch(`/api/schedules?${query}`, { cache: "no-store" });
  if (!response.ok) {
    return;
  }
  const data = await response.json();
  if (JSON.stringify(data.schedules) === JSON.stringify(state.schedules)) {
    return;
  }
  const previousSchedules = new Map(
    state.schedules.map((schedule) => [schedule.id, schedule])
  );
  const finishedSchedule = data.schedules.find((schedule) => {
    const previous = previousSchedules.get(schedule.id);
    return (
      ["pending", "running"].includes(previous?.status) &&
      ["completed", "failed"].includes(schedule.status)
    );
  });

  const leagueResponse = await fetch(`/api/leagues?${query}`, { cache: "no-store" });
  if (!leagueResponse.ok) {
    return;
  }
  const leagueData = await leagueResponse.json();
  if (accountId !== state.selectedAgentId) {
    return;
  }
  state.rows = leagueData.rows;
  state.schedules = data.schedules;
  restorePendingFromLocalStorage();
  applyFilters();
  if (finishedSchedule) {
    const allRows = [
      ...state.rows,
      ...[...state.periodRows.values()].flat(),
    ];
    const row = allRows.find(
      (candidate) =>
        Number(candidate.accountId) === Number(finishedSchedule.accountId) &&
        Number(candidate.idOrganization) === Number(finishedSchedule.idOrganization) &&
        Number(candidate.idLeague) === Number(finishedSchedule.idLeague) &&
        Number(candidate.idSportType) === Number(finishedSchedule.idSportType) &&
        Number(candidate.periodNumber || 0) ===
          Number(finishedSchedule.periodNumber || 0)
    );
    if (row && finishedSchedule.status === "completed") {
      row[finishedSchedule.field] = finishedSchedule.value;
      renderRows();
    }
    showScheduleStatus(
      finishedSchedule.status,
      row?.leagueName || "this league",
      finishedSchedule.value,
      finishedSchedule.scheduledFor,
      fieldLabels[finishedSchedule.field]
    );
  }
}

function showScheduleStatus(status, leagueName, value, scheduledFor, fieldLabel) {
  const successful = status === "completed";
  const failed = status === "failed";
  elements.scheduleStatusDialog.classList.toggle("status-success", successful);
  elements.scheduleStatusDialog.classList.toggle("status-error", failed);
  elements.scheduleStatusEyebrow.textContent = failed
    ? "SCHEDULE FAILED"
    : successful
      ? "SCHEDULE COMPLETED"
      : "SCHEDULED LIMIT";
  elements.scheduleStatusTitle.textContent = failed
    ? "Limit not applied"
    : successful
      ? "Limit has applied successfully"
      : "Limit change scheduled";
  elements.scheduleStatusText.textContent = successful
    ? `${leagueName} ${fieldLabel} was changed to ${Number(value).toLocaleString()} at ${scheduledFor}.`
    : failed
      ? `${leagueName} ${fieldLabel} could not be changed to ${Number(value).toLocaleString()}.`
      : `Limit change for ${leagueName} is set to ${Number(value).toLocaleString()} ${fieldLabel} and will be applied at ${scheduledFor}.`;
  elements.scheduleProgress.hidden = successful || failed;
  if (!elements.scheduleStatusDialog.open) {
    elements.scheduleStatusDialog.showModal();
  }
}

async function saveActiveChange() {
  const change = state.activeChange;
  if (!change) {
    return;
  }

  elements.confirmSave.disabled = true;
  elements.confirmSave.textContent = "Saving…";

  try {
    const response = await fetch("/api/limits", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        accountId: change.row.accountId,
        idOrganization: change.row.idOrganization,
        idLeague: change.row.idLeague,
        idSportType: change.row.idSportType,
        periodNumber: change.row.periodNumber || 0,
        field: change.field,
        value: change.newValue,
      }),
    });

    const data = await response.json();
    if (!response.ok) {
      throw new Error(data.error || "The limit could not be updated");
    }

    state.rows = data.rows;
    clearPendingChanges();
    state.activeChange = null;
    elements.dialog.close();
    applyFilters();
    showMessage(`${data.message}. New value: ${data.value.toLocaleString()}.`, "success");
  } catch (error) {
    elements.dialog.close();
    showMessage(error.message, "error");
  } finally {
    elements.confirmSave.disabled = false;
    elements.confirmSave.textContent = "Save to Aces High";
  }
}

async function scheduleActiveChange() {
  const change = state.activeChange;
  if (!change) {
    return;
  }
  if (!elements.scheduleTime.value) {
    showMessage("Select a Pakistan date and time first.", "error");
    return;
  }

  elements.confirmSchedule.disabled = true;
  elements.confirmSchedule.textContent = "Scheduling...";

  try {
    const response = await fetch("/api/schedules", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        accountId: change.row.accountId,
        idOrganization: change.row.idOrganization,
        idLeague: change.row.idLeague,
        idSportType: change.row.idSportType,
        periodNumber: change.row.periodNumber || 0,
        field: change.field,
        value: change.newValue,
        scheduledFor: elements.scheduleTime.value,
      }),
    });
    const data = await response.json();
    if (!response.ok) {
      throw new Error(data.error || "The limit could not be scheduled");
    }

    clearPendingChanges();
    state.activeChange = null;
    elements.dialog.close();
    await loadLeagues();
    showScheduleStatus(
      "pending",
      change.row.leagueName,
      change.newValue,
      data.scheduledFor,
      fieldLabels[change.field]
    );
  } catch (error) {
    elements.dialog.close();
    showMessage(error.message, "error");
  } finally {
    elements.confirmSchedule.disabled = false;
    elements.confirmSchedule.textContent = "Schedule";
  }
}

elements.searchInput.addEventListener("input", () => {
  applyFilters();
  queueFilterPreferences();
});
elements.agentSearch.addEventListener("input", () => {
  clearTimeout(agentSearchTimer);
  agentSearchTimer = setTimeout(() => {
    searchAgents().catch((error) => {
      showMessage(error.message, "error");
    });
  }, 300);
});
elements.rowTypeFilter.addEventListener("change", () => {
  applyFilters();
  queueFilterPreferences();
});
elements.agentSelect.addEventListener("change", async () => {
  const agent = state.agents.find(
    (item) => Number(item.id) === Number(elements.agentSelect.value)
  );
  if (agent) {
    await selectAgent(agent);
  }
});
elements.confirmSchedule.addEventListener("click", (event) => {
  event.preventDefault();
  scheduleActiveChange();
});
elements.confirmSave.addEventListener("click", (event) => {
  event.preventDefault();
  saveActiveChange();
});
elements.closeScheduleStatus.addEventListener("click", () => {
  elements.scheduleStatusDialog.close();
});
elements.scheduleStatusDialog.addEventListener("click", (event) => {
  if (event.target === elements.scheduleStatusDialog) {
    elements.scheduleStatusDialog.close();
  }
});
function showLogin() {
  elements.loginView.hidden = false;
  elements.dashboardHeader.hidden = true;
  elements.dashboardView.hidden = true;
  elements.password.value = "";
}

async function startDashboard() {
  elements.loginView.hidden = true;
  elements.dashboardHeader.hidden = false;
  elements.dashboardView.hidden = false;
  try {
    await loadAgents();
  } catch (error) {
    showMessage(error.message, "error");
  }
}

elements.loginForm.addEventListener("submit", async (event) => {
  event.preventDefault();
  elements.loginMessage.hidden = true;
  elements.loginButton.disabled = true;
  elements.loginButton.textContent = "Logging in...";
  try {
    const response = await fetch("/api/login", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        username: elements.username.value.trim(),
        password: elements.password.value,
      }),
    });
    const data = await response.json();
    if (!response.ok) {
      throw new Error(data.error || "Login failed");
    }
    elements.password.value = "";
    await startDashboard();
  } catch (error) {
    elements.loginMessage.textContent = error.message;
    elements.loginMessage.hidden = false;
  } finally {
    elements.loginButton.disabled = false;
    elements.loginButton.textContent = "Log in";
  }
});

elements.logoutButton.addEventListener("click", async () => {
  await fetch("/api/logout", { method: "POST" });
  state.agents = [];
  state.selectedAgentId = null;
  state.rows = [];
  clearPendingChanges();
  showLogin();
});

fetch("/api/session", { cache: "no-store" })
  .then((response) => response.ok ? startDashboard() : showLogin())
  .catch(showLogin);

setInterval(() => {
  refreshScheduleStatuses().catch(() => {});
}, 5000);
