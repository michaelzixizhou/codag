// Workflow detection and grouping logic
import { WorkflowGraph, WorkflowGroup, WorkflowComponent, WorkflowNode, WorkflowEdge } from './types';
import { colorFromString } from './utils';

/**
 * Find connected components within a set of node IDs
 * Returns array of arrays, each inner array is a connected component
 */
function findConnectedComponents(
    nodeIds: string[],
    incomingEdges: Map<string, WorkflowEdge[]>,
    outgoingEdges: Map<string, WorkflowEdge[]>
): string[][] {
    const nodeSet = new Set(nodeIds);
    const visited = new Set<string>();
    const components: string[][] = [];

    for (const startId of nodeIds) {
        if (visited.has(startId)) continue;

        // BFS to find all nodes in this component
        const component: string[] = [];
        const queue = [startId];
        visited.add(startId);

        while (queue.length > 0) {
            const currentId = queue.shift()!;
            component.push(currentId);

            // Check outgoing edges (within the workflow)
            const outgoing = outgoingEdges.get(currentId) || [];
            for (const edge of outgoing) {
                if (nodeSet.has(edge.target) && !visited.has(edge.target)) {
                    visited.add(edge.target);
                    queue.push(edge.target);
                }
            }

            // Check incoming edges (within the workflow)
            const incoming = incomingEdges.get(currentId) || [];
            for (const edge of incoming) {
                if (nodeSet.has(edge.source) && !visited.has(edge.source)) {
                    visited.add(edge.source);
                    queue.push(edge.source);
                }
            }
        }

        components.push(component);
    }

    return components;
}

/**
 * Find entry nodes for a component (nodes with no incoming edges from within the component)
 */
function findEntryNodes(
    componentNodeIds: string[],
    incomingEdges: Map<string, WorkflowEdge[]>
): string[] {
    const componentSet = new Set(componentNodeIds);
    const entryNodes: string[] = [];

    for (const nodeId of componentNodeIds) {
        const incoming = incomingEdges.get(nodeId) || [];
        const hasInternalIncoming = incoming.some(e => componentSet.has(e.source));
        if (!hasInternalIncoming) {
            entryNodes.push(nodeId);
        }
    }

    return entryNodes;
}

/**
 * Create a synthetic title node for a workflow
 */
function createTitleNode(workflowId: string, workflowName: string): WorkflowNode {
    return {
        id: `__title_${workflowId}`,
        label: workflowName,
        type: 'workflow-title'
    };
}

/**
 * Create edges from title node to entry nodes
 */
function createTitleEdges(titleNodeId: string, entryNodeIds: string[]): WorkflowEdge[] {
    return entryNodeIds.map(targetId => ({
        source: titleNodeId,
        target: targetId,
        label: ''
    }));
}

/**
 * Detect workflow groups from graph data
 */
