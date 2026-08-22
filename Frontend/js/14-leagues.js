/* 14-leagues.js
 * Loading league rows and schedules for the selected agent. */

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

