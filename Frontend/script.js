const state = {
  trackers: [],
  trackerSettings: null,
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
  activeEditRowKey: null,
  isSavingChange: false,
  comparison: null,
  comparisonAgentId: null,
  comparisonLeagues: [],
  comparisonLeaguesAgentId: null,
  comparisonLeague: "",
  comparisonLoading: false,
  comparisonRequest: 0,
  tradingMonitor: null,
  tradingAgentId: null,
  tradingLeagues: [],
  tradingLeaguesAgentId: null,
  tradingLeague: "",
  tradingLoading: false,
  tradingRequest: 0,
  telegramChats: [],
  editingTelegramRecipientId: null,
  partnerName: "Aces High",
};

const pendingStorageKey = "aceshighPendingLimitEdits";
const themeStorageKey = "aceshighTheme";
let preferenceSaveTimer = null;
let agentSearchTimer = null;
let agentSearchRequest = 0;
let tradingRefreshTimer = null;
/*
 * Monotonic token for every write to state.rows. An async flow captures the
 * token before fetching and discards its response if another write happened
 * meanwhile, so a slow poll can never overwrite fresher data.
 */
let leagueDataVersion = 0;
/*
 * The first league load is the one upstream call queued behind the agent
 * tree, and the account it will use is already known from the login response.
 * Starting it next to the agent request takes it off the critical path.
 */
let prefetchedLeagues = null;

function prefetchLeagues(accountId) {
  if (!accountId) {
    return;
  }

  const query = new URLSearchParams({
    accountId,
  });

  prefetchedLeagues = {
    accountId: Number(accountId),
    response: fetch(
      `/api/leagues?${query}`,
      {
        cache: "no-store",
      }
    ).catch(() => null),
  };
}

/*
 * Hand the in-flight response to the first league load for that account. Any
 * other account, a second load, or a failed prefetch falls back to a fresh
 * request.
 */
function takePrefetchedLeagues(accountId) {
  const prefetch = prefetchedLeagues;

  prefetchedLeagues = null;

  if (
    !prefetch ||
    prefetch.accountId !== Number(accountId)
  ) {
    return null;
  }

  return prefetch.response;
}

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
  dashboardHomeLink: document.querySelector("#dashboardHomeLink"),
  activityLogsLink: document.querySelector("#activityLogsLink"),
  pinnacleComparisonLink: document.querySelector("#pinnacleComparisonLink"),
  tradingMonitorLink: document.querySelector("#tradingMonitorLink"),
  telegramAlertsLink: document.querySelector("#telegramAlertsLink"),
  dashboardSummary: document.querySelector("#dashboardSummary"),
  limitsPanel: document.querySelector("#limitsPanel"),
  activityLogsView: document.querySelector("#activityLogsView"),
  pinnacleComparisonView: document.querySelector("#pinnacleComparisonView"),
  tradingMonitorView: document.querySelector("#tradingMonitorView"),
  telegramAlertsView: document.querySelector("#telegramAlertsView"),
  telegramAlertsForm: document.querySelector("#telegramAlertsForm"),
  telegramAlertsMessage: document.querySelector("#telegramAlertsMessage"),
  telegramAlertName: document.querySelector("#telegramAlertName"),
  telegramAlertChatId: document.querySelector("#telegramAlertChatId"),
  telegramAlertAudience: document.querySelector("#telegramAlertAudience"),
  telegramAlertAdd: document.querySelector("#telegramAlertAdd"),
  telegramAlertRows: document.querySelector("#telegramAlertRows"),
  telegramEditDialog: document.querySelector("#telegramEditDialog"),
  telegramEditForm: document.querySelector("#telegramEditForm"),
  telegramEditName: document.querySelector("#telegramEditName"),
  telegramEditChatId: document.querySelector("#telegramEditChatId"),
  telegramEditAudience: document.querySelector("#telegramEditAudience"),
  telegramEditMessage: document.querySelector("#telegramEditMessage"),
  telegramEditCancel: document.querySelector("#telegramEditCancel"),
  telegramEditSave: document.querySelector("#telegramEditSave"),
  comparisonLeague: document.querySelector("#comparisonLeague"),
  comparisonRefresh: document.querySelector("#comparisonRefresh"),
  comparisonMessage: document.querySelector("#comparisonMessage"),
  comparisonFixtureCount: document.querySelector("#comparisonFixtureCount"),
  comparisonSectionCount: document.querySelector("#comparisonSectionCount"),
  comparisonGeneratedAt: document.querySelector("#comparisonGeneratedAt"),
  comparisonProfiles: document.querySelector("#comparisonProfiles"),
  comparisonWindow: document.querySelector("#comparisonWindow"),
  comparisonExposure: document.querySelector("#comparisonExposure"),
  comparisonContent: document.querySelector("#comparisonContent"),
  tradingLeague: document.querySelector("#tradingLeague"),
  tradingRefresh: document.querySelector("#tradingRefresh"),
  tradingMessage: document.querySelector("#tradingMessage"),
  tradingEventCount: document.querySelector("#tradingEventCount"),
  tradingSuspendedCount: document.querySelector("#tradingSuspendedCount"),
  tradingActionCount: document.querySelector("#tradingActionCount"),
  tradingRows: document.querySelector("#tradingRows"),
  limitFilter: document.querySelector("#limitFilter"),
  limitModeFilter: document.querySelector("#limitModeFilter"),
  scheduleStatusFilter: document.querySelector("#scheduleStatusFilter"),
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
  buildRampView: document.querySelector("#buildRampView"),
  buildRampLink: document.querySelector("#buildRampLink"),
  rampBuilder: document.querySelector("#rampBuilder"),
  rampFields: document.querySelector("#rampFields"),
  rampLeagues: document.querySelector("#rampLeagues"),
  rampLeagueSearch: document.querySelector("#rampLeagueSearch"),
  rampLeagueCount: document.querySelector("#rampLeagueCount"),
  rampSelectAll: document.querySelector("#rampSelectAll"),
  rampSelectNone: document.querySelector("#rampSelectNone"),
  rampTracked: document.querySelector("#rampTracked"),
  rampScale: document.querySelector("#rampScale"),
  rampAgentName: document.querySelector("#rampAgentName"),
  rampMessage: document.querySelector("#rampMessage"),
  rampPreview: document.querySelector("#rampPreview"),
  rampCreate: document.querySelector("#rampCreate"),
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
  deleteAllSchedules: document.querySelector("#deleteAllSchedules"),
  clearScheduleOptions: document.querySelector("#clearScheduleOptions"),
  cancelDialogButton: document.querySelector("#cancelDialogButton"),
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

function isTradingMonitorRoute() {
  const normalizedPath =
    window.location.pathname.replace(/\/+$/, "") || "/";

  return normalizedPath === "/trading_monitor";
}

function isBuildRampRoute() {
  const normalizedPath =
    window.location.pathname.replace(/\/+$/, "") || "/";

  return normalizedPath === "/build_ramp";
}

function isTelegramAlertsRoute() {
  const normalizedPath =
    window.location.pathname.replace(/\/+$/, "") || "/";

  return normalizedPath === "/telegram_alerts";
}

