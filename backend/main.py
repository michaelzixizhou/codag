from fastapi import FastAPI, Depends, HTTPException, Header, Request, Response
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import RedirectResponse
from starlette.middleware.sessions import SessionMiddleware
from sqlalchemy.ext.asyncio import AsyncSession
from sqlalchemy import select
from typing import Optional, Callable, Awaitable, Any
import json
import uuid

from models import (
    UserCreate, UserLogin, Token, User, AnalyzeRequest, WorkflowGraph,
    DeviceCheckRequest, DeviceCheckResponse, DeviceLinkRequest,
    OAuthUser, AuthStateResponse,
    MetadataRequest, MetadataBundle, FileMetadataResult, FunctionMetadata,
    CondenseRequest, CondenseResponse,
    TokenUsage, CostData, AnalyzeResponse
)
from prompts import build_metadata_only_prompt, USE_MERMAID_FORMAT
from mermaid_parser import parse_mermaid_response
from auth import (
    get_password_hash,
    verify_password,
    create_access_token,
    decode_token,
    users_db
)
from database import (
    get_db, init_db,
    get_or_create_trial_device, increment_trial_usage,
    get_or_create_user, link_device_to_user,
    UserDB
)
from oauth import (
    oauth, get_github_user_info, get_google_user_info,
    is_github_configured, is_google_configured
)
from gemini_client import gemini_client
from analyzer import static_analyzer
from config import settings

# OAuth callback URI for VSCode extension
VSCODE_CALLBACK_URI = "vscode://codag.codag/auth/callback"

app = FastAPI(title="Codag")

# Add session middleware for OAuth state
app.add_middleware(
    SessionMiddleware,
    secret_key=settings.secret_key,
)

app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
    expose_headers=["X-Remaining-Analyses"],
)


@app.on_event("startup")
async def startup():
    """Initialize database on startup."""
    await init_db()


# =============================================================================
# OAuth Helpers
# =============================================================================

async def _redirect_to_oauth(
    provider_name: str,
    oauth_client: Any,
    is_configured: Callable[[], bool],
    request: Request,
    state: Optional[str]
) -> RedirectResponse:
    """Common OAuth login redirect logic."""
    print(f"[OAuth] {provider_name} login requested, configured: {is_configured()}")
    if not is_configured():
        raise HTTPException(status_code=501, detail=f"{provider_name} OAuth not configured")

    if state:
        request.session['oauth_state'] = state

    redirect_uri = f"{settings.backend_url}/auth/{provider_name.lower()}/callback"
    print(f"[OAuth] Redirecting to {provider_name} with callback: {redirect_uri}")
    try:
        return await oauth_client.authorize_redirect(request, redirect_uri)
    except Exception as e:
        print(f"[OAuth] {provider_name} redirect error: {e}")
        raise HTTPException(status_code=500, detail=f"OAuth redirect failed: {str(e)}")


async def _handle_oauth_callback(
    provider_name: str,
    oauth_client: Any,
    is_configured: Callable[[], bool],
    get_user_info: Callable[[dict], Awaitable[dict]],
    request: Request,
    db: AsyncSession
) -> RedirectResponse:
    """Common OAuth callback handling logic."""
    if not is_configured():
        raise HTTPException(status_code=501, detail=f"{provider_name} OAuth not configured")

    try:
        token = await oauth_client.authorize_access_token(request)
        user_info = await get_user_info(token)

        if not user_info.get('email'):
            return RedirectResponse(
                url=f"{VSCODE_CALLBACK_URI}?error=no_email",
                status_code=302
            )

        user = await get_or_create_user(
            db,
            email=user_info['email'],
            name=user_info.get('name'),
            provider=provider_name.lower(),
            provider_id=user_info['provider_id'],
        )

        jwt_token = create_access_token({
            "sub": user.email,
            "user_id": str(user.id)
        })

        return RedirectResponse(
            url=f"{VSCODE_CALLBACK_URI}?token={jwt_token}",
            status_code=302
        )
    except Exception as e:
        return RedirectResponse(
            url=f"{VSCODE_CALLBACK_URI}?error={str(e)}",
            status_code=302
        )


