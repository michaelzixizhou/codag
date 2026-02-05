// ELK layout and workflow grid tiling
import * as state from './state';
import { snapToGrid } from './utils';
import { createWorkflowPattern } from './setup';
import { measureNodeDimensions } from './helpers';
import { measureTextWidth } from './groups';
import { layoutWithELK, EdgeRoute, EdgeInput, NodeInput } from './elk-layout';
import {
    NODE_WIDTH, NODE_HEIGHT,
    WORKFLOW_SPACING,
    GROUP_BOUNDS_PADDING_X, GROUP_BOUNDS_PADDING_TOP, GROUP_BOUNDS_PADDING_BOTTOM,
    COMPONENT_PADDING
} from './constants';
import { WorkflowComponent } from './types';

declare const d3: any;

/**
 * Find which collapsed component a node belongs to (if any)
 */
function findCollapsedComponent(
    nodeId: string,
    components: WorkflowComponent[],
    expandedComponents: Set<string>
): WorkflowComponent | null {
    for (const comp of components) {
        if (comp.nodes.includes(nodeId) && !expandedComponents.has(comp.id)) {
            return comp;
        }
    }
    return null;
}

// Temporary storage for workflow layout data during two-pass layout
interface WorkflowLayoutData {
    group: any;
    nodes: any[];
    localPositions: Map<string, { x: number; y: number }>;
    localEdgeRoutes: Map<string, EdgeRoute>;  // Edge routes in local coords
    localLabelPositions: Map<string, { x: number; y: number }>;  // Label positions in local coords
    width: number;
    height: number;
    offsetX: number;
    offsetY: number;
    components: WorkflowComponent[];
    localBoundsMinX: number;
    localBoundsMinY: number;
}

