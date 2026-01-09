"""
Database migrations for schema changes.
Runs automatically on startup to ensure schema is up-to-date.
"""
from sqlalchemy import text
from database import engine
import logging

logger = logging.getLogger(__name__)


async def run_migrations():
    """Run all migrations in order."""
    await add_refresh_token_column()
    await migrate_to_secure_refresh_tokens()
    await add_batch_usage_table()


async def add_refresh_token_column():
    """Migration: Add refresh_token column to users table (legacy - will be removed)."""
    async with engine.begin() as conn:
        try:
            # Check if column exists
            result = await conn.execute(text("""
                SELECT column_name 
                FROM information_schema.columns 
                WHERE table_name='users' AND column_name='refresh_token'
            """))
            exists = result.fetchone()
            
            if not exists:
                logger.info('Running migration: Adding refresh_token column to users table')
                await conn.execute(text("""
                    ALTER TABLE users 
                    ADD COLUMN refresh_token VARCHAR(500) NULL
                """))
                logger.info('✅ Migration completed: refresh_token column added')
            else:
                logger.debug('Migration skipped: refresh_token column already exists')
        except Exception as e:
            logger.error(f'❌ Migration failed: {e}')
            raise


async def migrate_to_secure_refresh_tokens():
    """Migration: Add secure refresh token columns and remove plaintext column."""
    async with engine.begin() as conn:
        try:
            # Add hashed_refresh_token column
            result = await conn.execute(text("""
                SELECT column_name 
                FROM information_schema.columns 
                WHERE table_name='users' AND column_name='hashed_refresh_token'
            """))
            if not result.fetchone():
                logger.info('Running migration: Adding hashed_refresh_token column')
                await conn.execute(text("""
                    ALTER TABLE users 
                    ADD COLUMN hashed_refresh_token VARCHAR(255) NULL
                """))
            
            # Add token_family column
            result = await conn.execute(text("""
                SELECT column_name 
                FROM information_schema.columns 
                WHERE table_name='users' AND column_name='token_family'
            """))
            if not result.fetchone():
                logger.info('Running migration: Adding token_family column')
                await conn.execute(text("""
                    ALTER TABLE users 
                    ADD COLUMN token_family UUID NULL
                """))
            
            # Add token_version column
            result = await conn.execute(text("""
                SELECT column_name 
                FROM information_schema.columns 
                WHERE table_name='users' AND column_name='token_version'
            """))
            if not result.fetchone():
                logger.info('Running migration: Adding token_version column')
                await conn.execute(text("""
                    ALTER TABLE users 
                    ADD COLUMN token_version INTEGER DEFAULT 0
                """))
            
            # Drop old plaintext refresh_token column if new columns exist
            result = await conn.execute(text("""
                SELECT column_name 
                FROM information_schema.columns 
                WHERE table_name='users' AND column_name='refresh_token'
            """))
            if result.fetchone():
                logger.info('Running migration: Dropping plaintext refresh_token column')
                await conn.execute(text("""
                    ALTER TABLE users 
                    DROP COLUMN IF EXISTS refresh_token
                """))
                logger.info('✅ Migration completed: Secure refresh token storage enabled')
        except Exception as e:
            logger.error(f'❌ Migration failed: {e}')
            raise


async def add_batch_usage_table():
    """Migration: Create batch_usage table for secure trial tracking."""
    async with engine.begin() as conn:
        try:
            # Check if table exists
            result = await conn.execute(text("""
                SELECT tablename 
                FROM pg_tables 
                WHERE tablename='batch_usage'
            """))
            if not result.fetchone():
                logger.info('Running migration: Creating batch_usage table')
                await conn.execute(text("""
                    CREATE TABLE batch_usage (
                        id UUID PRIMARY KEY,
                        machine_id VARCHAR(255) NOT NULL,
                        batch_id VARCHAR(255) NOT NULL,
                        usage_date DATE NOT NULL,
                        created_at TIMESTAMP WITHOUT TIME ZONE NOT NULL,
                        CONSTRAINT uq_batch_usage_per_day UNIQUE (machine_id, batch_id, usage_date)
                    )
                """))
                # Add index for performance
                await conn.execute(text("""
                    CREATE INDEX idx_batch_usage_machine_id ON batch_usage(machine_id)
                """))
                logger.info('✅ Migration completed: batch_usage table created')
            else:
                logger.debug('Migration skipped: batch_usage table already exists')
        except Exception as e:
            logger.error(f'❌ Migration failed: {e}')
            raise
