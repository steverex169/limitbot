from datetime import datetime, timezone

from sqlalchemy import Float, BigInteger, Boolean, DateTime, ForeignKey, Integer, String, Text
from sqlalchemy.dialects.mysql import LONGTEXT
from sqlalchemy.orm import Mapped, mapped_column, relationship

from database import Base


def utc_now():
    return datetime.now(timezone.utc).replace(tzinfo=None)


class User(Base):
    __tablename__ = "users"

    id: Mapped[int] = mapped_column(Integer, primary_key=True)
    accesshigh_agent_id: Mapped[int] = mapped_column(BigInteger, unique=True, index=True)
    username: Mapped[str] = mapped_column(String(100), unique=True, index=True)
    password_hash: Mapped[str] = mapped_column(Text)
    password_encrypted: Mapped[str | None] = mapped_column(Text, nullable=True)
    access_token_encrypted: Mapped[str] = mapped_column(Text)
    selected_agent_id: Mapped[int | None] = mapped_column(BigInteger, nullable=True)
    search_query: Mapped[str] = mapped_column(String(200), default="")
    row_type_filter: Mapped[str] = mapped_column(String(20), default="all")
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=utc_now)
    updated_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), default=utc_now, onupdate=utc_now
    )

    sessions: Mapped[list["LoginSession"]] = relationship(
        back_populates="user", cascade="all, delete-orphan"
    )
    schedules: Mapped[list["ScheduledLimit"]] = relationship(
        back_populates="user", cascade="all, delete-orphan"
    )


class AgentTreeCache(Base):
    """Last known AccessHigh hierarchy for one logged-in agent.

    Rebuilding the tree costs one upstream request per node, so the result is
    stored here and reused across logins and container restarts instead of
    being walked again from scratch every time a user signs in.
    """

    __tablename__ = "agent_tree_cache"

    # The AccessHigh agent id is supplied by the caller, never generated.
    accesshigh_agent_id: Mapped[int] = mapped_column(
        BigInteger, primary_key=True, autoincrement=False
    )
    tree_json: Mapped[str] = mapped_column(Text().with_variant(LONGTEXT, "mysql"))
    agent_count: Mapped[int] = mapped_column(Integer, default=0)
    updated_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), default=utc_now, onupdate=utc_now
    )


class LoginSession(Base):
    __tablename__ = "login_sessions"

    id: Mapped[int] = mapped_column(Integer, primary_key=True)
    user_id: Mapped[int] = mapped_column(ForeignKey("users.id"), index=True)
    token_hash: Mapped[str] = mapped_column(String(64), unique=True, index=True)
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=utc_now)
    last_seen: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=utc_now)
    expires_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), index=True)

    user: Mapped[User] = relationship(back_populates="sessions")


class LimitChange(Base):
    """One row per limit that actually changed.

    A log rather than a counter: it answers how many times a limit has cycled,
    but also when, from what, to what, and whether a person or a schedule did
    it. Skipped saves are deliberately not recorded, so the count reflects
    real changes rather than attempts.
    """

    __tablename__ = "limit_changes"

    id: Mapped[int] = mapped_column(Integer, primary_key=True)
    user_id: Mapped[int | None] = mapped_column(
        ForeignKey("users.id", ondelete="SET NULL"), index=True, nullable=True
    )
    account_id: Mapped[int] = mapped_column(BigInteger, index=True)
    organization_id: Mapped[int] = mapped_column(BigInteger)
    league_id: Mapped[int] = mapped_column(BigInteger)
    sport_type_id: Mapped[int] = mapped_column(BigInteger)
    period_number: Mapped[int] = mapped_column(Integer, default=0)
    field: Mapped[str] = mapped_column(String(20))
    limit_mode: Mapped[str] = mapped_column(String(10), default="normal")
    old_value: Mapped[int | None] = mapped_column(BigInteger, nullable=True)
    new_value: Mapped[int] = mapped_column(BigInteger)
    # "manual" or "schedule", so a hand edit is distinguishable from automation.
    source: Mapped[str] = mapped_column(String(20), default="manual")
    schedule_id: Mapped[str | None] = mapped_column(String(32), nullable=True)
    customer_support_agent: Mapped[str | None] = mapped_column(
        String(100), nullable=True
    )
    target_scope: Mapped[str] = mapped_column(String(20), default="selected")
    affected_agents: Mapped[int | None] = mapped_column(Integer, nullable=True)
    affected_customers: Mapped[int | None] = mapped_column(Integer, nullable=True)
    changed_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), default=utc_now, index=True
    )