export function detectWorkflowGroups(data: WorkflowGraph): WorkflowGroup[] {
    if (data.nodes.length < 5) {
        // Don't group very small graphs
        return [];
    }

    // Prefer backend-provided workflow metadata if available
    if (data.workflows && data.workflows.length > 0) {
        const groups: WorkflowGroup[] = [];

        // Build adjacency lists for finding connected components and entry nodes
        const incomingEdges = new Map<string, WorkflowEdge[]>();
        const outgoingEdges = new Map<string, WorkflowEdge[]>();

        data.nodes.forEach(n => {
            incomingEdges.set(n.id, []);
            outgoingEdges.set(n.id, []);
        });

        data.edges.forEach(e => {
            if (incomingEdges.has(e.target)) {
                incomingEdges.get(e.target)!.push(e);
            }
            if (outgoingEdges.has(e.source)) {
                outgoingEdges.get(e.source)!.push(e);
            }
        });

        // Group workflows by ID first to handle duplicates from multi-file analysis
        const workflowsByBase = new Map<string, { id: string; name: string; description?: string; nodeIds: string[] }>();
        data.workflows.forEach((workflow, idx) => {
            const baseId = workflow.id || `group_${idx}`;

            if (!workflowsByBase.has(baseId)) {
                workflowsByBase.set(baseId, {
                    id: baseId,
                    name: workflow.name,
                    description: workflow.description,
                    nodeIds: []
                });
            }

            // Merge node IDs
            const merged = workflowsByBase.get(baseId)!;
            workflow.nodeIds.forEach(nodeId => {
                if (!merged.nodeIds.includes(nodeId)) {
                    merged.nodeIds.push(nodeId);
                }
            });
        });

        // Merge workflows that are connected by edges (including HTTP edges)
        // This ensures service-to-service connections keep workflows unified
        const nodeToWorkflow = new Map<string, string>();
        workflowsByBase.forEach((wf, wfId) => {
            wf.nodeIds.forEach(nodeId => nodeToWorkflow.set(nodeId, wfId));
        });

        // Union-find for merging workflows
        const workflowParent = new Map<string, string>();
        workflowsByBase.forEach((_, wfId) => workflowParent.set(wfId, wfId));

        function findRoot(id: string): string {
            if (workflowParent.get(id) !== id) {
                workflowParent.set(id, findRoot(workflowParent.get(id)!));
            }
            return workflowParent.get(id)!;
        }

        function unionWorkflows(wf1: string, wf2: string): void {
            const root1 = findRoot(wf1);
            const root2 = findRoot(wf2);
            if (root1 !== root2) {
                workflowParent.set(root2, root1);
            }
        }

        // Check each edge - if it connects nodes in different workflows, merge them
        data.edges.forEach(edge => {
            const sourceWf = nodeToWorkflow.get(edge.source);
            const targetWf = nodeToWorkflow.get(edge.target);

            if (sourceWf && targetWf && sourceWf !== targetWf) {
                unionWorkflows(sourceWf, targetWf);
            }

            // Also add orphan nodes (not in any workflow) to connected workflow
            if (sourceWf && !targetWf) {
                // Target node not in any workflow - add it to source's workflow
                const rootWf = findRoot(sourceWf);
                const wf = workflowsByBase.get(rootWf);
                if (wf && !wf.nodeIds.includes(edge.target)) {
                    wf.nodeIds.push(edge.target);
                    nodeToWorkflow.set(edge.target, rootWf);
                }
            }
            if (targetWf && !sourceWf) {
                // Source node not in any workflow - add it to target's workflow
                const rootWf = findRoot(targetWf);
                const wf = workflowsByBase.get(rootWf);
                if (wf && !wf.nodeIds.includes(edge.source)) {
                    wf.nodeIds.push(edge.source);
                    nodeToWorkflow.set(edge.source, rootWf);
                }
            }
        });

        // Merge workflows based on union-find results
        const mergedWorkflows = new Map<string, { id: string; name: string; description?: string; nodeIds: string[] }>();
        workflowsByBase.forEach((wf, wfId) => {
            const rootId = findRoot(wfId);
            if (!mergedWorkflows.has(rootId)) {
                const rootWf = workflowsByBase.get(rootId)!;
                mergedWorkflows.set(rootId, {
                    id: rootId,
                    name: rootWf.name,
                    description: rootWf.description,
                    nodeIds: [...rootWf.nodeIds]
                });
            }
            if (wfId !== rootId) {
                // Merge this workflow's nodes into the root
                const merged = mergedWorkflows.get(rootId)!;
                wf.nodeIds.forEach(nodeId => {
                    if (!merged.nodeIds.includes(nodeId)) {
                        merged.nodeIds.push(nodeId);
                    }
                });
            }
        });

        // Process each merged workflow (keep disconnected components together)
        mergedWorkflows.forEach((workflow, baseId) => {
            // Get actual node data
            const workflowNodes = workflow.nodeIds.map(id =>
                data.nodes.find(n => n.id === id)
            ).filter(n => n);

            // Find LLM nodes for model names
            const llmNodes = workflowNodes.filter(n => n?.type === 'llm');
            const modelNames = llmNodes.map(n => n?.model).filter((m): m is string => !!m);
            const llmProviders = modelNames.length > 0
                ? [...new Set(modelNames)].join(', ')
                : 'LLM';

            // Find connected components and create title node
            const connectedComponents = findConnectedComponents(
                workflow.nodeIds,
                incomingEdges,
                outgoingEdges
            );

            // Create title node for the workflow
            const titleNode = createTitleNode(baseId, workflow.name);
            const titleNodeId = titleNode.id;

            // Find entry nodes across all components
            let entryNodeIds: string[] = [];
            connectedComponents.forEach(component => {
                const componentEntries = findEntryNodes(component, incomingEdges);
                entryNodeIds.push(...componentEntries);
            });

            // Fallback: if no entry nodes found (circular workflow), use first node from each component
            if (entryNodeIds.length === 0 && connectedComponents.length > 0) {
                entryNodeIds = connectedComponents.map(comp => comp[0]).filter(Boolean);
            }

            // Ultimate fallback: connect to first workflow node
            if (entryNodeIds.length === 0 && workflow.nodeIds.length > 0) {
                entryNodeIds = [workflow.nodeIds[0]];
            }

            // Create edges from title to entry nodes
            const titleEdges = createTitleEdges(titleNodeId, entryNodeIds);

            // Inject title node and edges into graph data
            data.nodes.push(titleNode);
            data.edges.push(...titleEdges);

            // Update adjacency lists for the new title node
            incomingEdges.set(titleNodeId, []);
            outgoingEdges.set(titleNodeId, titleEdges);
            titleEdges.forEach(edge => {
                incomingEdges.get(edge.target)?.push(edge);
            });

            // Include title node in the workflow
            workflow.nodeIds.push(titleNodeId);

            // Parse components from workflow metadata
            const workflowComponents: WorkflowComponent[] = [];
            const originalWorkflow = data.workflows.find(w => w.id === baseId || w.id === workflow.id);
            if (originalWorkflow?.components) {
                originalWorkflow.components.forEach(comp => {
                    const compNodesInWorkflow = comp.nodeIds.filter(id => workflow.nodeIds.includes(id));
                    if (compNodesInWorkflow.length >= 3) {
                        workflowComponents.push({
                            id: comp.id,
                            name: comp.name,
                            description: comp.description,
                            nodes: comp.nodeIds,
                            collapsed: true,
                            color: colorFromString(comp.id),
                            workflowId: baseId
                        });
                    }
                });
            }

            groups.push({
                id: baseId,
                name: workflow.name,
                description: workflow.description,
                nodes: workflow.nodeIds,
                llmProviders,
                collapsed: false,
                color: colorFromString(baseId),
                level: 1,
                components: workflowComponents
            });
        });

        groups.sort((a, b) => a.name.localeCompare(b.name));
        return groups;
    }

    // Fallback: Use client-side BFS grouping
    const groups: WorkflowGroup[] = [];
    const visited = new Set<string>();
    const incomingEdges = new Map<string, any[]>();
    const outgoingEdges = new Map<string, any[]>();

    data.nodes.forEach(n => {
        incomingEdges.set(n.id, []);
        outgoingEdges.set(n.id, []);
    });

    data.edges.forEach(e => {
        incomingEdges.get(e.target)?.push(e);
        outgoingEdges.get(e.source)?.push(e);
    });

    const llmNodes = data.nodes.filter(n => n.type === 'llm');

    llmNodes.forEach((llmNode, idx) => {
        if (visited.has(llmNode.id)) return;

        const groupNodes = new Set<string>();
        const llmNodesInGroup = new Set<any>();

        const queue = [llmNode.id];
        const groupVisited = new Set([llmNode.id]);

        while (queue.length > 0) {
            const currentId = queue.shift()!;
            groupNodes.add(currentId);

            const currentNode = data.nodes.find(n => n.id === currentId);
            if (currentNode && currentNode.type === 'llm') {
                llmNodesInGroup.add(currentNode);
                visited.add(currentNode.id);
            }

            const incoming = incomingEdges.get(currentId) || [];
            for (const edge of incoming) {
                if (!groupVisited.has(edge.source)) {
                    queue.push(edge.source);
                    groupVisited.add(edge.source);
                }
            }

            const outgoing = outgoingEdges.get(currentId) || [];
            for (const edge of outgoing) {
                if (!groupVisited.has(edge.target)) {
                    queue.push(edge.target);
                    groupVisited.add(edge.target);
                }
            }
        }

        const groupNodesList = Array.from(groupNodes);

        if (groupNodesList.length >= 3) {
            // Get model names from the actual LLM nodes in this group
            const modelNames = Array.from(llmNodesInGroup)
                .map((n: any) => n.model)
                .filter((m: string) => !!m);
            const llmProviders = modelNames.length > 0
                ? [...new Set(modelNames)].join(', ')
                : 'LLM';

            const groupName = llmNodesInGroup.size > 1
                ? `Workflow (${llmNodesInGroup.size} LLM nodes)`
                : (llmNode.label || `Workflow ${idx + 1}`);

            const groupId = `group_${idx}`;
            groups.push({
                id: groupId,
                name: groupName,
                nodes: groupNodesList,
                llmProviders: llmProviders,
                collapsed: false,
                color: colorFromString(groupId),
                level: 1,
                components: []  // No components detected client-side
            });
        }
    });

    groups.sort((a, b) => a.name.localeCompare(b.name));
    return groups;
}