function applyDashboardRoute() {
  const activityLogsActive = isActivityLogsRoute();
  const comparisonActive = isPinnacleComparisonRoute();
  const tradingActive = isTradingMonitorRoute();
  const telegramAlertsActive = isTelegramAlertsRoute();
  const buildRampActive = isBuildRampRoute();
  const dashboardActive =
    !activityLogsActive &&
    !comparisonActive &&
    !tradingActive &&
    !telegramAlertsActive &&
    !buildRampActive;

  if (!tradingActive && tradingRefreshTimer) {
    clearTimeout(tradingRefreshTimer);
    tradingRefreshTimer = null;
  }

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

  if (elements.tradingMonitorView) {
    elements.tradingMonitorView.hidden = !tradingActive;
    elements.tradingMonitorView.setAttribute(
      "aria-hidden",
      String(!tradingActive)
    );
  }

  if (elements.buildRampView) {
    elements.buildRampView.hidden = !buildRampActive;
    elements.buildRampView.setAttribute(
      "aria-hidden",
      String(!buildRampActive)
    );
    /* The league list is built from the dashboard's rows, so refresh it each
     * time the page is opened rather than once at startup. */
    if (buildRampActive) {
      renderRampLeagues();
    }
  }

  if (elements.telegramAlertsView) {
    elements.telegramAlertsView.hidden = !telegramAlertsActive;
    elements.telegramAlertsView.setAttribute(
      "aria-hidden",
      String(!telegramAlertsActive)
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

  if (elements.dashboardHomeLink) {
    elements.dashboardHomeLink.classList.toggle("active", dashboardActive);
    if (dashboardActive) {
      elements.dashboardHomeLink.setAttribute("aria-current", "page");
    } else {
      elements.dashboardHomeLink.removeAttribute("aria-current");
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


  if (elements.tradingMonitorLink) {
    elements.tradingMonitorLink.classList.toggle("active", tradingActive);
    if (tradingActive) {
      elements.tradingMonitorLink.setAttribute("aria-current", "page");
    } else {
      elements.tradingMonitorLink.removeAttribute("aria-current");
    }
  }

  if (elements.buildRampLink) {
    elements.buildRampLink.classList.toggle("active", buildRampActive);
    if (buildRampActive) {
      elements.buildRampLink.setAttribute("aria-current", "page");
    } else {
      elements.buildRampLink.removeAttribute("aria-current");
    }
  }

  if (elements.telegramAlertsLink) {
    elements.telegramAlertsLink.classList.toggle("active", telegramAlertsActive);
    if (telegramAlertsActive) {
      elements.telegramAlertsLink.setAttribute("aria-current", "page");
    } else {
      elements.telegramAlertsLink.removeAttribute("aria-current");
    }
  }

  if (activityLogsActive) {
    renderSchedules();
    if (state.selectedAgentId) {
      loadSchedules().catch(() => { });
    }
  }

  if (comparisonActive && state.selectedAgentId) {
    loadComparisonLeagues()
      .then(() => loadPinnacleComparison())
      .catch(() => { });
  }


  if (tradingActive && state.selectedAgentId) {
    loadTradingLeagues()
      .then(() => loadTradingMonitor())
      .catch(() => { });
  }

  if (buildRampActive) {
    /*
     * The league list comes from the dashboard's rows. Opening this page
     * directly - by URL, or after a full page load - means they were never
     * fetched, which showed an empty picker on a page whose whole job is
     * picking leagues.
     */
    renderRampLeagues();
    loadTrackedLimits().catch(() => { });
    if (!state.rows.length && state.selectedAgentId) {
      loadLeagues(false)
        .then(() => renderRampLeagues())
        .catch(() => { });
    }
  }

  if (telegramAlertsActive) {
    /*
     * The list is fetched once at login and kept in state, and every add,
     * edit and delete refreshes it. Re-fetching on each visit made the page
     * flash empty and rebuild itself every time it was opened, so render what
     * is already loaded and only go to the network when there is nothing.
     */
    if (state.telegramChats.length) {
      renderTelegramChats();
    } else {
      loadTelegramChats().catch(() => { });
    }
  }

  if (dashboardActive && state.selectedAgentId && !state.rows.length) {
    loadLeagues().catch((error) => {
      showMessage(error.message, "error");
    });
  }
}


function showTelegramAlertsMessage(message, kind = "success") {
  if (!elements.telegramAlertsMessage) {
    return;
  }
  elements.telegramAlertsMessage.textContent = message;
  elements.telegramAlertsMessage.className = `message ${kind}`;
  elements.telegramAlertsMessage.hidden = !message;
}

function recipientMembershipText(recipient) {
  if (recipient.isAcesHigh && recipient.isBetWar) return "All";
  if (recipient.isAcesHigh) return "AcesHigh only";
  if (recipient.isBetWar) return "BetWar only";
  return "All";
}

function recipientAudienceValue(recipient) {
  if (recipient.isAcesHigh && recipient.isBetWar) return "all";
  if (recipient.isAcesHigh) return "aceshigh";
  if (recipient.isBetWar) return "betwar";
  return "all";
}

function applyRecipientAudienceUI(selectElement, recipient) {
  if (!selectElement) {
    return;
  }
  selectElement.value = recipientAudienceValue(recipient);
}

function getRecipientAudienceValue(isEdit = false) {
  const value = String(
    isEdit ? elements.telegramEditAudience?.value : elements.telegramAlertAudience?.value
  ).toLowerCase();
  return ["all", "aceshigh", "betwar"].includes(value) ? value : "all";
}

function audienceToMembershipFlags(audience) {
  const value = String(audience || "all").toLowerCase();
  if (value === "aceshigh") return { isAcesHigh: true, isBetWar: false };
  if (value === "betwar") return { isAcesHigh: false, isBetWar: true };
  return { isAcesHigh: true, isBetWar: true };
}

function renderTelegramChats() {
  if (!elements.telegramAlertRows) {
    return;
  }

  elements.telegramAlertRows.replaceChildren();

  if (!state.telegramChats.length) {
    const row = document.createElement("tr");
    const cell = document.createElement("td");
    cell.colSpan = 4;
    cell.className = "empty-state";
    cell.style.textAlign = "center";
    cell.textContent = "No Telegram recipients added yet.";
    row.append(cell);
    elements.telegramAlertRows.append(row);
    return;
  }

  state.telegramChats.forEach((recipient) => {
    const row = document.createElement("tr");

    const nameCell = document.createElement("td");
    nameCell.textContent = recipient.name;

    const chatCell = document.createElement("td");
    chatCell.textContent = recipient.chatId;

    const membershipCell = document.createElement("td");
    membershipCell.textContent = recipientMembershipText(recipient);

    const actionCell = document.createElement("td");
    const actionWrap = document.createElement("div");
    actionWrap.className = "telegram-action-buttons";

    const editButton = document.createElement("button");
    editButton.type = "button";
    editButton.className = "telegram-edit-button";
    editButton.textContent = "Edit";

    editButton.addEventListener("click", () => {
      state.editingTelegramRecipientId = recipient.id;
      elements.telegramEditName.value = recipient.name;
      elements.telegramEditChatId.value = recipient.chatId;
      applyRecipientAudienceUI(elements.telegramEditAudience, recipient);
      elements.telegramEditMessage.textContent = "";
      elements.telegramEditMessage.hidden = true;
      elements.telegramEditDialog.showModal();
      elements.telegramEditName.focus();
    });

    const deleteButton = document.createElement("button");
    deleteButton.type = "button";
    deleteButton.className = "danger-button telegram-delete-button";
    deleteButton.textContent = "Delete";

    deleteButton.addEventListener("click", async () => {
      if (!window.confirm(`Delete Telegram recipient ${recipient.name}?`)) {
        return;
      }

      deleteButton.disabled = true;
      try {
        const response = await fetch("/api/telegram-chats/delete", {
          method: "POST",
          headers: {"Content-Type": "application/json"},
          body: JSON.stringify({id: recipient.id}),
        });
        const data = await response.json();
        if (!response.ok) {
          throw new Error(data.error || "Could not delete Telegram recipient");
        }

        state.telegramChats = state.telegramChats.filter(
          (item) => item.id !== recipient.id
        );
        renderTelegramChats();
        showTelegramAlertsMessage("Telegram recipient deleted.", "success");
      } catch (error) {
        showTelegramAlertsMessage(error.message, "error");
      } finally {
        deleteButton.disabled = false;
      }
    });

    actionWrap.append(editButton, deleteButton);
    actionCell.append(actionWrap);
    row.append(nameCell, chatCell, membershipCell, actionCell);
    elements.telegramAlertRows.append(row);
  });
}


async function loadTelegramChats() {
  const response = await fetch("/api/telegram-chats", {cache: "no-store"});
  const data = await response.json();

  if (!response.ok) {
    throw new Error(data.error || "Could not load Telegram recipients");
  }

  state.telegramChats = Array.isArray(data.recipients) ? data.recipients : [];
  renderTelegramChats();
  return state.telegramChats;
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
    heading.textContent = `${partnerLabel()} ${period} limits`;
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

/*
 * Pinnacle reports limits to the dollar, e.g. 7,878. Writing that verbatim
 * fills the limits table with numbers nobody chose, so the button offers the
 * nearest hundred instead.
 */
function roundPushValue(value) {
  const number = Number(value);
  if (!Number.isFinite(number) || number <= 0) {
    return null;
  }
  return Math.max(100, Math.round(number / 100) * 100);
}

/*
 * A row is per selection, but the limit behind it belongs to the whole
 * league and period - both teams' moneyline rows write the same field. The
 * confirmation says so, because the button's position next to one team reads
 * like it only affects that fixture.
 */
function describePushTarget(data, section, row, target) {
  const league = comparisonText(data.league, "this league");
  const period = comparisonText(section.period, "Full Game");
  const field = fieldLabels[row.field] || row.field;
  const current = formatComparisonLimit(row.acesHigh?.limit);
  const next = Number(target).toLocaleString();

  return (
    `Set the ${field} limit for ${league} ${period} to ${next}?\n\n` +
    `Currently ${current}.\n\n` +
    `This is the league's limit, so it applies to every ${league} ` +
    `${period} fixture — not only ${comparisonText(section.fixture, "this game")}.`
  );
}

function createPushLimitCell(data, section, row) {
  const cell = document.createElement("td");
  cell.className = "comparison-push-cell";

  const target = roundPushValue(row.pinnacle?.limit);
  const writeTarget = section.writeTarget;

  /* No field, no target or no usable number means nothing to write. */
  if (!row.field || !writeTarget || target === null) {
    return cell;
  }

  const button = document.createElement("button");
  button.type = "button";
  button.className = "comparison-push";
  button.textContent = `Use ${target.toLocaleString()}`;
  button.title = `Set the ${fieldLabels[row.field] || row.field} limit to ${target.toLocaleString()}`;

  const current = Number(row.acesHigh?.limit);
  if (Number.isFinite(current) && current === target) {
    button.disabled = true;
    button.textContent = "Matches";
    button.title = "This limit already matches Pinnacle's, rounded";
    cell.append(button);
    return cell;
  }

  button.addEventListener("click", async () => {
    if (!window.confirm(describePushTarget(data, section, row, target))) {
      return;
    }

    const original = button.textContent;
    button.disabled = true;
    button.textContent = "Saving...";

    try {
      const response = await fetch("/api/limits", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          accountId: data.accountId,
          idOrganization: writeTarget.idOrganization,
          idLeague: writeTarget.idLeague,
          idSportType: writeTarget.idSportType,
          periodNumber: writeTarget.periodNumber || 0,
          field: row.field,
          value: target,
          limitMode: "normal",
        }),
      });
      const result = await response.json();

      if (!response.ok) {
        throw new Error(result.error || "Could not set the limit");
      }

      /*
       * A blue limit is skipped rather than written, so report what the
       * server actually did instead of assuming the value changed.
       */
      const skipped = result.changed === false;
      await loadPinnacleComparison(true).catch(() => {});
      setComparisonMessage(
        skipped
          ? result.note || "Skipped, the limit was not changed"
          : `${fieldLabels[row.field] || row.field} limit set to ${target.toLocaleString()}`,
        skipped ? "error" : "success"
      );
    } catch (error) {
      button.disabled = false;
      button.textContent = original;
      setComparisonMessage(error.message, "error");
    }
  });

  cell.append(button);
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

/*
 * One row per period and market, because that is the shape of the limit being
 * compared. A single fixture's number is not actionable on its own: the limit
 * applies to every game, so the exposure that matters is how many fixtures sit
 * above it, and the safe anchor is the lowest of them rather than the typical
 * one.
 */
function buildExposureRows(sections) {
  const groups = new Map();

  for (const section of sections) {
    for (const row of section.rows || []) {
      if (!row.field) {
        continue;
      }
      const pinnacle = Number(row.pinnacle?.limit);
      if (!Number.isFinite(pinnacle)) {
        continue;
      }
      const key = `${section.period}\u0000${row.field}`;
      let group = groups.get(key);
      if (!group) {
        group = {
          period: section.period,
          field: row.field,
          ourLimit: Number(row.acesHigh?.limit),
          writeTarget: section.writeTarget,
          pinnacle: [],
          over: 0,
          fixtures: new Set(),
        };
        groups.set(key, group);
      }
      group.pinnacle.push(pinnacle);
      group.fixtures.add(section.fixtureId ?? section.fixture);
      if (Number.isFinite(group.ourLimit) && group.ourLimit > pinnacle) {
        group.over += 1;
      }
    }
  }

  return [...groups.values()].map((group) => ({
    ...group,
    lowest: Math.min(...group.pinnacle),
    middle: median(group.pinnacle),
    highest: Math.max(...group.pinnacle),
    samples: group.pinnacle.length,
  }));
}

function renderComparisonExposure(data, sections) {
  const host = elements.comparisonExposure;
  if (!host) {
    return;
  }
  host.replaceChildren();

  const rows = buildExposureRows(sections);
  if (!rows.length) {
    return;
  }

  const card = document.createElement("article");
  card.className = "comparison-card exposure-card";

  const header = document.createElement("header");
  const titleWrap = document.createElement("div");
  const title = document.createElement("h3");
  title.textContent = "Where your limits sit against Pinnacle";
  const meta = document.createElement("p");
  const hours = comparisonWindowHours();
  meta.textContent =
    hours === Infinity
      ? `Across every matched fixture. Each limit applies to the whole league and period.`
      : `Across fixtures starting within ${hours} hours. Each limit applies to the whole league and period.`;
  titleWrap.append(title, meta);
  header.append(titleWrap);
  card.append(header);

  const wrap = document.createElement("div");
  wrap.className = "comparison-table-wrap";
  const table = document.createElement("table");
  table.className = "comparison-table exposure-table";

  const head = document.createElement("thead");
  const headRow = document.createElement("tr");
  [
    "Period",
    "Market",
    "Your limit",
    "Pinnacle lowest",
    "Pinnacle median",
    "Pinnacle highest",
    "Over on",
    "",
  ].forEach((label) => {
    const th = document.createElement("th");
    th.textContent = label;
    headRow.append(th);
  });
  head.append(headRow);
  table.append(head);

  const body = document.createElement("tbody");
  const order = ["spread", "moneyLine", "total", "teamTotal"];
  rows.sort(
    (a, b) =>
      String(a.period).localeCompare(String(b.period)) ||
      order.indexOf(a.field) - order.indexOf(b.field)
  );

  for (const row of rows) {
    const tr = document.createElement("tr");
    const fixtures = row.fixtures.size;

    const overCell = document.createElement("td");
    overCell.textContent = `${row.over} of ${fixtures}`;
    /* Being over Pinnacle is the exposure worth seeing; being under only
     * costs volume. */
    overCell.className = row.over
      ? "comparison-limit comparison-limit-over"
      : "comparison-limit";

    tr.append(
      comparisonCell(comparisonText(row.period)),
      comparisonCell(fieldLabels[row.field] || row.field),
      comparisonCell(
        Number.isFinite(row.ourLimit)
          ? formatComparisonLimit(row.ourLimit)
          : "—",
        "comparison-limit"
      ),
      comparisonCell(formatComparisonLimit(row.lowest), "comparison-limit"),
      comparisonCell(formatComparisonLimit(row.middle)),
      comparisonCell(formatComparisonLimit(row.highest)),
      overCell,
      createExposurePushCell(data, row)
    );
    body.append(tr);
  }

  table.append(body);
  wrap.append(table);
  card.append(wrap);
  host.append(card);
}

/*
 * The button offers the lowest Pinnacle limit in the window, not the median.
 * One number covers every fixture, so the exposure is set by the game Pinnacle
 * trusts least; anchoring to the typical game still leaves you above the
 * weakest one.
 */
function createExposurePushCell(data, row) {
  const cell = document.createElement("td");
  cell.className = "comparison-push-cell";

  const target = roundPushValue(row.lowest);
  if (!row.writeTarget || target === null) {
    return cell;
  }

  const button = document.createElement("button");
  button.type = "button";
  button.className = "comparison-push";
  const label = fieldLabels[row.field] || row.field;

  if (Number.isFinite(row.ourLimit) && row.ourLimit === target) {
    button.disabled = true;
    button.textContent = "Matches";
    button.title = "Already at the lowest Pinnacle limit in this window";
    cell.append(button);
    return cell;
  }

  button.textContent = `Use ${target.toLocaleString()}`;
  button.title = `Set ${label} to the lowest Pinnacle limit in this window`;

  button.addEventListener("click", async () => {
    const current = Number.isFinite(row.ourLimit)
      ? formatComparisonLimit(row.ourLimit)
      : "unset";
    const confirmed = window.confirm(
      `Set the ${label} limit for ${comparisonText(data.league, "this league")} ` +
      `${comparisonText(row.period, "Full Game")} to ${target.toLocaleString()}?\n\n` +
      `Currently ${current}. This is the lowest Pinnacle limit across ` +
      `${row.samples} compared selections in the chosen window.\n\n` +
      `It applies to every fixture in this league and period.`
    );
    if (!confirmed) {
      return;
    }

    const original = button.textContent;
    button.disabled = true;
    button.textContent = "Saving...";

    try {
      const response = await fetch("/api/limits", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          accountId: data.accountId,
          idOrganization: row.writeTarget.idOrganization,
          idLeague: row.writeTarget.idLeague,
          idSportType: row.writeTarget.idSportType,
          periodNumber: row.writeTarget.periodNumber || 0,
          field: row.field,
          value: target,
          limitMode: "normal",
        }),
      });
      const result = await response.json();
      if (!response.ok) {
        throw new Error(result.error || "Could not set the limit");
      }
      const skipped = result.changed === false;
      await loadPinnacleComparison(true).catch(() => {});
      setComparisonMessage(
        skipped
          ? result.note || "Skipped, the limit was not changed"
          : `${label} limit set to ${target.toLocaleString()}`,
        skipped ? "error" : "success"
      );
    } catch (error) {
      button.disabled = false;
      button.textContent = original;
      setComparisonMessage(error.message, "error");
    }
  });

  cell.append(button);
  return cell;
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

  renderComparisonProfiles(data);
  elements.comparisonContent.replaceChildren();

  const hours = comparisonWindowHours();
  const sections = (data.comparisons || []).filter((section) =>
    withinComparisonWindow(section, hours)
  );

  elements.comparisonFixtureCount.textContent = String(
    new Set(sections.map((section) => section.fixtureId ?? section.fixture)).size
  );
  elements.comparisonSectionCount.textContent = String(sections.length);

  renderComparisonExposure(data, sections);

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
      "Our limit",
      "Pinnacle line",
      "Pinnacle odds",
      "Pinnacle limit",
      "",
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
        ),
        createPushLimitCell(data, section, row)
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

