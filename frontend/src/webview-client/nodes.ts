// Node rendering
import * as state from './state';
import { sharedIcon } from './icons';
import { NODE_WIDTH, NODE_HEIGHT, NODE_BORDER_RADIUS } from './constants';
import { intersectRect, intersectDiamond, colorFromString } from './utils';

declare const d3: any;

export function renderNodes(
    dragstarted: (event: any, d: any) => void,
    dragged: (event: any, d: any) => void,
    dragended: (event: any, d: any) => void
): void {
    const { g, expandedNodes, sharedNodeCopies } = state;

    // Use expanded nodes from layout (already includes virtual copies for shared nodes)
    const nodesToRender = expandedNodes;

    // Create container for shared copy arrows BEFORE nodes (so arrows render below)
    const sharedArrowsContainer = g.append('g').attr('class', 'shared-arrows-container');
    state.setSharedArrowsContainer(sharedArrowsContainer);

    // Create nodes
    const node = g.append('g')
        .attr('class', 'nodes-container')
        .selectAll('g')
        .data(nodesToRender)
        .enter()
        .append('g')
        .attr('class', 'node')
        .attr('data-node-id', (d: any) => d.id)
        .call(d3.drag()
            .on('start', dragstarted)
            .on('drag', dragged)
            .on('end', dragended));

    // Add full background fill (dynamic dimensions)
    // LLM nodes: blue, Decision nodes: diamond shape, Title nodes: workflow color, Others: background
    node.each(function(this: SVGGElement, d: any) {
        const group = d3.select(this);
        const w = d.width || NODE_WIDTH;
        const h = d.height || NODE_HEIGHT;

        if (d.type === 'decision') {
            // Short hexagon shape for decision nodes (pointy left/right, flat top/bottom)
            const indent = w * 0.1;  // How far top/bottom edges indent from the points (half as long corners)
            const hexPath = `M ${-w/2 + indent} ${-h/2} L ${w/2 - indent} ${-h/2} L ${w/2} 0 L ${w/2 - indent} ${h/2} L ${-w/2 + indent} ${h/2} L ${-w/2} 0 Z`;
            group.append('path')
                .attr('d', hexPath)
                .style('fill', 'var(--vscode-editor-background)')
                .style('stroke', 'none');
        } else if (d.type === 'workflow-title') {
            // Title nodes: rounded pill with darker workflow color (for white text contrast)
            const workflowColor = colorFromString(d.id.replace('__title_', ''), 65, 35);
            group.append('rect')
                .attr('width', w)
                .attr('height', h)
                .attr('x', -w / 2)
                .attr('y', -h / 2)
                .attr('rx', h / 2)  // Pill shape
                .style('fill', workflowColor)
                .style('stroke', 'none');
        } else {
            // Rectangle for other nodes
            group.append('rect')
                .attr('width', w)
                .attr('height', h)
                .attr('x', -w / 2)
                .attr('y', -h / 2)
                .attr('rx', NODE_BORDER_RADIUS)
                .style('fill', d.type === 'llm' ? '#1976D2' : 'var(--vscode-editor-background)')
                .style('stroke', 'none');
        }
    });

    // Add border (dynamic dimensions)
    node.each(function(this: SVGGElement, d: any) {
        const group = d3.select(this);
        const w = d.width || NODE_WIDTH;
        const h = d.height || NODE_HEIGHT;

        if (d.type === 'decision') {
            // Short hexagon border for decision nodes
            const indent = w * 0.1;
            const hexPath = `M ${-w/2 + indent} ${-h/2} L ${w/2 - indent} ${-h/2} L ${w/2} 0 L ${w/2 - indent} ${h/2} L ${-w/2 + indent} ${h/2} L ${-w/2} 0 Z`;
            group.append('path')
                .attr('class', 'node-border')
                .attr('d', hexPath)
                .style('fill', 'none')
                .style('stroke', 'var(--vscode-editorWidget-border)')
                .style('stroke-width', '2px')
                .style('pointer-events', 'all');
        } else if (d.type === 'workflow-title') {
            // Title nodes: pill border matching darker fill color
            const workflowColor = colorFromString(d.id.replace('__title_', ''), 65, 35);
            group.append('rect')
                .attr('class', 'node-border')
                .attr('width', w)
                .attr('height', h)
                .attr('x', -w / 2)
                .attr('y', -h / 2)
                .attr('rx', h / 2)  // Pill shape
                .style('fill', 'none')
                .style('stroke', workflowColor)
                .style('stroke-width', '2px')
                .style('pointer-events', 'all');
        } else {
            // Rectangle border for other nodes
            group.append('rect')
                .attr('class', 'node-border')
                .attr('width', w)
                .attr('height', h)
                .attr('x', -w / 2)
                .attr('y', -h / 2)
                .attr('rx', NODE_BORDER_RADIUS)
                .style('fill', 'none')
                .style('stroke', 'var(--vscode-editorWidget-border)')
                .style('stroke-width', '2px')
                .style('pointer-events', 'all');
        }
    });

    // Add title centered in node with text wrapping
    // For decision nodes, use _textWidth/_textHeight (the inner usable area)
    const titleWrapper = node.append('foreignObject')
        .attr('x', (d: any) => {
            const textW = d._textWidth || d.width || NODE_WIDTH;
            return -textW / 2 + 4;
        })
        .attr('y', (d: any) => {
            const textH = d._textHeight || d.height || NODE_HEIGHT;
            return -textH / 2 + 4;
        })
        .attr('width', (d: any) => {
            const textW = d._textWidth || d.width || NODE_WIDTH;
            return textW - 8;
        })
        .attr('height', (d: any) => {
            const textH = d._textHeight || d.height || NODE_HEIGHT;
            return textH - 8;
        })
        .append('xhtml:div')
        .attr('class', 'node-title-wrapper')
        .style('width', '100%')
        .style('height', '100%')
        .style('display', 'flex')
        .style('align-items', 'center')
        .style('justify-content', 'center');

    titleWrapper.append('xhtml:span')
        .attr('lang', 'en')
        .style('text-align', 'center')
        .style('color', (d: any) => (d.type === 'llm' || d.type === 'workflow-title') ? '#ffffff' : 'var(--vscode-editor-foreground)')
        .style('font-family', '"DM Sans", "Inter", "Segoe UI", -apple-system, sans-serif')
        .style('font-size', (d: any) => d.type === 'workflow-title' ? '16px' : '15px')
        .style('font-weight', (d: any) => d.type === 'workflow-title' ? '600' : '400')
        .style('letter-spacing', '-0.01em')
        .style('line-height', '1.2')
        .style('word-wrap', 'break-word')
        .style('overflow-wrap', 'break-word')
        .style('hyphens', 'auto')
        .style('-webkit-hyphens', 'auto')
        .text((d: any) => d.label);

    // Add SHARED badge (bottom-left) for shared node copies
    const sharedBadge = node.filter((d: any) => d._originalId != null)
        .append('g')
        .attr('class', 'shared-badge')
        .attr('transform', (d: any) => `translate(${-(d.width || NODE_WIDTH) / 2 + 6}, ${(d.height || NODE_HEIGHT) / 2 - 10}) scale(0.8)`);

    sharedBadge.append('g')
        .attr('class', 'shared-badge-icon')
        .html(sharedIcon);

    sharedBadge.append('text')
        .attr('class', 'shared-badge-text')
        .attr('x', 35)
        .attr('y', 6)
        .attr('dominant-baseline', 'middle')
        .style('font-size', '10px')
        .style('font-weight', '600')
        .style('fill', 'var(--vscode-descriptionForeground)')
        .style('letter-spacing', '0.05em')
        .text('SHARED');

    // Add selection indicator (camera corners) - dynamic based on node dimensions
    const cornerSize = 8;
    node.append('g')
        .attr('class', 'node-selection-indicator')
        .attr('data-node-id', (d: any) => d.id)
        .style('display', 'none')
        .each(function(this: SVGGElement, d: any) {
            const group = d3.select(this);
            const cornerOffsetX = (d.width || NODE_WIDTH) / 2 + 8;
            const cornerOffsetY = (d.height || NODE_HEIGHT) / 2 + 8;
            group.append('path').attr('d', `M -${cornerOffsetX} -${cornerOffsetY - cornerSize} L -${cornerOffsetX} -${cornerOffsetY} L -${cornerOffsetX - cornerSize} -${cornerOffsetY}`);
            group.append('path').attr('d', `M ${cornerOffsetX - cornerSize} -${cornerOffsetY} L ${cornerOffsetX} -${cornerOffsetY} L ${cornerOffsetX} -${cornerOffsetY - cornerSize}`);
            group.append('path').attr('d', `M -${cornerOffsetX} ${cornerOffsetY - cornerSize} L -${cornerOffsetX} ${cornerOffsetY} L -${cornerOffsetX - cornerSize} ${cornerOffsetY}`);
            group.append('path').attr('d', `M ${cornerOffsetX - cornerSize} ${cornerOffsetY} L ${cornerOffsetX} ${cornerOffsetY} L ${cornerOffsetX} ${cornerOffsetY - cornerSize}`);
        });

    // Tooltip on hover
    node.append('title')
        .text((d: any) => {
            let text = `${d.label}\nType: ${d.type}`;
            if (d.description) {
                text += `\n\n${d.description}`;
            }
            return text;
        });

    // Set initial positions
    node.attr('transform', (d: any) => `translate(${d.x},${d.y})`);

    // Add hover behavior for shared nodes to show arrows to copies
    node.filter((d: any) => d._originalId != null)
        .on('mouseenter.sharedArrows', function(event: any, d: any) {
            const copies = sharedNodeCopies.get(d._originalId);
            if (!copies || copies.length < 2) return;

            // Find other copies and draw arrows to them
            copies.filter(vid => vid !== d.id).forEach(otherVid => {
                const otherNode = nodesToRender.find((n: any) => n.id === otherVid);
                if (otherNode && typeof otherNode.x === 'number' && typeof otherNode.y === 'number') {
                    drawSharedCopyArrow(sharedArrowsContainer, d, otherNode);
                }
            });
        })
        .on('mouseleave.sharedArrows', function() {
            sharedArrowsContainer.selectAll('.shared-copy-arrow').remove();
        });

    state.setNode(node);
}

