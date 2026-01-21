// Edge rendering and hover effects
import * as state from './state';
import { getVirtualNodeId, getNodeWorkflowCount, getOriginalNodeId } from './utils';
import {
    EDGE_STROKE_WIDTH, EDGE_HOVER_STROKE_WIDTH, EDGE_HOVER_HIT_WIDTH,
    EDGE_COLOR_HOVER, ARROW_HEAD_LENGTH
} from './constants';
import { getWorkflowNodeIds, findReverseEdge, getBidirectionalEdgeKey, positionTooltipNearMouse } from './helpers';
import { WorkflowComponent, WorkflowGroup, EdgeRoute } from './types';

declare const d3: any;

/**
 * Generate SVG path from ELK edge route (orthogonal routing)
 * Shortens endpoint to leave room for arrowhead
 */
function generateElkEdgePath(route: EdgeRoute): string {
    const { startPoint, endPoint, bendPoints } = route;

    // Shorten the endpoint along the last segment direction for arrow clearance
    let adjustedEnd = endPoint;
    const lastPoint = bendPoints.length > 0 ? bendPoints[bendPoints.length - 1] : startPoint;

    const dx = endPoint.x - lastPoint.x;
    const dy = endPoint.y - lastPoint.y;
    const len = Math.sqrt(dx * dx + dy * dy);

    if (len > ARROW_HEAD_LENGTH) {
        const ratio = (len - ARROW_HEAD_LENGTH) / len;
        adjustedEnd = {
            x: lastPoint.x + dx * ratio,
            y: lastPoint.y + dy * ratio
        };
    }

    // Build path: M start, L through bendPoints, L adjusted end
    let path = `M ${startPoint.x} ${startPoint.y}`;
    for (const bp of bendPoints) {
        path += ` L ${bp.x} ${bp.y}`;
    }
    path += ` L ${adjustedEnd.x} ${adjustedEnd.y}`;

    return path;
}

/**
 * Find ELK edge route for an edge
 * Edge IDs in ELK are formatted as: ${groupId}_${source}->${target}
 */
function findElkEdgeRoute(
    sourceId: string,
    targetId: string,
    workflowGroups: WorkflowGroup[]
): EdgeRoute | null {
    // Get original node IDs (strip virtual ID suffix if present)
    const origSource = getOriginalNodeId(sourceId);
    const origTarget = getOriginalNodeId(targetId);

    // Find which workflow this edge belongs to
    for (const group of workflowGroups) {
        if (group.nodes.includes(origSource) && group.nodes.includes(origTarget)) {
            const edgeId = `${group.id}_${origSource}->${origTarget}`;
            const route = state.getElkEdgeRoute(edgeId);
            if (route) return route;
        }
    }
    return null;
}

/**
 * Get ELK edge path for an edge (exported for use in formatGraph)
 * Returns empty string if no ELK route found
 */
export function getElkEdgePath(edge: any, workflowGroups: WorkflowGroup[]): string {
    const elkRoute = findElkEdgeRoute(
        edge._originalSource || edge.source,
        edge._originalTarget || edge.target,
        workflowGroups
    );
    if (elkRoute) {
        return generateElkEdgePath(elkRoute);
    }
    return '';
}

/**
 * Find which collapsed component a node belongs to (if any)
 */
function findNodeCollapsedComponent(
    nodeId: string,
    workflowGroups: WorkflowGroup[],
    expandedComponents: Set<string>
): WorkflowComponent | null {
    for (const group of workflowGroups) {
        for (const comp of (group.components || [])) {
            if (comp.nodes.includes(nodeId) && !expandedComponents.has(comp.id)) {
                return comp;
            }
        }
    }
    return null;
}

/**
 * Get component placeholder ID
 */
function getComponentPlaceholderId(componentId: string): string {
    return `__comp_${componentId}`;
}


// Get expanded nodes from state (created by layoutWorkflows)
export function getExpandedNodes(): any[] {
    return state.expandedNodes;
}

