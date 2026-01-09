from datetime import datetime, timedelta
from typing import Optional
from jose import JWTError, jwt
from fastapi import Depends, HTTPException
from fastapi.security import HTTPBearer, HTTPAuthorizationCredentials
from config import settings
from models import User, TokenData

security = HTTPBearer()

# In-memory user store (replace with DB in production)
users_db: dict[str, dict] = {}

def create_access_token(data: dict, expires_delta: Optional[timedelta] = None):
    to_encode = data.copy()
    expire = datetime.utcnow() + (expires_delta or timedelta(minutes=settings.access_token_expire_minutes))
    to_encode.update({"exp": expire})
    return jwt.encode(to_encode, settings.secret_key, algorithm=settings.algorithm)

def create_refresh_token(data: dict, expires_delta: Optional[timedelta] = None):
    """Create a refresh token with longer expiration (7 days)"""
    to_encode = data.copy()
    expire = datetime.utcnow() + (expires_delta or timedelta(days=7))
    to_encode.update({"exp": expire, "type": "refresh"})
    return jwt.encode(to_encode, settings.secret_key, algorithm=settings.algorithm)

def decode_refresh_token(token: str) -> TokenData:
    """Decode and validate a refresh token"""
    try:
        payload = jwt.decode(token, settings.secret_key, algorithms=[settings.algorithm])
        if payload.get("type") != "refresh":
            raise HTTPException(status_code=401, detail="Invalid token type")
        email: str = payload.get("sub")
        user_id: str = payload.get("user_id")
        if email is None:
            raise HTTPException(status_code=401, detail="Invalid token")
        return TokenData(email=email, user_id=user_id)
    except JWTError:
        raise HTTPException(status_code=401, detail="Invalid or expired refresh token")

def decode_token(token: str) -> TokenData:
    try:
        payload = jwt.decode(token, settings.secret_key, algorithms=[settings.algorithm])
        email: str = payload.get("sub")
        user_id: str = payload.get("user_id")
        if email is None:
            raise HTTPException(status_code=401, detail="Invalid token")
        return TokenData(email=email, user_id=user_id)
    except JWTError:
        raise HTTPException(status_code=401, detail="Invalid token")

async def get_current_user(credentials: HTTPAuthorizationCredentials = Depends(security)) -> User:
    token_data = decode_token(credentials.credentials)
    user_data = users_db.get(token_data.email)
    if not user_data:
        raise HTTPException(status_code=401, detail="User not found")
    return User(**user_data)

def check_rate_limit(user: User):
    today = datetime.utcnow().strftime("%Y-%m-%d")

    if user.is_paid:
        return

    if user.last_request_date != today:
        user.requests_today = 0
        user.last_request_date = today
        users_db[user.email]["requests_today"] = 0
        users_db[user.email]["last_request_date"] = today

    if user.requests_today >= settings.free_trial_requests_per_day:
        raise HTTPException(status_code=429, detail="Free trial limit reached")

    users_db[user.email]["requests_today"] += 1
