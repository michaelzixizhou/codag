// Shared helper functions for webview

import {
    NODE_WIDTH,
    NODE_HEIGHT,
    COLLAPSED_GROUP_WIDTH,
    COLLAPSED_GROUP_HEIGHT,
    GROUP_BOUNDS_PADDING_X,
    GROUP_BOUNDS_PADDING_TOP,
    GROUP_BOUNDS_PADDING_BOTTOM
} from './constants';
import { measureTextWidth } from './groups';

declare const d3: any;

export interface NodeMeasureOptions {
    fontSize?: string;
    fontWeight?: string;
    minWidth?: number;
    maxWidth?: number;
    horizontalPadding?: number;
    verticalPadding?: number;
}

/**
 * Measure node dimensions based on label text with wrapping
 * Uses actual SVG foreignObject rendering to get accurate dimensions
 * Dynamic width: finds the tightest fit for both single and multi-line text
 */
export function measureNodeDimensions(label: string, options?: NodeMeasureOptions): { width: number; height: number } {
    const fontFamily = '"DM Sans", "Inter", "Segoe UI", -apple-system, sans-serif';
    const fontSize = options?.fontSize || '15px';
    const fontWeight = options?.fontWeight || '400';
    const minWidth = options?.minWidth || 80;
    const maxWidth = options?.maxWidth || 200;
    const horizontalPadding = options?.horizontalPadding || 16;  // 8px on each side
    const verticalPadding = options?.verticalPadding || 12;    // 6px on each side

    // Create temp container in body (not SVG) for accurate HTML measurement
    const container = d3.select('body').append('div')
        .style('visibility', 'hidden')
        .style('position', 'absolute')
        .style('left', '-9999px');

    // First pass: measure unconstrained single-line width
    const singleLineDiv = container.append('div')
        .style('display', 'inline-block')
        .style('white-space', 'nowrap')
        .style('font-family', fontFamily)
        .style('font-size', fontSize)
        .style('font-weight', fontWeight)
        .style('line-height', '1.2')
        .text(label);

    const singleLineWidth = (singleLineDiv.node() as HTMLElement).offsetWidth;
    singleLineDiv.remove();

    // If fits in one line, use actual width (threshold matches foreignObject width: maxWidth - 8)
    if (singleLineWidth <= maxWidth - 8) {
        const width = Math.max(minWidth, singleLineWidth + horizontalPadding);
        const singleLineHeight = Math.ceil(parseFloat(fontSize) * 1.2);
        container.remove();
        return { width, height: singleLineHeight + verticalPadding };
    }

    // Second pass: constrain to maxWidth and measure wrapped content
    const wrappedDiv = container.append('div')
        .attr('lang', 'en')
        .style('width', `${maxWidth - 8}px`)  // Same as foreignObject width
        .style('font-family', fontFamily)
        .style('font-size', fontSize)
        .style('font-weight', fontWeight)
        .style('line-height', '1.2')
        .style('word-wrap', 'break-word')
        .style('overflow-wrap', 'break-word')
        .style('hyphens', 'auto')
        .style('-webkit-hyphens', 'auto')
        .style('text-align', 'center')
        .text(label);

    const wrappedHeight = (wrappedDiv.node() as HTMLElement).offsetHeight;

    // Third pass: find tightest width that maintains same height
    // Binary search for minimum width that doesn't increase height
    let lo = minWidth - horizontalPadding;
    let hi = maxWidth - horizontalPadding;
    let optimalWidth = hi;

    while (lo <= hi) {
        const mid = Math.floor((lo + hi) / 2);
        wrappedDiv.style('width', `${mid}px`);
        const testHeight = (wrappedDiv.node() as HTMLElement).offsetHeight;

        if (testHeight <= wrappedHeight) {
            optimalWidth = mid;
            hi = mid - 1;
        } else {
            lo = mid + 1;
        }
    }

    container.remove();

    return {
        width: Math.max(minWidth, optimalWidth + horizontalPadding),
        height: wrappedHeight + verticalPadding
    };
}

/**
 * Measure node width based on label text (legacy - use measureNodeDimensions)
 */
export function measureNodeWidth(label: string): number {
    return measureNodeDimensions(label).width;
}

/**
 * Get node dimensions based on whether it's a collapsed group or regular node
 * Replaces 17+ occurrences of inline dimension calculation
 */
export function getNodeDimensions(node: any): { width: number; height: number } {
    if (node?.isCollapsedGroup) {
        return { width: COLLAPSED_GROUP_WIDTH, height: COLLAPSED_GROUP_HEIGHT };
    }
    // Use stored dynamic dimensions if available
    return {
        width: node?.width || NODE_WIDTH,
        height: node?.height || NODE_HEIGHT
    };
}

