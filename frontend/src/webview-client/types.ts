// Type declarations for webview globals
declare const d3: any;
declare const dagre: any;
declare function acquireVsCodeApi(): any;

interface Window {
    __GRAPH_DATA__: any;
    // Global functions exposed to window
    refreshAnalysis: () => void;
    toggleExpandAll: () => void;
    formatGraph: () => void;
    toggleLegend: () => void;
    resetZoom: () => void;
    zoomIn: () => void;
    zoomOut: () => void;
    closePanel: () => void;
}

// Re-export shared types from parent (avoids duplication)
export { SourceLocation } from '../types';

// Graph data types (extended for D3/visualization)

export interface WorkflowNode {
    id: string;
    label: string;
    type: 'trigger' | 'llm' | 'tool' | 'decision' | 'integration' | 'memory' | 'parser' | 'output';
    description?: string;
    source?: SourceLocation;
    model?: string;  // For LLM nodes: the model name (e.g., "gpt-4", "gemini-2.5-flash")
    isEntryPoint?: boolean;
    isExitPoint?: boolean;
    x?: number;
    y?: number;
    fx?: number;
    fy?: number;
}

export interface WorkflowEdge {
    source: string;
    target: string;
    label?: string;
    dataType?: string;
    description?: string;
    sourceLocation?: SourceLocation;
}

export interface ComponentMetadata {
    id: string;
    name: string;
    description?: string;
    nodeIds: string[];
}

export interface Workflow {
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
    workflows: Workflow[];
}

export interface WorkflowComponent {
    id: string;
    name: string;
    description?: string;
    nodes: string[];  // Node IDs in this component
    collapsed: boolean;  // UI state
    color: string;
    workflowId: string;  // Parent workflow ID
    bounds?: {
        minX: number;
        maxX: number;
        minY: number;
        maxY: number;
    };
    centerX?: number;
    centerY?: number;
}

export interface WorkflowGroup {
    id: string;
    name: string;
    description?: string;
    nodes: string[];
    llmProviders: string;
    collapsed: boolean;
    color: string;
    level: number;
    bounds?: {
        minX: number;
        maxX: number;
        minY: number;
        maxY: number;
    };
    centerX?: number;
    centerY?: number;
    components: WorkflowComponent[];  // Sub-components within workflow
}

export interface NodePosition {
    x: number;
    y: number;
    fx?: number;
    fy?: number;
}

export interface SavedState {
    zoomTransform: any;
    collapsedWorkflows: string[];
    expandedComponents: string[];  // Component IDs that are expanded (default: collapsed)
    selectedNodeId: string | null;
    nodePositions: Map<string, NodePosition>;
}

export interface GraphDiff {
    nodes: {
        added: WorkflowNode[];
        removed: string[];
        updated: WorkflowNode[];
    };
    edges: {
        added: WorkflowEdge[];
        removed: WorkflowEdge[];
        updated: WorkflowEdge[];
    };
}
