// Minimap rendering
import * as state from './state';
import {
    NODE_WIDTH, NODE_HEIGHT, NODE_HALF_WIDTH, NODE_HALF_HEIGHT,
    TRANSITION_FAST, MINIMAP_PADDING
} from './constants';

declare const d3: any;

export function renderMinimap(): void {
    const { currentGraphData, workflowGroups, svg, zoom } = state;
    const minimapContainer = document.getElementById('minimap');
    if (!minimapContainer) return;

    // Read dimensions from CSS (responsive)
    const minimapWidth = minimapContainer.clientWidth || 200;
    const minimapHeight = minimapContainer.clientHeight || 150;

    // Clear existing minimap
    minimapContainer.innerHTML = '';

    // Create minimap SVG
    const minimapSvg = d3.select('#minimap')
        .append('svg')
        .attr('width', minimapWidth)
        .attr('height', minimapHeight);

    const minimapG = minimapSvg.append('g');

    if (currentGraphData.nodes.length === 0) return;

    const nodesWithPositions = currentGraphData.nodes.filter((n: any) => !isNaN(n.x) && !isNaN(n.y));
    if (nodesWithPositions.length === 0) return;

    const xs = nodesWithPositions.map((n: any) => n.x);
    const ys = nodesWithPositions.map((n: any) => n.y);
    const minX = Math.min(...xs) - NODE_HALF_WIDTH;
    const maxX = Math.max(...xs) + NODE_HALF_WIDTH;
    const minY = Math.min(...ys) - NODE_HEIGHT;
    const maxY = Math.max(...ys) + NODE_HEIGHT / 2;

    const graphWidth = maxX - minX;
    const graphHeight = maxY - minY;

    if (graphWidth <= 0 || graphHeight <= 0 || !isFinite(graphWidth) || !isFinite(graphHeight)) {
        return;
    }

    const scale = Math.min(
        (minimapWidth - MINIMAP_PADDING * 2) / graphWidth,
        (minimapHeight - MINIMAP_PADDING * 2) / graphHeight
    );

    if (!isFinite(scale) || scale <= 0) return;

    const scaledWidth = graphWidth * scale;
    const scaledHeight = graphHeight * scale;
    const offsetX = (minimapWidth - scaledWidth) / 2;
    const offsetY = (minimapHeight - scaledHeight) / 2;

    const toMinimapX = (x: number) => (x - minX) * scale + offsetX;
    const toMinimapY = (y: number) => (y - minY) * scale + offsetY;

    // Render workflow groups as rectangles
    workflowGroups.forEach((group: any) => {
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
    currentGraphData.edges.forEach((edge: any) => {
        const sourceNode = currentGraphData.nodes.find((n: any) => n.id === edge.source);
        const targetNode = currentGraphData.nodes.find((n: any) => n.id === edge.target);

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

    // Render nodes
    currentGraphData.nodes.forEach((node: any) => {
        if (!isNaN(node.x) && !isNaN(node.y)) {
            minimapG.append('circle')
                .attr('class', `minimap-node ${node.type}`)
                .attr('cx', toMinimapX(node.x))
                .attr('cy', toMinimapY(node.y))
                .attr('r', 3)
                .attr('data-node-id', node.id);
        }
    });

    // Add viewport rectangle
    const minimapViewportRect = minimapG.append('rect')
        .attr('class', 'minimap-viewport');

    // Store transform info on the svg element
    minimapSvg.minimapScale = scale;
    minimapSvg.minimapOffsetX = offsetX;
    minimapSvg.minimapOffsetY = offsetY;
    minimapSvg.minimapMinX = minX;
    minimapSvg.minimapMinY = minY;

    state.setMinimapState(minimapSvg, minimapViewportRect);

    // Update viewport rectangle
    updateMinimapViewport();

    // Click to navigate
    minimapSvg.on('click', function(event: any) {
        const [mx, my] = d3.pointer(event);
        const graphX = (mx - offsetX) / scale + minX;
        const graphY = (my - offsetY) / scale + minY;

        const currentTransform = d3.zoomTransform(svg.node());
        const container = document.getElementById('graph');
        if (!container) return;

        const currentWidth = container.clientWidth;
        const currentHeight = container.clientHeight;

        const newTranslate = [
            currentWidth / 2 - currentTransform.k * graphX,
            currentHeight / 2 - currentTransform.k * graphY
        ];

        svg.transition().duration(TRANSITION_FAST).call(
            zoom.transform,
            d3.zoomIdentity.translate(newTranslate[0], newTranslate[1]).scale(currentTransform.k)
        );
    });
}

export function updateMinimapViewport(): void {
    const { minimapViewportRect, minimapSvg, svg } = state;
    if (!minimapViewportRect || !minimapSvg) return;

    const currentTransform = d3.zoomTransform(svg.node());
    const scale = minimapSvg.minimapScale;
    const offsetX = minimapSvg.minimapOffsetX;
    const offsetY = minimapSvg.minimapOffsetY;
    const minX = minimapSvg.minimapMinX;
    const minY = minimapSvg.minimapMinY;

    if (scale === undefined || offsetX === undefined || offsetY === undefined ||
        minX === undefined || minY === undefined ||
        !isFinite(scale) || !isFinite(offsetX) || !isFinite(offsetY) ||
        !isFinite(minX) || !isFinite(minY)) {
        return;
    }

    const container = document.getElementById('graph');
    if (!container) return;

    const width = container.clientWidth;
    const height = container.clientHeight;

    const viewportX = -currentTransform.x / currentTransform.k;
    const viewportY = -currentTransform.y / currentTransform.k;
    const viewportWidth = width / currentTransform.k;
    const viewportHeight = height / currentTransform.k;

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

export function setupMinimapZoomListener(): void {
    const { zoom, vscode, currentGraphData, workflowGroups } = state;

    let minimapUpdatePending = false;
    let viewportUpdateTimeout: ReturnType<typeof setTimeout> | null = null;
    const VIEWPORT_UPDATE_DELAY = 150;

    zoom.on('zoom.minimap', () => {
        if (!minimapUpdatePending) {
            minimapUpdatePending = true;
            requestAnimationFrame(() => {
                updateMinimapViewport();
                minimapUpdatePending = false;
            });
        }

        // Debounced viewport tracking
        if (viewportUpdateTimeout) {
            clearTimeout(viewportUpdateTimeout);
        }
        viewportUpdateTimeout = setTimeout(() => {
            updateVisibleNodes();
            viewportUpdateTimeout = null;
        }, VIEWPORT_UPDATE_DELAY);
    });

    function updateVisibleNodes(): void {
        const { svg, currentGraphData, workflowGroups } = state;
        const container = document.getElementById('graph');
        if (!container) return;

        const width = container.clientWidth;
        const height = container.clientHeight;
        const currentTransform = d3.zoomTransform(svg.node());

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

        const visibleNodeIds = currentGraphData.nodes
            .filter((node: any) => {
                const inCollapsedGroup = workflowGroups.some((g: any) => g.collapsed && g.nodes.includes(node.id));
                if (inCollapsedGroup) return false;

                const nodeLeft = node.x - NODE_HALF_WIDTH;
                const nodeRight = node.x + NODE_HALF_WIDTH;
                const nodeTop = node.y - NODE_HALF_HEIGHT / 2;
                const nodeBottom = node.y + NODE_HALF_HEIGHT / 2;

                return !(nodeRight < viewportBounds.left ||
                        nodeLeft > viewportBounds.right ||
                        nodeBottom < viewportBounds.top ||
                        nodeTop > viewportBounds.bottom);
            })
            .map((node: any) => node.id);

        vscode.postMessage({
            command: 'viewportChanged',
            visibleNodeIds: visibleNodeIds
        });
    }
}

/**
 * Pulse animation for newly added nodes on minimap
 */
export function pulseMinimapNodes(nodeIds: string[]): void {
    nodeIds.forEach(id => {
        d3.select(`.minimap-node[data-node-id="${id}"]`)
            .transition().duration(200)
            .attr('r', 6)
            .transition().duration(400)
            .attr('r', 3)
            .transition().duration(200)
            .attr('r', 6)
            .transition().duration(400)
            .attr('r', 3);
    });
}