export function renderEdges(): void {
    const { g, currentGraphData, workflowGroups } = state;
    const expandedComponents = state.getExpandedComponents();

    // Filter nodes to only render those in workflow groups WITH 3+ NODES
    const allWorkflowNodeIds = getWorkflowNodeIds(workflowGroups);

    // Build set of actual node IDs for existence validation
    const existingNodeIds = new Set(currentGraphData.nodes.map((n: any) => n.id));

    // Filter edges to only those where BOTH nodes exist AND are rendered
    const baseEdges = currentGraphData.edges.filter((e: any) => {
        // First check: nodes must actually exist in graph
        if (!existingNodeIds.has(e.source) || !existingNodeIds.has(e.target)) {
            console.warn(`Filtering edge with missing endpoint: ${e.source} → ${e.target}`);
            return false;
        }
        // Second check: nodes must be in rendered workflows
        return allWorkflowNodeIds.has(e.source) && allWorkflowNodeIds.has(e.target);
    });

    // Transform edges to use virtual IDs for shared nodes and component placeholders
    const allEdges: any[] = [];
    baseEdges.forEach((edge: any) => {
        const sourceIsShared = getNodeWorkflowCount(edge.source, workflowGroups) > 1;
        const targetIsShared = getNodeWorkflowCount(edge.target, workflowGroups) > 1;

        // Check if source/target are in collapsed components
        const sourceComp = findNodeCollapsedComponent(edge.source, workflowGroups, expandedComponents);
        const targetComp = findNodeCollapsedComponent(edge.target, workflowGroups, expandedComponents);

        // Skip internal edges within same collapsed component
        if (sourceComp && targetComp && sourceComp.id === targetComp.id) {
            return;
        }

        if (!sourceIsShared && !targetIsShared) {
            // Neither endpoint is shared - render the edge
            // (Previously skipped cross-workflow edges, but these are valid for service-to-service connections)

            // Transform for components if needed
            allEdges.push({
                ...edge,
                source: sourceComp ? getComponentPlaceholderId(sourceComp.id) : edge.source,
                target: targetComp ? getComponentPlaceholderId(targetComp.id) : edge.target,
                _originalSource: edge.source,
                _originalTarget: edge.target,
                _sourceIsComponent: !!sourceComp,
                _targetIsComponent: !!targetComp
            });
        } else {
            // Find which workflow(s) this edge belongs to (both endpoints in same workflow)
            workflowGroups.forEach((wf: any) => {
                const sourceInWf = wf.nodes.includes(edge.source);
                const targetInWf = wf.nodes.includes(edge.target);
                if (sourceInWf && targetInWf) {
                    // Determine source ID (component placeholder > virtual ID > regular ID)
                    let sourceId = edge.source;
                    if (sourceComp) {
                        sourceId = getComponentPlaceholderId(sourceComp.id);
                    } else if (sourceIsShared) {
                        sourceId = getVirtualNodeId(edge.source, wf.id);
                    }

                    // Determine target ID
                    let targetId = edge.target;
                    if (targetComp) {
                        targetId = getComponentPlaceholderId(targetComp.id);
                    } else if (targetIsShared) {
                        targetId = getVirtualNodeId(edge.target, wf.id);
                    }

                    allEdges.push({
                        ...edge,
                        source: sourceId,
                        target: targetId,
                        _originalSource: edge.source,
                        _originalTarget: edge.target,
                        _sourceIsComponent: !!sourceComp,
                        _targetIsComponent: !!targetComp
                    });
                }
            });
        }
    });

    // Track which bidirectional pairs we've already processed
    const processedBidirectional = new Set<string>();

    // Separate unidirectional and bidirectional edges
    const edgesToRender: any[] = [];
    allEdges.forEach((edge: any) => {
        const reverseEdge = findReverseEdge(edge, allEdges);
        if (reverseEdge) {
            // Bidirectional - only render once per pair
            const key = getBidirectionalEdgeKey(edge);
            if (!processedBidirectional.has(key)) {
                processedBidirectional.add(key);
                // Mark as bidirectional and store reverse edge data
                edgesToRender.push({
                    ...edge,
                    isBidirectional: true,
                    reverseEdge: reverseEdge
                });
            }
        } else {
            // Unidirectional
            edgesToRender.push({ ...edge, isBidirectional: false });
        }
    });

    // Filter out edges without valid ELK routes (these would render as invisible/broken)
    const validEdgesToRender = edgesToRender.filter((edge: any) => {
        const elkRoute = findElkEdgeRoute(
            edge._originalSource || edge.source,
            edge._originalTarget || edge.target,
            workflowGroups
        );
        if (!elkRoute) {
            console.warn(`Filtering edge without ELK route: ${edge._originalSource || edge.source} → ${edge._originalTarget || edge.target}`);
            return false;
        }
        return true;
    });

    // Create container for edge paths
    const edgePathsContainer = g.append('g').attr('class', 'edge-paths-container');
    state.setEdgePathsContainer(edgePathsContainer);

    // Create edge path groups
    const linkGroup = edgePathsContainer
        .selectAll('g')
        .data(validEdgesToRender)
        .enter()
        .append('g')
        .attr('class', (d: any) => d.isBidirectional ? 'link-group bidirectional' : 'link-group')
        .attr('data-edge-key', (d: any) => d.isBidirectional
            ? getBidirectionalEdgeKey(d)
            : `${d.source}->${d.target}`);

    const link = linkGroup.append('path')
        .attr('class', 'link')
        .style('stroke-width', `${EDGE_STROKE_WIDTH}px`)
        .style('pointer-events', 'none')
        .attr('marker-end', 'url(#arrowhead)')
        .attr('marker-start', (d: any) => d.isBidirectional ? 'url(#arrowhead-start)' : null);

    // Add invisible wider path for easier hovering
    const linkHover = linkGroup.insert('path', '.link')
        .attr('class', 'link-hover')
        .style('stroke', 'transparent')
        .style('stroke-width', `${EDGE_HOVER_HIT_WIDTH}px`)
        .style('fill', 'none')
        .style('cursor', 'pointer')
        .on('mouseenter', function(event: any, d: any) {
            // Highlight edge path
            const index = validEdgesToRender.indexOf(d);
            const linkElement = d3.select(edgePathsContainer.node().children[index]).select('.link');
            linkElement.style('stroke', EDGE_COLOR_HOVER).style('stroke-width', `${EDGE_HOVER_STROKE_WIDTH}px`);

            // Show tooltip
            showEdgeTooltip(d, event);
        })
        .on('mousemove', function(event: any, d: any) {
            // Update tooltip position as mouse moves
            updateTooltipPosition(event);
        })
        .on('mouseleave', function(event: any, d: any) {
            // Reset edge path
            const index = validEdgesToRender.indexOf(d);
            const linkElement = d3.select(edgePathsContainer.node().children[index]).select('.link');
            linkElement.style('stroke', null).style('stroke-width', null);

            // Hide tooltip
            const tooltip = document.getElementById('edgeTooltip');
            if (tooltip) tooltip.style.display = 'none';
        })
        .on('click', function(event: any, d: any) {
            event.stopPropagation();
            if (d.sourceLocation) {
                state.vscode.postMessage({
                    command: 'openFile',
                    file: d.sourceLocation.file,
                    line: d.sourceLocation.line
                });
            }
        });

    // Generate edge path using ELK routes only (no fallback)
    const getEdgePath = (d: any) => {
        const elkRoute = findElkEdgeRoute(d._originalSource || d.source, d._originalTarget || d.target, workflowGroups);
        if (elkRoute) {
            return generateElkEdgePath(elkRoute);
        }
        return '';
    };

    // Set initial edge paths
    link.attr('d', getEdgePath);
    linkHover.attr('d', getEdgePath);

    state.setLinkSelections(link, linkHover, linkGroup);

    // Render edge labels for edges that have them (decisions, API calls)
    renderEdgeLabels(validEdgesToRender);
}

