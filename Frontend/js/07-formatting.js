/* 07-formatting.js
 * Field labels, normal/early limit-mode helpers, the US Eastern date and
 * time formatters, and the schedule time picker. */

const fieldLabels = {
  spread: "Spread",
  moneyLine: "Money line",
  total: "Total",
  teamTotal: "Team total",
};

const fieldApiNames = {
  spread: "Spread",
  moneyLine: "MoneyLine",
  total: "Total",
  teamTotal: "TeamTotal",
};

function getSelectedLimitMode() {
  return elements.limitModeFilter?.value === "early"
    ? "early"
    : "normal";
}

function getModeFieldKey(field, mode = getSelectedLimitMode()) {
  const apiName = fieldApiNames[field] || field;
  return mode === "early" ? `early${apiName}` : field;
}

function getModeFieldValue(row, field, mode = getSelectedLimitMode()) {
  const modeKey = getModeFieldKey(field, mode);

  // Normal and Early limits are independent values. Never fall back from an
  // Early field to the Normal field, otherwise a Normal change can appear in
  // the Early-limits view even though the Early value was never changed.
  if (mode === "early") {
    return row?.[modeKey] ?? null;
  }

  return row?.[field] ?? null;
}

function rowSupportsEarlyMode(row) {
  return row?.supportsEarlyLimit === true;
}

function getPendingChangesForMode(mode) {
  return [...state.pending.values()].filter(
    (change) => (change.mode || "normal") === mode
  );
}

const easternDateTimeFormatter = new Intl.DateTimeFormat(
  "en-US",
  {
    timeZone: "America/New_York",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    hour12: true,
    timeZoneName: "short",
  }
);

/*
 * The schedules table prints four timestamps per row across fifteen columns.
 * Repeating "2026" and "EST" in each of them pushed Status and Detail off the
 * side of the screen, so here the year is two digits and the zone is named
 * once, in the column heading.
 */
const easternCompactFormatter = new Intl.DateTimeFormat("en-US", {
  timeZone: "America/New_York",
  year: "2-digit",
  month: "2-digit",
  day: "2-digit",
  hour: "2-digit",
  minute: "2-digit",
  hour12: true,
});

function formatScheduleDateTime(value) {
  if (!value) {
    return "";
  }

  /* A value the server already formatted: drop the zone and the century. */
  if (typeof value === "string" && /\b(?:ET|EST|EDT)\b/.test(value)) {
    return value
      .replace(/\s*\b(?:ET|EST|EDT)\b/g, "")
      .replace(/\b(\d{2})\/(\d{2})\/\d{2}(\d{2})\b/, "$1/$2/$3")
      .trim();
  }

  const parsed = new Date(value);

  if (Number.isNaN(parsed.getTime())) {
    return String(value);
  }

  return easternCompactFormatter.format(parsed).replace(", ", " ");
}

function formatEasternDateTime(value) {
  if (!value) {
    return "";
  }

  /*
   * The desk works in "EST" as the name of the zone, so the label is fixed
   * while the clock time stays true New York local time — the same instant
   * the schedule actually runs at, daylight saving included. Only the
   * abbreviation is decided here.
   */
  if (
    typeof value === "string" &&
    /\b(?:ET|EST|EDT)\b/.test(value)
  ) {
    return value.replace(/\bEDT\b/g, "EST");
  }

  const parsed = new Date(value);

  if (Number.isNaN(parsed.getTime())) {
    return String(value);
  }

  return easternDateTimeFormatter
    .format(parsed)
    .replace(", ", " ")
    .replace(/\bEDT\b/g, "EST");
}

const easternTimeFormatter = new Intl.DateTimeFormat(
  "en-US",
  {
    timeZone: "America/New_York",
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
  }
);

function getEasternTimeValue(date = new Date()) {
  const parts = easternTimeFormatter.formatToParts(date);
  const hourPart = parts.find((part) => part.type === "hour")?.value || "00";
  const minutePart = parts.find((part) => part.type === "minute")?.value || "00";

  return `${String(Number(hourPart)).padStart(2, "0")}:${String(Number(minutePart)).padStart(2, "0")}`;
}

function populateScheduleTimePicker() {
  if (elements.scheduleHour?.options.length === 1) {
    for (let hour = 1; hour <= 12; hour += 1) {
      const option = document.createElement("option");
      option.value = String(hour).padStart(2, "0");
      option.textContent = String(hour).padStart(2, "0");
      elements.scheduleHour.append(option);
    }
  }

  if (elements.scheduleMinute?.options.length === 1) {
    for (let minute = 0; minute < 60; minute += 1) {
      const option = document.createElement("option");
      option.value = String(minute).padStart(2, "0");
      option.textContent = String(minute).padStart(2, "0");
      elements.scheduleMinute.append(option);
    }
  }

  /*
   * Nearly every schedule is on the hour, and leaving the minutes empty meant
   * picking "10" and "AM" still produced "Select an ET time first" - an error
   * about a field the operator had no reason to think was unfinished. Choosing
   * an hour fills the minutes, and a different minute can still be chosen.
   */
  if (elements.scheduleHour && !elements.scheduleHour.dataset.minuteDefault) {
    elements.scheduleHour.dataset.minuteDefault = "on";
    elements.scheduleHour.addEventListener("change", () => {
      if (elements.scheduleHour.value && !elements.scheduleMinute?.value) {
        elements.scheduleMinute.value = "00";
      }
    });

    /* A complaint about a missing time should go away when a time is given,
     * rather than sitting there red while the dialog is plainly now valid. */
    for (const control of [
      elements.scheduleHour,
      elements.scheduleMinute,
      elements.schedulePeriod,
    ]) {
      control?.addEventListener("change", () => {
        if (getSelectedScheduleTime()) {
          clearDialogMessage();
        }
      });
    }
  }
}

function getSelectedScheduleTime() {
  const hour = elements.scheduleHour?.value || "";
  const minute = elements.scheduleMinute?.value || "";
  const period = elements.schedulePeriod?.value || "";

  if (!hour || !minute || !period) {
    return "";
  }

  let hourNumber = Number(hour);

  if (period === "AM") {
    hourNumber = hourNumber === 12 ? 0 : hourNumber;
  } else {
    hourNumber = hourNumber === 12 ? 12 : hourNumber + 12;
  }

  return `${String(hourNumber).padStart(2, "0")}:${minute}`;
}

populateScheduleTimePicker();

function clearScheduleOptions() {
  elements.scheduleDays.forEach((input) => {
    input.checked = false;
  });

  if (elements.scheduleAllDays) {
    elements.scheduleAllDays.checked = false;
    elements.scheduleAllDays.indeterminate = false;
  }

  if (elements.scheduleHour) {
    elements.scheduleHour.value = "";
  }

  if (elements.scheduleMinute) {
    elements.scheduleMinute.value = "";
  }

  if (elements.schedulePeriod) {
    elements.schedulePeriod.value = "";
  }

  if (elements.customerSupportAgent) {
    elements.customerSupportAgent.value = "";
  }

  elements.limitTargetScopes?.forEach((input) => {
    input.checked = input.value === "selected";
  });

  clearDialogMessage();
}
