import * as vscode from 'vscode';
import { WorkflowGraph } from './api';

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
                    }
                },
                undefined,
                this.context.subscriptions
            );
        }

        this.panel.webview.html = this.getHtml(graph);
    }

    private getHtml(graph: WorkflowGraph): string {
        return `<!DOCTYPE html>
<html>
<head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <title>Workflow Visualization</title>
    <script src="https://d3js.org/d3.v7.min.js"></script>
    <script src="https://cdn.jsdelivr.net/npm/dagre@0.8.5/dist/dagre.min.js"></script>
    <style>
        * {
            margin: 0;
            padding: 0;
            box-sizing: border-box;
        }
        body {
            overflow: hidden;
            background: var(--vscode-editor-background);
            color: var(--vscode-editor-foreground);
            font-family: var(--vscode-font-family);
        }
        #header {
            position: fixed;
            top: 0;
            left: 0;
            right: 0;
            height: 36px;
            padding: 0 16px;
            background: var(--vscode-editor-background);
            border-bottom: 1px solid var(--vscode-panel-border);
            z-index: 1000;
            display: flex;
            justify-content: space-between;
            align-items: center;
        }
        #header h1 {
            font-size: 13px;
            font-weight: 500;
            margin: 0;
            color: var(--vscode-foreground);
            opacity: 0.9;
        }
        #controls {
            display: flex;
            gap: 4px;
        }
        #controls button {
            background: transparent;
            color: var(--vscode-icon-foreground);
            border: 1px solid transparent;
            padding: 4px;
            cursor: pointer;
            font-size: 16px;
            border-radius: 3px;
            width: 28px;
            height: 28px;
            display: flex;
            align-items: center;
            justify-content: center;
            transition: all 0.15s ease;
        }
        #controls button:hover {
            background: var(--vscode-toolbar-hoverBackground);
            border-color: var(--vscode-contrastBorder);
        }
        #controls button svg {
            width: 16px;
            height: 16px;
            fill: currentColor;
        }
        #graph {
            position: fixed;
            top: 36px;
            left: 0;
            right: 0;
            bottom: 0;
            width: 100%;
            height: calc(100% - 36px);
        }
        svg {
            width: 100%;
            height: 100%;
            cursor: grab;
        }
        svg:active {
            cursor: grabbing;
        }
        .node {
            cursor: pointer;
        }
        .node rect {
            fill: var(--vscode-editor-background);
            stroke: #ffffff;
            stroke-width: 2px;
            opacity: 1;
        }
        .node:hover rect {
            stroke-width: 3px;
            fill: var(--vscode-list-hoverBackground);
        }
        .node rect {
            pointer-events: all;
            cursor: pointer;
        }
        .node-icon {
            pointer-events: none;
            user-select: none;
        }
        .node-icon.trigger { color: #FFB74D; }
        .node-icon.llm { color: #64B5F6; }
        .node-icon.tool { color: #81C784; }
        .node-icon.decision { color: #BA68C8; }
        .node-icon.integration { color: #FF8A65; }
        .node-icon.memory { color: #4DB6AC; }
        .node-icon.parser { color: #A1887F; }
        .node-icon.output { color: #90A4AE; }
        .node text {
            fill: var(--vscode-editor-foreground);
            font-size: 11px;
            pointer-events: none;
            user-select: none;
            text-anchor: middle;
        }
        .link {
            fill: none;
            stroke: var(--vscode-editor-foreground);
            stroke-opacity: 0.6;
            stroke-width: 2px;
        }
        .link-label {
            fill: var(--vscode-editor-foreground);
            font-size: 10px;
            font-weight: 500;
            pointer-events: none;
            user-select: none;
            text-anchor: middle;
            background: var(--vscode-editor-background);
            padding: 2px 4px;
        }
        .edge-tooltip {
            position: fixed;
            background: var(--vscode-editor-background);
            border: 1px solid var(--vscode-panel-border);
            border-radius: 4px;
            padding: 8px;
            font-size: 12px;
            z-index: 10000;
            box-shadow: 0 2px 8px rgba(0,0,0,0.3);
            max-width: 300px;
            pointer-events: none;
        }
        .edge-tooltip div {
            margin: 4px 0;
        }
        .edge-tooltip strong {
            color: var(--vscode-textLink-foreground);
        }
        .loading-indicator {
            position: fixed;
            bottom: 16px;
            right: 16px;
            background: var(--vscode-editor-background);
            border: 1px solid var(--vscode-panel-border);
            border-radius: 4px;
            padding: 8px 12px;
            font-size: 11px;
            z-index: 2000;
            box-shadow: 0 2px 8px rgba(0,0,0,0.3);
            transition: opacity 0.3s ease;
        }
        .loading-content {
            display: flex;
            align-items: center;
            gap: 8px;
        }
        .loading-icon {
            display: inline-block;
            animation: spin 1s linear infinite;
        }
        .loading-indicator.success {
            border-color: #4CAF50;
        }
        .loading-indicator.success .loading-icon {
            animation: none;
        }
        .loading-indicator.error {
            border-color: #f44336;
        }
        .loading-indicator.error .loading-icon {
            animation: none;
        }
        @keyframes spin {
            from { transform: rotate(0deg); }
            to { transform: rotate(360deg); }
        }
        .side-panel {
            position: fixed;
            top: 36px;
            right: -320px;
            width: 320px;
            bottom: 0;
            background: var(--vscode-editor-background);
            border-left: 1px solid var(--vscode-panel-border);
            transition: right 0.3s ease;
            z-index: 1001;
            display: flex;
            flex-direction: column;
        }
        .side-panel.open {
            right: 0;
        }
        .panel-header {
            padding: 16px;
            border-bottom: 1px solid var(--vscode-panel-border);
            display: flex;
            justify-content: space-between;
            align-items: center;
        }
        .panel-header h2 {
            font-size: 14px;
            font-weight: 600;
            margin: 0;
            color: var(--vscode-foreground);
        }
        .close-btn {
            background: transparent;
            border: none;
            color: var(--vscode-icon-foreground);
            font-size: 24px;
            cursor: pointer;
            padding: 0;
            width: 24px;
            height: 24px;
            display: flex;
            align-items: center;
            justify-content: center;
            border-radius: 3px;
        }
        .close-btn:hover {
            background: var(--vscode-toolbar-hoverBackground);
        }
        .panel-content {
            padding: 16px;
            overflow-y: auto;
            flex: 1;
        }
        .panel-section {
            margin-bottom: 16px;
        }
        .panel-section label {
            display: block;
            font-size: 11px;
            text-transform: uppercase;
            color: var(--vscode-descriptionForeground);
            margin-bottom: 6px;
            font-weight: 600;
        }
        .type-badge {
            display: inline-block;
            padding: 4px 10px;
            border-radius: 12px;
            font-size: 12px;
            font-weight: 500;
        }
        .type-badge.trigger { background: #FFB74D20; color: #FFB74D; }
        .type-badge.llm { background: #64B5F620; color: #64B5F6; }
        .type-badge.tool { background: #81C78420; color: #81C784; }
        .type-badge.decision { background: #BA68C820; color: #BA68C8; }
        .type-badge.integration { background: #FF8A6520; color: #FF8A65; }
        .type-badge.memory { background: #4DB6AC20; color: #4DB6AC; }
        .type-badge.parser { background: #A1887F20; color: #A1887F; }
        .type-badge.output { background: #90A4AE20; color: #90A4AE; }
        .source-link {
            color: var(--vscode-textLink-foreground);
            text-decoration: none;
            font-size: 12px;
            font-family: var(--vscode-editor-font-family);
            display: block;
            padding: 6px;
            background: var(--vscode-editor-inactiveSelectionBackground);
            border-radius: 3px;
            word-break: break-all;
        }
        .source-link:hover {
            text-decoration: underline;
            background: var(--vscode-list-hoverBackground);
        }
    </style>
</head>
<body>
    <div id="header">
        <h1>${graph.llms_detected.join(', ') || 'Custom'} • ${graph.nodes.length} nodes • ${graph.edges.length} edges</h1>
        <div id="controls">
            <button onclick="resetZoom()" title="Fit to screen">
                <svg viewBox="0 0 16 16">
                    <path d="M2 2v4h1V3h3V2H2zm9 0v1h3v3h1V2h-4zM2 10v4h4v-1H3v-3H2zm12 0v3h-3v1h4v-4h-1z" fill="currentColor"/>
                </svg>
            </button>
            <button onclick="zoomIn()" title="Zoom in">
                <svg viewBox="0 0 16 16">
                    <path d="M8 3v10M3 8h10" stroke="currentColor" stroke-width="1.5" fill="none" stroke-linecap="round"/>
                </svg>
            </button>
            <button onclick="zoomOut()" title="Zoom out">
                <svg viewBox="0 0 16 16">
                    <path d="M3 8h10" stroke="currentColor" stroke-width="1.5" fill="none" stroke-linecap="round"/>
                </svg>
            </button>
        </div>
    </div>
    <div id="graph"></div>
    <div id="edgeTooltip" class="edge-tooltip" style="display: none;"></div>
    <div id="loadingIndicator" class="loading-indicator" style="display: none;">
        <div class="loading-content">
            <span class="loading-icon">⟳</span>
            <span class="loading-text">Analyzing workflow...</span>
        </div>
    </div>
    <div id="sidePanel" class="side-panel">
        <div class="panel-header">
            <h2 id="panelTitle"></h2>
            <button onclick="closePanel()" class="close-btn">×</button>
        </div>
        <div class="panel-content">
            <div class="panel-section">
                <label>Type</label>
                <div id="panelType" class="type-badge"></div>
            </div>
            <div class="panel-section" id="descriptionSection" style="display: none;">
                <label>Description</label>
                <div id="panelDescription" style="font-size: 12px; line-height: 1.5; color: var(--vscode-foreground);"></div>
            </div>
            <div class="panel-section" id="sourceSection">
                <label>Source</label>
                <a href="#" id="panelSource" class="source-link"></a>
            </div>
            <div class="panel-section" id="incomingSection" style="display: none;">
                <label>Incoming Data</label>
                <div id="panelIncoming"></div>
            </div>
            <div class="panel-section" id="outgoingSection" style="display: none;">
                <label>Outgoing Data</label>
                <div id="panelOutgoing"></div>
            </div>
        </div>
    </div>
    <script>
        const vscode = acquireVsCodeApi();
        const graphData = ${JSON.stringify(graph)};

        // Calculate intersection point at rectangle boundary
        function intersectRect(sourceNode, targetNode, nodeWidth = 50, nodeHeight = 50) {
            const dx = sourceNode.x - targetNode.x;
            const dy = sourceNode.y - targetNode.y;
            const halfWidth = nodeWidth / 2;
            const halfHeight = nodeHeight / 2;

            // Determine which edge is hit first (top/bottom vs left/right)
            if (Math.abs(dy/dx) > halfHeight/halfWidth) {
                // Hits top or bottom edge
                return {
                    x: targetNode.x + dx * Math.abs(halfHeight/dy),
                    y: targetNode.y + halfHeight * Math.sign(dy)
                };
            } else {
                // Hits left or right edge
                return {
                    x: targetNode.x + halfWidth * Math.sign(dx),
                    y: targetNode.y + dy * Math.abs(halfWidth/dx)
                };
            }
        }

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

        // Pegboard dot pattern
        const pattern = defs.append('pattern')
            .attr('id', 'pegboard')
            .attr('x', 0)
            .attr('y', 0)
            .attr('width', 20)
            .attr('height', 20)
            .attr('patternUnits', 'userSpaceOnUse');

        pattern.append('circle')
            .attr('cx', 10)
            .attr('cy', 10)
            .attr('r', 0.8)
            .attr('fill', 'var(--vscode-editor-foreground)')
            .attr('opacity', 0.15);

        // Add static pegboard background (doesn't zoom)
        svg.append('rect')
            .attr('width', '100%')
            .attr('height', '100%')
            .attr('fill', 'url(#pegboard)');

        // Main group for all graph elements (zoomable)
        const g = svg.append('g');

        // Arrow markers
        defs.append('marker')
            .attr('id', 'arrowhead')
            .attr('viewBox', '-0 -5 10 10')
            .attr('refX', 5)  // Small offset for arrow tip (path now stops at boundary)
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
            nodesep: 50,        // Vertical spacing between nodes
            ranksep: 150,       // Horizontal spacing between ranks (increased for edge labels)
            marginx: 25,        // Margins
            marginy: 25
        });
        dagreGraph.setDefaultEdgeLabel(() => ({}));

        // Add nodes to Dagre
        graphData.nodes.forEach(node => {
            dagreGraph.setNode(node.id, { width: 50, height: 70 });
        });

        // Add edges to Dagre
        graphData.edges.forEach(edge => {
            dagreGraph.setEdge(edge.source, edge.target);
        });

        // Compute layout
        dagre.layout(dagreGraph);

        // Apply Dagre positions to nodes
        graphData.nodes.forEach(node => {
            const pos = dagreGraph.node(node.id);
            node.x = pos.x;
            node.y = pos.y;
            node.fx = pos.x;
            node.fy = pos.y;
        });

        // Create links (edges)
        const linkGroup = g.append('g')
            .selectAll('g')
            .data(graphData.edges)
            .enter()
            .append('g')
            .attr('class', 'link-group');

        const link = linkGroup.append('path')
            .attr('class', 'link')
            .attr('marker-end', 'url(#arrowhead)');

        // Add edge labels
        const linkLabel = linkGroup.append('text')
            .attr('class', 'link-label')
            .text(d => d.label || '')
            .style('pointer-events', 'none');  // Don't interfere with edge hover

        // Add invisible wider path for easier hovering
        const linkHover = linkGroup.insert('path', '.link')
            .attr('class', 'link-hover')
            .style('stroke', 'transparent')
            .style('stroke-width', '20px')
            .style('fill', 'none')
            .style('cursor', 'pointer')
            .on('mouseover', function(event, d) {
                // Highlight the edge
                d3.select(this.parentNode).select('.link')
                    .style('stroke', '#00d9ff')
                    .style('stroke-width', '3px');

                // Show tooltip at edge midpoint
                const tooltip = document.getElementById('edgeTooltip');
                tooltip.innerHTML = \`
                    <div><strong>Variable:</strong> \${d.label || 'N/A'}</div>
                    \${d.dataType ? \`<div><strong>Type:</strong> \${d.dataType}</div>\` : ''}
                    \${d.description ? \`<div><strong>Description:</strong> \${d.description}</div>\` : ''}
                    \${d.sourceLocation ? \`<div><strong>Location:</strong> \${d.sourceLocation.file.split('/').pop()}:\${d.sourceLocation.line}</div>\` : ''}
                \`;

                // Get source and target nodes to calculate midpoint
                const sourceNode = graphData.nodes.find(n => n.id === d.source);
                const targetNode = graphData.nodes.find(n => n.id === d.target);

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
                // Reset edge highlight
                d3.select(this.parentNode).select('.link')
                    .style('stroke', null)
                    .style('stroke-width', null);

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
            .data(graphData.nodes)
            .enter()
            .append('g')
            .attr('class', 'node')
            .call(d3.drag()
                .on('start', dragstarted)
                .on('drag', dragged)
                .on('end', dragended));

        // Add square background
        node.append('rect')
            .attr('width', 50)
            .attr('height', 50)
            .attr('x', -25)
            .attr('y', -25)
            .attr('rx', 4);

        // Add icon based on node type
        node.append('g')
            .attr('class', d => \`node-icon \${d.type}\`)
            .html(d => getIcon(d.type));

        // Add label below node
        node.append('text')
            .text(d => d.label)
            .attr('y', 40);

        // Tooltip on hover
        node.append('title')
            .text(d => {
                let text = \`\${d.label}\\nType: \${d.type}\`;
                if (d.description) {
                    text += \`\\n\\n\${d.description}\`;
                }
                return text;
            });

        // Icon helper function
        function getIcon(type) {
            const icons = {
                trigger: '<svg viewBox="0 0 24 24" width="24" height="24"><path d="M13 3v7h9l-9 11v-7H4l9-11z" fill="currentColor"/></svg>',
                llm: '<svg viewBox="0 0 24 24" width="24" height="24"><circle cx="12" cy="12" r="3" fill="currentColor"/><path d="M12 2v4m0 12v4M4.93 4.93l2.83 2.83m8.48 8.48l2.83 2.83M2 12h4m12 0h4M4.93 19.07l2.83-2.83m8.48-8.48l2.83-2.83" stroke="currentColor" stroke-width="2" fill="none"/></svg>',
                tool: '<svg viewBox="0 0 24 24" width="24" height="24"><path d="M14.7 6.3a1 1 0 0 0 0 1.4l1.6 1.6a1 1 0 0 0 1.4 0l3.77-3.77a6 6 0 0 1-7.94 7.94l-6.91 6.91a2.12 2.12 0 0 1-3-3l6.91-6.91a6 6 0 0 1 7.94-7.94l-3.76 3.76z" fill="currentColor"/></svg>',
                decision: '<svg viewBox="0 0 24 24" width="24" height="24"><path d="M12 2l10 10-10 10L2 12 12 2z" fill="none" stroke="currentColor" stroke-width="2"/><path d="M8 12h8M12 8v8" stroke="currentColor" stroke-width="2"/></svg>',
                integration: '<svg viewBox="0 0 24 24" width="24" height="24"><circle cx="12" cy="12" r="2" fill="currentColor"/><circle cx="19" cy="12" r="2" fill="currentColor"/><circle cx="5" cy="12" r="2" fill="currentColor"/><path d="M7 12h10" stroke="currentColor" stroke-width="2"/></svg>',
                memory: '<svg viewBox="0 0 24 24" width="24" height="24"><rect x="3" y="6" width="18" height="12" rx="2" fill="none" stroke="currentColor" stroke-width="2"/><path d="M3 10h18M7 6v12M11 6v12M15 6v12M19 6v12" stroke="currentColor" stroke-width="1.5"/></svg>',
                parser: '<svg viewBox="0 0 24 24" width="24" height="24"><path d="M8 3v3m8-3v3M5 6h14a2 2 0 012 2v10a2 2 0 01-2 2H5a2 2 0 01-2-2V8a2 2 0 012-2zm0 4h14" fill="none" stroke="currentColor" stroke-width="2"/></svg>',
                output: '<svg viewBox="0 0 24 24" width="24" height="24"><path d="M9 3v18m6-18v18M3 12h18" stroke="currentColor" stroke-width="2" fill="none"/><circle cx="12" cy="12" r="2" fill="currentColor"/></svg>'
            };
            return icons[type] || icons.output;
        }

        // Set initial positions
        link.attr('d', d => {
            const sourceNode = graphData.nodes.find(n => n.id === d.source);
            const targetNode = graphData.nodes.find(n => n.id === d.target);
            const intersection = intersectRect(sourceNode, targetNode);
            return \`M\${sourceNode.x},\${sourceNode.y} L\${intersection.x},\${intersection.y}\`;
        });

        linkHover.attr('d', d => {
            const sourceNode = graphData.nodes.find(n => n.id === d.source);
            const targetNode = graphData.nodes.find(n => n.id === d.target);
            const intersection = intersectRect(sourceNode, targetNode);
            return \`M\${sourceNode.x},\${sourceNode.y} L\${intersection.x},\${intersection.y}\`;
        });

        linkLabel.attr('x', d => {
            const sourceNode = graphData.nodes.find(n => n.id === d.source);
            const targetNode = graphData.nodes.find(n => n.id === d.target);
            return (sourceNode.x + targetNode.x) / 2;
        }).attr('y', d => {
            const sourceNode = graphData.nodes.find(n => n.id === d.source);
            const targetNode = graphData.nodes.find(n => n.id === d.target);
            return (sourceNode.y + targetNode.y) / 2;
        });

        node.attr('transform', d => \`translate(\${d.x},\${d.y})\`);

        // Drag functions (update fixed positions)
        let dragStartX, dragStartY;

        function dragstarted(event, d) {
            // Track start position to detect click vs drag
            dragStartX = event.x;
            dragStartY = event.y;
            d3.select(this).raise();
        }

        function dragged(event, d) {
            d.fx = event.x;
            d.fy = event.y;
            d.x = event.x;
            d.y = event.y;

            // Update node position
            d3.select(this).attr('transform', \`translate(\${d.x},\${d.y})\`);

            // Update connected edges
            link.attr('d', function(l) {
                const sourceNode = graphData.nodes.find(n => n.id === l.source);
                const targetNode = graphData.nodes.find(n => n.id === l.target);
                const intersection = intersectRect(sourceNode, targetNode);
                return \`M\${sourceNode.x},\${sourceNode.y} L\${intersection.x},\${intersection.y}\`;
            });

            linkHover.attr('d', function(l) {
                const sourceNode = graphData.nodes.find(n => n.id === l.source);
                const targetNode = graphData.nodes.find(n => n.id === l.target);
                const intersection = intersectRect(sourceNode, targetNode);
                return \`M\${sourceNode.x},\${sourceNode.y} L\${intersection.x},\${intersection.y}\`;
            });

            linkLabel.attr('x', function(l) {
                const sourceNode = graphData.nodes.find(n => n.id === l.source);
                const targetNode = graphData.nodes.find(n => n.id === l.target);
                return (sourceNode.x + targetNode.x) / 2;
            }).attr('y', function(l) {
                const sourceNode = graphData.nodes.find(n => n.id === l.source);
                const targetNode = graphData.nodes.find(n => n.id === l.target);
                return (sourceNode.y + targetNode.y) / 2;
            });
        }

        function dragended(event, d) {
            // Detect click vs drag (if moved less than 5 pixels, treat as click)
            const distance = Math.sqrt(
                Math.pow(event.x - dragStartX, 2) + Math.pow(event.y - dragStartY, 2)
            );

            if (distance < 5) {
                // It was a click, not a drag
                console.log('Node clicked:', d);
                event.sourceEvent.stopPropagation();
                openPanel(d);
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

        // Initial view - fit entire graph to screen
        function fitToScreen() {
            // Get fresh container dimensions (important if container has resized)
            const container = document.getElementById('graph');
            const width = container.clientWidth;
            const height = container.clientHeight;

            const bounds = g.node().getBBox();
            const fullWidth = bounds.width;
            const fullHeight = bounds.height;
            const midX = bounds.x + fullWidth / 2;
            const midY = bounds.y + fullHeight / 2;

            if (fullWidth === 0 || fullHeight === 0) return;

            // Add padding (0.9 uses 90% of available space, leaving 10% padding)
            const scale = 0.9 / Math.max(fullWidth / width, fullHeight / height);
            const translate = [width / 2 - scale * midX, height / 2 - scale * midY];

            svg.transition().duration(500).call(
                zoom.transform,
                d3.zoomIdentity.translate(translate[0], translate[1]).scale(scale)
            );
        }

        // Fit to screen on initial load
        setTimeout(() => fitToScreen(), 100);

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
            const incomingEdges = graphData.edges.filter(e => e.target === nodeData.id);
            if (incomingEdges.length > 0) {
                incoming.innerHTML = incomingEdges.map(edge => {
                    const sourceNode = graphData.nodes.find(n => n.id === edge.source);
                    const fileName = edge.sourceLocation?.file?.split('/').pop() || '';
                    const location = edge.sourceLocation ? \`\${fileName}:\${edge.sourceLocation.line}\` : '';
                    return \`
                        <div style="margin: 8px 0; padding: 8px; background: var(--vscode-input-background); border-radius: 4px;">
                            <div style="display: flex; align-items: center; gap: 8px; margin-bottom: 4px;">
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
            const outgoingEdges = graphData.edges.filter(e => e.source === nodeData.id);
            if (outgoingEdges.length > 0) {
                outgoing.innerHTML = outgoingEdges.map(edge => {
                    const targetNode = graphData.nodes.find(n => n.id === edge.target);
                    const fileName = edge.sourceLocation?.file?.split('/').pop() || '';
                    const location = edge.sourceLocation ? \`\${fileName}:\${edge.sourceLocation.line}\` : '';
                    return \`
                        <div style="margin: 8px 0; padding: 8px; background: var(--vscode-input-background); border-radius: 4px;">
                            <div style="display: flex; align-items: center; gap: 8px; margin-bottom: 4px;">
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
        }

        function closePanel() {
            const panel = document.getElementById('sidePanel');
            panel.classList.remove('open');
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
