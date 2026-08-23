/* 17-schedule-status.js
 * Polling scheduled limit runs and the status dialog that reports them. */

let scheduleStatusDismissTimer = null;

function closeScheduleStatusDialog() {
  if (scheduleStatusDismissTimer) {
    window.clearTimeout(scheduleStatusDismissTimer);
    scheduleStatusDismissTimer = null;
  }

  if (elements.scheduleStatusDialog?.open) {
    elements.scheduleStatusDialog.close();
  }
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
  if (scheduleStatusDismissTimer) {
    window.clearTimeout(scheduleStatusDismissTimer);
    scheduleStatusDismissTimer = null;
  }

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

  /*
   * This dialog is an acknowledgement, not a progress lock. A pending
   * recurring schedule may not run for days, so leaving a modal open until
   * then makes the dashboard appear frozen. Keep it long enough to read and
   * let the status table continue reporting the schedule after it closes.
   */
  scheduleStatusDismissTimer = window.setTimeout(
    closeScheduleStatusDialog,
    successful || failed || skipped ? 8000 : 5000
  );
}
