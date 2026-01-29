from pydantic import BaseModel
from typing import Optional, List, Dict, Any

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
    http_connections: Optional[str] = None  # HTTP connection context for service-to-service edges

class SourceLocation(BaseModel):
    file: str
    line: int
    function: Optional[str] = None


class EdgePayload(BaseModel):
    """Data being passed along an edge"""
    name: str              # Variable name: "request"
    type: str              # Type: "AnalyzeRequest"
    description: str       # "User's code submission"


class GraphEdge(BaseModel):
    source: str
    target: str
    label: Optional[str] = None              # Descriptive (only for decisions/API calls)
    payload: Optional[EdgePayload] = None    # Data contract
    condition: Optional[str] = None          # For decision branches: "if request.is_valid"


class GraphNode(BaseModel):
    id: str
    label: str                               # "Gemini 2.5 Flash", "Validate Request"
    type: str                                # step, llm, decision
    description: Optional[str] = None        # ≤10 words, omit if obvious from label
    source: Optional[SourceLocation] = None

    # LLM-specific
    model: Optional[str] = None
    temperature: Optional[float] = None

class ComponentMetadata(BaseModel):
    """Sub-component within a workflow (e.g., error handling, tool selection)."""
    id: str  # "comp_1", "comp_2", etc.
    name: str  # Descriptive name (e.g., "Error Handling", "Tool Selection")
    description: Optional[str] = None
    nodeIds: List[str]  # Node IDs contained in this component

class WorkflowMetadata(BaseModel):
    id: str  # "workflow_1", "workflow_2", etc.
    name: str  # Descriptive name (e.g., "Document Analysis Pipeline")
    description: Optional[str] = None
    nodeIds: List[str]  # List of node IDs that belong to this workflow
    components: List[ComponentMetadata] = []  # Sub-components within workflow

class WorkflowGraph(BaseModel):
    nodes: List[GraphNode]
    edges: List[GraphEdge]
    llms_detected: List[str] = []  # Computed client-side from node models
    workflows: List[WorkflowMetadata] = []  # Workflow groupings identified by LLM


# Metadata-only models (for incremental updates)
class FunctionContext(BaseModel):
    """Context about a single function for metadata generation."""
    name: str
    line: int
    type: str  # llm, trigger, function
    calls: List[str]  # Functions it calls
    code: Optional[str] = None  # Optional function source

class FileStructureContext(BaseModel):
    """Structure context for a file (from local tree-sitter analysis)."""
    filePath: str
    functions: List[FunctionContext]
    imports: List[str]

class MetadataRequest(BaseModel):
    """Request for metadata-only analysis."""
    files: List[FileStructureContext]
    code: Optional[str] = None  # Optional: full code for better context

class FunctionMetadata(BaseModel):
    """Metadata for a single function."""
    name: str
    label: str  # Human-readable label
    description: str  # Brief description

class FileMetadataResult(BaseModel):
    """Metadata result for a single file."""
    filePath: str
    functions: List[FunctionMetadata]
    edgeLabels: Dict[str, str] = {}  # "fn1→fn2" → label

class MetadataBundle(BaseModel):
    """Response bundle of metadata for multiple files."""
    files: List[FileMetadataResult]


# Structure condensation models
class CondenseRequest(BaseModel):
    """Request to condense raw repo structure into workflow-relevant summary."""
    raw_structure: str  # JSON string of tree-sitter extracted structure

class CondenseResponse(BaseModel):
    """Response with condensed workflow structure."""
    condensed_structure: str


# Cost tracking models
class TokenUsage(BaseModel):
    """Token usage from Gemini API response."""
    input_tokens: int
    output_tokens: int
    total_tokens: int
    cached_tokens: int = 0

class CostData(BaseModel):
    """Cost calculation based on token usage."""
    input_cost: float
    output_cost: float
    total_cost: float

class AnalyzeResponse(BaseModel):
    """Enhanced analyze response with cost tracking."""
    graph: WorkflowGraph
    usage: Optional[TokenUsage] = None
    cost: Optional[CostData] = None  # XML/text summary of workflows