/**
 * Update header snapshot stats
 */
export function updateSnapshotStats(workflowGroups: WorkflowGroup[], currentGraphData: WorkflowGraph): void {
    // Only count workflows with 3+ nodes
    const renderedWorkflows = workflowGroups.filter(wf => wf.nodes.length >= 3);
    const visibleWorkflowCount = renderedWorkflows.length;

    // Get all visible node IDs from rendered workflows
    const visibleNodeIds = new Set<string>();
    renderedWorkflows.forEach(wf => wf.nodes.forEach(id => visibleNodeIds.add(id)));

    // Count only LLM nodes that are in visible workflows
    const visibleLlmCalls = currentGraphData.nodes.filter(n => n.type === 'llm' && visibleNodeIds.has(n.id)).length;

    const statWorkflows = document.getElementById('statWorkflows');
    const statLlmCalls = document.getElementById('statLlmCalls');
    const statTimestamp = document.getElementById('statTimestamp');

    if (statWorkflows) statWorkflows.textContent = String(visibleWorkflowCount);
    if (statLlmCalls) statLlmCalls.textContent = String(visibleLlmCalls);

    if (statTimestamp) {
        const now = new Date();
        const hours = now.getHours();
        const minutes = now.getMinutes().toString().padStart(2, '0');
        const ampm = hours >= 12 ? 'PM' : 'AM';
        const hour12 = hours % 12 || 12;
        statTimestamp.textContent = `${hour12}:${minutes} ${ampm}`;
    }
}
