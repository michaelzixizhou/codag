from datetime import datetime, timedelta, timezone
from typing import Optional
import uuid
from jose import JWTError, jwt
from fastapi import Depends, HTTPException
from fastapi.security import HTTPBearer, HTTPAuthorizationCredentials
from config import settings
from models import User, TokenData

security = HTTPBearer()

# In-memory user store (replace with DB in production)
users_db: dict[str, dict] = {}

# JWT security constants
ALLOWED_ALGORITHMS = [settings.algorithm]  # Whitelist to prevent algorithm confusion attacks
TOKEN_ISSUER = settings.backend_url
TOKEN_AUDIENCE = "codag-api"

def _get_utc_now() -> datetime:
    """Get timezone-aware UTC datetime."""
    return datetime.now(timezone.utc)

def _create_token_claims(subject: str, user_id: str, token_type: str = "access", expires_delta: Optional[timedelta] = None, token_family: Optional[str] = None) -> dict:
    """Create standard JWT claims with security best practices.
    
    Args:
        subject: The 'sub' claim (typically user email)
        user_id: The user's ID
        token_type: 'access' or 'refresh'
        expires_delta: Custom expiration time
        token_family: Token family ID for refresh token rotation
    
    Returns:
        Dictionary of JWT claims including iss, aud, exp, iat, jti, sub
    """
    now = _get_utc_now()
    
    if expires_delta is None:
        if token_type == "refresh":
            expires_delta = timedelta(days=7)
        else:
            expires_delta = timedelta(minutes=settings.access_token_expire_minutes)
    
    claims = {
        "sub": subject,
        "user_id": user_id,
        "iss": TOKEN_ISSUER,  # Issuer claim
        "aud": TOKEN_AUDIENCE,  # Audience claim
        "exp": now + expires_delta,  # Expiration time
        "iat": now,  # Issued at time
        "jti": str(uuid.uuid4()),  # JWT ID for revocation tracking
    }
    
    if token_type == "refresh":
        claims["type"] = "refresh"
        if token_family:
            claims["family"] = token_family
    
    return claims

def create_access_token(data: dict, expires_delta: Optional[timedelta] = None) -> str:
    """Create a signed access token with security best practices.
    
    Args:
        data: Must contain 'sub' (email) and 'user_id'
        expires_delta: Optional custom expiration
    
    Returns:
        Encoded JWT access token
    """
    claims = _create_token_claims(
        subject=data["sub"],
        user_id=data["user_id"],
        token_type="access",
        expires_delta=expires_delta
    )
    return jwt.encode(claims, settings.secret_key, algorithm=settings.algorithm)

def create_refresh_token(data: dict, expires_delta: Optional[timedelta] = None, token_family: Optional[str] = None) -> str:
    """Create a signed refresh token with longer expiration.
    
    Args:
        data: Must contain 'sub' (email) and 'user_id'
        expires_delta: Optional custom expiration (default: 7 days)
        token_family: Token family ID for rotation tracking
    
    Returns:
        Encoded JWT refresh token
    """
    claims = _create_token_claims(
        subject=data["sub"],
        user_id=data["user_id"],
        token_type="refresh",
        expires_delta=expires_delta,
        token_family=token_family
    )
    return jwt.encode(claims, settings.secret_key, algorithm=settings.algorithm)

def _decode_and_validate_token(token: str, expected_type: Optional[str] = None) -> dict:
    """Decode and validate JWT token with comprehensive security checks.
    
    Args:
        token: The JWT token string
        expected_type: Expected token type ('refresh' or None for access)
    
    Returns:
        Validated token payload
    
    Raises:
        HTTPException: If token is invalid, expired, or fails validation
    """
    try:
        # Decode with algorithm whitelist and claim validation
        payload = jwt.decode(
            token,
            settings.secret_key,
            algorithms=ALLOWED_ALGORITHMS,  # Prevents algorithm confusion attacks
            issuer=TOKEN_ISSUER,  # Validates issuer claim
            audience=TOKEN_AUDIENCE,  # Validates audience claim
            options={
                "verify_signature": True,
                "verify_exp": True,
                "verify_iat": True,
                "require_exp": True,
                "require_iat": True,
                "require_sub": True,
            }
        )
        
        # Validate token type if specified
        if expected_type == "refresh":
            if payload.get("type") != "refresh":
                raise HTTPException(status_code=401, detail="Invalid token type")
        
        # Validate required claims
        if not payload.get("sub") or not payload.get("user_id"):
            raise HTTPException(status_code=401, detail="Missing required claims")
        
        return payload
    
    except JWTError as e:
        # More specific error messages for debugging (in production, use generic message)
        error_msg = "Invalid or expired token"
        if "expired" in str(e).lower():
            error_msg = "Token has expired"
        elif "signature" in str(e).lower():
            error_msg = "Invalid token signature"
        raise HTTPException(status_code=401, detail=error_msg)

def decode_refresh_token(token: str) -> TokenData:
    """Decode and validate a refresh token.
    
    Args:
        token: The refresh token string
    
    Returns:
        TokenData with email and user_id
    
    Raises:
        HTTPException: If token is invalid or not a refresh token
    """
    payload = _decode_and_validate_token(token, expected_type="refresh")
    return TokenData(email=payload["sub"], user_id=payload["user_id"])

def decode_token(token: str) -> TokenData:
    """Decode and validate an access token.
    
    Args:
        token: The access token string
    
    Returns:
        TokenData with email and user_id
    
    Raises:
        HTTPException: If token is invalid
    """
    payload = _decode_and_validate_token(token, expected_type=None)
    return TokenData(email=payload["sub"], user_id=payload["user_id"])

async def get_current_user(credentials: HTTPAuthorizationCredentials = Depends(security)) -> User:
    token_data = decode_token(credentials.credentials)
    user_data = users_db.get(token_data.email)
    if not user_data:
        raise HTTPException(status_code=401, detail="User not found")
    return User(**user_data)

def check_rate_limit(user: User) -> None:
    """Check and enforce rate limits for trial users.
    
    Args:
        user: User object to check limits for
    
    Raises:
        HTTPException: If rate limit is exceeded
    """
    today = _get_utc_now().strftime("%Y-%m-%d")

    # Paid users have no limits
    if user.is_paid:
        return

    # Reset daily counter if it's a new day
    if user.last_request_date != today:
        user.requests_today = 0
        user.last_request_date = today
        users_db[user.email]["requests_today"] = 0
        users_db[user.email]["last_request_date"] = today

    # Check if limit reached
    if user.requests_today >= settings.free_trial_requests_per_day:
        raise HTTPException(status_code=429, detail="Free trial limit reached")

    # Increment counter
    users_db[user.email]["requests_today"] += 1
