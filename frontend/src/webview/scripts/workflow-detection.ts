/**
 * Workflow detection and grouping logic
 * Detects entry/exit points, critical paths, and workflow groups
 */

export const workflowDetectionScript = `
        // Fallback: Detect entry/exit points and critical path if backend didn't set them
        function ensureVisualCues(data) {
            // Build adjacency lists
            const incomingEdges = new Map();
            const outgoingEdges = new Map();

            data.nodes.forEach(n => {
                incomingEdges.set(n.id, []);
                outgoingEdges.set(n.id, []);
            });

            data.edges.forEach(e => {
                incomingEdges.get(e.target).push(e);
                outgoingEdges.get(e.source).push(e);
            });

            // Detect entry/exit points
            data.nodes.forEach(node => {
                if (!node.isEntryPoint && incomingEdges.get(node.id).length === 0) {
                    node.isEntryPoint = true;
                }
                if (!node.isExitPoint && outgoingEdges.get(node.id).length === 0) {
                    node.isExitPoint = true;
                }
            });

            // Detect critical path: find LLM nodes and mark path through them
            const llmNodes = data.nodes.filter(n => n.type === 'llm');
            if (llmNodes.length > 0 && !llmNodes.some(n => n.isCriticalPath)) {
                // Simple heuristic: mark first LLM node and its connected path
                const llmNode = llmNodes[0];
                llmNode.isCriticalPath = true;

                // Trace backwards to entry
                let current = llmNode;
                while (true) {
                    const incoming = incomingEdges.get(current.id);
                    if (incoming.length === 0) break;

                    incoming[0].isCriticalPath = true;
                    const sourceNode = data.nodes.find(n => n.id === incoming[0].source);
                    if (sourceNode) {
                        sourceNode.isCriticalPath = true;
                        current = sourceNode;
                    } else break;
                }

                // Trace forwards to exit
                current = llmNode;
                while (true) {
                    const outgoing = outgoingEdges.get(current.id);
                    if (outgoing.length === 0) break;

                    outgoing[0].isCriticalPath = true;
                    const targetNode = data.nodes.find(n => n.id === outgoing[0].target);
                    if (targetNode) {
                        targetNode.isCriticalPath = true;
                        current = targetNode;
                    } else break;
                }
            }
        }

        ensureVisualCues(currentGraphData);

        // Detect workflow groups (collapsed by default for large graphs)
        function detectWorkflowGroups(data) {
            if (data.nodes.length < 5) {
                // Don't group very small graphs (< 5 nodes)
                return [];
            }

            // Prefer backend-provided workflow metadata if available
            if (data.workflows && data.workflows.length > 0) {
                const groups = [];

                // Build adjacency lists for connectivity validation
                const incomingEdges = new Map();
                const outgoingEdges = new Map();
                data.nodes.forEach(n => {
                    incomingEdges.set(n.id, []);
                    outgoingEdges.set(n.id, []);
                });
                data.edges.forEach(e => {
                    incomingEdges.get(e.target).push(e);
                    outgoingEdges.get(e.source).push(e);
                });

                // Group workflows by ID first to handle duplicates from multi-file analysis
                const workflowsByBase = new Map();
                data.workflows.forEach((workflow, idx) => {
                    const workflowNodes = data.nodes.filter(n => workflow.nodeIds.includes(n.id));
                    const llmNodesInWorkflow = workflowNodes.filter(n => n.type === 'llm');

                    // ONLY include workflows that have LLM nodes
                    if (llmNodesInWorkflow.length === 0) {
                        return;  // Skip non-LLM workflows
                    }

                    // Extract base workflow ID (remove file-specific suffixes if any)
                    const baseId = workflow.id || 'group_' + idx;

                    if (!workflowsByBase.has(baseId)) {
                        workflowsByBase.set(baseId, {
                            id: baseId,
                            name: workflow.name,
                            description: workflow.description,
                            nodeIds: []
                        });
                    }

                    // Merge node IDs from all instances of this workflow
                    const merged = workflowsByBase.get(baseId);
                    workflow.nodeIds.forEach(nodeId => {
                        if (!merged.nodeIds.includes(nodeId)) {
                            merged.nodeIds.push(nodeId);
                        }
                    });
                });

                // Now process each merged workflow and split into connected components
                workflowsByBase.forEach((workflow, baseId) => {
                    // VALIDATE: Split disconnected components within this workflow
                    const visited = new Set();
                    const connectedComponents = [];

                    // Constrain BFS to only nodes within this workflow
                    const workflowNodeSet = new Set(workflow.nodeIds);

                    workflow.nodeIds.forEach(startNodeId => {
                        if (visited.has(startNodeId)) return;

                        // BFS to find all connected nodes within this workflow
                        const component = new Set();
                        const queue = [startNodeId];
                        const queueVisited = new Set([startNodeId]);

                        while (queue.length > 0) {
                            const currentId = queue.shift();
                            component.add(currentId);
                            visited.add(currentId);

                            // Traverse edges only to nodes within this workflow's boundaries
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
                    const llmProvider = data.llms_detected && data.llms_detected.length > 0
                        ? data.llms_detected[0]
                        : 'LLM';

                    // Log warning if splitting occurs (indicates backend issue)
                    if (connectedComponents.length > 1) {
                        console.warn(
                            'Workflow "' + workflow.name + '" contains ' + connectedComponents.length + ' disconnected components. ' +
                            'This indicates the backend LLM assigned unconnected nodes to the same workflow. ' +
                            'Consider creating separate workflows for each component.'
                        );
                    }

                    connectedComponents.forEach((componentNodes, compIdx) => {
                        const groupId = connectedComponents.length > 1
                            ? baseId + '_' + compIdx
                            : baseId;

                        // Try to create meaningful names for disconnected components
                        let groupName = workflow.name;

                        if (connectedComponents.length > 1) {
                            // Extract nodes for this component
                            const componentNodesData = componentNodes.map(id =>
                                data.nodes.find(n => n.id === id)
                            ).filter(n => n);

                            // Try to infer a distinct name from node labels
                            const entryNodes = componentNodesData.filter(n => n.isEntryPoint);
                            const llmNodes = componentNodesData.filter(n => n.type === 'llm');

                            if (entryNodes.length > 0) {
                                // Use entry point label as distinguisher
                                groupName = workflow.name + ' - ' + entryNodes[0].label;
                            } else if (llmNodes.length > 0) {
                                // Use LLM label as distinguisher
                                groupName = workflow.name + ' - ' + llmNodes[0].label;
                            } else {
                                // Fallback to Part numbering
                                groupName = workflow.name + ' (Part ' + (compIdx + 1) + ')';
                            }
                        }

                        groups.push({
                            id: groupId,
                            name: groupName,
                            description: workflow.description,
                            nodes: componentNodes,
                            llmProvider: llmProvider,
                            collapsed: false,
                            color: colorFromString(groupId),
                            level: 1
                        });
                    });
                });
                return groups;
            }

            // Fallback: Use client-side BFS grouping if backend doesn't provide workflows
            const groups = [];
            const visited = new Set();
            const incomingEdges = new Map();
            const outgoingEdges = new Map();

            // Build adjacency lists
            data.nodes.forEach(n => {
                incomingEdges.set(n.id, []);
                outgoingEdges.set(n.id, []);
            });

            data.edges.forEach(e => {
                incomingEdges.get(e.target).push(e);
                outgoingEdges.get(e.source).push(e);
            });

            // Find all connected components and create workflow groups
            // Start with LLM-containing components, then handle remaining nodes
            const llmNodes = data.nodes.filter(n => n.type === 'llm');
            const allVisitedNodes = new Set();

            // First pass: Create workflows for LLM-containing components
            llmNodes.forEach((llmNode, idx) => {
                if (visited.has(llmNode.id)) return;

                const groupNodes = new Set();
                const llmNodesInGroup = new Set();

                // Use BFS to traverse ENTIRE connected component
                const queue = [llmNode.id];
                const groupVisited = new Set([llmNode.id]);

                while (queue.length > 0) {
                    const currentId = queue.shift();
                    groupNodes.add(currentId);
                    allVisitedNodes.add(currentId);

                    // Track LLM nodes in this component
                    const currentNode = data.nodes.find(n => n.id === currentId);
                    if (currentNode && currentNode.type === 'llm') {
                        llmNodesInGroup.add(currentNode);
                        visited.add(currentNode.id);  // Mark this LLM as processed
                    }

                    // Traverse backwards through ALL incoming edges
                    const incoming = incomingEdges.get(currentId) || [];
                    for (const edge of incoming) {
                        const prevNodeId = edge.source;
                        if (!groupVisited.has(prevNodeId)) {
                            queue.push(prevNodeId);
                            groupVisited.add(prevNodeId);
                        }
                    }

                    // Traverse forwards through ALL outgoing edges
                    const outgoing = outgoingEdges.get(currentId) || [];
                    for (const edge of outgoing) {
                        const nextNodeId = edge.target;
                        if (!groupVisited.has(nextNodeId)) {
                            queue.push(nextNodeId);
                            groupVisited.add(nextNodeId);
                        }
                    }
                }

                // Create group only if it has 2+ nodes
                const groupNodesList = Array.from(groupNodes);

                if (groupNodesList.length >= 3) {
                    const llmProvider = data.llms_detected && data.llms_detected.length > 0
                        ? data.llms_detected[0]
                        : 'LLM';

                    // Use first LLM node's label, or show count if multiple LLMs
                    const groupName = llmNodesInGroup.size > 1
                        ? 'Workflow (' + llmNodesInGroup.size + ' LLM calls)'
                        : (llmNode.label || 'Workflow ' + (idx + 1));

                    const groupId = 'group_' + idx;
                    groups.push({
                        id: groupId,
                        name: groupName,
                        nodes: groupNodesList,
                        llmProvider: llmProvider,
                        collapsed: false,  // Start expanded
                        color: colorFromString(groupId),  // Unique color
                        level: 1  // Level 1 group
                    });
                }
            });

            // Don't render orphan nodes - only nodes in LLM workflows should be displayed

            return groups;
        }

        const workflowGroups = detectWorkflowGroups(currentGraphData);
`;