# =============================================================================
# Device/Trial Auth Endpoints
# =============================================================================

@app.post("/auth/device", response_model=DeviceCheckResponse)
async def check_device(
    request: DeviceCheckRequest,
    db: AsyncSession = Depends(get_db)
):
    """
    Check or register a trial device.
    Returns remaining analyses for the day.
    """
    device, remaining = await get_or_create_trial_device(db, request.machine_id)

    return DeviceCheckResponse(
        machine_id=request.machine_id,
        remaining_analyses=remaining,
        is_trial=True,
        is_authenticated=device.user_id is not None
    )


@app.post("/auth/device/link")
async def link_device(
    request: DeviceLinkRequest,
    authorization: Optional[str] = Header(None),
    db: AsyncSession = Depends(get_db)
):
    """
    Link a trial device to an authenticated user.
    Called after OAuth signup.
    """
    if not authorization or not authorization.startswith("Bearer "):
        raise HTTPException(status_code=401, detail="Not authenticated")

    token = authorization.replace("Bearer ", "")
    token_data = decode_token(token)

    if not token_data.user_id:
        raise HTTPException(status_code=401, detail="Invalid token")

    await link_device_to_user(db, request.machine_id, uuid.UUID(token_data.user_id))

    return {"status": "linked"}


# =============================================================================
# OAuth Endpoints
# =============================================================================

@app.get("/auth/github")
async def github_login(request: Request, state: Optional[str] = None):
    """Redirect to GitHub OAuth."""
    return await _redirect_to_oauth("GitHub", oauth.github, is_github_configured, request, state)


@app.get("/auth/github/callback")
async def github_callback(request: Request, db: AsyncSession = Depends(get_db)):
    """Handle GitHub OAuth callback."""
    return await _handle_oauth_callback(
        "GitHub", oauth.github, is_github_configured, get_github_user_info, request, db
    )


@app.get("/auth/google")
async def google_login(request: Request, state: Optional[str] = None):
    """Redirect to Google OAuth."""
    return await _redirect_to_oauth("Google", oauth.google, is_google_configured, request, state)


@app.get("/auth/google/callback")
async def google_callback(request: Request, db: AsyncSession = Depends(get_db)):
    """Handle Google OAuth callback."""
    return await _handle_oauth_callback(
        "Google", oauth.google, is_google_configured, get_google_user_info, request, db
    )


@app.get("/auth/me", response_model=OAuthUser)
async def get_me(
    authorization: Optional[str] = Header(None),
    db: AsyncSession = Depends(get_db)
):
    """Get current authenticated user info."""
    if not authorization or not authorization.startswith("Bearer "):
        raise HTTPException(status_code=401, detail="Not authenticated")

    token = authorization.replace("Bearer ", "")
    token_data = decode_token(token)

    if not token_data.user_id:
        raise HTTPException(status_code=401, detail="Invalid token")

    result = await db.execute(
        select(UserDB).where(UserDB.id == uuid.UUID(token_data.user_id))
    )
    user = result.scalar_one_or_none()

    if not user:
        raise HTTPException(status_code=404, detail="User not found")

    return OAuthUser(
        id=str(user.id),
        email=user.email,
        name=user.name,
        avatar_url=None,  # Not stored in DB, could fetch from provider if needed
        provider=user.provider,
        is_paid=user.is_paid
    )


# =============================================================================
# Legacy Auth Endpoints (kept for backwards compatibility)
# =============================================================================

@app.post("/auth/register", response_model=Token)
async def register(user: UserCreate):
    if user.email in users_db:
        raise HTTPException(status_code=400, detail="Email already registered")

    users_db[user.email] = {
        "email": user.email,
        "hashed_password": get_password_hash(user.password),
        "is_paid": False,
        "requests_today": 0,
        "last_request_date": None
    }

    token = create_access_token({"sub": user.email})
    return {"access_token": token, "token_type": "bearer"}