class ScheduledLimit(Base):
    __tablename__ = "scheduled_limits"

    id: Mapped[str] = mapped_column(String(32), primary_key=True)
    user_id: Mapped[int] = mapped_column(ForeignKey("users.id"), index=True)
    login_session_id: Mapped[int | None] = mapped_column(
        ForeignKey("login_sessions.id", ondelete="SET NULL"), index=True, nullable=True
    )
    account_id: Mapped[int] = mapped_column(BigInteger, index=True)
    organization_id: Mapped[int] = mapped_column(BigInteger)
    league_id: Mapped[int] = mapped_column(BigInteger)
    sport_type_id: Mapped[int] = mapped_column(BigInteger)
    period_number: Mapped[int] = mapped_column(Integer, default=0)
    field: Mapped[str] = mapped_column(String(20))
    value: Mapped[int] = mapped_column(BigInteger)
    scheduled_for: Mapped[datetime] = mapped_column(DateTime(timezone=True), index=True)
    recurrence_days: Mapped[str | None] = mapped_column(String(20), nullable=True)
    recurrence_time: Mapped[str | None] = mapped_column(String(5), nullable=True)
    telegram_audience: Mapped[str] = mapped_column(String(10), default="all")
    is_early_limit: Mapped[bool] = mapped_column(Boolean, default=False)
    customer_support_agent: Mapped[str | None] = mapped_column(
        String(100), nullable=True
    )
    target_scope: Mapped[str] = mapped_column(String(20), default="selected")
    affected_agents: Mapped[int | None] = mapped_column(Integer, nullable=True)
    affected_customers: Mapped[int | None] = mapped_column(Integer, nullable=True)
    status: Mapped[str] = mapped_column(String(20), default="pending", index=True)
    error: Mapped[str | None] = mapped_column(Text, nullable=True)
    last_run_status: Mapped[str | None] = mapped_column(String(20), nullable=True)
    last_run_changed: Mapped[bool | None] = mapped_column(Boolean, nullable=True)
    # Why a run did or did not change anything, e.g. "No change needed,
    # already 500". Distinct from `error`, which is only ever a failure.
    run_note: Mapped[str | None] = mapped_column(String(255), nullable=True)
    # Every run overwrote the previous one, so a recurring schedule that had
    # fired forty times looked exactly like one that had fired once. Counted
    # separately because "it ran" and "it changed something" are different
    # questions: a healthy schedule often runs and correctly changes nothing.
    run_count: Mapped[int] = mapped_column(Integer, default=0)
    change_count: Mapped[int] = mapped_column(Integer, default=0)
    last_run_at: Mapped[datetime | None] = mapped_column(
        DateTime(timezone=True), nullable=True
    )
    completed_at: Mapped[datetime | None] = mapped_column(
        DateTime(timezone=True), nullable=True
    )
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=utc_now)

    user: Mapped[User] = relationship(back_populates="schedules")

