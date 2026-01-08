"""
Database module for Codag authentication and trial tracking.
Uses async SQLAlchemy with PostgreSQL.
"""
from datetime import datetime, date
from typing import Optional
import uuid

from sqlalchemy import Column, String, Boolean, Integer, Date, DateTime, ForeignKey, UniqueConstraint
from sqlalchemy.dialects.postgresql import UUID
from sqlalchemy.ext.asyncio import create_async_engine, AsyncSession
from sqlalchemy.orm import sessionmaker, declarative_base, relationship

from config import settings

# Create async engine
engine = create_async_engine(
    settings.database_url,
    echo=False,
    pool_pre_ping=True,
    pool_size=20,
    max_overflow=30,
)

# Async session factory
AsyncSessionLocal = sessionmaker(
    engine,
    class_=AsyncSession,
    expire_on_commit=False,
)

Base = declarative_base()


class UserDB(Base):
    """OAuth-authenticated user accounts."""
    __tablename__ = "users"

    id = Column(UUID(as_uuid=True), primary_key=True, default=uuid.uuid4)
    email = Column(String(255), unique=True, nullable=False, index=True)
    name = Column(String(255), nullable=True)
    provider = Column(String(50), nullable=False)  # 'github' | 'google'
    provider_id = Column(String(255), nullable=False)
    is_paid = Column(Boolean, default=False)
    created_at = Column(DateTime, default=datetime.utcnow)
    last_login_at = Column(DateTime, nullable=True)

    # Relationship to linked trial devices
    devices = relationship("TrialDeviceDB", back_populates="user")

    __table_args__ = (
        UniqueConstraint('provider', 'provider_id', name='uq_provider_id'),
    )


class TrialDeviceDB(Base):
    """Anonymous trial device tracking via machineId."""
    __tablename__ = "trial_devices"

    id = Column(UUID(as_uuid=True), primary_key=True, default=uuid.uuid4)
    machine_id = Column(String(255), unique=True, nullable=False, index=True)
    analyses_today = Column(Integer, default=0)
    last_analysis_date = Column(Date, nullable=True)
    first_seen_at = Column(DateTime, default=datetime.utcnow)

    # Optional link to user after OAuth signup
    user_id = Column(UUID(as_uuid=True), ForeignKey('users.id', ondelete='SET NULL'), nullable=True)
    user = relationship("UserDB", back_populates="devices")


async def get_db():
    """Dependency for FastAPI routes to get async DB session."""
    async with AsyncSessionLocal() as session:
        try:
            yield session
        finally:
            await session.close()


async def init_db():
    """Create all tables. Call on startup."""
    async with engine.begin() as conn:
        await conn.run_sync(Base.metadata.create_all)


async def get_or_create_trial_device(
    session: AsyncSession,
    machine_id: str
) -> tuple["TrialDeviceDB", int]:
    """
    Get or create a trial device record.
    Returns (device, remaining_analyses).
    Resets counter if it's a new day.
    """
    from sqlalchemy import select

    result = await session.execute(
        select(TrialDeviceDB).where(TrialDeviceDB.machine_id == machine_id)
    )
    device = result.scalar_one_or_none()

    today = date.today()

    if device is None:
        # New device
        device = TrialDeviceDB(
            machine_id=machine_id,
            analyses_today=0,
            last_analysis_date=today,
        )
        session.add(device)
        await session.commit()
        await session.refresh(device)
        remaining = settings.free_trial_requests_per_day
    else:
        # Existing device - check if we need to reset daily counter
        if device.last_analysis_date != today:
            device.analyses_today = 0
            device.last_analysis_date = today
            await session.commit()
            await session.refresh(device)

        remaining = max(0, settings.free_trial_requests_per_day - device.analyses_today)

    return device, remaining


async def increment_trial_usage(
    session: AsyncSession,
    machine_id: str
) -> int:
    """
    Increment usage for a trial device.
    Returns remaining analyses after increment.
    Raises ValueError if quota exhausted.
    """
    device, remaining = await get_or_create_trial_device(session, machine_id)

    if remaining <= 0:
        raise ValueError("Trial quota exhausted")

    device.analyses_today += 1
    await session.commit()

    return remaining - 1


async def get_or_create_user(
    session: AsyncSession,
    email: str,
    name: Optional[str],
    provider: str,
    provider_id: str,
) -> "UserDB":
    """
    Get or create a user from OAuth data.
    Updates last_login_at on each call.
    """
    from sqlalchemy import select

    result = await session.execute(
        select(UserDB).where(
            UserDB.provider == provider,
            UserDB.provider_id == provider_id
        )
    )
    user = result.scalar_one_or_none()

    if user is None:
        # Check if email already exists (different provider)
        email_result = await session.execute(
            select(UserDB).where(UserDB.email == email)
        )
        existing_email_user = email_result.scalar_one_or_none()

        if existing_email_user:
            # Update existing user with new provider info
            # (This allows linking multiple OAuth providers to same email)
            user = existing_email_user
            # Don't overwrite provider info - keep original
        else:
            # Create new user
            user = UserDB(
                email=email,
                name=name,
                provider=provider,
                provider_id=provider_id,
            )
            session.add(user)

    user.last_login_at = datetime.utcnow()
    if name and not user.name:
        user.name = name

    await session.commit()
    await session.refresh(user)
    return user


async def link_device_to_user(
    session: AsyncSession,
    machine_id: str,
    user_id: uuid.UUID
) -> Optional["TrialDeviceDB"]:
    """
    Link a trial device to an authenticated user.
    Called after OAuth signup to transfer device history.
    """
    from sqlalchemy import select

    result = await session.execute(
        select(TrialDeviceDB).where(TrialDeviceDB.machine_id == machine_id)
    )
    device = result.scalar_one_or_none()

    if device:
        device.user_id = user_id
        await session.commit()
        await session.refresh(device)

    return device
