/* 08-pending-changes.js
 * Row identity and parent-limit resolution, the league dropdown, and the
 * pending-edit buffer persisted to localStorage across reloads. */

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