class PinnacleLimitSample(Base):
    """One reading of a Pinnacle limit, with how far the game still is.

    Collected over days these rows give the intraday curve - how much a limit
    grows as a fixture absorbs two-way money. Only the shape transfers to a
    smaller book; the level reflects Pinnacle's own volume and never does.
    """

    __tablename__ = "pinnacle_limit_samples"

    id: Mapped[int] = mapped_column(Integer, primary_key=True, autoincrement=True)
    league: Mapped[str] = mapped_column(String(24), index=True)
    period: Mapped[str] = mapped_column(String(32))
    field: Mapped[str] = mapped_column(String(20))
    fixture_id: Mapped[str] = mapped_column(String(64), index=True)
    hours_to_start: Mapped[float] = mapped_column(Float)
    limit_value: Mapped[float] = mapped_column(Float)
    # The line the limit was posted against - the handicap for a spread, the
    # points for a total. A limit means something different at -3.5 than at
    # -10.5, so a reading kept without its line cannot be read back later.
    line_value: Mapped[float | None] = mapped_column(Float, nullable=True)
    # Which feed the reading came from. The rows collected through OddsPapi are
    # not on the same scale as Pinnacle's own - the aggregator reported 937 and
    # 187 where Pinnacle posts 1,875 and 375, and its baseball readings landed
    # under a "1st Half" period baseball does not have. Blending the two would
    # build a ramp from two different books, so the curve reads one source and
    # the older rows are kept only for reference.
    source: Mapped[str] = mapped_column(String(16), default="pinnacle", index=True)
    sampled_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), index=True
    )


class LimitTracker(Base):
    """One limit that follows Pinnacle live, at a chosen fraction of it.

    Distinct from ScheduledLimit: a schedule writes a fixed number at a fixed
    time, while a tracker writes whatever Pinnacle is at right now, scaled.
    The ramp shape is not configured here - it emerges, because Pinnacle's own
    limit climbs as a fixture takes money.
    """

    __tablename__ = "limit_trackers"

    id: Mapped[str] = mapped_column(String(32), primary_key=True)
    user_id: Mapped[int] = mapped_column(ForeignKey("users.id"), index=True)
    account_id: Mapped[int] = mapped_column(BigInteger, index=True)
    organization_id: Mapped[int] = mapped_column(BigInteger)
    league_id: Mapped[int] = mapped_column(BigInteger)
    sport_type_id: Mapped[int] = mapped_column(BigInteger)
    period_number: Mapped[int] = mapped_column(Integer, default=0)
    field: Mapped[str] = mapped_column(String(20))
    is_early_limit: Mapped[bool] = mapped_column(Boolean, default=False)

    # Where to read Pinnacle: the league slug and the period label, both of
    # which pinnacle_api maps onto Pinnacle's own sport, league and period
    # numbers.
    league_slug: Mapped[str] = mapped_column(String(24), index=True)
    period_label: Mapped[str] = mapped_column(String(32), default="Full Game")
    league_name: Mapped[str | None] = mapped_column(String(120), nullable=True)

    scale_percent: Mapped[int] = mapped_column(Integer, default=50)
    enabled: Mapped[bool] = mapped_column(Boolean, default=True, index=True)
    customer_support_agent: Mapped[str | None] = mapped_column(
        String(100), nullable=True
    )

    # What the last cycle saw and did, so the page can show it without
    # re-reading AccessHigh.
    last_pinnacle_value: Mapped[float | None] = mapped_column(Float, nullable=True)
    last_pinnacle_line: Mapped[float | None] = mapped_column(Float, nullable=True)
    last_pinnacle_event: Mapped[str | None] = mapped_column(
        String(120), nullable=True
    )
    last_written_value: Mapped[int | None] = mapped_column(BigInteger, nullable=True)
    last_note: Mapped[str | None] = mapped_column(String(255), nullable=True)
    last_checked_at: Mapped[datetime | None] = mapped_column(
        DateTime(timezone=True), nullable=True
    )
    last_written_at: Mapped[datetime | None] = mapped_column(
        DateTime(timezone=True), nullable=True
    )
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=utc_now)


