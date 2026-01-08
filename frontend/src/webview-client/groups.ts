// Workflow group rendering (expanded and collapsed)
import * as state from './state';
import {
    COLLAPSED_GROUP_HEIGHT,
    COLLAPSED_GROUP_HALF_HEIGHT,
    COLLAPSED_GROUP_BORDER_RADIUS,
    GROUP_TITLE_OFFSET_X, GROUP_TITLE_OFFSET_Y,
    GROUP_COLLAPSE_BTN_X, GROUP_COLLAPSE_BTN_Y, GROUP_COLLAPSE_BTN_SIZE,
    GROUP_STROKE_WIDTH
} from './constants';

declare const d3: any;

// Minimum width for collapsed groups
const MIN_COLLAPSED_WIDTH = 200;
const COLLAPSED_PADDING = 60; // padding on each side of text

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

export function renderGroups(updateGroupVisibility: () => void): void {
    const { g, workflowGroups } = state;

    // Render group containers
    const groupContainer = g.append('g').attr('class', 'groups');
    state.setContainers(groupContainer, null);

    // Filter out groups without bounds and workflows with < 3 nodes
    const groupsWithBounds = workflowGroups.filter((grp: any) => grp.bounds && grp.nodes.length >= 3);

    // Expand bounds to fit title if needed
    const fontFamily = '"Inter", "Segoe UI", "SF Pro Display", -apple-system, sans-serif';
    groupsWithBounds.forEach((grp: any) => {
        const titleText = `${grp.name} (${grp.nodes.length} nodes)`;
        const titleWidth = measureTextWidth(titleText, '19px', '500', fontFamily);
        const requiredWidth = titleWidth + GROUP_TITLE_OFFSET_X + 40; // left offset + right padding
        const currentWidth = grp.bounds.maxX - grp.bounds.minX;
        if (requiredWidth > currentWidth) {
            grp.bounds.maxX = grp.bounds.minX + requiredWidth;
        }
    });

    const groupElements = groupContainer.selectAll('.workflow-group')
        .data(groupsWithBounds, (d: any) => d.id)
        .enter()
        .append('g')
        .attr('class', 'workflow-group')
        .attr('data-group-id', (d: any) => d.id);

    // Group background rectangle
    groupElements.append('rect')
        .attr('class', 'group-background')
        .attr('x', (d: any) => d.bounds.minX)
        .attr('y', (d: any) => d.bounds.minY)
        .attr('width', (d: any) => d.bounds.maxX - d.bounds.minX)
        .attr('height', (d: any) => d.bounds.maxY - d.bounds.minY)
        .attr('rx', COLLAPSED_GROUP_BORDER_RADIUS)
        .style('fill', (d: any) => d.color)
        .style('fill-opacity', 0.03)
        .style('stroke', (d: any) => d.color)
        .style('stroke-opacity', 0.4)
        .style('stroke-width', `${GROUP_STROKE_WIDTH}px`)
        .style('stroke-dasharray', '8,4')
        .style('opacity', (d: any) => (d.collapsed || d.id === 'group_orphans') ? 0 : 1)
        .style('pointer-events', 'none');

    // Title inside expanded group
    groupElements.append('text')
        .attr('class', 'group-title-expanded')
        .attr('x', (d: any) => d.bounds.minX + GROUP_TITLE_OFFSET_X)
        .attr('y', (d: any) => d.bounds.minY + GROUP_TITLE_OFFSET_Y)
        .attr('dominant-baseline', 'middle')
        .style('fill', (d: any) => d.color)
        .style('font-family', '"Inter", "Segoe UI", "SF Pro Display", -apple-system, sans-serif')
        .style('font-size', '19px')
        .style('font-weight', '500')
        .style('display', (d: any) => (d.collapsed || d.id === 'group_orphans') ? 'none' : 'block')
        .style('pointer-events', 'none')
        .text((d: any) => `${d.name} (${d.nodes.length} nodes)`);

    // Collapse button for expanded group
    const expandedCollapseBtn = groupElements.append('g')
        .attr('class', 'group-collapse-btn')
        .style('display', (d: any) => (d.collapsed || d.id === 'group_orphans') ? 'none' : 'block')
        .style('cursor', 'pointer')
        .on('click', function(event: any, d: any) {
            event.stopPropagation();
            d.collapsed = true;
            updateGroupVisibility();
        });

    expandedCollapseBtn.append('rect')
        .attr('x', (d: any) => d.bounds.minX + GROUP_COLLAPSE_BTN_X)
        .attr('y', (d: any) => d.bounds.minY + GROUP_COLLAPSE_BTN_Y)
        .attr('width', GROUP_COLLAPSE_BTN_SIZE)
        .attr('height', GROUP_COLLAPSE_BTN_SIZE)
        .attr('rx', 4)
        .style('fill', (d: any) => d.color)
        .style('fill-opacity', 0.2)
        .style('stroke', (d: any) => d.color)
        .style('stroke-width', '2px');

    expandedCollapseBtn.append('text')
        .attr('x', (d: any) => d.bounds.minX + GROUP_COLLAPSE_BTN_X + GROUP_COLLAPSE_BTN_SIZE / 2)
        .attr('y', (d: any) => d.bounds.minY + GROUP_TITLE_OFFSET_Y)
        .attr('text-anchor', 'middle')
        .attr('dominant-baseline', 'middle')
        .style('fill', (d: any) => d.color)
        .style('font-size', '16px')
        .style('font-weight', 'bold')
        .style('pointer-events', 'none')
        .text('−');

    state.setGroupElements(groupElements);
}

