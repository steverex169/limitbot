/* 18-save-actions.js
 * Writing limits back: saving one change, saving a pending batch, and
 * creating a recurring schedule. */

function getRequiredCustomerSupportAgent() {
  const customerSupportAgent =
    elements.customerSupportAgent?.value.trim() || "";

  if (!customerSupportAgent) {
    showDialogMessage("Enter the Customer Support Agent name.");
    elements.customerSupportAgent?.focus();
    return null;
  }

  if (customerSupportAgent.length > 100) {
    showDialogMessage(
      "Customer Support Agent name must be 100 characters or fewer."
    );
    elements.customerSupportAgent?.focus();
    return null;
  }

  return customerSupportAgent;
}

function getLimitTargetScope() {
  return elements.limitTargetScopes?.find((input) => input.checked)?.value ||
    "selected";
}

function serializeHierarchyChanges(batch) {
  return batch.map((item) => ({
    accountId: item.row.accountId,
    idOrganization: item.row.idOrganization,
    idLeague: item.row.idLeague,
    idSportType: item.row.idSportType,
    periodNumber: item.row.periodNumber || 0,
    field: item.field,
    value: item.newValue,
    limitMode: item.mode === "early" ? "early" : "normal",
  }));
}

async function saveHierarchyBatch(batch, customerSupportAgent) {
  clearDialogMessage();
  elements.confirmSave.disabled = true;
  elements.confirmSchedule.disabled = true;
  elements.confirmSave.textContent = "Checking impact…";

  try {
    const changes = serializeHierarchyChanges(batch);
    const previewResponse = await fetch("/api/limits/hierarchy/preview", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ changes, customerSupportAgent }),
    });
    const preview = await previewResponse.json();
    if (!previewResponse.ok) {
      throw new Error(preview.error || "The affected agents could not be checked");
    }

    const affectedAgents = Number(preview.affectedAgents || 0);
    const affectedCustomers = Number(preview.affectedCustomers || 0);
    const confirmed = window.confirm(
      `Apply ${batch.length} limit ${batch.length === 1 ? "change" : "changes"} to all agents?\n\n` +
      `${affectedAgents.toLocaleString()} agents and ${affectedCustomers.toLocaleString()} customers are affected. ` +
      "The main agent and all subagents are included; player overrides are not overwritten."
    );
    if (!confirmed) {
      return;
    }

    elements.confirmSave.textContent = "Saving to all agents…";
    const saveResponse = await fetch("/api/limits/hierarchy", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ confirmationToken: preview.confirmationToken }),
    });
    const result = await saveResponse.json();
    if (!saveResponse.ok) {
      throw new Error(result.error || "The all-agent update failed");
    }

    leagueDataVersion += 1;
    batch.forEach((item) => {
      const savedField = getModeFieldKey(
        item.field,
        item.mode === "early" ? "early" : "normal"
      );
      applySavedValueToRows(item.row, savedField, item.newValue);
      setInputValueForChange(item, item.newValue);
      removePendingChange(item);
    });
    state.activeChange = null;
    state.pendingSaveBatch = [];
    elements.dialog.close();
    applyFilters();

    const outcome =
      `Updated ${batch.length} limit ${batch.length === 1 ? "value" : "values"} for ` +
      `${Number(result.affectedAgents || affectedAgents).toLocaleString()} agents. ` +
      "Player overrides were left unchanged.";
    loadLeagues(false)
      .catch(() => {})
      .finally(() => showMessage(outcome, "success"));
  } catch (error) {
    showDialogMessage(error.message);
  } finally {
    elements.confirmSave.disabled = false;
    elements.confirmSchedule.disabled = false;
    elements.confirmSave.textContent =
      `Save to ${state.partnerName || "Aces High"}`;
  }
}