/**
 * Calculate label position from ELK edge route
 * For orthogonal paths, place label at midpoint of the horizontal segment
 */
function getLabelPositionFromRoute(route: EdgeRoute): { x: number; y: number } {
    const { startPoint, endPoint, bendPoints } = route;

    // Build full path points
    const points = [startPoint, ...bendPoints, endPoint];

    // Find horizontal segment (where y values are equal between consecutive points)
    for (let i = 0; i < points.length - 1; i++) {
        const p1 = points[i];
        const p2 = points[i + 1];
        if (Math.abs(p1.y - p2.y) < 1) {
            // Horizontal segment - place label at midpoint
            return {
                x: (p1.x + p2.x) / 2,
                y: p1.y
            };
        }
    }

    // Fallback: midpoint of entire edge
    return {
        x: (startPoint.x + endPoint.x) / 2,
        y: (startPoint.y + endPoint.y) / 2
    };
}

/**
 * Render text labels on edges that have them (only actual labels, not payloads)
 * Uses ELK route geometry for positioning - no fallback
 */
function renderEdgeLabels(edges: any[]): void {
    const { g, workflowGroups } = state;

    // Filter to only edges with actual labels (not payload data)
    // Labels are descriptive actions like "valid", "invalid", "POST /analyze"
    const edgesWithLabels = edges.filter(e => e.label && typeof e.label === 'string');
    if (edgesWithLabels.length === 0) {
        state.setEdgeLabelsState(null, null, []);
        return;
    }

    // Create container for edge labels (above paths)
    const edgeLabelsContainer = g.append('g').attr('class', 'edge-labels-container');

    const labelGroups = edgeLabelsContainer
        .selectAll('g.edge-label')
        .data(edgesWithLabels)
        .enter()
        .append('g')
        .attr('class', 'edge-label')
        .attr('transform', (d: any) => {
            // Use ELK route for label position (ELK-only)
            const elkRoute = findElkEdgeRoute(
                d._originalSource || d.source,
                d._originalTarget || d.target,
                workflowGroups
            );
            if (elkRoute) {
                const pos = getLabelPositionFromRoute(elkRoute);
                return `translate(${pos.x}, ${pos.y})`;
            }
            // No route = no label position (hidden at origin)
            return 'translate(0, 0)';
        });

    // Add background rect for readability
    labelGroups.append('rect')
        .attr('class', 'edge-label-bg')
        .attr('rx', 3)
        .attr('ry', 3)
        .attr('fill', 'var(--vscode-editor-background)')
        .attr('fill-opacity', 0.9)
        .attr('stroke', 'var(--vscode-editorWidget-border)')
        .attr('stroke-width', 1);

    // Add text
    labelGroups.append('text')
        .attr('class', 'edge-label-text')
        .attr('text-anchor', 'middle')
        .attr('dominant-baseline', 'middle')
        .attr('fill', 'var(--vscode-foreground)')
        .attr('font-size', '11px')
        .text((d: any) => d.label);

    // Size background rects to fit text
    labelGroups.each(function(this: any) {
        const group = d3.select(this);
        const text = group.select('text');
        const textNode = text.node();
        if (textNode) {
            const bbox = textNode.getBBox();
            group.select('rect')
                .attr('x', bbox.x - 4)
                .attr('y', bbox.y - 2)
                .attr('width', bbox.width + 8)
                .attr('height', bbox.height + 4);
        }
    });

    // Store in state for updates
    state.setEdgeLabelsState(edgeLabelsContainer, labelGroups, edgesWithLabels);
}

