"""
OAuth handlers for GitHub and Google authentication.
Uses authlib for OAuth 2.0 flow.
"""
from typing import Optional
from authlib.integrations.starlette_client import OAuth

from config import settings

# Initialize OAuth client
oauth = OAuth()

# GitHub OAuth configuration
if settings.github_client_id and settings.github_client_secret:
    oauth.register(
        name='github',
        client_id=settings.github_client_id,
        client_secret=settings.github_client_secret,
        authorize_url='https://github.com/login/oauth/authorize',
        access_token_url='https://github.com/login/oauth/access_token',
        api_base_url='https://api.github.com/',
        client_kwargs={'scope': 'read:user user:email'},
    )

# Google OAuth configuration
if settings.google_client_id and settings.google_client_secret:
    oauth.register(
        name='google',
        client_id=settings.google_client_id,
        client_secret=settings.google_client_secret,
        server_metadata_url='https://accounts.google.com/.well-known/openid-configuration',
        client_kwargs={'scope': 'openid email profile'},
    )


async def get_github_user_info(token: dict) -> dict:
    """
    Fetch user info from GitHub API.
    Returns dict with email, name, avatar_url, provider_id.
    """
    import httpx

    access_token = token.get('access_token')
    headers = {
        'Authorization': f'Bearer {access_token}',
        'Accept': 'application/json',
    }

    async with httpx.AsyncClient() as client:
        # Get user profile
        user_response = await client.get(
            'https://api.github.com/user',
            headers=headers
        )
        user_data = user_response.json()

        # Get user emails (in case primary email is private)
        emails_response = await client.get(
            'https://api.github.com/user/emails',
            headers=headers
        )
        emails_data = emails_response.json()

        # Find primary email
        email = None
        for email_entry in emails_data:
            if email_entry.get('primary') and email_entry.get('verified'):
                email = email_entry.get('email')
                break

        # Fallback to public email
        if not email:
            email = user_data.get('email')

        return {
            'email': email,
            'name': user_data.get('name') or user_data.get('login'),
            'avatar_url': user_data.get('avatar_url'),
            'provider_id': str(user_data.get('id')),
        }


async def get_google_user_info(token: dict) -> dict:
    """
    Fetch user info from Google.
    For OpenID Connect, user info is in the id_token.
    Returns dict with email, name, avatar_url, provider_id.
    """
    import httpx

    # For OpenID Connect, we can get info from userinfo endpoint
    access_token = token.get('access_token')
    headers = {
        'Authorization': f'Bearer {access_token}',
    }

    async with httpx.AsyncClient() as client:
        response = await client.get(
            'https://www.googleapis.com/oauth2/v3/userinfo',
            headers=headers
        )
        user_data = response.json()

        return {
            'email': user_data.get('email'),
            'name': user_data.get('name'),
            'avatar_url': user_data.get('picture'),
            'provider_id': user_data.get('sub'),  # Google's unique user ID
        }


def is_github_configured() -> bool:
    """Check if GitHub OAuth is configured."""
    return bool(settings.github_client_id and settings.github_client_secret)


def is_google_configured() -> bool:
    """Check if Google OAuth is configured."""
    return bool(settings.google_client_id and settings.google_client_secret)
