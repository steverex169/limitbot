/* 11-schedule-cells.js
 * Schedule row cells and grouping: period/last-run wording, status and
 * detail cells, and the cancel/delete actions applied to a group. */

function describeSchedulePeriod(schedule) {
  const periodNumber = Number(schedule.periodNumber || 0);
  return periodNumber ? `Period ${periodNumber}` : "Full game";
}

/*
 * How many times a schedule has fired, and how often that actually moved a
 * limit. Both matter and they are different questions: a recurring schedule
 * doing its job runs every day and correctly changes nothing most of them, so
 * "ran 40 times, changed 3" is healthy while "ran 40 times, changed 0" is
 * worth a look and "not run yet" on a past due time is a fault.
 */
function describeScheduleRuns(schedule) {
  const runs = Number(schedule.runCount) || 0;
  if (!runs) {
    return "";
  }
  const changes = Number(schedule.changeCount) || 0;
  return `${runs} run${runs === 1 ? "" : "s"} · ${changes} changed`;
}

function describeScheduleLastRun(schedule) {
  if (!schedule.lastRunAtUtc && !schedule.lastRunAt) {
    return "Not run yet";
  }

  const when = formatScheduleDateTime(
    schedule.lastRunAtUtc || schedule.lastRunAt
  );
  const lastStatus = String(
    schedule.lastRunStatus || ""
  ).toLowerCase();
  const rowStatus = String(schedule.status || "").toLowerCase();

  /*
   * Status already carries the current state. Repeat the last run's own
   * outcome only when it differs from it — a recurring schedule that is
   * pending again after a failed run is the case worth seeing.
   */
  return lastStatus && lastStatus !== rowStatus
    ? `${lastStatus} · ${when}`
    : when;
}

/*
 * Status says what happened and Last run says when. Detail carries the one
 * thing neither can show: why. A failure explains itself, and a run that
 * completed without changing anything says so rather than looking identical
 * to one that did.
 */
function describeScheduleDetail(schedule) {
  const detail = schedule.error || schedule.runNote || "";
  if (schedule.targetScope !== "all_agents") {
    return detail;
  }
  const scope = `All agents · ${Number(schedule.affectedAgents || 0).toLocaleString()} agents, ${Number(schedule.affectedCustomers || 0).toLocaleString()} customers`;
  return detail ? `${scope} · ${detail}` : scope;
}

/*
 * Status carries a colour so a failed run is visible at a glance rather than
 * being one lowercase word among twelve columns.
 */
function createStatusCell(status) {
  const cell = document.createElement("td");
  const badge = document.createElement("span");
  const value = String(status || "").toLowerCase();
  badge.className = `schedule-status schedule-status-${value || "unknown"}`;
  badge.textContent = value
    ? value.charAt(0).toUpperCase() + value.slice(1)
    : "—";
  cell.append(badge);
  return cell;
}

/*
 * Saving Spread, Money line and Total together writes three rows in
 * scheduled_limits, but it was one decision by one person. The table used to
 * show it as three near-identical lines. Grouping puts it back on one line the
 * way a sportsbook prints a game: the key is every column the rows share, so
 * anything genuinely separate still gets its own line.
 */
const scheduleLimitFields = ["spread", "moneyLine", "total", "teamTotal"];

function scheduleGroupKey(schedule) {
  const created = String(schedule.createdAtUtc || schedule.createdAt || "");
  const createdMinute = created.includes("T")
    ? created.slice(0, 16)
    : created.replace(/:\d{2}(?:\s|$)/, " ").trim();
  return JSON.stringify([
    schedule.activityType || "schedule",
    schedule.accountId,
    schedule.idLeague,
    schedule.idSportType,
    schedule.limitMode || "normal",
    schedule.recurrence || "",
    schedule.scheduledForUtc || schedule.scheduledFor || "",
    createdMinute,
    schedule.customerSupportAgent || "",
    schedule.targetScope || "selected",
  ]);
}

function groupSchedules(schedules) {
  /* A Map keeps insertion order, so the existing sort survives grouping. */
  const groups = new Map();

  for (const schedule of schedules) {
    const key = scheduleGroupKey(schedule);
    const existing = groups.get(key);

    if (existing) {
      existing.push(schedule);
    } else {
      groups.set(key, [schedule]);
    }
  }

  return [...groups.values()];
}

/*
 * Reading order through the week: Monday's schedules before Tuesday's, and
 * within a day the earliest time first. Grouped by creation order, a ramp
 * built in one go came out in whatever order it happened to be written, which
 * says nothing about when any of it runs.
 *
 * A recurring schedule sorts on its first weekday; a one-off on the weekday it
 * actually falls on, so the two interleave rather than forming two lists.
 */
const scheduleWeekdayOrder = ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"];

function scheduleWeekOrder(schedule) {
  const days = Array.isArray(schedule.recurrenceDays)
    ? schedule.recurrenceDays
        .map(Number)
        .filter((day) => Number.isFinite(day))
    : [];

  if (days.length) {
    return [Math.min(...days), schedule.recurrenceTime || "99:99"];
  }

  const when = new Date(schedule.scheduledForUtc || schedule.scheduledFor);
  if (Number.isNaN(when.valueOf())) {
    return [9, "99:99"];
  }

  /* Eastern, because that is the clock every schedule is written in. */
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: "America/New_York",
    weekday: "short",
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
  }).formatToParts(when);
  const lookup = Object.fromEntries(parts.map((part) => [part.type, part.value]));
  const index = scheduleWeekdayOrder.indexOf(lookup.weekday);

  return [
    index === -1 ? 8 : index,
    schedule.recurrenceTime || `${lookup.hour}:${lookup.minute}`,
  ];
}

