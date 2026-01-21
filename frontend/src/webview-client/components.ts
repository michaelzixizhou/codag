// Collapsed component rendering (sub-groups within workflows)
import * as state from './state';
import { COMPONENT_CORNER_CUT, DRAG_THRESHOLD, COMPONENT_PADDING } from './constants';
import { WorkflowComponent } from './types';
import { measureTextWidth } from './groups';
import { snapToGrid } from './utils';
import { updateEdgePaths, updateEdgeLabels } from './edges';
import { renderMinimap } from './minimap';

declare const d3: any;

// Track drag state
let dragStartX = 0;
let dragStartY = 0;

/**
 * Generate octagon points for a component
 * Prioritizes width over height (wider than tall)
 */
function getOctagonPoints(cx: number, cy: number, w: number, h: number): string {
    const cut = Math.min(w, h) * COMPONENT_CORNER_CUT;
    const halfW = w / 2;
    const halfH = h / 2;

    // Clockwise from top-left
    const points = [
        [cx - halfW + cut, cy - halfH],      // top-left
        [cx + halfW - cut, cy - halfH],      // top-right
        [cx + halfW, cy - halfH + cut],      // right-top
        [cx + halfW, cy + halfH - cut],      // right-bottom
        [cx + halfW - cut, cy + halfH],      // bottom-right
        [cx - halfW + cut, cy + halfH],      // bottom-left
        [cx - halfW, cy + halfH - cut],      // left-bottom
        [cx - halfW, cy - halfH + cut],      // left-top
    ];

    return points.map(([x, y]) => `${x},${y}`).join(' ');
}

/**
 * Render collapsed components for all workflow groups.
 * Components are rendered as octagons overlaying their grouped nodes.
 */