function showEdgeTooltip(d: any, event: any): void {
    const tooltip = document.getElementById('edgeTooltip');
    if (!tooltip) return;

    const { currentGraphData } = state;

    // Helper to get node label from ID
    const getNodeLabel = (nodeId: string): string => {
        const node = currentGraphData.nodes.find((n: any) => n.id === nodeId);
        return node?.label || nodeId;
    };

    if (d.isBidirectional && d.reverseEdge) {
        // Bidirectional edge - show both directions
        const sourceLabel = getNodeLabel(d.source);
        const targetLabel = getNodeLabel(d.target);
        const forwardHtml = formatEdgeInfo(d, `${sourceLabel} → ${targetLabel}`);
        const reverseHtml = formatEdgeInfo(d.reverseEdge, `${targetLabel} → ${sourceLabel}`);

        tooltip.innerHTML = `
            <div class="bidirectional-tooltip">
                <div class="edge-direction">${forwardHtml}</div>
                <hr style="border: none; border-top: 1px solid var(--vscode-editorWidget-border); margin: 8px 0;">
                <div class="edge-direction">${reverseHtml}</div>
            </div>
        `;
    } else {
        // Unidirectional edge
        tooltip.innerHTML = formatEdgeInfo(d);
    }

    tooltip.style.display = 'block';
    updateTooltipPosition(event);
}

