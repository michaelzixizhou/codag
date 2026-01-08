// Drag handlers
import * as state from './state';
import { snapToGrid } from './utils';
import { openPanel, closePanel } from './panel';
import { renderMinimap } from './minimap';
import { updateEdgePaths } from './edges';
import { updateSharedArrows } from './nodes';
import { DRAG_THRESHOLD } from './constants';

declare const d3: any;

let dragStartX: number = 0;
let dragStartY: number = 0;

export function dragstarted(event: any, d: any): void {
    // Track start position to detect click vs drag
    dragStartX = event.x;
    dragStartY = event.y;
    d3.select(`.node[data-node-id="${d.id}"]`).raise();
}

export function dragged(event: any, d: any): void {
    // Snap to grid
    d.fx = snapToGrid(event.x);
    d.fy = snapToGrid(event.y);
    d.x = d.fx;
    d.y = d.fy;

    // Update node position
    d3.select(`.node[data-node-id="${d.id}"]`)
        .attr('transform', `translate(${d.x},${d.y})`);

    // Update connected edges
    updateEdgePaths();

    // Update shared arrows if dragging a shared node
    if (d._originalId) {
        updateSharedArrows(d);
    }

    // Update minimap
    updateMinimapNodePosition(d);
}

export function dragended(event: any, d: any): void {
    // Detect click vs drag
    const distance = Math.sqrt(
        Math.pow(event.x - dragStartX, 2) + Math.pow(event.y - dragStartY, 2)
    );

    if (distance < DRAG_THRESHOLD) {
        // It was a click
        if (event.sourceEvent) {
            event.sourceEvent.stopPropagation();
            event.sourceEvent.preventDefault();
        }

        // Toggle panel if clicking the same node
        if (state.currentlyOpenNodeId === d.id) {
            closePanel();
        } else {
            openPanel(d);
        }
    } else {
        // It was a drag - update minimap
        renderMinimap();
    }
}

function updateMinimapNodePosition(node: any): void {
    const { minimapSvg, currentGraphData } = state;
    if (!minimapSvg) return;

    const scale = minimapSvg.minimapScale;
    const offsetX = minimapSvg.minimapOffsetX;
    const offsetY = minimapSvg.minimapOffsetY;
    const minX = minimapSvg.minimapMinX;
    const minY = minimapSvg.minimapMinY;

    const toMinimapX = (x: number) => (x - minX) * scale + offsetX;
    const toMinimapY = (y: number) => (y - minY) * scale + offsetY;

    // Update node position
    minimapSvg.select(`circle[data-node-id="${node.id}"]`)
        .attr('cx', toMinimapX(node.x))
        .attr('cy', toMinimapY(node.y));

    // Update connected edges
    minimapSvg.selectAll('.minimap-edge').each(function(this: SVGLineElement) {
        const edge = d3.select(this);
        const sourceId = edge.attr('data-source');
        const targetId = edge.attr('data-target');

        if (sourceId === node.id || targetId === node.id) {
            const sourceNode = currentGraphData.nodes.find((n: any) => n.id === sourceId);
            const targetNode = currentGraphData.nodes.find((n: any) => n.id === targetId);

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
