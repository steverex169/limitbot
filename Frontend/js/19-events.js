/* 19-events.js
 * Event wiring: sidebar navigation, filters, dialogs, and the theme
 * toggle. Runs after every handler above is defined. */

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

function syncAllScheduleDays() {
  if (!elements.scheduleAllDays) {
    return;
  }

  const selectedCount = elements.scheduleDays.filter(
    (input) => input.checked
  ).length;

  elements.scheduleAllDays.checked =
    selectedCount === elements.scheduleDays.length;
  elements.scheduleAllDays.indeterminate =
    selectedCount > 0 && selectedCount < elements.scheduleDays.length;
}

elements.scheduleAllDays?.addEventListener(
  "change",
  () => {
    const checked = elements.scheduleAllDays.checked;
    elements.scheduleDays.forEach((input) => {
      input.checked = checked;
    });
    elements.scheduleAllDays.indeterminate = false;
  }
);

elements.scheduleDays.forEach((input) => {
  input.addEventListener("change", syncAllScheduleDays);
});

elements.closeScheduleStatus.addEventListener(
  "click",
  closeScheduleStatusDialog
);

elements.scheduleStatusDialog.addEventListener(
  "close",
  () => {
    if (scheduleStatusDismissTimer) {
      window.clearTimeout(scheduleStatusDismissTimer);
      scheduleStatusDismissTimer = null;
    }
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