async function saveActiveChange() {
  const everything =
    Array.isArray(state.pendingSaveBatch) &&
    state.pendingSaveBatch.length
      ? state.pendingSaveBatch
      : state.activeChange
        ? [state.activeChange]
        : [];

  /*
   * A value that already matches is kept so it can be scheduled, but writing
   * it now would spend a request to change nothing. Saving skips those.
   */
  const batch = everything.filter((change) => !change.unchanged);

  if (!batch.length && everything.length) {
    showDialogMessage(
      everything.length === 1
        ? "That limit is already at this value. Use Schedule to pin it for later."
        : "Those limits are already at these values. Use Schedule to pin them for later."
    );
    return;
  }

  if (!batch.length) {
    return;
  }

  const customerSupportAgent = getRequiredCustomerSupportAgent();
  if (!customerSupportAgent) {
    return;
  }

  if (getLimitTargetScope() === "all") {
    return saveHierarchyBatch(batch, customerSupportAgent);
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
          customerSupportAgent,
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

  const customerSupportAgent = getRequiredCustomerSupportAgent();
  if (!customerSupportAgent) {
    return;
  }

  if (getLimitTargetScope() === "all") {
    return saveHierarchyBatch(batch, customerSupportAgent);
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
              customerSupportAgent,
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

async function scheduleHierarchyBatch(
  batch,
  customerSupportAgent,
  recurrenceDays,
  selectedTime,
  oneTimeSchedule
) {
  clearDialogMessage();
  elements.confirmSchedule.disabled = true;
  elements.confirmSave.disabled = true;
  elements.confirmSchedule.textContent = "Checking impact…";

  try {
    const changes = serializeHierarchyChanges(batch);
    const previewResponse = await fetch("/api/limits/hierarchy/preview", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ changes, customerSupportAgent }),
    });
    const preview = await previewResponse.json();
    if (!previewResponse.ok) {
      throw new Error(preview.error || "The affected agents could not be checked");
    }

    const affectedAgents = Number(preview.affectedAgents || 0);
    const affectedCustomers = Number(preview.affectedCustomers || 0);
    const timing = oneTimeSchedule
      ? `one time at ${selectedTime} ET`
      : `on the selected days at ${selectedTime} ET`;
    const confirmed = window.confirm(
      `Schedule ${batch.length} limit ${batch.length === 1 ? "change" : "changes"} for all agents ${timing}?\n\n` +
      `${affectedAgents.toLocaleString()} agents and ${affectedCustomers.toLocaleString()} customers are currently affected. ` +
      "Each run uses the latest agent hierarchy; player overrides are not overwritten."
    );
    if (!confirmed) {
      return;
    }

    elements.confirmSchedule.textContent = "Scheduling for all agents…";
    const response = await fetch("/api/schedules/hierarchy", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        confirmationToken: preview.confirmationToken,
        recurrenceDays,
        recurrenceTime: selectedTime,
        oneTimeSchedule,
      }),
    });
    const data = await response.json();
    if (!response.ok) {
      throw new Error(data.error || "The all-agent schedule could not be created");
    }

    batch.forEach(removePendingChange);
    state.activeChange = null;
    state.pendingSaveBatch = [];
    elements.dialog.close();

    const item = batch[0];
    showScheduleStatus(
      "pending",
      `${item.row.leagueName} · All agents`,
      item.newValue,
      formatEasternDateTime(data.scheduledForUtc || data.scheduledFor),
      fieldLabels[item.field],
      data.recurrence,
      formatEasternDateTime(data.scheduledForUtc || data.scheduledFor)
    );
    showMessage(
      `${data.created || batch.length} all-agent limit ${batch.length === 1 ? "change" : "changes"} scheduled. ` +
      `Current impact: ${affectedAgents.toLocaleString()} agents, ${affectedCustomers.toLocaleString()} customers.`,
      "success"
    );
  } catch (error) {
    showDialogMessage(error.message);
  } finally {
    elements.confirmSchedule.disabled = false;
    elements.confirmSave.disabled = false;
    elements.confirmSchedule.textContent = "Schedule";
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
  const customerSupportAgent = getRequiredCustomerSupportAgent();
  if (!customerSupportAgent) {
    return;
  }

  if (!selectedTime) {
    showDialogMessage("Select an ET time first.");
    return;
  }

  const oneTimeSchedule = recurrenceDays.length === 0;

  if (oneTimeSchedule && getLimitTargetScope() !== "all") {
    if (
      !window.confirm(
        `This limit will change one time at ${selectedTime} ET and will not repeat. Continue?`
      )
    ) {
      return;
    }
  }

  if (getLimitTargetScope() === "all") {
    return scheduleHierarchyBatch(
      batch,
      customerSupportAgent,
      recurrenceDays,
      selectedTime,
      oneTimeSchedule
    );
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
