// Collapsed component rendering (sub-groups within workflows)
import * as state from './state';
import {
    COLLAPSED_COMPONENT_WIDTH, COLLAPSED_COMPONENT_HEIGHT,
    COLLAPSED_COMPONENT_HALF_WIDTH, COLLAPSED_COMPONENT_HALF_HEIGHT,
    COLLAPSED_COMPONENT_BORDER_RADIUS
} from './constants';
import { WorkflowComponent } from './types';

declare const d3: any;

/**
 * Render collapsed components for all workflow groups.
 * Components are rendered as compact boxes within their parent workflow.
 */
export function renderCollapsedComponents(onToggle: () => void): void {
    const { g, workflowGroups } = state;
    const expandedComponents = state.getExpandedComponents();

    // Collect all collapsed components from all workflow groups
    const allCollapsedComponents: WorkflowComponent[] = [];
    workflowGroups.forEach((group: any) => {
        (group.components || []).forEach((comp: WorkflowComponent) => {
            if (!expandedComponents.has(comp.id) && comp.centerX !== undefined && comp.centerY !== undefined) {
                allCollapsedComponents.push(comp);
            }
        });
    });

    if (allCollapsedComponents.length === 0) return;

    // Create container for collapsed components (render after nodes)
    const componentContainer = g.append('g').attr('class', 'collapsed-components');

    const componentElements = componentContainer.selectAll('.collapsed-component')
        .data(allCollapsedComponents, (d: any) => d.id)
        .enter()
        .append('g')
        .attr('class', 'collapsed-component')
        .attr('data-component-id', (d: WorkflowComponent) => d.id)
        .style('cursor', 'pointer')
        .on('click', function(event: any, d: WorkflowComponent) {
            event.stopPropagation();
            state.expandComponent(d.id);
            onToggle();
        });

    // Background rectangle with dashed border
    componentElements.append('rect')
        .attr('class', 'component-bg')
        .attr('x', (d: WorkflowComponent) => (d.centerX || 0) - COLLAPSED_COMPONENT_HALF_WIDTH)
        .attr('y', (d: WorkflowComponent) => (d.centerY || 0) - COLLAPSED_COMPONENT_HALF_HEIGHT)
        .attr('width', COLLAPSED_COMPONENT_WIDTH)
        .attr('height', COLLAPSED_COMPONENT_HEIGHT)
        .attr('rx', COLLAPSED_COMPONENT_BORDER_RADIUS)
        .style('fill', '#1e1e2e')
        .style('stroke', (d: WorkflowComponent) => d.color)
        .style('stroke-width', '2px')
        .style('stroke-dasharray', '4,2');

    // Use foreignObject for text content
    const contentFO = componentElements.append('foreignObject')
        .attr('x', (d: WorkflowComponent) => (d.centerX || 0) - COLLAPSED_COMPONENT_HALF_WIDTH)
        .attr('y', (d: WorkflowComponent) => (d.centerY || 0) - COLLAPSED_COMPONENT_HALF_HEIGHT)
        .attr('width', COLLAPSED_COMPONENT_WIDTH)
        .attr('height', COLLAPSED_COMPONENT_HEIGHT);

    const contentDiv = contentFO.append('xhtml:div')
        .style('width', '100%')
        .style('height', '100%')
        .style('display', 'flex')
        .style('flex-direction', 'column')
        .style('align-items', 'center')
        .style('justify-content', 'center')
        .style('padding', '8px 12px')
        .style('box-sizing', 'border-box')
        .style('gap', '4px');

    // Component name
    contentDiv.append('xhtml:div')
        .style('color', (d: WorkflowComponent) => d.color)
        .style('font-family', '"Inter", "Segoe UI", "SF Pro Display", -apple-system, sans-serif')
        .style('font-size', '14px')
        .style('font-weight', '600')
        .style('text-align', 'center')
        .style('line-height', '1.2')
        .style('overflow', 'hidden')
        .style('text-overflow', 'ellipsis')
        .style('white-space', 'nowrap')
        .style('max-width', '100%')
        .text((d: WorkflowComponent) => d.name);

    // Node count
    contentDiv.append('xhtml:div')
        .style('color', 'var(--vscode-descriptionForeground, #888)')
        .style('font-family', '"Inter", "Segoe UI", "SF Pro Display", -apple-system, sans-serif')
        .style('font-size', '12px')
        .style('font-weight', '500')
        .style('text-align', 'center')
        .text((d: WorkflowComponent) => `(${d.nodes.length} nodes)`);

    // Expand icon
    contentDiv.append('xhtml:div')
        .style('color', 'var(--vscode-descriptionForeground, #666)')
        .style('font-size', '14px')
        .style('margin-top', '2px')
        .text('⤢');
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
            if (comp.centerX === undefined || comp.centerY === undefined) continue;

            const left = comp.centerX - COLLAPSED_COMPONENT_HALF_WIDTH;
            const right = comp.centerX + COLLAPSED_COMPONENT_HALF_WIDTH;
            const top = comp.centerY - COLLAPSED_COMPONENT_HALF_HEIGHT;
            const bottom = comp.centerY + COLLAPSED_COMPONENT_HALF_HEIGHT;

            if (x >= left && x <= right && y >= top && y <= bottom) {
                return comp;
            }
        }
    }

    return null;
}
