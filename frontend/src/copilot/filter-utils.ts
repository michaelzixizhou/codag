/**
 * Shared filtering utilities for ViewState-based workflow filtering
 * Used by both webview rendering and Copilot tools to ensure consistency
 */

import { WorkflowGraph, WorkflowMetadata } from '../api';

export interface Node {
    id: string;
}

export interface Edge {
    source: string;
    target: string;
}

/**
 * Filter workflows to only those expanded by the user
 * If expandedWorkflowIds is empty, returns all workflows (no filtering)
 *
 * @param workflows - All workflows in the graph
 * @param expandedWorkflowIds - Array of workflow names that are currently expanded
 * @returns Filtered array of workflows
 */
export function filterToExpandedWorkflows(
    workflows: WorkflowMetadata[],
    expandedWorkflowIds: string[]
): WorkflowMetadata[] {
    if (!expandedWorkflowIds || expandedWorkflowIds.length === 0) {
        // No filtering - return all workflows
        return workflows;
    }

    const expandedSet = new Set(expandedWorkflowIds);
    return workflows.filter(wf => expandedSet.has(wf.name));
}

/**
 * Get set of node IDs visible in expanded workflows
 *
 * @param workflows - All workflows in the graph
 * @param expandedWorkflowIds - Array of workflow names that are currently expanded
 * @returns Set of node IDs that are visible
 */
export function getVisibleNodeIds(
    workflows: WorkflowMetadata[],
    expandedWorkflowIds: string[]
): Set<string> {
    const visibleWorkflows = filterToExpandedWorkflows(workflows, expandedWorkflowIds);
    const visibleNodeIds = new Set<string>();

    visibleWorkflows.forEach(wf => {
        wf.nodeIds.forEach(nodeId => visibleNodeIds.add(nodeId));
    });

    return visibleNodeIds;
}

/**
 * Filter nodes to only those in expanded workflows
 * If expandedWorkflowIds is empty, returns all nodes (no filtering)
 *
 * @param allNodes - All nodes in the graph
 * @param workflows - All workflows in the graph
 * @param expandedWorkflowIds - Array of workflow names that are currently expanded
 * @returns Filtered array of nodes
 */
export function filterToExpandedNodes<T extends Node>(
    allNodes: T[],
    workflows: WorkflowMetadata[],
    expandedWorkflowIds: string[]
): T[] {
    if (!expandedWorkflowIds || expandedWorkflowIds.length === 0) {
        // No filtering - return all nodes
        return allNodes;
    }

    const visibleNodeIds = getVisibleNodeIds(workflows, expandedWorkflowIds);
    return allNodes.filter(n => visibleNodeIds.has(n.id));
}

/**
 * Filter edges to only those connecting visible nodes
 * If visibleNodeIds is empty, returns all edges (no filtering)
 *
 * @param allEdges - All edges in the graph
 * @param visibleNodeIds - Set of node IDs that are visible
 * @returns Filtered array of edges
 */
export function filterToExpandedEdges<T extends Edge>(
    allEdges: T[],
    visibleNodeIds: Set<string>
): T[] {
    if (visibleNodeIds.size === 0) {
        // No filtering - return all edges
        return allEdges;
    }

    return allEdges.filter(e =>
        visibleNodeIds.has(e.source) && visibleNodeIds.has(e.target)
    );
}

/**
 * Filter entire graph to only expanded workflows
 * Convenience function for filtering WorkflowGraph objects
 * If expandedWorkflowIds is empty, returns the original graph (no filtering)
 *
 * @param graph - The complete workflow graph
 * @param expandedWorkflowIds - Array of workflow names that are currently expanded
 * @returns Filtered workflow graph
 */
export function filterGraphToExpanded(
    graph: WorkflowGraph,
    expandedWorkflowIds: string[]
): WorkflowGraph {
    if (!expandedWorkflowIds || expandedWorkflowIds.length === 0) {
        // No filtering - return original graph
        return graph;
    }

    const visibleWorkflows = filterToExpandedWorkflows(graph.workflows, expandedWorkflowIds);
    const visibleNodeIds = getVisibleNodeIds(graph.workflows, expandedWorkflowIds);
    const visibleNodes = graph.nodes.filter(n => visibleNodeIds.has(n.id));
    const visibleEdges = filterToExpandedEdges(graph.edges, visibleNodeIds);

    return {
        ...graph,
        workflows: visibleWorkflows,
        nodes: visibleNodes,
        edges: visibleEdges
    };
}
