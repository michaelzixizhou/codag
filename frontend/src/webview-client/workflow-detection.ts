// Workflow detection and grouping logic
import { WorkflowGraph, WorkflowGroup, WorkflowComponent } from './types';
import { colorFromString } from './utils';

/**
 * Ensure visual cues (entry/exit points) are set
 */
export function ensureVisualCues(data: WorkflowGraph): void {
    // Build adjacency lists
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

    // Detect entry/exit points
    data.nodes.forEach(node => {
        if (!node.isEntryPoint && (incomingEdges.get(node.id)?.length ?? 0) === 0) {
            node.isEntryPoint = true;
        }
        if (!node.isExitPoint && (outgoingEdges.get(node.id)?.length ?? 0) === 0) {
            node.isExitPoint = true;
        }
    });
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

        // Build adjacency lists for connectivity validation
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

        // Group workflows by ID first to handle duplicates from multi-file analysis
        const workflowsByBase = new Map<string, { id: string; name: string; description?: string; nodeIds: string[] }>();
        data.workflows.forEach((workflow, idx) => {
            const workflowNodes = data.nodes.filter(n => workflow.nodeIds.includes(n.id));
            const llmNodesInWorkflow = workflowNodes.filter(n => n.type === 'llm');

            // ONLY include workflows that have LLM nodes
            if (llmNodesInWorkflow.length === 0) {
                return;
            }

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

        // Process each merged workflow and split into connected components
        workflowsByBase.forEach((workflow, baseId) => {
            const visited = new Set<string>();
            const connectedComponents: string[][] = [];
            const workflowNodeSet = new Set(workflow.nodeIds);

            workflow.nodeIds.forEach(startNodeId => {
                if (visited.has(startNodeId)) return;

                // BFS to find all connected nodes within this workflow
                const component = new Set<string>();
                const queue = [startNodeId];
                const queueVisited = new Set([startNodeId]);

                while (queue.length > 0) {
                    const currentId = queue.shift()!;
                    component.add(currentId);
                    visited.add(currentId);

                    // Traverse edges only to nodes within this workflow
                    const incoming = incomingEdges.get(currentId) || [];
                    for (const edge of incoming) {
                        if (!queueVisited.has(edge.source) && workflowNodeSet.has(edge.source)) {
                            queue.push(edge.source);
                            queueVisited.add(edge.source);
                        }
                    }

                    const outgoing = outgoingEdges.get(currentId) || [];
                    for (const edge of outgoing) {
                        if (!queueVisited.has(edge.target) && workflowNodeSet.has(edge.target)) {
                            queue.push(edge.target);
                            queueVisited.add(edge.target);
                        }
                    }
                }

                connectedComponents.push(Array.from(component));
            });

            // Create a separate group for each connected component
            if (connectedComponents.length > 1) {
                console.warn(
                    `Workflow "${workflow.name}" contains ${connectedComponents.length} disconnected components.`
                );
            }

            connectedComponents.forEach((componentNodes, compIdx) => {
                const groupId = connectedComponents.length > 1
                    ? `${baseId}_${compIdx}`
                    : baseId;

                // Get actual node data for this component
                const componentNodesData = componentNodes.map(id =>
                    data.nodes.find(n => n.id === id)
                ).filter(n => n);

                // Find LLM nodes within this component to determine model names
                const llmNodes = componentNodesData.filter(n => n?.type === 'llm');
                const modelNames = llmNodes
                    .map(n => n?.model)
                    .filter((m): m is string => !!m);
                const llmProviders = modelNames.length > 0
                    ? [...new Set(modelNames)].join(', ')
                    : 'LLM';

                let groupName = workflow.name;

                if (connectedComponents.length > 1) {
                    const entryNodes = componentNodesData.filter(n => n?.isEntryPoint);

                    if (entryNodes.length > 0 && entryNodes[0]) {
                        groupName = `${workflow.name} - ${entryNodes[0].label}`;
                    } else if (llmNodes.length > 0 && llmNodes[0]) {
                        groupName = `${workflow.name} - ${llmNodes[0].label}`;
                    } else {
                        groupName = `${workflow.name} (Part ${compIdx + 1})`;
                    }
                }

                // Parse components from workflow metadata
                const workflowComponents: WorkflowComponent[] = [];
                const originalWorkflow = data.workflows.find(w => w.id === baseId || w.id === workflow.id);
                if (originalWorkflow?.components) {
                    const componentNodeSet = new Set(componentNodes);
                    originalWorkflow.components.forEach(comp => {
                        // Only include components whose nodes are all in this connected component
                        const compNodesInComponent = comp.nodeIds.filter(id => componentNodeSet.has(id));
                        if (compNodesInComponent.length >= 3 && compNodesInComponent.length === comp.nodeIds.length) {
                            workflowComponents.push({
                                id: comp.id,
                                name: comp.name,
                                description: comp.description,
                                nodes: comp.nodeIds,
                                collapsed: true,  // Default: collapsed
                                color: colorFromString(comp.id),
                                workflowId: groupId
                            });
                        }
                    });
                }

                groups.push({
                    id: groupId,
                    name: groupName,
                    description: workflow.description,
                    nodes: componentNodes,
                    llmProviders: llmProviders,
                    collapsed: false,
                    color: colorFromString(groupId),
                    level: 1,
                    components: workflowComponents
                });
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
