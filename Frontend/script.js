const state = {
  agents: [],
  selectedAgentId: null,
  rows: [],
  filteredRows: [],
  pending: new Map(),
  schedules: [],
  periodRows: new Map(),
  expandedRows: new Set(),
  expandedAgentIds: new Set(),
  activeChange: null,
};

const pendingStorageKey = "aceshighPendingLimitEdits";
const themeStorageKey = "aceshighTheme";
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
  themeToggle: document.querySelector("#themeToggle"),
  agentSelectButton: document.querySelector("#agentSelectButton"),
  agentTree: document.querySelector("#agentTree"),
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
  scheduleRows: document.querySelector("#scheduleRows"),
  message: document.querySelector("#message"),
  dialog: document.querySelector("#confirmDialog"),
  confirmTitle: document.querySelector("#confirmTitle"),
  confirmText: document.querySelector("#confirmText"),
  oldValue: document.querySelector("#oldValue"),
  newValue: document.querySelector("#newValue"),
  scheduleTime: document.querySelector("#scheduleTime"),
  scheduleDays: [...document.querySelectorAll('input[name="scheduleDay"]')],
  earlyLimit: document.querySelector("#earlyLimit"),
  earlyRepeatWeekly: document.querySelector("#earlyRepeatWeekly"),
  earlyRepeatWrap: document.querySelector("#earlyRepeatWrap"),
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

function getPreferredTheme() {
  const storedTheme = localStorage.getItem(themeStorageKey);
  if (storedTheme === "light" || storedTheme === "dark") {
    return storedTheme;
  }
  return window.matchMedia("(prefers-color-scheme: dark)").matches ? "dark" : "light";
}

function applyTheme(theme) {
  const nextTheme = theme === "dark" ? "dark" : "light";
  document.documentElement.dataset.theme = nextTheme;
  document.documentElement.style.colorScheme = nextTheme;
  if (elements.themeToggle) {
    elements.themeToggle.setAttribute("aria-pressed", String(nextTheme === "dark"));
    elements.themeToggle.dataset.theme = nextTheme;
    elements.themeToggle.title = nextTheme === "dark" ? "Switch to light theme" : "Switch to dark theme";
  }
}

function toggleTheme() {
  const currentTheme = document.documentElement.dataset.theme === "dark" ? "dark" : "light";
  const nextTheme = currentTheme === "dark" ? "light" : "dark";
  localStorage.setItem(themeStorageKey, nextTheme);
  applyTheme(nextTheme);
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
  const lockingSchedule = [...scheduledChanges]
    .reverse()
    .find(
      (schedule) =>
        !schedule.recurring && ["pending", "running"].includes(schedule.status)
    );

  input.className = "limit-input";
  input.type = "number";
  input.min = "0";
  input.step = "1";
  input.value =
    pendingChange?.newValue ??
    (lockingSchedule
      ? lockingSchedule.value
      : originalValue) ??
    "";
  input.disabled =
    !row.editableFields.includes(field) ||
    Boolean(lockingSchedule);
  if (pendingChange) {
    input.classList.add("changed");
  }
  if (input.disabled) {
    input.title =
      lockingSchedule
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
  elements.scheduleDays.forEach((input) => {
    input.checked = false;
  });
  elements.earlyLimit.checked = false;
  elements.earlyRepeatWeekly.checked = false;
  elements.earlyRepeatWrap.hidden = true;
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

function renderSchedules() {
  elements.scheduleRows.replaceChildren();
  const schedules = state.schedules.filter(
    (schedule) => schedule.recurring && schedule.status !== "cancelled"
  );
  if (!schedules.length) {
    const row = document.createElement("tr");
    const cell = document.createElement("td");
    cell.colSpan = 6;
    cell.className = "empty-state";
    cell.textContent = "No recurring schedules.";
    row.append(cell);
    elements.scheduleRows.append(row);
    return;
  }

  for (const schedule of schedules) {
    const row = document.createElement("tr");
    const league = state.rows.find(
      (item) =>
        Number(item.idLeague) === Number(schedule.idLeague) &&
        Number(item.idOrganization) === Number(schedule.idOrganization)
    );
    row.append(
      createTextCell(league?.leagueName || `League ${schedule.idLeague}`),
      createTextCell(
        `${schedule.earlyLimit ? "Early limit · " : ""}${fieldLabels[schedule.field] || schedule.field}: ${Number(schedule.value).toLocaleString()}`
      ),
      createTextCell(schedule.recurrence),
      createTextCell(schedule.scheduledFor),
      createTextCell(schedule.status)
    );
    const action = document.createElement("td");
    const cancel = document.createElement("button");
    cancel.type = "button";
    cancel.className = "schedule-cancel";
    cancel.textContent = "Cancel";
    cancel.disabled = schedule.status === "running";
    cancel.addEventListener("click", async () => {
      cancel.disabled = true;
      try {
        const response = await fetch("/api/schedules/cancel", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ id: schedule.id }),
        });
        const data = await response.json();
        if (!response.ok) {
          throw new Error(data.error || "Could not cancel schedule");
        }
        state.schedules = state.schedules.filter(
          (item) => item.id !== schedule.id
        );
        renderSchedules();
        renderRows();
        showMessage(data.message, "success");
      } catch (error) {
        cancel.disabled = false;
        showMessage(error.message, "error");
      }
    });
    action.append(cancel);
    row.append(action);
    elements.scheduleRows.append(row);
  }
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
  renderSchedules();
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
  state.expandedAgentIds = new Set(
    state.agents
      .filter((agent) => Number(agent.depth || 0) === 0)
      .map((agent) => Number(agent.id))
  );
  if (elements.agentSelect) elements.agentSelect.replaceChildren();
  for (const agent of []) {
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
  updateAgentSelectorLabel(defaultAgent);
  renderAgentTree();
  elements.agentSelectButton.disabled = false;
  await loadLeagues();
}

