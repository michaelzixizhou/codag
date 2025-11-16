import * as vscode from 'vscode';
import { WorkflowGraph } from './api';
import { webviewStyles } from './webview/styles';
import { getNodeIcon } from './webview/icons';
import { snapToGrid, intersectRect, colorFromString } from './webview/utils';

export class WebviewManager {
    private panel: vscode.WebviewPanel | undefined;

    constructor(private context: vscode.ExtensionContext) {}

    notifyAnalysisStarted() {
        if (this.panel) {
            this.panel.webview.postMessage({ command: 'analysisStarted' });
        }
    }

    notifyAnalysisComplete(success: boolean, error?: string) {
        if (this.panel) {
            this.panel.webview.postMessage({
                command: 'analysisComplete',
                success,
                error
            });
        }
    }

    showLoading(message: string) {
        // Create panel if needed
        if (!this.panel) {
            this.panel = vscode.window.createWebviewPanel(
                'aiworkflowviz',
                'Workflow Visualization',
                vscode.ViewColumn.Beside,
                {
                    enableScripts: true,
                    retainContextWhenHidden: true
                }
            );

            this.panel.onDidDispose(() => {
                this.panel = undefined;
            });

            // Handle messages from webview
            this.panel.webview.onDidReceiveMessage(
                async (message) => {
                    if (message.command === 'openFile') {
                        try {
                            const document = await vscode.workspace.openTextDocument(message.file);
                            const editor = await vscode.window.showTextDocument(document, vscode.ViewColumn.One);

                            const line = message.line - 1;
                            const range = new vscode.Range(line, 0, line, 0);
                            editor.selection = new vscode.Selection(range.start, range.end);
                            editor.revealRange(range, vscode.TextEditorRevealType.InCenter);
                        } catch (error: any) {
                            vscode.window.showErrorMessage(`Could not open file: ${error.message}`);
                        }
                    } else if (message.command === 'refreshAnalysis') {
                        vscode.commands.executeCommand('aiworkflowviz.refresh');
                    }
                },
                undefined,
                this.context.subscriptions
            );

            // Set initial HTML with empty graph
            this.panel.webview.html = this.getHtml({ nodes: [], edges: [], llms_detected: [], workflows: [] });
        } else {
            this.panel.reveal();
        }

        // Send loading message
        this.panel.webview.postMessage({ command: 'showLoading', text: message });
    }

    updateProgress(current: number, total: number) {
        if (this.panel) {
            this.panel.webview.postMessage({ command: 'updateProgress', current, total });
        }
    }

    updateGraph(graph: WorkflowGraph) {
        if (this.panel) {
            this.panel.webview.postMessage({ command: 'updateGraph', graph });
        }
    }

    show(graph: WorkflowGraph) {
        if (this.panel) {
            this.panel.reveal();
        } else {
            this.panel = vscode.window.createWebviewPanel(
                'aiworkflowviz',
                'Workflow Visualization',
                vscode.ViewColumn.Beside,
                {
                    enableScripts: true,
                    retainContextWhenHidden: true
                }
            );

            this.panel.onDidDispose(() => {
                this.panel = undefined;
            });

            // Handle messages from webview
            this.panel.webview.onDidReceiveMessage(
                async (message) => {
                    if (message.command === 'openFile') {
                        try {
                            const document = await vscode.workspace.openTextDocument(message.file);
                            const editor = await vscode.window.showTextDocument(document, vscode.ViewColumn.One);

                            // Jump to line (lines are 0-indexed in VSCode API)
                            const line = message.line - 1;
                            const range = new vscode.Range(line, 0, line, 0);
                            editor.selection = new vscode.Selection(range.start, range.end);
                            editor.revealRange(range, vscode.TextEditorRevealType.InCenter);
                        } catch (error: any) {
                            vscode.window.showErrorMessage(`Could not open file: ${error.message}`);
                        }
                    } else if (message.command === 'refreshAnalysis') {
                        // Trigger refresh command
                        vscode.commands.executeCommand('aiworkflowviz.refresh');
                    }
                },
                undefined,
                this.context.subscriptions
            );
        }

        this.panel.webview.html = this.getHtml(graph);
    }

