import type { WorkflowEdge } from "./types.js";

/**
 * Kahn's algorithm for topological sorting of a DAG.
 * Returns node IDs in dependency order (sources first).
 */
export function topologicalSort(nodeIds: string[], edges: WorkflowEdge[]): string[] {
    const nodeSet = new Set(nodeIds);
    const inDegree = new Map<string, number>();
    const adj = new Map<string, string[]>();

    for (const id of nodeIds) {
        inDegree.set(id, 0);
        adj.set(id, []);
    }

    for (const edge of edges) {
        if (nodeSet.has(edge.source) && nodeSet.has(edge.target)) {
            adj.get(edge.source)!.push(edge.target);
            inDegree.set(edge.target, (inDegree.get(edge.target) ?? 0) + 1);
        }
    }

    const queue: string[] = [];
    for (const [id, deg] of inDegree) {
        if (deg === 0) queue.push(id);
    }

    const result: string[] = [];
    while (queue.length > 0) {
        const node = queue.shift()!;
        result.push(node);
        for (const neighbor of adj.get(node) ?? []) {
            const newDeg = inDegree.get(neighbor)! - 1;
            inDegree.set(neighbor, newDeg);
            if (newDeg === 0) queue.push(neighbor);
        }
    }

    // Append any nodes not reached (cycles — shouldn't happen but be safe)
    for (const id of nodeIds) {
        if (!result.includes(id)) result.push(id);
    }

    return result;
}