function setTradingMessage(message = "", type = "") {
  elements.tradingMessage.textContent = message;
  elements.tradingMessage.className = `message comparison-message ${type}`.trim();
  elements.tradingMessage.hidden = !message;
}

function tradingStateBadge(label, stateName) {
  const badge = document.createElement("span");
  badge.className = `trading-state trading-state-${stateName}`;
  badge.textContent = label;
  return badge;
}

function tradingScoreText(event) {
  const scores = Array.isArray(event.scores) ? event.scores : [];
  const score = [...scores].reverse().find(
    (item) => item.participant1Score !== null && item.participant2Score !== null
  );
  if (!score) {
    return "—";
  }
  return `${score.participant1Score}–${score.participant2Score}`;
}

function renderTradingMonitor(data) {
  state.tradingMonitor = data;
  elements.tradingEventCount.textContent = comparisonText(data.eventCount, "0");
  elements.tradingSuspendedCount.textContent = comparisonText(
    data.suspendedCount,
    "0"
  );
  elements.tradingActionCount.textContent = comparisonText(data.actionCount, "0");
  elements.tradingRows.replaceChildren();

  if (!data.events?.length) {
    const row = document.createElement("tr");
    const cell = document.createElement("td");
    cell.colSpan = 7;
    cell.className = "empty-state";
    cell.textContent = `No current ${comparisonText(data.league, "league")} events are mapped between ${partnerLabel()} and Pinnacle.`;
    row.append(cell);
    elements.tradingRows.append(row);
    return;
  }

  data.events.forEach((event) => {
    const row = document.createElement("tr");
    const fixture = document.createElement("td");
    const fixtureName = document.createElement("strong");
    const fixtureMeta = document.createElement("small");
    const mappingMeta = document.createElement("small");
    fixtureName.textContent = comparisonText(event.fixture);
    const start = new Date(event.startTimeUtc);
    fixtureMeta.textContent = Number.isNaN(start.valueOf())
      ? (event.periods || []).join(" · ")
      : `${start.toLocaleString([], {
          month: "short",
          day: "numeric",
          hour: "numeric",
          minute: "2-digit",
        })} · ${(event.periods || []).join(" · ")}`;
    const startDifference = event.mapping?.maxStartDifferenceMinutes;
    mappingMeta.textContent = event.mapping?.verified
      ? `Verified teams + start time (${comparisonText(startDifference, "0")} min difference)`
      : "Mapping not verified";
    mappingMeta.className = event.mapping?.verified
      ? "trading-evidence trading-evidence-ok"
      : "trading-evidence trading-evidence-warning";
    fixture.append(fixtureName, fixtureMeta, mappingMeta);

    const score = document.createElement("td");
    const scoreValue = document.createElement("strong");
    const clock = document.createElement("small");
    scoreValue.textContent = tradingScoreText(event);
    clock.textContent = [
      event.clock?.currentPeriod,
      event.clock?.remainingTimeInPeriod || event.clock?.remainingTime,
    ].filter(Boolean).join(" · ") || "Not live";
    score.append(scoreValue, clock);

    const gameStatus = document.createElement("td");
    gameStatus.append(tradingStateBadge(
      comparisonText(event.status?.name, event.status?.live ? "Live" : "Scheduled"),
      event.status?.live ? "live" : "neutral"
    ));

    const aces = document.createElement("td");
    aces.append(tradingStateBadge(
      event.acesHigh?.open ? "Open" : "Closed",
      event.acesHigh?.open ? "open" : "closed"
    ));

    const pinnacle = document.createElement("td");
    const pinnacleLabel = event.pinnacle?.staleOdds
      ? "Stale"
      : event.pinnacle?.suspended
      ? "Suspended"
      : event.pinnacle?.open
      ? "Open"
      : event.pinnacle?.hasOdds === false
      ? "Unavailable"
      : event.pinnacle?.quoteCount > 0
      ? "Closed"
      : "Unknown";
    const pinnacleState = event.pinnacle?.staleOdds
      ? "hold"
      : event.pinnacle?.suspended
      ? "suspend"
      : event.pinnacle?.open
      ? "open"
      : event.pinnacle?.hasOdds === false
      ? "hold"
      : event.pinnacle?.quoteCount > 0
      ? "closed"
      : "hold";
    pinnacle.append(tradingStateBadge(pinnacleLabel, pinnacleState));
    const pinnacleEvidence = document.createElement("small");
    pinnacleEvidence.className = "trading-evidence";
    pinnacleEvidence.textContent = `${comparisonText(
      event.pinnacle?.activeQuoteCount,
      "0"
    )}/${comparisonText(event.pinnacle?.quoteCount, "0")} active quotes`;
    pinnacle.append(pinnacleEvidence);

    const signal = document.createElement("td");
    signal.append(tradingStateBadge(
      comparisonText(event.recommendation),
      event.signal || "neutral"
    ));

    const updated = document.createElement("td");
    const updatedAt = new Date(event.pinnacle?.updatedAt || data.generatedAt);
    updated.textContent = Number.isNaN(updatedAt.valueOf())
      ? "—"
      : updatedAt.toLocaleTimeString([], { hour: "numeric", minute: "2-digit", second: "2-digit" });

    row.append(fixture, score, gameStatus, aces, pinnacle, signal, updated);
    elements.tradingRows.append(row);
  });
}

