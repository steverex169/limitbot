/* 10-limits-table.js
 * The editable limits table: cell construction, the confirmation dialog
 * trigger, row rendering, period expansion, and the search/type filters. */

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
      typedValue === null ||
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
        /*
         * Typing the value a limit already holds used to be discarded, which
         * is right for saving now - there is nothing to write - but wrong for
         * scheduling. "Set Total to 200 at 10am Monday" is meaningful even
         * when it is 200 today, because a tracker, another schedule or a
         * person may move it before then; that is what pinning it means. It
         * is kept and flagged, and only the schedule path uses it.
         */
        unchanged: typedValue === originalValue,
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