export function renderCollapsedComponents(onToggle: () => void): void {
    const { g, workflowGroups } = state;
    const expandedComponents = state.getExpandedComponents();

    // Collect all collapsed components from all workflow groups
    const allCollapsedComponents: WorkflowComponent[] = [];
    workflowGroups.forEach((group: any) => {
        (group.components || []).forEach((comp: WorkflowComponent) => {
            if (!expandedComponents.has(comp.id) && comp.bounds && comp.centerX !== undefined && comp.centerY !== undefined) {
                allCollapsedComponents.push(comp);
            }
        });
    });

    if (allCollapsedComponents.length === 0) return;

    // Create container for collapsed components (render after nodes)
    const componentContainer = g.append('g').attr('class', 'collapsed-components');

    // Calculate and store visual dimensions for each component
    allCollapsedComponents.forEach((comp: WorkflowComponent) => {
        const fontFamily = '"Inter", "SF Pro Display", -apple-system, sans-serif';
        const nameWidth = measureTextWidth(comp.name || '', '16px', '400', fontFamily);
        const countText = `contains ${comp.nodes.length} nodes`;
        const countWidth = measureTextWidth(countText, '13px', '500', fontFamily);
        const maxWidth = Math.max(nameWidth, countWidth);
        (comp as any).visualWidth = maxWidth + 32;
        (comp as any).visualHeight = 52;
    });

    // Drag handlers for components
    const componentDragStarted = (event: any, d: WorkflowComponent) => {
        dragStartX = event.x;
        dragStartY = event.y;
        d3.select(`.collapsed-component[data-component-id="${d.id}"]`).raise();
    };

    const componentDragged = (event: any, d: WorkflowComponent) => {
        const newX = snapToGrid(event.x);
        const newY = snapToGrid(event.y);

        // Update component position
        d.centerX = newX;
        d.centerY = newY;

        // Update bounds based on new center (round to avoid sub-pixel jitter)
        const w = (d as any).visualWidth || 100;
        const h = (d as any).visualHeight || 52;
        d.bounds = {
            minX: Math.round(newX - w / 2 - COMPONENT_PADDING),
            maxX: Math.round(newX + w / 2 + COMPONENT_PADDING),
            minY: Math.round(newY - h / 2 - COMPONENT_PADDING),
            maxY: Math.round(newY + h / 2 + COMPONENT_PADDING)
        };

        // Update visual elements
        const elem = d3.select(`.collapsed-component[data-component-id="${d.id}"]`);
        elem.select('.component-bg')
            .attr('points', getOctagonPoints(newX, newY, w, h));
        elem.select('.component-name')
            .attr('x', newX)
            .attr('y', newY - 6);
        elem.select('.component-count')
            .attr('x', newX)
            .attr('y', newY + 12);

        // Update connected edges and labels
        updateEdgePaths();
        updateEdgeLabels();
    };

    const componentDragEnded = (event: any, d: WorkflowComponent) => {
        const distance = Math.sqrt(
            Math.pow(event.x - dragStartX, 2) + Math.pow(event.y - dragStartY, 2)
        );

        if (distance < DRAG_THRESHOLD) {
            // It was a click - expand the component
            if (event.sourceEvent) {
                event.sourceEvent.stopPropagation();
                event.sourceEvent.preventDefault();
            }
            state.expandComponent(d.id);
            onToggle();
        } else {
            // It was a drag - update minimap
            renderMinimap();
        }
    };

    const componentElements = componentContainer.selectAll('.collapsed-component')
        .data(allCollapsedComponents, (d: any) => d.id)
        .enter()
        .append('g')
        .attr('class', 'collapsed-component')
        .attr('data-component-id', (d: WorkflowComponent) => d.id)
        .style('cursor', 'grab')
        .call(d3.drag()
            .on('start', componentDragStarted)
            .on('drag', componentDragged)
            .on('end', componentDragEnded)
        );

    // Octagon background - sized to fit text content tightly
    componentElements.append('polygon')
        .attr('class', 'component-bg')
        .attr('points', (d: WorkflowComponent) => {
            const w = (d as any).visualWidth || 100;
            const h = (d as any).visualHeight || 52;
            return getOctagonPoints(d.centerX || 0, d.centerY || 0, w, h);
        })
        .style('fill', 'var(--vscode-editor-background, #1e1e2e)')
        .style('fill-opacity', '0.95')
        .style('stroke', (d: WorkflowComponent) => d.color)
        .style('stroke-width', '2.5px')
        .style('filter', 'drop-shadow(0 2px 4px rgba(0,0,0,0.3))');

    // Component name (centered, same weight as normal nodes)
    componentElements.append('text')
        .attr('class', 'component-name')
        .attr('x', (d: WorkflowComponent) => d.centerX || 0)
        .attr('y', (d: WorkflowComponent) => (d.centerY || 0) - 6)
        .attr('text-anchor', 'middle')
        .attr('dominant-baseline', 'middle')
        .style('fill', '#fff')
        .style('font-family', '"Inter", "SF Pro Display", -apple-system, sans-serif')
        .style('font-size', '16px')
        .style('font-weight', '400')
        .style('letter-spacing', '-0.01em')
        .text((d: WorkflowComponent) => d.name);

    // Node count (below name)
    componentElements.append('text')
        .attr('class', 'component-count')
        .attr('x', (d: WorkflowComponent) => d.centerX || 0)
        .attr('y', (d: WorkflowComponent) => (d.centerY || 0) + 12)
        .attr('text-anchor', 'middle')
        .attr('dominant-baseline', 'middle')
        .style('fill', 'rgba(255,255,255,0.7)')
        .style('font-family', '"Inter", "SF Pro Display", -apple-system, sans-serif')
        .style('font-size', '13px')
        .style('font-weight', '500')
        .text((d: WorkflowComponent) => `contains ${d.nodes.length} nodes`);
}

/**
 * Update visibility of collapsed components based on current state.
 * Called when components are expanded/collapsed.
 */
export function updateCollapsedComponentsVisibility(): void {
    const { g, workflowGroups } = state;
    const expandedComponents = state.getExpandedComponents();

    // Remove existing collapsed components and re-render
    g.selectAll('.collapsed-components').remove();

    // Re-render will be called by the main update function
}

/**
 * Get collapsed component at position (for hit testing)
 */
export function getCollapsedComponentAt(x: number, y: number): WorkflowComponent | null {
    const { workflowGroups } = state;
    const expandedComponents = state.getExpandedComponents();

    for (const group of workflowGroups) {
        for (const comp of (group.components || [])) {
            if (expandedComponents.has(comp.id)) continue;
            if (!comp.bounds) continue;

            if (x >= comp.bounds.minX && x <= comp.bounds.maxX &&
                y >= comp.bounds.minY && y <= comp.bounds.maxY) {
                return comp;
            }
        }
    }

    return null;
}
