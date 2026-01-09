"""
Database module for Codag authentication and trial tracking.
Uses async SQLAlchemy with PostgreSQL.
"""
from datetime import datetime, date, timezone
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
    created_at = Column(DateTime(timezone=True), default=lambda: datetime.now(timezone.utc))
    last_login_at = Column(DateTime(timezone=True), nullable=True)
    
    # Secure refresh token storage
    hashed_refresh_token = Column(String(255), nullable=True)  # SHA-256 hash of refresh token
    token_family = Column(UUID(as_uuid=True), nullable=True)  # For rotation tracking
    token_version = Column(Integer, default=0)  # Increment on rotation to invalidate old tokens

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
    first_seen_at = Column(DateTime(timezone=True), default=lambda: datetime.now(timezone.utc))

    # Optional link to user after OAuth signup
    user_id = Column(UUID(as_uuid=True), ForeignKey('users.id', ondelete='SET NULL'), nullable=True)
    user = relationship("UserDB", back_populates="devices")


class BatchUsageDB(Base):
    """Track batch IDs to prevent multiple analyses for same batch."""
    __tablename__ = "batch_usage"

    id = Column(UUID(as_uuid=True), primary_key=True, default=uuid.uuid4)
    machine_id = Column(String(255), nullable=False, index=True)
    batch_id = Column(String(255), nullable=False)
    usage_date = Column(Date, nullable=False)
    created_at = Column(DateTime(timezone=True), default=lambda: datetime.now(timezone.utc))

    __table_args__ = (
        UniqueConstraint('machine_id', 'batch_id', 'usage_date', name='uq_batch_usage_per_day'),
    )


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

    user.last_login_at = datetime.now(timezone.utc)
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


async def check_and_record_batch_usage(
    session: AsyncSession,
    machine_id: str,
    batch_id: str
) -> bool:
    """Check if a batch was already used today and record it if not.
    
    Args:
        session: Database session
        machine_id: Device machine ID
        batch_id: Unique batch identifier
    
    Returns:
        True if batch was already used today, False if this is first use
    """
    from sqlalchemy import select
    
    today = date.today()
    
    # Check if this batch was already used today
    result = await session.execute(
        select(BatchUsageDB).where(
            BatchUsageDB.machine_id == machine_id,
            BatchUsageDB.batch_id == batch_id,
            BatchUsageDB.usage_date == today
        )
    )
    existing = result.scalar_one_or_none()
    
    if existing:
        return True  # Already used today
    
    # Record this batch usage
    batch_usage = BatchUsageDB(
        machine_id=machine_id,
        batch_id=batch_id,
        usage_date=today
    )
    session.add(batch_usage)
    await session.commit()
    
    return False  # First use today


async def cleanup_old_batch_usage(
    session: AsyncSession,
    days_to_keep: int = 7
) -> int:
    """Clean up batch usage records older than specified days.
    
    Args:
        session: Database session
        days_to_keep: Number of days of history to keep
    
    Returns:
        Number of records deleted
    """
    from sqlalchemy import delete
    from datetime import timedelta
    
    cutoff_date = date.today() - timedelta(days=days_to_keep)
    
    result = await session.execute(
        delete(BatchUsageDB).where(BatchUsageDB.usage_date < cutoff_date)
    )
    await session.commit()
    
    return result.rowcount


def hash_refresh_token(token: str) -> str:
    """Hash a refresh token using SHA-256.
    
    Args:
        token: The raw refresh token string
    
    Returns:
        Hex-encoded SHA-256 hash
    """
    import hashlib
    return hashlib.sha256(token.encode()).hexdigest()


async def store_refresh_token(
    session: AsyncSession,
    user_id: uuid.UUID,
    refresh_token: str,
    token_family: Optional[uuid.UUID] = None
) -> uuid.UUID:
    """Store a hashed refresh token for a user.
    
    Args:
        session: Database session
        user_id: User's ID
        refresh_token: The raw refresh token to hash and store
        token_family: Optional existing family ID for rotation
    
    Returns:
        Token family ID (new or existing)
    """
    from sqlalchemy import select
    
    result = await session.execute(
        select(UserDB).where(UserDB.id == user_id)
    )
    user = result.scalar_one_or_none()
    
    if not user:
        raise ValueError("User not found")
    
    # Generate new token family if not provided
    if token_family is None:
        token_family = uuid.uuid4()
    
    # Hash and store
    user.hashed_refresh_token = hash_refresh_token(refresh_token)
    user.token_family = token_family
    user.token_version += 1
    
    await session.commit()
    await session.refresh(user)
    
    return token_family


async def validate_refresh_token(
    session: AsyncSession,
    user_id: uuid.UUID,
    refresh_token: str,
    expected_family: uuid.UUID
) -> bool:
    """Validate a refresh token against stored hash.
    
    Args:
        session: Database session
        user_id: User's ID
        refresh_token: The raw refresh token to validate
        expected_family: Expected token family (from JWT claims)
    
    Returns:
        True if token is valid, False otherwise
    """
    from sqlalchemy import select
    
    result = await session.execute(
        select(UserDB).where(UserDB.id == user_id)
    )
    user = result.scalar_one_or_none()
    
    if not user or not user.hashed_refresh_token:
        return False
    
    # Check token family matches (prevents token reuse)
    if user.token_family != expected_family:
        return False
    
    # Validate hash
    token_hash = hash_refresh_token(refresh_token)
    return token_hash == user.hashed_refresh_token


async def invalidate_refresh_tokens(
    session: AsyncSession,
    user_id: uuid.UUID
) -> None:
    """Invalidate all refresh tokens for a user (e.g., on logout).
    
    Args:
        session: Database session
        user_id: User's ID
    """
    from sqlalchemy import select
    
    result = await session.execute(
        select(UserDB).where(UserDB.id == user_id)
    )
    user = result.scalar_one_or_none()
    
    if user:
        user.hashed_refresh_token = None
        user.token_family = None
        user.token_version += 1
        await session.commit()
