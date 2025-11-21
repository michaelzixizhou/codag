/**
 * Graph filtering utilities for removing orphaned nodes
 * Applies the same filtering logic used in webview rendering to Copilot context
 */

import { WorkflowGraph } from '../api';

/**
 * Filters out orphaned nodes and their edges from the graph
 * Orphaned nodes are those NOT in workflow groups (connected components with LLM nodes and 3+ nodes)
 * This ensures Copilot context matches what's rendered in the webview
 */
export function filterOrphanedNodes(graph: WorkflowGraph): WorkflowGraph {
    // Return empty graph if no nodes
    if (!graph.nodes || graph.nodes.length === 0) {
        return { ...graph, nodes: [], edges: [] };
    }

    // Build adjacency maps for connectivity analysis
    const incomingEdges = new Map<string, string[]>();
    const outgoingEdges = new Map<string, string[]>();

    graph.nodes.forEach(n => {
        incomingEdges.set(n.id, []);
        outgoingEdges.set(n.id, []);
    });

    graph.edges.forEach(e => {
        const incoming = incomingEdges.get(e.target);
        const outgoing = outgoingEdges.get(e.source);
        if (incoming) incoming.push(e.source);
        if (outgoing) outgoing.push(e.target);
    });

    // Find all connected components using BFS
    const visited = new Set<string>();
    const validNodeIds = new Set<string>();
    const llmNodes = graph.nodes.filter(n => n.type === 'llm');

    // Start BFS from each unvisited LLM node
    llmNodes.forEach(llmNode => {
        if (visited.has(llmNode.id)) return;

        // BFS to find entire connected component
        const component = new Set<string>();
        const queue = [llmNode.id];
        const queueVisited = new Set([llmNode.id]);

        while (queue.length > 0) {
            const currentId = queue.shift()!;
            component.add(currentId);
            visited.add(currentId);

            // Traverse backward through incoming edges
            const incoming = incomingEdges.get(currentId) || [];
            for (const sourceId of incoming) {
                if (!queueVisited.has(sourceId)) {
                    queue.push(sourceId);
                    queueVisited.add(sourceId);
                }
            }

            // Traverse forward through outgoing edges
            const outgoing = outgoingEdges.get(currentId) || [];
            for (const targetId of outgoing) {
                if (!queueVisited.has(targetId)) {
                    queue.push(targetId);
                    queueVisited.add(targetId);
                }
            }
        }

        // Only include components with 3+ nodes (workflow groups)
        if (component.size >= 3) {
            component.forEach(id => validNodeIds.add(id));
        }
    });

    // Filter nodes to only those in valid workflow groups
    const filteredNodes = graph.nodes.filter(n => validNodeIds.has(n.id));

    // Filter edges to only those where BOTH source AND target are in valid nodes
    const filteredEdges = graph.edges.filter(e =>
        validNodeIds.has(e.source) && validNodeIds.has(e.target)
    );

    // Return filtered graph with same structure
    return {
        ...graph,
        nodes: filteredNodes,
        edges: filteredEdges
    };
}
