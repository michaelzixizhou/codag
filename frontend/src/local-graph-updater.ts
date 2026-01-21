/**
 * Local Graph Updater
 *
 * Applies call graph diffs to workflow graphs without LLM.
 * Provides instant structural updates with function names as temporary labels.
 */

import {
    WorkflowGraph,
    WorkflowNode,
    WorkflowEdge,
    WorkflowMetadata
} from './types';

import {
    ExtractedCallGraph,
    CallGraphDiff,
    FunctionInfo
} from './call-graph-extractor';
import { identifyProvider } from './providers';

/**
 * Result of applying a local update
 */
export interface LocalUpdateResult {
    graph: WorkflowGraph;
    nodesAdded: string[];       // New node IDs
    nodesRemoved: string[];     // Removed node IDs
    nodesUpdated: string[];     // Nodes with updated source locations
    edgesAdded: number;
    edgesRemoved: number;
    needsMetadata: string[];    // Nodes that need metadata from LLM
    changedFunctions: string[]; // Function names that changed (for live indicators)
}

/**
 * Cached structure for a file - enables local updates
 */
export interface CachedFileStructure {
    relativePath: string;
    callGraph: ExtractedCallGraph;
    nodeMapping: Map<string, string>;    // function name → node ID
}

/**
 * Convert function name to a readable label (temporary until LLM provides real labels)
 */
function functionNameToLabel(name: string): string {
    // Handle anonymous functions
    if (name.startsWith('anonymous_')) {
        return `Anonymous (line ${name.split('_')[1]})`;
    }

    // Convert camelCase/snake_case to Title Case
    return name
        .replace(/_/g, ' ')
        .replace(/([a-z])([A-Z])/g, '$1 $2')
        .split(' ')
        .map(word => word.charAt(0).toUpperCase() + word.slice(1).toLowerCase())
        .join(' ');
}

/**
 * Generate a stable node ID from file path and function name
 * Format: {relativePath}::{function} to match backend format
 * Example: backend/client.py::analyze_workflow
 */
function generateNodeId(relativePath: string, functionName: string): string {
    // Use :: separator (colons forbidden in filenames, so unambiguous)
    // relativePath should be relative (e.g., "backend/client.py")
    return `${relativePath}::${functionName}`;
}

/**
 * Determine node type from function info
 * Only 3 types: step, llm, decision
 * - llm: Function makes LLM API calls
 * - step: Everything else (decision nodes determined by LLM analysis)
 */
function determineNodeType(
    _functionName: string,
    _info: FunctionInfo,
    hasLLMCalls: boolean
): string {
    if (hasLLMCalls) {
        return 'llm';
    }
    // All other nodes are "step" until LLM classifies them
    return 'step';
}

/**
 * Apply a call graph diff to update a workflow graph locally
 * @param relativePath - Workspace-relative path (e.g., "backend/client.py") for node IDs
 */
