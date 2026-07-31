from datetime import datetime, timezone

from sqlalchemy import BigInteger, Boolean, DateTime, ForeignKey, Integer, String, Text
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


class LoginSession(Base):
    __tablename__ = "login_sessions"

    id: Mapped[int] = mapped_column(Integer, primary_key=True)
    user_id: Mapped[int] = mapped_column(ForeignKey("users.id"), index=True)
    token_hash: Mapped[str] = mapped_column(String(64), unique=True, index=True)
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=utc_now)
    last_seen: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=utc_now)
    expires_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), index=True)

    user: Mapped[User] = relationship(back_populates="sessions")


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
    is_early_limit: Mapped[bool] = mapped_column(Boolean, default=False)
    status: Mapped[str] = mapped_column(String(20), default="pending", index=True)
    error: Mapped[str | None] = mapped_column(Text, nullable=True)
    last_run_status: Mapped[str | None] = mapped_column(String(20), nullable=True)
    last_run_at: Mapped[datetime | None] = mapped_column(
        DateTime(timezone=True), nullable=True
    )
    completed_at: Mapped[datetime | None] = mapped_column(
        DateTime(timezone=True), nullable=True
    )
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=utc_now)

    user: Mapped[User] = relationship(back_populates="schedules")