/**
 * Draw a curved dotted arrow between two shared node copies
 */
function drawSharedCopyArrow(container: any, fromNode: any, toNode: any): void {
    // Calculate edge intersection points at node boundaries (use dynamic widths)
    const fromWidth = fromNode.width || NODE_WIDTH;
    const fromHeight = fromNode.height || NODE_HEIGHT;
    const toWidth = toNode.width || NODE_WIDTH;
    const toHeight = toNode.height || NODE_HEIGHT;

    // Use diamond intersection for decision nodes
    const startPoint = fromNode.type === 'decision'
        ? intersectDiamond(toNode, fromNode, fromWidth, fromHeight)
        : intersectRect(toNode, fromNode, fromWidth, fromHeight);
    const endPoint = toNode.type === 'decision'
        ? intersectDiamond(fromNode, toNode, toWidth, toHeight)
        : intersectRect(fromNode, toNode, toWidth, toHeight);

    const dx = endPoint.x - startPoint.x;
    const dy = endPoint.y - startPoint.y;
    const dist = Math.sqrt(dx * dx + dy * dy);

    if (dist < 10) return; // Too close, skip arrow

    // Calculate control point for quadratic bezier (curve outward)
    const midX = (startPoint.x + endPoint.x) / 2;
    const midY = (startPoint.y + endPoint.y) / 2;

    // Perpendicular offset for curve (proportional to distance)
    const curveOffset = Math.min(dist * 0.25, 100);
    const perpX = -dy / dist * curveOffset;
    const perpY = dx / dist * curveOffset;

    const ctrlX = midX + perpX;
    const ctrlY = midY + perpY;

    const path = `M${startPoint.x},${startPoint.y} Q${ctrlX},${ctrlY} ${endPoint.x},${endPoint.y}`;

    container.append('path')
        .attr('class', 'shared-copy-arrow')
        .attr('d', path)
        .attr('marker-end', 'url(#arrowhead)');
}

