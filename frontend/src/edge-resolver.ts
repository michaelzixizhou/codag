/**
 * Edge Resolver
 *
 * Resolves cross-batch edges after merging all batch results.
 * With deterministic IDs (path::function format), resolution is straightforward:
 * - Edge targets that exist as node IDs are resolved
 * - Edge targets that don't exist are unresolved cross-batch references
 *
 * Also adds cross-service edges from HTTP connection detection.
 */

import { WorkflowGraph, WorkflowEdge, WorkflowNode } from './api';
import { HttpConnection } from './http-endpoint-extractor';
import { CONFIG, SUPPORTED_EXTENSIONS } from './config';

/**
 * Parse deterministic node ID into components
 * Format: relative/path.ext::function or relative/path.ext::function::line
 * Example: main.py::handle_request → {file: "main.py", func: "handle_request"}
 * Example: backend/client.py::check::42 → {file: "backend/client.py", func: "check", line: 42}
 */
export function parseNodeId(id: string): { file: string; func: string; line?: number } | null {
    // Split on :: (unambiguous since : is forbidden in filenames)
    const parts = id.split('::');
    if (parts.length < 2) return null;

    const file = parts[0];  // First part is relative file path
    const func = parts[1];  // Second part is function name
    const line = parts[2] ? parseInt(parts[2], 10) : undefined;  // Optional line number

    return { file, func, line: isNaN(line as number) ? undefined : line };
}

/**
 * Convert module notation to file path notation
 * Handles both Python and JS/TS module imports
 * e.g., "src.db" → ["src/db.py", "src/db.ts", "src/db.js"]
 *       "src.suggestions.engine" → ["src/suggestions/engine.py", ...]
 */
function moduleToFilePaths(moduleNotation: string): string[] {
    // Split on :: to separate module from function
    const parts = moduleNotation.split('::');
    if (parts.length < 2) return [moduleNotation];

    const modulePath = parts[0];
    const funcAndRest = parts.slice(1).join('::');

    // Check if it looks like module notation (contains dots but not slashes)
    // and doesn't already have a file extension
    if (modulePath.includes('.') && !modulePath.includes('/')) {
        // Check if last segment looks like a file extension
        const segments = modulePath.split('.');
        const lastSegment = segments[segments.length - 1];
        // Check against known extensions (without leading dot)
        const knownExtensions = SUPPORTED_EXTENSIONS.map(e => e.slice(1));
        const hasExtension = knownExtensions.includes(lastSegment);

        if (!hasExtension) {
            // Convert dots to slashes and try multiple extensions
            const basePath = modulePath.replace(/\./g, '/');
            const extensions = [...SUPPORTED_EXTENSIONS, ''];
            return extensions.map(ext => `${basePath}${ext}::${funcAndRest}`);
        }
    }

    return [moduleNotation];
}

/**
 * Build lookup map from nodes with multiple matching strategies
 */
export function buildNodeLookup(nodes: WorkflowGraph['nodes']): {
    exact: Set<string>;
    byFunction: Map<string, string[]>;  // function name → full node IDs
    byFileSuffix: Map<string, string[]>;  // "filename::func" → full node IDs
    byPathSuffix: Map<string, string[]>;  // "partial/path/file::func" → full node IDs (multiple depths)
} {
    const exact = new Set<string>();
    const byFunction = new Map<string, string[]>();
    const byFileSuffix = new Map<string, string[]>();
    const byPathSuffix = new Map<string, string[]>();

    for (const node of nodes) {
        exact.add(node.id);
        exact.add(node.id.toLowerCase());

        const parsed = parseNodeId(node.id);
        if (parsed) {
            // Add to function lookup
            const funcKey = parsed.func.toLowerCase();
            if (!byFunction.has(funcKey)) {
                byFunction.set(funcKey, []);
            }
            byFunction.get(funcKey)!.push(node.id);

            // Add to file suffix lookup (e.g., "db.py::create_call" → node.id)
            const pathParts = parsed.file.split('/');
            const fileBasename = pathParts.pop() || parsed.file;
            const suffixKey = `${fileBasename}::${parsed.func}`.toLowerCase();
            if (!byFileSuffix.has(suffixKey)) {
                byFileSuffix.set(suffixKey, []);
            }
            byFileSuffix.get(suffixKey)!.push(node.id);

            // Add path suffix lookups at multiple depths
            // e.g., for "app/services/broker-api/src/db.py::func"
            // add: "src/db.py::func", "broker-api/src/db.py::func", etc.
            const maxDepth = CONFIG.EDGE_RESOLUTION.PATH_MATCHING_DEPTH;
            let pathSuffix = fileBasename;
            for (let i = pathParts.length - 1; i >= 0 && i >= pathParts.length - maxDepth; i--) {
                pathSuffix = pathParts[i] + '/' + pathSuffix;
                const pathKey = `${pathSuffix}::${parsed.func}`.toLowerCase();
                if (!byPathSuffix.has(pathKey)) {
                    byPathSuffix.set(pathKey, []);
                }
                byPathSuffix.get(pathKey)!.push(node.id);
            }
        }
    }

    return { exact, byFunction, byFileSuffix, byPathSuffix };
}