export function applyLocalUpdate(
    currentGraph: WorkflowGraph,
    diff: CallGraphDiff,
    newCallGraph: ExtractedCallGraph,
    relativePath: string
): LocalUpdateResult {
    // Deep clone to avoid mutation
    const graph: WorkflowGraph = JSON.parse(JSON.stringify(currentGraph));

    const result: LocalUpdateResult = {
        graph,
        nodesAdded: [],
        nodesRemoved: [],
        nodesUpdated: [],
        edgesAdded: 0,
        edgesRemoved: 0,
        needsMetadata: [],
        changedFunctions: []
    };

    // Build lookup for existing nodes
    const nodeById = new Map<string, WorkflowNode>();
    const nodeByFunction = new Map<string, WorkflowNode>();

    for (const node of graph.nodes) {
        nodeById.set(node.id, node);
        if (node.source?.function) {
            nodeByFunction.set(`${node.source.file}:${node.source.function}`, node);
        }
    }

    // 1. Handle removed functions - remove nodes
    for (const funcName of diff.removedFunctions) {
        const key = `${relativePath}:${funcName}`;
        const existingNode = nodeByFunction.get(key);

        if (existingNode) {
            // Remove node
            graph.nodes = graph.nodes.filter(n => n.id !== existingNode.id);
            result.nodesRemoved.push(existingNode.id);

            // Remove edges involving this node
            const beforeEdges = graph.edges.length;
            graph.edges = graph.edges.filter(
                e => e.source !== existingNode.id && e.target !== existingNode.id
            );
            result.edgesRemoved += beforeEdges - graph.edges.length;

            // Remove from workflows
            for (const wf of graph.workflows) {
                wf.nodeIds = wf.nodeIds.filter(id => id !== existingNode.id);
            }
        }
    }

    // 2. Handle added functions - create new nodes
    for (const funcName of diff.addedFunctions) {
        const funcInfo = newCallGraph.functions.get(funcName);
        if (!funcInfo) continue;

        // Skip anonymous functions (callbacks) unless they have LLM calls
        const hasLLMCalls = newCallGraph.llmCalls.has(funcName);
        if (funcName.startsWith('anonymous_') && !hasLLMCalls) {
            continue;
        }

        const nodeId = generateNodeId(relativePath, funcName);
        const nodeType = determineNodeType(funcName, funcInfo, hasLLMCalls);

        const newNode: WorkflowNode = {
            id: nodeId,
            label: functionNameToLabel(funcName),
            type: nodeType,
            source: {
                file: relativePath,
                line: funcInfo.startLine,
                function: funcName
            }
        };

        graph.nodes.push(newNode);
        result.nodesAdded.push(nodeId);
        result.needsMetadata.push(nodeId);

        nodeById.set(nodeId, newNode);
        nodeByFunction.set(`${relativePath}:${funcName}`, newNode);

        // Also add edges from this new function to existing nodes
        const calls = newCallGraph.callGraph.get(funcName) || [];
        for (const callee of calls) {
            // Look for target in current file or any existing node
            let targetNode = nodeByFunction.get(`${relativePath}:${callee}`);
            if (!targetNode) {
                targetNode = graph.nodes.find(n =>
                    n.source?.function === callee ||
                    n.id.endsWith(`_${callee}`)
                );
            }

            if (targetNode && nodeId !== targetNode.id) {
                graph.edges.push({
                    source: nodeId,
                    target: targetNode.id
                });
                result.edgesAdded++;
            }
        }
    }

    // 3. Handle modified functions - update source locations
    for (const funcName of diff.modifiedFunctions) {
        const key = `${relativePath}:${funcName}`;
        const existingNode = nodeByFunction.get(key);
        const funcInfo = newCallGraph.functions.get(funcName);

        if (existingNode && funcInfo) {
            existingNode.source = {
                file: relativePath,
                line: funcInfo.startLine,
                function: funcName
            };
            result.nodesUpdated.push(existingNode.id);
        }
    }

    // 4. Handle added edges
    for (const edge of diff.addedEdges) {
        const sourceNode = nodeByFunction.get(`${relativePath}:${edge.from}`);

        // Try to find target - could be in same file or external
        let targetNode = nodeByFunction.get(`${relativePath}:${edge.to}`);

        // If target not found in this file, look in all nodes by function name match
        if (!targetNode) {
            targetNode = graph.nodes.find(n =>
                n.source?.function === edge.to ||
                n.id.endsWith(`_${edge.to}`)
            );
        }

        if (sourceNode && targetNode && sourceNode.id !== targetNode.id) {
            // Check if edge already exists
            const exists = graph.edges.some(
                e => e.source === sourceNode.id && e.target === targetNode!.id
            );

            if (!exists) {
                graph.edges.push({
                    source: sourceNode.id,
                    target: targetNode.id
                });
                result.edgesAdded++;
            }
        }
    }

    // 5. Handle removed edges
    for (const edge of diff.removedEdges) {
        const sourceNode = nodeByFunction.get(`${relativePath}:${edge.from}`);
        const targetNode = nodeByFunction.get(`${relativePath}:${edge.to}`) ||
            graph.nodes.find(n => n.source?.function === edge.to);

        if (sourceNode && targetNode) {
            const beforeCount = graph.edges.length;
            graph.edges = graph.edges.filter(
                e => !(e.source === sourceNode.id && e.target === targetNode!.id)
            );
            result.edgesRemoved += beforeCount - graph.edges.length;
        }
    }

    // 6. Clean up empty workflows
    graph.workflows = graph.workflows.filter(wf => wf.nodeIds.length > 0);

    result.graph = graph;
    return result;
}

/**
 * Create an initial graph from a call graph extraction (no existing graph)
 * @param relativePath - Workspace-relative path (e.g., "backend/client.py") for node IDs
 */
export function createGraphFromCallGraph(
    callGraph: ExtractedCallGraph,
    relativePath: string
): WorkflowGraph {
    const nodes: WorkflowNode[] = [];
    const edges: WorkflowEdge[] = [];
    const nodeById = new Map<string, WorkflowNode>();

    // Create nodes for each function (skip most anonymous functions)
    for (const [funcName, funcInfo] of callGraph.functions) {
        const hasLLMCalls = callGraph.llmCalls.has(funcName);

        // Skip anonymous unless they have LLM calls
        if (funcName.startsWith('anonymous_') && !hasLLMCalls) {
            continue;
        }

        const nodeId = generateNodeId(relativePath, funcName);
        const nodeType = determineNodeType(funcName, funcInfo, hasLLMCalls);

        const node: WorkflowNode = {
            id: nodeId,
            label: functionNameToLabel(funcName),
            type: nodeType,
            source: {
                file: relativePath,
                line: funcInfo.startLine,
                function: funcName
            }
        };

        nodes.push(node);
        nodeById.set(funcName, node);
    }

    // Create edges from call graph
    for (const [caller, callees] of callGraph.callGraph) {
        const sourceNode = nodeById.get(caller);
        if (!sourceNode) continue;

        for (const callee of callees) {
            const targetNode = nodeById.get(callee);
            if (targetNode && sourceNode.id !== targetNode.id) {
                edges.push({
                    source: sourceNode.id,
                    target: targetNode.id
                });
            }
        }
    }

    // Detect LLM providers from imports using centralized provider detection
    const llmsDetected: string[] = [];
    for (const imp of callGraph.imports) {
        const provider = identifyProvider(imp);
        if (provider && !llmsDetected.includes(provider)) {
            llmsDetected.push(provider);
        }
    }

    // Create a single workflow containing all nodes
    const fileName = relativePath.split('/').pop()?.replace(/\.[^.]+$/, '') || 'unknown';
    const workflow: WorkflowMetadata = {
        id: `workflow_${fileName}`,
        name: fileName,
        description: `Workflow from ${fileName}`,
        nodeIds: nodes.map(n => n.id)
    };

    return {
        nodes,
        edges,
        llms_detected: [...new Set(llmsDetected)],
        workflows: [workflow]
    };
}

/**
 * Check if a graph has meaningful content (not just empty)
 */
export function hasWorkflowContent(graph: WorkflowGraph): boolean {
    // Need at least one LLM node or trigger node
    return graph.nodes.some(n =>
        n.type === 'llm' || n.type === 'trigger'
    );
}
