const state = {
  agents: [],
  selectedAgentId: null,
  rows: [],
  filteredRows: [],
  pending: new Map(),
  pendingSaveBatch: [],
  schedules: [],
  schedulesAgentId: null,
  periodRows: new Map(),
  expandedRows: new Set(),
  expandedAgentIds: new Set(),
  activeChange: null,
  comparison: null,
  comparisonAgentId: null,
  comparisonLoading: false,
  comparisonRequest: 0,
};

const pendingStorageKey = "aceshighPendingLimitEdits";
const themeStorageKey = "aceshighTheme";
let preferenceSaveTimer = null;
let agentSearchTimer = null;
let agentSearchRequest = 0;
/*
 * Monotonic token for every write to state.rows. An async flow captures the
 * token before fetching and discards its response if another write happened
 * meanwhile, so a slow poll can never overwrite fresher data.
 */
let leagueDataVersion = 0;

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
  dashboardSidebar: document.querySelector("#dashboardSidebar"),
  activityLogsLink: document.querySelector("#activityLogsLink"),
  pinnacleComparisonLink: document.querySelector("#pinnacleComparisonLink"),
  dashboardSummary: document.querySelector("#dashboardSummary"),
  limitsPanel: document.querySelector("#limitsPanel"),
  activityLogsView: document.querySelector("#activityLogsView"),
  pinnacleComparisonView: document.querySelector("#pinnacleComparisonView"),
  comparisonRefresh: document.querySelector("#comparisonRefresh"),
  comparisonMessage: document.querySelector("#comparisonMessage"),
  comparisonFixtureCount: document.querySelector("#comparisonFixtureCount"),
  comparisonSectionCount: document.querySelector("#comparisonSectionCount"),
  comparisonGeneratedAt: document.querySelector("#comparisonGeneratedAt"),
  comparisonProfiles: document.querySelector("#comparisonProfiles"),
  comparisonContent: document.querySelector("#comparisonContent"),
  limitFilter: document.querySelector("#limitFilter"),
  limitModeFilter: document.querySelector("#limitModeFilter"),
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
  scheduleHour: document.querySelector("#scheduleHour"),
  scheduleMinute: document.querySelector("#scheduleMinute"),
  schedulePeriod: document.querySelector("#schedulePeriod"),
  customerSupportAgent: document.querySelector("#customerSupportAgent"),
  clearScheduleOptions: document.querySelector("#clearScheduleOptions"),
  scheduleDays: [
    ...document.querySelectorAll('input[name="scheduleDay"]'),
  ],
  dialogMessage: document.querySelector("#dialogMessage"),
  confirmSchedule: document.querySelector("#confirmSchedule"),
  confirmSave: document.querySelector("#confirmSave"),
  scheduleStatusDialog: document.querySelector("#scheduleStatusDialog"),
  scheduleStatusEyebrow: document.querySelector("#scheduleStatusEyebrow"),
  scheduleStatusTitle: document.querySelector("#scheduleStatusTitle"),
  scheduleStatusText: document.querySelector("#scheduleStatusText"),
  scheduleProgress: document.querySelector("#scheduleProgress"),
  closeScheduleStatus: document.querySelector("#closeScheduleStatus"),
};

function isActivityLogsRoute() {
  const normalizedPath =
    window.location.pathname.replace(/\/+$/, "") || "/";

  return normalizedPath === "/activity_logs";
}

function isPinnacleComparisonRoute() {
  const normalizedPath =
    window.location.pathname.replace(/\/+$/, "") || "/";

  return normalizedPath === "/pinnacle_aceshigh";
}

function applyDashboardRoute() {
  const activityLogsActive = isActivityLogsRoute();
  const comparisonActive = isPinnacleComparisonRoute();
  const dashboardActive = !activityLogsActive && !comparisonActive;

  if (elements.dashboardSummary) {
    elements.dashboardSummary.hidden = !dashboardActive;
  }

  if (elements.limitsPanel) {
    elements.limitsPanel.hidden = !dashboardActive;
  }

  if (elements.pinnacleComparisonView) {
    elements.pinnacleComparisonView.hidden = !comparisonActive;
    elements.pinnacleComparisonView.setAttribute(
      "aria-hidden",
      String(!comparisonActive)
    );
  }

  if (elements.activityLogsView) {
    elements.activityLogsView.hidden = !activityLogsActive;
    elements.activityLogsView.setAttribute(
      "aria-hidden",
      String(!activityLogsActive)
    );
  }

  if (elements.activityLogsLink) {
    elements.activityLogsLink.classList.toggle(
      "active",
      activityLogsActive
    );

    if (activityLogsActive) {
      elements.activityLogsLink.setAttribute(
        "aria-current",
        "page"
      );
    } else {
      elements.activityLogsLink.removeAttribute(
        "aria-current"
      );
    }
  }

  if (elements.pinnacleComparisonLink) {
    elements.pinnacleComparisonLink.classList.toggle(
      "active",
      comparisonActive
    );

    if (comparisonActive) {
      elements.pinnacleComparisonLink.setAttribute(
        "aria-current",
        "page"
      );
    } else {
      elements.pinnacleComparisonLink.removeAttribute(
        "aria-current"
      );
    }
  }

  if (activityLogsActive) {
    renderSchedules();
    if (state.selectedAgentId) {
      loadSchedules().catch(() => { });
    }
  }

  if (comparisonActive && state.selectedAgentId) {
    loadPinnacleComparison().catch(() => { });
  }
}

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

function renderComparisonProfiles(data) {
  elements.comparisonProfiles.replaceChildren();
  const marketLabels = {
    moneyline: "Moneyline",
    spread: "Spread",
    total: "Total",
    teamtotal: "Team total",
  };

  Object.entries(data.configuredLimits || {}).forEach(([period, limits]) => {
    const card = document.createElement("article");
    card.className = "comparison-profile-card";
    const heading = document.createElement("h3");
    heading.textContent = `AcesHigh ${period} limits`;
    card.append(heading);

    const list = document.createElement("dl");
    Object.entries(marketLabels).forEach(([key, label]) => {
      const item = document.createElement("div");
      const term = document.createElement("dt");
      const value = document.createElement("dd");
      term.textContent = label;
      value.textContent = formatComparisonLimit(limits?.[key], "USD");
      item.append(term, value);
      list.append(item);
    });
    card.append(list);
    elements.comparisonProfiles.append(card);
  });
}

function renderPinnacleComparison(data) {
  state.comparison = data;
  elements.comparisonFixtureCount.textContent =
    comparisonText(data.matchedFixtureCount, "0");
  elements.comparisonSectionCount.textContent =
    comparisonText(data.sectionCount, "0");

  const generated = new Date(data.generatedAt);
  elements.comparisonGeneratedAt.textContent = Number.isNaN(generated.valueOf())
    ? "—"
    : generated.toLocaleString([], {
        month: "short",
        day: "numeric",
        hour: "numeric",
        minute: "2-digit",
      });

  renderComparisonProfiles(data);
  elements.comparisonContent.replaceChildren();

  if (!data.comparisons?.length) {
    const empty = document.createElement("p");
    empty.className = "comparison-empty";
    empty.textContent =
      "No current MLB fixtures could be mapped between AcesHigh and Pinnacle.";
    elements.comparisonContent.append(empty);
    return;
  }

  data.comparisons.forEach((section) => {
    const card = document.createElement("article");
    card.className = "comparison-card";

    const header = document.createElement("header");
    const titleWrap = document.createElement("div");
    const title = document.createElement("h3");
    title.textContent = comparisonText(section.fixture, "MLB fixture");
    const meta = document.createElement("p");
    const start = new Date(section.startTimeUtc);
    meta.textContent = Number.isNaN(start.valueOf())
      ? `AcesHigh game ${comparisonText(section.acesHighGameNumber)}`
      : `${start.toLocaleString([], {
          weekday: "short",
          hour: "numeric",
          minute: "2-digit",
        })} · AcesHigh game ${comparisonText(section.acesHighGameNumber)}`;
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
      "AcesHigh line",
      "AcesHigh odds",
      "Our limit",
      "Pinnacle line",
      "Pinnacle odds",
      "Pinnacle limit",
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
      const ourLimit = Number(row.acesHigh?.limit);
      const pinnacleLimit = Number(row.pinnacle?.limit);
      let ourLimitClass = "comparison-limit";
      let pinnacleLimitClass = "comparison-limit";
      if (Number.isFinite(ourLimit) && Number.isFinite(pinnacleLimit)) {
        if (ourLimit > pinnacleLimit) {
          ourLimitClass += " comparison-limit-higher";
        } else if (pinnacleLimit > ourLimit) {
          pinnacleLimitClass += " comparison-limit-higher";
        }
      }
      tr.append(
        comparisonCell(comparisonText(row.market)),
        comparisonCell(comparisonText(row.selection), "comparison-selection"),
        comparisonCell(formatComparisonLine(row.acesHigh?.line)),
        comparisonCell(formatAmericanOdds(row.acesHigh?.oddsAmerican)),
        comparisonCell(formatComparisonLimit(row.acesHigh?.limit), ourLimitClass),
        comparisonCell(formatComparisonLine(row.pinnacle?.line)),
        comparisonCell(formatAmericanOdds(row.pinnacle?.oddsAmerican)),
        comparisonCell(
          formatComparisonLimit(
            row.pinnacle?.limit,
            data.pinnacleLimitCurrency || "USD"
          ),
          pinnacleLimitClass
        )
      );
      body.append(tr);
    });
    table.append(body);
    wrap.append(table);
    card.append(wrap);
    elements.comparisonContent.append(card);
  });
}

