// Shared type definitions for Codag extension

// === Source Location ===
export interface SourceLocation {
    file: string;
    line: number;
    function: string;
}

// === Workflow Graph Types ===
export interface WorkflowNode {
    id: string;
    label: string;
    description?: string;
    type: string;
    source?: SourceLocation;
    metadata?: any;
    isEntryPoint?: boolean;
    isExitPoint?: boolean;
}

export interface WorkflowEdge {
    source: string;
    target: string;
    label?: string;
}

export interface WorkflowMetadata {
    id: string;
    name: string;
    description: string;
    nodeIds: string[];
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

// === Auth Types ===
export type OAuthProvider = 'github' | 'google';

export interface OAuthUser {
    id: string;
    email: string;
    name?: string;
    avatar_url?: string;
    provider: OAuthProvider;
    is_paid: boolean;
}

export interface AuthState {
    isAuthenticated: boolean;
    isTrial: boolean;
    remainingAnalyses: number;
    user?: OAuthUser;
}

// === API Response Types ===
export interface DeviceCheckResponse {
    machine_id: string;
    remaining_analyses: number;
    is_trial: boolean;
    is_authenticated: boolean;
}

export interface AnalyzeResult {
    graph: WorkflowGraph;
    remainingAnalyses: number;  // -1 for unlimited (authenticated users)
}