async function loadTradingLeagues(force = false) {
  if (!state.selectedAgentId) {
    return;
  }
  const accountId = state.selectedAgentId;
  if (
    !force &&
    Number(state.tradingLeaguesAgentId) === Number(accountId) &&
    state.tradingLeagues.length
  ) {
    return;
  }
  elements.tradingLeague.disabled = true;
  elements.tradingLeague.replaceChildren(new Option("Loading leagues...", ""));
  const params = new URLSearchParams({ accountId: String(accountId) });
  const response = await fetch(`/api/pinnacle-comparison/leagues?${params}`, {
    cache: "no-store",
  });
  const data = await response.json();
  if (!response.ok) {
    throw new Error(data.error || "Could not load trading leagues");
  }
  if (Number(accountId) !== Number(state.selectedAgentId)) {
    return;
  }
  state.tradingLeagues = data.leagues || [];
  state.tradingLeaguesAgentId = accountId;
  const available = new Set(state.tradingLeagues.map((league) => league.slug));
  if (!available.has(state.tradingLeague)) {
    state.tradingLeague = available.has("mlb")
      ? "mlb"
      : (state.tradingLeagues[0]?.slug || "");
  }
  elements.tradingLeague.replaceChildren();
  if (!state.tradingLeagues.length) {
    elements.tradingLeague.append(new Option("No mapped leagues", ""));
    setTradingMessage(`No ${partnerLabel()} leagues overlap with this OddsPapi account.`, "error");
    return;
  }
  state.tradingLeagues.forEach((league) => {
    elements.tradingLeague.append(new Option(league.name, league.slug));
  });
  elements.tradingLeague.value = state.tradingLeague;
  elements.tradingLeague.disabled = false;
}

function scheduleTradingRefresh() {
  if (tradingRefreshTimer) {
    clearTimeout(tradingRefreshTimer);
  }
  if (!isTradingMonitorRoute()) {
    tradingRefreshTimer = null;
    return;
  }
  tradingRefreshTimer = setTimeout(() => {
    // Ask the backend on every UI tick, while allowing its short cache to
    // protect AcesHigh and OddsPapi from unnecessary repeated requests.
    state.tradingMonitor = null;
    loadTradingMonitor(false).catch(() => { });
  }, 30000);
}