function setComparisonMessage(message = "", type = "") {
  elements.comparisonMessage.textContent = message;
  elements.comparisonMessage.className = `message comparison-message ${type}`.trim();
  elements.comparisonMessage.hidden = !message;
}

async function loadPinnacleComparison(force = false) {
  if (!state.selectedAgentId || state.comparisonLoading) {
    return;
  }
  if (
    !force &&
    state.comparison &&
    Number(state.comparisonAgentId) === Number(state.selectedAgentId)
  ) {
    renderPinnacleComparison(state.comparison);
    return;
  }

  const requestId = ++state.comparisonRequest;
  const accountId = state.selectedAgentId;
  state.comparisonLoading = true;
  elements.comparisonRefresh.disabled = true;
  elements.comparisonRefresh.textContent = "Refreshing...";
  setComparisonMessage("Loading current MLB lines and limits...");

  try {
    const params = new URLSearchParams({ accountId: String(accountId) });
    if (force) {
      params.set("refresh", "true");
    }
    const response = await fetch(`/api/pinnacle-comparison?${params}`, {
      cache: "no-store",
    });
    const data = await response.json();
    if (!response.ok) {
      throw new Error(data.error || "Could not load the MLB comparison");
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

const fieldLabels = {
  spread: "Spread",
  moneyLine: "Money line",
  total: "Total",
  teamTotal: "Team total",
};

const fieldApiNames = {
  spread: "Spread",
  moneyLine: "MoneyLine",
  total: "Total",
  teamTotal: "TeamTotal",
};

function getSelectedLimitMode() {
  return elements.limitModeFilter?.value === "early"
    ? "early"
    : "normal";
}

function getModeFieldKey(field, mode = getSelectedLimitMode()) {
  const apiName = fieldApiNames[field] || field;
  return mode === "early" ? `early${apiName}` : field;
}

function getModeFieldValue(row, field, mode = getSelectedLimitMode()) {
  const modeKey = getModeFieldKey(field, mode);

  // Normal and Early limits are independent values. Never fall back from an
  // Early field to the Normal field, otherwise a Normal change can appear in
  // the Early-limits view even though the Early value was never changed.
  if (mode === "early") {
    return row?.[modeKey] ?? null;
  }

  return row?.[field] ?? null;
}

function rowSupportsEarlyMode(row) {
  return row?.supportsEarlyLimit === true;
}

function getPendingChangesForMode(mode) {
  return [...state.pending.values()].filter(
    (change) => (change.mode || "normal") === mode
  );
}

const easternDateTimeFormatter = new Intl.DateTimeFormat(
  "en-US",
  {
    timeZone: "America/New_York",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    hour12: true,
    timeZoneName: "short",
  }
);

function formatEasternDateTime(value) {
  if (!value) {
    return "";
  }

  if (
    typeof value === "string" &&
    /(?:\bET\b|\bEST\b|\bEDT\b)/.test(value)
  ) {
    return value;
  }

  const parsed = new Date(value);

  if (Number.isNaN(parsed.getTime())) {
    return String(value);
  }

  return easternDateTimeFormatter
    .format(parsed)
    .replace(", ", " ");
}

const easternTimeFormatter = new Intl.DateTimeFormat(
  "en-US",
  {
    timeZone: "America/New_York",
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
  }
);

function getEasternTimeValue(date = new Date()) {
  const parts = easternTimeFormatter.formatToParts(date);
  const hourPart = parts.find((part) => part.type === "hour")?.value || "00";
  const minutePart = parts.find((part) => part.type === "minute")?.value || "00";

  return `${String(Number(hourPart)).padStart(2, "0")}:${String(Number(minutePart)).padStart(2, "0")}`;
}

function populateScheduleTimePicker() {
  if (elements.scheduleHour?.options.length === 1) {
    for (let hour = 1; hour <= 12; hour += 1) {
      const option = document.createElement("option");
      option.value = String(hour).padStart(2, "0");
      option.textContent = String(hour).padStart(2, "0");
      elements.scheduleHour.append(option);
    }
  }

  if (elements.scheduleMinute?.options.length === 1) {
    for (let minute = 0; minute < 60; minute += 1) {
      const option = document.createElement("option");
      option.value = String(minute).padStart(2, "0");
      option.textContent = String(minute).padStart(2, "0");
      elements.scheduleMinute.append(option);
    }
  }
}

function getSelectedScheduleTime() {
  const hour = elements.scheduleHour?.value || "";
  const minute = elements.scheduleMinute?.value || "";
  const period = elements.schedulePeriod?.value || "";

  if (!hour || !minute || !period) {
    return "";
  }

  let hourNumber = Number(hour);

  if (period === "AM") {
    hourNumber = hourNumber === 12 ? 0 : hourNumber;
  } else {
    hourNumber = hourNumber === 12 ? 12 : hourNumber + 12;
  }

  return `${String(hourNumber).padStart(2, "0")}:${minute}`;
}

populateScheduleTimePicker();

function clearScheduleOptions() {
  elements.scheduleDays.forEach((input) => {
    input.checked = false;
  });

  if (elements.scheduleHour) {
    elements.scheduleHour.value = "";
  }

  if (elements.scheduleMinute) {
    elements.scheduleMinute.value = "";
  }

  if (elements.schedulePeriod) {
    elements.schedulePeriod.value = "";
  }

  if (elements.customerSupportAgent) {
    elements.customerSupportAgent.value = "";
  }

  clearDialogMessage();
}

function rowKey(row) {
  return `${row.accountId}:${row.idOrganization}:${row.idLeague}:${row.idSportType}:${row.periodNumber || 0}`;
}

function inputKey(row, field) {
  return `${rowKey(row)}:${getSelectedLimitMode()}:${field}`;
}

function normalizeLimitKey(value) {
  return String(value || "")
    .trim()
    .toUpperCase()
    .replace(/[–—]/g, "-")
    .replace(/\s+/g, " ");
}

function getRowDisplayName(row) {
  return String(
    row?.leagueName ||
    row?.organizationLabel ||
    row?.name ||
    row?.league ||
    ""
  ).trim();
}

function getExplicitParentLimit(row) {
  const possibleValues = [
    row?.parentCategory,
    row?.limitGroup,
    row?.parentName,
    row?.groupName,
    row?.categoryName,
    row?.profileName,
  ];

  for (const value of possibleValues) {
    const label = String(value || "").trim();

    if (label) {
      return label;
    }
  }

  return "";
}

function isParentLimitRow(row) {
  const label = getRowDisplayName(row);

  if (!label) {
    return false;
  }

  const normalizedLabel = normalizeLimitKey(label);

  if (normalizedLabel === "OTHER") {
    return false;
  }

  /*
   * The API uses Summary rows for the main parent limits:
   * BIG SIX, MID-LEVEL, MINOR and NOVELTY.
   */
  if (normalizeLimitKey(row?.rowType) === "SUMMARY") {
    return true;
  }

  /*
   * Fallback for an API response where rowType is unavailable.
   * League rows such as "Pro Football -- Full Game" are excluded.
   */
  const markedAsParent =
    row?.isParentHeader === true ||
    row?.isParentHeader === 1 ||
    row?.isParentHeader === "true";

  const isTopLevel =
    row?.level === undefined ||
    row?.level === null ||
    row?.level === "" ||
    Number(row.level) === 0;

  return markedAsParent && isTopLevel && !label.includes("--");
}

function populateLimitDropdown(rows, selectedValue = "") {
  if (!elements.limitFilter) {
    return;
  }

  const sourceRows = Array.isArray(rows) ? rows : [];
  const parentLimitMap = new Map();

  /*
   * Build the dropdown dynamically from parent Summary rows only.
   * Normal leagues will not be added to the Select Limit dropdown.
   */
  for (const row of sourceRows) {
    if (!isParentLimitRow(row)) {
      continue;
    }

    const label = getRowDisplayName(row);
    const key = normalizeLimitKey(label);

    if (!key || key === "OTHER") {
      continue;
    }

    if (!parentLimitMap.has(key)) {
      parentLimitMap.set(key, label);
    }
  }

  elements.limitFilter.replaceChildren();

  const placeholder = document.createElement("option");
  placeholder.value = "";
  placeholder.textContent = "Select League";
  elements.limitFilter.append(placeholder);

  for (const [key, label] of parentLimitMap) {
    const option = document.createElement("option");
    option.value = key;
    option.textContent = label;
    elements.limitFilter.append(option);
  }

  /*
   * Preserve the selected parent limit when the user
   * changes the selected agent.
   */
  const selectedKey = normalizeLimitKey(selectedValue);

  elements.limitFilter.value = parentLimitMap.has(selectedKey)
    ? selectedKey
    : "";
}

function readStoredPendingChanges() {
  try {
    const stored = JSON.parse(
      localStorage.getItem(pendingStorageKey) || "[]"
    );
    return Array.isArray(stored) ? stored : [];
  } catch {
    localStorage.removeItem(pendingStorageKey);
    return [];
  }
}

function savePendingToLocalStorage() {
  /*
   * Keep stored edits that belong to other agents: only this agent's rows
   * are in memory, so overwriting storage with state.pending alone would
   * silently delete every other agent's unsaved edits.
   */
  const otherAgentChanges = readStoredPendingChanges().filter(
    (stored) =>
      Number(stored.accountId) !== Number(state.selectedAgentId)
  );

  const currentChanges = [...state.pending.values()].map((change) => ({
    accountId: change.row.accountId,
    idOrganization: change.row.idOrganization,
    idLeague: change.row.idLeague,
    idSportType: change.row.idSportType,
    periodNumber: change.row.periodNumber || 0,
    mode: change.mode || "normal",
    field: change.field,
    oldValue: change.oldValue,
    newValue: change.newValue,
    isParentRow: change.isParentRow || isParentLimitRow(change.row), // Store parent flag
  }));

  localStorage.setItem(
    pendingStorageKey,
    JSON.stringify([...otherAgentChanges, ...currentChanges])
  );
}

function restorePendingFromLocalStorage() {
  state.pending.clear();

  for (const stored of readStoredPendingChanges()) {
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
      !Array.isArray(row.editableFields) ||
      !row.editableFields.includes(stored.field) ||
      getModeFieldValue(row, stored.field, stored.mode || "normal") === stored.newValue
    ) {
      continue;
    }

    const mode = stored.mode || "normal";

    state.pending.set(`${rowKey(row)}:${mode}:${stored.field}`, {
      row,
      mode,
      field: stored.field,
      oldValue: getModeFieldValue(row, stored.field, mode),
      newValue: stored.newValue,
      isParentRow: stored.isParentRow || false,
    });
  }

  savePendingToLocalStorage();
}

function clearPendingChanges() {
  state.pending.clear();
  localStorage.removeItem(pendingStorageKey);
}

function removePendingChange(change) {
  state.pending.delete(
    `${rowKey(change.row)}:${change.mode || "normal"}:${change.field}`
  );
  savePendingToLocalStorage();
  updateCounters();
}

function getPreferredTheme() {
  const storedTheme = localStorage.getItem(themeStorageKey);

  if (storedTheme === "light" || storedTheme === "dark") {
    return storedTheme;
  }

  return window.matchMedia("(prefers-color-scheme: dark)").matches
    ? "dark"
    : "light";
}

function applyTheme(theme) {
  const nextTheme = theme === "dark" ? "dark" : "light";

  document.documentElement.dataset.theme = nextTheme;
  document.documentElement.style.colorScheme = nextTheme;

  if (elements.themeToggle) {
    elements.themeToggle.setAttribute(
      "aria-pressed",
      String(nextTheme === "dark")
    );

    elements.themeToggle.dataset.theme = nextTheme;

    elements.themeToggle.title =
      nextTheme === "dark"
        ? "Switch to light theme"
        : "Switch to dark theme";
  }
}

function toggleTheme() {
  const currentTheme =
    document.documentElement.dataset.theme === "dark"
      ? "dark"
      : "light";

  const nextTheme =
    currentTheme === "dark"
      ? "light"
      : "dark";

  localStorage.setItem(themeStorageKey, nextTheme);
  applyTheme(nextTheme);
}


function showMessage(text, type = "") {
  elements.message.textContent = text;
  elements.message.className = `message ${type}`.trim();
  elements.message.hidden = false;
}

/*
 * Errors raised while the confirm dialog is open must render inside the
 * dialog: the page behind the modal backdrop is dimmed and inert.
 */
function showDialogMessage(text) {
  if (!elements.dialogMessage) {
    showMessage(text, "error");
    return;
  }
  elements.dialogMessage.textContent = text;
  elements.dialogMessage.hidden = false;
}

function clearDialogMessage() {
  if (elements.dialogMessage) {
    elements.dialogMessage.hidden = true;
  }
}

function clearMessage() {
  elements.message.hidden = true;
}

function applySavedValueToRows(savedRow, savedField, savedValue) {
  state.rows = state.rows.map((row) => {
    if (
      Number(row.accountId) === Number(savedRow.accountId) &&
      Number(row.idLeague) === Number(savedRow.idLeague) &&
      Number(row.idOrganization) === Number(savedRow.idOrganization) &&
      Number(row.idSportType) === Number(savedRow.idSportType) &&
      Number(row.periodNumber || 0) === Number(savedRow.periodNumber || 0)
    ) {
      return { ...row, [savedField]: savedValue };
    }
    return row;
  });
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
  const limitMode = getSelectedLimitMode();

  const originalValue = getModeFieldValue(row, field, limitMode);
  const key = `${rowKey(row)}:${limitMode}:${field}`;
  const pendingChange = state.pending.get(key);

  const scheduledChanges = state.schedules.filter(
    (schedule) =>
      Number(schedule.accountId) === Number(row.accountId) &&
      Number(schedule.idOrganization) === Number(row.idOrganization) &&
      Number(schedule.idLeague) === Number(row.idLeague) &&
      Number(schedule.idSportType) === Number(row.idSportType) &&
      Number(schedule.periodNumber || 0) === Number(row.periodNumber || 0) &&
      schedule.field === field &&
      (schedule.limitMode || "normal") === limitMode
  );

  const lockingSchedule = [...scheduledChanges]
    .reverse()
    .find(
      (schedule) =>
        !schedule.recurring &&
        ["pending", "running"].includes(schedule.status)
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

  // Remove the check that disabled parent rows
  const editableFields = Array.isArray(row.editableFields)
    ? row.editableFields
    : [];

  input.disabled =
    !editableFields.includes(field) ||
    Boolean(lockingSchedule) ||
    (limitMode === "early" && rowSupportsEarlyMode(row) === false);

  if (pendingChange) {
    input.classList.add("changed");
  }

  if (input.disabled) {
    input.title = lockingSchedule
      ? "This limit is locked until its scheduled change finishes"
      : limitMode === "early" && rowSupportsEarlyMode(row) === false
        ? "Early values are not available for this league"
      : row.disabledReason || "This field is not editable";
  }

  input.dataset.field = field;
  input.dataset.rowKey = rowKey(row);

  // Add indication this is a parent row
  if (isParentLimitRow(row)) {
    input.dataset.isParentRow = "true";
    input.title = "This will update all leagues under this parent limit";
  }
  input.dataset.limitMode = limitMode;

  input.setAttribute(
    "aria-label",
    `${fieldLabels[field]} for ${row.leagueName}`
  );

  input.addEventListener("input", () => {
    const typedValue =
      input.value === ""
        ? null
        : Number(input.value);

    /*
     * A non-integer value is never saved, so it must not stay marked as a
     * pending change either — otherwise the field displays one number
     * while Save would write a different one.
     */
    const invalidValue =
      typedValue !== null &&
      !Number.isInteger(typedValue);

    if (
      invalidValue ||
      typedValue === originalValue ||
      (typedValue === null && originalValue == null)
    ) {
      state.pending.delete(key);
      input.classList.remove("changed");
    } else {
      state.pending.set(key, {
        row,
        mode: limitMode,
        field,
        oldValue: originalValue,
        newValue: typedValue,
        isParentRow: isParentLimitRow(row), // Flag this as a parent update
      });

      input.classList.add("changed");
    }

    updateCounters();
    savePendingToLocalStorage();

    const saveButton = input
      .closest("tr")
      ?.querySelector(".save-button");

    if (saveButton) {
      saveButton.disabled = ![
        ...state.pending.keys(),
      ].some((pendingKey) =>
        pendingKey.startsWith(`${rowKey(row)}:${limitMode}:`)
      );
    }
  });

  cell.append(input);
  return cell;
}

function openConfirmation(row) {
  const limitMode = getSelectedLimitMode();
  const changes = getPendingChangesForMode(limitMode);

  if (!changes.length) {
    showMessage(
      "Make at least one change before saving.",
      "error"
    );
    return;
  }

  const change =
    changes.find(
      (item) => rowKey(item.row) === rowKey(row)
    ) || changes[0];

  if (
    change.newValue === null ||
    change.newValue < 0
  ) {
    showMessage(
      "Enter a valid whole-number limit before saving.",
      "error"
    );
    return;
  }

  state.activeChange = change;
  state.pendingSaveBatch = changes;

  elements.confirmTitle.textContent =
    `Update ${fieldLabels[change.field]}?`;

  elements.confirmText.textContent =
    `${row.leagueName} · Account ${row.accountId} · Organization ${row.idOrganization}`;

  elements.oldValue.textContent =
    change.oldValue ?? "Not set";

  elements.newValue.textContent =
    change.newValue.toLocaleString();

  clearScheduleOptions();

  clearDialogMessage();

  elements.dialog.showModal();
}

function renderRows() {
  elements.leagueRows.replaceChildren();

  /*
   * The dashboard table stays empty until a main
   * parent limit is selected.
   */
  if (!elements.limitFilter.value) {
    const row = document.createElement("tr");
    const cell = document.createElement("td");

    cell.colSpan = 7;
    cell.className = "empty-state";
    cell.textContent = "No league is selected.";

    row.append(cell);
    elements.leagueRows.append(row);

    updateCounters();
    return;
  }

  if (!state.filteredRows.length) {
    const row = document.createElement("tr");
    const cell = document.createElement("td");

    cell.colSpan = 7;
    cell.className = "empty-state";
    cell.textContent =
      "No editable leagues match the current filters.";

    row.append(cell);
    elements.leagueRows.append(row);

    updateCounters();
    return;
  }

  const displayRows = [];

  for (const row of state.filteredRows) {
    displayRows.push(row);

    if (state.expandedRows.has(rowKey(row))) {
      displayRows.push(
        ...(state.periodRows.get(rowKey(row)) || [])
      );
    }
  }

  for (const row of displayRows) {
    const tableRow = document.createElement("tr");

    tableRow.className =
      `row-level-${row.level || 0}`;

    if (isParentLimitRow(row)) {
      tableRow.classList.add("parent-header-row");
    } else {
      tableRow.classList.add("child-row");
    }

    const nameCell = document.createElement("td");
    nameCell.className = "league-name";

    if (row.hasPeriods) {
      const expandButton =
        document.createElement("button");

      expandButton.className = "expand-button";
      expandButton.type = "button";

      expandButton.textContent =
        state.expandedRows.has(rowKey(row))
          ? "−"
          : "+";

      expandButton.setAttribute(
        "aria-label",
        `${state.expandedRows.has(rowKey(row))
          ? "Collapse"
          : "Expand"
        } ${row.leagueName}`
      );

      expandButton.addEventListener(
        "click",
        () => {
          togglePeriods(row).catch((error) => {
            showMessage(
              error.message ||
              "Could not load league periods",
              "error"
            );
          });
        }
      );

      nameCell.append(expandButton);
    }

    const name =
      document.createElement("strong");

    name.textContent =
      row.leagueName ||
      row.name ||
      row.league ||
      row.organizationLabel ||
      "Unnamed league";

    const ids =
      document.createElement("small");

    ids.textContent =
      `League ${row.idLeague} · Organization ${row.idOrganization}`;

    const badge =
      document.createElement("span");

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

    const actionCell =
      document.createElement("td");

    const saveButton =
      document.createElement("button");

    saveButton.className = "save-button";
    saveButton.type = "button";
    saveButton.textContent = "Save";

    saveButton.disabled = ![
      ...state.pending.keys(),
    ].some((pendingKey) =>
      pendingKey.startsWith(`${rowKey(row)}:${getSelectedLimitMode()}:`)
    );

    saveButton.addEventListener(
      "click",
      () => openConfirmation(row)
    );

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

    const response = await fetch(
      `/api/periods?${query}`,
      {
        cache: "no-store",
      }
    );

    // Error responses (e.g. a proxy's HTML error page) may not be JSON.
    let data = {};
    try {
      data = await response.json();
    } catch {
      data = {};
    }

    if (!response.ok) {
      showMessage(
        data.error ||
        "Could not load league periods",
        "error"
      );
      return;
    }

    state.periodRows.set(
      key,
      Array.isArray(data.rows)
        ? data.rows
        : []
    );
  }

  state.expandedRows.add(key);
  renderRows();
}

function isOtherLimitRow(row) {
  const rowName = getRowDisplayName(row)
    .toUpperCase()
    .split(" -- ")[0]
    .trim();

  return rowName === "OTHER";
}

function applyFilters() {
  const query = elements.searchInput.value
    .trim()
    .toLowerCase();

  const rowType = elements.rowTypeFilter.value;

  const selectedLimitKey = normalizeLimitKey(
    elements.limitFilter.value
  );

  // No parent selected: keep the table empty.
  if (!selectedLimitKey) {
    state.filteredRows = [];
    renderRows();
    return;
  }

  const filteredRows = [];
  let currentParentLimitKey = "";

  for (const row of state.rows) {
    /*
     * When a parent limit row is found:
     * BIG SIX, MID-LEVEL, MINOR or NOVELTY.
     */
    if (isParentLimitRow(row)) {
      currentParentLimitKey = normalizeLimitKey(
        getRowDisplayName(row)
      );

      /*
       * Add the selected parent limit itself to the table.
       * Previously this row was skipped with only "continue".
       */
      if (currentParentLimitKey === selectedLimitKey) {
        filteredRows.push(row);
      }

      continue;
    }

    // Do not show the unwanted Other row.
    if (isOtherLimitRow(row)) {
      continue;
    }

    const explicitParentKey = normalizeLimitKey(
      getExplicitParentLimit(row)
    );

    const rowParentKey =
      explicitParentKey ||
      currentParentLimitKey;

    // Show only leagues under the selected parent.
    if (rowParentKey !== selectedLimitKey) {
      continue;
    }

    const matchesType =
      rowType === "all" ||
      row.rowType === rowType;

    const haystack = [
      row.leagueName,
      row.organizationLabel,
      row.name,
      row.league,
      row.periodDescription,
      row.idLeague,
      row.idOrganization,
    ]
      .filter(
        (value) =>
          value !== undefined &&
          value !== null
      )
      .join(" ")
      .toLowerCase();

    const matchesSearch =
      !query ||
      haystack.includes(query);

    if (
      matchesType &&
      matchesSearch
    ) {
      filteredRows.push(row);
    }
  }

  state.filteredRows = filteredRows;
  renderRows();
}

function renderSchedules() {
  elements.scheduleRows.replaceChildren();

  const schedules = state.schedules.filter(
    (schedule) =>
      schedule.recurring
  );

  if (!schedules.length) {
    const row = document.createElement("tr");
    const cell = document.createElement("td");

    cell.colSpan = 8;
    cell.className = "empty-state";
    cell.textContent = "No recurring schedules.";

    row.append(cell);
    elements.scheduleRows.append(row);
    return;
  }

  for (const schedule of schedules) {
    const row = document.createElement("tr");

    row.append(
      createTextCell(
        schedule.agentName ||
        state.agents.find(
          (agent) =>
            Number(agent.id) ===
            Number(schedule.accountId)
        )?.name ||
        `Agent ${schedule.accountId}`
      ),
      createTextCell(schedule.customerSupportAgent),
      createTextCell(
        schedule.leagueName ||
        `League ${schedule.idLeague}`
      ),
      createTextCell(
        `${fieldLabels[schedule.field] ||
        schedule.field
        }${schedule.limitMode === "early" ? " (Early)" : ""}: ${Number(
          schedule.value
        ).toLocaleString()}`
      ),
      createTextCell(schedule.recurrence),
      createTextCell(
        formatEasternDateTime(
          schedule.scheduledForUtc ||
          schedule.scheduledFor
        )
      ),
      createTextCell(schedule.status)
    );

    const action =
      document.createElement("td");

    const cancel =
      document.createElement("button");

    cancel.type = "button";
    cancel.className = "schedule-cancel";
    cancel.textContent = "Cancel";
    cancel.disabled =
      !["pending", "failed"].includes(schedule.status);

    cancel.addEventListener(
      "click",
      async () => {
        cancel.disabled = true;

        try {
          const response = await fetch(
            "/api/schedules/cancel",
            {
              method: "POST",
              headers: {
                "Content-Type":
                  "application/json",
              },
              body: JSON.stringify({
                id: schedule.id,
              }),
            }
          );

          const data = await response.json();

          if (!response.ok) {
            throw new Error(
              data.error ||
              "Could not cancel schedule"
            );
          }

          state.schedules =
            state.schedules.filter(
              (item) =>
                item.id !== schedule.id
            );

          renderSchedules();
          renderRows();

          showMessage(
            data.message,
            "success"
          );
        } catch (error) {
          cancel.disabled = false;

          showMessage(
            error.message,
            "error"
          );
        }
      }
    );

    action.append(cancel);
    row.append(action);
    elements.scheduleRows.append(row);
  }
}

async function loadLeagues(includeSchedules = true) {
  const accountId = state.selectedAgentId;

  if (!accountId) {
    return;
  }

  /*
   * Remember the current selected parent before
   * loading another agent's rows.
   */
  const selectedLimitBeforeLoad =
    elements.limitFilter.value;

  const requestVersion = ++leagueDataVersion;

  clearMessage();

  const query = new URLSearchParams({
    accountId,
  });

  const requests = [
    fetch(`/api/leagues?${query}`, {
      cache: "no-store",
    }),
  ];
  if (includeSchedules) {
    requests.push(
      fetch(`/api/schedules?${query}`, {
        cache: "no-store",
      })
    );
  }
  const [response, scheduleResponse] = await Promise.all(requests);

  if (
    !response.ok ||
    (scheduleResponse && !scheduleResponse.ok)
  ) {
    throw new Error(
      "Could not load editable leagues"
    );
  }

  const data = await response.json();
  const scheduleData = scheduleResponse
    ? await scheduleResponse.json()
    : null;

  /*
   * Ignore an old response if another agent was selected or a newer
   * load/save wrote fresher rows while this request was running.
   */
  if (
    accountId !== state.selectedAgentId ||
    requestVersion !== leagueDataVersion
  ) {
    return;
  }

  state.rows = Array.isArray(data.rows)
    ? data.rows
    : [];

  if (scheduleData) {
    state.schedules = Array.isArray(scheduleData.schedules)
      ? scheduleData.schedules
      : [];
    state.schedulesAgentId = accountId;
  }

  state.filteredRows = [];

  /*
   * Rebuild the dynamic dropdown using parent
   * Summary rows only, then restore the current
   * selected parent when available.
   */
  populateLimitDropdown(
    state.rows,
    selectedLimitBeforeLoad
  );

  restorePendingFromLocalStorage();
  applyFilters();
  renderSchedules();
}

async function loadSchedules(force = false) {
  const accountId = state.selectedAgentId;
  if (!accountId) {
    return;
  }
  if (!force && Number(state.schedulesAgentId) === Number(accountId)) {
    renderSchedules();
    return;
  }

  const response = await fetch(
    `/api/schedules?${new URLSearchParams({ accountId })}`,
    { cache: "no-store" }
  );
  const data = await response.json();
  if (!response.ok) {
    throw new Error(data.error || "Could not load activity logs");
  }
  if (Number(accountId) !== Number(state.selectedAgentId)) {
    return;
  }
  state.schedules = Array.isArray(data.schedules) ? data.schedules : [];
  state.schedulesAgentId = accountId;
  renderSchedules();
}

async function loadAgents() {
  const response = await fetch(
    "/api/agents",
    {
      cache: "no-store",
    }
  );

  const data = await response.json();

  if (
    !response.ok ||
    !data.agents?.length
  ) {
    throw new Error(
      data.error ||
      "Could not load agents"
    );
  }

  state.agents = data.agents;

  const preferences =
    data.preferences || {};

  elements.accountName.textContent =
    data.parentName || "Agent";

  elements.accountId.textContent =
    `Account ${data.parentId}`;

  state.expandedAgentIds = new Set(
    state.agents
      .filter(
        (agent) =>
          Number(agent.depth || 0) === 0
      )
      .map((agent) => Number(agent.id))
  );

  elements.searchInput.value =
    preferences.searchQuery || "";

  elements.rowTypeFilter.value = [
    "all",
    "League",
    "Summary",
  ].includes(preferences.rowTypeFilter)
    ? preferences.rowTypeFilter
    : "all";

  const defaultAgent =
    state.agents.find(
      (agent) =>
        Number(agent.id) ===
        Number(
          preferences.selectedAgentId
        )
    ) ||
    state.agents.find(
      (agent) =>
        Number(agent.id) ===
        Number(data.parentId)
    ) ||
    state.agents[0];

  state.selectedAgentId =
    Number(defaultAgent.id);

  updateAgentSelectorLabel(defaultAgent);
  renderAgentTree();

  if (elements.agentSelectButton) {
    elements.agentSelectButton.disabled =
      false;
  }

  if (isActivityLogsRoute()) {
    await loadSchedules();
    loadLeagues(false).catch((error) => {
      showMessage(error.message, "error");
    });
  } else if (isPinnacleComparisonRoute()) {
    loadLeagues(false).catch((error) => {
      showMessage(error.message, "error");
    });
    await loadPinnacleComparison().catch(() => { });
  } else {
    await loadLeagues();
  }
}

function updateAgentSelectorLabel(agent) {
  elements.agentSelectButton.textContent =
    `${agent.name} (${agent.count ?? 0})`;
}

function visibleAgentRows() {
  const visible = [];
  const ancestors = [];

  for (const agent of state.agents) {
    const depth =
      Number(agent.depth || 0);

    ancestors.length = depth;

    const isVisible =
      depth === 0 ||
      ancestors.every((ancestor) =>
        state.expandedAgentIds.has(
          Number(ancestor.id)
        )
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
    const row =
      document.createElement("button");

    row.type = "button";
    row.className = "agent-tree-row";
    row.setAttribute(
      "role",
      "treeitem"
    );

    row.setAttribute(
      "aria-selected",
      String(
        Number(agent.id) ===
        state.selectedAgentId
      )
    );

    row.style.setProperty(
      "--agent-depth",
      Number(agent.depth || 0)
    );

    const toggle =
      document.createElement("button");

    toggle.type = "button";
    toggle.className =
      "agent-tree-toggle";

    toggle.textContent =
      agent.hasChildren
        ? state.expandedAgentIds.has(
          Number(agent.id)
        )
          ? "▾"
          : "▸"
        : "";

    toggle.disabled =
      !agent.hasChildren;

    toggle.setAttribute(
      "aria-label",
      `${state.expandedAgentIds.has(
        Number(agent.id)
      )
        ? "Collapse"
        : "Expand"
      } ${agent.name}`
    );

    const name =
      document.createElement("span");

    name.className =
      "agent-tree-name";

    name.textContent =
      `${agent.name} (${agent.count ?? 0})`;

    row.append(toggle, name);

    toggle.addEventListener(
      "click",
      (event) => {
        event.preventDefault();
        event.stopPropagation();

        const agentId =
          Number(agent.id);

        if (
          state.expandedAgentIds.has(
            agentId
          )
        ) {
          state.expandedAgentIds.delete(
            agentId
          );
        } else {
          state.expandedAgentIds.add(
            agentId
          );
        }

        renderAgentTree();
      }
    );

    row.addEventListener(
      "click",
      async () => {
        await selectAgent(agent);
      }
    );

    elements.agentTree.append(row);
  }
}

function renderAgentSearchResults(agents) {
  elements.agentSearchResults.replaceChildren();

  const visibleAgents = agents.filter(
    (agent) =>
      Number(agent.id) !==
      state.selectedAgentId
  );

  if (!visibleAgents.length) {
    const empty =
      document.createElement("div");

    empty.className =
      "agent-search-empty";

    empty.textContent = agents.length
      ? "Selected agent hidden"
      : "No matching agents";

    elements.agentSearchResults.append(
      empty
    );

    elements.agentSearchResults.hidden =
      false;

    return;
  }

  for (const agent of visibleAgents) {
    const result =
      document.createElement("button");

    result.type = "button";
    result.className =
      "agent-search-result";

    result.setAttribute(
      "role",
      "option"
    );

    const name =
      document.createElement("strong");

    name.textContent = agent.name;

    result.append(name);

    result.addEventListener(
      "click",
      () => selectAgent(agent)
    );

    elements.agentSearchResults.append(
      result
    );
  }

  elements.agentSearchResults.hidden =
    false;
}

async function searchAgents() {
  const searchValue =
    elements.agentSearch.value.trim();

  const requestId =
    ++agentSearchRequest;

  if (!searchValue) {
    elements.agentSearchResults.hidden =
      true;

    elements.agentSearchResults.replaceChildren();
    return;
  }

  const response = await fetch(
    `/api/agent-search?${new URLSearchParams({
      q: searchValue,
    })}`,
    {
      cache: "no-store",
    }
  );

  const data = await response.json();

  if (requestId !== agentSearchRequest) {
    return;
  }

  if (!response.ok) {
    throw new Error(
      data.error ||
      "Could not search agents"
    );
  }

  renderAgentSearchResults(
    data.agents || []
  );
}

async function selectAgent(agent) {
  const knownAgent = state.agents.find(
    (item) =>
      Number(item.id) ===
      Number(agent.id)
  );

  state.selectedAgentId =
    Number(agent.id);

  const selectedAgent =
    knownAgent || agent;

  updateAgentSelectorLabel(
    selectedAgent
  );

  renderAgentTree();

  elements.agentTree.hidden = true;

  /*
   * Find Agent is only for searching.
   * Clear it after an agent is selected.
   */
  clearTimeout(agentSearchTimer);
  agentSearchRequest += 1;

  elements.agentSearch.value = "";

  elements.agentSearchResults.replaceChildren();

  elements.agentSearchResults.hidden =
    true;

  savePreferences({
    selectedAgentId:
      state.selectedAgentId,
  }).catch((error) => {
    showMessage(
      error.message,
      "error"
    );
  });

  state.periodRows.clear();
  state.expandedRows.clear();
  state.activeChange = null;
  state.pendingSaveBatch = [];
  state.comparisonRequest += 1;
  state.comparison = null;
  state.comparisonAgentId = null;
  state.comparisonLoading = false;
  state.schedulesAgentId = null;

  elements.leagueRows.innerHTML =
    '<tr><td colspan="7" class="empty-state">Loading leagues...</td></tr>';

  try {
    /*
     * loadLeagues preserves the currently selected
     * parent limit while loading this agent's values.
     */
    if (isActivityLogsRoute()) {
      await loadSchedules();
      await loadLeagues(false);
    } else if (isPinnacleComparisonRoute()) {
      loadLeagues(false).catch((error) => {
        showMessage(error.message, "error");
      });
      await loadPinnacleComparison().catch(() => { });
    } else {
      await loadLeagues();
    }
  } catch (error) {
    /*
     * Drop the previous agent's rows: leaving them in state would render
     * the old agent's limits under the newly selected agent's name.
     */
    state.rows = [];
    state.filteredRows = [];
    state.schedules = [];
    renderSchedules();

    const errorRow = document.createElement("tr");
    const errorCell = document.createElement("td");
    errorCell.colSpan = 7;
    errorCell.className = "empty-state";
    errorCell.textContent =
      "Could not load leagues for this agent. Try selecting it again.";
    errorRow.append(errorCell);
    elements.leagueRows.replaceChildren(errorRow);

    updateCounters();

    showMessage(
      error.message,
      "error"
    );
  }
}

async function savePreferences(preferences) {
  const response = await fetch(
    "/api/preferences",
    {
      method: "POST",
      headers: {
        "Content-Type":
          "application/json",
      },
      body: JSON.stringify(preferences),
    }
  );

  if (
    !response.ok &&
    response.status !== 401
  ) {
    const data = await response.json();

    throw new Error(
      data.error ||
      "Could not save preferences"
    );
  }
}

function queueFilterPreferences() {
  clearTimeout(preferenceSaveTimer);

  preferenceSaveTimer = setTimeout(
    () => {
      savePreferences({
        searchQuery:
          elements.searchInput.value,
        rowTypeFilter:
          elements.rowTypeFilter.value,
      }).catch((error) =>
        showMessage(
          error.message,
          "error"
        )
      );
    },
    300
  );
}

async function refreshScheduleStatuses() {
  const accountId =
    state.selectedAgentId;

  if (!accountId) {
    return;
  }

  /*
   * Skip this poll while the user is mid-interaction: re-rendering would
   * steal focus from a limit input, and refreshing under an open confirm
   * dialog could swap the rows the pending change points at.
   */
  if (
    elements.dialog.open ||
    document.activeElement?.classList?.contains("limit-input")
  ) {
    return;
  }

  const requestVersion = leagueDataVersion;

  const query =
    new URLSearchParams({
      accountId,
    });

  const response = await fetch(
    `/api/schedules?${query}`,
    {
      cache: "no-store",
    }
  );

  if (!response.ok) {
    return;
  }

  const data = await response.json();

  if (
    JSON.stringify(data.schedules) ===
    JSON.stringify(state.schedules)
  ) {
    return;
  }

  const previousSchedules = new Map(
    state.schedules.map((schedule) => [
      schedule.id,
      schedule,
    ])
  );

  const finishedSchedule =
    data.schedules.find((schedule) => {
      const previous =
        previousSchedules.get(
          schedule.id
        );

      return (
        ([
          "pending",
          "running",
        ].includes(previous?.status) &&
          [
            "completed",
            "failed",
          ].includes(schedule.status)) ||
        (schedule.recurring &&
          previous?.lastRunAt !==
          schedule.lastRunAt &&
          Boolean(schedule.lastRunAt))
      );
    });

  const leagueResponse = await fetch(
    `/api/leagues?${query}`,
    {
      cache: "no-store",
    }
  );

  if (!leagueResponse.ok) {
    return;
  }

  const leagueData =
    await leagueResponse.json();

  /*
   * Discard this poll's data if another agent was selected or a save/load
   * wrote fresher rows while these requests were in flight — otherwise
   * stale league values would overwrite a just-saved limit in the UI.
   */
  if (
    accountId !== state.selectedAgentId ||
    requestVersion !== leagueDataVersion
  ) {
    return;
  }

  const selectedLimitBeforeRefresh =
    elements.limitFilter.value;

  state.rows = Array.isArray(
    leagueData.rows
  )
    ? leagueData.rows
    : [];

  state.schedules = Array.isArray(
    data.schedules
  )
    ? data.schedules
    : [];

  populateLimitDropdown(
    state.rows,
    selectedLimitBeforeRefresh
  );

  restorePendingFromLocalStorage();
  applyFilters();
  renderSchedules();

  if (finishedSchedule) {
    const allRows = [
      ...state.rows,
      ...[
        ...state.periodRows.values(),
      ].flat(),
    ];

    const row = allRows.find(
      (candidate) =>
        Number(candidate.accountId) ===
        Number(
          finishedSchedule.accountId
        ) &&
        Number(
          candidate.idOrganization
        ) ===
        Number(
          finishedSchedule.idOrganization
        ) &&
        Number(candidate.idLeague) ===
        Number(
          finishedSchedule.idLeague
        ) &&
        Number(candidate.idSportType) ===
        Number(
          finishedSchedule.idSportType
        ) &&
        Number(
          candidate.periodNumber || 0
        ) ===
        Number(
          finishedSchedule.periodNumber ||
          0
        )
    );

    if (
      row &&
      finishedSchedule.status ===
      "completed"
    ) {
      const finishedLimitMode =
        finishedSchedule.limitMode === "early"
          ? "early"
          : "normal";
      const finishedField = getModeFieldKey(
        finishedSchedule.field,
        finishedLimitMode
      );

      // Patch only the mode that actually completed. An Early schedule must
      // update earlySpread/earlyMoneyLine/etc.; a Normal schedule must update
      // spread/moneyLine/etc.
      row[finishedField] =
        finishedSchedule.value;

      renderRows();
    }

    showScheduleStatus(
      finishedSchedule.lastRunStatus ||
      finishedSchedule.status,
      row?.leagueName ||
      "this league",
      finishedSchedule.value,
      formatEasternDateTime(
        finishedSchedule.lastRunAtUtc ||
        finishedSchedule.lastRunAt ||
        finishedSchedule.scheduledForUtc ||
        finishedSchedule.scheduledFor
      ),
      fieldLabels[
      finishedSchedule.field
      ],
      finishedSchedule.recurrence,
      formatEasternDateTime(
        finishedSchedule.scheduledForUtc ||
        finishedSchedule.scheduledFor
      )
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
  const successful =
    status === "completed";

  const failed =
    status === "failed";

  elements.scheduleStatusDialog.classList.toggle(
    "status-success",
    successful
  );

  elements.scheduleStatusDialog.classList.toggle(
    "status-error",
    failed
  );

  elements.scheduleStatusEyebrow.textContent =
    failed
      ? "SCHEDULE FAILED"
      : successful
        ? "SCHEDULE COMPLETED"
        : "SCHEDULED LIMIT";

  elements.scheduleStatusTitle.textContent =
    failed
      ? "Limit not applied"
      : successful
        ? "Limit has applied successfully"
        : "Limit change scheduled";

  elements.scheduleStatusText.textContent =
    successful
      ? `${leagueName} ${fieldLabel} was changed to ${Number(
        value
      ).toLocaleString()} at ${scheduledFor}.${nextRun
        ? ` Next run: ${nextRun}.`
        : ""
      }`
      : failed
        ? `${leagueName} ${fieldLabel} could not be changed to ${Number(
          value
        ).toLocaleString()}.${nextRun
          ? ` It will retry at the next scheduled run: ${nextRun}.`
          : ""
        }`
        : `Limit change for ${leagueName} is set to ${Number(
          value
        ).toLocaleString()} ${fieldLabel}. ${recurrence ||
        `It will be applied at ${scheduledFor}`
        }. Next run: ${nextRun || scheduledFor
        }.`;

  elements.scheduleProgress.hidden =
    successful || failed;

  if (successful || failed) {
    if (elements.scheduleStatusDialog.open) {
      elements.scheduleStatusDialog.close();
    }
    elements.scheduleStatusDialog.showModal();
  } else if (!elements.scheduleStatusDialog.open) {
    elements.scheduleStatusDialog.showModal();
  }
}

async function saveActiveChange() {
  const batch =
    Array.isArray(state.pendingSaveBatch) &&
    state.pendingSaveBatch.length
      ? state.pendingSaveBatch
      : state.activeChange
        ? [state.activeChange]
        : [];

  if (!batch.length) {
    return;
  }

  const change = batch[0];

  elements.confirmSave.disabled = true;
  elements.confirmSave.textContent =
    "Saving…";

  try {
    // The pending edit already remembers the mode in which it was created.
    // Use that stored mode instead of reading the dropdown again at save time.
    const limitMode = change.mode === "early" ? "early" : "normal";
    const savedField = getModeFieldKey(
      change.field,
      limitMode
    );
    const response = await fetch(
      "/api/limits",
      {
        method: "POST",
        headers: {
          "Content-Type":
            "application/json",
        },
        body: JSON.stringify({
          accountId:
            change.row.accountId,
          idOrganization:
            change.row.idOrganization,
          idLeague:
            change.row.idLeague,
          idSportType:
            change.row.idSportType,
          periodNumber:
            change.row.periodNumber ||
            0,
          field: change.field,
          value: change.newValue,
          limitMode,
        }),
      }
    );

    const data = await response.json();

    if (!response.ok) {
      throw new Error(
        data.error ||
        "The limit could not be updated"
      );
    }

    // Optimistically update the matching row in state.rows so the UI
    // always reflects the saved value regardless of backend cache timing.
    const savedValue = change.newValue;
    const savedRow = change.row;

    applySavedValueToRows(savedRow, savedField, savedValue);

    // Invalidate any in-flight poll so its pre-save data is discarded.
    leagueDataVersion += 1;

    // Remove only the change that was saved; edits pending on other rows
    // must survive this save.
    removePendingChange(change);
    state.activeChange = null;
    state.pendingSaveBatch = [];
    elements.dialog.close();

    applyFilters();

    showMessage(
      `${data.message}. New value: ${data.value.toLocaleString()}.`,
      "success"
    );
  } catch (error) {
    elements.dialog.close();

    showMessage(
      error.message,
      "error"
    );
  } finally {
    elements.confirmSave.disabled =
      false;

    elements.confirmSave.textContent =
      "Save to Aces High";
  }
}

async function savePendingBatch() {
  const batch = Array.isArray(state.pendingSaveBatch)
    ? state.pendingSaveBatch.filter(Boolean)
    : [];

  if (!batch.length) {
    return;
  }

  elements.confirmSave.disabled = true;
  elements.confirmSave.textContent =
    "Saving...";

  try {
    const savedSummaries = [];

    for (const item of batch) {
      const limitMode =
        item.mode || getSelectedLimitMode();
      const savedField = getModeFieldKey(
        item.field,
        limitMode
      );
      const response = await fetch(
        "/api/limits",
        {
          method: "POST",
          headers: {
            "Content-Type":
              "application/json",
          },
          body: JSON.stringify({
            accountId:
              item.row.accountId,
            idOrganization:
              item.row.idOrganization,
            idLeague:
              item.row.idLeague,
            idSportType:
              item.row.idSportType,
            periodNumber:
              item.row.periodNumber ||
              0,
            field: item.field,
            value: item.newValue,
            limitMode,
          }),
        }
      );

      const data = await response.json();

      if (!response.ok) {
        throw new Error(
          data.error ||
          "The limit could not be updated"
        );
      }

      const savedValue = item.newValue;
      const savedRow = item.row;
      applySavedValueToRows(savedRow, savedField, savedValue);

      leagueDataVersion += 1;
      removePendingChange(item);
      savedSummaries.push(
        `${item.row.leagueName}: ${item.newValue.toLocaleString()}`
      );
    }

    state.activeChange = null;
    state.pendingSaveBatch = [];
    elements.dialog.close();
    applyFilters();

    showMessage(
      `${savedSummaries.length} pending changes saved successfully.`,
      "success"
    );
  } catch (error) {
    elements.dialog.close();
    showMessage(
      error.message,
      "error"
    );
  } finally {
    elements.confirmSave.disabled =
      false;
    elements.confirmSave.textContent =
      "Save to Aces High";
  }
}

async function scheduleActiveChange() {
  const change = state.activeChange;

  if (!change) {
    return;
  }

  const recurrenceDays =
    elements.scheduleDays
      .filter((input) => input.checked)
      .map((input) =>
        Number(input.value)
      );

  const selectedTime = getSelectedScheduleTime();
  const customerSupportAgent =
    elements.customerSupportAgent?.value.trim() || "";

  if (customerSupportAgent.length > 100) {
    showDialogMessage(
      "Customer Support Agent name must be 100 characters or fewer."
    );
    return;
  }

  if (!selectedTime) {
    showDialogMessage(
      "Select an Eastern time first."
    );
    return;
  }

  const oneTimeSchedule = recurrenceDays.length === 0;

  if (!oneTimeSchedule && !customerSupportAgent) {
    showDialogMessage(
      "Enter the Customer Support Agent name."
    );
    return;
  }

  // Keep the schedule permanently tied to the mode in which the edit was
  // created. Changing UI state later must never retarget the schedule.
  const limitMode = change.mode === "early" ? "early" : "normal";

  if (oneTimeSchedule) {
    if (
      !window.confirm(
        `This limit will change one time at ${selectedTime} ET and will not repeat. Continue?`
      )
    ) {
      return;
    }
  }

  clearDialogMessage();

  elements.confirmSchedule.disabled =
    true;

  elements.confirmSchedule.textContent =
    "Scheduling...";

  try {
    const response = await fetch(
      "/api/schedules",
      {
        method: "POST",
        headers: {
          "Content-Type":
            "application/json",
        },
        body: JSON.stringify({
          accountId:
            change.row.accountId,
          idOrganization:
            change.row.idOrganization,
          idLeague:
            change.row.idLeague,
          idSportType:
            change.row.idSportType,
          periodNumber:
            change.row.periodNumber ||
            0,
          field: change.field,
          value: change.newValue,
          limitMode,
          recurrenceDays,
          recurrenceTime: selectedTime,
          customerSupportAgent,
          oneTimeSchedule,
        }),
      }
    );

    const data = await response.json();

    if (!response.ok) {
      throw new Error(
        data.error ||
        "The limit could not be scheduled"
      );
    }

    removePendingChange(change);
    state.activeChange = null;
    elements.dialog.close();

    /*
     * The schedule was created successfully — report that before the
     * follow-up refresh, whose failure must not read as a failed schedule.
     */
    showScheduleStatus(
      "pending",
      change.row.leagueName,
      change.newValue,
      formatEasternDateTime(
        data.scheduledForUtc ||
        data.scheduledFor
      ),
      fieldLabels[change.field],
      data.recurrence,
      formatEasternDateTime(
        data.scheduledForUtc ||
        data.scheduledFor
      )
    );

    try {
      await loadLeagues();
    } catch {
      showMessage(
        "The schedule was created, but the table could not be refreshed. Reload the page to see current values.",
        "error"
      );
    }
  } catch (error) {
    elements.dialog.close();

    showMessage(
      error.message,
      "error"
    );
  } finally {
    elements.confirmSchedule.disabled =
      false;

    elements.confirmSchedule.textContent =
      "Schedule";
  }
}

elements.activityLogsLink?.addEventListener(
  "click",
  (event) => {
    if (
      event.button !== 0 ||
      event.metaKey ||
      event.ctrlKey ||
      event.shiftKey ||
      event.altKey
    ) {
      return;
    }

    event.preventDefault();

    if (!isActivityLogsRoute()) {
      window.history.pushState(
        {},
        "",
        "/activity_logs"
      );
    }

    applyDashboardRoute();
  }
);

elements.pinnacleComparisonLink?.addEventListener(
  "click",
  (event) => {
    if (
      event.button !== 0 ||
      event.metaKey ||
      event.ctrlKey ||
      event.shiftKey ||
      event.altKey
    ) {
      return;
    }

    event.preventDefault();

    if (!isPinnacleComparisonRoute()) {
      window.history.pushState(
        {},
        "",
        "/pinnacle_aceshigh"
      );
    }

    applyDashboardRoute();
  }
);

elements.comparisonRefresh?.addEventListener(
  "click",
  () => {
    loadPinnacleComparison(true).catch(() => { });
  }
);

window.addEventListener(
  "popstate",
  () => {
    applyDashboardRoute();
  }
);

elements.searchInput.addEventListener(
  "input",
  () => {
    applyFilters();
    queueFilterPreferences();
  }
);

elements.agentSearch.addEventListener(
  "input",
  () => {
    clearTimeout(agentSearchTimer);

    agentSearchTimer = setTimeout(
      () => {
        searchAgents().catch((error) => {
          showMessage(
            error.message,
            "error"
          );
        });
      },
      300
    );
  }
);

elements.rowTypeFilter.addEventListener(
  "change",
  () => {
    applyFilters();
    queueFilterPreferences();
  }
);

elements.limitFilter.addEventListener(
  "change",
  () => {
    applyFilters();
  }
);

elements.limitModeFilter?.addEventListener(
  "change",
  () => {
    renderRows();
  }
);

elements.agentSelectButton.addEventListener(
  "click",
  () => {
    elements.agentTree.hidden =
      !elements.agentTree.hidden;
  }
);

document.addEventListener(
  "click",
  (event) => {
    if (
      !elements.agentTree.hidden &&
      !event.target.closest(
        ".agent-selector"
      )
    ) {
      elements.agentTree.hidden = true;
    }
  }
);

document.addEventListener(
  "keydown",
  (event) => {
    if (event.key === "Escape") {
      elements.agentTree.hidden = true;
      elements.agentSearchResults.hidden =
        true;

    }
  }
);

elements.confirmSchedule.addEventListener(
  "click",
  (event) => {
    event.preventDefault();
    scheduleActiveChange();
  }
);

elements.clearScheduleOptions?.addEventListener(
  "click",
  (event) => {
    event.preventDefault();
    clearScheduleOptions();
  }
);

elements.confirmSave.addEventListener(
  "click",
  (event) => {
    event.preventDefault();

    /*
     * "Save to Aces High" always saves immediately. Scheduling happens
     * only through the Schedule button — rerouting based on how many
     * weekdays were checked silently did the wrong operation.
     */
    const selectedDays =
      elements.scheduleDays.filter(
        (input) => input.checked
      );
    const selectedTime = getSelectedScheduleTime();
    if (selectedTime) {
      scheduleActiveChange();
      return;
    }

    if (selectedDays.length) {
      showDialogMessage(
        "Pick an Eastern time to create a schedule, or clear the schedule to save immediately."
      );
      return;
    }

    if ((state.pendingSaveBatch || []).length > 1) {
      savePendingBatch();
      return;
    }

    saveActiveChange();
  }
);

elements.closeScheduleStatus.addEventListener(
  "click",
  () => {
    elements.scheduleStatusDialog.close();
  }
);

elements.themeToggle?.addEventListener(
  "click",
  toggleTheme
);

elements.scheduleStatusDialog.addEventListener(
  "click",
  (event) => {
    if (
      event.target ===
      elements.scheduleStatusDialog
    ) {
      elements.scheduleStatusDialog.close();
    }
  }
);

applyTheme(getPreferredTheme());

function showLogin() {
  document.body.classList.remove(
    "app-loading"
  );

  elements.loginView.hidden = false;
  elements.dashboardHeader.hidden = true;
  elements.dashboardSidebar.hidden = true;
  elements.dashboardView.hidden = true;
  elements.password.value = "";
}

async function startDashboard(sessionData = null) {
  document.body.classList.remove(
    "app-loading"
  );

  elements.loginView.hidden = true;
  elements.dashboardHeader.hidden = false;
  elements.dashboardSidebar.hidden = false;
  elements.dashboardView.hidden = false;
  if (sessionData) {
    elements.accountName.textContent = sessionData.username || "Agent";
    elements.accountId.textContent = `Account ${sessionData.id}`;
  }
  applyDashboardRoute();

  try {
    await loadAgents();
  } catch (error) {
    showMessage(
      error.message,
      "error"
    );
  }
}

elements.loginForm.addEventListener(
  "submit",
  async (event) => {
    event.preventDefault();

    elements.loginMessage.hidden = true;
    elements.loginButton.disabled = true;
    elements.loginButton.textContent =
      "Logging in...";

    try {
      const response = await fetch(
        "/api/login",
        {
          method: "POST",
          headers: {
            "Content-Type":
              "application/json",
          },
          body: JSON.stringify({
            username:
              elements.username.value.trim(),
            password:
              elements.password.value,
          }),
        }
      );

      const data =
        await response.json();

      if (!response.ok) {
        throw new Error(
          data.error ||
          "Login failed"
        );
      }

      elements.password.value = "";

      await startDashboard(data);
    } catch (error) {
      elements.loginMessage.textContent =
        error.message;

      elements.loginMessage.hidden =
        false;
    } finally {
      elements.loginButton.disabled =
        false;

      elements.loginButton.textContent =
        "Log in";
    }
  }
);

elements.logoutButton.addEventListener(
  "click",
  async () => {
    await fetch("/api/logout", {
      method: "POST",
    });

    state.agents = [];
    state.selectedAgentId = null;
    state.expandedAgentIds.clear();
    state.rows = [];
    state.filteredRows = [];
    state.schedules = [];
    state.schedulesAgentId = null;
    state.periodRows.clear();
    state.expandedRows.clear();
    state.activeChange = null;
    state.pendingSaveBatch = [];
    state.comparisonRequest += 1;
    state.comparison = null;
    state.comparisonAgentId = null;
    state.comparisonLoading = false;

    clearPendingChanges();

    /*
     * Clear everything the previous account rendered so the next login
     * on this browser never sees another user's data.
     */
    elements.leagueRows.replaceChildren();
    elements.scheduleRows.replaceChildren();
    elements.agentTree.replaceChildren();
    elements.agentTree.hidden = true;
    elements.agentSelectButton.textContent =
      "Loading agents...";
    elements.agentSelectButton.disabled =
      true;
    elements.accountName.textContent =
      "Loading…";
    elements.accountId.textContent =
      "Account";
    elements.agentSearch.value = "";
    elements.agentSearchResults.replaceChildren();
    elements.agentSearchResults.hidden =
      true;
    elements.searchInput.value = "";
    elements.comparisonContent.replaceChildren();
    elements.comparisonProfiles.replaceChildren();
    elements.comparisonFixtureCount.textContent = "—";
    elements.comparisonSectionCount.textContent = "—";
    elements.comparisonGeneratedAt.textContent = "—";
    setComparisonMessage("");

    if (elements.dialog.open) {
      elements.dialog.close();
    }

    if (elements.scheduleStatusDialog.open) {
      elements.scheduleStatusDialog.close();
    }

    clearMessage();
    updateCounters();

    elements.limitFilter.replaceChildren();

    const placeholder =
      document.createElement("option");

    placeholder.value = "";
    placeholder.textContent =
      "Select League";

    elements.limitFilter.append(
      placeholder
    );
    if (elements.limitModeFilter) {
      elements.limitModeFilter.value = "normal";
    }

    showLogin();
  }
);

fetch("/api/session", {
  cache: "no-store",
})
  .then(async (response) => {
    if (!response.ok) {
      showLogin();
      return;
    }
    await startDashboard(await response.json());
  })
  .catch(showLogin);

setInterval(() => {
  refreshScheduleStatuses().catch(
    () => { }
  );
}, 5000);