/**
 * Pick best match from multiple candidates
 * Prefers nodes WITHOUT line numbers (function entry points) over nodes WITH line numbers
 */
function pickBestMatch(matches: string[]): string | null {
    if (!matches || matches.length === 0) return null;
    if (matches.length === 1) return matches[0];

    // Prefer nodes without line numbers (file::func over file::func::line)
    const entryPoints = matches.filter(m => {
        const parts = m.split('::');
        // Entry point has exactly 2 parts (file::func), not 3+ (file::func::line)
        return parts.length === 2;
    });

    if (entryPoints.length === 1) {
        return entryPoints[0];  // Unambiguous entry point
    }
    if (entryPoints.length > 1) {
        // Multiple entry points - pick shortest path (likely most specific)
        return entryPoints.sort((a, b) => a.length - b.length)[0];
    }

    // No entry points, all have line numbers - pick the first (lowest line number typically)
    return matches.sort()[0];
}

/**
 * Try to find a matching node ID for a target that might be in module notation
 * Uses multiple fallback strategies:
 * 1. Exact match
 * 2. Module notation → file path conversion (multiple extensions)
 * 3. Path suffix matching at various depths
 * 4. File basename + function name matching
 */
export function findMatchingNodeId(
    target: string,
    lookup: ReturnType<typeof buildNodeLookup>
): string | null {
    // Strategy 1: Exact match
    if (lookup.exact.has(target) || lookup.exact.has(target.toLowerCase())) {
        return target;
    }

    // Strategy 2: Convert module notation to file paths and try each
    const convertedPaths = moduleToFilePaths(target);
    for (const converted of convertedPaths) {
        if (converted !== target) {
            if (lookup.exact.has(converted) || lookup.exact.has(converted.toLowerCase())) {
                return converted;
            }

            // Try path suffix match for converted path
            const parsed = parseNodeId(converted);
            if (parsed) {
                // Try progressively shorter path suffixes
                const pathParts = parsed.file.split('/');
                let pathSuffix = '';
                for (let i = pathParts.length - 1; i >= 0; i--) {
                    pathSuffix = pathSuffix ? pathParts[i] + '/' + pathSuffix : pathParts[i];
                    const suffixKey = `${pathSuffix}::${parsed.func}`.toLowerCase();

                    // Check byPathSuffix first (more specific)
                    const pathMatches = lookup.byPathSuffix.get(suffixKey);
                    const bestPath = pickBestMatch(pathMatches || []);
                    if (bestPath) return bestPath;

                    // Fall back to byFileSuffix
                    if (i === pathParts.length - 1) {
                        const fileMatches = lookup.byFileSuffix.get(suffixKey);
                        const bestFile = pickBestMatch(fileMatches || []);
                        if (bestFile) return bestFile;
                    }
                }
            }
        }
    }

    // Strategy 3: Try path suffix match on original target
    const parsed = parseNodeId(target);
    if (parsed) {
        const pathParts = parsed.file.split('/');
        let pathSuffix = '';
        for (let i = pathParts.length - 1; i >= 0; i--) {
            pathSuffix = pathSuffix ? pathParts[i] + '/' + pathSuffix : pathParts[i];
            const suffixKey = `${pathSuffix}::${parsed.func}`.toLowerCase();

            const pathMatches = lookup.byPathSuffix.get(suffixKey);
            const bestPath = pickBestMatch(pathMatches || []);
            if (bestPath) return bestPath;

            if (i === pathParts.length - 1) {
                const fileMatches = lookup.byFileSuffix.get(suffixKey);
                const bestFile = pickBestMatch(fileMatches || []);
                if (bestFile) return bestFile;
            }
        }
    }

    // Strategy 4: Last resort - match by function name only
    if (parsed) {
        const funcMatches = lookup.byFunction.get(parsed.func.toLowerCase());
        const bestFunc = pickBestMatch(funcMatches || []);
        if (bestFunc) return bestFunc;
    }

    return null;
}