@app.post("/auth/login", response_model=Token)
async def login(user: UserLogin):
    user_data = users_db.get(user.email)
    if not user_data or not verify_password(user.password, user_data["hashed_password"]):
        raise HTTPException(status_code=401, detail="Invalid credentials")

    token = create_access_token({"sub": user.email})
    return {"access_token": token, "token_type": "bearer"}


# =============================================================================
# Analysis Endpoint
# =============================================================================

@app.post("/analyze", response_model=AnalyzeResponse)
async def analyze_workflow(
    request: AnalyzeRequest,
    response: Response,
    x_device_id: Optional[str] = Header(None),
    authorization: Optional[str] = Header(None),
    db: AsyncSession = Depends(get_db)
):
    """
    Analyze code for LLM workflow patterns.

    Authentication:
    - X-Device-ID header: Trial mode (5 analyses/day)
    - Authorization: Bearer <token>: Authenticated mode (unlimited)
    """
    # TEMPORARY: Disable auth/trial checks for development
    remaining_analyses = -1  # -1 means unlimited

    # Track cumulative cost across retries
    total_usage = TokenUsage(input_tokens=0, output_tokens=0, total_tokens=0, cached_tokens=0)
    total_cost = CostData(input_cost=0.0, output_cost=0.0, total_cost=0.0)

    # Input validation
    MAX_CODE_SIZE = 5_000_000  # 5MB limit
    MAX_FILES = 50  # Reasonable limit on number of files

    if len(request.code) > MAX_CODE_SIZE:
        raise HTTPException(
            status_code=413,
            detail=f"Code size ({len(request.code)} bytes) exceeds maximum allowed size ({MAX_CODE_SIZE} bytes). Try analyzing fewer files or smaller files."
        )

    if request.file_paths and len(request.file_paths) > MAX_FILES:
        raise HTTPException(
            status_code=413,
            detail=f"Number of files ({len(request.file_paths)}) exceeds maximum allowed ({MAX_FILES}). Try analyzing fewer files at once."
        )

    # Static analysis
    framework = request.framework_hint or static_analyzer.detect_framework(
        request.code,
        request.file_paths[0] if request.file_paths else ""
    )

    # Convert metadata to dict format
    metadata_dicts = [m.dict() for m in request.metadata] if request.metadata else None

    # Helper to accumulate usage/cost
    def accumulate_cost(usage: TokenUsage, cost: CostData):
        nonlocal total_usage, total_cost
        total_usage = TokenUsage(
            input_tokens=total_usage.input_tokens + usage.input_tokens,
            output_tokens=total_usage.output_tokens + usage.output_tokens,
            total_tokens=total_usage.total_tokens + usage.total_tokens,
            cached_tokens=total_usage.cached_tokens + usage.cached_tokens
        )
        total_cost = CostData(
            input_cost=total_cost.input_cost + cost.input_cost,
            output_cost=total_cost.output_cost + cost.output_cost,
            total_cost=total_cost.total_cost + cost.total_cost
        )

    # LLM analysis
    try:
        result, usage, cost = await gemini_client.analyze_workflow(
            request.code,
            framework,
            metadata_dicts,
            http_connections=request.http_connections
        )
        accumulate_cost(usage, cost)
        result = result.strip()

        # Helper to fix file paths from LLM (handles both relative and mangled absolute paths)
        def fix_file_path(path: str, file_paths: list) -> str:
            if not path:
                return path
            if path in file_paths:
                return path
            filename = path.split('/')[-1]
            for input_path in file_paths:
                if input_path.endswith('/' + filename):
                    return input_path
            return path

        # Parse response based on format
        if USE_MERMAID_FORMAT:
            # Parse Mermaid + Metadata format with retry on failure
            MAX_RETRIES = 2

            for attempt in range(MAX_RETRIES + 1):
                # Strip markdown wrappers if present
                clean_result = result
                if clean_result.startswith("```"):
                    clean_result = clean_result.split("\n", 1)[1] if "\n" in clean_result else clean_result[3:]
                if clean_result.endswith("```"):
                    clean_result = clean_result.rsplit("```", 1)[0]

                try:
                    graph = parse_mermaid_response(clean_result.strip())
                    break  # Success - exit retry loop
                except ValueError as e:
                    if attempt < MAX_RETRIES:
                        print(f"[analyze] Parse attempt {attempt + 1} failed: {e}")
                        print(f"[analyze] Retrying with correction prompt...")
                        # Retry with a correction prompt
                        correction_prompt = f"""Your previous response could not be parsed. Error: {str(e)[:200]}

CRITICAL FORMAT REMINDER:
1. Output RAW TEXT only - NO markdown backticks
2. Mermaid diagram(s) FIRST, then "---" separator, then "metadata:" section
3. The metadata section must be valid YAML

Example format:
flowchart TD
    %% Workflow: Example
    A[Step] --> B([LLM])

---
metadata:
A: {{file: "file.py", line: 1, function: "func", type: "step"}}
B: {{file: "file.py", line: 10, function: "llm", type: "llm"}}

Please re-analyze the code and output in the CORRECT format."""
                        try:
                            result, retry_usage, retry_cost = await gemini_client.analyze_workflow(
                                request.code,
                                framework,
                                metadata_dicts,
                                correction_prompt
                            )
                            accumulate_cost(retry_usage, retry_cost)
                            result = result.strip()
                        except Exception as retry_err:
                            print(f"[analyze] Retry LLM call failed: {retry_err}")
                            raise HTTPException(
                                status_code=500,
                                detail=f"Analysis failed after retry: {str(e)}"
                            )
                    else:
                        # All retries exhausted
                        raise HTTPException(
                            status_code=500,
                            detail=f"Analysis failed after {MAX_RETRIES + 1} attempts: Could not parse Mermaid response. {str(e)}"
                        )

            # Empty graph is valid - code has no LLM calls
            if not graph.nodes:
                return AnalyzeResponse(graph=graph, usage=total_usage, cost=total_cost)

            # Fix file paths in nodes
            for node in graph.nodes:
                if node.source and node.source.file:
                    node.source.file = fix_file_path(node.source.file, request.file_paths)

            # DEBUG: Log workflows
            for wf in graph.workflows:
                print(f"DEBUG: Workflow '{wf.name}' ({len(wf.nodeIds)} nodes)")

            return AnalyzeResponse(graph=graph, usage=total_usage, cost=total_cost)
        else:
            # Parse JSON format (legacy)
            if result.startswith("```json"):
                result = result[7:]
            if result.startswith("```"):
                result = result[3:]
            if result.endswith("```"):
                result = result[:-3]

            try:
                graph_data = json.loads(result.strip())
            except json.JSONDecodeError as json_err:
                result_clean = result.strip()
                if not result_clean.endswith('}'):
                    open_braces = result_clean.count('{') - result_clean.count('}')
                    open_brackets = result_clean.count('[') - result_clean.count(']')
                    last_comma = result_clean.rfind(',')
                    if last_comma > result_clean.rfind('}') and last_comma > result_clean.rfind(']'):
                        result_clean = result_clean[:last_comma]
                    result_clean += ']' * max(0, open_brackets)
                    result_clean += '}' * max(0, open_braces)
                    try:
                        graph_data = json.loads(result_clean)
                    except:
                        raise HTTPException(
                            status_code=500,
                            detail=f"Analysis failed: Response was truncated. {str(json_err)}"
                        )
                else:
                    raise

            # Empty graph is valid - return early
            if not graph_data.get('nodes'):
                empty_graph = WorkflowGraph(nodes=[], edges=[], llms_detected=[], workflows=[])
                return AnalyzeResponse(graph=empty_graph, usage=total_usage, cost=total_cost)

            for node in graph_data.get('nodes', []):
                if node.get('source') and node['source'].get('file'):
                    node['source']['file'] = fix_file_path(node['source']['file'], request.file_paths)

            workflows = graph_data.get('workflows', [])
            for wf in workflows:
                node_count = len(wf.get('nodeIds', []))
                print(f"DEBUG: Workflow '{wf.get('name')}' ({node_count} nodes)")

            graph = WorkflowGraph(**graph_data)
            return AnalyzeResponse(graph=graph, usage=total_usage, cost=total_cost)
    except HTTPException:
        raise
    except Exception as e:
        raise HTTPException(status_code=500, detail=f"Analysis failed: {str(e)}")


