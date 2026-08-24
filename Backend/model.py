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
    status: Mapped[str] = mapped_column(String(20), default="pending", index=True)
    error: Mapped[str | None] = mapped_column(Text, nullable=True)
    last_run_status: Mapped[str | None] = mapped_column(String(20), nullable=True)
    # Why a run did or did not change anything, e.g. "No change needed,
    # already 500". Distinct from `error`, which is only ever a failure.
    run_note: Mapped[str | None] = mapped_column(String(255), nullable=True)
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

    # Where to read Pinnacle: the OddsPapi league and the period label the
    # samples are stored under.
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
    last_written_value: Mapped[int | None] = mapped_column(BigInteger, nullable=True)
    last_note: Mapped[str | None] = mapped_column(String(255), nullable=True)
    last_checked_at: Mapped[datetime | None] = mapped_column(
        DateTime(timezone=True), nullable=True
    )
    last_written_at: Mapped[datetime | None] = mapped_column(
        DateTime(timezone=True), nullable=True
    )
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=utc_now)
