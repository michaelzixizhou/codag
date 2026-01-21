/**
 * ELK Layout Engine
 *
 * Replaces dagre for graph layout. ELK provides:
 * - Better edge routing (orthogonal, avoiding nodes)
 * - Active maintenance (dagre unmaintained since 2018)
 * - More layout algorithms and configuration options
 */

import ELK, { ElkNode, ElkExtendedEdge } from 'elkjs/lib/elk.bundled.js';

const elk = new ELK();

// Layout options for top-down flowchart style with proper edge routing
const DEFAULT_LAYOUT_OPTIONS: Record<string, string> = {
    'elk.algorithm': 'layered',
    'elk.direction': 'DOWN',

    // Node spacing - tight layout, edges route between
    'elk.layered.spacing.nodeNodeBetweenLayers': '35',  // Vertical gap between layers
    'elk.spacing.nodeNode': '20',                        // Horizontal gap within layer

    // Edge routing - ORTHOGONAL for square edges that avoid nodes
    'elk.edgeRouting': 'ORTHOGONAL',
    'elk.layered.spacing.edgeNodeBetweenLayers': '25',  // Space between edges and nodes vertically
    'elk.layered.spacing.edgeEdgeBetweenLayers': '15',  // Vertical spacing between parallel edges
    'elk.spacing.edgeEdge': '15',                        // Horizontal spacing between parallel edges
    'elk.spacing.edgeNode': '20',                        // Minimum edge-to-node distance

    // Crossing minimization - reduce edge overlaps
    'elk.layered.crossingMinimization.strategy': 'LAYER_SWEEP',
    'elk.layered.crossingMinimization.greedySwitch.type': 'TWO_SIDED',

    // Node placement for better edge routing
    'elk.layered.nodePlacement.strategy': 'NETWORK_SIMPLEX',
    'elk.layered.nodePlacement.bk.fixedAlignment': 'BALANCED',

    // Layering strategy
    'elk.layered.layering.strategy': 'NETWORK_SIMPLEX',

    // Edge label placement
    'elk.edgeLabels.inline': 'true',

    // DO NOT merge edges - keep them separate like circuit traces
    'elk.layered.mergeEdges': 'false',
    'elk.layered.mergeHierarchyEdges': 'false',

    // Higher thoroughness = better routing quality
    'elk.layered.thoroughness': '10',
};

export interface LayoutResult {
    positions: Map<string, { x: number; y: number }>;
    edgeRoutes: Map<string, EdgeRoute>;
}

export interface EdgeRoute {
    startPoint: { x: number; y: number };
    endPoint: { x: number; y: number };
    bendPoints: { x: number; y: number }[];
}

/**
 * Layout nodes and edges using ELK
 */
export async function layoutWithELK(
    nodes: Array<{ id: string; width: number; height: number }>,
    edges: Array<{ source: string; target: string; id?: string }>,
    options?: Record<string, string>
): Promise<LayoutResult> {
    const layoutOptions = { ...DEFAULT_LAYOUT_OPTIONS, ...options };

    const graph = {
        id: 'root',
        layoutOptions,
        children: nodes.map(n => ({
            id: n.id,
            width: n.width,
            height: n.height,
        })),
        edges: edges.map((e, i) => ({
            id: e.id || `e${i}`,
            sources: [e.source],
            targets: [e.target],
        })),
    };

    const result = await elk.layout(graph);

    // Add margin equivalent to dagre's marginx/marginy (30px)
    const MARGIN = 30;

    // Extract node positions
    const positions = new Map<string, { x: number; y: number }>();

    for (const child of result.children || []) {
        // ELK returns top-left corner, we need center
        const centerX = (child.x || 0) + (child.width || 0) / 2 + MARGIN;
        const centerY = (child.y || 0) + (child.height || 0) / 2 + MARGIN;
        positions.set(child.id, { x: centerX, y: centerY });
    }

    // Extract edge routes from ELK (apply same margin offset)
    // ELK-ONLY: No fallback generation
    const edgeRoutes = new Map<string, EdgeRoute>();

    for (const edge of (result.edges || []) as ElkExtendedEdge[]) {
        const section = edge.sections?.[0];
        if (section && section.startPoint && section.endPoint) {
            edgeRoutes.set(edge.id, {
                startPoint: { x: section.startPoint.x + MARGIN, y: section.startPoint.y + MARGIN },
                endPoint: { x: section.endPoint.x + MARGIN, y: section.endPoint.y + MARGIN },
                bendPoints: (section.bendPoints || []).map(bp => ({ x: bp.x + MARGIN, y: bp.y + MARGIN })),
            });
        }
    }

    return { positions, edgeRoutes };
}

/**
 * Update layout options for different scenarios
 */
export function createLayoutOptions(overrides?: Record<string, string>): Record<string, string> {
    return { ...DEFAULT_LAYOUT_OPTIONS, ...overrides };
}
