import * as vscode from 'vscode';
import { WorkflowGraph } from './api';
import { ViewState } from './copilot/types';
import { webviewStyles } from './webview/styles';
import { getHtmlTemplate, LoadingOptions } from './webview/template';
import { loadScripts } from './webview/script-loader';
import { getNodeIcon } from './webview/icons';
import { snapToGrid, intersectRect, colorFromString } from './webview/utils';

export class WebviewManager {
    private panel: vscode.WebviewPanel | undefined;
    private viewState: ViewState = {
        selectedNodeId: null,
        expandedWorkflowIds: [],
        lastUpdated: Date.now()
    };

    constructor(private context: vscode.ExtensionContext) {}

    private getIconPath() {
        return {
            light: vscode.Uri.joinPath(this.context.extensionUri, 'media', 'icon-dark.svg'),
            dark: vscode.Uri.joinPath(this.context.extensionUri, 'media', 'icon-light.svg')
        };
    }

    getViewState(): ViewState | null {
        return this.panel ? this.viewState : null;
    }

    updateViewState(update: Partial<ViewState>) {
        this.viewState = {
            ...this.viewState,
            ...update,
            lastUpdated: Date.now()
        };
    }

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

    private setupMessageHandlers() {
        if (!this.panel) return;

        this.panel.webview.onDidReceiveMessage(
            async (message) => {
                if (message.command === 'openFile') {
                    try {
                        const filePath = message.file;

                        // Validate file path
                        if (!filePath || typeof filePath !== 'string') {
                            vscode.window.showErrorMessage(`Invalid file path: ${filePath}`);
                            return;
                        }

                        // Must be absolute path starting with /
                        if (!filePath.startsWith('/')) {
                            vscode.window.showErrorMessage(`File path must be absolute: ${filePath}`);
                            return;
                        }

                        const fileUri = vscode.Uri.file(filePath);
                        const document = await vscode.workspace.openTextDocument(fileUri);
                        const editor = await vscode.window.showTextDocument(document, vscode.ViewColumn.One);

                        const line = message.line - 1;
                        const range = new vscode.Range(line, 0, line, 0);
                        editor.selection = new vscode.Selection(range.start, range.end);
                        editor.revealRange(range, vscode.TextEditorRevealType.InCenter);
                    } catch (error: any) {
                        vscode.window.showErrorMessage(`Could not open file: ${error.message}`);
                    }
                } else if (message.command === 'refreshAnalysis') {
                    vscode.commands.executeCommand('codag.refresh');
                } else if (message.command === 'exportFile') {
                    this.handleExport(message);
                } else if (message.command === 'nodeSelected') {
                    this.updateViewState({
                        selectedNodeId: message.nodeId,
                        selectedNodeLabel: message.nodeLabel,
                        selectedNodeType: message.nodeType
                    });
                } else if (message.command === 'nodeDeselected') {
                    this.updateViewState({
                        selectedNodeId: null,
                        selectedNodeLabel: undefined,
                        selectedNodeType: undefined
                    });
                } else if (message.command === 'workflowVisibilityChanged') {
                    this.updateViewState({
                        expandedWorkflowIds: message.expandedWorkflowIds || []
                    });
                } else if (message.command === 'viewportChanged') {
                    this.updateViewState({
                        visibleNodeIds: message.visibleNodeIds || []
                    });
                }
            },
            undefined,
            this.context.subscriptions
        );
    }

    showLoading(message: string) {
        // Create panel if needed
        if (!this.panel) {
            this.panel = vscode.window.createWebviewPanel(
                'codag',
                'Codag',
                vscode.ViewColumn.Beside,
                {
                    enableScripts: true,
                    retainContextWhenHidden: true
                }
            );

            this.panel.iconPath = this.getIconPath();

            this.panel.onDidDispose(() => {
                this.panel = undefined;
            });

            this.setupMessageHandlers();

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
            this.panel.webview.postMessage({
                command: 'updateGraph',
                graph,
                preserveState: true
            });
        }
    }

    showProgressOverlay(message: string) {
        if (this.panel) {
            this.panel.webview.postMessage({ command: 'showProgressOverlay', text: message });
        }
    }

    hideProgressOverlay() {
        if (this.panel) {
            this.panel.webview.postMessage({ command: 'hideProgressOverlay' });
        }
    }

    private async handleExport(message: { format: string; data: string; filename: string }) {
        const filters: { [key: string]: string[] } = {
            svg: ['SVG Files'],
            png: ['PNG Images'],
            md: ['Markdown Files']
        };

        const extensions: { [key: string]: string[] } = {
            svg: ['svg'],
            png: ['png'],
            md: ['md']
        };

        const uri = await vscode.window.showSaveDialog({
            defaultUri: vscode.Uri.file(message.filename),
            filters: { [filters[message.format]?.[0] || 'All Files']: extensions[message.format] || ['*'] }
        });

        if (uri) {
            try {
                let content: Uint8Array;

                if (message.format === 'png') {
                    // PNG is base64 encoded
                    const base64Data = message.data.replace(/^data:image\/png;base64,/, '');
                    content = Buffer.from(base64Data, 'base64');
                } else {
                    // SVG and MD are plain text
                    content = Buffer.from(message.data, 'utf-8');
                }

                await vscode.workspace.fs.writeFile(uri, content);
                vscode.window.showInformationMessage(`Exported to ${uri.fsPath}`);
            } catch (error: any) {
                vscode.window.showErrorMessage(`Export failed: ${error.message}`);
            }
        }
    }

    focusNode(nodeId: string) {
        if (this.panel) {
            this.panel.reveal();
            this.panel.webview.postMessage({ command: 'focusNode', nodeId });
        }
    }

    show(graph: WorkflowGraph, loadingOptions?: LoadingOptions) {
        if (this.panel) {
            this.panel.reveal();
            this.panel.webview.html = this.getHtml(graph, loadingOptions);
            return;
        } else {
            this.panel = vscode.window.createWebviewPanel(
                'codag',
                'Codag',
                vscode.ViewColumn.Beside,
                {
                    enableScripts: true,
                    retainContextWhenHidden: true
                }
            );

            this.panel.iconPath = this.getIconPath();

            this.panel.onDidDispose(() => {
                this.panel = undefined;
            });

            this.setupMessageHandlers();
        }

        this.panel.webview.html = this.getHtml(graph, loadingOptions);
    }