export async function layoutWorkflows(defs: any): Promise<void> {
    const { currentGraphData, workflowGroups, originalPositions, g } = state;
    const expandedComponents = state.getExpandedComponents();

    const layoutData: WorkflowLayoutData[] = [];

    // ========== PASS 0: Measure ALL nodes first ==========
    // This ensures every node has proper dimensions, even if workflow is skipped
    currentGraphData.nodes.forEach((node: any) => {
        const isTitleNode = node.type === 'workflow-title';
        const measureOptions = isTitleNode ? {
            fontSize: '16px',
            fontWeight: '600',
            minWidth: 100,
            maxWidth: 280,
            horizontalPadding: 24,  // More padding for pill shape
            verticalPadding: 16
        } : undefined;

        const dims = measureNodeDimensions(node.label || node.id, measureOptions);
        // Store original text area dimensions for foreignObject
        node._textWidth = dims.width;
        node._textHeight = dims.height;
        // Decision nodes use hexagon shape - add width for the pointed ends
        if (node.type === 'decision') {
            node.width = dims.width * 1.2;
            node.height = dims.height;
        } else {
            node.width = dims.width;
            node.height = dims.height;
        }
    });

    // ========== PASS 0.5: Test render to detect overflow, fix heights ==========
    // Wait for fonts to load before measuring (DM Sans affects text metrics)
    if (document.fonts && document.fonts.ready) {
        await document.fonts.ready;
    }

    // Create temp foreignObjects matching actual render structure to detect overflow
    const svg = d3.select('svg');
    if (!svg.empty()) {
        const testGroup = svg.append('g')
            .attr('class', 'overflow-test-temp')
            .attr('transform', 'translate(-5000, -5000)');

        currentGraphData.nodes.forEach((node: any) => {
            const isTitleNode = node.type === 'workflow-title';
            const fontSize = isTitleNode ? '16px' : '15px';
            const fontWeight = isTitleNode ? '600' : '400';
            const vPadding = isTitleNode ? 16 : 12;
            const foWidth = node._textWidth - 8;
            const foHeight = node._textHeight - 8;

            // Create foreignObject matching nodes.ts structure exactly
            const fo = testGroup.append('foreignObject')
                .attr('width', foWidth)
                .attr('height', foHeight);

            const wrapper = fo.append('xhtml:div')
                .attr('xmlns', 'http://www.w3.org/1999/xhtml')
                .style('width', '100%')
                .style('height', '100%')
                .style('display', 'flex')
                .style('align-items', 'center')
                .style('justify-content', 'center');

            const span = wrapper.append('xhtml:span')
                .attr('xmlns', 'http://www.w3.org/1999/xhtml')
                .attr('lang', 'en')
                .style('display', 'block')
                .style('width', '100%')
                .style('text-align', 'center')
                .style('font-family', '"DM Sans", "Inter", "Segoe UI", -apple-system, sans-serif')
                .style('font-size', fontSize)
                .style('font-weight', fontWeight)
                .style('letter-spacing', '-0.01em')
                .style('line-height', '1.2')
                .style('word-break', 'break-word')
                .style('word-wrap', 'break-word')
                .style('overflow-wrap', 'break-word')
                .style('hyphens', 'auto')
                .style('-webkit-hyphens', 'auto')
                .text(node.label || node.id);

            // Force layout
            const spanEl = span.node() as HTMLElement;
            void spanEl.offsetHeight;

            // Check for overflow
            const actualHeight = spanEl.offsetHeight;
            if (actualHeight > foHeight) {
                const hPadding = isTitleNode ? 24 : 16;

                // Binary search for minimum width that maintains same height
                // (tightest width that doesn't add more lines)
                let lo = 50;
                let hi = foWidth;
                let optimalWidth = foWidth;

                while (lo <= hi) {
                    const mid = Math.floor((lo + hi) / 2);
                    fo.attr('width', mid);
                    void spanEl.offsetHeight;

                    const testHeight = spanEl.offsetHeight;
                    if (testHeight <= actualHeight) {
                        // Still fits in same number of lines, try smaller
                        optimalWidth = mid;
                        hi = mid - 1;
                    } else {
                        // Wrapped to more lines, need more width
                        lo = mid + 1;
                    }
                }

                const newWidth = optimalWidth + hPadding;
                const newHeight = actualHeight + vPadding;

                node.width = node.type === 'decision' ? newWidth * 1.2 : newWidth;
                node._textWidth = newWidth;
                node.height = newHeight;
                node._textHeight = newHeight;

            }

            fo.remove();
        });

        testGroup.remove();
    }

    // ========== PASS 1: Layout each workflow individually with ELK ==========
    // All nodes are laid out normally - components don't affect layout
    for (const group of workflowGroups) {
        const allGroupNodes = currentGraphData.nodes.filter((n: any) =>
            group.nodes.includes(n.id)
        );

        if (allGroupNodes.length < 3) continue;

        const components = group.components || [];

        // Prepare nodes for ELK layout
        const elkNodes: NodeInput[] = [];

        allGroupNodes.forEach((node: any) => {
            const elkNode: NodeInput = { id: node.id, width: node.width, height: node.height };

            // Force title nodes to the first layer so they appear at the top
            if (node.type === 'workflow-title') {
                elkNode.layoutOptions = {
                    'elk.layering.layerConstraint': 'FIRST',
                    'elk.priority': '100'
                };
            }

            elkNodes.push(elkNode);
        });

        // Prepare edges for ELK layout (include labels for proper spacing)
        const elkEdges: EdgeInput[] = [];
        const seenEdges = new Set<string>();
        currentGraphData.edges.forEach((edge: any) => {
            if (group.nodes.includes(edge.source) && group.nodes.includes(edge.target)) {
                const edgeKey = `${edge.source}->${edge.target}`;
                if (!seenEdges.has(edgeKey)) {
                    seenEdges.add(edgeKey);
                    elkEdges.push({
                        source: edge.source,
                        target: edge.target,
                        id: `${group.id}_${edgeKey}`,
                        label: edge.label || undefined,  // Pass label for ELK positioning
                    });
                }
            }
        });

        // Run ELK layout
        const { positions: elkPositions, edgeRoutes, labelPositions } = await layoutWithELK(elkNodes, elkEdges);

        // Store LOCAL positions (no global offset yet)
        const localPositions = new Map<string, { x: number; y: number }>();

        // Store positions for all nodes
        allGroupNodes.forEach((node: any) => {
            const pos = elkPositions.get(node.id);
            if (pos && typeof pos.x === 'number' && typeof pos.y === 'number') {
                localPositions.set(node.id, { x: snapToGrid(pos.x), y: snapToGrid(pos.y) });
            }
        });

        // Calculate local bounds using actual node edges AND edge route points
        const positionEntries = Array.from(localPositions.entries());
        if (positionEntries.length === 0) continue;

        // Build array with position + dimensions for each node
        const nodesWithBounds = positionEntries.map(([nodeId, pos]) => {
            const node = allGroupNodes.find((n: any) => n.id === nodeId);
            const width = node?.width || NODE_WIDTH;
            const height = node?.height || NODE_HEIGHT;
            return { x: pos.x, y: pos.y, width, height };
        });

        // Calculate initial bounds from node edges
        let boundsMinX = Math.min(...nodesWithBounds.map(n => n.x - n.width / 2)) - GROUP_BOUNDS_PADDING_X;
        let boundsMaxX = Math.max(...nodesWithBounds.map(n => n.x + n.width / 2)) + GROUP_BOUNDS_PADDING_X;
        let boundsMinY = Math.min(...nodesWithBounds.map(n => n.y - n.height / 2)) - GROUP_BOUNDS_PADDING_TOP;
        let boundsMaxY = Math.max(...nodesWithBounds.map(n => n.y + n.height / 2)) + GROUP_BOUNDS_PADDING_BOTTOM;

        // Expand bounds to include edge route points (ELK orthogonal routing can
        // place bend points outside the node-based bounds)
        const EDGE_ROUTE_PADDING = 8; // Clearance for edge stroke + small margin
        edgeRoutes.forEach((route) => {
            const points = [route.startPoint, route.endPoint, ...route.bendPoints];
            for (const p of points) {
                boundsMinX = Math.min(boundsMinX, p.x - EDGE_ROUTE_PADDING);
                boundsMaxX = Math.max(boundsMaxX, p.x + EDGE_ROUTE_PADDING);
                boundsMinY = Math.min(boundsMinY, p.y - EDGE_ROUTE_PADDING);
                boundsMaxY = Math.max(boundsMaxY, p.y + EDGE_ROUTE_PADDING);
            }
        });

        // Ensure bounds are wide enough for the workflow title
        const titleText = `${group.name} (${group.nodes.length} nodes)`;
        const titleWidth = measureTextWidth(titleText, '17px', '500', '"Inter", "Segoe UI", sans-serif') + 10; // +10 for padding
        const currentWidth = boundsMaxX - boundsMinX;
        const finalWidth = Math.max(currentWidth, titleWidth);
        const widthDiff = finalWidth - currentWidth;

        const localBounds = {
            minX: boundsMinX - widthDiff / 2,  // Center the extra width
            maxX: boundsMaxX + widthDiff / 2,
            minY: boundsMinY,
            maxY: boundsMaxY
        };

        const width = localBounds.maxX - localBounds.minX;
        const height = localBounds.maxY - localBounds.minY;

        layoutData.push({
            group,
            nodes: allGroupNodes,
            localPositions,
            localEdgeRoutes: edgeRoutes,  // Store for transformation in PASS 3
            localLabelPositions: labelPositions,  // Store label positions for transformation
            width,
            height,
            offsetX: 0,
            offsetY: 0,
            components,
            localBoundsMinX: localBounds.minX,
            localBoundsMinY: localBounds.minY
        });
    }

    // Will be populated in PASS 3 after transformation
    const allElkEdgeRoutes = new Map<string, EdgeRoute>();
    const allLabelPositions = new Map<string, { x: number; y: number }>();

    // ========== PASS 2: Radial corner-packing layout ==========
    if (layoutData.length > 0) {
        const S = WORKFLOW_SPACING;

        // Sort by area descending (largest first)
        const sortedData = [...layoutData].sort((a, b) => (b.width * b.height) - (a.width * a.height));

        // Placed workflows: { x, y, w, h } where x,y is top-left corner
        const placed: { x: number; y: number; w: number; h: number; name: string }[] = [];

        // Check if position overlaps any placed workflow (need S gap from all)
        const overlaps = (x: number, y: number, w: number, h: number): boolean => {
            for (const p of placed) {
                const noOverlap =
                    x + w + S <= p.x ||
                    p.x + p.w + S <= x ||
                    y + h + S <= p.y ||
                    p.y + p.h + S <= y;
                if (!noOverlap) return true;
            }
            return false;
        };


        // Find corners: positions where new workflow is S away from TWO edges
        // (one horizontal edge of workflow A, one vertical edge of workflow B)
        const getCorners = (w: number, h: number): { x: number; y: number }[] => {
            const corners: { x: number; y: number }[] = [];

            for (const a of placed) {
                for (const b of placed) {
                    // Corner types: new workflow touches a's horizontal edge + b's vertical edge

                    // Below a's bottom + right of b's right
                    corners.push({ x: b.x + b.w + S, y: a.y + a.h + S });
                    // Below a's bottom + left of b's left
                    corners.push({ x: b.x - w - S, y: a.y + a.h + S });
                    // Above a's top + right of b's right
                    corners.push({ x: b.x + b.w + S, y: a.y - h - S });
                    // Above a's top + left of b's left
                    corners.push({ x: b.x - w - S, y: a.y - h - S });
                }
            }

            return corners;
        };

        // Place each workflow
        sortedData.forEach((data, idx) => {
            const w = data.width;
            const h = data.height;

            if (idx === 0) {
                // Largest at center
                data.offsetX = 0;
                data.offsetY = 0;
                placed.push({ x: 0, y: 0, w, h, name: data.group.name });
                return;
            }

            if (idx === 1) {
                // Second to the RIGHT of first, top-aligned
                const first = placed[0];
                data.offsetX = first.x + first.w + S;
                data.offsetY = first.y; // top-aligned
                placed.push({ x: data.offsetX, y: data.offsetY, w, h, name: data.group.name });
                return;
            }

            // Find all corners
            const corners = getCorners(w, h);

            // Calculate centroid of placed workflows (true radial center)
            const centroidX = placed.reduce((sum, p) => sum + p.x + p.w / 2, 0) / placed.length;
            const centroidY = placed.reduce((sum, p) => sum + p.y + p.h / 2, 0) / placed.length;

            // Distance from candidate center to placed centroid
            const distToCentroid = (x: number, y: number, cw: number, ch: number): number => {
                const cx = x + cw / 2;
                const cy = y + ch / 2;
                const dx = cx - centroidX;
                const dy = cy - centroidY;
                return Math.sqrt(dx * dx + dy * dy);
            };

            // Find valid corner closest to centroid
            let bestPos: { x: number; y: number } | null = null;
            let bestDist = Infinity;

            for (const pos of corners) {
                if (!overlaps(pos.x, pos.y, w, h)) {
                    const dist = distToCentroid(pos.x, pos.y, w, h);
                    if (dist < bestDist) {
                        bestDist = dist;
                        bestPos = pos;
                    }
                }
            }

            if (bestPos) {
                data.offsetX = bestPos.x;
                data.offsetY = bestPos.y;
            } else {
                // Fallback: place to the right of everything
                const maxRight = Math.max(...placed.map(p => p.x + p.w));
                data.offsetX = maxRight + S;
                data.offsetY = 0;
            }

            placed.push({ x: data.offsetX, y: data.offsetY, w, h, name: data.group.name });
        });

        // Normalize: shift so min is at (0, 0)
        const minX = Math.min(...sortedData.map(d => d.offsetX));
        const minY = Math.min(...sortedData.map(d => d.offsetY));
        sortedData.forEach((data) => {
            data.offsetX -= minX;
            data.offsetY -= minY;
        });
    }

    // ========== PASS 3: Apply global offsets and finalize positions ==========
    layoutData.forEach((data) => {
        const { group, nodes, localPositions, localEdgeRoutes, localLabelPositions, offsetX, offsetY, components, localBoundsMinX, localBoundsMinY } = data;

        // Apply offset to ALL node positions
        // Normalize by subtracting localBounds origin so positions start at (0,0)
        nodes.forEach((node: any) => {
            const localPos = localPositions.get(node.id);

            if (localPos) {
                const x = localPos.x - localBoundsMinX + offsetX;
                const y = localPos.y - localBoundsMinY + offsetY;

                node.x = x;
                node.y = y;
                node.fx = x;
                node.fy = y;
                originalPositions.set(node.id, { x, y });
            }
        });

        // Transform edge routes with same offset as nodes
        const transformPoint = (p: { x: number; y: number }) => ({
            x: p.x - localBoundsMinX + offsetX,
            y: p.y - localBoundsMinY + offsetY
        });

        localEdgeRoutes.forEach((route, edgeId) => {
            allElkEdgeRoutes.set(edgeId, {
                startPoint: transformPoint(route.startPoint),
                endPoint: transformPoint(route.endPoint),
                bendPoints: route.bendPoints.map(transformPoint)
            });
        });

        // Transform label positions with same offset
        localLabelPositions.forEach((pos, edgeId) => {
            allLabelPositions.set(edgeId, transformPoint(pos));
        });

        // Calculate component bounds from their actual node positions
        components.forEach((comp: WorkflowComponent) => {
            const compNodes = nodes.filter((n: any) => comp.nodes.includes(n.id));
            if (compNodes.length === 0) return;

            // Get positions for component nodes
            const nodePositions = compNodes.map((node: any) => ({
                x: node.x,
                y: node.y,
                w: node.width || NODE_WIDTH,
                h: node.height || NODE_HEIGHT
            }));

            if (nodePositions.length === 0) return;

            // Calculate bounds from node positions (with padding)
            // Round to integers to avoid sub-pixel jitter
            comp.bounds = {
                minX: Math.round(Math.min(...nodePositions.map((p: any) => p.x - p.w / 2)) - COMPONENT_PADDING),
                maxX: Math.round(Math.max(...nodePositions.map((p: any) => p.x + p.w / 2)) + COMPONENT_PADDING),
                minY: Math.round(Math.min(...nodePositions.map((p: any) => p.y - p.h / 2)) - COMPONENT_PADDING),
                maxY: Math.round(Math.max(...nodePositions.map((p: any) => p.y + p.h / 2)) + COMPONENT_PADDING)
            };
            comp.centerX = Math.round((comp.bounds.minX + comp.bounds.maxX) / 2);
            comp.centerY = Math.round((comp.bounds.minY + comp.bounds.maxY) / 2);
        });

        // Use the exact bounds we calculated in PASS 1 and positioned in PASS 2
        // No recalculation - just apply the offset to get final bounds
        // Round to integers to avoid sub-pixel jitter on updates
        group.bounds = {
            minX: Math.round(offsetX),
            maxX: Math.round(offsetX + data.width),
            minY: Math.round(offsetY),
            maxY: Math.round(offsetY + data.height)
        };
        // Store layout bounds separately for formatGraph to use
        group._layoutBounds = { ...group.bounds };
        group.centerX = Math.round((group.bounds.minX + group.bounds.maxX) / 2);
        group.centerY = Math.round((group.bounds.minY + group.bounds.maxY) / 2);
    });

    // Create colored dot patterns for each workflow group
    workflowGroups.forEach((group) => {
        createWorkflowPattern(defs, group.id, group.color);
    });

    state.setOriginalPositions(originalPositions);
    state.setElkEdgeRoutes(allElkEdgeRoutes);
    state.setElkLabelPositions(allLabelPositions);

    // Build a map of which nodes are in collapsed components
    const nodesInCollapsedComponents = new Set<string>();
    workflowGroups.forEach((group: any) => {
        (group.components || []).forEach((comp: WorkflowComponent) => {
            if (!expandedComponents.has(comp.id)) {
                comp.nodes.forEach((nodeId: string) => nodesInCollapsedComponents.add(nodeId));
            }
        });
    });

    // Create expanded nodes list (nodes in valid workflows with positions)
    // This must happen BEFORE renderEdges() so edges can find node positions
    const expandedNodesList: any[] = [];
    const skippedNodes: string[] = [];

    currentGraphData.nodes.forEach((node: any) => {
        // Skip nodes in collapsed components
        if (nodesInCollapsedComponents.has(node.id)) {
            return;
        }

        const nodeWorkflows = workflowGroups.filter((g: any) =>
            g.nodes.includes(node.id) && g.nodes.length >= 3
        );

        if (nodeWorkflows.length >= 1) {
            // Node is in at least one valid workflow - add to expanded list
            expandedNodesList.push(node);
        } else {
            // Nodes in no valid workflow (< 3 nodes) are skipped
            skippedNodes.push(node.id);
        }
    });

    state.setExpandedNodes(expandedNodesList);
}