/**
 * Update shared copy arrows during drag (if any are visible)
 */
export function updateSharedArrows(draggedNode: any): void {
    const { sharedArrowsContainer, sharedNodeCopies, expandedNodes } = state;
    if (!sharedArrowsContainer || !draggedNode._originalId) return;

    // Clear existing arrows
    sharedArrowsContainer.selectAll('.shared-copy-arrow').remove();

    // Get all copies of this shared node
    const copies = sharedNodeCopies.get(draggedNode._originalId);
    if (!copies || copies.length < 2) return;

    // Check if we're hovering on this node (arrows should be visible)
    const nodeElement = document.querySelector(`.node[data-node-id="${draggedNode.id}"]`);
    if (!nodeElement?.matches(':hover')) return;

    // Redraw arrows to other copies
    copies.filter(vid => vid !== draggedNode.id).forEach(otherVid => {
        const otherNode = expandedNodes.find((n: any) => n.id === otherVid);
        if (otherNode && typeof otherNode.x === 'number' && typeof otherNode.y === 'number') {
            drawSharedCopyArrow(sharedArrowsContainer, draggedNode, otherNode);
        }
    });
}

/**
 * Pulse animation for newly added nodes
 */
export function pulseNodes(nodeIds: string[]): void {
    nodeIds.forEach(id => {
        d3.select(`.node[data-node-id="${id}"]`)
            .transition().duration(200)
            .style('opacity', 0.3)
            .transition().duration(400)
            .style('opacity', 1)
            .transition().duration(200)
            .style('opacity', 0.3)
            .transition().duration(400)
            .style('opacity', 1);
    });
}

