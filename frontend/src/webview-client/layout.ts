// Dagre layout and workflow grid tiling
import * as state from './state';
import { snapToGrid, getNodeWorkflowCount, getVirtualNodeId } from './utils';
import { createWorkflowPattern } from './setup';
import { calculateGroupBounds } from './helpers';
import { measureTextWidth } from './groups';
import {
    NODE_WIDTH, NODE_HEIGHT,
    DAGRE_NODESEP, DAGRE_RANKSEP, DAGRE_MARGIN,
    WORKFLOW_SPACING,
    GROUP_TITLE_OFFSET_X,
    COLLAPSED_COMPONENT_WIDTH, COLLAPSED_COMPONENT_HEIGHT
} from './constants';
import { WorkflowComponent } from './types';

declare const dagre: any;
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

/**
 * Get component placeholder ID
 */
function getComponentPlaceholderId(componentId: string): string {
    return `__comp_${componentId}`;
}

// Temporary storage for workflow layout data during two-pass layout
interface WorkflowLayoutData {
    group: any;
    nodes: any[];
    localPositions: Map<string, { x: number; y: number }>;
    width: number;
    height: number;
    offsetX: number;
    offsetY: number;
    // Component-related data
    nodeToComponentPlaceholder: Map<string, string>;
    components: WorkflowComponent[];
}