@app.post("/analyze/metadata-only")
async def analyze_metadata_only(
    request: MetadataRequest,
    x_device_id: Optional[str] = Header(None),
    authorization: Optional[str] = Header(None)
):
    """Generate metadata (labels, descriptions) for functions.

    This is a lightweight endpoint for incremental updates.
    Structure is already known from local tree-sitter analysis.
    Only needs LLM for human-readable labels and descriptions.
    """
    # Build prompt from structure context
    files_data = [f.model_dump() for f in request.files]
    prompt = build_metadata_only_prompt(files_data)

    # Add code context if provided
    if request.code:
        prompt += f"\n\nFull code for context:\n{request.code[:8000]}"

    try:
        # Use gemini for metadata generation (simple prompt, no workflow system instruction)
        result, usage, cost = await gemini_client.generate_metadata(prompt)

        # Clean markdown if present
        result = result.strip()
        if result.startswith("```json"):
            result = result[7:]
        if result.startswith("```"):
            result = result[3:]
        if result.endswith("```"):
            result = result[:-3]

        # Parse response
        try:
            metadata_data = json.loads(result.strip())
        except json.JSONDecodeError:
            # Try to recover
            result_clean = result.strip()
            open_braces = result_clean.count('{') - result_clean.count('}')
            open_brackets = result_clean.count('[') - result_clean.count(']')
            result_clean += ']' * max(0, open_brackets)
            result_clean += '}' * max(0, open_braces)
            metadata_data = json.loads(result_clean)

        # Convert to response model
        files_result = []
        for file_data in metadata_data.get('files', []):
            functions = [
                FunctionMetadata(
                    name=f.get('name', ''),
                    label=f.get('label', f.get('name', '')),
                    description=f.get('description', '')
                )
                for f in file_data.get('functions', [])
            ]
            files_result.append(FileMetadataResult(
                filePath=file_data.get('filePath', ''),
                functions=functions,
                edgeLabels=file_data.get('edgeLabels', {})
            ))

        return {
            "files": [f.model_dump() for f in files_result],
            "usage": usage.model_dump(),
            "cost": cost.model_dump()
        }

    except Exception as e:
        raise HTTPException(status_code=500, detail=f"Metadata analysis failed: {str(e)}")


@app.post("/condense-structure")
async def condense_structure(request: CondenseRequest):
    """Condense raw repo structure into workflow-relevant summary.

    Uses LLM to:
    1. Filter out irrelevant files (tests, configs, utilities)
    2. Identify LLM/AI workflow entry points
    3. Create condensed structure for cross-batch context
    """
    try:
        condensed, usage, cost = await gemini_client.condense_repo_structure(request.raw_structure)
        return {
            "condensed_structure": condensed,
            "usage": usage.model_dump(),
            "cost": cost.model_dump()
        }
    except Exception as e:
        raise HTTPException(status_code=500, detail=f"Structure condensation failed: {str(e)}")


@app.get("/health")
async def health():
    return {"status": "ok"}


if __name__ == "__main__":
    import uvicorn
    uvicorn.run(app, host="0.0.0.0", port=8000)