class LmAutopilotLeague(Base):
    """One league LM247's per-game autopilot follows Pinnacle on.

    Distinct from LimitTracker, which sets Metalic's one-per-league limit.
    This sets LM247's per-game circled amount, one row per game, from
    Pinnacle's own per-game number - the thing Metalic cannot express. There
    is a row per (store, league); the markets and the share are chosen here,
    and the games come and go on their own as the slate changes.
    """

    __tablename__ = "lm_autopilot_leagues"

    id: Mapped[str] = mapped_column(String(32), primary_key=True)
    store_id: Mapped[int] = mapped_column(Integer, index=True)
    # The Pinnacle league to read, and the LM247 league to write. Kept as two
    # fields because the mapping is by name and a name can change on either
    # side; storing both means a rename breaks loudly rather than silently
    # writing to the wrong board.
    league_slug: Mapped[str] = mapped_column(String(24), index=True)
    lm_league_id: Mapped[int] = mapped_column(Integer)
    league_name: Mapped[str] = mapped_column(String(120))

    enabled: Mapped[bool] = mapped_column(Boolean, default=False, index=True)
    scale_percent: Mapped[int] = mapped_column(Integer, default=70)
    # Which markets to circle, as a comma list of our field names
    # (moneyLine, spread, total, teamTotal). Empty means none.
    markets: Mapped[str] = mapped_column(String(80), default="moneyLine")

    # "all" circles every matched game in the league at scale_percent;
    # "per_game" circles only the games named in selected_games, each at its
    # own share. Per-game is a curated list of this slate's games, since a game
    # number belongs to one slate and next week's games carry new ones.
    mode: Mapped[str] = mapped_column(String(12), default="all")
    # JSON list for per_game mode: [{"gameNumber", "event", "scalePercent"}].
    selected_games: Mapped[str | None] = mapped_column(Text, nullable=True)

    last_run_at: Mapped[datetime | None] = mapped_column(
        DateTime(timezone=True), nullable=True
    )
    last_note: Mapped[str | None] = mapped_column(String(255), nullable=True)
    updated_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), default=utc_now, onupdate=utc_now
    )


class LmAutopilotState(Base):
    """The master switch, one row. Off means the whole autopilot is idle.

    A single well-known row rather than a config file, so the on/off is
    changed from the page and survives a redeploy. The env kill-switch is a
    separate, harder stop for emergencies; this is the everyday control.
    """

    __tablename__ = "lm_autopilot_state"

    id: Mapped[int] = mapped_column(Integer, primary_key=True, default=1)
    enabled: Mapped[bool] = mapped_column(Boolean, default=False)
    updated_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), default=utc_now, onupdate=utc_now
    )


class LmAutopilotChange(Base):
    """One circled-limit change the autopilot actually made.

    The log the operator watches. Written only when a limit truly moved, so a
    cycle that finds everything already correct adds nothing - the same rule
    the Telegram tracker alerts follow, for the same reason: a log that
    records every no-op buries the changes that matter.
    """

    __tablename__ = "lm_autopilot_changes"

    id: Mapped[int] = mapped_column(Integer, primary_key=True, autoincrement=True)
    changed_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), default=utc_now, index=True
    )
    store_id: Mapped[int] = mapped_column(Integer, index=True)
    league_slug: Mapped[str] = mapped_column(String(24), index=True)
    league_name: Mapped[str] = mapped_column(String(120))
    game_number: Mapped[int] = mapped_column(BigInteger)
    event: Mapped[str] = mapped_column(String(160))
    market: Mapped[str] = mapped_column(String(20))
    period: Mapped[int] = mapped_column(Integer, default=0)
    pinnacle_limit: Mapped[float | None] = mapped_column(Float, nullable=True)
    # What Pinnacle was on the previous change, so a row shows the whole move:
    # "Pinnacle 28,000 -> 30,000" rather than just where it landed.
    pinnacle_previous: Mapped[float | None] = mapped_column(Float, nullable=True)
    scale_percent: Mapped[int] = mapped_column(Integer)
    old_value: Mapped[int | None] = mapped_column(Integer, nullable=True)
    new_value: Mapped[int | None] = mapped_column(Integer, nullable=True)
    # "applied", "failed"; skips are not recorded.
    outcome: Mapped[str] = mapped_column(String(16), default="applied")
    note: Mapped[str | None] = mapped_column(String(255), nullable=True)


