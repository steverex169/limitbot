/* 20-session.js
 * Session bootstrap: login/logout, partner naming, starting the
 * dashboard, and the session poll that keeps it alive. */

function showLogin(message) {
  document.body.classList.remove(
    "app-loading"
  );

  elements.loginView.hidden = false;
  elements.dashboardHeader.hidden = true;
  elements.dashboardSidebar.hidden = true;
  elements.dashboardView.hidden = true;
  elements.password.value = "";
  if (message && elements.loginMessage) {
    elements.loginMessage.textContent = message;
    elements.loginMessage.hidden = false;
  }
}

/*
 * A session that expires while the tab is open used to be invisible. Every
 * poll 401'd into an empty catch, the numbers on screen stayed as they were,
 * and saving did nothing at all - no request, no error. One tab sat like that
 * for twelve hours; a College Football schedule was written, saved, and never
 * existed, and there was no way to tell from the page.
 *
 * Wrapping fetch rather than fixing the call sites is deliberate: there are
 * two dozen of them, several already swallow errors on purpose, and a new one
 * would have to remember. The session is a property of the page, so the page
 * handles it in one place.
 */
(function watchForExpiredSession() {
  const nativeFetch = window.fetch.bind(window);
  window.fetch = async function (input, init) {
    const response = await nativeFetch(input, init);
    const url = String(
      (input && input.url) || input || ""
    );
    /* Only our own API, and never the login call itself - a wrong password is
       also a 401, and it has its own message to show. */
    if (
      response.status === 401 &&
      url.includes("/api/") &&
      !url.includes("/api/login") &&
      !url.includes("/api/session") &&
      elements.loginView &&
      elements.loginView.hidden
    ) {
      showLogin("Your session expired. Sign in again to continue.");
    }
    return response;
  };
})();

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

function applyDeploymentFeatures(sessionData) {
  state.pinnacleComparisonEnabled =
    sessionData?.pinnacleComparisonEnabled !== false;
  state.tradingMonitorEnabled =
    sessionData?.tradingMonitorEnabled !== false;
  state.telegramSite = sessionData?.telegramSite || "aceshigh";

  if (elements.pinnacleComparisonLink) {
    elements.pinnacleComparisonLink.hidden =
      !state.pinnacleComparisonEnabled;
  }
  if (elements.tradingMonitorLink) {
    elements.tradingMonitorLink.hidden = !state.tradingMonitorEnabled;
  }

  const betwarTelegram = state.telegramSite === "betwar";
  if (elements.telegramAlertAudience) {
    elements.telegramAlertAudience.hidden = betwarTelegram;
    elements.telegramAlertAudience.value = betwarTelegram ? "betwar" : "all";
  }
  if (elements.telegramEditAudience) {
    elements.telegramEditAudience.hidden = betwarTelegram;
  }
  if (elements.telegramMembershipHeader) {
    elements.telegramMembershipHeader.textContent =
      betwarTelegram ? "Alerts from" : "Membership";
  }

  if (
    !state.pinnacleComparisonEnabled &&
    isPinnacleComparisonRoute()
  ) {
    window.history.replaceState({}, "", "/");
  }
  if (!state.tradingMonitorEnabled && isTradingMonitorRoute()) {
    window.history.replaceState({}, "", "/");
  }
}

async function startDashboard(sessionData = null) {
  applyPartnerName(sessionData?.partnerName);
  applyDeploymentFeatures(sessionData);
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

/*
 * A tab left open runs whatever script it loaded, however long ago. Reloading
 * picks up a new build; a tab nobody reloads never asks. That is how a limit
 * change was posted without the Customer Support Agent field - the script
 * predated it, the server had come to require it, and the save was refused
 * with nothing on screen to suggest the page itself was the problem.
 *
 * The script is stamped with an id built from its own sources. When the server
 * reports a different one, this page is out of date and says so.
 */
function warnIfBuildIsStale(buildId) {
  if (
    !buildId ||
    typeof APP_BUILD_ID === "undefined" ||
    buildId === APP_BUILD_ID ||
    document.getElementById("staleBuildNotice")
  ) {
    return;
  }
  const notice = document.createElement("div");
  notice.id = "staleBuildNotice";
  notice.className = "stale-build-notice";
  notice.setAttribute("role", "alert");
  notice.textContent =
    "This page is running an older version and saving may fail. ";
  const reload = document.createElement("button");
  reload.type = "button";
  reload.textContent = "Reload now";
  reload.addEventListener("click", () => window.location.reload());
  notice.append(reload);
  document.body.append(notice);
}

setInterval(async () => {
  try {
    const response = await fetch("/api/session", { cache: "no-store" });
    if (!response.ok) {
      return;
    }
    warnIfBuildIsStale((await response.json()).buildId);
  } catch {
    /* Offline or mid-deploy. The next tick asks again. */
  }
}, 60000);