/**
 * Hydrate node labels after metadata is fetched.
 * Smoothly updates labels without re-rendering the entire graph.
 *
 * @param labelUpdates Map of nodeId → new label
 */
export function hydrateLabels(labelUpdates: Map<string, string>): void {
    labelUpdates.forEach((newLabel, nodeId) => {
        const nodeElement = d3.select(`.node[data-node-id="${nodeId}"]`);
        if (!nodeElement.empty()) {
            // Update the text span with smooth fade
            nodeElement.select('.node-title-wrapper span')
                .transition()
                .duration(150)
                .style('opacity', 0.5)
                .transition()
                .duration(150)
                .style('opacity', 1)
                .text(newLabel);

            // Also update the data binding for consistency
            const nodeData = nodeElement.datum() as any;
            if (nodeData) {
                nodeData.label = newLabel;
            }
        }
    });
}

/**
 * Mark nodes as "syncing" (waiting for metadata).
 * Shows a subtle indicator that metadata is being fetched.
 *
 * @param nodeIds Array of node IDs to mark as syncing
 */
export function markNodesSyncing(nodeIds: string[]): void {
    nodeIds.forEach(id => {
        const nodeElement = d3.select(`.node[data-node-id="${id}"]`);
        if (!nodeElement.empty()) {
            // Add subtle opacity pulse to indicate loading
            nodeElement.classed('syncing', true);
            nodeElement.select('.node-title-wrapper span')
                .style('opacity', 0.7);
        }
    });
}

/**
 * Clear syncing state from nodes.
 *
 * @param nodeIds Array of node IDs to clear syncing state
 */
export function clearNodesSyncing(nodeIds: string[]): void {
    nodeIds.forEach(id => {
        const nodeElement = d3.select(`.node[data-node-id="${id}"]`);
        if (!nodeElement.empty()) {
            nodeElement.classed('syncing', false);
            nodeElement.select('.node-title-wrapper span')
                .transition()
                .duration(150)
                .style('opacity', 1);
        }
    });
}

/**
 * Get all node IDs that match the given file path and optionally specific functions
 */