function updateAgentSelectorLabel(agent) {
  elements.agentSelectButton.textContent = `${agent.name} (${agent.count ?? 0})`;
}

function visibleAgentRows() {
  const visible = [];
  const ancestors = [];
  for (const agent of state.agents) {
    const depth = Number(agent.depth || 0);
    ancestors.length = depth;
    const isVisible =
      depth === 0 ||
      ancestors.every((ancestor) =>
        state.expandedAgentIds.has(Number(ancestor.id))
      );
    if (isVisible) {
      visible.push(agent);
    }
    ancestors[depth] = agent;
  }
  return visible;
}

function renderAgentTree() {
  elements.agentTree.replaceChildren();
  for (const agent of visibleAgentRows()) {
    const row = document.createElement("button");
    row.type = "button";
    row.className = "agent-tree-row";
    row.setAttribute("role", "treeitem");
    row.setAttribute(
      "aria-selected",
      String(Number(agent.id) === state.selectedAgentId)
    );
    row.style.setProperty("--agent-depth", Number(agent.depth || 0));

    const toggle = document.createElement("button");
    toggle.type = "button";
    toggle.className = "agent-tree-toggle";
    toggle.textContent = agent.hasChildren
      ? state.expandedAgentIds.has(Number(agent.id))
        ? "▾"
        : "▸"
      : "";
    toggle.disabled = !agent.hasChildren;
    toggle.setAttribute(
      "aria-label",
      `${state.expandedAgentIds.has(Number(agent.id)) ? "Collapse" : "Expand"} ${agent.name}`
    );

    const name = document.createElement("span");
    name.className = "agent-tree-name";
    name.textContent = `${agent.name} (${agent.count ?? 0})`;

    row.append(toggle, name);
    toggle.addEventListener("click", (event) => {
      event.preventDefault();
      event.stopPropagation();
      const agentId = Number(agent.id);
      if (state.expandedAgentIds.has(agentId)) {
        state.expandedAgentIds.delete(agentId);
      } else {
        state.expandedAgentIds.add(agentId);
      }
      renderAgentTree();
    });
    row.addEventListener("click", async () => {
      await selectAgent(agent);
    });
    elements.agentTree.append(row);
  }
}

