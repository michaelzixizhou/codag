from pydantic import BaseModel, EmailStr
from typing import Optional, List, Dict, Any
from datetime import datetime
from enum import Enum

class Token(BaseModel):
    access_token: str
    refresh_token: str
    token_type: str

class RefreshTokenRequest(BaseModel):
    refresh_token: str

class TokenData(BaseModel):
    email: Optional[str] = None
    user_id: Optional[str] = None  # UUID as string

class User(BaseModel):
    email: str
    is_paid: bool = False
    requests_today: int = 0
    last_request_date: Optional[str] = None


# OAuth Models
class OAuthProvider(str, Enum):
    GITHUB = "github"
    GOOGLE = "google"

class OAuthUser(BaseModel):
    """User response model for OAuth-authenticated users."""
    id: str
    email: str
    name: Optional[str] = None
    avatar_url: Optional[str] = None
    provider: OAuthProvider
    is_paid: bool = False

    class Config:
        from_attributes = True


# Trial/Device Models
class DeviceCheckRequest(BaseModel):
    """Request to check/register a trial device."""
    machine_id: str

class DeviceCheckResponse(BaseModel):
    """Response with trial status."""
    machine_id: str
    remaining_analyses: int
    is_trial: bool = True
    is_authenticated: bool = False

class DeviceLinkRequest(BaseModel):
    """Request to link a device to an authenticated user."""
    machine_id: str

class AuthStateResponse(BaseModel):
    """Full auth state for frontend."""
    is_authenticated: bool
    is_trial: bool
    remaining_analyses: int
    user: Optional[OAuthUser] = None

class LocationMetadata(BaseModel):
    line: int
    type: str
    description: str
    function: str
    variable: Optional[str] = None

class FileMetadata(BaseModel):
    file: str
    locations: List[LocationMetadata]
    relatedFiles: List[str]

class AnalyzeRequest(BaseModel):
    code: str
    file_paths: List[str]
    framework_hint: Optional[str] = None
    metadata: List[FileMetadata] = []

class SourceLocation(BaseModel):
    file: str
    line: int
    function: str

class GraphNode(BaseModel):
    id: str
    label: str
    description: str  # REQUIRED - Gemini must provide this
    type: str
    source: Optional[SourceLocation] = None
    metadata: Optional[Dict[str, Any]] = None
    model: Optional[str] = None  # For LLM nodes: the model name (e.g., "GPT-4", "Claude 3.5 Sonnet", "Gemini 2.5 Flash")
    isEntryPoint: Optional[bool] = False  # Node with no incoming edges
    isExitPoint: Optional[bool] = False   # Node with no outgoing edges

class GraphEdge(BaseModel):
    source: str
    target: str
    label: str  # Variable/class name being passed (REQUIRED)
    variable: Optional[str] = None  # Alias for label (for backwards compatibility)
    dataType: Optional[str] = None  # Data type (e.g., "str", "dict", "AnalyzeRequest")
    description: Optional[str] = None  # What the variable represents
    sourceLocation: Optional[SourceLocation] = None  # Where variable is passed in code

class ComponentMetadata(BaseModel):
    """Sub-component within a workflow (e.g., error handling, tool selection)."""
    id: str  # "comp_1", "comp_2", etc.
    name: str  # Descriptive name (e.g., "Error Handling", "Tool Selection")
    description: str  # 1-2 sentence description
    nodeIds: List[str]  # Node IDs contained in this component

class WorkflowMetadata(BaseModel):
    id: str  # "workflow_1", "workflow_2", etc.
    name: str  # Descriptive name (e.g., "Document Analysis Pipeline")
    description: str  # 1-2 sentence description of workflow purpose
    nodeIds: List[str]  # List of node IDs that belong to this workflow
    components: List[ComponentMetadata] = []  # Sub-components within workflow

class WorkflowGraph(BaseModel):
    nodes: List[GraphNode]
    edges: List[GraphEdge]
    llms_detected: List[str]
    workflows: List[WorkflowMetadata] = []  # Workflow groupings identified by LLM
