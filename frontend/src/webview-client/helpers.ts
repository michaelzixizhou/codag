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

/**
 * Get node dimensions based on whether it's a collapsed group or regular node
 * Replaces 17+ occurrences of inline dimension calculation
 */
export function getNodeDimensions(node: any): { width: number; height: number } {
    return node?.isCollapsedGroup
        ? { width: COLLAPSED_GROUP_WIDTH, height: COLLAPSED_GROUP_HEIGHT }
        : { width: NODE_WIDTH, height: NODE_HEIGHT };
}

/**
 * Calculate group bounds from node positions
 * Replaces 4+ occurrences of bounds calculation
 */
export function calculateGroupBounds(nodes: any[]): {
    bounds: { minX: number; maxX: number; minY: number; maxY: number };
    centerX: number;
    centerY: number;
} | null {
    const xs = nodes.map((n: any) => n.x).filter((x: number) => x !== undefined && !isNaN(x));
    const ys = nodes.map((n: any) => n.y).filter((y: number) => y !== undefined && !isNaN(y));

    if (xs.length === 0 || ys.length === 0) return null;

    const bounds = {
        minX: Math.min(...xs) - GROUP_BOUNDS_PADDING_X,
        maxX: Math.max(...xs) + GROUP_BOUNDS_PADDING_X,
        minY: Math.min(...ys) - GROUP_BOUNDS_PADDING_TOP,
        maxY: Math.max(...ys) + GROUP_BOUNDS_PADDING_BOTTOM
    };

    return {
        bounds,
        centerX: (bounds.minX + bounds.maxX) / 2,
        centerY: (bounds.minY + bounds.maxY) / 2
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
