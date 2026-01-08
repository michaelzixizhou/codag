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


async def add_refresh_token_column():
    """Migration: Add refresh_token column to users table."""
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
