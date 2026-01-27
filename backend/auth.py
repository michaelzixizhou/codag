from datetime import datetime, timedelta
from typing import Optional
from jose import JWTError, jwt
from fastapi import HTTPException
from config import settings
from models import TokenData


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
