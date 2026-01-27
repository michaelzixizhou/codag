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

    // Node spacing - comfortable for unlabeled edges, labels handled separately
    'elk.layered.spacing.nodeNodeBetweenLayers': '35',  // Vertical gap between layers
    'elk.spacing.nodeNode': '20',                        // Horizontal gap within layer

    // Edge routing - ORTHOGONAL for square edges that avoid nodes
    'elk.edgeRouting': 'ORTHOGONAL',
    'elk.layered.spacing.edgeNodeBetweenLayers': '15',  // Space between edges and nodes vertically
    'elk.layered.spacing.edgeEdgeBetweenLayers': '20',  // Vertical spacing between parallel edges (room for labels)
    'elk.spacing.edgeEdge': '20',                        // Horizontal spacing between parallel edges
    'elk.spacing.edgeNode': '12',                        // Minimum edge-to-node distance

    // Crossing minimization - reduce edge overlaps
    'elk.layered.crossingMinimization.strategy': 'LAYER_SWEEP',
    'elk.layered.crossingMinimization.greedySwitch.type': 'TWO_SIDED',

    // Node placement for better edge routing
    'elk.layered.nodePlacement.strategy': 'NETWORK_SIMPLEX',
    'elk.layered.nodePlacement.bk.fixedAlignment': 'BALANCED',

    // Layering strategy
    'elk.layered.layering.strategy': 'NETWORK_SIMPLEX',

    // Edge label placement - labels placed on edges, not between layers
    'elk.edgeLabels.inline': 'false',        // Don't reserve layer space for labels
    'elk.edgeLabels.placement': 'CENTER',
    'elk.spacing.labelLabel': '12',          // Min space between labels
    'elk.spacing.labelNode': '8',            // Min space label-to-node

    // DO NOT merge edges - keep them separate like circuit traces
    'elk.layered.mergeEdges': 'false',
    'elk.layered.mergeHierarchyEdges': 'false',

    // Higher thoroughness = better routing quality
    'elk.layered.thoroughness': '10',
};

export interface LayoutResult {
    positions: Map<string, { x: number; y: number }>;
    edgeRoutes: Map<string, EdgeRoute>;
    labelPositions: Map<string, { x: number; y: number }>;
}

export interface EdgeRoute {
    startPoint: { x: number; y: number };
    endPoint: { x: number; y: number };
    bendPoints: { x: number; y: number }[];
}

export interface EdgeInput {
    source: string;
    target: string;
    id?: string;
    label?: string;
}

// Estimate label width based on character count
function estimateLabelWidth(label: string): number {
    return Math.max(40, label.length * 7 + 16);
}

const LABEL_HEIGHT = 18;

export interface NodeInput {
    id: string;
    width: number;
    height: number;
    layoutOptions?: Record<string, string>;  // Per-node ELK options
}

/**
 * Layout nodes and edges using ELK
 */
export async function layoutWithELK(
    nodes: Array<NodeInput>,
    edges: EdgeInput[],
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
            ...(n.layoutOptions ? { layoutOptions: n.layoutOptions } : {})
        })),
        edges: edges.map((e, i) => {
            const edgeId = e.id || `e${i}`;
            const elkEdge: any = {
                id: edgeId,
                sources: [e.source],
                targets: [e.target],
            };
            // Add label for ELK to position
            if (e.label) {
                elkEdge.labels = [{
                    id: `${edgeId}_label`,
                    text: e.label,
                    width: estimateLabelWidth(e.label),
                    height: LABEL_HEIGHT,
                }];
            }
            return elkEdge;
        }),
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

    // Extract edge routes and label positions from ELK
    const edgeRoutes = new Map<string, EdgeRoute>();
    const labelPositions = new Map<string, { x: number; y: number }>();

    for (const edge of (result.edges || []) as ElkExtendedEdge[]) {
        const section = edge.sections?.[0];
        if (section && section.startPoint && section.endPoint) {
            edgeRoutes.set(edge.id, {
                startPoint: { x: section.startPoint.x + MARGIN, y: section.startPoint.y + MARGIN },
                endPoint: { x: section.endPoint.x + MARGIN, y: section.endPoint.y + MARGIN },
                bendPoints: (section.bendPoints || []).map(bp => ({ x: bp.x + MARGIN, y: bp.y + MARGIN })),
            });
        }

        // Extract label position if present
        const labels = (edge as any).labels;
        if (labels && labels.length > 0) {
            const label = labels[0];
            if (typeof label.x === 'number' && typeof label.y === 'number') {
                // ELK returns top-left of label, convert to center
                labelPositions.set(edge.id, {
                    x: label.x + (label.width || 0) / 2 + MARGIN,
                    y: label.y + (label.height || 0) / 2 + MARGIN,
                });
            }
        }
    }

    return { positions, edgeRoutes, labelPositions };
}

/**
 * Update layout options for different scenarios
 */
export function createLayoutOptions(overrides?: Record<string, string>): Record<string, string> {
    return { ...DEFAULT_LAYOUT_OPTIONS, ...overrides };
}
