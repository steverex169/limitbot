/* 15-agents.js
 * The agent tree: loading, rendering, keyboard/expand handling, search,
 * and selecting an agent. */

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