class BetAlertRule(Base):
    """One agent whose players' bets raise an alert.

    Picked from the agent tree. `cents` is what the alert tells the desk to
    move the line by; `min_risk` lets a rule ignore small tickets. There is no
    master switch: a rule that is enabled is watching, and none enabled means
    the watcher idles.
    """

    __tablename__ = "bet_alert_rules"

    id: Mapped[str] = mapped_column(String(32), primary_key=True)
    agent_id: Mapped[int] = mapped_column(BigInteger, index=True)
    agent_name: Mapped[str] = mapped_column(String(120))
    cents: Mapped[int] = mapped_column(Integer, default=10)
    min_risk: Mapped[int] = mapped_column(Integer, default=0)
    enabled: Mapped[bool] = mapped_column(Boolean, default=True, index=True)
    last_run_at: Mapped[datetime | None] = mapped_column(
        DateTime(timezone=True), nullable=True
    )
    last_note: Mapped[str | None] = mapped_column(String(255), nullable=True)
    updated_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), default=utc_now, onupdate=utc_now
    )


class BetAlertSeen(Base):
    """Every open ticket the watcher has already looked at.

    The pending report has no "since" filter - its date is a paging cursor -
    so a new bet is a ticket number not in this table. Kept in the database
    rather than memory so a restart does not re-alert the whole open book.
    """

    __tablename__ = "bet_alert_seen"

    ticket_number: Mapped[int] = mapped_column(BigInteger, primary_key=True)
    customer_id: Mapped[int] = mapped_column(BigInteger, index=True)
    agent_id: Mapped[int] = mapped_column(BigInteger, index=True)
    placed_at: Mapped[datetime | None] = mapped_column(
        DateTime(timezone=True), nullable=True
    )
    first_seen: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), default=utc_now, index=True
    )
    alerted: Mapped[bool] = mapped_column(Boolean, default=False)


class BetAlertEvent(Base):
    """One alert that was raised - what was bet and what the desk was told."""

    __tablename__ = "bet_alert_events"

    id: Mapped[int] = mapped_column(Integer, primary_key=True, autoincrement=True)
    created_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), default=utc_now, index=True
    )
    ticket_number: Mapped[int] = mapped_column(BigInteger, index=True)
    agent_id: Mapped[int] = mapped_column(BigInteger, index=True)
    agent_name: Mapped[str] = mapped_column(String(120))
    player: Mapped[str] = mapped_column(String(120))
    website: Mapped[str | None] = mapped_column(String(40), nullable=True)
    wager_type: Mapped[str | None] = mapped_column(String(24), nullable=True)
    market: Mapped[str | None] = mapped_column(String(40), nullable=True)
    description: Mapped[str] = mapped_column(String(255))
    matchup: Mapped[str | None] = mapped_column(String(200), nullable=True)
    league: Mapped[str | None] = mapped_column(String(80), nullable=True)
    game_time: Mapped[str | None] = mapped_column(String(40), nullable=True)
    risk: Mapped[float | None] = mapped_column(Float, nullable=True)
    to_win: Mapped[float | None] = mapped_column(Float, nullable=True)
    placed_at: Mapped[str | None] = mapped_column(String(40), nullable=True)
    cents: Mapped[int] = mapped_column(Integer, default=10)
    notified: Mapped[bool] = mapped_column(Boolean, default=False)
    note: Mapped[str | None] = mapped_column(String(255), nullable=True)
