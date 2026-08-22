/* 01-state.js
 * Shared mutable state, localStorage keys, the debounce/refresh timers,
 * and the league prefetch that starts before the dashboard renders. */

const state = {
  trackers: [],
  trackerHistory: [],
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
  pinnacleComparisonEnabled: true,
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
