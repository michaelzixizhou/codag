// Graph diffing logic for incremental updates
import { WorkflowGraph, WorkflowNode, WorkflowEdge, Workflow, GraphDiff } from './types';

export function computeGraphDiff(oldGraph: WorkflowGraph, newGraph: WorkflowGraph): GraphDiff & { workflows: { added: Workflow[]; removed: string[]; updated: Workflow[] } } {
    const diff = {
        nodes: { added: [] as WorkflowNode[], removed: [] as string[], updated: [] as WorkflowNode[] },
        edges: { added: [] as WorkflowEdge[], removed: [] as WorkflowEdge[], updated: [] as WorkflowEdge[] },
        workflows: { added: [] as Workflow[], removed: [] as string[], updated: [] as Workflow[] }
    };

    // Build lookup maps
    const oldNodeMap = new Map(oldGraph.nodes.map(n => [n.id, n]));
    const newNodeMap = new Map(newGraph.nodes.map(n => [n.id, n]));

    const edgeKey = (e: WorkflowEdge) => `${e.source}->${e.target}`;
    const oldEdgeMap = new Map(oldGraph.edges.map(e => [edgeKey(e), e]));
    const newEdgeMap = new Map(newGraph.edges.map(e => [edgeKey(e), e]));

    const oldWorkflowMap = new Map((oldGraph.workflows || []).map(w => [w.id, w]));
    const newWorkflowMap = new Map((newGraph.workflows || []).map(w => [w.id, w]));

    // Diff nodes
    newGraph.nodes.forEach(newNode => {
        const oldNode = oldNodeMap.get(newNode.id);
        if (!oldNode) {
            diff.nodes.added.push(newNode);
        } else if (nodeChanged(oldNode, newNode)) {
            diff.nodes.updated.push(newNode);
        }
    });

    oldGraph.nodes.forEach(oldNode => {
        if (!newNodeMap.has(oldNode.id)) {
            diff.nodes.removed.push(oldNode.id);
        }
    });

    // Diff edges
    newGraph.edges.forEach(newEdge => {
        const key = edgeKey(newEdge);
        const oldEdge = oldEdgeMap.get(key);
        if (!oldEdge) {
            diff.edges.added.push(newEdge);
        } else if (edgeChanged(oldEdge, newEdge)) {
            diff.edges.updated.push(newEdge);
        }
    });

    oldGraph.edges.forEach(oldEdge => {
        const key = edgeKey(oldEdge);
        if (!newEdgeMap.has(key)) {
            diff.edges.removed.push({ source: oldEdge.source, target: oldEdge.target });
        }
    });

    // Diff workflows
    (newGraph.workflows || []).forEach(newWorkflow => {
        const oldWorkflow = oldWorkflowMap.get(newWorkflow.id);
        if (!oldWorkflow) {
            diff.workflows.added.push(newWorkflow);
        } else if (workflowChanged(oldWorkflow, newWorkflow)) {
            diff.workflows.updated.push(newWorkflow);
        }
    });

    (oldGraph.workflows || []).forEach(oldWorkflow => {
        if (!newWorkflowMap.has(oldWorkflow.id)) {
            diff.workflows.removed.push(oldWorkflow.id);
        }
    });

    return diff;
}

function nodeChanged(oldNode: WorkflowNode, newNode: WorkflowNode): boolean {
    return oldNode.label !== newNode.label ||
           oldNode.type !== newNode.type ||
           oldNode.description !== newNode.description ||
           oldNode.isEntryPoint !== newNode.isEntryPoint ||
           oldNode.isExitPoint !== newNode.isExitPoint ||
           JSON.stringify(oldNode.source) !== JSON.stringify(newNode.source);
}

function edgeChanged(oldEdge: WorkflowEdge, newEdge: WorkflowEdge): boolean {
    return oldEdge.label !== newEdge.label;
}

function workflowChanged(oldWorkflow: Workflow, newWorkflow: Workflow): boolean {
    return oldWorkflow.name !== newWorkflow.name ||
           oldWorkflow.description !== newWorkflow.description ||
           JSON.stringify(oldWorkflow.nodeIds.slice().sort()) !== JSON.stringify(newWorkflow.nodeIds.slice().sort());
}

export function hasDiff(diff: GraphDiff & { workflows?: { added: any[]; removed: any[]; updated: any[] } }): boolean {
    return diff.nodes.added.length > 0 ||
           diff.nodes.removed.length > 0 ||
           diff.nodes.updated.length > 0 ||
           diff.edges.added.length > 0 ||
           diff.edges.removed.length > 0 ||
           diff.edges.updated.length > 0 ||
           (diff.workflows?.added?.length ?? 0) > 0 ||
           (diff.workflows?.removed?.length ?? 0) > 0 ||
           (diff.workflows?.updated?.length ?? 0) > 0;
}