    private getHtml(graph: WorkflowGraph): string {
        // Create JavaScript function for icons (inject TypeScript function as string)
        const getIconFn = `function getIcon(type) { return (${getNodeIcon.toString()})(type); }`;

        // Create JavaScript functions for utilities
        const snapToGridFn = `const GRID_SIZE = 50; function snapToGrid(value) { return Math.round(value / GRID_SIZE) * GRID_SIZE; }`;
        const intersectRectFn = `function intersectRect(sourceNode, targetNode, nodeWidth = 140, nodeHeight = 70) {
            const dx = sourceNode.x - targetNode.x;
            const dy = sourceNode.y - targetNode.y;
            const halfWidth = nodeWidth / 2;
            const halfHeight = nodeHeight / 2;
            if (Math.abs(dy/dx) > halfHeight/halfWidth) {
                return { x: targetNode.x + dx * Math.abs(halfHeight/dy), y: targetNode.y + halfHeight * Math.sign(dy) };
            } else {
                return { x: targetNode.x + halfWidth * Math.sign(dx), y: targetNode.y + dy * Math.abs(halfWidth/dx) };
            }
        }`;
        const colorFromStringFn = `function colorFromString(str, saturation = 70, lightness = 60) {
            let hash = 0;
            for (let i = 0; i < str.length; i++) {
                hash = str.charCodeAt(i) + ((hash << 5) - hash);
            }
            const hue = Math.abs(hash) % 360;
            return 'hsl(' + hue + ', ' + saturation + '%, ' + lightness + '%)';
        }`;

        return `<!DOCTYPE html>
<html>
<head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <title>Workflow Visualization</title>
    <script src="https://d3js.org/d3.v7.min.js"></script>
    <script src="https://cdn.jsdelivr.net/npm/dagre@0.8.5/dist/dagre.min.js"></script>
    <style>${webviewStyles}
    </style>
</head>
<body>
    <div id="header">
        <h1>AI Workflow Visualization</h1>
        <div id="controls">
            <button onclick="zoomIn()" title="Zoom In">
                <svg viewBox="0 0 24 24"><path d="M19 13h-6v6h-2v-6H5v-2h6V5h2v6h6v2z"/></svg>
            </button>
            <button onclick="zoomOut()" title="Zoom Out">
                <svg viewBox="0 0 24 24"><path d="M19 13H5v-2h14v2z"/></svg>
            </button>
            <button onclick="resetZoom()" title="Fit to Screen">
                <svg viewBox="0 0 24 24"><path d="M3 3h6v2H5v4H3V3zm18 0v6h-2V5h-4V3h6zM3 15v6h6v-2H5v-4H3zm16 0v4h-4v2h6v-6h-2z"/></svg>
            </button>
            <button class="expand-btn" onclick="toggleExpandAll()" title="Expand/Collapse All Workflows">
                <svg viewBox="0 0 24 24"><path d="M12 5.83L15.17 9l1.41-1.41L12 3 7.41 7.59 8.83 9 12 5.83zm0 12.34L8.83 15l-1.41 1.41L12 21l4.59-4.59L15.17 15 12 18.17z"/></svg>
            </button>
            <button class="format-btn" onclick="formatGraph()" title="Reset Layout">
                <svg viewBox="0 0 24 24"><path d="M3 3v8h8V3H3zm6 6H5V5h4v4zm-6 4v8h8v-8H3zm6 6H5v-4h4v4zm4-16v8h8V3h-8zm6 6h-4V5h4v4zm-6 4v8h8v-8h-8zm6 6h-4v-4h4v4z"/></svg>
            </button>
            <button class="refresh-btn" onclick="refreshAnalysis()" title="Reanalyze Entire Workspace">
                <svg viewBox="0 0 24 24"><path d="M17.65 6.35A7.958 7.958 0 0 0 12 4c-4.42 0-7.99 3.58-7.99 8s3.57 8 7.99 8c3.73 0 6.84-2.55 7.73-6h-2.08A5.99 5.99 0 0 1 12 18c-3.31 0-6-2.69-6-6s2.69-6 6-6c1.66 0 3.14.69 4.22 1.78L13 11h7V4l-2.35 2.35z"/></svg>
            </button>
        </div>
    </div>

    <div id="graph"></div>

    <div id="buttonTooltip" class="button-tooltip"></div>

    <div id="legend" class="legend">
        <div class="legend-header" onclick="toggleLegend()">
            <span>Legend</span>
            <span id="legendToggle" class="legend-toggle">−</span>
        </div>
        <div id="legendContent" class="legend-content">
            <div class="legend-item">
                <div class="legend-line legend-line-entry"></div>
                <span>Entry Point</span>
            </div>
            <div class="legend-item">
                <div class="legend-line legend-line-exit"></div>
                <span>Exit Point</span>
            </div>
            <div class="legend-item">
                <div class="legend-line legend-line-critical"></div>
                <span>Critical Path</span>
            </div>
        </div>
    </div>

    <div id="minimap"></div>

    <div id="edgeTooltip" class="edge-tooltip" style="display: none;"></div>

    <div id="loadingIndicator" class="loading-indicator" style="display: none;">
        <div class="loading-content">
            <div class="loading-icon">⏳</div>
            <div id="loadingText">Analyzing workflow...</div>
        </div>
    </div>

    <div id="sidePanel" class="side-panel">
        <div class="panel-header">
            <h2 id="panelTitle">Node Details</h2>
            <button class="close-btn" onclick="closePanel()">&times;</button>
        </div>
        <div class="panel-content">
            <div class="panel-section">
                <label>Type</label>
                <div id="panelType" class="type-badge">-</div>
            </div>
            <div id="descriptionSection" class="panel-section">
                <label>Description</label>
                <p id="panelDescription">-</p>
            </div>
            <div id="sourceSection" class="panel-section">
                <label>Source Location</label>
                <a id="panelSource" class="source-link" href="#" onclick="return handleSourceClick(event)">-</a>
            </div>
            <div id="incomingSection" class="panel-section">
                <label>Incoming Data</label>
                <div id="panelIncoming">-</div>
            </div>
            <div id="outgoingSection" class="panel-section">
                <label>Outgoing Data</label>
                <div id="panelOutgoing">-</div>
            </div>
        </div>
    </div>

    <script>
        const vscode = acquireVsCodeApi();
        let currentGraphData = ${JSON.stringify(graph)};

        // Utility functions
        ${snapToGridFn}
        ${intersectRectFn}
        ${getIconFn}
        ${colorFromStringFn}

        // Merge two graphs (for progressive updates)
        function mergeGraphs(existing, newGraph) {
            const merged = { ...existing };

            // Merge nodes (deduplicate by id)
            const nodeMap = new Map(existing.nodes.map(n => [n.id, n]));
            newGraph.nodes.forEach(n => nodeMap.set(n.id, n));
            merged.nodes = Array.from(nodeMap.values());

            // Merge edges (deduplicate by source->target)
            const edgeMap = new Map(existing.edges.map(e => [\`\${e.source}->\${e.target}\`, e]));
            newGraph.edges.forEach(e => edgeMap.set(\`\${e.source}->\${e.target}\`, e));
            merged.edges = Array.from(edgeMap.values());

            // Merge LLMs detected
            merged.llms_detected = [...new Set([...existing.llms_detected, ...newGraph.llms_detected])];

            // Merge workflows
            merged.workflows = [...existing.workflows];
            newGraph.workflows.forEach(newWf => {
                const existingWf = merged.workflows.find(w => w.id === newWf.id);
                if (existingWf) {
                    existingWf.nodeIds = [...new Set([...existingWf.nodeIds, ...newWf.nodeIds])];
                } else {
                    merged.workflows.push(newWf);
                }
            });

            return merged;
        }

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
                data.workflows.forEach((workflow, idx) => {
                    const groupId = workflow.id || 'group_' + idx;

                    // Detect LLM provider from nodes in this workflow
                    const workflowNodes = data.nodes.filter(n => workflow.nodeIds.includes(n.id));
                    const llmNodesInWorkflow = workflowNodes.filter(n => n.type === 'llm');

                    // ONLY include workflows that have LLM nodes
                    if (llmNodesInWorkflow.length === 0) {
                        return;  // Skip non-LLM workflows
                    }

                    const llmProvider = data.llms_detected && data.llms_detected.length > 0
                        ? data.llms_detected[0]
                        : 'LLM';

                    groups.push({
                        id: groupId,
                        name: workflow.name,  // Use backend-provided descriptive name
                        description: workflow.description,  // Store description for tooltip
                        nodes: workflow.nodeIds,
                        llmProvider: llmProvider,
                        collapsed: false,
                        color: colorFromString(groupId),
                        level: 1
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

                if (groupNodesList.length >= 2) {
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

            // Second pass: Group remaining connected components (nodes without LLM connections)
            const remainingNodes = data.nodes.filter(n => !allVisitedNodes.has(n.id));

            remainingNodes.forEach((startNode, idx) => {
                if (allVisitedNodes.has(startNode.id)) return;

                const groupNodes = new Set();
                const queue = [startNode.id];
                const groupVisited = new Set([startNode.id]);

                while (queue.length > 0) {
                    const currentId = queue.shift();
                    groupNodes.add(currentId);
                    allVisitedNodes.add(currentId);

                    // Traverse backwards through ALL incoming edges
                    const incoming = incomingEdges.get(currentId) || [];
                    for (const edge of incoming) {
                        const prevNodeId = edge.source;
                        if (!groupVisited.has(prevNodeId) && !allVisitedNodes.has(prevNodeId)) {
                            queue.push(prevNodeId);
                            groupVisited.add(prevNodeId);
                        }
                    }

                    // Traverse forwards through ALL outgoing edges
                    const outgoing = outgoingEdges.get(currentId) || [];
                    for (const edge of outgoing) {
                        const nextNodeId = edge.target;
                        if (!groupVisited.has(nextNodeId) && !allVisitedNodes.has(nextNodeId)) {
                            queue.push(nextNodeId);
                            groupVisited.add(nextNodeId);
                        }
                    }
                }

                // Create group only if it has 2+ nodes
                const groupNodesList = Array.from(groupNodes);

                if (groupNodesList.length >= 2) {
                    const groupId = 'group_other_' + idx;
                    groups.push({
                        id: groupId,
                        name: 'Connected Group ' + (idx + 1),
                        nodes: groupNodesList,
                        llmProvider: 'none',
                        collapsed: false,
                        color: colorFromString(groupId),
                        level: 1
                    });
                }
            });

            // Collect all nodes that aren't in any workflow group (orphan nodes)
            const allGroupedNodeIds = new Set();
            groups.forEach(g => g.nodes.forEach(id => allGroupedNodeIds.add(id)));

            const orphanNodes = data.nodes
                .filter(n => !allGroupedNodeIds.has(n.id))
                .map(n => n.id);

            // Create a default workflow group for orphan nodes if any exist
            if (orphanNodes.length > 0) {
                groups.push({
                    id: 'group_orphans',
                    name: 'Other Nodes',
                    nodes: orphanNodes,
                    llmProvider: 'none',
                    collapsed: false,  // Start expanded so orphans are visible
                    color: colorFromString('group_orphans'),
                    level: 1
                });
            }

            return groups;
        }

        const workflowGroups = detectWorkflowGroups(currentGraphData);

        const container = document.getElementById('graph');
        const width = container.clientWidth;
        const height = container.clientHeight;

        const svg = d3.select('#graph')
            .append('svg')
            .attr('width', '100%')
            .attr('height', '100%');

        // Create zoom behavior (disable double-click zoom)
        const zoom = d3.zoom()
            .scaleExtent([0.1, 10])
            .on('zoom', (event) => {
                g.attr('transform', event.transform);
            });

        svg.call(zoom).on('dblclick.zoom', null);

        // Create defs for patterns and markers
        const defs = svg.append('defs');

        // Pegboard dot pattern - 50px grid (nodes are 1x1 grid units)
        const pattern = defs.append('pattern')
            .attr('id', 'pegboard')
            .attr('x', 0)
            .attr('y', 0)
            .attr('width', 50)
            .attr('height', 50)
            .attr('patternUnits', 'userSpaceOnUse');

        pattern.append('circle')
            .attr('cx', 25)
            .attr('cy', 25)
            .attr('r', 1.2)
            .attr('fill', 'var(--vscode-editor-foreground)')
            .attr('opacity', 0.2);

        // Main group for all graph elements (zoomable, includes pegboard)
        const g = svg.append('g');

        // Add pegboard background inside transform group (zooms/pans with content)
        g.append('rect')
            .attr('x', -5000)
            .attr('y', -5000)
            .attr('width', 10000)
            .attr('height', 10000)
            .attr('fill', 'url(#pegboard)')
            .lower(); // Send to back

        // Arrow markers
        defs.append('marker')
            .attr('id', 'arrowhead')
            .attr('viewBox', '-0 -5 10 10')
            .attr('refX', 9.5)  // Position arrow tip at edge (10 is tip, 9.5 leaves tiny gap)
            .attr('refY', 0)
            .attr('orient', 'auto')
            .attr('markerWidth', 6)
            .attr('markerHeight', 6)
            .append('path')
            .attr('d', 'M 0,-5 L 10,0 L 0,5')
            .attr('fill', 'currentColor')
            .style('fill', 'var(--vscode-editor-foreground)');

        // Create Dagre graph for hierarchical layout
        const dagreGraph = new dagre.graphlib.Graph();
        dagreGraph.setGraph({
            rankdir: 'LR',      // Left to right
            nodesep: 90,        // Vertical spacing: 90 - 70 (node height) = 20px gap
            ranksep: 160,       // Horizontal spacing: 160 - 140 (node width) = 20px gap
            marginx: 30,        // Moderate margins for workflow separation
            marginy: 30
        });
        dagreGraph.setDefaultEdgeLabel(() => ({}));

        // Add nodes to Dagre
        currentGraphData.nodes.forEach(node => {
            dagreGraph.setNode(node.id, { width: 140, height: 70 });
        });

        // Add edges to Dagre
        currentGraphData.edges.forEach(edge => {
            dagreGraph.setEdge(edge.source, edge.target);
        });

        // Compute layout
        dagre.layout(dagreGraph);

        // Apply Dagre positions to nodes (snap to grid)
        // Also store original positions for format reset
        const originalPositions = new Map();
        currentGraphData.nodes.forEach(node => {
            const pos = dagreGraph.node(node.id);
            node.x = snapToGrid(pos.x);
            node.y = snapToGrid(pos.y);
            node.fx = node.x;
            node.fy = node.y;
            originalPositions.set(node.id, { x: node.x, y: node.y });
        });

        // Calculate group bounds after layout
        workflowGroups.forEach(group => {
            const groupNodes = currentGraphData.nodes.filter(n => group.nodes.includes(n.id));
            if (groupNodes.length === 0) return;

            const xs = groupNodes.map(n => n.x);
            const ys = groupNodes.map(n => n.y);

            group.bounds = {
                minX: Math.min(...xs) - 90,  // Node half-width (70) + margin (20)
                maxX: Math.max(...xs) + 90,  // Node half-width (70) + margin (20)
                minY: Math.min(...ys) - 75,  // Node half-height (35) + margin (40 for title)
                maxY: Math.max(...ys) + 55   // Node half-height (35) + margin (20)
            };

            // Calculate center for collapsed state
            group.centerX = (group.bounds.minX + group.bounds.maxX) / 2;
            group.centerY = (group.bounds.minY + group.bounds.maxY) / 2;
        });

        // Prevent overlapping bounding boxes with iterative resolution
        // Skip "Other Nodes" group (it shouldn't have a bounding box)
        const boundedGroups = workflowGroups.filter(g => g.id !== 'group_orphans');

        // Run multiple iterations to resolve all overlaps
        const maxIterations = 3;
        let iteration = 0;
        let hadOverlap = true;

        while (hadOverlap && iteration < maxIterations) {
            hadOverlap = false;
            iteration++;

            for (let i = 0; i < boundedGroups.length; i++) {
                for (let j = i + 1; j < boundedGroups.length; j++) {
                    const g1 = boundedGroups[i];
                    const g2 = boundedGroups[j];

                    // Check if bounds overlap
                    const overlap = !(g1.bounds.maxX < g2.bounds.minX ||
                                     g2.bounds.maxX < g1.bounds.minX ||
                                     g1.bounds.maxY < g2.bounds.minY ||
                                     g2.bounds.maxY < g1.bounds.minY);

                    if (overlap) {
                        hadOverlap = true;

                        // Calculate overlap amount in each direction
                        const overlapX = Math.min(g1.bounds.maxX, g2.bounds.maxX) - Math.max(g1.bounds.minX, g2.bounds.minX);
                        const overlapY = Math.min(g1.bounds.maxY, g2.bounds.maxY) - Math.max(g1.bounds.minY, g2.bounds.minY);

                        const padding = 10;

                        if (overlapX < overlapY) {
                            // More vertical overlap, separate horizontally
                            if (g1.centerX < g2.centerX) {
                                const shift = (g1.bounds.maxX - g2.bounds.minX) + padding;

                                // Move nodes with the bounding box
                                const g2Nodes = currentGraphData.nodes.filter(n => g2.nodes.includes(n.id));
                                g2Nodes.forEach(n => {
                                    n.x += shift;
                                    n.fx += shift;
                                });

                                // Recalculate bounds based on new node positions
                                const xs = g2Nodes.map(n => n.x);
                                const ys = g2Nodes.map(n => n.y);
                                g2.bounds = {
                                    minX: Math.min(...xs) - 90,  // Node half-width (70) + margin (20)
                                    maxX: Math.max(...xs) + 90,  // Node half-width (70) + margin (20)
                                    minY: Math.min(...ys) - 75,  // Node half-height (35) + margin (40 for title)
                                    maxY: Math.max(...ys) + 55   // Node half-height (35) + margin (20)
                                };
                                g2.centerX = (g2.bounds.minX + g2.bounds.maxX) / 2;
                                g2.centerY = (g2.bounds.minY + g2.bounds.maxY) / 2;
                            } else {
                                const shift = (g2.bounds.maxX - g1.bounds.minX) + padding;

                                // Move nodes with the bounding box
                                const g1Nodes = currentGraphData.nodes.filter(n => g1.nodes.includes(n.id));
                                g1Nodes.forEach(n => {
                                    n.x += shift;
                                    n.fx += shift;
                                });

                                // Recalculate bounds based on new node positions
                                const xs = g1Nodes.map(n => n.x);
                                const ys = g1Nodes.map(n => n.y);
                                g1.bounds = {
                                    minX: Math.min(...xs) - 90,  // Node half-width (70) + margin (20)
                                    maxX: Math.max(...xs) + 90,  // Node half-width (70) + margin (20)
                                    minY: Math.min(...ys) - 75,  // Node half-height (35) + margin (40 for title)
                                    maxY: Math.max(...ys) + 55   // Node half-height (35) + margin (20)
                                };
                                g1.centerX = (g1.bounds.minX + g1.bounds.maxX) / 2;
                                g1.centerY = (g1.bounds.minY + g1.bounds.maxY) / 2;
                            }
                        } else {
                            // More horizontal overlap, separate vertically
                            if (g1.centerY < g2.centerY) {
                                const shift = (g1.bounds.maxY - g2.bounds.minY) + padding;

                                // Move nodes with the bounding box
                                const g2Nodes = currentGraphData.nodes.filter(n => g2.nodes.includes(n.id));
                                g2Nodes.forEach(n => {
                                    n.y += shift;
                                    n.fy += shift;
                                });

                                // Recalculate bounds based on new node positions
                                const xs = g2Nodes.map(n => n.x);
                                const ys = g2Nodes.map(n => n.y);
                                g2.bounds = {
                                    minX: Math.min(...xs) - 90,  // Node half-width (70) + margin (20)
                                    maxX: Math.max(...xs) + 90,  // Node half-width (70) + margin (20)
                                    minY: Math.min(...ys) - 75,  // Node half-height (35) + margin (40 for title)
                                    maxY: Math.max(...ys) + 55   // Node half-height (35) + margin (20)
                                };
                                g2.centerX = (g2.bounds.minX + g2.bounds.maxX) / 2;
                                g2.centerY = (g2.bounds.minY + g2.bounds.maxY) / 2;
                            } else {
                                const shift = (g2.bounds.maxY - g1.bounds.minY) + padding;

                                // Move nodes with the bounding box
                                const g1Nodes = currentGraphData.nodes.filter(n => g1.nodes.includes(n.id));
                                g1Nodes.forEach(n => {
                                    n.y += shift;
                                    n.fy += shift;
                                });

                                // Recalculate bounds based on new node positions
                                const xs = g1Nodes.map(n => n.x);
                                const ys = g1Nodes.map(n => n.y);
                                g1.bounds = {
                                    minX: Math.min(...xs) - 90,  // Node half-width (70) + margin (20)
                                    maxX: Math.max(...xs) + 90,  // Node half-width (70) + margin (20)
                                    minY: Math.min(...ys) - 75,  // Node half-height (35) + margin (40 for title)
                                    maxY: Math.max(...ys) + 55   // Node half-height (35) + margin (20)
                                };
                                g1.centerX = (g1.bounds.minX + g1.bounds.maxX) / 2;
                                g1.centerY = (g1.bounds.minY + g1.bounds.maxY) / 2;
                            }
                        }
                    }
                }
            }
        }

        // Update originalPositions to reflect post-overlap-resolution positions
        // This ensures formatGraph() resets to the correct layout
        currentGraphData.nodes.forEach(node => {
            originalPositions.set(node.id, { x: node.x, y: node.y });
        });

        // Create colored dot patterns for each workflow group
        workflowGroups.forEach((group, idx) => {
            const colorPattern = defs.append('pattern')
                .attr('id', 'pegboard-' + group.id)
                .attr('x', 0)
                .attr('y', 0)
                .attr('width', 50)
                .attr('height', 50)
                .attr('patternUnits', 'userSpaceOnUse');

            colorPattern.append('circle')
                .attr('cx', 25)
                .attr('cy', 25)
                .attr('r', 1.2)
                .attr('fill', group.color)
                .attr('opacity', 0.3);
        });

        // Render group containers (borders for expanded, aggregate for collapsed)
        const groupContainer = g.append('g')
            .attr('class', 'groups');

        const groupElements = groupContainer.selectAll('.workflow-group')
            .data(workflowGroups)
            .enter()
            .append('g')
            .attr('class', 'workflow-group');

        // Group background rectangle (only shown when expanded) - NEW DESIGN
        // Don't render background for "Other Nodes" orphan group
        groupElements.append('rect')
            .attr('class', 'group-background')
            .attr('x', d => d.bounds.minX)
            .attr('y', d => d.bounds.minY)
            .attr('width', d => d.bounds.maxX - d.bounds.minX)
            .attr('height', d => d.bounds.maxY - d.bounds.minY)
            .attr('rx', 12)
            .style('fill', d => d.color)  // Unique color
            .style('fill-opacity', 0.1)   // Very subtle background
            .style('stroke', d => d.color)  // Colored border
            .style('stroke-width', '3px')
            .style('stroke-dasharray', '8,4')  // Dotted border
            .style('opacity', d => (d.collapsed || d.id === 'group_orphans') ? 0 : 1)
            .style('pointer-events', 'none');

        // Title inside expanded group (top-left corner)
        groupElements.append('text')
            .attr('class', 'group-title-expanded')
            .attr('x', d => d.bounds.minX + 40)
            .attr('y', d => d.bounds.minY + 20)
            .style('fill', d => d.color)
            .style('font-size', '13px')
            .style('font-weight', '700')
            .style('display', d => (d.collapsed || d.id === 'group_orphans') ? 'none' : 'block')
            .style('pointer-events', 'none')
            .text(d => d.name + ' (' + d.nodes.length + ' nodes)');

        // Collapse button for expanded group
        const expandedCollapseBtn = groupElements.append('g')
            .attr('class', 'group-collapse-btn')
            .style('display', d => (d.collapsed || d.id === 'group_orphans') ? 'none' : 'block')
            .style('cursor', 'pointer')
            .on('click', function(event, d) {
                event.stopPropagation();
                d.collapsed = true;
                updateGroupVisibility();
            });

        expandedCollapseBtn.append('rect')
            .attr('x', d => d.bounds.minX + 10)
            .attr('y', d => d.bounds.minY + 8)
            .attr('width', 24)
            .attr('height', 24)
            .attr('rx', 4)
            .style('fill', d => d.color)
            .style('fill-opacity', 0.2)
            .style('stroke', d => d.color)
            .style('stroke-width', '2px');

        expandedCollapseBtn.append('text')
            .attr('x', d => d.bounds.minX + 22)
            .attr('y', d => d.bounds.minY + 24)
            .attr('text-anchor', 'middle')
            .style('fill', d => d.color)
            .style('font-size', '16px')
            .style('font-weight', 'bold')
            .style('pointer-events', 'none')
            .text('−');

        // Collapsed groups will be rendered later (after edges) for proper z-index

        // Get node or collapsed group representation for edge routing
        function getNodeOrCollapsedGroup(nodeId) {
            // Check for collapsed workflow group
            const collapsedGroup = workflowGroups.find(g =>
                g.collapsed && g.nodes.includes(nodeId)
            );

            if (collapsedGroup) {
                return {
                    id: collapsedGroup.id,
                    x: collapsedGroup.centerX,
                    y: collapsedGroup.centerY,
                    isCollapsedGroup: true,
                    width: 260,
                    height: 130
                };
            }

            return currentGraphData.nodes.find(n => n.id === nodeId);
        }

        // Update visibility of nodes/edges based on group collapse state
        function updateGroupVisibility() {
            // Update Level 1 group backgrounds
            groupElements.select('.group-background')
                .style('opacity', d => d.collapsed ? 0 : 1);

            // Update Level 1 expanded title
            groupElements.select('.group-title-expanded')
                .style('display', d => d.collapsed ? 'none' : 'block');

            // Update Level 1 collapse button
            groupElements.select('.group-collapse-btn')
                .style('display', d => d.collapsed ? 'none' : 'block');

            // Show/hide collapsed groups (in separate container)
            collapsedGroups.style('display', d => d.collapsed ? 'block' : 'none');

            // Hide nodes that are in collapsed groups
            node.style('display', d => {
                const inCollapsedGroup = workflowGroups.some(g => g.collapsed && g.nodes.includes(d.id));
                return inCollapsedGroup ? 'none' : 'block';
            });

            // Show all edges, but route them to collapsed groups when needed
            linkGroup.style('display', 'block');

            // Update edge paths to route to collapsed groups
            link.attr('d', function(l) {
                const sourceNode = getNodeOrCollapsedGroup(l.source);
                const targetNode = getNodeOrCollapsedGroup(l.target);

                // Skip if nodes not found
                if (!sourceNode || !targetNode) return '';

                // Check if both nodes are in the same collapsed group
                const sourceGroup = workflowGroups.find(g => g.collapsed && g.nodes.includes(l.source));
                const targetGroup = workflowGroups.find(g => g.collapsed && g.nodes.includes(l.target));
                if (sourceGroup && targetGroup && sourceGroup.id === targetGroup.id) {
                    // Internal edge - hide it
                    d3.select(this.parentNode).style('display', 'none');
                    return '';
                }

                // Edge crosses group boundaries - show it
                d3.select(this.parentNode).style('display', 'block');

                const targetWidth = targetNode.isCollapsedGroup ? 260 : 140;
                const targetHeight = targetNode.isCollapsedGroup ? 130 : 70;

                const intersection = intersectRect(sourceNode, targetNode, targetWidth, targetHeight);
                return \`M\${sourceNode.x},\${sourceNode.y} L\${intersection.x},\${intersection.y}\`;
            });

            linkHover.attr('d', function(l) {
                const sourceNode = getNodeOrCollapsedGroup(l.source);
                const targetNode = getNodeOrCollapsedGroup(l.target);

                if (!sourceNode || !targetNode) return '';

                // Check if both nodes are in the same collapsed group
                const sourceGroup = workflowGroups.find(g => g.collapsed && g.nodes.includes(l.source));
                const targetGroup = workflowGroups.find(g => g.collapsed && g.nodes.includes(l.target));
                if (sourceGroup && targetGroup && sourceGroup.id === targetGroup.id) {
                    return '';
                }

                const targetWidth = targetNode.isCollapsedGroup ? 260 : 140;
                const targetHeight = targetNode.isCollapsedGroup ? 130 : 70;

                const intersection = intersectRect(sourceNode, targetNode, targetWidth, targetHeight);
                return \`M\${sourceNode.x},\${sourceNode.y} L\${intersection.x},\${intersection.y}\`;
            });

            linkLabelGroup.attr('transform', function(l) {
                const sourceNode = getNodeOrCollapsedGroup(l.source);
                const targetNode = getNodeOrCollapsedGroup(l.target);

                if (!sourceNode || !targetNode) return 'translate(0,0)';

                const midX = (sourceNode.x + targetNode.x) / 2;
                const midY = (sourceNode.y + targetNode.y) / 2;
                return 'translate(' + midX + ',' + midY + ')';
            })
            .style('display', function(l) {
                // Hide labels for edges where both endpoints are inside a collapsed group
                const sourceNodeData = currentGraphData.nodes.find(n => n.id === l.source);
                const targetNodeData = currentGraphData.nodes.find(n => n.id === l.target);

                if (!sourceNodeData || !targetNodeData) return 'block';

                // Check if both nodes belong to a collapsed group
                const sourceGroup = workflowGroups.find(g => g.collapsed && g.nodes.includes(sourceNodeData.id));
                const targetGroup = workflowGroups.find(g => g.collapsed && g.nodes.includes(targetNodeData.id));

                // Hide if both nodes are in the same collapsed group
                if (sourceGroup && targetGroup && sourceGroup.id === targetGroup.id) {
                    return 'none';
                }

                return 'block';
            });
        }

        // Create two separate containers: one for edge paths, one for edge labels
        // This ensures ALL edges are drawn beneath ALL labels
        const edgePathsContainer = g.append('g').attr('class', 'edge-paths-container');
        const edgeLabelsContainer = g.append('g').attr('class', 'edge-labels-container');

        // Create edge path groups (for paths only)
        const linkGroup = edgePathsContainer
            .selectAll('g')
            .data(currentGraphData.edges)
            .enter()
            .append('g')
            .attr('class', 'link-group');

        const link = linkGroup.append('path')
            .attr('class', d => d.isCriticalPath ? 'link critical-path' : 'link')
            .attr('marker-end', 'url(#arrowhead)');

        // Create edge label groups (separate from paths, rendered on top)
        const linkLabelGroup = edgeLabelsContainer
            .selectAll('g')
            .data(currentGraphData.edges)
            .enter()
            .append('g')
            .attr('class', 'link-label-group');

        const linkLabel = linkLabelGroup.append('text')
            .attr('class', 'link-label')
            .text(d => d.label || '');

        // Add invisible wider path for easier hovering
        const linkHover = linkGroup.insert('path', '.link')
            .attr('class', 'link-hover')
            .style('stroke', 'transparent')
            .style('stroke-width', '20px')
            .style('fill', 'none')
            .style('cursor', 'pointer')
            .on('mouseover', function(event, d) {
                // Unified hover: highlight both edge path and label
                const index = currentGraphData.edges.indexOf(d);
                const linkElement = d3.select(edgePathsContainer.node().children[index]).select('.link');
                const labelElement = d3.select(edgeLabelsContainer.node().children[index]).select('.link-label');

                if (d.isCriticalPath) {
                    linkElement.style('stroke', '#FF9999').style('stroke-width', '5px');
                    labelElement.style('font-weight', 'bold').style('fill', '#FF9999');
                } else {
                    linkElement.style('stroke', '#00d9ff').style('stroke-width', '3px');
                    labelElement.style('font-weight', 'bold').style('fill', '#00d9ff');
                }

                // Show tooltip at edge midpoint
                const tooltip = document.getElementById('edgeTooltip');
                tooltip.innerHTML = \`
                    <div><strong>Variable:</strong> \${d.label || 'N/A'}</div>
                    \${d.dataType ? \`<div><strong>Type:</strong> \${d.dataType}</div>\` : ''}
                    \${d.description ? \`<div><strong>Description:</strong> \${d.description}</div>\` : ''}
                    \${d.sourceLocation ? \`<div><strong>Location:</strong> \${d.sourceLocation.file.split('/').pop()}:\${d.sourceLocation.line}</div>\` : ''}
                \`;

                // Get source and target nodes to calculate midpoint
                const sourceNode = currentGraphData.nodes.find(n => n.id === d.source);
                const targetNode = currentGraphData.nodes.find(n => n.id === d.target);

                if (sourceNode && targetNode) {
                    // Calculate midpoint in SVG coordinates
                    const midX = (sourceNode.x + targetNode.x) / 2;
                    const midY = (sourceNode.y + targetNode.y) / 2;

                    // Get the SVG element and its bounding rect
                    const svgElement = document.querySelector('#graph svg');
                    const svgRect = svgElement.getBoundingClientRect();

                    // Get current transform
                    const transform = d3.zoomTransform(svgElement);

                    // Convert SVG coordinates to screen coordinates
                    const screenX = transform.applyX(midX) + svgRect.left;
                    const screenY = transform.applyY(midY) + svgRect.top;

                    tooltip.style.display = 'block';
                    tooltip.style.left = (screenX + 10) + 'px';
                    tooltip.style.top = (screenY - 10) + 'px';
                }
            })
            .on('mouseout', function(event, d) {
                // Unified hover reset: reset both edge path and label
                const index = currentGraphData.edges.indexOf(d);
                const linkElement = d3.select(edgePathsContainer.node().children[index]).select('.link');
                const labelElement = d3.select(edgeLabelsContainer.node().children[index]).select('.link-label');

                if (d.isCriticalPath) {
                    linkElement.style('stroke', '#FF6B6B').style('stroke-width', '4px');
                    labelElement.style('font-weight', null).style('fill', null);
                } else {
                    linkElement.style('stroke', null).style('stroke-width', null);
                    labelElement.style('font-weight', null).style('fill', null);
                }

                // Hide tooltip
                const tooltip = document.getElementById('edgeTooltip');
                tooltip.style.display = 'none';
            })
            .on('click', function(event, d) {
                event.stopPropagation();
                if (d.sourceLocation) {
                    vscode.postMessage({
                        command: 'openFile',
                        file: d.sourceLocation.file,
                        line: d.sourceLocation.line
                    });
                }
            });

        // Create nodes
        const node = g.append('g')
            .selectAll('g')
            .data(currentGraphData.nodes)
            .enter()
            .append('g')
            .attr('class', 'node')
            .call(d3.drag()
                .on('start', dragstarted)
                .on('drag', dragged)
                .on('end', dragended));

        // Add rectangular background fill (no stroke)
        node.append('rect')
            .attr('width', 140)
            .attr('height', 70)
            .attr('x', -70)
            .attr('y', -35)
            .attr('rx', 4)
            .style('fill', 'var(--vscode-editor-background)')
            .style('stroke', 'none');

        // Add colored header background (above fill, below border)
        const typeColors = {
            'trigger': '#FFB74D',
            'llm': '#64B5F6',
            'tool': '#81C784',
            'decision': '#BA68C8',
            'integration': '#FF8A65',
            'memory': '#4DB6AC',
            'parser': '#A1887F',
            'output': '#90A4AE'
        };
        node.append('path')
            .attr('class', 'node-header')
            .attr('d', 'M -65,-35 L 65,-35 A 4,4 0 0,1 69,-31 L 69,-11 L -69,-11 L -69,-31 A 4,4 0 0,1 -65,-35 Z')
            .style('fill', d => typeColors[d.type] || '#90A4AE')
            .style('opacity', 0.3)
            .style('stroke', 'none');

        // Add rectangular border (stroke only, rendered on top)
        node.append('rect')
            .attr('width', 140)
            .attr('height', 70)
            .attr('x', -70)
            .attr('y', -35)
            .attr('rx', 4)
            .attr('class', d => {
                const classes = [];
                if (d.isCriticalPath) classes.push('critical-path');
                if (d.isEntryPoint) classes.push('entry-point');
                if (d.isExitPoint) classes.push('exit-point');
                return classes.join(' ');
            })
            .style('fill', 'none')
            .style('pointer-events', 'all');

        // Add title inside node at top with dynamic sizing
        node.append('text')
            .attr('class', 'node-title')
            .text(d => d.label)
            .attr('y', -21)
            .attr('dominant-baseline', 'middle')
            .each(function() {
                const maxWidth = 120; // Conservative width for safety
                let textLength = this.getComputedTextLength();

                if (textLength > maxWidth) {
                    const scale = maxWidth / textLength;
                    const currentFontSize = 13; // From CSS
                    let newFontSize = Math.max(8, currentFontSize * scale); // Min 8px
                    d3.select(this).style('font-size', newFontSize + 'px');

                    // Re-measure to ensure it fits
                    textLength = this.getComputedTextLength();
                    if (textLength > maxWidth) {
                        newFontSize = Math.max(7, newFontSize * (maxWidth / textLength));
                        d3.select(this).style('font-size', newFontSize + 'px');
                    }
                }
            });

        // Add icon at bottom-right corner (accounting for rounded corners)
        node.append('g')
            .attr('class', d => \`node-icon \${d.type}\`)
            .attr('transform', 'translate(44, 10) scale(0.8)')
            .html(d => getIcon(d.type));

        // Add node type label to the left of icon (right-aligned with equal margins)
        node.append('text')
            .attr('class', 'node-type')
            .text(d => d.type.toUpperCase())
            .attr('x', 40)
            .attr('y', 21)
            .attr('dominant-baseline', 'middle')
            .style('text-anchor', 'end');

        // Add selection indicator (camera corners) - hidden by default
        const cornerSize = 8;
        const cornerOffsetX = 72; // Distance from center to corner start (horizontal)
        const cornerOffsetY = 37; // Distance from center to corner start (vertical)
        node.append('g')
            .attr('class', 'node-selection-indicator')
            .attr('data-node-id', d => d.id)
            .style('display', 'none')
            .each(function() {
                const g = d3.select(this);
                // Top-left corner
                g.append('path').attr('d', \`M -\${cornerOffsetX} -\${cornerOffsetY - cornerSize} L -\${cornerOffsetX} -\${cornerOffsetY} L -\${cornerOffsetX - cornerSize} -\${cornerOffsetY}\`);
                // Top-right corner
                g.append('path').attr('d', \`M \${cornerOffsetX - cornerSize} -\${cornerOffsetY} L \${cornerOffsetX} -\${cornerOffsetY} L \${cornerOffsetX} -\${cornerOffsetY - cornerSize}\`);
                // Bottom-left corner
                g.append('path').attr('d', \`M -\${cornerOffsetX} \${cornerOffsetY - cornerSize} L -\${cornerOffsetX} \${cornerOffsetY} L -\${cornerOffsetX - cornerSize} \${cornerOffsetY}\`);
                // Bottom-right corner
                g.append('path').attr('d', \`M \${cornerOffsetX - cornerSize} \${cornerOffsetY} L \${cornerOffsetX} \${cornerOffsetY} L \${cornerOffsetX} \${cornerOffsetY - cornerSize}\`);
            });

        // Tooltip on hover
        node.append('title')
            .text(d => {
                let text = \`\${d.label}\\nType: \${d.type}\`;
                if (d.description) {
                    text += \`\\n\\n\${d.description}\`;
                }
                return text;
            });

        // Set initial positions (will be updated by updateGroupVisibility)
        link.attr('d', d => {
            const sourceNode = currentGraphData.nodes.find(n => n.id === d.source);
            const targetNode = currentGraphData.nodes.find(n => n.id === d.target);
            if (!sourceNode || !targetNode) return '';
            const intersection = intersectRect(sourceNode, targetNode);
            return \`M\${sourceNode.x},\${sourceNode.y} L\${intersection.x},\${intersection.y}\`;
        });

        linkHover.attr('d', d => {
            const sourceNode = currentGraphData.nodes.find(n => n.id === d.source);
            const targetNode = currentGraphData.nodes.find(n => n.id === d.target);
            if (!sourceNode || !targetNode) return '';
            const intersection = intersectRect(sourceNode, targetNode);
            return \`M\${sourceNode.x},\${sourceNode.y} L\${intersection.x},\${intersection.y}\`;
        });

        // Position label groups
        linkLabelGroup.attr('transform', d => {
            const sourceNode = currentGraphData.nodes.find(n => n.id === d.source);
            const targetNode = currentGraphData.nodes.find(n => n.id === d.target);
            if (!sourceNode || !targetNode) return 'translate(0,0)';
            const midX = (sourceNode.x + targetNode.x) / 2;
            const midY = (sourceNode.y + targetNode.y) / 2;
            return 'translate(' + midX + ',' + midY + ')';
        });

        // Add background rectangles for edge labels
        linkLabel.each(function(d) {
            const textElement = this;
            const bbox = textElement.getBBox();
            const padding = 3;

            // Insert rect before text in the same group
            const group = textElement.parentNode;
            const rect = document.createElementNS('http://www.w3.org/2000/svg', 'rect');
            rect.setAttribute('class', 'link-label-bg');
            rect.setAttribute('x', bbox.x - padding);
            rect.setAttribute('y', bbox.y - padding);
            rect.setAttribute('width', bbox.width + padding * 2);
            rect.setAttribute('height', bbox.height + padding * 2);

            group.insertBefore(rect, textElement);
        });

        // Add event handlers to label groups
        linkLabelGroup
            .on('mouseover', function(event, d) {
                // Unified hover: highlight both edge path and label
                const index = currentGraphData.edges.indexOf(d);
                const linkElement = d3.select(edgePathsContainer.node().children[index]).select('.link');
                const labelElement = d3.select(edgeLabelsContainer.node().children[index]).select('.link-label');

                if (d.isCriticalPath) {
                    linkElement.style('stroke', '#FF9999').style('stroke-width', '5px');
                    labelElement.style('font-weight', 'bold').style('fill', '#FF9999');
                } else {
                    linkElement.style('stroke', '#00d9ff').style('stroke-width', '3px');
                    labelElement.style('font-weight', 'bold').style('fill', '#00d9ff');
                }

                // Show tooltip
                const tooltip = document.getElementById('edgeTooltip');
                tooltip.innerHTML = '<div><strong>Variable:</strong> ' + (d.label || 'N/A') + '</div>' +
                    (d.dataType ? '<div><strong>Type:</strong> ' + d.dataType + '</div>' : '') +
                    (d.description ? '<div><strong>Description:</strong> ' + d.description + '</div>' : '') +
                    (d.sourceLocation ? '<div><strong>Location:</strong> ' + d.sourceLocation.file.split('/').pop() + ':' + d.sourceLocation.line + '</div>' : '');

                // Get screen position
                const transform = d3.zoomTransform(document.querySelector('#graph svg'));
                const svgRect = document.querySelector('#graph svg').getBoundingClientRect();
                const sourceNode = currentGraphData.nodes.find(n => n.id === d.source);
                const targetNode = currentGraphData.nodes.find(n => n.id === d.target);
                const midX = (sourceNode.x + targetNode.x) / 2;
                const midY = (sourceNode.y + targetNode.y) / 2;
                const screenX = transform.applyX(midX) + svgRect.left;
                const screenY = transform.applyY(midY) + svgRect.top;

                tooltip.style.display = 'block';
                tooltip.style.left = (screenX + 10) + 'px';
                tooltip.style.top = (screenY - 10) + 'px';
            })
            .on('mouseout', function(event, d) {
                // Unified hover reset: reset both edge path and label
                const index = currentGraphData.edges.indexOf(d);
                const linkElement = d3.select(edgePathsContainer.node().children[index]).select('.link');
                const labelElement = d3.select(edgeLabelsContainer.node().children[index]).select('.link-label');

                if (d.isCriticalPath) {
                    linkElement.style('stroke', '#FF6B6B').style('stroke-width', '4px');
                    labelElement.style('font-weight', null).style('fill', null);
                } else {
                    linkElement.style('stroke', null).style('stroke-width', null);
                    labelElement.style('font-weight', null).style('fill', null);
                }

                // Hide tooltip
                const tooltip = document.getElementById('edgeTooltip');
                tooltip.style.display = 'none';
            })
            .on('click', function(event, d) {
                event.stopPropagation();
                if (d.sourceLocation) {
                    vscode.postMessage({
                        command: 'openFile',
                        file: d.sourceLocation.file,
                        line: d.sourceLocation.line
                    });
                }
            });

        node.attr('transform', d => \`translate(\${d.x},\${d.y})\`);

        // Render collapsed groups AFTER edges/nodes for proper z-index (so they're clickable)
        const collapsedGroupContainer = g.append('g')
            .attr('class', 'collapsed-groups');

        const collapsedGroups = collapsedGroupContainer.selectAll('.collapsed-group')
            .data(workflowGroups)
            .enter()
            .append('g')
            .attr('class', 'collapsed-group-node')
            .style('display', d => d.collapsed ? 'block' : 'none')
            .style('cursor', 'pointer')
            .on('click', function(event, d) {
                event.stopPropagation();
                d.collapsed = false;
                updateGroupVisibility();
            });

        // Background with pegboard pattern
        collapsedGroups.append('rect')
            .attr('x', d => d.centerX - 130)
            .attr('y', d => d.centerY - 65)
            .attr('width', 260)
            .attr('height', 130)
            .attr('rx', 12)
            .style('fill', d => 'url(#pegboard-' + d.id + ')')
            .style('stroke', d => d.color)
            .style('stroke-width', '3px')
            .style('filter', 'drop-shadow(0 2px 8px rgba(0,0,0,0.2))');

        // Solid color overlay
        collapsedGroups.append('rect')
            .attr('x', d => d.centerX - 130)
            .attr('y', d => d.centerY - 65)
            .attr('width', 260)
            .attr('height', 130)
            .attr('rx', 12)
            .style('fill', d => d.color)
            .style('fill-opacity', 0.7)
            .style('pointer-events', 'none');

        collapsedGroups.append('text')
            .attr('x', d => d.centerX)
            .attr('y', d => d.centerY - 20)
            .attr('text-anchor', 'middle')
            .style('fill', '#ffffff')
            .style('font-size', '15px')
            .style('font-weight', '700')
            .text(d => d.name)
            .each(function() {
                const maxWidth = 240;
                let textLength = this.getComputedTextLength();
                if (textLength > maxWidth) {
                    const scale = maxWidth / textLength;
                    const currentFontSize = 15;
                    let newFontSize = Math.max(10, currentFontSize * scale);
                    d3.select(this).style('font-size', newFontSize + 'px');
                    // Re-measure to ensure it fits
                    textLength = this.getComputedTextLength();
                    if (textLength > maxWidth) {
                        newFontSize = Math.max(9, newFontSize * (maxWidth / textLength));
                        d3.select(this).style('font-size', newFontSize + 'px');
                    }
                }
            });

        collapsedGroups.append('text')
            .attr('x', d => d.centerX)
            .attr('y', d => d.centerY + 5)
            .attr('text-anchor', 'middle')
            .style('fill', '#ffffff')
            .style('opacity', 0.9)
            .style('font-size', '12px')
            .text(d => d.nodes.length + ' nodes • ' + d.llmProvider)
            .each(function() {
                const maxWidth = 240;
                let textLength = this.getComputedTextLength();
                if (textLength > maxWidth) {
                    const scale = maxWidth / textLength;
                    const currentFontSize = 12;
                    let newFontSize = Math.max(9, currentFontSize * scale);
                    d3.select(this).style('font-size', newFontSize + 'px');
                    // Re-measure to ensure it fits
                    textLength = this.getComputedTextLength();
                    if (textLength > maxWidth) {
                        newFontSize = Math.max(8, newFontSize * (maxWidth / textLength));
                        d3.select(this).style('font-size', newFontSize + 'px');
                    }
                }
            });

        collapsedGroups.append('text')
            .attr('x', d => d.centerX)
            .attr('y', d => d.centerY + 30)
            .attr('text-anchor', 'middle')
            .style('fill', '#ffffff')
            .style('opacity', 0.7)
            .style('font-size', '12px')
            .text('Click to expand ▼');

        // Drag functions (update fixed positions)
        let dragStartX, dragStartY;

        function dragstarted(event, d) {
            // Track start position to detect click vs drag
            dragStartX = event.x;
            dragStartY = event.y;
            d3.select(this).raise();
        }

        function dragged(event, d) {
            // Snap to grid
            d.fx = snapToGrid(event.x);
            d.fy = snapToGrid(event.y);
            d.x = d.fx;
            d.y = d.fy;

            // Update node position
            d3.select(this).attr('transform', \`translate(\${d.x},\${d.y})\`);

            // Update connected edges (using collapsed group routing if needed)
            link.attr('d', function(l) {
                const sourceNode = getNodeOrCollapsedGroup(l.source);
                const targetNode = getNodeOrCollapsedGroup(l.target);
                if (!sourceNode || !targetNode) return '';

                const targetWidth = targetNode.isCollapsedGroup ? 260 : 140;
                const targetHeight = targetNode.isCollapsedGroup ? 130 : 70;

                const intersection = intersectRect(sourceNode, targetNode, targetWidth, targetHeight);
                return \`M\${sourceNode.x},\${sourceNode.y} L\${intersection.x},\${intersection.y}\`;
            });

            linkHover.attr('d', function(l) {
                const sourceNode = getNodeOrCollapsedGroup(l.source);
                const targetNode = getNodeOrCollapsedGroup(l.target);
                if (!sourceNode || !targetNode) return '';

                const targetWidth = targetNode.isCollapsedGroup ? 260 : 140;
                const targetHeight = targetNode.isCollapsedGroup ? 130 : 70;

                const intersection = intersectRect(sourceNode, targetNode, targetWidth, targetHeight);
                return \`M\${sourceNode.x},\${sourceNode.y} L\${intersection.x},\${intersection.y}\`;
            });

            linkLabelGroup.attr('transform', function(l) {
                const sourceNode = getNodeOrCollapsedGroup(l.source);
                const targetNode = getNodeOrCollapsedGroup(l.target);
                if (!sourceNode || !targetNode) return 'translate(0,0)';

                const midX = (sourceNode.x + targetNode.x) / 2;
                const midY = (sourceNode.y + targetNode.y) / 2;
                return 'translate(' + midX + ',' + midY + ')';
            })
            .style('display', function(l) {
                // Hide labels for edges where both endpoints are inside a collapsed group
                const sourceNodeData = currentGraphData.nodes.find(n => n.id === l.source);
                const targetNodeData = currentGraphData.nodes.find(n => n.id === l.target);

                if (!sourceNodeData || !targetNodeData) return 'block';

                // Check if both nodes belong to a collapsed group
                const sourceGroup = workflowGroups.find(g => g.collapsed && g.nodes.includes(sourceNodeData.id));
                const targetGroup = workflowGroups.find(g => g.collapsed && g.nodes.includes(targetNodeData.id));

                // Hide if both nodes are in the same collapsed group
                if (sourceGroup && targetGroup && sourceGroup.id === targetGroup.id) {
                    return 'none';
                }

                return 'block';
            });

            // Update background rectangles for edge labels
            linkLabel.each(function() {
                const textElement = this;
                const bbox = textElement.getBBox();
                const padding = 3;
                const rect = textElement.previousSibling;

                if (rect && rect.classList.contains('link-label-bg')) {
                    rect.setAttribute('x', bbox.x - padding);
                    rect.setAttribute('y', bbox.y - padding);
                    rect.setAttribute('width', bbox.width + padding * 2);
                    rect.setAttribute('height', bbox.height + padding * 2);
                }
            });

            // Update minimap
            updateMinimapNodePosition(d);
        }

        function updateMinimapNodePosition(node) {
            if (!minimapSvg) return;

            const scale = minimapSvg.minimapScale;
            const offsetX = minimapSvg.minimapOffsetX;
            const offsetY = minimapSvg.minimapOffsetY;
            const minX = minimapSvg.minimapMinX;
            const minY = minimapSvg.minimapMinY;

            const toMinimapX = x => (x - minX) * scale + offsetX;
            const toMinimapY = y => (y - minY) * scale + offsetY;

            // Update node position
            minimapSvg.select('circle[data-node-id="' + node.id + '"]')
                .attr('cx', toMinimapX(node.x))
                .attr('cy', toMinimapY(node.y));

            // Update connected edges
            minimapSvg.selectAll('.minimap-edge').each(function() {
                const edge = d3.select(this);
                const edgeData = currentGraphData.edges.find(e =>
                    edge.attr('data-source') === e.source && edge.attr('data-target') === e.target
                );

                if (edgeData && (edgeData.source === node.id || edgeData.target === node.id)) {
                    const sourceNode = currentGraphData.nodes.find(n => n.id === edgeData.source);
                    const targetNode = currentGraphData.nodes.find(n => n.id === edgeData.target);

                    edge.attr('x1', toMinimapX(sourceNode.x))
                        .attr('y1', toMinimapY(sourceNode.y))
                        .attr('x2', toMinimapX(targetNode.x))
                        .attr('y2', toMinimapY(targetNode.y));
                }
            });
        }

        let currentlyOpenNodeId = null;

        function dragended(event, d) {
            // Detect click vs drag (if moved less than 5 pixels, treat as click)
            const distance = Math.sqrt(
                Math.pow(event.x - dragStartX, 2) + Math.pow(event.y - dragStartY, 2)
            );

            if (distance < 5) {
                // It was a click, not a drag
                console.log('Node clicked:', d);
                event.sourceEvent.stopPropagation();

                // Toggle panel if clicking the same node
                if (currentlyOpenNodeId === d.id) {
                    closePanel();
                } else {
                    openPanel(d);
                }
            }
        }

        // Refresh analysis (bypasses cache)
        function refreshAnalysis() {
            vscode.postMessage({ command: 'refreshAnalysis' });
        }

        // Toggle expand/collapse all workflows
        function toggleExpandAll() {
            if (!workflowGroups || workflowGroups.length === 0) return;

            // Check if any groups are expanded
            const anyExpanded = workflowGroups.some(g => !g.collapsed && g.id !== 'group_orphans');

            // If any expanded, collapse all. Otherwise, expand all
            const shouldCollapse = anyExpanded;

            workflowGroups.forEach(g => {
                if (g.id !== 'group_orphans') {
                    g.collapsed = shouldCollapse;
                }
            });

            updateGroupVisibility();
        }

        // Format graph (reset to original layout)
        function formatGraph() {
            // Reset all nodes to their original dagre-computed positions
            currentGraphData.nodes.forEach(node => {
                const orig = originalPositions.get(node.id);
                if (orig) {
                    node.x = orig.x;
                    node.y = orig.y;
                    node.fx = orig.x;
                    node.fy = orig.y;
                }
            });

            // Recalculate group bounds based on new node positions
            workflowGroups.forEach(group => {
                const groupNodes = currentGraphData.nodes.filter(n => group.nodes.includes(n.id));
                if (groupNodes.length === 0) return;

                const xs = groupNodes.map(n => n.x);
                const ys = groupNodes.map(n => n.y);

                group.bounds = {
                    minX: Math.min(...xs) - 90,  // Node half-width (70) + margin (20)
                    maxX: Math.max(...xs) + 90,  // Node half-width (70) + margin (20)
                    minY: Math.min(...ys) - 75,  // Node half-height (35) + margin (40 for title)
                    maxY: Math.max(...ys) + 55   // Node half-height (35) + margin (20)
                };

                // Update center for collapsed state
                group.centerX = (group.bounds.minX + group.bounds.maxX) / 2;
                group.centerY = (group.bounds.minY + group.bounds.maxY) / 2;
            });

            // Update bounding box positions with smooth transition
            svg.selectAll('.group-background')
                .transition()
                .duration(500)
                .attr('x', d => d.bounds.minX)
                .attr('y', d => d.bounds.minY)
                .attr('width', d => d.bounds.maxX - d.bounds.minX)
                .attr('height', d => d.bounds.maxY - d.bounds.minY);

            // Update bounding box title positions
            svg.selectAll('.group-title-expanded')
                .transition()
                .duration(500)
                .attr('x', d => d.bounds.minX + 40)
                .attr('y', d => d.bounds.minY + 20);

            // Update collapse button positions
            svg.selectAll('.group-collapse-btn')
                .transition()
                .duration(500)
                .attr('transform', d => \`translate(\${d.bounds.minX + 10}, \${d.bounds.minY + 10})\`);

            // Update node positions with smooth transition
            svg.selectAll('.node')
                .transition()
                .duration(500)
                .attr('transform', d => \`translate(\${d.x},\${d.y})\`);

            // Update edge positions (smooth transition)
            svg.selectAll('.link').transition().duration(500)
                .attr('d', function(l) {
                    const sourceNode = getNodeOrCollapsedGroup(l.source);
                    const targetNode = getNodeOrCollapsedGroup(l.target);
                    if (!sourceNode || !targetNode) return '';

                    const targetWidth = targetNode.isCollapsedGroup ? 260 : 140;
                    const targetHeight = targetNode.isCollapsedGroup ? 130 : 70;

                    const intersection = intersectRect(sourceNode, targetNode, targetWidth, targetHeight);
                    return \`M\${sourceNode.x},\${sourceNode.y} L\${intersection.x},\${intersection.y}\`;
                });

            svg.selectAll('.link-hover').transition().duration(500)
                .attr('d', function(l) {
                    const sourceNode = getNodeOrCollapsedGroup(l.source);
                    const targetNode = getNodeOrCollapsedGroup(l.target);
                    if (!sourceNode || !targetNode) return '';

                    const targetWidth = targetNode.isCollapsedGroup ? 260 : 140;
                    const targetHeight = targetNode.isCollapsedGroup ? 130 : 70;

                    const intersection = intersectRect(sourceNode, targetNode, targetWidth, targetHeight);
                    return \`M\${sourceNode.x},\${sourceNode.y} L\${intersection.x},\${intersection.y}\`;
                });

            // Update edge label positions
            svg.selectAll('.link-label-group').transition().duration(500)
                .attr('transform', function(l) {
                    const sourceNode = getNodeOrCollapsedGroup(l.source);
                    const targetNode = getNodeOrCollapsedGroup(l.target);
                    if (!sourceNode || !targetNode) return 'translate(0,0)';

                    const midX = (sourceNode.x + targetNode.x) / 2;
                    const midY = (sourceNode.y + targetNode.y) / 2;
                    return 'translate(' + midX + ',' + midY + ')';
                });
        }

        // Toggle legend visibility
        function toggleLegend() {
            const legendContent = document.getElementById('legendContent');
            const legendToggle = document.getElementById('legendToggle');
            if (legendContent.style.display === 'none') {
                legendContent.style.display = 'block';
                legendToggle.textContent = '−';
            } else {
                legendContent.style.display = 'none';
                legendToggle.textContent = '+';
            }
        }

        // Zoom controls
        function resetZoom() {
            fitToScreen();
        }

        function zoomIn() {
            svg.transition().duration(300).call(
                zoom.scaleBy,
                1.3
            );
        }

        function zoomOut() {
            svg.transition().duration(300).call(
                zoom.scaleBy,
                0.7
            );
        }

        // Button tooltip handlers
        function showButtonTooltip(event, text) {
            const tooltip = document.getElementById('buttonTooltip');
            tooltip.textContent = text;

            // Position tooltip and prevent cutoff
            positionTooltip(tooltip, event.clientX, event.clientY);
            tooltip.classList.add('visible');
        }

        function positionTooltip(tooltip, mouseX, mouseY) {
            // Get tooltip dimensions (need to make it visible first to measure)
            tooltip.style.opacity = '0';
            tooltip.style.display = 'block';
            const tooltipRect = tooltip.getBoundingClientRect();
            tooltip.style.opacity = '';
            tooltip.style.display = '';

            // Default position: right and above cursor
            let left = mouseX + 10;
            let top = mouseY - 30;

            // Check right boundary
            if (left + tooltipRect.width > window.innerWidth) {
                // Position to left of cursor instead
                left = mouseX - tooltipRect.width - 10;
            }

            // Check left boundary
            if (left < 0) {
                left = 10;
            }

            // Check top boundary
            if (top < 0) {
                // Position below cursor instead
                top = mouseY + 10;
            }

            // Check bottom boundary
            if (top + tooltipRect.height > window.innerHeight) {
                top = window.innerHeight - tooltipRect.height - 10;
            }

            tooltip.style.left = left + 'px';
            tooltip.style.top = top + 'px';
        }

        function hideButtonTooltip() {
            const tooltip = document.getElementById('buttonTooltip');
            tooltip.classList.remove('visible');
        }

        // Attach tooltip listeners to all control buttons
        document.querySelectorAll('#controls button').forEach((btn, index) => {
            const tooltips = ['Zoom In', 'Zoom Out', 'Fit to Screen', 'Expand/Collapse All Workflows', 'Reset Layout', 'Reanalyze Entire Workspace'];
            btn.addEventListener('mouseenter', (e) => showButtonTooltip(e, tooltips[index]));
            btn.addEventListener('mousemove', (e) => {
                const tooltip = document.getElementById('buttonTooltip');
                positionTooltip(tooltip, e.clientX, e.clientY);
            });
            btn.addEventListener('mouseleave', hideButtonTooltip);
        });

        // Initial view - fit entire graph to screen
        function fitToScreen() {
            // Get fresh container dimensions (important if container has resized)
            const container = document.getElementById('graph');
            const width = container.clientWidth;
            const height = container.clientHeight;

            // Calculate bounds from actual node positions (ignore pegboard)
            if (currentGraphData.nodes.length === 0) return;

            const nodeWidth = 140;
            const nodeHeight = 70;
            const xs = currentGraphData.nodes.map(n => n.x);
            const ys = currentGraphData.nodes.map(n => n.y);
            const minX = Math.min(...xs) - nodeWidth / 2;
            const maxX = Math.max(...xs) + nodeWidth / 2;
            const minY = Math.min(...ys) - nodeHeight; // Extra top margin for title
            const maxY = Math.max(...ys) + nodeHeight / 2;

            const fullWidth = maxX - minX;
            const fullHeight = maxY - minY;
            const midX = (minX + maxX) / 2;
            const midY = (minY + maxY) / 2;

            if (fullWidth === 0 || fullHeight === 0) return;

            // Add padding (0.9 uses 90% of available space, leaving 10% padding)
            const scale = 0.9 / Math.max(fullWidth / width, fullHeight / height);
            const translate = [width / 2 - scale * midX, height / 2 - scale * midY];

            svg.transition().duration(500).call(
                zoom.transform,
                d3.zoomIdentity.translate(translate[0], translate[1]).scale(scale)
            );
        }

        // Minimap rendering
        let minimapSvg, minimapViewportRect;

        function renderMinimap() {
            const minimapContainer = document.getElementById('minimap');
            const minimapWidth = 200;
            const minimapHeight = 150;

            // Clear existing minimap
            minimapContainer.innerHTML = '';

            // Create minimap SVG
            minimapSvg = d3.select('#minimap')
                .append('svg')
                .attr('width', minimapWidth)
                .attr('height', minimapHeight);

            const minimapG = minimapSvg.append('g');

            // Calculate bounds from node positions
            if (currentGraphData.nodes.length === 0) return;

            const nodeWidth = 140;
            const nodeHeight = 70;
            const xs = currentGraphData.nodes.map(n => n.x);
            const ys = currentGraphData.nodes.map(n => n.y);
            const minX = Math.min(...xs) - nodeWidth / 2;
            const maxX = Math.max(...xs) + nodeWidth / 2;
            const minY = Math.min(...ys) - nodeHeight; // Extra top margin for title
            const maxY = Math.max(...ys) + nodeHeight / 2;

            const graphWidth = maxX - minX;
            const graphHeight = maxY - minY;
            const graphCenterX = (minX + maxX) / 2;
            const graphCenterY = (minY + maxY) / 2;

            // Safety check: ensure valid dimensions
            if (graphWidth <= 0 || graphHeight <= 0 || !isFinite(graphWidth) || !isFinite(graphHeight)) {
                return;
            }

            // Calculate scale to fit graph in minimap with padding
            const padding = 10;
            const scale = Math.min(
                (minimapWidth - padding * 2) / graphWidth,
                (minimapHeight - padding * 2) / graphHeight
            );

            // Safety check: ensure valid scale
            if (!isFinite(scale) || scale <= 0) {
                return;
            }

            // Calculate scaled dimensions
            const scaledWidth = graphWidth * scale;
            const scaledHeight = graphHeight * scale;

            // Calculate offset to center the graph in the minimap
            const offsetX = (minimapWidth - scaledWidth) / 2;
            const offsetY = (minimapHeight - scaledHeight) / 2;

            // Function to transform coordinates to minimap space (centered)
            const toMinimapX = x => (x - minX) * scale + offsetX;
            const toMinimapY = y => (y - minY) * scale + offsetY;

            // Render workflow groups as rectangles
            workflowGroups.forEach(group => {
                if (group.bounds) {
                    minimapG.append('rect')
                        .attr('class', 'minimap-group')
                        .attr('x', toMinimapX(group.bounds.minX))
                        .attr('y', toMinimapY(group.bounds.minY))
                        .attr('width', (group.bounds.maxX - group.bounds.minX) * scale)
                        .attr('height', (group.bounds.maxY - group.bounds.minY) * scale)
                        .attr('rx', 2)
                        .style('fill', 'none')
                        .style('stroke', 'var(--vscode-button-background)')
                        .style('stroke-width', '1px')
                        .style('stroke-dasharray', '2,2')
                        .style('opacity', 0.6);
                }
            });

            // Render edges
            currentGraphData.edges.forEach(edge => {
                const sourceNode = currentGraphData.nodes.find(n => n.id === edge.source);
                const targetNode = currentGraphData.nodes.find(n => n.id === edge.target);

                if (sourceNode && targetNode) {
                    minimapG.append('line')
                        .attr('class', 'minimap-edge')
                        .attr('data-source', edge.source)
                        .attr('data-target', edge.target)
                        .attr('x1', toMinimapX(sourceNode.x))
                        .attr('y1', toMinimapY(sourceNode.y))
                        .attr('x2', toMinimapX(targetNode.x))
                        .attr('y2', toMinimapY(targetNode.y));
                }
            });

            // Render nodes with type-based coloring
            currentGraphData.nodes.forEach(node => {
                minimapG.append('circle')
                    .attr('class', 'minimap-node ' + node.type)
                    .attr('cx', toMinimapX(node.x))
                    .attr('cy', toMinimapY(node.y))
                    .attr('r', 3)
                    .attr('data-node-id', node.id);
            });

            // Add viewport rectangle
            minimapViewportRect = minimapG.append('rect')
                .attr('class', 'minimap-viewport');

            // Update viewport rectangle
            updateMinimapViewport();

            // Click to navigate
            minimapSvg.on('click', function(event) {
                const [mx, my] = d3.pointer(event);

                // Convert minimap coords back to graph coords
                const graphX = (mx - offsetX) / scale + minX;
                const graphY = (my - offsetY) / scale + minY;

                // Get current transform
                const currentTransform = d3.zoomTransform(svg.node());

                // Calculate new translation to center on clicked point
                const newTranslate = [
                    width / 2 - currentTransform.k * graphX,
                    height / 2 - currentTransform.k * graphY
                ];

                // Apply new transform
                svg.transition().duration(300).call(
                    zoom.transform,
                    d3.zoomIdentity.translate(newTranslate[0], newTranslate[1]).scale(currentTransform.k)
                );
            });

            // Store minimap transform info for viewport updates
            minimapSvg.minimapScale = scale;
            minimapSvg.minimapOffsetX = offsetX;
            minimapSvg.minimapOffsetY = offsetY;
            minimapSvg.minimapMinX = minX;
            minimapSvg.minimapMinY = minY;
        }

        function updateMinimapViewport() {
            if (!minimapViewportRect || !minimapSvg) return;

            const currentTransform = d3.zoomTransform(svg.node());
            const scale = minimapSvg.minimapScale;
            const offsetX = minimapSvg.minimapOffsetX;
            const offsetY = minimapSvg.minimapOffsetY;
            const minX = minimapSvg.minimapMinX;
            const minY = minimapSvg.minimapMinY;

            // Safety check: ensure all values are valid
            if (!isFinite(scale) || !isFinite(offsetX) || !isFinite(offsetY) || !isFinite(minX) || !isFinite(minY)) {
                return;
            }

            // Get current container dimensions
            const container = document.getElementById('graph');
            const width = container.clientWidth;
            const height = container.clientHeight;

            // Calculate visible area in graph coordinates
            const viewportX = -currentTransform.x / currentTransform.k;
            const viewportY = -currentTransform.y / currentTransform.k;
            const viewportWidth = width / currentTransform.k;
            const viewportHeight = height / currentTransform.k;

            // Convert to minimap coordinates
            const rectX = (viewportX - minX) * scale + offsetX;
            const rectY = (viewportY - minY) * scale + offsetY;
            const rectWidth = viewportWidth * scale;
            const rectHeight = viewportHeight * scale;

            minimapViewportRect
                .attr('x', rectX)
                .attr('y', rectY)
                .attr('width', rectWidth)
                .attr('height', rectHeight);
        }

        // Update viewport on zoom/pan
        zoom.on('zoom.minimap', (event) => {
            g.attr('transform', event.transform);
            updateMinimapViewport();
        });

        // Fit to screen on initial load
        setTimeout(() => {
            renderMinimap();
            fitToScreen();
            // Apply initial group collapse states
            updateGroupVisibility();
        }, 100);

        // Panel functions
        function openPanel(nodeData) {
            console.log('openPanel called with:', nodeData);

            const panel = document.getElementById('sidePanel');
            const title = document.getElementById('panelTitle');
            const type = document.getElementById('panelType');
            const descriptionSection = document.getElementById('descriptionSection');
            const description = document.getElementById('panelDescription');
            const sourceSection = document.getElementById('sourceSection');
            const source = document.getElementById('panelSource');
            const incomingSection = document.getElementById('incomingSection');
            const incoming = document.getElementById('panelIncoming');
            const outgoingSection = document.getElementById('outgoingSection');
            const outgoing = document.getElementById('panelOutgoing');

            console.log('Panel elements:', { panel, title, type, descriptionSection, description, sourceSection, source, incomingSection, incoming, outgoingSection, outgoing });

            if (!panel || !title || !type || !sourceSection || !source || !descriptionSection || !description || !incomingSection || !incoming || !outgoingSection || !outgoing) {
                console.error('Missing panel elements');
                return;
            }

            title.textContent = nodeData.label;
            type.textContent = nodeData.type;
            type.className = 'type-badge ' + nodeData.type;

            if (nodeData.description) {
                description.textContent = nodeData.description;
                descriptionSection.style.display = 'block';
            } else {
                descriptionSection.style.display = 'none';
            }

            if (nodeData.source) {
                const fileName = nodeData.source.file.split('/').pop();
                source.textContent = \`\${nodeData.source.function} in \${fileName}:\${nodeData.source.line}\`;
                source.onclick = (e) => {
                    e.preventDefault();
                    vscode.postMessage({
                        command: 'openFile',
                        file: nodeData.source.file,
                        line: nodeData.source.line
                    });
                };
                sourceSection.style.display = 'block';
            } else {
                sourceSection.style.display = 'none';
            }

            // Find incoming edges
            const incomingEdges = currentGraphData.edges.filter(e => e.target === nodeData.id);
            if (incomingEdges.length > 0) {
                incoming.innerHTML = incomingEdges.map(edge => {
                    const sourceNode = currentGraphData.nodes.find(n => n.id === edge.source);
                    const fileName = edge.sourceLocation?.file?.split('/').pop() || '';
                    const location = edge.sourceLocation ? \`\${fileName}:\${edge.sourceLocation.line}\` : '';
                    return \`
                        <div style="margin: 8px 0; padding: 8px; background: var(--vscode-input-background); border-radius: 4px;">
                            <div style="display: flex; align-items: center; gap: 8px; margin-bottom: 4px; flex-wrap: wrap;">
                                \${edge.sourceLocation ? \`<a href="#" class="source-link" onclick="event.preventDefault(); vscode.postMessage({command: 'openFile', file: '\${edge.sourceLocation.file}', line: \${edge.sourceLocation.line}});"><strong>\${edge.label}</strong></a>\` : \`<strong>\${edge.label}</strong>\`}
                                \${edge.dataType ? \`<span style="font-size: 10px; padding: 2px 6px; background: var(--vscode-badge-background); color: var(--vscode-badge-foreground); border-radius: 3px;">\${edge.dataType}</span>\` : ''}
                            </div>
                            <div style="font-size: 11px; color: var(--vscode-descriptionForeground);">
                                From: \${sourceNode ? sourceNode.label : edge.source}
                            </div>
                            \${edge.description ? \`<div style="font-size: 11px; margin-top: 4px; font-style: italic;">\${edge.description}</div>\` : ''}
                        </div>
                    \`;
                }).join('');
                incomingSection.style.display = 'block';
            } else {
                incomingSection.style.display = 'none';
            }

            // Find outgoing edges
            const outgoingEdges = currentGraphData.edges.filter(e => e.source === nodeData.id);
            if (outgoingEdges.length > 0) {
                outgoing.innerHTML = outgoingEdges.map(edge => {
                    const targetNode = currentGraphData.nodes.find(n => n.id === edge.target);
                    const fileName = edge.sourceLocation?.file?.split('/').pop() || '';
                    const location = edge.sourceLocation ? \`\${fileName}:\${edge.sourceLocation.line}\` : '';
                    return \`
                        <div style="margin: 8px 0; padding: 8px; background: var(--vscode-input-background); border-radius: 4px;">
                            <div style="display: flex; align-items: center; gap: 8px; margin-bottom: 4px; flex-wrap: wrap;">
                                \${edge.sourceLocation ? \`<a href="#" class="source-link" onclick="event.preventDefault(); vscode.postMessage({command: 'openFile', file: '\${edge.sourceLocation.file}', line: \${edge.sourceLocation.line}});"><strong>\${edge.label}</strong></a>\` : \`<strong>\${edge.label}</strong>\`}
                                \${edge.dataType ? \`<span style="font-size: 10px; padding: 2px 6px; background: var(--vscode-badge-background); color: var(--vscode-badge-foreground); border-radius: 3px;">\${edge.dataType}</span>\` : ''}
                            </div>
                            <div style="font-size: 11px; color: var(--vscode-descriptionForeground);">
                                To: \${targetNode ? targetNode.label : edge.target}
                            </div>
                            \${edge.description ? \`<div style="font-size: 11px; margin-top: 4px; font-style: italic;">\${edge.description}</div>\` : ''}
                        </div>
                    \`;
                }).join('');
                outgoingSection.style.display = 'block';
            } else {
                outgoingSection.style.display = 'none';
            }

            console.log('Adding open class to panel');
            panel.classList.add('open');

            // Track currently open node
            currentlyOpenNodeId = nodeData.id;

            // Show selection indicator for this node
            d3.selectAll('.node-selection-indicator').style('display', 'none');
            d3.select('.node-selection-indicator[data-node-id="' + nodeData.id + '"]').style('display', 'block');
        }

        function closePanel() {
            const panel = document.getElementById('sidePanel');
            panel.classList.remove('open');

            // Clear currently open node
            currentlyOpenNodeId = null;

            // Hide all selection indicators
            d3.selectAll('.node-selection-indicator').style('display', 'none');
        }

        // Close panel when clicking outside
        svg.on('click', () => {
            closePanel();
        });

        // Listen for messages from the extension
        window.addEventListener('message', event => {
            const message = event.data;
            const indicator = document.getElementById('loadingIndicator');
            const iconSpan = indicator.querySelector('.loading-icon');
            const textSpan = indicator.querySelector('.loading-text');

            switch (message.command) {
                case 'showLoading':
                    indicator.className = 'loading-indicator';
                    iconSpan.textContent = '⟳';
                    textSpan.textContent = message.text || 'Loading...';
                    indicator.style.display = 'block';
                    break;

                case 'updateProgress':
                    indicator.className = 'loading-indicator';
                    iconSpan.textContent = '⟳';
                    textSpan.textContent = \`Batch \${message.current}/\${message.total} complete...\`;
                    indicator.style.display = 'block';
                    break;

                case 'updateGraph':
                    // Merge new graph data and reload page to re-render
                    currentGraphData = mergeGraphs(currentGraphData, message.graph);
                    location.reload();
                    break;

                case 'analysisStarted':
                    indicator.className = 'loading-indicator';
                    iconSpan.textContent = '⟳';
                    textSpan.textContent = 'Analyzing workflow...';
                    indicator.style.display = 'block';
                    break;

                case 'analysisComplete':
                    if (message.success) {
                        indicator.className = 'loading-indicator success';
                        iconSpan.textContent = '✓';
                        textSpan.textContent = 'Analysis complete';
                        setTimeout(() => {
                            indicator.style.display = 'none';
                        }, 2000);
                    } else {
                        indicator.className = 'loading-indicator error';
                        iconSpan.textContent = '✕';
                        textSpan.textContent = message.error || 'Analysis failed';
                        setTimeout(() => {
                            indicator.style.display = 'none';
                        }, 3000);
                    }
                    break;
            }
        });
    </script>
</body>
</html>`;
    }
}
