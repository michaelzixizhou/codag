// Edge rendering and hover effects
import * as state from './state';
import { generateEdgePath, getNodeOrCollapsedGroup, getVirtualNodeId, getNodeWorkflowCount, getOriginalNodeId } from './utils';
import {
    NODE_WIDTH, NODE_HEIGHT,
    EDGE_STROKE_WIDTH, EDGE_HOVER_STROKE_WIDTH, EDGE_HOVER_HIT_WIDTH,
    EDGE_COLOR_HOVER,
    COLLAPSED_COMPONENT_WIDTH, COLLAPSED_COMPONENT_HEIGHT
} from './constants';
import { getWorkflowNodeIds, getNodeDimensions, findReverseEdge, getBidirectionalEdgeKey, positionTooltipNearMouse } from './helpers';
import { WorkflowComponent, WorkflowGroup } from './types';

declare const d3: any;

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

    // Filter edges to only those where BOTH nodes are rendered
    const baseEdges = currentGraphData.edges.filter((e: any) =>
        allWorkflowNodeIds.has(e.source) && allWorkflowNodeIds.has(e.target)
    );

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
            // Neither endpoint is shared - transform for components if needed
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

    // Create container for edge paths
    const edgePathsContainer = g.append('g').attr('class', 'edge-paths-container');
    state.setEdgePathsContainer(edgePathsContainer);

    // Create edge path groups
    const linkGroup = edgePathsContainer
        .selectAll('g')
        .data(edgesToRender)
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
            const index = edgesToRender.indexOf(d);
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
            const index = edgesToRender.indexOf(d);
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

    // Helper to find node by ID (check component placeholders, expanded nodes, then original)
    const findNode = (nodeId: string) => {
        // Check if this is a component placeholder
        if (nodeId.startsWith('__comp_')) {
            const compId = nodeId.replace('__comp_', '');
            // Find the component in workflow groups
            for (const group of workflowGroups) {
                for (const comp of (group.components || [])) {
                    if (comp.id === compId && comp.centerX !== undefined && comp.centerY !== undefined) {
                        return {
                            id: nodeId,
                            x: comp.centerX,
                            y: comp.centerY,
                            _isComponentPlaceholder: true,
                            _componentWidth: COLLAPSED_COMPONENT_WIDTH,
                            _componentHeight: COLLAPSED_COMPONENT_HEIGHT
                        };
                    }
                }
            }
        }

        // Check expanded nodes (includes virtual copies)
        const expanded = state.expandedNodes.find((n: any) => n.id === nodeId);
        if (expanded && typeof expanded.x === 'number' && !isNaN(expanded.x)) return expanded;

        // Check original nodes
        const original = currentGraphData.nodes.find((n: any) => n.id === nodeId);
        if (original && typeof original.x === 'number' && !isNaN(original.x)) return original;

        // For virtual IDs (node__workflow), try original ID
        const baseId = nodeId.includes('__') ? nodeId.split('__')[0] : null;
        if (baseId) {
            const baseNode = state.expandedNodes.find((n: any) => n.id === baseId)
                || currentGraphData.nodes.find((n: any) => n.id === baseId);
            if (baseNode && typeof baseNode.x === 'number' && !isNaN(baseNode.x)) return baseNode;
        }

        console.warn(`[edges] Node not found: ${nodeId}`);
        return null;
    };

    // Set initial edge paths
    link.attr('d', (d: any) => {
        const sourceNode = findNode(d.source);
        const targetNode = findNode(d.target);
        if (!sourceNode || !targetNode) return '';
        // Use component dimensions if applicable
        const sourceWidth = sourceNode._componentWidth || NODE_WIDTH;
        const sourceHeight = sourceNode._componentHeight || NODE_HEIGHT;
        const targetWidth = targetNode._componentWidth || NODE_WIDTH;
        const targetHeight = targetNode._componentHeight || NODE_HEIGHT;
        return generateEdgePath(d, sourceNode, targetNode, workflowGroups, targetWidth, targetHeight, sourceWidth, sourceHeight, allEdges);
    });

    linkHover.attr('d', (d: any) => {
        const sourceNode = findNode(d.source);
        const targetNode = findNode(d.target);
        if (!sourceNode || !targetNode) return '';
        const sourceWidth = sourceNode._componentWidth || NODE_WIDTH;
        const sourceHeight = sourceNode._componentHeight || NODE_HEIGHT;
        const targetWidth = targetNode._componentWidth || NODE_WIDTH;
        const targetHeight = targetNode._componentHeight || NODE_HEIGHT;
        return generateEdgePath(d, sourceNode, targetNode, workflowGroups, targetWidth, targetHeight, sourceWidth, sourceHeight, allEdges);
    });

    state.setLinkSelections(link, linkHover, linkGroup);
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
    html += `<div><strong>Variable:</strong> ${edge.label || 'N/A'}</div>`;
    if (edge.dataType) html += `<div><strong>Type:</strong> ${edge.dataType}</div>`;
    if (edge.description) html += `<div><strong>Description:</strong> ${edge.description}</div>`;
    if (edge.sourceLocation) {
        html += `<div><strong>Location:</strong> ${edge.sourceLocation.file.split('/').pop()}:${edge.sourceLocation.line}</div>`;
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

export function updateEdgePaths(): void {
    const { link, linkHover, currentGraphData, workflowGroups, expandedNodes } = state;

    // Helper to find node (check component placeholders, expanded nodes, then collapsed groups)
    const getNode = (nodeId: string) => {
        // Check if this is a component placeholder
        if (nodeId.startsWith('__comp_')) {
            const compId = nodeId.replace('__comp_', '');
            for (const group of workflowGroups) {
                for (const comp of (group.components || [])) {
                    if (comp.id === compId && comp.centerX !== undefined && comp.centerY !== undefined) {
                        return {
                            id: nodeId,
                            x: comp.centerX,
                            y: comp.centerY,
                            _isComponentPlaceholder: true,
                            _componentWidth: COLLAPSED_COMPONENT_WIDTH,
                            _componentHeight: COLLAPSED_COMPONENT_HEIGHT
                        };
                    }
                }
            }
        }

        // First check expanded nodes
        const expanded = expandedNodes.find((n: any) => n.id === nodeId);
        if (expanded && typeof expanded.x === 'number' && !isNaN(expanded.x)) return expanded;
        // Then check collapsed groups and original nodes
        const node = getNodeOrCollapsedGroup(nodeId, currentGraphData.nodes, workflowGroups);
        if (node && typeof node.x === 'number' && !isNaN(node.x)) return node;
        return null;
    };

    link.attr('d', function(l: any) {
        const sourceNode = getNode(l.source);
        const targetNode = getNode(l.target);
        if (!sourceNode || !targetNode) return '';
        const { width: targetWidth, height: targetHeight } = getNodeDimensions(targetNode);
        const { width: sourceWidth, height: sourceHeight } = getNodeDimensions(sourceNode);
        return generateEdgePath(l, sourceNode, targetNode, workflowGroups, targetWidth, targetHeight, sourceWidth, sourceHeight, currentGraphData.edges);
    });

    linkHover.attr('d', function(l: any) {
        const sourceNode = getNode(l.source);
        const targetNode = getNode(l.target);
        if (!sourceNode || !targetNode) return '';
        const { width: targetWidth, height: targetHeight } = getNodeDimensions(targetNode);
        const { width: sourceWidth, height: sourceHeight } = getNodeDimensions(sourceNode);
        return generateEdgePath(l, sourceNode, targetNode, workflowGroups, targetWidth, targetHeight, sourceWidth, sourceHeight, currentGraphData.edges);
    });
}