export function getNodesByFileAndFunctions(filePath: string, functions?: string[]): string[] {
    const { currentGraphData } = state;
    if (!currentGraphData?.nodes) return [];

    return currentGraphData.nodes
        .filter(node => {
            if (node.source?.file !== filePath) return false;
            // If no functions specified, don't match any (require explicit function list)
            if (!functions || functions.length === 0) return false;
            // Match if node's function is in the changed list
            return functions.includes(node.source.function);
        })
        .map(node => node.id);
}

/**
 * Apply file change state CSS class to nodes matching the given file path and functions
 */
export function applyFileChangeState(
    filePath: string,
    functions: string[] | undefined,
    changeState: 'active' | 'changed' | 'unchanged'
): void {
    // For 'unchanged', clear all indicators for this file regardless of functions
    if (changeState === 'unchanged') {
        const { currentGraphData } = state;
        if (!currentGraphData?.nodes) return;

        const allFileNodeIds = currentGraphData.nodes
            .filter(node => node.source?.file === filePath)
            .map(node => node.id);

        allFileNodeIds.forEach(nodeId => {
            const border = document.querySelector(`.node[data-node-id="${nodeId}"] .node-border`);
            if (border) {
                border.classList.remove('file-active', 'file-changed');
            }
            const minimapNode = document.querySelector(`.minimap-node[data-node-id="${nodeId}"]`);
            if (minimapNode) {
                minimapNode.classList.remove('file-active', 'file-changed');
            }
        });
        return;
    }

    // For 'active' or 'changed', only apply to specific functions
    const nodeIds = getNodesByFileAndFunctions(filePath, functions);

    nodeIds.forEach(nodeId => {
        const border = document.querySelector(`.node[data-node-id="${nodeId}"] .node-border`);
        if (!border) return;

        // Remove existing file state classes
        border.classList.remove('file-active', 'file-changed');

        // Apply new state
        if (changeState === 'active') {
            border.classList.add('file-active');
        } else if (changeState === 'changed') {
            border.classList.add('file-changed');
        }
    });

    // Also update minimap nodes
    nodeIds.forEach(nodeId => {
        const minimapNode = document.querySelector(`.minimap-node[data-node-id="${nodeId}"]`);
        if (!minimapNode) return;

        minimapNode.classList.remove('file-active', 'file-changed');
        if (changeState === 'active') {
            minimapNode.classList.add('file-active');
        } else if (changeState === 'changed') {
            minimapNode.classList.add('file-changed');
        }
    });
}

/**
 * Clear all file change indicators from all nodes
 */
export function clearFileChangeIndicators(): void {
    document.querySelectorAll('.node-border.file-active, .node-border.file-changed')
        .forEach(el => {
            el.classList.remove('file-active', 'file-changed');
        });
    document.querySelectorAll('.minimap-node.file-active, .minimap-node.file-changed')
        .forEach(el => {
            el.classList.remove('file-active', 'file-changed');
        });
}

/**
 * Helper to create a single node element with all its structure.
 * Extracted from renderNodes for reuse in incremental updates.
 */
