export interface SourceLocation {
    file: string;
    line: number;
    function?: string;
}

export interface EdgePayload {
    name: string;
    type: string;
    description: string;
}

export interface WorkflowNode {
    id: string;
    label: string;
    description?: string;
    type: string;
    source?: SourceLocation;
    model?: string;
    temperature?: number;
}

export interface WorkflowEdge {
    source: string;
    target: string;
    label?: string;
    payload?: EdgePayload;
    condition?: string;
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
    _workspacePath?: string; // Set at load time, not serialized
}