export function renderCollapsedGroups(updateGroupVisibility: () => void): void {
    const { g, workflowGroups } = state;

    const groupsWithBounds = workflowGroups.filter((grp: any) => grp.bounds && grp.nodes.length >= 3);

    // Calculate dynamic width for each collapsed group based on title
    const fontFamily = '"Inter", "Segoe UI", "SF Pro Display", -apple-system, sans-serif';
    groupsWithBounds.forEach((grp: any) => {
        const titleWidth = measureTextWidth(grp.name, '21px', '600', fontFamily);
        const calculatedWidth = titleWidth + COLLAPSED_PADDING;
        grp.collapsedWidth = Math.max(calculatedWidth, MIN_COLLAPSED_WIDTH);
        grp.collapsedHalfWidth = grp.collapsedWidth / 2;
    });

    // Render collapsed groups AFTER edges/nodes for proper z-index
    const collapsedGroupContainer = g.append('g').attr('class', 'collapsed-groups');

    const collapsedGroups = collapsedGroupContainer.selectAll('.collapsed-group')
        .data(groupsWithBounds, (d: any) => d.id)
        .enter()
        .append('g')
        .attr('class', 'collapsed-group-node')
        .attr('data-group-id', (d: any) => d.id)
        .style('display', (d: any) => d.collapsed ? 'block' : 'none')
        .style('cursor', 'pointer')
        .on('click', function(event: any, d: any) {
            event.stopPropagation();
            d.collapsed = false;
            updateGroupVisibility();
        });

    // Background with pegboard pattern
    collapsedGroups.append('rect')
        .attr('class', 'collapsed-bg-pattern')
        .attr('x', (d: any) => d.centerX - d.collapsedHalfWidth)
        .attr('y', (d: any) => d.centerY - COLLAPSED_GROUP_HALF_HEIGHT)
        .attr('width', (d: any) => d.collapsedWidth)
        .attr('height', COLLAPSED_GROUP_HEIGHT)
        .attr('rx', COLLAPSED_GROUP_BORDER_RADIUS)
        .style('fill', (d: any) => `url(#pegboard-${d.id})`)
        .style('stroke', (d: any) => d.color)
        .style('stroke-width', `${GROUP_STROKE_WIDTH}px`)
        .style('filter', 'drop-shadow(0 2px 8px rgba(0,0,0,0.2))');

    // Solid color overlay
    collapsedGroups.append('rect')
        .attr('class', 'collapsed-bg-overlay')
        .attr('x', (d: any) => d.centerX - d.collapsedHalfWidth)
        .attr('y', (d: any) => d.centerY - COLLAPSED_GROUP_HALF_HEIGHT)
        .attr('width', (d: any) => d.collapsedWidth)
        .attr('height', COLLAPSED_GROUP_HEIGHT)
        .attr('rx', COLLAPSED_GROUP_BORDER_RADIUS)
        .style('fill', (d: any) => d.color)
        .style('fill-opacity', 0.7)
        .style('pointer-events', 'none');

    // Single foreignObject for all text content with flexbox layout
    const contentFO = collapsedGroups.append('foreignObject')
        .attr('class', 'collapsed-content')
        .attr('x', (d: any) => d.centerX - d.collapsedHalfWidth)
        .attr('y', (d: any) => d.centerY - COLLAPSED_GROUP_HALF_HEIGHT)
        .attr('width', (d: any) => d.collapsedWidth)
        .attr('height', COLLAPSED_GROUP_HEIGHT);

    const contentDiv = contentFO.append('xhtml:div')
        .style('width', '100%')
        .style('height', '100%')
        .style('display', 'flex')
        .style('flex-direction', 'column')
        .style('align-items', 'center')
        .style('justify-content', 'center')
        .style('padding', '16px 20px')
        .style('box-sizing', 'border-box')
        .style('gap', '8px');

    // Title
    contentDiv.append('xhtml:div')
        .attr('class', 'collapsed-title')
        .style('text-align', 'center')
        .style('color', '#ffffff')
        .style('text-shadow', '0 1px 3px rgba(0,0,0,0.6)')
        .style('font-family', '"Inter", "Segoe UI", "SF Pro Display", -apple-system, sans-serif')
        .style('font-size', '21px')
        .style('font-weight', '600')
        .style('line-height', '1.3')
        .style('white-space', 'nowrap')
        .text((d: any) => d.name);

    // Stats line
    contentDiv.append('xhtml:div')
        .attr('class', 'collapsed-stats')
        .style('color', '#ffffff')
        .style('text-shadow', '0 1px 2px rgba(0,0,0,0.5)')
        .style('opacity', '0.9')
        .style('font-family', '"Inter", "Segoe UI", "SF Pro Display", -apple-system, sans-serif')
        .style('font-size', '15px')
        .style('font-weight', '600')
        .style('text-align', 'center')
        .text((d: any) => `${d.nodes.length} nodes • ${d.llmProviders}`);

    // Expand hint (centered below stats)
    contentDiv.append('xhtml:div')
        .attr('class', 'collapsed-expand-hint')
        .style('display', 'flex')
        .style('align-items', 'center')
        .style('justify-content', 'center')
        .style('gap', '6px')
        .style('color', '#ffffff')
        .style('text-shadow', '0 1px 2px rgba(0,0,0,0.4)')
        .style('opacity', '0.6')
        .style('font-family', '"Inter", "Segoe UI", "SF Pro Display", -apple-system, sans-serif')
        .style('font-size', '11px')
        .html('Click to expand <span style="font-size:16px">⤢</span>');

    state.setCollapsedGroups(collapsedGroups);
    state.setContainers(state.groupContainer, collapsedGroupContainer);
}
