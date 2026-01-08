from pydantic_settings import BaseSettings
from typing import Optional

class Settings(BaseSettings):
    secret_key: str
    gemini_api_key: str
    free_trial_requests_per_day: int = 5  # Trial users: 5/day
    algorithm: str = "HS256"
    access_token_expire_minutes: int = 60 * 24  # 24 hours

    # Database
    database_url: str = "postgresql+asyncpg://localhost/codag"

    # OAuth - GitHub
    github_client_id: Optional[str] = None
    github_client_secret: Optional[str] = None

    # OAuth - Google
    google_client_id: Optional[str] = None
    google_client_secret: Optional[str] = None

    # Backend URL (for OAuth callbacks)
    backend_url: str = "http://localhost:8000"

    class Config:
        env_file = ".env"

settings = Settings()
