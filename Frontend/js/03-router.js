/* 03-router.js
 * Client-side routing. One predicate per route plus applyDashboardRoute(),
 * which shows the matching section and marks the active sidebar link. */

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
  const comparisonActive =
    state.pinnacleComparisonEnabled && isPinnacleComparisonRoute();
  const tradingActive =
    state.tradingMonitorEnabled && isTradingMonitorRoute();
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
