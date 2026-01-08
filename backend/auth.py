from datetime import datetime, timedelta
from typing import Optional
from jose import JWTError, jwt
from passlib.context import CryptContext
from fastapi import Depends, HTTPException
from fastapi.security import HTTPBearer, HTTPAuthorizationCredentials
from config import settings
from models import User, TokenData

pwd_context = CryptContext(schemes=["bcrypt"], deprecated="auto")
security = HTTPBearer()

# In-memory user store (replace with DB in production)
users_db: dict[str, dict] = {}

def verify_password(plain_password: str, hashed_password: str) -> bool:
    return pwd_context.verify(plain_password, hashed_password)

def get_password_hash(password: str) -> str:
    return pwd_context.hash(password)

def create_access_token(data: dict, expires_delta: Optional[timedelta] = None):
    to_encode = data.copy()
    expire = datetime.utcnow() + (expires_delta or timedelta(minutes=settings.access_token_expire_minutes))
    to_encode.update({"exp": expire})
    return jwt.encode(to_encode, settings.secret_key, algorithm=settings.algorithm)

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
