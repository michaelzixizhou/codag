// Node rendering
import * as state from './state';
import { getNodeIcon, sharedIcon } from './icons';
import { TYPE_COLORS, NODE_WIDTH, NODE_HEIGHT, NODE_HALF_WIDTH, NODE_HALF_HEIGHT, NODE_BORDER_RADIUS, NODE_ICON_SCALE } from './constants';
import { intersectRect } from './utils';

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

    // Add full background fill
    node.append('rect')
        .attr('width', NODE_WIDTH)
        .attr('height', NODE_HEIGHT)
        .attr('x', -NODE_HALF_WIDTH)
        .attr('y', -NODE_HALF_HEIGHT)
        .attr('rx', NODE_BORDER_RADIUS)
        .style('fill', 'var(--vscode-editor-background)')
        .style('stroke', 'none');

    // Add dark header background (top 30px, rounded top corners)
    node.append('path')
        .attr('class', 'node-header')
        .attr('d', 'M -66,-61 L 66,-61 A 4,4 0 0,1 70,-57 L 70,-31 L -70,-31 L -70,-57 A 4,4 0 0,1 -66,-61 Z')
        .style('fill', 'var(--vscode-editor-background)')
        .style('stroke', 'none');

    // Add grey body background (bottom 92px, rounded bottom corners)
    node.append('path')
        .attr('class', 'node-body')
        .attr('d', 'M -70,-31 L 70,-31 L 70,57 A 4,4 0 0,1 66,61 L -66,61 A 4,4 0 0,1 -70,57 Z')
        .style('fill', 'color-mix(in srgb, var(--vscode-editor-background) 92%, var(--vscode-editor-foreground))')
        .style('stroke', 'none');

    // Add type-colored border
    node.append('rect')
        .attr('class', 'node-border')
        .attr('width', NODE_WIDTH)
        .attr('height', NODE_HEIGHT)
        .attr('x', -NODE_HALF_WIDTH)
        .attr('y', -NODE_HALF_HEIGHT)
        .attr('rx', NODE_BORDER_RADIUS)
        .style('fill', 'none')
        .style('stroke', (d: any) => TYPE_COLORS[d.type] || '#90A4AE')
        .style('stroke-width', '2px')
        .style('pointer-events', 'all');

    // Add title centered in body with text wrapping and 3-line clamp
    // Body spans from y=-31 (header bottom) to y=+61 (node bottom) = 92px
    // 5px padding matches horizontal, -1px shift up for visual alignment
    // Outer div: flexbox for centering, inner span: line-clamp for truncation
    const titleWrapper = node.append('foreignObject')
        .attr('x', -65)
        .attr('y', -27)
        .attr('width', 130)
        .attr('height', 83)
        .append('xhtml:div')
        .attr('class', 'node-title-wrapper')
        .style('width', '100%')
        .style('height', '100%')
        .style('display', 'flex')
        .style('align-items', 'center')
        .style('justify-content', 'center');

    titleWrapper.append('xhtml:span')
        .attr('lang', 'en')
        .style('display', '-webkit-box')
        .style('-webkit-line-clamp', '3')
        .style('-webkit-box-orient', 'vertical')
        .style('overflow', 'hidden')
        .style('text-align', 'center')
        .style('color', 'var(--vscode-editor-foreground)')
        .style('font-family', '"DM Sans", "Inter", "Segoe UI", -apple-system, sans-serif')
        .style('font-size', '17px')
        .style('font-weight', '400')
        .style('letter-spacing', '-0.01em')
        .style('line-height', '1.35')
        .style('word-wrap', 'break-word')
        .style('hyphens', 'auto')
        .style('-webkit-hyphens', 'auto')
        .text((d: any) => d.label);

    // Add icon at top-left of header (centered vertically with type label)
    node.append('g')
        .attr('class', (d: any) => `node-icon ${d.type}`)
        .attr('transform', `translate(-62, -55) scale(${NODE_ICON_SCALE})`)
        .html((d: any) => getNodeIcon(d.type));

    // Add node type label next to icon in header
    node.append('text')
        .attr('class', 'node-type')
        .text((d: any) => d.type.toUpperCase())
        .attr('x', -38)
        .attr('y', -43)
        .attr('dominant-baseline', 'middle')
        .style('text-anchor', 'start');

    // Add entry icon (top-right, green door with arrow in)
    node.filter((d: any) => d.isEntryPoint)
        .append('g')
        .attr('class', 'entry-icon')
        .attr('transform', 'translate(52, -52) scale(0.7)')
        .html('<svg viewBox="0 0 24 24" width="20" height="20"><path d="M15 3h4a2 2 0 0 1 2 2v14a2 2 0 0 1-2 2h-4M10 17l5-5-5-5M13.8 12H3" stroke="#4CAF50" stroke-width="2.5" fill="none" stroke-linecap="round" stroke-linejoin="round"/></svg>');

    // Add exit icon (top-right, red door with arrow out)
    node.filter((d: any) => d.isExitPoint)
        .append('g')
        .attr('class', 'exit-icon')
        .attr('transform', (d: any) => d.isEntryPoint ? 'translate(32, -52) scale(0.7)' : 'translate(52, -52) scale(0.7)')
        .html('<svg viewBox="0 0 24 24" width="20" height="20"><path d="M9 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h4M16 17l5-5-5-5M21 12H9" stroke="#f44336" stroke-width="2.5" fill="none" stroke-linecap="round" stroke-linejoin="round"/></svg>');

    // Add SHARED badge (bottom-left) for shared node copies
    const sharedBadge = node.filter((d: any) => d._originalId != null)
        .append('g')
        .attr('class', 'shared-badge')
        .attr('transform', 'translate(-62, 47)');

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

    // Add selection indicator (camera corners)
    const cornerSize = 8;
    const cornerOffsetX = 78;
    const cornerOffsetY = 69;
    node.append('g')
        .attr('class', 'node-selection-indicator')
        .attr('data-node-id', (d: any) => d.id)
        .style('display', 'none')
        .each(function(this: SVGGElement) {
            const group = d3.select(this);
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
    node.attr('transform', (d: any) => {
        if (d._originalId != null) {
            console.log(`[RENDER] Shared node ${d.id} rendered at (${d.x}, ${d.y})`);
        }
        return `translate(${d.x},${d.y})`;
    });

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
    // Calculate edge intersection points at node boundaries
    const startPoint = intersectRect(toNode, fromNode, NODE_WIDTH, NODE_HEIGHT);
    const endPoint = intersectRect(fromNode, toNode, NODE_WIDTH, NODE_HEIGHT);

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
