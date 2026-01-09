from pydantic_settings import BaseSettings
from typing import Optional, List

class Settings(BaseSettings):
    secret_key: str
    gemini_api_key: str
    free_trial_requests_per_day: int = 5  # Trial users: 5/day
    algorithm: str = "HS256"
    access_token_expire_minutes: int = 60 * 24  # 24 hours
    dev_mode: bool = False  # When true, bypasses auth/trial limits

    # Database
    database_url: str = "postgresql+asyncpg://localhost/codag"

    # OAuth - GitHub
    github_client_id: Optional[str] = None
    github_client_secret: Optional[str] = None

    # OAuth - Google
    google_client_id: Optional[str] = None
    google_client_secret: Optional[str] = None

    # Backend URL (for OAuth callbacks and JWT issuer)
    backend_url: str = "http://localhost:8000"
    
    # CORS - Allowed origins (comma-separated in .env)
    # In production, set to specific domains: "https://yourdomain.com,vscode://codag.codag"
    # Use "*" only for development
    allowed_origins: str = "*"

    @property
    def allowed_origins_list(self) -> List[str]:
        """Parse allowed_origins string into list."""
        if self.allowed_origins == "*":
            return ["*"]
        return [origin.strip() for origin in self.allowed_origins.split(",") if origin.strip()]

    class Config:
        env_file = ".env"

settings = Settings()