    private getHtml(graph: WorkflowGraph, loadingOptions?: LoadingOptions): string {
        // Properly build HTML string with safe JSON stringification
        let graphJson: string;
        try {
            graphJson = JSON.stringify(graph);
        } catch (error) {
            console.error('Failed to stringify graph:', error);
            graphJson = '{}';
        }

        // Build the main renderer script (everything after workflow detection)
        const mainRendererScript = `
        // Helper function to count how many workflows contain a node
        function getNodeWorkflowCount(nodeId) {
            return workflowGroups.filter(g => g.nodes.includes(nodeId)).length;
        }

        // Helper function to check if node is in a specific workflow
        function isNodeInWorkflow(nodeId, workflowId) {
            const workflow = workflowGroups.find(g => g.id === workflowId);
            return workflow ? workflow.nodes.includes(nodeId) : false;
        }

        // Helper function to generate curved path for cross-workflow edges
        function generateEdgePath(edge, sourceNode, targetNode, targetWidth = 140, targetHeight = 70) {
            // Validate nodes exist and have valid coordinates
            if (!sourceNode || !targetNode ||
                typeof sourceNode.x !== 'number' || typeof sourceNode.y !== 'number' ||
                typeof targetNode.x !== 'number' || typeof targetNode.y !== 'number' ||
                isNaN(sourceNode.x) || isNaN(sourceNode.y) ||
                isNaN(targetNode.x) || isNaN(targetNode.y)) {
                console.warn(\`Invalid edge coordinates for \${edge.source} -> \${edge.target}\`);
                return '';
            }

            // Check if this is a cross-workflow edge
            const sourceGroup = workflowGroups.find(g => g.nodes.includes(edge.source));
            const targetGroup = workflowGroups.find(g => g.nodes.includes(edge.target));
            const isCrossWorkflow = sourceGroup && targetGroup && sourceGroup.id !== targetGroup.id;

            const intersection = intersectRect(sourceNode, targetNode, targetWidth, targetHeight);

            if (isCrossWorkflow) {
                // Generate smooth quadratic Bézier curve for cross-workflow edges
                const midY = (sourceNode.y + intersection.y) / 2;
                // Control point at vertical midpoint to create smooth curve
                return 'M' + sourceNode.x + ',' + sourceNode.y + ' Q' + sourceNode.x + ',' + midY + ' ' + intersection.x + ',' + intersection.y;
            } else {
                // Straight line for within-workflow edges
                return 'M' + sourceNode.x + ',' + sourceNode.y + ' L' + intersection.x + ',' + intersection.y;
            }
        }

        const container = document.getElementById('graph');
        const width = container.clientWidth;
        const height = container.clientHeight;

        const svg = d3.select('#graph')
            .append('svg')
            .attr('width', '100%')
            .attr('height', '100%');

        // Create defs for patterns and markers
        const defs = svg.append('defs');

        // Fine pegboard dot pattern - 5px grid for normal zoom
        const finePattern = defs.append('pattern')
            .attr('id', 'pegboard-fine')
            .attr('x', 0)
            .attr('y', 0)
            .attr('width', 5)
            .attr('height', 5)
            .attr('patternUnits', 'userSpaceOnUse');

        finePattern.append('circle')
            .attr('id', 'pegboard-fine-dot')
            .attr('cx', 2.5)
            .attr('cy', 2.5)
            .attr('r', 0.5)
            .attr('fill', 'var(--vscode-editor-foreground)')
            .attr('opacity', 0.15);

        // Coarse pegboard dot pattern - 20px grid for zoomed out view
        const coarsePattern = defs.append('pattern')
            .attr('id', 'pegboard-coarse')
            .attr('x', 0)
            .attr('y', 0)
            .attr('width', 20)
            .attr('height', 20)
            .attr('patternUnits', 'userSpaceOnUse');

        coarsePattern.append('circle')
            .attr('id', 'pegboard-coarse-dot')
            .attr('cx', 10)
            .attr('cy', 10)
            .attr('r', 1)
            .attr('fill', 'var(--vscode-editor-foreground)')
            .attr('opacity', 0.15);

        // Main group for all graph elements (zoomable, includes pegboard)
        const g = svg.append('g');

        // Add pegboard background inside transform group (zooms/pans with content)
        // Make it large enough to cover entire viewport at any zoom level
        const pegboardBg = g.append('rect')
            .attr('x', -50000)
            .attr('y', -50000)
            .attr('width', 100000)
            .attr('height', 100000)
            .attr('fill', 'url(#pegboard-fine)')
            .attr('class', 'pegboard-bg')
            .lower(); // Send to back

        // Cache pegboard dot selections for performance (avoid DOM queries on every zoom tick)
        const finePatternDot = d3.select('#pegboard-fine-dot');
        const coarsePatternDot = d3.select('#pegboard-coarse-dot');

        // Create zoom behavior (disable double-click zoom)
        const zoom = d3.zoom()
            .scaleExtent([0.1, 10])
            .on('zoom', (event) => {
                g.attr('transform', event.transform);

                // Adaptive pegboard: adjust opacity and pattern based on zoom
                const k = event.transform.k;
                const opacity = Math.min(0.15, Math.max(0.02, 0.15 * k));

                if (k < 0.5) {
                    // Switch to coarse grid at low zoom
                    pegboardBg.attr('fill', 'url(#pegboard-coarse)');
                    coarsePatternDot.attr('opacity', opacity);
                } else {
                    // Use fine grid at normal zoom
                    pegboardBg.attr('fill', 'url(#pegboard-fine)');
                    finePatternDot.attr('opacity', opacity);
                }
            });

        svg.call(zoom).on('dblclick.zoom', null);

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

        // Simple approach: Layout each workflow independently and stack vertically
        // This eliminates the need for complex overlap detection/resolution
        const originalPositions = new Map();
        let currentYOffset = 0;
        const workflowSpacing = 150;  // Vertical spacing between workflows

        workflowGroups.forEach((group, idx) => {
            // Get ALL nodes in this workflow (including shared nodes)
            const allGroupNodes = currentGraphData.nodes.filter(n =>
                group.nodes.includes(n.id)
            );

            // Get ONLY exclusive nodes (for bounds calculation to prevent overlap)
            const exclusiveGroupNodes = allGroupNodes.filter(n =>
                getNodeWorkflowCount(n.id) === 1
            );

            // Skip groups with less than 3 nodes total
            if (allGroupNodes.length < 3) return;

            // Create separate Dagre graph for this workflow
            const dagreGraph = new dagre.graphlib.Graph();
            dagreGraph.setGraph({
                rankdir: 'LR',      // Left to right
                nodesep: 50,        // Vertical spacing between nodes in same rank
                ranksep: 100,       // Horizontal spacing between ranks
                marginx: 30,        // Left/right margins
                marginy: 30         // Top/bottom margins
            });
            dagreGraph.setDefaultEdgeLabel(() => ({}));

            // Add ALL nodes to Dagre (including shared) for proper layout
            allGroupNodes.forEach(node => {
                dagreGraph.setNode(node.id, { width: 140, height: 70 });
            });

            // Add only edges between nodes in this workflow
            currentGraphData.edges.forEach(edge => {
                if (group.nodes.includes(edge.source) && group.nodes.includes(edge.target)) {
                    dagreGraph.setEdge(edge.source, edge.target);
                }
            });

            // Layout this workflow
            dagre.layout(dagreGraph);

            // Apply positions to ALL nodes (including shared) with Y offset
            allGroupNodes.forEach(node => {
                const pos = dagreGraph.node(node.id);
                // Validate position - fallback to (0,0) if undefined or NaN
                if (!pos || typeof pos.x !== 'number' || typeof pos.y !== 'number' ||
                    isNaN(pos.x) || isNaN(pos.y)) {
                    console.warn('Invalid position for node ' + node.id + ' (' + node.label + '), using fallback');
                    node.x = 0;
                    node.y = currentYOffset;
                } else {
                    node.x = snapToGrid(pos.x);
                    node.y = snapToGrid(pos.y + currentYOffset);
                }
                node.fx = node.x;
                node.fy = node.y;
                originalPositions.set(node.id, { x: node.x, y: node.y });
            });

            // Calculate bounds ONLY from exclusive nodes (prevents overlap)
            // Shared nodes are positioned but don't affect bounds
            if (exclusiveGroupNodes.length === 0) {
                // All nodes are shared - skip this workflow's bounds
                console.warn('Workflow "' + group.name + '" has only shared nodes, skipping bounds calculation');
                return;
            }

            const xs = exclusiveGroupNodes.map(n => n.x);
            const ys = exclusiveGroupNodes.map(n => n.y);

            group.bounds = {
                minX: Math.min(...xs) - 90,  // Node half-width (70) + margin (20)
                maxX: Math.max(...xs) + 90,  // Node half-width (70) + margin (20)
                minY: Math.min(...ys) - 75,  // Node half-height (35) + margin (40 for title)
                maxY: Math.max(...ys) + 55   // Node half-height (35) + margin (20)
            };

            // Calculate center for collapsed state
            group.centerX = (group.bounds.minX + group.bounds.maxX) / 2;
            group.centerY = (group.bounds.minY + group.bounds.maxY) / 2;

            // Update Y offset for next workflow
            currentYOffset = group.bounds.maxY + workflowSpacing;
        });

        // Create colored dot patterns for each workflow group
        workflowGroups.forEach((group, idx) => {
            const colorPattern = defs.append('pattern')
                .attr('id', 'pegboard-' + group.id)
                .attr('x', 0)
                .attr('y', 0)
                .attr('width', 10)
                .attr('height', 10)
                .attr('patternUnits', 'userSpaceOnUse');

            colorPattern.append('circle')
                .attr('cx', 5)
                .attr('cy', 5)
                .attr('r', 1)
                .attr('fill', group.color)
                .attr('opacity', 0.25);
        });

        // Render group containers (borders for expanded, aggregate for collapsed)
        const groupContainer = g.append('g')
            .attr('class', 'groups');

        // Filter out groups without bounds (empty groups) and workflows with < 3 nodes
        const groupsWithBounds = workflowGroups.filter(g => g.bounds && g.nodes.length >= 3);

        // Check for duplicate group IDs
        const groupIds = groupsWithBounds.map(g => g.id);
        const duplicates = groupIds.filter((id, index) => groupIds.indexOf(id) !== index);
        if (duplicates.length > 0) {
            console.warn('Duplicate workflow group IDs found:', duplicates);
        }

        const groupElements = groupContainer.selectAll('.workflow-group')
            .data(groupsWithBounds, d => d.id)
            .enter()
            .append('g')
            .attr('class', 'workflow-group')
            .attr('data-group-id', d => d.id);

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
            .attr('y', d => d.bounds.minY + 24)
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

                return generateEdgePath(l, sourceNode, targetNode, targetWidth, targetHeight);
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

                return generateEdgePath(l, sourceNode, targetNode, targetWidth, targetHeight);
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

            // Notify extension of workflow visibility state
            const expandedWorkflowIds = workflowGroups
                .filter(g => !g.collapsed && g.id !== 'group_orphans')
                .map(g => g.name);

            vscode.postMessage({
                command: 'workflowVisibilityChanged',
                expandedWorkflowIds: expandedWorkflowIds
            });
        }

        // Filter nodes to only render those in workflow groups WITH 3+ NODES
        const allWorkflowNodeIds = new Set();
        workflowGroups.forEach(g => {
            if (g.nodes.length >= 3) {
                g.nodes.forEach(id => allWorkflowNodeIds.add(id));
            }
        });
        const nodesToRender = currentGraphData.nodes.filter(n => allWorkflowNodeIds.has(n.id));

        // Filter edges to only those where BOTH nodes are rendered
        const nodesToRenderIds = new Set(nodesToRender.map(n => n.id));
        const edgesToRender = currentGraphData.edges.filter(e =>
            nodesToRenderIds.has(e.source) && nodesToRenderIds.has(e.target)
        );

        // Create two separate containers: one for edge paths, one for edge labels
        // This ensures ALL edges are drawn beneath ALL labels
        const edgePathsContainer = g.append('g').attr('class', 'edge-paths-container');
        const edgeLabelsContainer = g.append('g').attr('class', 'edge-labels-container');

        // Create edge path groups (for paths only, filtered to rendered nodes)
        const linkGroup = edgePathsContainer
            .selectAll('g')
            .data(edgesToRender)
            .enter()
            .append('g')
            .attr('class', 'link-group')
            .attr('data-edge-key', d => d.source + '->' + d.target);

        const link = linkGroup.append('path')
            .attr('class', d => d.isCriticalPath ? 'link critical-path' : 'link')
            .attr('marker-end', 'url(#arrowhead)');

        // Create edge label groups (separate from paths, rendered on top, filtered)
        const linkLabelGroup = edgeLabelsContainer
            .selectAll('g')
            .data(edgesToRender)
            .enter()
            .append('g')
            .attr('class', 'link-label-group')
            .attr('data-edge-key', d => d.source + '->' + d.target);

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
                const index = edgesToRender.indexOf(d);
                const linkElement = d3.select(edgePathsContainer.node().children[index]).select('.link');
                const labelElement = d3.select(edgeLabelsContainer.node().children[index]).select('.link-label');
                const labelBgElement = d3.select(edgeLabelsContainer.node().children[index]).select('.link-label-bg');

                if (d.isCriticalPath) {
                    linkElement.style('stroke', '#FF9999').style('stroke-width', '5px');
                    labelElement.style('font-weight', 'bold').style('fill', '#ffffff');
                    labelBgElement.style('fill', '#FF9999').style('fill-opacity', '1');
                } else {
                    linkElement.style('stroke', '#00d9ff').style('stroke-width', '3px');
                    labelElement.style('font-weight', 'bold').style('fill', '#ffffff');
                    labelBgElement.style('fill', '#00d9ff').style('fill-opacity', '1');
                }

                // Show tooltip at edge midpoint
                const tooltip = document.getElementById('edgeTooltip');
                tooltip.innerHTML =
                    '<div><strong>Variable:</strong> ' + (d.label || 'N/A') + '</div>' +
                    (d.dataType ? '<div><strong>Type:</strong> ' + d.dataType + '</div>' : '') +
                    (d.description ? '<div><strong>Description:</strong> ' + d.description + '</div>' : '') +
                    (d.sourceLocation ? '<div><strong>Location:</strong> <a href="#" class="source-link" data-file="' + d.sourceLocation.file + '" data-line="' + d.sourceLocation.line + '" onclick="event.preventDefault(); vscode.postMessage({command: \\'openFile\\', file: this.dataset.file, line: parseInt(this.dataset.line)});">' + d.sourceLocation.file.split('/').pop() + ':' + d.sourceLocation.line + '</a></div>' : '');

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
                const index = edgesToRender.indexOf(d);
                const linkElement = d3.select(edgePathsContainer.node().children[index]).select('.link');
                const labelElement = d3.select(edgeLabelsContainer.node().children[index]).select('.link-label');
                const labelBgElement = d3.select(edgeLabelsContainer.node().children[index]).select('.link-label-bg');

                if (d.isCriticalPath) {
                    linkElement.style('stroke', '#FF6B6B').style('stroke-width', '4px');
                    labelElement.style('font-weight', null).style('fill', null);
                    labelBgElement.style('fill', null).style('fill-opacity', null);
                } else {
                    linkElement.style('stroke', null).style('stroke-width', null);
                    labelElement.style('font-weight', null).style('fill', null);
                    labelBgElement.style('fill', null).style('fill-opacity', null);
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

        // Create nodes (only those in workflows)
        const node = g.append('g')
            .attr('class', 'nodes-container')
            .selectAll('g')
            .data(nodesToRender)
            .enter()
            .append('g')
            .attr('class', 'node')
            .attr('data-node-id', d => d.id)
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
            .style('opacity', 0.5)
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
            .attr('y', -21)
            .attr('dominant-baseline', 'middle')
            .each(function(d) {
                const maxWidth = 110; // Conservative width accounting for icon + padding
                const minFontSize = 8; // Minimum readable font size
                const currentFontSize = 13; // From CSS

                // Set initial text
                d3.select(this).text(d.label);
                let textLength = this.getComputedTextLength();

                if (textLength > maxWidth) {
                    // Try scaling font down
                    const scale = maxWidth / textLength;
                    let newFontSize = Math.max(minFontSize, currentFontSize * scale);
                    d3.select(this).style('font-size', newFontSize + 'px');

                    // Re-measure after scaling
                    textLength = this.getComputedTextLength();

                    // If still too long at minimum font size, truncate with ellipsis
                    if (textLength > maxWidth && newFontSize === minFontSize) {
                        let text = d.label;
                        while (textLength > maxWidth && text.length > 3) {
                            text = text.slice(0, -1);
                            d3.select(this).text(text + '...');
                            textLength = this.getComputedTextLength();
                        }
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
        const cornerOffsetX = 78; // Distance from center to corner start (horizontal)
        const cornerOffsetY = 42; // Distance from center to corner start (vertical)
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
            return generateEdgePath(d, sourceNode, targetNode);
        });

        linkHover.attr('d', d => {
            const sourceNode = currentGraphData.nodes.find(n => n.id === d.source);
            const targetNode = currentGraphData.nodes.find(n => n.id === d.target);
            return generateEdgePath(d, sourceNode, targetNode);
        });

        // Position label groups
        linkLabelGroup.attr('transform', d => {
            const sourceNode = currentGraphData.nodes.find(n => n.id === d.source);
            const targetNode = currentGraphData.nodes.find(n => n.id === d.target);
            if (!sourceNode || !targetNode ||
                typeof sourceNode.x !== 'number' || typeof sourceNode.y !== 'number' ||
                typeof targetNode.x !== 'number' || typeof targetNode.y !== 'number' ||
                isNaN(sourceNode.x) || isNaN(sourceNode.y) ||
                isNaN(targetNode.x) || isNaN(targetNode.y)) {
                return 'translate(0,0)';
            }
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
                const index = edgesToRender.indexOf(d);
                const linkElement = d3.select(edgePathsContainer.node().children[index]).select('.link');
                const labelElement = d3.select(edgeLabelsContainer.node().children[index]).select('.link-label');
                const labelBgElement = d3.select(edgeLabelsContainer.node().children[index]).select('.link-label-bg');

                if (d.isCriticalPath) {
                    linkElement.style('stroke', '#FF9999').style('stroke-width', '5px');
                    labelElement.style('font-weight', 'bold').style('fill', '#ffffff');
                    labelBgElement.style('fill', '#FF9999').style('fill-opacity', '1');
                } else {
                    linkElement.style('stroke', '#00d9ff').style('stroke-width', '3px');
                    labelElement.style('font-weight', 'bold').style('fill', '#ffffff');
                    labelBgElement.style('fill', '#00d9ff').style('fill-opacity', '1');
                }

                // Show tooltip
                const tooltip = document.getElementById('edgeTooltip');
                tooltip.innerHTML = '<div><strong>Variable:</strong> ' + (d.label || 'N/A') + '</div>' +
                    (d.dataType ? '<div><strong>Type:</strong> ' + d.dataType + '</div>' : '') +
                    (d.description ? '<div><strong>Description:</strong> ' + d.description + '</div>' : '') +
                    (d.sourceLocation ? '<div><strong>Location:</strong> <a href="#" class="source-link" data-file="' + d.sourceLocation.file + '" data-line="' + d.sourceLocation.line + '" onclick="event.preventDefault(); vscode.postMessage({command: \\'openFile\\', file: this.dataset.file, line: parseInt(this.dataset.line)});">' + d.sourceLocation.file.split('/').pop() + ':' + d.sourceLocation.line + '</a></div>' : '');

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
                const index = edgesToRender.indexOf(d);
                const linkElement = d3.select(edgePathsContainer.node().children[index]).select('.link');
                const labelElement = d3.select(edgeLabelsContainer.node().children[index]).select('.link-label');
                const labelBgElement = d3.select(edgeLabelsContainer.node().children[index]).select('.link-label-bg');

                if (d.isCriticalPath) {
                    linkElement.style('stroke', '#FF6B6B').style('stroke-width', '4px');
                    labelElement.style('font-weight', null).style('fill', null);
                    labelBgElement.style('fill', null).style('fill-opacity', null);
                } else {
                    linkElement.style('stroke', null).style('stroke-width', null);
                    labelElement.style('font-weight', null).style('fill', null);
                    labelBgElement.style('fill', null).style('fill-opacity', null);
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
            .data(groupsWithBounds, d => d.id)
            .enter()
            .append('g')
            .attr('class', 'collapsed-group-node')
            .attr('data-group-id', d => d.id)
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

            // Update connected edges (using collapsed group routing and curved cross-workflow paths)
            link.attr('d', function(l) {
                const sourceNode = getNodeOrCollapsedGroup(l.source);
                const targetNode = getNodeOrCollapsedGroup(l.target);
                const targetWidth = targetNode?.isCollapsedGroup ? 260 : 140;
                const targetHeight = targetNode?.isCollapsedGroup ? 130 : 70;
                return generateEdgePath(l, sourceNode, targetNode, targetWidth, targetHeight);
            });

            linkHover.attr('d', function(l) {
                const sourceNode = getNodeOrCollapsedGroup(l.source);
                const targetNode = getNodeOrCollapsedGroup(l.target);
                const targetWidth = targetNode?.isCollapsedGroup ? 260 : 140;
                const targetHeight = targetNode?.isCollapsedGroup ? 130 : 70;
                return generateEdgePath(l, sourceNode, targetNode, targetWidth, targetHeight);
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

                    if (sourceNode && targetNode &&
                        !isNaN(sourceNode.x) && !isNaN(sourceNode.y) &&
                        !isNaN(targetNode.x) && !isNaN(targetNode.y)) {
                        edge.attr('x1', toMinimapX(sourceNode.x))
                            .attr('y1', toMinimapY(sourceNode.y))
                            .attr('x2', toMinimapX(targetNode.x))
                            .attr('y2', toMinimapY(targetNode.y));
                    }
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
                // It was a click, not a drag - stop propagation to prevent SVG click from closing panel
                if (event.sourceEvent) {
                    event.sourceEvent.stopPropagation();
                    event.sourceEvent.preventDefault();
                }

                // Toggle panel if clicking the same node
                if (currentlyOpenNodeId === d.id) {
                    closePanel();
                } else {
                    openPanel(d);
                }
            } else {
                // It was a drag - update minimap with new node positions
                renderMinimap();
            }
        }

        // Refresh analysis (bypasses cache)
        function refreshAnalysis() {
            console.log('refreshAnalysis button clicked');
            vscode.postMessage({ command: 'refreshAnalysis' });
        }
        window.refreshAnalysis = refreshAnalysis;

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
        window.toggleExpandAll = toggleExpandAll;

        // Format graph (reset to original layout)
        function formatGraph() {
            console.log('formatGraph button clicked');
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
                // Skip workflows with < 3 nodes (they aren't rendered)
                if (group.nodes.length < 3) return;

                // Filter out shared nodes (only include exclusive nodes for bounds)
                const groupNodes = currentGraphData.nodes.filter(n =>
                    group.nodes.includes(n.id) && getNodeWorkflowCount(n.id) === 1
                );
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

            // Update bounding box positions with smooth transition (only groups with valid bounds)
            svg.selectAll('.group-background')
                .filter(d => d.bounds && !isNaN(d.bounds.minX))
                .transition()
                .duration(500)
                .attr('x', d => d.bounds.minX)
                .attr('y', d => d.bounds.minY)
                .attr('width', d => d.bounds.maxX - d.bounds.minX)
                .attr('height', d => d.bounds.maxY - d.bounds.minY);

            // Update bounding box title positions
            svg.selectAll('.group-title-expanded')
                .filter(d => d.bounds && !isNaN(d.bounds.minX))
                .transition()
                .duration(500)
                .attr('x', d => d.bounds.minX + 40)
                .attr('y', d => d.bounds.minY + 24);

            // Update collapse button positions
            svg.selectAll('.group-collapse-btn rect')
                .filter(d => d.bounds && !isNaN(d.bounds.minX))
                .transition()
                .duration(500)
                .attr('x', d => d.bounds.minX + 10)
                .attr('y', d => d.bounds.minY + 8);

            svg.selectAll('.group-collapse-btn text')
                .filter(d => d.bounds && !isNaN(d.bounds.minX))
                .transition()
                .duration(500)
                .attr('x', d => d.bounds.minX + 22)
                .attr('y', d => d.bounds.minY + 24);

            // Update collapsed group positions (only groups with valid centers)
            svg.selectAll('.collapsed-group-node rect')
                .filter(d => !isNaN(d.centerX) && !isNaN(d.centerY))
                .transition()
                .duration(500)
                .attr('x', d => d.centerX - 130)
                .attr('y', d => d.centerY - 65);

            // Update collapsed group text positions (3 text elements per group, only with valid centers)
            svg.selectAll('.collapsed-group-node')
                .filter(d => !isNaN(d.centerX) && !isNaN(d.centerY))
                .each(function(d) {
                    const group = d3.select(this);
                    const texts = group.selectAll('text').nodes();

                    // Title (first text)
                    if (texts[0]) {
                        d3.select(texts[0])
                            .transition()
                            .duration(500)
                            .attr('x', d.centerX)
                            .attr('y', d.centerY - 20);
                    }

                    // Node count (second text)
                    if (texts[1]) {
                        d3.select(texts[1])
                            .transition()
                            .duration(500)
                            .attr('x', d.centerX)
                            .attr('y', d.centerY + 5);
                    }

                    // "Click to expand" (third text)
                    if (texts[2]) {
                        d3.select(texts[2])
                            .transition()
                            .duration(500)
                            .attr('x', d.centerX)
                            .attr('y', d.centerY + 30);
                    }
                });

            // Update node positions with smooth transition (only nodes with valid positions)
            svg.selectAll('.node')
                .filter(d => !isNaN(d.x) && !isNaN(d.y))
                .transition()
                .duration(500)
                .attr('transform', d => \`translate(\${d.x},\${d.y})\`);

            // Update edge positions (smooth transition) with curved cross-workflow edges
            svg.selectAll('.link').transition().duration(500)
                .attr('d', function(l) {
                    const sourceNode = getNodeOrCollapsedGroup(l.source);
                    const targetNode = getNodeOrCollapsedGroup(l.target);
                    const targetWidth = targetNode?.isCollapsedGroup ? 260 : 140;
                    const targetHeight = targetNode?.isCollapsedGroup ? 130 : 70;
                    return generateEdgePath(l, sourceNode, targetNode, targetWidth, targetHeight);
                });

            svg.selectAll('.link-hover').transition().duration(500)
                .attr('d', function(l) {
                    const sourceNode = getNodeOrCollapsedGroup(l.source);
                    const targetNode = getNodeOrCollapsedGroup(l.target);
                    const targetWidth = targetNode?.isCollapsedGroup ? 260 : 140;
                    const targetHeight = targetNode?.isCollapsedGroup ? 130 : 70;
                    return generateEdgePath(l, sourceNode, targetNode, targetWidth, targetHeight);
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

            // Update minimap with new positions
            renderMinimap();
        }
        window.formatGraph = formatGraph;

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
        window.toggleLegend = toggleLegend;

        // Zoom controls
        function resetZoom() {
            fitToScreen();
        }
        window.resetZoom = resetZoom;

        function zoomIn() {
            svg.transition().duration(300).call(
                zoom.scaleBy,
                1.3
            );
        }
        window.zoomIn = zoomIn;

        function zoomOut() {
            svg.transition().duration(300).call(
                zoom.scaleBy,
                0.7
            );
        }
        window.zoomOut = zoomOut;

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
            const tooltips = ['Zoom In', 'Zoom Out', 'Fit to Screen', 'Expand/Collapse All Workflows', 'Reset Layout', 'Reanalyze Entire Workspace', 'Export as SVG', 'Export as PNG', 'Export as Markdown'];
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

            // Filter to only nodes with valid positions
            const nodesWithPositions = currentGraphData.nodes.filter(n => !isNaN(n.x) && !isNaN(n.y));
            if (nodesWithPositions.length === 0) return;

            const nodeWidth = 140;
            const nodeHeight = 70;
            const xs = nodesWithPositions.map(n => n.x);
            const ys = nodesWithPositions.map(n => n.y);
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

            // Calculate bounds from node positions (only nodes with valid positions)
            if (currentGraphData.nodes.length === 0) return;

            const nodesWithPositions = currentGraphData.nodes.filter(n => !isNaN(n.x) && !isNaN(n.y));
            if (nodesWithPositions.length === 0) return;

            const nodeWidth = 140;
            const nodeHeight = 70;
            const xs = nodesWithPositions.map(n => n.x);
            const ys = nodesWithPositions.map(n => n.y);
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

            // Render edges (only for nodes with valid positions)
            currentGraphData.edges.forEach(edge => {
                const sourceNode = currentGraphData.nodes.find(n => n.id === edge.source);
                const targetNode = currentGraphData.nodes.find(n => n.id === edge.target);

                if (sourceNode && targetNode &&
                    !isNaN(sourceNode.x) && !isNaN(sourceNode.y) &&
                    !isNaN(targetNode.x) && !isNaN(targetNode.y)) {
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

            // Render nodes with type-based coloring (only nodes with valid positions)
            currentGraphData.nodes.forEach(node => {
                if (!isNaN(node.x) && !isNaN(node.y)) {
                    minimapG.append('circle')
                        .attr('class', 'minimap-node ' + node.type)
                        .attr('cx', toMinimapX(node.x))
                        .attr('cy', toMinimapY(node.y))
                        .attr('r', 3)
                        .attr('data-node-id', node.id);
                }
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

            // Safety check: ensure all values exist and are valid
            if (scale === undefined || offsetX === undefined || offsetY === undefined ||
                minX === undefined || minY === undefined ||
                !isFinite(scale) || !isFinite(offsetX) || !isFinite(offsetY) ||
                !isFinite(minX) || !isFinite(minY)) {
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

        // Track visible nodes in viewport for Copilot context
        function updateVisibleNodes() {
            const container = document.getElementById('graph');
            const width = container.clientWidth;
            const height = container.clientHeight;
            const currentTransform = d3.zoomTransform(svg.node());

            // Calculate viewport bounds in graph coordinates
            const viewportX = -currentTransform.x / currentTransform.k;
            const viewportY = -currentTransform.y / currentTransform.k;
            const viewportWidth = width / currentTransform.k;
            const viewportHeight = height / currentTransform.k;

            const viewportBounds = {
                left: viewportX,
                right: viewportX + viewportWidth,
                top: viewportY,
                bottom: viewportY + viewportHeight
            };

            // Check which nodes intersect viewport (exclude collapsed nodes)
            const visibleNodeIds = currentGraphData.nodes
                .filter(node => {
                    // Skip nodes in collapsed groups
                    const inCollapsedGroup = workflowGroups.some(g => g.collapsed && g.nodes.includes(node.id));
                    if (inCollapsedGroup) return false;

                    // Node bounds (140x70, centered at x,y)
                    const nodeLeft = node.x - 70;
                    const nodeRight = node.x + 70;
                    const nodeTop = node.y - 35;
                    const nodeBottom = node.y + 35;

                    // Check for intersection (AABB collision)
                    return !(nodeRight < viewportBounds.left ||
                            nodeLeft > viewportBounds.right ||
                            nodeBottom < viewportBounds.top ||
                            nodeTop > viewportBounds.bottom);
                })
                .map(node => node.id);

            // Send to extension
            vscode.postMessage({
                command: 'viewportChanged',
                visibleNodeIds: visibleNodeIds
            });
        }

        // Debounced viewport tracking to avoid excessive messages during pan/zoom
        let viewportUpdateTimeout = null;
        const VIEWPORT_UPDATE_DELAY = 150; // ms

        function updateVisibleNodesDebounced() {
            if (viewportUpdateTimeout) {
                clearTimeout(viewportUpdateTimeout);
            }
            viewportUpdateTimeout = setTimeout(() => {
                updateVisibleNodes();
                viewportUpdateTimeout = null;
            }, VIEWPORT_UPDATE_DELAY);
        }

        // Update viewport on zoom/pan (throttled with requestAnimationFrame for performance)
        let minimapUpdatePending = false;
        zoom.on('zoom.minimap', (event) => {
            // Note: transform is already applied in main zoom handler, no need to duplicate
            if (!minimapUpdatePending) {
                minimapUpdatePending = true;
                requestAnimationFrame(() => {
                    updateMinimapViewport();
                    minimapUpdatePending = false;
                });
            }
            updateVisibleNodesDebounced();
        });

        // Fit to screen on initial load
        setTimeout(() => {
            // Reset layout to clean Dagre positions (fixes overlap resolution bugs)
            formatGraph();
            renderMinimap();
            fitToScreen();
            // Apply initial group collapse states
            updateGroupVisibility();
            // Set initial viewport state for Copilot
            updateVisibleNodes();
        }, 100);

        // Panel functions
        function openPanel(nodeData) {
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

            if (!panel || !title || !type || !sourceSection || !source || !descriptionSection || !description || !incomingSection || !incoming || !outgoingSection || !outgoing) {
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
                const funcName = nodeData.source.function.endsWith('()') ? nodeData.source.function : nodeData.source.function + '()';
                source.textContent = \`\${funcName} in \${fileName}:\${nodeData.source.line}\`;
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

            // Find incoming edges (only show edges where source node exists - filter orphaned nodes)
            const incomingEdges = currentGraphData.edges.filter(e => {
                if (e.target !== nodeData.id) return false;
                // Only include edge if source node exists in the graph
                return currentGraphData.nodes.some(n => n.id === e.source);
            });
            if (incomingEdges.length > 0) {
                incoming.innerHTML = incomingEdges.map(edge => {
                    const sourceNode = currentGraphData.nodes.find(n => n.id === edge.source);
                    const fileName = edge.sourceLocation?.file?.split('/').pop() || '';
                    const location = edge.sourceLocation ? \`\${fileName}:\${edge.sourceLocation.line}\` : '';
                    return '<div style="margin: 8px 0; padding: 8px; background: var(--vscode-input-background); border-radius: 4px;">' +
                        '<div style="display: flex; align-items: center; gap: 8px; margin-bottom: 4px; flex-wrap: wrap;">' +
                        (edge.sourceLocation ? '<a href="#" class="source-link incoming-data-link" data-file="' + edge.sourceLocation.file + '" data-line="' + edge.sourceLocation.line + '"><strong>' + edge.label + '</strong></a>' : '<strong>' + edge.label + '</strong>') +
                        (edge.dataType ? '<span style="font-size: 10px; padding: 2px 6px; background: var(--vscode-badge-background); color: var(--vscode-badge-foreground); border-radius: 3px;">' + edge.dataType + '</span>' : '') +
                        '</div>' +
                        '<div style="font-size: 11px; color: var(--vscode-descriptionForeground);">From: ' + (sourceNode ? sourceNode.label : edge.source) + '</div>' +
                        (edge.description ? '<div style="font-size: 11px; margin-top: 4px; font-style: italic;">' + edge.description + '</div>' : '') +
                        '</div>';
                }).join('');

                // Add event listeners to incoming data links
                incoming.querySelectorAll('.incoming-data-link').forEach((link, index) => {
                    const edge = incomingEdges[index];
                    link.onclick = (e) => {
                        e.preventDefault();
                        if (edge.sourceLocation) {
                            vscode.postMessage({
                                command: 'openFile',
                                file: edge.sourceLocation.file,
                                line: edge.sourceLocation.line
                            });
                        }
                    };
                });

                incomingSection.style.display = 'block';
            } else {
                incomingSection.style.display = 'none';
            }

            // Find outgoing edges (only show edges where target node exists - filter orphaned nodes)
            const outgoingEdges = currentGraphData.edges.filter(e => {
                if (e.source !== nodeData.id) return false;
                // Only include edge if target node exists in the graph
                return currentGraphData.nodes.some(n => n.id === e.target);
            });
            if (outgoingEdges.length > 0) {
                outgoing.innerHTML = outgoingEdges.map(edge => {
                    const targetNode = currentGraphData.nodes.find(n => n.id === edge.target);
                    const fileName = edge.sourceLocation?.file?.split('/').pop() || '';
                    const location = edge.sourceLocation ? \`\${fileName}:\${edge.sourceLocation.line}\` : '';
                    return '<div style="margin: 8px 0; padding: 8px; background: var(--vscode-input-background); border-radius: 4px;">' +
                        '<div style="display: flex; align-items: center; gap: 8px; margin-bottom: 4px; flex-wrap: wrap;">' +
                        (edge.sourceLocation ? '<a href="#" class="source-link outgoing-data-link" data-file="' + edge.sourceLocation.file + '" data-line="' + edge.sourceLocation.line + '"><strong>' + edge.label + '</strong></a>' : '<strong>' + edge.label + '</strong>') +
                        (edge.dataType ? '<span style="font-size: 10px; padding: 2px 6px; background: var(--vscode-badge-background); color: var(--vscode-badge-foreground); border-radius: 3px;">' + edge.dataType + '</span>' : '') +
                        '</div>' +
                        '<div style="font-size: 11px; color: var(--vscode-descriptionForeground);">To: ' + (targetNode ? targetNode.label : edge.target) + '</div>' +
                        (edge.description ? '<div style="font-size: 11px; margin-top: 4px; font-style: italic;">' + edge.description + '</div>' : '') +
                        '</div>';
                }).join('');

                // Add event listeners to outgoing data links
                outgoing.querySelectorAll('.outgoing-data-link').forEach((link, index) => {
                    const edge = outgoingEdges[index];
                    link.onclick = (e) => {
                        e.preventDefault();
                        if (edge.sourceLocation) {
                            vscode.postMessage({
                                command: 'openFile',
                                file: edge.sourceLocation.file,
                                line: edge.sourceLocation.line
                            });
                        }
                    };
                });

                outgoingSection.style.display = 'block';
            } else {
                outgoingSection.style.display = 'none';
            }

            console.log('Adding open class to panel');
            panel.classList.add('open');

            // Track currently open node
            currentlyOpenNodeId = nodeData.id;

            // Notify extension of selected node
            vscode.postMessage({
                command: 'nodeSelected',
                nodeId: nodeData.id,
                nodeLabel: nodeData.label,
                nodeType: nodeData.type
            });

            // Show selection indicator for this node
            d3.selectAll('.node-selection-indicator').style('display', 'none');
            d3.select('.node-selection-indicator[data-node-id="' + nodeData.id + '"]').style('display', 'block');
        }

        function closePanel() {
            const panel = document.getElementById('sidePanel');
            panel.classList.remove('open');

            // Clear currently open node
            currentlyOpenNodeId = null;

            // Notify extension of deselection
            vscode.postMessage({
                command: 'nodeDeselected'
            });

            // Hide all selection indicators
            d3.selectAll('.node-selection-indicator').style('display', 'none');
        }
        window.closePanel = closePanel;

        // Close panel when clicking outside (but not on nodes)
        svg.on('click', function(event) {
            // Only close if clicking on SVG or background g, not on child elements like nodes
            const target = event.target;
            if (target.tagName === 'svg' || target.tagName === 'rect' && target.classList.contains('pegboard-bg')) {
                closePanel();
            }
        });

        // === INCREMENTAL UPDATE FUNCTIONS ===

        // Capture current UI state before update
        function captureState() {
            return {
                zoomTransform: d3.zoomTransform(svg.node()),
                collapsedWorkflows: workflowGroups.filter(g => g.collapsed).map(g => g.id),
                selectedNodeId: currentlyOpenNodeId,
                nodePositions: new Map(currentGraphData.nodes.map(n => [n.id, { x: n.x, y: n.y, fx: n.fx, fy: n.fy }]))
            };
        }

        // Restore UI state after update
        function restoreState(savedState) {
            // Restore zoom transform
            svg.call(zoom.transform, savedState.zoomTransform);

            // Restore collapsed states
            workflowGroups.forEach(g => {
                g.collapsed = savedState.collapsedWorkflows.includes(g.id);
            });
            updateGroupVisibility();

            // Re-select node if it still exists
            if (savedState.selectedNodeId) {
                const node = currentGraphData.nodes.find(n => n.id === savedState.selectedNodeId);
                if (node) {
                    openPanel(node);
                } else {
                    closePanel();
                }
            }

            // Update minimap viewport
            updateMinimapViewport();
        }

        // Apply incremental DOM updates using D3 data-join pattern
        function applyIncrementalUpdate(diff, savedState) {
            console.log('[webview] Applying incremental update:', diff);

            // Preserve positions for existing nodes
            currentGraphData.nodes.forEach(n => {
                const pos = savedState.nodePositions.get(n.id);
                if (pos) {
                    n.x = pos.x;
                    n.y = pos.y;
                    n.fx = pos.fx;
                    n.fy = pos.fy;
                    originalPositions.set(n.id, { x: n.x, y: n.y });
                }
            });

            // Layout new nodes using Dagre
            if (diff.nodes.added.length > 0) {
                layoutNewNodes(diff.nodes.added);
            }

            // === REMOVE NODES ===
            diff.nodes.removed.forEach(nodeId => {
                g.select('.node[data-node-id="' + nodeId + '"]').remove();
            });

            // === UPDATE EXISTING NODES ===
            diff.nodes.updated.forEach(updatedNode => {
                const nodeEl = g.select('.node[data-node-id="' + updatedNode.id + '"]');
                if (!nodeEl.empty()) {
                    // Update label
                    nodeEl.select('.node-title').text(updatedNode.label);

                    // Update node classes for entry/exit/critical styling
                    const nodeRect = nodeEl.select('.node-background');
                    nodeRect.classed('entry-point', updatedNode.isEntryPoint || false);
                    nodeRect.classed('exit-point', updatedNode.isExitPoint || false);
                    nodeRect.classed('critical-path', updatedNode.isCriticalPath || false);
                }
            });

            // === ADD NEW NODES ===
            diff.nodes.added.forEach(newNode => {
                renderNode(newNode);
            });

            // === REMOVE EDGES ===
            diff.edges.removed.forEach(edge => {
                const edgeKey = edge.source + '->' + edge.target;
                // Remove from both path and label containers
                g.select('.edge-paths-container .link-group[data-edge-key="' + edgeKey + '"]').remove();
                g.select('.edge-labels-container .link-label-group[data-edge-key="' + edgeKey + '"]').remove();
            });

            // === UPDATE EXISTING EDGES ===
            diff.edges.updated.forEach(updatedEdge => {
                const edgeKey = updatedEdge.source + '->' + updatedEdge.target;
                const edgeEl = g.select('.edge-paths-container .link-group[data-edge-key="' + edgeKey + '"]');
                const labelEl = g.select('.edge-labels-container .link-label-group[data-edge-key="' + edgeKey + '"]');

                if (!edgeEl.empty()) {
                    // Update critical path styling
                    edgeEl.select('.link')
                        .classed('critical-path', updatedEdge.isCriticalPath || false);
                }

                if (!labelEl.empty()) {
                    // Update label text
                    labelEl.select('.link-label').text(updatedEdge.label || '');
                }
            });

            // === ADD NEW EDGES ===
            diff.edges.added.forEach(newEdge => {
                renderEdge(newEdge);
            });

            // Update all edge paths (positions may have changed)
            updateAllEdgePaths();

            // Recalculate bounds for workflows that need it (AFTER nodes have positions)
            recalculateWorkflowBounds(workflowGroups);

            // Update workflow group DOM elements (bounds may have changed)
            updateWorkflowGroups(workflowGroups);

            // Re-render minimap with updated data
            renderMinimap();
        }

        // Layout new nodes using Dagre within their workflow
        function layoutNewNodes(newNodes) {
            // Group new nodes by workflow
            const nodesByWorkflow = new Map();
            newNodes.forEach(newNode => {
                const workflow = workflowGroups.find(g => g.nodes.includes(newNode.id));
                const wfId = workflow ? workflow.id : '__orphan__';
                if (!nodesByWorkflow.has(wfId)) {
                    nodesByWorkflow.set(wfId, { workflow, nodes: [] });
                }
                nodesByWorkflow.get(wfId).nodes.push(newNode);
            });

            // Track vertical offset for positioning multiple workflows
            let workflowYOffset = 0;

            nodesByWorkflow.forEach(({ workflow, nodes: wfNewNodes }) => {
                if (!workflow) {
                    // Orphan nodes - stack vertically
                    const existingYs = currentGraphData.nodes
                        .filter(n => n.y !== undefined && !isNaN(n.y))
                        .map(n => n.y);
                    let offsetY = existingYs.length > 0 ? Math.max(...existingYs) + 150 : 0;

                    wfNewNodes.forEach(n => {
                        n.x = snapToGrid(200);
                        n.y = snapToGrid(offsetY);
                        n.fx = n.x;
                        n.fy = n.y;
                        offsetY += 150;
                        originalPositions.set(n.id, { x: n.x, y: n.y });
                    });
                    return;
                }

                // Check if workflow has ANY existing positioned nodes
                const existingPositionedNodes = workflow.nodes
                    .map(id => currentGraphData.nodes.find(n => n.id === id))
                    .filter(n => n && n.x !== undefined && !isNaN(n.x));

                if (existingPositionedNodes.length === 0) {
                    // ALL nodes are new - run full dagre layout for this workflow
                    const dagreGraph = new dagre.graphlib.Graph();
                    dagreGraph.setGraph({ rankdir: 'LR', nodesep: 50, ranksep: 100 });
                    dagreGraph.setDefaultEdgeLabel(() => ({}));

                    // Add all workflow nodes
                    workflow.nodes.forEach(nodeId => {
                        dagreGraph.setNode(nodeId, { width: 140, height: 70 });
                    });

                    // Add edges within workflow
                    currentGraphData.edges.forEach(edge => {
                        if (workflow.nodes.includes(edge.source) && workflow.nodes.includes(edge.target)) {
                            dagreGraph.setEdge(edge.source, edge.target);
                        }
                    });

                    dagre.layout(dagreGraph);

                    // Apply positions to all nodes in this workflow (not just new ones)
                    workflow.nodes.forEach(nodeId => {
                        const node = currentGraphData.nodes.find(n => n.id === nodeId);
                        const pos = dagreGraph.node(nodeId);
                        if (node && pos) {
                            node.x = snapToGrid(pos.x);
                            node.y = snapToGrid(pos.y + workflowYOffset);
                            node.fx = node.x;
                            node.fy = node.y;
                            originalPositions.set(node.id, { x: node.x, y: node.y });
                        }
                    });

                    // Calculate workflow height for next workflow offset
                    const wfNodes = workflow.nodes
                        .map(id => currentGraphData.nodes.find(n => n.id === id))
                        .filter(n => n && n.y !== undefined);
                    if (wfNodes.length > 0) {
                        const maxY = Math.max(...wfNodes.map(n => n.y));
                        workflowYOffset = maxY + 200; // Add padding between workflows
                    }
                } else if (workflow.bounds) {
                    // Workflow has existing positioned nodes - use mini-dagre to insert new nodes
                    const dagreGraph = new dagre.graphlib.Graph();
                    dagreGraph.setGraph({ rankdir: 'LR', nodesep: 50, ranksep: 100 });
                    dagreGraph.setDefaultEdgeLabel(() => ({}));

                    // Add all workflow nodes (existing ones get fixed positions)
                    workflow.nodes.forEach(nodeId => {
                        const existingNode = currentGraphData.nodes.find(n => n.id === nodeId);
                        if (existingNode) {
                            if (existingNode.x !== undefined && existingNode.y !== undefined) {
                                dagreGraph.setNode(nodeId, {
                                    width: 140, height: 70,
                                    x: existingNode.x, y: existingNode.y
                                });
                            } else {
                                dagreGraph.setNode(nodeId, { width: 140, height: 70 });
                            }
                        }
                    });

                    // Add edges within workflow
                    currentGraphData.edges.forEach(edge => {
                        if (workflow.nodes.includes(edge.source) && workflow.nodes.includes(edge.target)) {
                            dagreGraph.setEdge(edge.source, edge.target);
                        }
                    });

                    dagre.layout(dagreGraph);

                    // Apply positions only to new nodes
                    wfNewNodes.forEach(newNode => {
                        const pos = dagreGraph.node(newNode.id);
                        if (pos) {
                            newNode.x = snapToGrid(pos.x);
                            newNode.y = snapToGrid(pos.y);
                            newNode.fx = newNode.x;
                            newNode.fy = newNode.y;
                            originalPositions.set(newNode.id, { x: newNode.x, y: newNode.y });
                        }
                    });
                } else {
                    // Workflow exists but has no bounds yet and no positioned nodes
                    // Run full dagre layout
                    const dagreGraph = new dagre.graphlib.Graph();
                    dagreGraph.setGraph({ rankdir: 'LR', nodesep: 50, ranksep: 100 });
                    dagreGraph.setDefaultEdgeLabel(() => ({}));

                    workflow.nodes.forEach(nodeId => {
                        dagreGraph.setNode(nodeId, { width: 140, height: 70 });
                    });

                    currentGraphData.edges.forEach(edge => {
                        if (workflow.nodes.includes(edge.source) && workflow.nodes.includes(edge.target)) {
                            dagreGraph.setEdge(edge.source, edge.target);
                        }
                    });

                    dagre.layout(dagreGraph);

                    workflow.nodes.forEach(nodeId => {
                        const node = currentGraphData.nodes.find(n => n.id === nodeId);
                        const pos = dagreGraph.node(nodeId);
                        if (node && pos) {
                            node.x = snapToGrid(pos.x);
                            node.y = snapToGrid(pos.y + workflowYOffset);
                            node.fx = node.x;
                            node.fy = node.y;
                            originalPositions.set(node.id, { x: node.x, y: node.y });
                        }
                    });

                    const wfNodes = workflow.nodes
                        .map(id => currentGraphData.nodes.find(n => n.id === id))
                        .filter(n => n && n.y !== undefined);
                    if (wfNodes.length > 0) {
                        const maxY = Math.max(...wfNodes.map(n => n.y));
                        workflowYOffset = maxY + 200;
                    }
                }
            });
        }

        // Recalculate bounds for workflow groups that don't have them
        function recalculateWorkflowBounds(groups) {
            groups.forEach(group => {
                if (group.bounds) return; // Already has bounds

                const allGroupNodes = currentGraphData.nodes.filter(n => group.nodes.includes(n.id));
                if (allGroupNodes.length < 3) return;

                // Calculate bounds from current node positions
                const xs = allGroupNodes.map(n => n.x).filter(x => x !== undefined && !isNaN(x));
                const ys = allGroupNodes.map(n => n.y).filter(y => y !== undefined && !isNaN(y));

                if (xs.length === 0 || ys.length === 0) return;

                group.bounds = {
                    minX: Math.min(...xs) - 90,
                    maxX: Math.max(...xs) + 90,
                    minY: Math.min(...ys) - 75,
                    maxY: Math.max(...ys) + 55
                };
                group.centerX = (group.bounds.minX + group.bounds.maxX) / 2;
                group.centerY = (group.bounds.minY + group.bounds.maxY) / 2;
            });
        }

        // Update workflow group DOM elements during incremental updates
        function updateWorkflowGroups(groups) {
            const groupsWithBounds = groups.filter(grp => grp.bounds && grp.nodes.length >= 3);
            const groupContainer = g.select('.groups');

            // Get existing group IDs in DOM
            const existingGroupIds = new Set();
            groupContainer.selectAll('.workflow-group').each(function(d) {
                if (d && d.id) existingGroupIds.add(d.id);
            });

            // Update existing groups
            groupContainer.selectAll('.workflow-group').each(function(d) {
                const group = groupsWithBounds.find(grp => grp.id === d.id);
                if (!group) {
                    // Group no longer exists - remove it
                    d3.select(this).remove();
                    return;
                }

                // Update data binding
                d3.select(this).datum(group);

                // Update bounds
                d3.select(this).select('.group-background')
                    .attr('x', group.bounds.minX)
                    .attr('y', group.bounds.minY)
                    .attr('width', group.bounds.maxX - group.bounds.minX)
                    .attr('height', group.bounds.maxY - group.bounds.minY);

                d3.select(this).select('.group-title-expanded')
                    .attr('x', group.bounds.minX + 40)
                    .attr('y', group.bounds.minY + 24)
                    .text(group.name + ' (' + group.nodes.length + ' nodes)');

                // Update collapse button position
                d3.select(this).select('.group-collapse-btn rect')
                    .attr('x', group.bounds.minX + 10)
                    .attr('y', group.bounds.minY + 8);
                d3.select(this).select('.group-collapse-btn text')
                    .attr('x', group.bounds.minX + 22)
                    .attr('y', group.bounds.minY + 24);
            });

            // Add new groups that don't exist in DOM
            const newGroups = groupsWithBounds.filter(grp => !existingGroupIds.has(grp.id));
            if (newGroups.length > 0) {
                const newGroupElements = groupContainer.selectAll('.workflow-group-new')
                    .data(newGroups, d => d.id)
                    .enter()
                    .append('g')
                    .attr('class', 'workflow-group')
                    .attr('data-group-id', d => d.id);

                // Group background rectangle
                newGroupElements.append('rect')
                    .attr('class', 'group-background')
                    .attr('x', d => d.bounds.minX)
                    .attr('y', d => d.bounds.minY)
                    .attr('width', d => d.bounds.maxX - d.bounds.minX)
                    .attr('height', d => d.bounds.maxY - d.bounds.minY)
                    .attr('rx', 12)
                    .style('fill', d => d.color)
                    .style('fill-opacity', 0.1)
                    .style('stroke', d => d.color)
                    .style('stroke-width', '3px')
                    .style('stroke-dasharray', '8,4')
                    .style('opacity', d => d.collapsed ? 0 : 1)
                    .style('pointer-events', 'none');

                // Title inside expanded group
                newGroupElements.append('text')
                    .attr('class', 'group-title-expanded')
                    .attr('x', d => d.bounds.minX + 40)
                    .attr('y', d => d.bounds.minY + 24)
                    .style('fill', d => d.color)
                    .style('font-size', '13px')
                    .style('font-weight', '700')
                    .style('display', d => d.collapsed ? 'none' : 'block')
                    .style('pointer-events', 'none')
                    .text(d => d.name + ' (' + d.nodes.length + ' nodes)');

                // Collapse button
                const collapseBtn = newGroupElements.append('g')
                    .attr('class', 'group-collapse-btn')
                    .style('display', d => d.collapsed ? 'none' : 'block')
                    .style('cursor', 'pointer')
                    .on('click', function(event, d) {
                        event.stopPropagation();
                        d.collapsed = true;
                        updateGroupVisibility();
                    });

                collapseBtn.append('rect')
                    .attr('x', d => d.bounds.minX + 10)
                    .attr('y', d => d.bounds.minY + 8)
                    .attr('width', 24)
                    .attr('height', 24)
                    .attr('rx', 4)
                    .style('fill', d => d.color)
                    .style('fill-opacity', 0.2)
                    .style('stroke', d => d.color)
                    .style('stroke-width', '2px');

                collapseBtn.append('text')
                    .attr('x', d => d.bounds.minX + 22)
                    .attr('y', d => d.bounds.minY + 24)
                    .attr('text-anchor', 'middle')
                    .style('fill', d => d.color)
                    .style('font-size', '16px')
                    .style('font-weight', 'bold')
                    .style('pointer-events', 'none')
                    .text('−');
            }
        }

        // Render a single node (for incremental updates)
        function renderNode(nodeData) {
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

            // Append to nodes-container
            const nodeGroup = g.select('.nodes-container').append('g')
                .datum(nodeData)
                .attr('class', 'node')
                .attr('data-node-id', nodeData.id)
                .attr('transform', 'translate(' + nodeData.x + ',' + nodeData.y + ')')
                .call(d3.drag()
                    .on('start', dragstarted)
                    .on('drag', dragged)
                    .on('end', dragended));

            // Background fill rect
            nodeGroup.append('rect')
                .attr('width', 140)
                .attr('height', 70)
                .attr('x', -70)
                .attr('y', -35)
                .attr('rx', 4)
                .style('fill', 'var(--vscode-editor-background)')
                .style('stroke', 'none');

            // Colored header background
            nodeGroup.append('path')
                .attr('class', 'node-header')
                .attr('d', 'M -65,-35 L 65,-35 A 4,4 0 0,1 69,-31 L 69,-11 L -69,-11 L -69,-31 A 4,4 0 0,1 -65,-35 Z')
                .style('fill', typeColors[nodeData.type] || '#90A4AE')
                .style('opacity', 0.5)
                .style('stroke', 'none');

            // Border rect with entry/exit/critical classes
            const classes = [];
            if (nodeData.isCriticalPath) classes.push('critical-path');
            if (nodeData.isEntryPoint) classes.push('entry-point');
            if (nodeData.isExitPoint) classes.push('exit-point');

            nodeGroup.append('rect')
                .attr('width', 140)
                .attr('height', 70)
                .attr('x', -70)
                .attr('y', -35)
                .attr('rx', 4)
                .attr('class', classes.join(' '))
                .style('fill', 'none')
                .style('pointer-events', 'all');

            // Title text
            nodeGroup.append('text')
                .attr('class', 'node-title')
                .attr('y', -21)
                .attr('dominant-baseline', 'middle')
                .text(nodeData.label);

            // Icon
            nodeGroup.append('g')
                .attr('class', 'node-icon ' + nodeData.type)
                .attr('transform', 'translate(44, 10) scale(0.8)')
                .html(getIcon(nodeData.type));

            // Type label
            nodeGroup.append('text')
                .attr('class', 'node-type')
                .text(nodeData.type.toUpperCase())
                .attr('x', 40)
                .attr('y', 21)
                .attr('dominant-baseline', 'middle')
                .style('text-anchor', 'end');

            // Selection indicator (camera corners) - hidden by default
            nodeGroup.append('rect')
                .attr('class', 'selection-indicator')
                .attr('x', -75)
                .attr('y', -40)
                .attr('width', 150)
                .attr('height', 80)
                .attr('rx', 6)
                .style('fill', 'none')
                .style('stroke', '#00d9ff')
                .style('stroke-width', '3px')
                .style('stroke-dasharray', '10,5')
                .style('display', 'none');
        }

        // Render a single edge (for incremental updates)
        function renderEdge(edgeData) {
            const sourceNode = currentGraphData.nodes.find(n => n.id === edgeData.source);
            const targetNode = currentGraphData.nodes.find(n => n.id === edgeData.target);

            if (!sourceNode || !targetNode) return;

            const edgeKey = edgeData.source + '->' + edgeData.target;
            const pathClass = 'link' + (edgeData.isCriticalPath ? ' critical-path' : '');

            // Create edge group in edge-paths-container
            const edgeGroup = g.select('.edge-paths-container').append('g')
                .datum(edgeData)
                .attr('class', 'link-group')
                .attr('data-edge-key', edgeKey);

            // Edge path
            edgeGroup.append('path')
                .attr('class', pathClass)
                .attr('d', generateEdgePath(edgeData, sourceNode, targetNode, 140, 70))
                .attr('marker-end', 'url(#arrowhead)');

            // Hover path (wider for easier interaction)
            edgeGroup.append('path')
                .attr('class', 'link-hover')
                .attr('d', generateEdgePath(edgeData, sourceNode, targetNode, 140, 70))
                .on('mouseover', function(event) {
                    const transform = d3.zoomTransform(svg.node());
                    edgeGroup.select('.link').style('stroke-width', (3 / transform.k) + 'px');
                    edgeGroup.select('.link-label').style('font-weight', 'bold');
                })
                .on('mouseout', function() {
                    const transform = d3.zoomTransform(svg.node());
                    edgeGroup.select('.link').style('stroke-width', (2 / transform.k) + 'px');
                    edgeGroup.select('.link-label').style('font-weight', 'normal');
                });

            // Edge label - add to separate edge-labels-container (for z-order)
            const midX = (sourceNode.x + targetNode.x) / 2;
            const midY = (sourceNode.y + targetNode.y) / 2;

            const labelGroup = g.select('.edge-labels-container').append('g')
                .datum(edgeData)
                .attr('class', 'link-label-group')
                .attr('data-edge-key', edgeKey)
                .attr('transform', 'translate(' + midX + ',' + midY + ')');

            labelGroup.append('rect')
                .attr('class', 'link-label-bg');

            labelGroup.append('text')
                .attr('class', 'link-label')
                .text(edgeData.label || '');
        }

        // Update all edge paths (after node positions change)
        function updateAllEdgePaths() {
            g.selectAll('.link-group').each(function(edgeData) {
                const sourceNode = getNodeOrCollapsedGroup(edgeData.source);
                const targetNode = getNodeOrCollapsedGroup(edgeData.target);
                const targetWidth = targetNode?.isCollapsedGroup ? 260 : 140;
                const targetHeight = targetNode?.isCollapsedGroup ? 130 : 70;

                const path = generateEdgePath(edgeData, sourceNode, targetNode, targetWidth, targetHeight);

                d3.select(this).select('.link').attr('d', path);
                d3.select(this).select('.link-hover').attr('d', path);

                // Update label position
                if (sourceNode && targetNode) {
                    const midX = (sourceNode.x + targetNode.x) / 2;
                    const midY = (sourceNode.y + targetNode.y) / 2;
                    d3.select(this).select('.link-label-group')
                        .attr('transform', 'translate(' + midX + ',' + midY + ')');
                }
            });
        }

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
                    indicator.style.display = 'block';

                    // Show and update progress bar
                    const progressContainer = indicator.querySelector('.progress-bar-container');
                    const progressFill = indicator.querySelector('.progress-bar-fill');
                    if (progressContainer && progressFill) {
                        progressContainer.style.display = 'block';
                        const percent = (message.current / message.total) * 100;
                        progressFill.style.width = \`\${percent}%\`;
                        // Update text with percentage
                        textSpan.textContent = \`Analyzing workflows... \${Math.round(percent)}%\`;
                    }
                    break;

                case 'showProgressOverlay':
                    const overlay = document.getElementById('progressOverlay');
                    const overlayText = overlay.querySelector('.overlay-text');
                    overlayText.textContent = message.text || 'Processing...';
                    overlay.style.display = 'flex';
                    break;

                case 'hideProgressOverlay':
                    document.getElementById('progressOverlay').style.display = 'none';
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

                case 'updateGraph':
                    if (message.preserveState && message.graph) {
                        console.log('[webview] updateGraph: applying incremental update');

                        // Capture current UI state
                        const savedState = captureState();

                        // Compute diff between old and new graph
                        const diff = computeGraphDiff(currentGraphData, message.graph);

                        if (!hasDiff(diff)) {
                            console.log('[webview] updateGraph: no changes detected');
                            break;
                        }

                        // Update the graph data
                        currentGraphData = message.graph;

                        // Re-detect workflow groups (may have changed)
                        const newWorkflowGroups = detectWorkflowGroups(currentGraphData);

                        // Merge workflow collapse states from old groups
                        newWorkflowGroups.forEach(newG => {
                            const oldG = workflowGroups.find(og => og.id === newG.id);
                            if (oldG) {
                                newG.collapsed = oldG.collapsed;
                                // Only preserve bounds if nodes haven't changed
                                const oldNodes = oldG.nodes.slice().sort();
                                const newNodes = newG.nodes.slice().sort();
                                const nodesChanged = JSON.stringify(oldNodes) !== JSON.stringify(newNodes);
                                if (oldG.bounds && !nodesChanged) {
                                    newG.bounds = oldG.bounds;
                                    newG.centerX = oldG.centerX;
                                    newG.centerY = oldG.centerY;
                                }
                            }
                        });

                        workflowGroups = newWorkflowGroups;

                        // Apply incremental DOM updates (includes bounds recalculation)
                        applyIncrementalUpdate(diff, savedState);

                        // Restore UI state (zoom, selection, etc.)
                        restoreState(savedState);

                        console.log('[webview] updateGraph: incremental update complete', {
                            nodesAdded: diff.nodes.added.length,
                            nodesRemoved: diff.nodes.removed.length,
                            nodesUpdated: diff.nodes.updated.length,
                            edgesAdded: diff.edges.added.length,
                            edgesRemoved: diff.edges.removed.length
                        });

                        // Update header stats
                        updateSnapshotStats();
                    } else {
                        console.log('[webview] updateGraph: no graph data or preserveState=false');
                    }
                    break;

                case 'focusNode':
                    // Focus on a specific node (from Copilot clickable link)
                    if (message.nodeId) {
                        const node = data.nodes.find(n => n.id === message.nodeId);
                        if (node) {
                            // Select the node (opens side panel)
                            selectNode(node);

                            // Pan to center the node
                            if (node.x !== undefined && node.y !== undefined) {
                                const svgElement = svg.node();
                                const width = svgElement.clientWidth;
                                const height = svgElement.clientHeight;
                                const scale = 1.2; // Slight zoom in

                                const transform = d3.zoomIdentity
                                    .translate(width / 2, height / 2)
                                    .scale(scale)
                                    .translate(-node.x, -node.y);

                                svg.transition()
                                    .duration(750)
                                    .call(zoom.transform, transform);
                            }
                        }
                    }
                    break;
            }
        });`;

        // Combine all scripts using the script loader
        const scriptContent = loadScripts(graphJson, mainRendererScript);

        // Use the template to generate the full HTML
        return getHtmlTemplate(webviewStyles, scriptContent, loadingOptions);
    }
}
