/* 11-schedule-cells.js
 * Schedule row cells and grouping: period/last-run wording, status and
 * detail cells, and the cancel/delete actions applied to a group. */

function describeSchedulePeriod(schedule) {
  const periodNumber = Number(schedule.periodNumber || 0);
  return periodNumber ? `Period ${periodNumber}` : "Full game";
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
  return JSON.stringify([
    schedule.activityType || "schedule",
    schedule.accountId,
    schedule.idOrganization,
    schedule.idLeague,
    schedule.idSportType,
    schedule.periodNumber || 0,
    schedule.limitMode || "normal",
    schedule.recurrence || "",
    schedule.scheduledForUtc || schedule.scheduledFor || "",
    schedule.createdAtUtc || schedule.createdAt || "",
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