/**
 * Resolve cross-batch edges after merging all batch results.
 * Returns the graph with edges validated and stats.
 * Handles module notation to file path conversion for cross-batch references.
 */
export function resolveExternalEdges(graph: WorkflowGraph): {
    graph: WorkflowGraph;
    resolved: number;
    unresolved: string[];
} {
    const lookup = buildNodeLookup(graph.nodes);
    const resolvedEdges: WorkflowEdge[] = [];
    const unresolvedTargets: string[] = [];
    let resolvedCount = 0;

    for (const edge of graph.edges) {
        // Check if source exists (try fuzzy matching)
        const resolvedSource = findMatchingNodeId(edge.source, lookup);
        if (!resolvedSource) {
            // Source doesn't exist - skip this edge entirely
            unresolvedTargets.push(`source:${edge.source}`);
            continue;
        }

        // Check if target exists (try fuzzy matching for module notation)
        const resolvedTarget = findMatchingNodeId(edge.target, lookup);
        if (resolvedTarget) {
            // Both endpoints exist - edge is valid
            // Use resolved IDs (may be different from original if fuzzy matched)
            resolvedEdges.push({
                ...edge,
                source: resolvedSource,
                target: resolvedTarget
            });
            resolvedCount++;
        } else {
            // Target doesn't exist - unresolved cross-batch reference
            unresolvedTargets.push(edge.target);
        }
    }

    return {
        graph: {
            ...graph,
            edges: resolvedEdges
        },
        resolved: resolvedCount,
        unresolved: unresolvedTargets
    };
}

/**
 * Log resolution statistics
 */
export function logResolutionStats(
    resolved: number,
    unresolved: string[],
    log: (msg: string) => void
): void {
    if (resolved > 0) {
        log(`Resolved ${resolved} cross-batch edge(s)`);
    }

    if (unresolved.length > 0) {
        log(`${unresolved.length} unresolved cross-batch reference(s):`);
        for (const ref of unresolved.slice(0, 5)) {
            log(`   - ${ref}`);
        }
        if (unresolved.length > 5) {
            log(`   ... and ${unresolved.length - 5} more`);
        }
    }
}

/**
 * Add cross-service edges from HTTP connections to the graph.
 * Creates edges between HTTP client calls and their matched route handlers.
 * Also creates placeholder nodes if endpoints don't exist as nodes yet.
 */
export function addHttpConnectionEdges(
    graph: WorkflowGraph,
    httpConnections: HttpConnection[]
): { graph: WorkflowGraph; addedEdges: number; addedNodes: number } {
    if (!httpConnections || httpConnections.length === 0) {
        return { graph, addedEdges: 0, addedNodes: 0 };
    }

    const existingNodeIds = new Set(graph.nodes.map(n => n.id));
    const newNodes: WorkflowNode[] = [];
    const newEdges: WorkflowEdge[] = [];

    for (const conn of httpConnections) {
        // Build node IDs in deterministic format
        const clientNodeId = `${conn.client.file}::${conn.client.function}`;
        const handlerNodeId = `${conn.handler.file}::${conn.handler.function}`;

        // Create placeholder node for client if it doesn't exist
        if (!existingNodeIds.has(clientNodeId)) {
            newNodes.push({
                id: clientNodeId,
                label: `${conn.client.method} ${conn.client.normalizedPath}`,
                type: 'step',
                source: {
                    file: conn.client.file,
                    line: conn.client.line,
                    function: conn.client.function
                }
            });
            existingNodeIds.add(clientNodeId);
        }

        // Create placeholder node for handler if it doesn't exist
        if (!existingNodeIds.has(handlerNodeId)) {
            newNodes.push({
                id: handlerNodeId,
                label: `Handle ${conn.handler.path}`,
                type: 'step',
                source: {
                    file: conn.handler.file,
                    line: conn.handler.line,
                    function: conn.handler.function
                }
            });
            existingNodeIds.add(handlerNodeId);
        }

        // Create edge between client and handler
        const edgeLabel = `${conn.client.method} ${conn.client.normalizedPath}`;
        const edgeExists = graph.edges.some(
            e => e.source === clientNodeId && e.target === handlerNodeId
        );

        if (!edgeExists) {
            newEdges.push({
                source: clientNodeId,
                target: handlerNodeId,
                label: edgeLabel
            });
        }
    }

    return {
        graph: {
            ...graph,
            nodes: [...graph.nodes, ...newNodes],
            edges: [...graph.edges, ...newEdges]
        },
        addedEdges: newEdges.length,
        addedNodes: newNodes.length
    };
}