function renderAgentSearchResults(agents) {
  elements.agentSearchResults.replaceChildren();
  const visibleAgents = agents.filter(
    (agent) => Number(agent.id) !== state.selectedAgentId
  );
  if (!visibleAgents.length) {
    const empty = document.createElement("div");
    empty.className = "agent-search-empty";
    empty.textContent = agents.length ? "Selected agent hidden" : "No matching agents";
    elements.agentSearchResults.append(empty);
    elements.agentSearchResults.hidden = false;
    return;
  }

  for (const agent of visibleAgents) {
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
  const knownAgent = state.agents.find(
    (item) => Number(item.id) === state.selectedAgentId
  );
  const selectedAgent = knownAgent || agent;
  if (!knownAgent) {
    state.agents.push(agent);
  }
  updateAgentSelectorLabel(selectedAgent);
  renderAgentTree();
  elements.agentTree.hidden = true;
  elements.agentSearch.value = selectedAgent.name;
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
      (["pending", "running"].includes(previous?.status) &&
        ["completed", "failed"].includes(schedule.status)) ||
      (schedule.recurring &&
        previous?.lastRunAt !== schedule.lastRunAt &&
        Boolean(schedule.lastRunAt))
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
  renderSchedules();
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
      finishedSchedule.lastRunStatus || finishedSchedule.status,
      row?.leagueName || "this league",
      finishedSchedule.value,
      finishedSchedule.lastRunAt || finishedSchedule.scheduledFor,
      fieldLabels[finishedSchedule.field],
      finishedSchedule.recurrence,
      finishedSchedule.scheduledFor
    );
  }
}

function showScheduleStatus(
  status,
  leagueName,
  value,
  scheduledFor,
  fieldLabel,
  recurrence = null,
  nextRun = null
) {
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
    ? `${leagueName} ${fieldLabel} was changed to ${Number(value).toLocaleString()} at ${scheduledFor}.${nextRun ? ` Next run: ${nextRun}.` : ""}`
    : failed
      ? `${leagueName} ${fieldLabel} could not be changed to ${Number(value).toLocaleString()}.${nextRun ? ` It will retry at the next scheduled run: ${nextRun}.` : ""}`
      : `Limit change for ${leagueName} is set to ${Number(value).toLocaleString()} ${fieldLabel}. ${recurrence || `It will be applied at ${scheduledFor}`}. Next run: ${nextRun || scheduledFor}.`;
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
  const recurrenceDays = elements.scheduleDays
    .filter((input) => input.checked)
    .map((input) => Number(input.value));
  if (!elements.scheduleTime.value) {
    showMessage("Select an Eastern time first.", "error");
    return;
  }
  if (!recurrenceDays.length) {
    showMessage("Select at least one weekday.", "error");
    return;
  }
  const earlyLimit = elements.earlyLimit.checked;
  const repeatWeekly = !earlyLimit || elements.earlyRepeatWeekly.checked;
  if (earlyLimit) {
    const [hour = 0, minute = 0] = elements.scheduleTime.value
      .split(":")
      .map((part) => Number(part));
    if (hour < 8 || hour > 11 || (hour === 11 && minute > 0)) {
      showMessage("Early limit time must be between 8:00 AM and 11:00 AM ET.", "error");
      return;
    }
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
        recurrenceDays,
        recurrenceTime: elements.scheduleTime.value,
        earlyLimit,
        repeatWeekly,
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
      fieldLabels[change.field],
      data.recurrence,
      data.scheduledFor
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
elements.agentSelectButton.addEventListener("click", () => {
  elements.agentTree.hidden = !elements.agentTree.hidden;
});
document.addEventListener("click", (event) => {
  if (
    !elements.agentTree.hidden &&
    !event.target.closest(".agent-selector")
  ) {
    elements.agentTree.hidden = true;
  }
});
document.addEventListener("keydown", (event) => {
  if (event.key === "Escape") {
    elements.agentTree.hidden = true;
    elements.agentSearchResults.hidden = true;
  }
});
elements.confirmSchedule.addEventListener("click", (event) => {
  event.preventDefault();
  scheduleActiveChange();
});
elements.earlyLimit.addEventListener("change", () => {
  elements.earlyRepeatWrap.hidden = !elements.earlyLimit.checked;
  if (!elements.earlyLimit.checked) {
    elements.earlyRepeatWeekly.checked = false;
  }
});
elements.confirmSave.addEventListener("click", (event) => {
  event.preventDefault();
  saveActiveChange();
});
elements.closeScheduleStatus.addEventListener("click", () => {
  elements.scheduleStatusDialog.close();
});
elements.themeToggle?.addEventListener("click", toggleTheme);
elements.scheduleStatusDialog.addEventListener("click", (event) => {
  if (event.target === elements.scheduleStatusDialog) {
    elements.scheduleStatusDialog.close();
  }
});

applyTheme(getPreferredTheme());
function showLogin() {
  document.body.classList.remove("app-loading");
  elements.loginView.hidden = false;
  elements.dashboardHeader.hidden = true;
  elements.dashboardView.hidden = true;
  elements.password.value = "";
}

async function startDashboard() {
  document.body.classList.remove("app-loading");
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
  state.expandedAgentIds.clear();
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