async function loadTradingMonitor(force = false) {
  if (!state.selectedAgentId || !state.tradingLeague || state.tradingLoading) {
    return;
  }
  if (
    !force &&
    state.tradingMonitor &&
    Number(state.tradingAgentId) === Number(state.selectedAgentId) &&
    state.tradingMonitor.leagueSlug === state.tradingLeague
  ) {
    renderTradingMonitor(state.tradingMonitor);
    scheduleTradingRefresh();
    return;
  }
  const requestId = ++state.tradingRequest;
  const accountId = state.selectedAgentId;
  state.tradingLoading = true;
  elements.tradingRefresh.disabled = true;
  elements.tradingRefresh.textContent = "Refreshing...";
  setTradingMessage("Loading mapped events and Pinnacle trading state...");
  try {
    const params = new URLSearchParams({
      accountId: String(accountId),
      league: state.tradingLeague,
    });
    if (force) {
      params.set("refresh", "true");
    }
    const response = await fetch(`/api/trading-monitor?${params}`, {
      cache: "no-store",
    });
    const data = await response.json();
    if (!response.ok) {
      throw new Error(data.error || "Could not load the trading monitor");
    }
    if (
      requestId !== state.tradingRequest ||
      Number(accountId) !== Number(state.selectedAgentId)
    ) {
      return;
    }
    state.tradingAgentId = accountId;
    renderTradingMonitor(data);
    setTradingMessage("");
  } catch (error) {
    if (requestId === state.tradingRequest) {
      setTradingMessage(error.message, "error");
    }
    throw error;
  } finally {
    if (requestId === state.tradingRequest) {
      state.tradingLoading = false;
      elements.tradingRefresh.disabled = false;
      elements.tradingRefresh.textContent = "Refresh";
      scheduleTradingRefresh();
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

/*
 * The schedules table prints four timestamps per row across fifteen columns.
 * Repeating "2026" and "EST" in each of them pushed Status and Detail off the
 * side of the screen, so here the year is two digits and the zone is named
 * once, in the column heading.
 */
const easternCompactFormatter = new Intl.DateTimeFormat("en-US", {
  timeZone: "America/New_York",
  year: "2-digit",
  month: "2-digit",
  day: "2-digit",
  hour: "2-digit",
  minute: "2-digit",
  hour12: true,
});

function formatScheduleDateTime(value) {
  if (!value) {
    return "";
  }

  /* A value the server already formatted: drop the zone and the century. */
  if (typeof value === "string" && /\b(?:ET|EST|EDT)\b/.test(value)) {
    return value
      .replace(/\s*\b(?:ET|EST|EDT)\b/g, "")
      .replace(/\b(\d{2})\/(\d{2})\/\d{2}(\d{2})\b/, "$1/$2/$3")
      .trim();
  }

  const parsed = new Date(value);

  if (Number.isNaN(parsed.getTime())) {
    return String(value);
  }

  return easternCompactFormatter.format(parsed).replace(", ", " ");
}

function formatEasternDateTime(value) {
  if (!value) {
    return "";
  }

  /*
   * The desk works in "EST" as the name of the zone, so the label is fixed
   * while the clock time stays true New York local time — the same instant
   * the schedule actually runs at, daylight saving included. Only the
   * abbreviation is decided here.
   */
  if (
    typeof value === "string" &&
    /\b(?:ET|EST|EDT)\b/.test(value)
  ) {
    return value.replace(/\bEDT\b/g, "EST");
  }

  const parsed = new Date(value);

  if (Number.isNaN(parsed.getTime())) {
    return String(value);
  }

  return easternDateTimeFormatter
    .format(parsed)
    .replace(", ", " ")
    .replace(/\bEDT\b/g, "EST");
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

function restorePendingInput(change) {
  const selector = [
    `.limit-input[data-row-key="${rowKey(change.row)}"]`,
    `[data-limit-mode="${change.mode || "normal"}"]`,
    `[data-field="${change.field}"]`,
  ].join("");
  const input = elements.leagueRows.querySelector(selector);
  if (input) {
    input.value =
      change.oldValue == null ? "" : String(change.oldValue);
  }
}

function setInputValueForChange(change, value) {
  const selector = [
    `.limit-input[data-row-key="${rowKey(change.row)}"]`,
    `[data-limit-mode="${change.mode || "normal"}"]`,
    `[data-field="${change.field}"]`,
  ].join("");
  const input = elements.leagueRows.querySelector(selector);
  if (input) {
    input.value = value == null ? "" : String(value);
  }
}

function updateSaveButtonForRow(rowOrKey, mode = getSelectedLimitMode()) {
  const rowKeyValue =
    typeof rowOrKey === "string" ? rowOrKey : rowKey(rowOrKey);
  const button = elements.leagueRows.querySelector(
    `.save-button[data-row-key="${rowKeyValue}"]`
  );
  if (!button) {
    return;
  }
  button.disabled = ![...state.pending.keys()].some((pendingKey) =>
    pendingKey.startsWith(`${rowKeyValue}:${mode}:`)
  );
}

function focusInputForChange(change) {
  const selector = [
    `.limit-input[data-row-key="${rowKey(change.row)}"]`,
    `[data-limit-mode="${change.mode || "normal"}"]`,
    `[data-field="${change.field}"]`,
  ].join("");
  const input = elements.leagueRows.querySelector(selector);
  if (input) {
    input.focus({ preventScroll: true });
  }
}

function captureInputCaret(change) {
  const selector = [
    `.limit-input[data-row-key="${rowKey(change.row)}"]`,
    `[data-limit-mode="${change.mode || "normal"}"]`,
    `[data-field="${change.field}"]`,
  ].join("");
  const input = elements.leagueRows.querySelector(selector);
  if (!input) {
    return null;
  }
  return {
    rowKey: rowKey(change.row),
    mode: change.mode || "normal",
    field: change.field,
    start: input.selectionStart,
    end: input.selectionEnd,
  };
}

function restoreInputCaret(caret) {
  if (!caret) {
    return;
  }
  const selector = [
    `.limit-input[data-row-key="${caret.rowKey}"]`,
    `[data-limit-mode="${caret.mode}"]`,
    `[data-field="${caret.field}"]`,
  ].join("");
  const input = elements.leagueRows.querySelector(selector);
  if (!input) {
    return;
  }
  input.focus({ preventScroll: true });
  if (caret.start != null && caret.end != null) {
    input.setSelectionRange(caret.start, caret.end);
  }
}

function discardPendingChange(change) {
  if (!change) {
    return;
  }
  state.pending.delete(
    `${rowKey(change.row)}:${change.mode || "normal"}:${change.field}`
  );
  restorePendingInput(change);
  savePendingToLocalStorage();
  updateCounters();
  updateSaveButtonForRow(change.row, change.mode || "normal");
  applyFilters();
}

function discardPendingChangesExceptRow(targetRowKey) {
  const activeInput = document.activeElement;
  const caret =
    activeInput?.classList?.contains("limit-input")
      ? {
          rowKey: activeInput.dataset.rowKey,
          mode: activeInput.dataset.limitMode || "normal",
          field: activeInput.dataset.field,
          start: activeInput.selectionStart,
          end: activeInput.selectionEnd,
        }
      : null;
  let changed = false;
  const affectedRows = new Map();
  for (const change of [...state.pending.values()]) {
    if (rowKey(change.row) === targetRowKey) {
      continue;
    }
    affectedRows.set(
      rowKey(change.row),
      change.mode || "normal"
    );
    state.pending.delete(
      `${rowKey(change.row)}:${change.mode || "normal"}:${change.field}`
    );
    restorePendingInput(change);
    changed = true;
  }
  if (changed) {
    savePendingToLocalStorage();
    updateCounters();
    for (const [rowKeyValue, mode] of affectedRows) {
      updateSaveButtonForRow(rowKeyValue, mode);
    }
    window.setTimeout(() => {
      if (!caret) {
        return;
      }
      restoreInputCaret(caret);
    }, 0);
  }
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

  input.className = "limit-input";
  input.type = "number";
  input.min = "0";
  input.step = "1";

  input.value =
    pendingChange?.newValue ??
    originalValue ??
    "";

  // Remove the check that disabled parent rows
  const editableFields = Array.isArray(row.editableFields)
    ? row.editableFields
    : [];

  input.disabled =
    !editableFields.includes(field) ||
    (limitMode === "early" && rowSupportsEarlyMode(row) === false);

  if (input.disabled) {
    input.title =
      limitMode === "early" && rowSupportsEarlyMode(row) === false
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

    const currentRowKey = rowKey(row);
    if (state.activeEditRowKey !== currentRowKey) {
      discardPendingChangesExceptRow(currentRowKey);
      state.activeEditRowKey = currentRowKey;
      window.setTimeout(() => {
        focusInputForChange({
          row,
          mode: limitMode,
          field,
        });
      }, 0);
    }

    if (
      invalidValue ||
      typedValue === originalValue ||
      (typedValue === null && originalValue == null)
    ) {
      state.pending.delete(key);
    } else {
      state.pending.set(key, {
        row,
        mode: limitMode,
        field,
        oldValue: originalValue,
        newValue: typedValue,
        isParentRow: isParentLimitRow(row), // Flag this as a parent update
      });
      state.activeEditRowKey = currentRowKey;
      if (!state.pending.size) {
        state.activeEditRowKey = null;
      }
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

  /*
   * How many times this limit has actually been changed. Sits with the value
   * rather than in its own column, so the table does not grow by four.
   */
  const cycles = Number(
    (limitMode === "early" ? row.earlyCycles : row.cycles)?.[field] || 0
  );

  if (cycles > 0) {
    const badge = document.createElement("span");
    badge.className = "cycle-count";
    badge.textContent = cycles;
    badge.title = `Changed ${cycles} time${cycles === 1 ? "" : "s"}`;
    cell.append(badge);
  }

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
    saveButton.dataset.rowKey = rowKey(row);

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

function describeSchedulePeriod(schedule) {
  const periodNumber = Number(schedule.periodNumber || 0);
  return periodNumber ? `Period ${periodNumber}` : "Full game";
}

function describeScheduleLastRun(schedule) {
  if (!schedule.lastRunAtUtc && !schedule.lastRunAt) {
    return "Not run yet";
  }

  const when = formatScheduleDateTime(
    schedule.lastRunAtUtc || schedule.lastRunAt
  );
  const lastStatus = String(
    schedule.lastRunStatus || ""
  ).toLowerCase();
  const rowStatus = String(schedule.status || "").toLowerCase();

  /*
   * Status already carries the current state. Repeat the last run's own
   * outcome only when it differs from it — a recurring schedule that is
   * pending again after a failed run is the case worth seeing.
   */
  return lastStatus && lastStatus !== rowStatus
    ? `${lastStatus} · ${when}`
    : when;
}

/*
 * Status says what happened and Last run says when. Detail carries the one
 * thing neither can show: why. A failure explains itself, and a run that
 * completed without changing anything says so rather than looking identical
 * to one that did.
 */
function describeScheduleDetail(schedule) {
  return schedule.error || schedule.runNote || "";
}

/*
 * Status carries a colour so a failed run is visible at a glance rather than
 * being one lowercase word among twelve columns.
 */
function createStatusCell(status) {
  const cell = document.createElement("td");
  const badge = document.createElement("span");
  const value = String(status || "").toLowerCase();
  badge.className = `schedule-status schedule-status-${value || "unknown"}`;
  badge.textContent = value
    ? value.charAt(0).toUpperCase() + value.slice(1)
    : "—";
  cell.append(badge);
  return cell;
}

/*
 * Saving Spread, Money line and Total together writes three rows in
 * scheduled_limits, but it was one decision by one person. The table used to
 * show it as three near-identical lines. Grouping puts it back on one line the
 * way a sportsbook prints a game: the key is every column the rows share, so
 * anything genuinely separate still gets its own line.
 */
const scheduleLimitFields = ["spread", "moneyLine", "total", "teamTotal"];

function scheduleGroupKey(schedule) {
  return JSON.stringify([
    schedule.accountId,
    schedule.idOrganization,
    schedule.idLeague,
    schedule.idSportType,
    schedule.periodNumber || 0,
    schedule.limitMode || "normal",
    schedule.recurrence || "",
    schedule.scheduledForUtc || schedule.scheduledFor || "",
    schedule.createdAtUtc || schedule.createdAt || "",
    schedule.customerSupportAgent || "",
  ]);
}

function groupSchedules(schedules) {
  /* A Map keeps insertion order, so the existing sort survives grouping. */
  const groups = new Map();

  for (const schedule of schedules) {
    const key = scheduleGroupKey(schedule);
    const existing = groups.get(key);

    if (existing) {
      existing.push(schedule);
    } else {
      groups.set(key, [schedule]);
    }
  }

  return [...groups.values()];
}

function createLimitValueCell(schedule, field) {
  const cell = document.createElement("td");

  if (field === "teamTotal") {
    cell.classList.add("col-team-total");
  }

  if (!schedule) {
    /* Not part of this schedule at all — distinct from a limit of zero. */
    cell.textContent = "—";
    cell.classList.add("schedule-limit-empty");
    return cell;
  }

  cell.textContent = Number(schedule.value).toLocaleString();
  cell.classList.add("schedule-limit-value");
  return cell;
}

/*
 * One badge when the whole group agrees, otherwise one per distinct state so a
 * single failed limit is never hidden behind two successful ones.
 */
function createGroupStatusCell(group) {
  const cell = document.createElement("td");
  const statuses = [
    ...new Set(group.map((item) => String(item.status || "").toLowerCase())),
  ];

  for (const status of statuses) {
    const badge = document.createElement("span");
    badge.className = `schedule-status schedule-status-${status || "unknown"}`;
    badge.textContent = status
      ? status.charAt(0).toUpperCase() + status.slice(1)
      : "—";

    if (statuses.length > 1) {
      badge.title = group
        .filter(
          (item) => String(item.status || "").toLowerCase() === status
        )
        .map((item) => fieldLabels[item.field] || item.field)
        .join(", ");
    }

    cell.append(badge);
  }

  return cell;
}

function createGroupDetailCell(group) {
  const cell = document.createElement("td");
  const notes = group
    .map((item) => ({
      label: fieldLabels[item.field] || item.field,
      text: describeScheduleDetail(item),
    }))
    .filter((note) => note.text);

  if (!notes.length) {
    return cell;
  }

  const distinct = [...new Set(notes.map((note) => note.text))];

  /* The same note on every limit is one sentence, not three. */
  if (distinct.length === 1 && notes.length === group.length) {
    cell.textContent = distinct[0];
    return cell;
  }

  for (const note of notes) {
    const line = document.createElement("div");
    line.className = "schedule-detail-line";
    line.textContent = `${note.label}: ${note.text}`;
    cell.append(line);
  }

  return cell;
}

function describeGroupLastRun(group) {
  return [
    ...new Set(group.map((item) => describeScheduleLastRun(item))),
  ].join(" · ");
}

async function postScheduleAction(path, body) {
  const response = await fetch(path, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  const data = await response.json();

  if (!response.ok) {
    throw new Error(data.error || "Could not update schedule");
  }

  return data;
}

/*
 * Each limit is still its own job upstream, so act on them one at a time and
 * report honestly: a group where one delete fails must not claim it removed
 * everything.
 */
async function applyToGroup(group, path, extra = () => ({})) {
  const removed = [];
  let failure = null;

  for (const schedule of group) {
    try {
      await postScheduleAction(path, { id: schedule.id, ...extra(schedule) });
      removed.push(schedule.id);
    } catch (error) {
      failure = failure || error;
    }
  }

  return { removed, failure };
}

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
    empty.textContent =
      state.selectedAgentId
        ? "Loading leagues for this agent..."
        : "Select an agent on the left to load its leagues.";
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
    state.trackerSettings = data;
    renderTrackedLimits();
  } catch (error) {
    setRampMessage(error.message, "error");
  }
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
    `Checked every ${settings.intervalMinutes || 10} minutes against fixtures ` +
    `starting within ${settings.windowHours || 12} hours. A limit is only rewritten ` +
    `once Pinnacle has moved more than ${settings.minChangePercent || 8}%.`;
  host.append(note);

  const table = document.createElement("table");
  table.className = "ramp-tracked-table";
  const head = document.createElement("thead");
  const headRow = document.createElement("tr");
  ["League", "Market", "Pinnacle now", "Your limit", "Last checked", "State", ""]
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
      comparisonCell(
        tracker.pinnacle ? Number(tracker.pinnacle).toLocaleString() : "—"
      ),
      comparisonCell(
        tracker.value
          ? `${Number(tracker.value).toLocaleString()} (${tracker.scalePercent}%)`
          : `— (${tracker.scalePercent}%)`
      ),
      comparisonCell(comparisonText(tracker.checkedAt, "not yet")),
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
  if (
    !window.confirm(
      `Track ${total.toLocaleString()} limit${total === 1 ? "" : "s"} at ${scale}% of Pinnacle?\n\n` +
      `Across ${targets.length} league${targets.length === 1 ? "" : "s"} and ` +
      `${fields.length} limit type${fields.length === 1 ? "" : "s"}.\n\n` +
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
        : "No active schedules.";

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
      createTextCell(first.recurrence || "One time"),
      createTextCell(
        formatScheduleDateTime(first.scheduledForUtc || first.scheduledFor)
      ),
      createTextCell(describeGroupLastRun(group)),
      createGroupStatusCell(group),
      createGroupDetailCell(group)
    );

    const action = document.createElement("td");
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

    const count = state.schedules.length;

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

      state.schedules = [];
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
      elements.deleteAllSchedules.textContent = "Delete all";
    }
  });
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

  const prefetched =
    takePrefetchedLeagues(accountId);

  const requests = [
    prefetched
      ? prefetched.then(
        (response) =>
          response ||
          fetch(`/api/leagues?${query}`, {
            cache: "no-store",
          })
      )
      : fetch(`/api/leagues?${query}`, {
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
  syncRampLeagues();

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
    await loadComparisonLeagues();
    await loadPinnacleComparison().catch(() => { });
  } else if (isTradingMonitorRoute()) {
    loadLeagues(false).catch((error) => {
      showMessage(error.message, "error");
    });
    await loadTradingLeagues();
    await loadTradingMonitor().catch(() => { });
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
  state.comparisonLeagues = [];
  state.comparisonLeaguesAgentId = null;
  state.comparisonLeague = "";
  state.comparisonLoading = false;
  state.tradingRequest += 1;
  state.tradingMonitor = null;
  state.tradingAgentId = null;
  state.tradingLeagues = [];
  state.tradingLeaguesAgentId = null;
  state.tradingLeague = "";
  state.tradingLoading = false;
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
      await loadComparisonLeagues();
      await loadPinnacleComparison().catch(() => { });
    } else if (isTradingMonitorRoute()) {
      loadLeagues(false).catch((error) => {
        showMessage(error.message, "error");
      });
      await loadTradingLeagues();
      await loadTradingMonitor().catch(() => { });
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
  syncRampLeagues();

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
      finishedSchedule.status === "completed" &&
      // A skipped run wrote nothing, so there is nothing to patch in.
      !finishedSchedule.runNote
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
      // The schedule carries its own league name; the row lookup only finds
      // one when that league happens to be loaded, which is why this popup
      // used to say "this league".
      finishedSchedule.leagueName ||
      row?.leagueName ||
      `League ${finishedSchedule.idLeague}`,
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
      ),
      finishedSchedule.runNote
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
  nextRun = null,
  runNote = null
) {
  /*
   * A run that completed without changing anything is not a change. Saying
   * "applied successfully" for it would claim a limit moved when it did not.
   */
  const skipped =
    status === "completed" && Boolean(runNote);

  const successful =
    status === "completed" && !skipped;

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
      : skipped
        ? "SCHEDULE SKIPPED"
        : successful
          ? "SCHEDULE COMPLETED"
          : "SCHEDULED LIMIT";

  elements.scheduleStatusTitle.textContent =
    failed
      ? "Limit not applied"
      : skipped
        ? "Limit was not changed"
        : successful
          ? "Limit has applied successfully"
          : "Limit change scheduled";

  elements.scheduleStatusText.textContent =
    skipped
      ? `${leagueName} ${fieldLabel} was left unchanged at ${scheduledFor}. ${runNote}.${nextRun ? ` Next run: ${nextRun}.` : ""}`
      : successful
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
    successful || failed || skipped;

  elements.scheduleStatusDialog.classList.toggle("status-skipped", skipped);

  if (successful || failed || skipped) {
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
    const skipped = data.changed === false;

    // Invalidate any in-flight poll so its pre-save data is discarded.
    leagueDataVersion += 1;

    /*
     * Only a write that actually happened may update what we show. A skip
     * leaves AcesHigh untouched, so the grid goes back to the stored value
     * rather than displaying one that was never accepted.
     */
    if (skipped) {
      restorePendingInput(change);
    } else {
      applySavedValueToRows(change.row, savedField, change.newValue);
      setInputValueForChange(change, change.newValue);
    }

    // Remove only the change that was saved; edits pending on other rows
    // must survive this save.
    removePendingChange(change);
    state.activeChange = null;
    state.pendingSaveBatch = [];
    elements.dialog.close();

    applyFilters();

    const where = `${change.row.leagueName || "League"} · ${fieldLabels[change.field] || change.field}${change.mode === "early" ? " (Early)" : ""}`;
    const previous =
      change.oldValue == null ? "not set" : Number(change.oldValue).toLocaleString();
    const outcome = skipped
      ? `${where} was NOT changed. ${data.note || data.message}. It stays at ${previous}.`
      : `${where} changed from ${previous} to ${Number(change.newValue).toLocaleString()}.`;

    /*
     * loadLeagues clears the message bar as it starts, so the outcome has to
     * be written after the re-read settles. Showing it first meant a skipped
     * save reported nothing at all.
     */
    loadLeagues(false)
      .catch(() => { })
      .finally(() => showMessage(outcome, skipped ? "error" : "success"));
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
      `Save to ${state.partnerName || "Aces High"}`;
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
    const skippedSummaries = [];
    const failedSummaries = [];

    for (const item of batch) {
      const limitMode =
        item.mode || getSelectedLimitMode();
      const savedField = getModeFieldKey(
        item.field,
        limitMode
      );

      /*
       * Each field is saved on its own request. A field AcesHigh rejects
       * must not abandon the fields queued behind it, otherwise saving
       * Spread, Money Line and Total together can persist only the first.
       */
      try {
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

        leagueDataVersion += 1;

        /*
         * A skipped save changed nothing at AcesHigh, so it must change
         * nothing here either. Applying it locally would leave our grid
         * claiming a value AcesHigh never accepted.
         */
        if (data.changed === false) {
          restorePendingInput(item);
          removePendingChange(item);
          skippedSummaries.push(
            `${fieldLabels[item.field] || item.field} (${data.note || "already set"})`
          );
        } else {
          applySavedValueToRows(item.row, savedField, item.newValue);
          setInputValueForChange(item, item.newValue);
          removePendingChange(item);
          savedSummaries.push(
            `${fieldLabels[item.field] || item.field}`
          );
        }
      } catch (error) {
        failedSummaries.push(
          `${fieldLabels[item.field] || item.field} (${error.message})`
        );
      }
    }

    state.activeChange = null;
    state.pendingSaveBatch = [];
    elements.dialog.close();
    applyFilters();

    const league = batch[0]?.row?.leagueName || "League";
    const skippedText = skippedSummaries.length
      ? ` NOT changed: ${skippedSummaries.join(", ")}.`
      : "";

    let outcome;
    let kind;
    if (failedSummaries.length) {
      outcome = `${league}: saved ${savedSummaries.join(", ") || "nothing"}. Failed: ${failedSummaries.join("; ")}.${skippedText}`;
      kind = "error";
    } else if (!savedSummaries.length && skippedSummaries.length) {
      outcome = `${league}: nothing was changed.${skippedText}`;
      kind = "error";
    } else {
      outcome = `${league}: changed ${savedSummaries.join(", ")}.${skippedText}`;
      kind = skippedSummaries.length ? "error" : "success";
    }

    /*
     * One re-read for the whole batch so the grid shows AcesHigh's values
     * rather than the ones we painted, and the outcome is written after it
     * because loadLeagues clears the message bar as it starts.
     */
    loadLeagues(false)
      .catch(() => { })
      .finally(() => showMessage(outcome, kind));
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
      `Save to ${state.partnerName || "Aces High"}`;
  }
}

async function scheduleActiveChange() {
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

  const recurrenceDays =
    elements.scheduleDays
      .filter((input) => input.checked)
      .map((input) => Number(input.value));

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
    showDialogMessage("Select an ET time first.");
    return;
  }

  const oneTimeSchedule = recurrenceDays.length === 0;

  if (!customerSupportAgent) {
    showDialogMessage("Enter the Customer Support Agent name.");
    return;
  }

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
  elements.confirmSchedule.disabled = true;
  elements.confirmSchedule.textContent = "Scheduling...";

  try {
    const scheduledSummaries = [];
    let firstScheduled = null;

    const failedSummaries = [];

    for (const item of batch) {
      const limitMode = item.mode === "early" ? "early" : "normal";

      /*
       * One schedule per field. A field the backend rejects must not stop
       * the fields queued behind it from being scheduled at all.
       */
      try {
        const response = await fetch("/api/schedules", {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
          },
          body: JSON.stringify({
            accountId: item.row.accountId,
            idOrganization: item.row.idOrganization,
            idLeague: item.row.idLeague,
            idSportType: item.row.idSportType,
            periodNumber: item.row.periodNumber || 0,
            field: item.field,
            value: item.newValue,
            limitMode,
            recurrenceDays,
            recurrenceTime: selectedTime,
            customerSupportAgent,
            oneTimeSchedule,
          }),
        });

        const data = await response.json();

        if (!response.ok) {
          throw new Error(data.error || "The limit could not be scheduled");
        }

        removePendingChange(item);
        scheduledSummaries.push(`${item.row.leagueName}: ${fieldLabels[item.field]}`);
        if (!firstScheduled) {
          firstScheduled = { item, data };
        }
      } catch (error) {
        failedSummaries.push(
          `${fieldLabels[item.field] || item.field} (${error.message})`
        );
      }
    }

    if (failedSummaries.length) {
      showMessage(
        `Scheduled ${scheduledSummaries.length} of ${batch.length}. Failed: ${failedSummaries.join("; ")}.`,
        "error"
      );
    }

    state.activeChange = null;
    state.pendingSaveBatch = [];
    elements.dialog.close();

    if (firstScheduled) {
      const { item, data } = firstScheduled;
      showScheduleStatus(
        "pending",
        item.row.leagueName,
        item.newValue,
        formatEasternDateTime(data.scheduledForUtc || data.scheduledFor),
        fieldLabels[item.field],
        data.recurrence,
        formatEasternDateTime(data.scheduledForUtc || data.scheduledFor)
      );
    }

    if (scheduledSummaries.length > 1) {
      showMessage(
        `${scheduledSummaries.length} limit changes scheduled successfully.`,
        "success"
      );
    }

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
    showMessage(error.message, "error");
  } finally {
    elements.confirmSchedule.disabled = false;
    elements.confirmSchedule.textContent = "Schedule";
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

elements.dashboardHomeLink?.addEventListener(
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
    if (window.location.pathname !== "/") {
      window.history.pushState({}, "", "/");
    }
    applyDashboardRoute();
  }
);

elements.buildRampLink?.addEventListener(
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

    if (!isBuildRampRoute()) {
      window.history.pushState({}, "", "/build_ramp");
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

elements.tradingMonitorLink?.addEventListener(
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
    if (!isTradingMonitorRoute()) {
      window.history.pushState({}, "", "/trading_monitor");
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

elements.comparisonLeague?.addEventListener(
  "change",
  () => {
    state.comparisonLeague = elements.comparisonLeague.value;
    state.comparisonRequest += 1;
    state.comparison = null;
    state.comparisonAgentId = null;
    state.comparisonLoading = false;
    loadPinnacleComparison().catch(() => { });
  }
);

elements.tradingRefresh?.addEventListener(
  "click",
  () => {
    loadTradingMonitor(true).catch(() => { });
  }
);

elements.tradingLeague?.addEventListener(
  "change",
  () => {
    state.tradingLeague = elements.tradingLeague.value;
    state.tradingRequest += 1;
    state.tradingMonitor = null;
    state.tradingAgentId = null;
    state.tradingLoading = false;
    loadTradingMonitor(true).catch(() => { });
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

elements.telegramEditCancel?.addEventListener("click", () => {
  state.editingTelegramRecipientId = null;
  elements.telegramEditDialog?.close();
});

elements.telegramEditForm?.addEventListener("submit", async (event) => {
  event.preventDefault();

  const recipientId = state.editingTelegramRecipientId;
  const name = elements.telegramEditName?.value.trim() || "";
  const chatId = elements.telegramEditChatId?.value.trim() || "";
  const audience = getRecipientAudienceValue(true);
  const { isAcesHigh, isBetWar } = audienceToMembershipFlags(audience);

  if (!recipientId) {
    return;
  }

  if (!name || !chatId) {
    elements.telegramEditMessage.textContent =
      "Name and Telegram Chat ID are required.";
    elements.telegramEditMessage.hidden = false;
    return;
  }

  elements.telegramEditSave.disabled = true;
  elements.telegramEditSave.textContent = "Saving...";

  try {
    const response = await fetch("/api/telegram-chats/edit", {
      method: "POST",
      headers: {"Content-Type": "application/json"},
      body: JSON.stringify({
        id: recipientId,
        name,
        chatId,
        isAcesHigh,
        isBetWar,
      }),
    });
    const data = await response.json();

    if (!response.ok) {
      throw new Error(data.error || "Could not update Telegram recipient");
    }

    await loadTelegramChats();
    state.editingTelegramRecipientId = null;
    elements.telegramEditDialog.close();
    showTelegramAlertsMessage(
      `${data.recipient?.name || name} updated.`,
      "success"
    );
  } catch (error) {
    elements.telegramEditMessage.textContent = error.message;
    elements.telegramEditMessage.hidden = false;
  } finally {
    elements.telegramEditSave.disabled = false;
    elements.telegramEditSave.textContent = "Save changes";
  }
});

elements.telegramEditDialog?.addEventListener("close", () => {
  state.editingTelegramRecipientId = null;
  if (elements.telegramEditMessage) {
    elements.telegramEditMessage.textContent = "";
    elements.telegramEditMessage.hidden = true;
  }
});

elements.telegramAlertsForm?.addEventListener(
  "submit",
  async (event) => {
    event.preventDefault();

    const name = elements.telegramAlertName?.value.trim() || "";
    const chatId = elements.telegramAlertChatId?.value.trim() || "";
    const audience = getRecipientAudienceValue(false);
    const { isAcesHigh, isBetWar } = audienceToMembershipFlags(audience);

    if (!name || !chatId) {
      showTelegramAlertsMessage("Enter both a name and Telegram Chat ID.", "error");
      return;
    }
    elements.telegramAlertAdd.disabled = true;
    elements.telegramAlertAdd.textContent = "Adding...";

    try {
      const response = await fetch("/api/telegram-chats", {
        method: "POST",
        headers: {"Content-Type": "application/json"},
        body: JSON.stringify({name, chatId, isAcesHigh, isBetWar}),
      });
      const data = await response.json();

      if (!response.ok) {
        throw new Error(data.error || "Could not add Telegram recipient");
      }

      elements.telegramAlertName.value = "";
      elements.telegramAlertChatId.value = "";
      if (elements.telegramAlertAudience) {
        elements.telegramAlertAudience.value = "all";
      }
      await loadTelegramChats();
      showTelegramAlertsMessage(
        `${data.recipient?.name || name} added for Telegram alerts.`,
        "success"
      );
    } catch (error) {
      showTelegramAlertsMessage(error.message, "error");
    } finally {
      elements.telegramAlertAdd.disabled = false;
      elements.telegramAlertAdd.textContent = "Add Telegram recipient";
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
    state.isSavingChange = true;

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
        "Pick an ET time to create a schedule, or clear the schedule to save immediately."
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

elements.dialog.addEventListener(
  "close",
  () => {
    if (elements.dialog.returnValue === "cancel") {
      for (const change of [...state.pending.values()]) {
        discardPendingChange(change);
      }
    }
    window.setTimeout(() => {
      state.isSavingChange = false;
    }, 0);
  }
);

elements.cancelDialogButton?.addEventListener(
  "click",
  () => {
    elements.dialog.close("cancel");
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

/*
 * The same build runs against more than one site, so anything naming the
 * upstream follows the deployment rather than being written into the markup.
 */

/* The site name for text built at render time. The .partner-name spans are
 * rewritten in place on login; strings assembled in JS need this instead. */
function partnerLabel() {
  return state.partnerName || "Aces High";
}

function applyPartnerName(name) {
  if (!name) {
    return;
  }
  state.partnerName = name;
  for (const node of document.querySelectorAll(".partner-name")) {
    node.textContent = name;
  }
  /* Labels that are attributes rather than text, so a screen reader hears
   * the site this deployment actually manages. */
  for (const node of document.querySelectorAll("[data-partner-aria]")) {
    node.setAttribute(
      "aria-label",
      node.dataset.partnerAria.replace("{name}", name)
    );
  }
  document.title = `${name} Limit Control`;
}

async function startDashboard(sessionData = null) {
  applyPartnerName(sessionData?.partnerName);
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

  if (sessionData) {
    prefetchLeagues(
      Number(
        sessionData.preferences
          ?.selectedAgentId
      ) || Number(sessionData.id)
    );
  }

  loadAgents().catch((error) => {
    showMessage(
      error.message,
      "error"
    );
  });

  loadTelegramChats().catch(() => { });
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
    state.comparisonLeagues = [];
    state.comparisonLeaguesAgentId = null;
    state.comparisonLeague = "";
    state.comparisonLoading = false;
    state.tradingRequest += 1;
    state.tradingMonitor = null;
    state.tradingAgentId = null;
    state.tradingLeagues = [];
    state.tradingLeaguesAgentId = null;
    state.tradingLeague = "";
    state.tradingLoading = false;
    if (tradingRefreshTimer) {
      clearTimeout(tradingRefreshTimer);
      tradingRefreshTimer = null;
    }
    // Drop any league response still in flight for the account that just
    // signed out.
    prefetchedLeagues = null;

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
    elements.comparisonLeague.replaceChildren(new Option("Loading leagues...", ""));
    elements.comparisonLeague.disabled = true;
    elements.tradingRows.replaceChildren();
    elements.tradingEventCount.textContent = "—";
    elements.tradingSuspendedCount.textContent = "—";
    elements.tradingActionCount.textContent = "—";
    elements.tradingLeague.replaceChildren(new Option("Loading leagues...", ""));
    elements.tradingLeague.disabled = true;
    setTradingMessage("");
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