function formatEdgeInfo(edge: any, header?: string): string {
    let html = '<div style="position: relative;">';
    if (header) {
        html += `<div style="font-weight: 600; margin-bottom: 4px; color: var(--vscode-textLink-foreground);">${header}</div>`;
    }

    // Show edge label if present (decision branch, API call)
    if (edge.label) {
        html += `<div><strong>Label:</strong> ${edge.label}</div>`;
    }

    // Show condition if present (for decision branches)
    if (edge.condition) {
        html += `<div><strong>Condition:</strong> <code>${edge.condition}</code></div>`;
    }

    // Show payload info if present
    if (edge.payload) {
        html += `<div style="margin-top: 4px; padding-top: 4px; border-top: 1px solid var(--vscode-editorWidget-border);">`;
        html += `<div><strong>Data:</strong> <code>${edge.payload.name}</code></div>`;
        html += `<div><strong>Type:</strong> ${edge.payload.type}</div>`;
        if (edge.payload.description) {
            html += `<div><strong>Description:</strong> ${edge.payload.description}</div>`;
        }
        html += '</div>';
    }

    // Show "No data" message if neither label nor payload
    if (!edge.label && !edge.payload) {
        html += `<div style="color: var(--vscode-descriptionForeground);">Control flow edge</div>`;
    }

    html += '</div>';
    return html;
}

function updateTooltipPosition(event: any): void {
    const tooltip = document.getElementById('edgeTooltip');
    if (!tooltip) return;

    const mouseX = event.clientX || event.pageX;
    const mouseY = event.clientY || event.pageY;
    positionTooltipNearMouse(tooltip, mouseX, mouseY);
}

/**
 * Update edge label positions when layout changes
 * @param transitionDuration - Optional duration for animated transition (0 = instant)
 */
export function updateEdgeLabels(transitionDuration: number = 0): void {
    const { edgeLabelGroups, edgesWithLabels, workflowGroups } = state;

    if (!edgeLabelGroups || edgesWithLabels.length === 0) return;

    const computeTransform = (d: any) => {
        // Use ELK route for label position
        const elkRoute = findElkEdgeRoute(
            d._originalSource || d.source,
            d._originalTarget || d.target,
            workflowGroups
        );
        if (elkRoute) {
            const pos = getLabelPositionFromRoute(elkRoute);
            return `translate(${pos.x}, ${pos.y})`;
        }
        return 'translate(0, 0)';
    };

    if (transitionDuration > 0) {
        edgeLabelGroups.transition().duration(transitionDuration).attr('transform', computeTransform);
    } else {
        edgeLabelGroups.attr('transform', computeTransform);
    }
}

/**
 * Update edge paths using ELK routes
 */
export function updateEdgePaths(): void {
    const { link, linkHover, workflowGroups } = state;

    const getEdgePath = (l: any) => {
        const elkRoute = findElkEdgeRoute(
            l._originalSource || l.source,
            l._originalTarget || l.target,
            workflowGroups
        );
        if (elkRoute) {
            return generateElkEdgePath(elkRoute);
        }
        return '';
    };

    link.attr('d', getEdgePath);
    linkHover.attr('d', getEdgePath);
}

/**
 * Incrementally update edges without destroying existing DOM elements.
 * Uses D3 enter/update/exit pattern to minimize DOM operations.
 */
