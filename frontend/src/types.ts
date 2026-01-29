// Shared type definitions for Codag extension

// === Source Location ===
export interface SourceLocation {
    file: string;
    line: number;
    function?: string;
}

// === Edge Payload (data contract) ===
export interface EdgePayload {
    name: string;        // Variable name: "request"
    type: string;        // Type: "AnalyzeRequest"
    description: string; // "User's code submission"
}

// === Workflow Graph Types ===
export interface WorkflowNode {
    id: string;
    label: string;
    description?: string;
    type: string;
    source?: SourceLocation;
    // LLM-specific
    model?: string;
    temperature?: number;
}

export interface WorkflowEdge {
    source: string;
    target: string;
    label?: string;                  // Descriptive (only for decisions/API calls)
    payload?: EdgePayload;           // Data contract
    condition?: string;              // For decision branches
}

export interface ComponentMetadata {
    id: string;
    name: string;
    description?: string;
    nodeIds: string[];
}

export interface WorkflowMetadata {
    id: string;
    name: string;
    description?: string;
    nodeIds: string[];
    components?: ComponentMetadata[];
}

export interface WorkflowGraph {
    nodes: WorkflowNode[];
    edges: WorkflowEdge[];
    llms_detected: string[];
    workflows: WorkflowMetadata[];
}

// === File Metadata (Static Analysis) ===
export interface LocationMetadata {
    line: number;
    type: string;
    description: string;
    function: string;
    variable?: string;
}

export interface FileMetadata {
    file: string;
    locations: LocationMetadata[];
    relatedFiles: string[];
}

// === API Response Types ===
export interface AnalyzeResult {
    graph: WorkflowGraph;
    usage?: TokenUsage;
    cost?: CostData;
}

// === Metadata-Only API Types ===
export interface FunctionContext {
    name: string;
    line: number;
    type: string;  // llm, trigger, function
    calls: string[];
    code?: string;
}

export interface FileStructureContext {
    filePath: string;
    functions: FunctionContext[];
    imports: string[];
}

export interface MetadataRequest {
    files: FileStructureContext[];
    code?: string;
}

export interface FunctionMetadataResult {
    name: string;
    label: string;
    description: string;
}

export interface FileMetadataResult {
    filePath: string;
    functions: FunctionMetadataResult[];
    edgeLabels: Record<string, string>;
}

export interface MetadataBundle {
    files: FileMetadataResult[];
}

// === Cost Tracking Types ===
export interface TokenUsage {
    input_tokens: number;
    output_tokens: number;
    total_tokens: number;
    cached_tokens: number;
}

export interface CostData {
    input_cost: number;
    output_cost: number;
    total_cost: number;
}

export interface CostOperation {
    type: 'analyze' | 'condense' | 'metadata';
    batch_index?: number;
    file_count: number;
    usage: TokenUsage;
    cost: CostData;
    timestamp: number;
}

export interface CostReport {
    operations: CostOperation[];
    totals: {
        input_tokens: number;
        output_tokens: number;
        total_tokens: number;
        total_cost: number;
    };
    duration_ms: number;
}