function createNodeElement(nodeGroup: any, d: any, sharedNodeCopies: Map<string, string[]>): void {
    const w = d.width || NODE_WIDTH;
    const h = d.height || NODE_HEIGHT;

    // Add background fill
    if (d.type === 'decision') {
        const indent = w * 0.1;
        const hexPath = `M ${-w/2 + indent} ${-h/2} L ${w/2 - indent} ${-h/2} L ${w/2} 0 L ${w/2 - indent} ${h/2} L ${-w/2 + indent} ${h/2} L ${-w/2} 0 Z`;
        nodeGroup.append('path')
            .attr('d', hexPath)
            .style('fill', 'var(--vscode-editor-background)')
            .style('stroke', 'none');
    } else if (d.type === 'workflow-title') {
        const workflowColor = colorFromString(d.id.replace('__title_', ''), 65, 35);
        nodeGroup.append('rect')
            .attr('width', w)
            .attr('height', h)
            .attr('x', -w / 2)
            .attr('y', -h / 2)
            .attr('rx', h / 2)
            .style('fill', workflowColor)
            .style('stroke', 'none');
    } else {
        nodeGroup.append('rect')
            .attr('width', w)
            .attr('height', h)
            .attr('x', -w / 2)
            .attr('y', -h / 2)
            .attr('rx', NODE_BORDER_RADIUS)
            .style('fill', d.type === 'llm' ? '#1976D2' : 'var(--vscode-editor-background)')
            .style('stroke', 'none');
    }

    // Add border
    if (d.type === 'decision') {
        const indent = w * 0.1;
        const hexPath = `M ${-w/2 + indent} ${-h/2} L ${w/2 - indent} ${-h/2} L ${w/2} 0 L ${w/2 - indent} ${h/2} L ${-w/2 + indent} ${h/2} L ${-w/2} 0 Z`;
        nodeGroup.append('path')
            .attr('class', 'node-border')
            .attr('d', hexPath)
            .style('fill', 'none')
            .style('stroke', 'var(--vscode-editorWidget-border)')
            .style('stroke-width', '2px')
            .style('pointer-events', 'all');
    } else if (d.type === 'workflow-title') {
        const workflowColor = colorFromString(d.id.replace('__title_', ''), 65, 35);
        nodeGroup.append('rect')
            .attr('class', 'node-border')
            .attr('width', w)
            .attr('height', h)
            .attr('x', -w / 2)
            .attr('y', -h / 2)
            .attr('rx', h / 2)
            .style('fill', 'none')
            .style('stroke', workflowColor)
            .style('stroke-width', '2px')
            .style('pointer-events', 'all');
    } else {
        nodeGroup.append('rect')
            .attr('class', 'node-border')
            .attr('width', w)
            .attr('height', h)
            .attr('x', -w / 2)
            .attr('y', -h / 2)
            .attr('rx', NODE_BORDER_RADIUS)
            .style('fill', 'none')
            .style('stroke', 'var(--vscode-editorWidget-border)')
            .style('stroke-width', '2px')
            .style('pointer-events', 'all');
    }

    // Add title
    const textW = d._textWidth || d.width || NODE_WIDTH;
    const textH = d._textHeight || d.height || NODE_HEIGHT;
    const titleWrapper = nodeGroup.append('foreignObject')
        .attr('x', -textW / 2 + 4)
        .attr('y', -textH / 2 + 4)
        .attr('width', textW - 8)
        .attr('height', textH - 8)
        .append('xhtml:div')
        .attr('class', 'node-title-wrapper')
        .style('width', '100%')
        .style('height', '100%')
        .style('display', 'flex')
        .style('align-items', 'center')
        .style('justify-content', 'center');

    titleWrapper.append('xhtml:span')
        .attr('lang', 'en')
        .style('text-align', 'center')
        .style('color', (d.type === 'llm' || d.type === 'workflow-title') ? '#ffffff' : 'var(--vscode-editor-foreground)')
        .style('font-family', '"DM Sans", "Inter", "Segoe UI", -apple-system, sans-serif')
        .style('font-size', d.type === 'workflow-title' ? '16px' : '15px')
        .style('font-weight', d.type === 'workflow-title' ? '600' : '400')
        .style('letter-spacing', '-0.01em')
        .style('line-height', '1.2')
        .style('word-wrap', 'break-word')
        .style('overflow-wrap', 'break-word')
        .style('hyphens', 'auto')
        .style('-webkit-hyphens', 'auto')
        .text(d.label);

    // Add SHARED badge for shared node copies
    if (d._originalId != null) {
        const sharedBadge = nodeGroup.append('g')
            .attr('class', 'shared-badge')
            .attr('transform', `translate(${-w / 2 + 6}, ${h / 2 - 10}) scale(0.8)`);

        sharedBadge.append('g')
            .attr('class', 'shared-badge-icon')
            .html(sharedIcon);

        sharedBadge.append('text')
            .attr('class', 'shared-badge-text')
            .attr('x', 35)
            .attr('y', 6)
            .attr('dominant-baseline', 'middle')
            .style('font-size', '10px')
            .style('font-weight', '600')
            .style('fill', 'var(--vscode-descriptionForeground)')
            .style('letter-spacing', '0.05em')
            .text('SHARED');
    }

    // Add selection indicator
    const cornerSize = 8;
    const selIndicator = nodeGroup.append('g')
        .attr('class', 'node-selection-indicator')
        .attr('data-node-id', d.id)
        .style('display', 'none');

    const cornerOffsetX = w / 2 + 8;
    const cornerOffsetY = h / 2 + 8;
    selIndicator.append('path').attr('d', `M -${cornerOffsetX} -${cornerOffsetY - cornerSize} L -${cornerOffsetX} -${cornerOffsetY} L -${cornerOffsetX - cornerSize} -${cornerOffsetY}`);
    selIndicator.append('path').attr('d', `M ${cornerOffsetX - cornerSize} -${cornerOffsetY} L ${cornerOffsetX} -${cornerOffsetY} L ${cornerOffsetX} -${cornerOffsetY - cornerSize}`);
    selIndicator.append('path').attr('d', `M -${cornerOffsetX} ${cornerOffsetY - cornerSize} L -${cornerOffsetX} ${cornerOffsetY} L -${cornerOffsetX - cornerSize} ${cornerOffsetY}`);
    selIndicator.append('path').attr('d', `M ${cornerOffsetX - cornerSize} ${cornerOffsetY} L ${cornerOffsetX} ${cornerOffsetY} L ${cornerOffsetX} ${cornerOffsetY - cornerSize}`);

    // Add tooltip
    nodeGroup.append('title')
        .text(() => {
            let text = `${d.label}\nType: ${d.type}`;
            if (d.description) {
                text += `\n\n${d.description}`;
            }
            return text;
        });
}