function sortScheduleGroups(groups) {
  return groups
    .map((group, index) => {
      const first = group[0];
      const [day, time] = scheduleWeekOrder(first);
      return {
        group,
        index,
        /* Anything still to run stays above anything already finished. */
        active: ["pending", "running"].includes(
          String(first.status || "").toLowerCase()
        ),
        day,
        time,
      };
    })
    .sort(
      (a, b) =>
        Number(b.active) - Number(a.active) ||
        a.day - b.day ||
        String(a.time).localeCompare(String(b.time)) ||
        a.index - b.index
    )
    .map((entry) => entry.group);
}

function createLimitValueCell(schedule, field) {
  const cell = document.createElement("td");

  if (field === "teamTotal") {
    cell.classList.add("col-team-total");
  }

  if (!schedule) {
    /* Not part of this schedule at all — distinct from a limit of zero. */
    cell.textContent = "—";
    cell.classList.add("schedule-limit-empty");
    return cell;
  }

  cell.textContent = Number(schedule.value).toLocaleString();
  cell.classList.add("schedule-limit-value");
  return cell;
}

function createMatrixLimitCell(group, field, periodLimits) {
  const matches = group.filter((schedule) =>
    schedule.field === field &&
    (Number(schedule.periodNumber || 0) > 0) === periodLimits
  );
  const cell = document.createElement("td");

  if (field === "teamTotal") {
    cell.classList.add("col-team-total");
  }
  if (!matches.length) {
    cell.textContent = "—";
    cell.classList.add("schedule-limit-empty");
    return cell;
  }

  cell.classList.add("schedule-limit-value");
  const values = [...new Map(matches.map((schedule) => [
    `${schedule.periodNumber || 0}:${schedule.value}`,
    schedule,
  ])).values()];

  for (const [index, schedule] of values.entries()) {
    const line = document.createElement("div");
    line.textContent = periodLimits && values.length > 1
      ? `P${schedule.periodNumber} ${Number(schedule.value).toLocaleString()}`
      : Number(schedule.value).toLocaleString();
    cell.append(line);
    if (index < values.length - 1) {
      line.classList.add("schedule-limit-multiple");
    }
  }
  return cell;
}

function describeScheduleTiming(schedule) {
  if (schedule.activityType === "immediate") {
    return "Immediate";
  }
  if (schedule.recurrence) {
    return schedule.recurrence;
  }
  return `One time · ${formatScheduleDateTime(
    schedule.scheduledForUtc || schedule.scheduledFor
  )}`;
}

/*
 * One badge when the whole group agrees, otherwise one per distinct state so a
 * single failed limit is never hidden behind two successful ones.
 */
function createGroupStatusCell(group) {
  const cell = document.createElement("td");
  const statuses = [
    ...new Set(group.map((item) => String(item.status || "").toLowerCase())),
  ];

  for (const status of statuses) {
    const badge = document.createElement("span");
    badge.className = `schedule-status schedule-status-${status || "unknown"}`;
    badge.textContent = status
      ? status.charAt(0).toUpperCase() + status.slice(1)
      : "—";

    if (statuses.length > 1) {
      badge.title = group
        .filter(
          (item) => String(item.status || "").toLowerCase() === status
        )
        .map((item) => fieldLabels[item.field] || item.field)
        .join(", ");
    }

    cell.append(badge);
  }

  return cell;
}

function createGroupDetailCell(group) {
  const cell = document.createElement("td");
  const notes = group
    .map((item) => ({
      label: fieldLabels[item.field] || item.field,
      text: describeScheduleDetail(item),
    }))
    .filter((note) => note.text);

  if (!notes.length) {
    return cell;
  }

  const distinct = [...new Set(notes.map((note) => note.text))];

  /* The same note on every limit is one sentence, not three. */
  if (distinct.length === 1 && notes.length === group.length) {
    cell.textContent = distinct[0];
    return cell;
  }

  for (const note of notes) {
    const line = document.createElement("div");
    line.className = "schedule-detail-line";
    line.textContent = `${note.label}: ${note.text}`;
    cell.append(line);
  }

  return cell;
}

function describeGroupLastRun(group) {
  return [
    ...new Set(group.map((item) => describeScheduleLastRun(item))),
  ].join(" · ");
}

/*
 * How many times this group has fired, and how often that moved a limit.
 * They answer different questions: a recurring schedule doing its job runs
 * every day and correctly changes nothing on most of them, so "40 runs, 3
 * changed" is healthy, "40 runs, 0 changed" is worth a look, and "never run"
 * against a time that has passed is a fault.
 */
function describeGroupRuns(group) {
  const runs = Math.max(...group.map((item) => Number(item.runCount) || 0));
  if (!runs) {
    return "Never run";
  }
  const changes = Math.max(
    ...group.map((item) => Number(item.changeCount) || 0)
  );
  return (
    `${runs.toLocaleString()} time${runs === 1 ? "" : "s"}` +
    ` · changed a limit ${changes.toLocaleString()} of them`
  );
}

async function postScheduleAction(path, body) {
  const response = await fetch(path, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  const data = await response.json();

  if (!response.ok) {
    throw new Error(data.error || "Could not update schedule");
  }

  return data;
}

/*
 * Each limit is still its own job upstream, so act on them one at a time and
 * report honestly: a group where one delete fails must not claim it removed
 * everything.
 */
async function applyToGroup(group, path, extra = () => ({})) {
  const removed = [];
  let failure = null;

  for (const schedule of group) {
    try {
      await postScheduleAction(path, { id: schedule.id, ...extra(schedule) });
      removed.push(schedule.id);
    } catch (error) {
      failure = failure || error;
    }
  }

  return { removed, failure };
}
