from pydantic import BaseModel, EmailStr
from typing import Optional, List, Dict, Any
from datetime import datetime

class UserCreate(BaseModel):
    email: EmailStr
    password: str

class UserLogin(BaseModel):
    email: EmailStr
    password: str

class Token(BaseModel):
    access_token: str
    token_type: str

class TokenData(BaseModel):
    email: Optional[str] = None

class User(BaseModel):
    email: str
    is_paid: bool = False
    requests_today: int = 0
    last_request_date: Optional[str] = None

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
    isEntryPoint: Optional[bool] = False  # Node with no incoming edges
    isExitPoint: Optional[bool] = False   # Node with no outgoing edges
    isCriticalPath: Optional[bool] = False  # Part of longest execution path

class GraphEdge(BaseModel):
    source: str
    target: str
    label: str  # Variable/class name being passed (REQUIRED)
    variable: Optional[str] = None  # Alias for label (for backwards compatibility)
    dataType: Optional[str] = None  # Data type (e.g., "str", "dict", "AnalyzeRequest")
    description: Optional[str] = None  # What the variable represents
    sourceLocation: Optional[SourceLocation] = None  # Where variable is passed in code
    isCriticalPath: Optional[bool] = False  # Part of longest execution path

class WorkflowGraph(BaseModel):
    nodes: List[GraphNode]
    edges: List[GraphEdge]
    llms_detected: List[str]