/**
 * Incrementally update nodes without destroying existing DOM elements.
 * Uses D3 enter/update/exit pattern to minimize DOM operations.
 */
export function updateNodesIncremental(
    dragstarted: (event: any, d: any) => void,
    dragged: (event: any, d: any) => void,
    dragended: (event: any, d: any) => void
): void {
    const { g, expandedNodes, sharedNodeCopies } = state;

    // Get or create the nodes container
    let nodesContainer = g.select('.nodes-container');
    if (nodesContainer.empty()) {
        // Also need shared arrows container
        const sharedArrowsContainer = g.append('g').attr('class', 'shared-arrows-container');
        state.setSharedArrowsContainer(sharedArrowsContainer);
        nodesContainer = g.append('g').attr('class', 'nodes-container');
    }

    // Data join with key function
    const nodeSelection = nodesContainer.selectAll('.node')
        .data(expandedNodes, (d: any) => d.id);

    // EXIT: Remove nodes that no longer exist
    nodeSelection.exit().remove();

    // ENTER: Create new nodes
    const enterNodes = nodeSelection.enter()
        .append('g')
        .attr('class', 'node')
        .attr('data-node-id', (d: any) => d.id)
        .call(d3.drag()
            .on('start', dragstarted)
            .on('drag', dragged)
            .on('end', dragended));

    // Build each new node's internal structure
    enterNodes.each(function(this: SVGGElement, d: any) {
        createNodeElement(d3.select(this), d, sharedNodeCopies);
    });

    // Add hover behavior for shared nodes (enter only)
    const { sharedArrowsContainer } = state;
    enterNodes.filter((d: any) => d._originalId != null)
        .on('mouseenter.sharedArrows', function(event: any, d: any) {
            const copies = sharedNodeCopies.get(d._originalId);
            if (!copies || copies.length < 2) return;
            copies.filter(vid => vid !== d.id).forEach(otherVid => {
                const otherNode = expandedNodes.find((n: any) => n.id === otherVid);
                if (otherNode && typeof otherNode.x === 'number' && typeof otherNode.y === 'number') {
                    drawSharedCopyArrow(sharedArrowsContainer, d, otherNode);
                }
            });
        })
        .on('mouseleave.sharedArrows', function() {
            sharedArrowsContainer.selectAll('.shared-copy-arrow').remove();
        });

    // UPDATE + ENTER: Update positions on all nodes
    const allNodes = nodeSelection.merge(enterNodes);
    allNodes.attr('transform', (d: any) => `translate(${d.x},${d.y})`);

    state.setNode(allNodes);
}