/**
 * Calculate group bounds from node positions
 * Uses node CENTERS + max dimensions for consistent alignment across workflows
 * This ensures bounding boxes align when ELK-aligned node centers are at the same position
 */
export function calculateGroupBounds(nodes: any[]): {
    bounds: { minX: number; maxX: number; minY: number; maxY: number };
    centerX: number;
    centerY: number;
} | null {
    const validNodes = nodes.filter((n: any) =>
        n.x !== undefined && !isNaN(n.x) && n.y !== undefined && !isNaN(n.y)
    );

    if (validNodes.length === 0) return null;

    // Calculate bounds using actual node edges (tight fit)
    // Round to integers to avoid sub-pixel jitter
    const bounds = {
        minX: Math.round(Math.min(...validNodes.map((n: any) => n.x - (n.width || NODE_WIDTH) / 2)) - GROUP_BOUNDS_PADDING_X),
        maxX: Math.round(Math.max(...validNodes.map((n: any) => n.x + (n.width || NODE_WIDTH) / 2)) + GROUP_BOUNDS_PADDING_X),
        minY: Math.round(Math.min(...validNodes.map((n: any) => n.y - (n.height || NODE_HEIGHT) / 2)) - GROUP_BOUNDS_PADDING_TOP),
        maxY: Math.round(Math.max(...validNodes.map((n: any) => n.y + (n.height || NODE_HEIGHT) / 2)) + GROUP_BOUNDS_PADDING_BOTTOM)
    };

    return {
        bounds,
        centerX: Math.round((bounds.minX + bounds.maxX) / 2),
        centerY: Math.round((bounds.minY + bounds.maxY) / 2)
    };
}

/**
 * Check if two nodes are in the same collapsed group
 * Replaces 4+ occurrences of collapsed group check
 */
export function areNodesInSameCollapsedGroup(
    sourceId: string,
    targetId: string,
    workflowGroups: any[]
): boolean {
    // Extract original IDs if these are virtual node IDs (nodeId__workflowId)
    const getOriginalId = (id: string) => id.includes('__') ? id.split('__')[0] : id;
    const origSource = getOriginalId(sourceId);
    const origTarget = getOriginalId(targetId);

    const sourceGroup = workflowGroups.find((g: any) => g.collapsed && g.nodes.includes(origSource));
    const targetGroup = workflowGroups.find((g: any) => g.collapsed && g.nodes.includes(origTarget));
    return !!(sourceGroup && targetGroup && sourceGroup.id === targetGroup.id);
}

/**
 * Get filtered node IDs from workflow groups (only groups with 3+ nodes)
 * Replaces 3 occurrences of workflow node filtering
 */
export function getWorkflowNodeIds(workflowGroups: any[]): Set<string> {
    const ids = new Set<string>();
    workflowGroups.forEach((g: any) => {
        if (g.nodes.length >= 3) {
            g.nodes.forEach((id: string) => ids.add(id));
        }
    });
    return ids;
}

/**
 * Find the reverse edge (B→A) for a given edge (A→B)
 */
export function findReverseEdge(edge: any, allEdges: any[]): any | null {
    return allEdges.find((e: any) => e.source === edge.target && e.target === edge.source) || null;
}

/**
 * Check if an edge is bidirectional (has a reverse edge)
 */
export function isBidirectionalEdge(edge: any, allEdges: any[]): boolean {
    return allEdges.some((e: any) => e.source === edge.target && e.target === edge.source);
}

/**
 * Get canonical edge key for bidirectional edges (always uses alphabetically first node as source)
 * This ensures A→B and B→A map to the same key
 */
export function getBidirectionalEdgeKey(edge: any): string {
    const [first, second] = [edge.source, edge.target].sort();
    return `${first}<->${second}`;
}

/**
 * Position a tooltip near the mouse cursor with boundary checks
 */
export function positionTooltipNearMouse(
    tooltip: HTMLElement,
    mouseX: number,
    mouseY: number,
    offsetX: number = 15,
    offsetY: number = 10
): void {
    // Temporarily make visible to measure
    tooltip.style.opacity = '0';
    tooltip.style.display = 'block';
    const tooltipRect = tooltip.getBoundingClientRect();
    tooltip.style.opacity = '';
    tooltip.style.display = '';

    let left = mouseX + offsetX;
    let top = mouseY - offsetY;

    // Boundary checks
    if (left + tooltipRect.width > window.innerWidth) {
        left = mouseX - tooltipRect.width - offsetX;
    }
    if (left < 0) left = offsetX;
    if (top < 0) top = mouseY + offsetX;
    if (top + tooltipRect.height > window.innerHeight) {
        top = window.innerHeight - tooltipRect.height - offsetX;
    }

    tooltip.style.left = `${left}px`;
    tooltip.style.top = `${top}px`;
}
