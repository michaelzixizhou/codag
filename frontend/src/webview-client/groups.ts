// Workflow group rendering
import * as state from './state';
import {
    COLLAPSED_GROUP_BORDER_RADIUS,
    GROUP_STROKE_WIDTH
} from './constants';

declare const d3: any;

// Measure text width using a temporary SVG element
export function measureTextWidth(text: string, fontSize: string, fontWeight: string, fontFamily: string): number {
    const svg = d3.select('body').append('svg').style('visibility', 'hidden').style('position', 'absolute');
    const textEl = svg.append('text')
        .style('font-size', fontSize)
        .style('font-weight', fontWeight)
        .style('font-family', fontFamily)
        .text(text);
    const width = textEl.node().getBBox().width;
    svg.remove();
    return width;
}

export function renderGroups(): void {
    const { g, workflowGroups } = state;

    // Render group containers
    const groupContainer = g.append('g').attr('class', 'groups');
    state.setContainers(groupContainer, null);

    // Filter out groups without bounds and workflows with < 3 nodes
    const groupsWithBounds = workflowGroups.filter((grp: any) => grp.bounds && grp.nodes.length >= 3);

    const groupElements = groupContainer.selectAll('.workflow-group')
        .data(groupsWithBounds, (d: any) => d.id)
        .enter()
        .append('g')
        .attr('class', 'workflow-group')
        .attr('data-group-id', (d: any) => d.id);

    // Group background rectangle with hover events
    groupElements.append('rect')
        .attr('class', 'group-background')
        .attr('x', (d: any) => d.bounds.minX)
        .attr('y', (d: any) => d.bounds.minY)
        .attr('width', (d: any) => d.bounds.maxX - d.bounds.minX)
        .attr('height', (d: any) => d.bounds.maxY - d.bounds.minY)
        .attr('rx', COLLAPSED_GROUP_BORDER_RADIUS)
        .style('fill', (d: any) => d.color)
        .style('fill-opacity', 0.08)
        .style('stroke', (d: any) => d.color)
        .style('stroke-opacity', 0.5)
        .style('stroke-width', `${GROUP_STROKE_WIDTH}px`)
        .style('opacity', (d: any) => d.id === 'group_orphans' ? 0 : 1)
        .style('pointer-events', 'all')
        .on('mouseenter', function(this: SVGRectElement) {
            d3.select(this.parentNode).select('.group-title-expanded').style('opacity', 1);
        })
        .on('mouseleave', function(this: SVGRectElement) {
            d3.select(this.parentNode).select('.group-title-expanded').style('opacity', 0);
        });

    // Title above group (hidden by default, shown on hover)
    groupElements.append('text')
        .attr('class', 'group-title-expanded')
        .attr('x', (d: any) => d.bounds.minX)
        .attr('y', (d: any) => d.bounds.minY - 8)
        .attr('dominant-baseline', 'auto')
        .style('fill', (d: any) => d.color)
        .style('font-family', '"Inter", "Segoe UI", "SF Pro Display", -apple-system, sans-serif')
        .style('font-size', '17px')
        .style('font-weight', '500')
        .style('opacity', 0)
        .style('transition', 'opacity 0.2s ease')
        .style('pointer-events', 'none')
        .text((d: any) => `${d.name} (${d.nodes.length} nodes)`);

    state.setGroupElements(groupElements);
}

/**
 * Incrementally update groups without destroying existing DOM elements.
 * Uses D3 enter/update/exit pattern to minimize DOM operations.
 */
export function updateGroupsIncremental(): void {
    const { g, workflowGroups } = state;

    // Filter out groups without bounds and workflows with < 3 nodes
    const groupsWithBounds = workflowGroups.filter((grp: any) => grp.bounds && grp.nodes.length >= 3);

    // Get or create the groups container
    let groupContainer = g.select('.groups');
    if (groupContainer.empty()) {
        groupContainer = g.append('g').attr('class', 'groups');
        state.setContainers(groupContainer, null);
    }

    // Data join with key function
    const groupSelection = groupContainer.selectAll('.workflow-group')
        .data(groupsWithBounds, (d: any) => d.id);

    // EXIT: Remove groups that no longer exist
    groupSelection.exit().remove();

    // ENTER: Create new groups
    const enterGroups = groupSelection.enter()
        .append('g')
        .attr('class', 'workflow-group')
        .attr('data-group-id', (d: any) => d.id);

    // Add background rect to new groups
    enterGroups.append('rect')
        .attr('class', 'group-background')
        .attr('rx', COLLAPSED_GROUP_BORDER_RADIUS)
        .style('fill-opacity', 0.08)
        .style('stroke-opacity', 0.5)
        .style('stroke-width', `${GROUP_STROKE_WIDTH}px`)
        .style('pointer-events', 'all')
        .on('mouseenter', function(this: SVGRectElement) {
            d3.select(this.parentNode).select('.group-title-expanded').style('opacity', 1);
        })
        .on('mouseleave', function(this: SVGRectElement) {
            d3.select(this.parentNode).select('.group-title-expanded').style('opacity', 0);
        });

    // Add title to new groups
    enterGroups.append('text')
        .attr('class', 'group-title-expanded')
        .attr('dominant-baseline', 'auto')
        .style('font-family', '"Inter", "Segoe UI", "SF Pro Display", -apple-system, sans-serif')
        .style('font-size', '17px')
        .style('font-weight', '500')
        .style('opacity', 0)
        .style('transition', 'opacity 0.2s ease')
        .style('pointer-events', 'none');

    // UPDATE + ENTER: Update all groups (existing + new)
    const allGroups = groupSelection.merge(enterGroups);

    // Update background rects
    allGroups.select('.group-background')
        .attr('x', (d: any) => d.bounds.minX)
        .attr('y', (d: any) => d.bounds.minY)
        .attr('width', (d: any) => d.bounds.maxX - d.bounds.minX)
        .attr('height', (d: any) => d.bounds.maxY - d.bounds.minY)
        .style('fill', (d: any) => d.color)
        .style('stroke', (d: any) => d.color)
        .style('opacity', (d: any) => d.id === 'group_orphans' ? 0 : 1);

    // Update titles
    allGroups.select('.group-title-expanded')
        .attr('x', (d: any) => d.bounds.minX)
        .attr('y', (d: any) => d.bounds.minY - 8)
        .style('fill', (d: any) => d.color)
        .text((d: any) => `${d.name} (${d.nodes.length} nodes)`);

    state.setGroupElements(allGroups);
}