export function updateEdgesIncremental(): void {
    const { g, currentGraphData, workflowGroups } = state;
    const expandedComponents = state.getExpandedComponents();

    // Build edge list (same logic as renderEdges)
    const allEdges: any[] = [];

    currentGraphData.edges.forEach((edge: any) => {
        const sourceIsShared = getNodeWorkflowCount(edge.source, workflowGroups) > 1;
        const targetIsShared = getNodeWorkflowCount(edge.target, workflowGroups) > 1;
        const sourceComp = findNodeCollapsedComponent(edge.source, workflowGroups, expandedComponents);
        const targetComp = findNodeCollapsedComponent(edge.target, workflowGroups, expandedComponents);

        if (!sourceIsShared && !targetIsShared) {
            const sameWorkflow = workflowGroups.some((wf: any) =>
                wf.nodes.includes(edge.source) && wf.nodes.includes(edge.target)
            );
            if (!sameWorkflow) return;

            allEdges.push({
                ...edge,
                source: sourceComp ? getComponentPlaceholderId(sourceComp.id) : edge.source,
                target: targetComp ? getComponentPlaceholderId(targetComp.id) : edge.target,
                _originalSource: edge.source,
                _originalTarget: edge.target,
                _sourceIsComponent: !!sourceComp,
                _targetIsComponent: !!targetComp
            });
        } else {
            workflowGroups.forEach((wf: any) => {
                const sourceInWf = wf.nodes.includes(edge.source);
                const targetInWf = wf.nodes.includes(edge.target);
                if (sourceInWf && targetInWf) {
                    let sourceId = edge.source;
                    if (sourceComp) {
                        sourceId = getComponentPlaceholderId(sourceComp.id);
                    } else if (sourceIsShared) {
                        sourceId = getVirtualNodeId(edge.source, wf.id);
                    }

                    let targetId = edge.target;
                    if (targetComp) {
                        targetId = getComponentPlaceholderId(targetComp.id);
                    } else if (targetIsShared) {
                        targetId = getVirtualNodeId(edge.target, wf.id);
                    }

                    allEdges.push({
                        ...edge,
                        source: sourceId,
                        target: targetId,
                        _originalSource: edge.source,
                        _originalTarget: edge.target,
                        _sourceIsComponent: !!sourceComp,
                        _targetIsComponent: !!targetComp
                    });
                }
            });
        }
    });

    // Handle bidirectional edges
    const processedBidirectional = new Set<string>();
    const edgesToRender: any[] = [];
    allEdges.forEach((edge: any) => {
        const reverseEdge = findReverseEdge(edge, allEdges);
        if (reverseEdge) {
            const key = getBidirectionalEdgeKey(edge);
            if (!processedBidirectional.has(key)) {
                processedBidirectional.add(key);
                edgesToRender.push({
                    ...edge,
                    isBidirectional: true,
                    reverseEdge: reverseEdge
                });
            }
        } else {
            edgesToRender.push({ ...edge, isBidirectional: false });
        }
    });

    // Get or create edge paths container
    let edgePathsContainer = g.select('.edge-paths-container');
    if (edgePathsContainer.empty()) {
        edgePathsContainer = g.append('g').attr('class', 'edge-paths-container');
        state.setEdgePathsContainer(edgePathsContainer);
    }

    // Data join with composite key
    const linkGroupSelection = edgePathsContainer.selectAll('.link-group')
        .data(edgesToRender, (d: any) => d.isBidirectional
            ? getBidirectionalEdgeKey(d)
            : `${d.source}->${d.target}`);

    // EXIT: Remove edges that no longer exist
    linkGroupSelection.exit().remove();

    // ENTER: Create new edge groups
    const enterGroups = linkGroupSelection.enter()
        .append('g')
        .attr('class', (d: any) => d.isBidirectional ? 'link-group bidirectional' : 'link-group')
        .attr('data-edge-key', (d: any) => d.isBidirectional
            ? getBidirectionalEdgeKey(d)
            : `${d.source}->${d.target}`);

    // Add paths to new groups
    enterGroups.append('path')
        .attr('class', 'link')
        .style('stroke-width', `${EDGE_STROKE_WIDTH}px`)
        .style('pointer-events', 'none')
        .attr('marker-end', 'url(#arrowhead)')
        .attr('marker-start', (d: any) => d.isBidirectional ? 'url(#arrowhead-start)' : null);

    enterGroups.insert('path', '.link')
        .attr('class', 'link-hover')
        .style('stroke', 'transparent')
        .style('stroke-width', `${EDGE_HOVER_HIT_WIDTH}px`)
        .style('fill', 'none')
        .style('cursor', 'pointer')
        .on('mouseenter', function(event: any, d: any) {
            const parent = d3.select(this.parentNode);
            parent.select('.link').style('stroke', EDGE_COLOR_HOVER).style('stroke-width', `${EDGE_HOVER_STROKE_WIDTH}px`);
            showEdgeTooltip(d, event);
        })
        .on('mousemove', function(event: any) {
            updateTooltipPosition(event);
        })
        .on('mouseleave', function() {
            const parent = d3.select(this.parentNode);
            parent.select('.link').style('stroke', null).style('stroke-width', null);
            const tooltip = document.getElementById('edgeTooltip');
            if (tooltip) tooltip.style.display = 'none';
        })
        .on('click', function(event: any, d: any) {
            event.stopPropagation();
            if (d.sourceLocation) {
                state.vscode.postMessage({
                    command: 'openFile',
                    file: d.sourceLocation.file,
                    line: d.sourceLocation.line
                });
            }
        });

    // UPDATE + ENTER: Update all edge paths
    const allGroups = linkGroupSelection.merge(enterGroups);

    const getEdgePath = (d: any) => {
        const elkRoute = findElkEdgeRoute(d._originalSource || d.source, d._originalTarget || d.target, workflowGroups);
        if (elkRoute) {
            return generateElkEdgePath(elkRoute);
        }
        return '';
    };

    allGroups.select('.link').attr('d', getEdgePath);
    allGroups.select('.link-hover').attr('d', getEdgePath);

    state.setLinkSelections(allGroups.select('.link'), allGroups.select('.link-hover'), allGroups);

    // Update edge labels incrementally
    updateEdgeLabelsIncremental(edgesToRender);
}

