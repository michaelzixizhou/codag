/**
 * Type definitions for Copilot workflow context integration
 */

// Tool input from Copilot (all fields optional - auto-detects from active editor)
export interface WorkflowToolInput {
  filePath?: string;
  operation?: string;
}

// View state from webview visualization
export interface ViewState {
  selectedNodeId: string | null;
  selectedNodeLabel?: string;
  selectedNodeType?: string;
  expandedWorkflowIds: string[];
  visibleNodeIds?: string[];
  lastUpdated: number;
}

// Node adjacency info for "insert between X and Y" operations
export interface AdjacentNodeInfo {
  nodeId: string;
  label: string;
  type: string;
  beforeNodes: string[]; // IDs of nodes that come before this one
  afterNodes: string[];  // IDs of nodes that come after this one
  source: {
    file: string;
    line: number;
    function: string;
  };
}

// Workflow structure info
export interface WorkflowInfo {
  name: string;
  nodeIds: string[];     // All node IDs in this workflow
  entryPoints: string[]; // Node IDs
  exitPoints: string[];  // Node IDs
  criticalPath: string[]; // Node IDs in critical path
}

// Cross-file dependency info
export interface CrossFileEdge {
  from: { file: string; nodeId: string };
  to: { file: string; nodeId: string };
  edgeType: string;
}

// Current file's role in the workflow
export interface FileContext {
  nodesInFile: string[]; // Node IDs present in this file
  incomingFromFiles: string[]; // Files that have edges pointing to this file
  outgoingToFiles: string[];   // Files this file has edges pointing to
}

// Complete metadata returned to Copilot
export interface WorkflowMetadata {
  adjacentNodes: AdjacentNodeInfo[];
  workflows: WorkflowInfo[];
  crossFileEdges: CrossFileEdge[];
  fileContext: FileContext;
}