export function layoutWorkflows(defs: any): void {
    const { currentGraphData, workflowGroups, originalPositions, g } = state;
    const expandedComponents = state.getExpandedComponents();

    const layoutData: WorkflowLayoutData[] = [];

    // ========== PASS 1: Layout each workflow individually with dagre ==========
    workflowGroups.forEach((group, idx) => {
        const allGroupNodes = currentGraphData.nodes.filter((n: any) =>
            group.nodes.includes(n.id)
        );

        if (allGroupNodes.length < 3) return;

        const components = group.components || [];

        // Create dagre graph for this workflow
        const dagreGraph = new dagre.graphlib.Graph();
        dagreGraph.setGraph({
            rankdir: 'LR',
            nodesep: DAGRE_NODESEP,
            ranksep: DAGRE_RANKSEP,
            marginx: DAGRE_MARGIN,
            marginy: DAGRE_MARGIN
        });
        dagreGraph.setDefaultEdgeLabel(() => ({}));

        // Track which component placeholders have been added
        const addedComponentPlaceholders = new Set<string>();
        // Map node IDs to their component placeholder (if collapsed)
        const nodeToComponentPlaceholder = new Map<string, string>();

        // Add nodes: either regular nodes or component placeholders
        allGroupNodes.forEach((node: any) => {
            const collapsedComp = findCollapsedComponent(node.id, components, expandedComponents);

            if (collapsedComp) {
                // Node is in a collapsed component
                const placeholderId = getComponentPlaceholderId(collapsedComp.id);
                nodeToComponentPlaceholder.set(node.id, placeholderId);

                if (!addedComponentPlaceholders.has(collapsedComp.id)) {
                    // Add placeholder node for this component
                    dagreGraph.setNode(placeholderId, {
                        width: COLLAPSED_COMPONENT_WIDTH,
                        height: COLLAPSED_COMPONENT_HEIGHT
                    });
                    addedComponentPlaceholders.add(collapsedComp.id);
                }
            } else {
                // Regular node (not in collapsed component)
                dagreGraph.setNode(node.id, { width: NODE_WIDTH, height: NODE_HEIGHT });
            }
        });

        // Add edges (transform to use component placeholders where needed)
        currentGraphData.edges.forEach((edge: any) => {
            if (group.nodes.includes(edge.source) && group.nodes.includes(edge.target)) {
                const sourceId = nodeToComponentPlaceholder.get(edge.source) || edge.source;
                const targetId = nodeToComponentPlaceholder.get(edge.target) || edge.target;

                // Skip internal edges within same collapsed component
                if (sourceId === targetId && sourceId.startsWith('__comp_')) {
                    return;
                }

                // Only add edge if not already added (dedup for component edges)
                if (!dagreGraph.hasEdge(sourceId, targetId)) {
                    dagreGraph.setEdge(sourceId, targetId);
                }
            }
        });

        dagre.layout(dagreGraph);

        // Store LOCAL positions (no global offset yet)
        const localPositions = new Map<string, { x: number; y: number }>();

        // First, store positions for component placeholders
        addedComponentPlaceholders.forEach(compId => {
            const placeholderId = getComponentPlaceholderId(compId);
            const pos = dagreGraph.node(placeholderId);
            if (pos && typeof pos.x === 'number' && typeof pos.y === 'number') {
                localPositions.set(placeholderId, { x: snapToGrid(pos.x), y: snapToGrid(pos.y) });
            }
        });

        // Then store positions for regular nodes (not in collapsed components)
        allGroupNodes.forEach((node: any) => {
            const collapsedComp = findCollapsedComponent(node.id, components, expandedComponents);
            if (collapsedComp) {
                // Node is in collapsed component - position comes from placeholder
                // We'll handle this when rendering
                return;
            }

            const pos = dagreGraph.node(node.id);
            if (pos && typeof pos.x === 'number' && typeof pos.y === 'number') {
                const isShared = getNodeWorkflowCount(node.id, workflowGroups) > 1;
                const key = isShared ? getVirtualNodeId(node.id, group.id) : node.id;
                localPositions.set(key, { x: snapToGrid(pos.x), y: snapToGrid(pos.y) });
            }
        });

        // Calculate local bounds
        const positions = Array.from(localPositions.values());
        if (positions.length === 0) return;

        const xs = positions.map(p => p.x);
        const ys = positions.map(p => p.y);
        const localBounds = {
            minX: Math.min(...xs) - 90,  // GROUP_BOUNDS_PADDING_X
            maxX: Math.max(...xs) + 90,
            minY: Math.min(...ys) - 126, // GROUP_BOUNDS_PADDING_TOP
            maxY: Math.max(...ys) + 81   // GROUP_BOUNDS_PADDING_BOTTOM
        };

        // Expand for title
        const fontFamily = '"Inter", "Segoe UI", "SF Pro Display", -apple-system, sans-serif';
        const titleText = `${group.name} (${group.nodes.length} nodes)`;
        const titleWidth = measureTextWidth(titleText, '19px', '500', fontFamily);
        const requiredWidth = titleWidth + GROUP_TITLE_OFFSET_X + 40;
        const currentWidth = localBounds.maxX - localBounds.minX;
        if (requiredWidth > currentWidth) {
            localBounds.maxX = localBounds.minX + requiredWidth;
        }

        const width = localBounds.maxX - localBounds.minX;
        const height = localBounds.maxY - localBounds.minY;

        layoutData.push({
            group,
            nodes: allGroupNodes,
            localPositions,
            width,
            height,
            offsetX: 0,
            offsetY: 0,
            nodeToComponentPlaceholder,
            components
        });
    });

    // ========== PASS 2: Grid tiling (row-based shelf packing for square-ish layout) ==========
    if (layoutData.length > 0) {
        // Calculate target width for square-ish layout
        const totalArea = layoutData.reduce((sum, d) => sum + d.width * d.height, 0);
        const targetWidth = Math.sqrt(totalArea) * 1.2; // Slight bias for wider layout

        let currentX = 0;
        let currentY = 0;
        let rowMaxHeight = 0;

        layoutData.forEach((data, idx) => {
            // Check if we need to start a new row
            if (currentX > 0 && currentX + data.width > targetWidth) {
                currentX = 0;
                currentY += rowMaxHeight + WORKFLOW_SPACING;
                rowMaxHeight = 0;
            }

            data.offsetX = currentX;
            data.offsetY = currentY;

            currentX += data.width + WORKFLOW_SPACING;
            rowMaxHeight = Math.max(rowMaxHeight, data.height);
        });
    }

    // ========== PASS 3: Apply global offsets and finalize positions ==========
    layoutData.forEach((data) => {
        const { group, nodes, localPositions, offsetX, offsetY, nodeToComponentPlaceholder, components } = data;

        // First, apply offsets to component placeholder positions and update component bounds
        components.forEach((comp: WorkflowComponent) => {
            const placeholderId = getComponentPlaceholderId(comp.id);
            const localPos = localPositions.get(placeholderId);
            if (localPos) {
                const x = localPos.x + offsetX;
                const y = localPos.y + offsetY;
                comp.centerX = x;
                comp.centerY = y;
                comp.bounds = {
                    minX: x - COLLAPSED_COMPONENT_WIDTH / 2,
                    maxX: x + COLLAPSED_COMPONENT_WIDTH / 2,
                    minY: y - COLLAPSED_COMPONENT_HEIGHT / 2,
                    maxY: y + COLLAPSED_COMPONENT_HEIGHT / 2
                };
                // Store component placeholder position for edge routing
                originalPositions.set(placeholderId, { x, y });
            }
        });

        // Apply offset to all regular node positions (not in collapsed components)
        nodes.forEach((node: any) => {
            // Skip nodes in collapsed components
            if (nodeToComponentPlaceholder.has(node.id)) {
                return;
            }

            const isShared = getNodeWorkflowCount(node.id, workflowGroups) > 1;
            const key = isShared ? getVirtualNodeId(node.id, group.id) : node.id;
            const localPos = localPositions.get(key);

            if (localPos) {
                const x = localPos.x + offsetX;
                const y = localPos.y + offsetY;

                if (isShared) {
                    originalPositions.set(key, { x, y });
                } else {
                    node.x = x;
                    node.y = y;
                    node.fx = x;
                    node.fy = y;
                    originalPositions.set(node.id, { x, y });
                }
            }
        });

        // Calculate final bounds with offset (include both regular nodes and component placeholders)
        const nodesWithPositions = nodes
            .filter((node: any) => !nodeToComponentPlaceholder.has(node.id)) // Exclude nodes in collapsed components
            .map((node: any) => {
                const isShared = getNodeWorkflowCount(node.id, workflowGroups) > 1;
                if (isShared) {
                    const virtualId = getVirtualNodeId(node.id, group.id);
                    const pos = originalPositions.get(virtualId);
                    return pos ? { ...node, x: pos.x, y: pos.y } : null;
                } else {
                    return node;
                }
            }).filter((n: any) => n && typeof n.x === 'number' && typeof n.y === 'number');

        // Add component placeholders as pseudo-nodes for bounds calculation
        components.forEach((comp: WorkflowComponent) => {
            if (comp.centerX !== undefined && comp.centerY !== undefined) {
                nodesWithPositions.push({
                    id: getComponentPlaceholderId(comp.id),
                    x: comp.centerX,
                    y: comp.centerY,
                    _isComponentPlaceholder: true
                });
            }
        });

        if (nodesWithPositions.length === 0) return;

        const boundsResult = calculateGroupBounds(nodesWithPositions);
        if (!boundsResult) return;

        group.bounds = boundsResult.bounds;

        // Expand bounds to fit title if needed
        const fontFamily = '"Inter", "Segoe UI", "SF Pro Display", -apple-system, sans-serif';
        const titleText = `${group.name} (${group.nodes.length} nodes)`;
        const titleWidth = measureTextWidth(titleText, '19px', '500', fontFamily);
        const requiredWidth = titleWidth + GROUP_TITLE_OFFSET_X + 40;
        const currentWidth = group.bounds.maxX - group.bounds.minX;
        if (requiredWidth > currentWidth) {
            group.bounds.maxX = group.bounds.minX + requiredWidth;
        }

        group.centerX = (group.bounds.minX + group.bounds.maxX) / 2;
        group.centerY = (group.bounds.minY + group.bounds.maxY) / 2;
    });

    // Create colored dot patterns for each workflow group
    workflowGroups.forEach((group) => {
        createWorkflowPattern(defs, group.id, group.color);
    });

    state.setOriginalPositions(originalPositions);

    // Build a map of which nodes are in collapsed components
    const nodesInCollapsedComponents = new Set<string>();
    workflowGroups.forEach((group: any) => {
        (group.components || []).forEach((comp: WorkflowComponent) => {
            if (!expandedComponents.has(comp.id)) {
                comp.nodes.forEach((nodeId: string) => nodesInCollapsedComponents.add(nodeId));
            }
        });
    });

    // Create expanded nodes (shared nodes become virtual copies per workflow)
    // This must happen BEFORE renderEdges() so edges can find node positions
    const expandedNodesList: any[] = [];
    const sharedNodeCopies = new Map<string, string[]>();

    currentGraphData.nodes.forEach((node: any) => {
        // Skip nodes in collapsed components
        if (nodesInCollapsedComponents.has(node.id)) {
            return;
        }

        const nodeWorkflows = workflowGroups.filter((g: any) =>
            g.nodes.includes(node.id) && g.nodes.length >= 3
        );

        if (nodeWorkflows.length > 1) {
            // Shared node: create a copy for each workflow
            nodeWorkflows.forEach((wf: any) => {
                const virtualId = getVirtualNodeId(node.id, wf.id);
                const pos = originalPositions.get(virtualId) || { x: 0, y: 0 };
                expandedNodesList.push({
                    ...node,
                    id: virtualId,
                    _originalId: node.id,
                    _workflowId: wf.id,
                    x: pos.x,
                    y: pos.y,
                    fx: pos.x,
                    fy: pos.y
                });
                if (!sharedNodeCopies.has(node.id)) {
                    sharedNodeCopies.set(node.id, []);
                }
                sharedNodeCopies.get(node.id)!.push(virtualId);
            });
        } else if (nodeWorkflows.length === 1) {
            // Non-shared node: use original (position already set on node object)
            expandedNodesList.push(node);
        }
        // Nodes in no valid workflow (< 3 nodes) are skipped
    });

    state.setExpandedNodes(expandedNodesList);
    state.setSharedNodeCopies(sharedNodeCopies);
}