/**
 * Incrementally update edge labels
 */
function updateEdgeLabelsIncremental(edges: any[]): void {
    const { g, workflowGroups } = state;

    const edgesWithLabels = edges.filter(e => e.label && typeof e.label === 'string');

    // Get or create labels container
    let edgeLabelsContainer = g.select('.edge-labels-container');
    if (edgeLabelsContainer.empty()) {
        edgeLabelsContainer = g.append('g').attr('class', 'edge-labels-container');
    }

    // Data join
    const labelSelection = edgeLabelsContainer.selectAll('.edge-label')
        .data(edgesWithLabels, (d: any) => `${d._originalSource || d.source}->${d._originalTarget || d.target}`);

    // EXIT
    labelSelection.exit().remove();

    // ENTER
    const enterLabels = labelSelection.enter()
        .append('g')
        .attr('class', 'edge-label');

    enterLabels.append('rect')
        .attr('class', 'edge-label-bg')
        .attr('rx', 3)
        .attr('ry', 3)
        .attr('fill', 'var(--vscode-editor-background)')
        .attr('fill-opacity', 0.9)
        .attr('stroke', 'var(--vscode-editorWidget-border)')
        .attr('stroke-width', 1);

    enterLabels.append('text')
        .attr('class', 'edge-label-text')
        .attr('text-anchor', 'middle')
        .attr('dominant-baseline', 'middle')
        .attr('fill', 'var(--vscode-foreground)')
        .attr('font-size', '11px');

    // UPDATE + ENTER
    const allLabels = labelSelection.merge(enterLabels);

    allLabels.attr('transform', (d: any) => {
        const elkRoute = findElkEdgeRoute(
            d._originalSource || d.source,
            d._originalTarget || d.target,
            workflowGroups
        );
        if (elkRoute) {
            const pos = getLabelPositionFromRoute(elkRoute);
            return `translate(${pos.x}, ${pos.y})`;
        }
        return 'translate(0, 0)';
    });

    allLabels.select('text').text((d: any) => d.label);

    // Size background rects
    allLabels.each(function(this: any) {
        const group = d3.select(this);
        const text = group.select('text');
        const textNode = text.node();
        if (textNode) {
            const bbox = textNode.getBBox();
            group.select('rect')
                .attr('x', bbox.x - 4)
                .attr('y', bbox.y - 2)
                .attr('width', bbox.width + 8)
                .attr('height', bbox.height + 4);
        }
    });

    state.setEdgeLabelsState(edgeLabelsContainer, allLabels, edgesWithLabels);
}
