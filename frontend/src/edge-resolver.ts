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
import { HttpConnection, CrossFileCall } from './repo-structure';
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
 * Extract relative path from a potentially full path.
 * Looks for common project markers (backend/, frontend/, src/) to find relative portion.
 */
function toRelativePath(fullPath: string): string {
    // Already relative if doesn't start with /
    if (!fullPath.startsWith('/')) return fullPath;

    // Look for common project directory markers
    const markers = ['backend/', 'frontend/', 'src/', 'lib/', 'app/', 'pkg/', 'cmd/'];
    for (const marker of markers) {
        const idx = fullPath.indexOf(marker);
        if (idx !== -1) {
            return fullPath.slice(idx);
        }
    }

    // Fallback: take last 2-3 path segments
    const parts = fullPath.split('/').filter(Boolean);
    if (parts.length >= 3) {
        return parts.slice(-3).join('/');
    }
    if (parts.length >= 2) {
        return parts.slice(-2).join('/');
    }
    return parts[parts.length - 1] || fullPath;
}

/**
 * Add cross-service edges from HTTP connections to the graph.
 * Creates edges between HTTP client calls and their matched route handlers.
 * Uses fuzzy path matching to connect full paths to relative node IDs.
 */
export function addHttpConnectionEdges(
    graph: WorkflowGraph,
    httpConnections: HttpConnection[],
    log?: (msg: string) => void
): { graph: WorkflowGraph; addedEdges: number; addedNodes: number } {
    const _log = log || console.log;

    if (!httpConnections || httpConnections.length === 0) {
        return { graph, addedEdges: 0, addedNodes: 0 };
    }

    // Build lookup for fuzzy matching (handles path suffix matching)
    const lookup = buildNodeLookup(graph.nodes);
    const existingNodeIds = new Set(graph.nodes.map(n => n.id));
    const newNodes: WorkflowNode[] = [];
    const newEdges: WorkflowEdge[] = [];

    for (const conn of httpConnections) {
        // Convert full paths to relative paths for node ID matching
        const clientRelPath = toRelativePath(conn.client.file);
        const handlerRelPath = toRelativePath(conn.handler.file);

        // Build candidate node IDs (relative paths)
        const clientCandidateId = `${clientRelPath}::${conn.client.function}`;
        const handlerCandidateId = `${handlerRelPath}::${conn.handler.function}`;

        // Try fuzzy matching to find existing nodes
        const matchedClientId = findMatchingNodeId(clientCandidateId, lookup);
        const matchedHandlerId = findMatchingNodeId(handlerCandidateId, lookup);

        // Use matched ID if found, otherwise use relative path candidate
        const clientNodeId = matchedClientId || clientCandidateId;
        const handlerNodeId = matchedHandlerId || handlerCandidateId;

        // Create placeholder node for client if no match found
        if (!matchedClientId && !existingNodeIds.has(clientNodeId)) {
            newNodes.push({
                id: clientNodeId,
                label: `${conn.client.method} ${conn.client.normalizedPath}`,
                type: 'step',
                source: {
                    file: clientRelPath,  // Use relative path
                    line: conn.client.line,
                    function: conn.client.function
                }
            });
            existingNodeIds.add(clientNodeId);
            // Add to lookup for subsequent matches
            lookup.exact.add(clientNodeId);
            lookup.exact.add(clientNodeId.toLowerCase());
        }

        // Create placeholder node for handler if no match found
        if (!matchedHandlerId && !existingNodeIds.has(handlerNodeId)) {
            newNodes.push({
                id: handlerNodeId,
                label: `Handle ${conn.handler.path}`,
                type: 'step',
                source: {
                    file: handlerRelPath,  // Use relative path
                    line: conn.handler.line,
                    function: conn.handler.function
                }
            });
            existingNodeIds.add(handlerNodeId);
            lookup.exact.add(handlerNodeId);
            lookup.exact.add(handlerNodeId.toLowerCase());
        }

        // Create edge between client and handler
        const edgeLabel = `${conn.client.method} ${conn.client.normalizedPath}`;
        const edgeExists = graph.edges.some(
            e => e.source === clientNodeId && e.target === handlerNodeId
        ) || newEdges.some(
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

    _log(`[HTTP] Added ${newEdges.length} edges, ${newNodes.length} nodes`);

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

/**
 * Add edges from frontend callers to HTTP client functions.
 * This completes the chain: frontend_caller → api.ts::httpMethod → backend handler
 *
 * @param graph - Graph that already has HTTP client nodes (from addHttpConnectionEdges)
 * @param httpConnections - HTTP connections detected
 * @param repoStructure - Repo structure with function call information
 * @param log - Logger function
 */
export function addHttpCallerEdges(
    graph: WorkflowGraph,
    httpConnections: HttpConnection[],
    repoFiles: { path: string; functions: { name: string; calls: string[]; line: number }[] }[],
    log?: (msg: string) => void
): { graph: WorkflowGraph; addedEdges: number; addedNodes: number } {
    const _log = log || console.log;

    if (!httpConnections || httpConnections.length === 0 || !repoFiles || repoFiles.length === 0) {
        return { graph, addedEdges: 0, addedNodes: 0 };
    }

    let lookup = buildNodeLookup(graph.nodes);
    const existingEdges = new Set(graph.edges.map(e => `${e.source}::${e.target}`));
    const existingNodeIds = new Set(graph.nodes.map(n => n.id));
    const newEdges: WorkflowEdge[] = [];
    const newNodes: WorkflowNode[] = [];

    // Build a set of HTTP client function names to look for
    const httpClientFunctions = new Map<string, string>(); // funcName → nodeId
    for (const conn of httpConnections) {
        const clientRelPath = toRelativePath(conn.client.file);
        const clientNodeId = `${clientRelPath}::${conn.client.function}`;
        // Try to find the actual node ID (might be fuzzy matched)
        const matchedId = findMatchingNodeId(clientNodeId, lookup) || clientNodeId;
        httpClientFunctions.set(conn.client.function, matchedId);
        // Also add variations (e.g., "api.analyzeWorkflow" → "analyzeWorkflow")
        httpClientFunctions.set(`api.${conn.client.function}`, matchedId);
        httpClientFunctions.set(`this.api.${conn.client.function}`, matchedId);
    }

    // Search all functions for calls to HTTP client functions
    for (const file of repoFiles) {
        const fileRelPath = toRelativePath(file.path);

        for (const func of file.functions) {
            for (const call of func.calls) {
                // Check if this call matches any HTTP client function
                // Handle patterns like: api.analyzeWorkflow, this.api.analyzeWorkflow, analyzeWorkflow
                const callParts = call.split('.');
                const funcName = callParts[callParts.length - 1];

                // Check direct match or with api prefix
                const targetNodeId = httpClientFunctions.get(call) ||
                                   httpClientFunctions.get(funcName) ||
                                   httpClientFunctions.get(`api.${funcName}`);

                if (targetNodeId) {
                    const callerNodeId = `${fileRelPath}::${func.name}`;
                    let matchedCallerId = findMatchingNodeId(callerNodeId, lookup);

                    // If caller node doesn't exist, create it
                    if (!matchedCallerId && !existingNodeIds.has(callerNodeId)) {
                        const newNode: WorkflowNode = {
                            id: callerNodeId,
                            label: func.name,
                            type: 'step',
                            description: `Calls ${funcName}()`,
                            source: {
                                file: file.path,
                                line: func.line,
                                function: func.name
                            }
                        };
                        newNodes.push(newNode);
                        existingNodeIds.add(callerNodeId);
                        matchedCallerId = callerNodeId;
                        // Rebuild lookup with new node
                        lookup = buildNodeLookup([...graph.nodes, ...newNodes]);
                    }

                    if (matchedCallerId) {
                        const edgeKey = `${matchedCallerId}::${targetNodeId}`;
                        if (!existingEdges.has(edgeKey)) {
                            newEdges.push({
                                source: matchedCallerId,
                                target: targetNodeId,
                                label: `${funcName}()`
                            });
                            existingEdges.add(edgeKey);
                        }
                    }
                }
            }
        }
    }

    _log(`[HTTP-CALLERS] Added ${newNodes.length} nodes, ${newEdges.length} edges`);

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

/**
 * Add cross-file function call edges to the graph.
 * These are statically detected calls between files (e.g., main.py calling gemini_client.py).
 * Uses fuzzy path matching to connect to existing nodes.
 */
export function addCrossFileCallEdges(
    graph: WorkflowGraph,
    crossFileCalls: CrossFileCall[],
    log?: (msg: string) => void
): { graph: WorkflowGraph; addedEdges: number } {
    const _log = log || console.log;

    if (!crossFileCalls || crossFileCalls.length === 0) {
        return { graph, addedEdges: 0 };
    }

    // Build lookup for fuzzy matching
    const lookup = buildNodeLookup(graph.nodes);
    const existingEdges = new Set(
        graph.edges.map(e => `${e.source}::${e.target}`)
    );
    const newEdges: WorkflowEdge[] = [];

    for (const call of crossFileCalls) {
        // Build candidate node IDs
        const callerRelPath = toRelativePath(call.caller.file);
        const calleeRelPath = toRelativePath(call.callee.file);

        const callerCandidateId = `${callerRelPath}::${call.caller.function}`;
        const calleeCandidateId = `${calleeRelPath}::${call.callee.function}`;

        // Try fuzzy matching to find existing nodes
        const matchedCallerId = findMatchingNodeId(callerCandidateId, lookup);
        const matchedCalleeId = findMatchingNodeId(calleeCandidateId, lookup);

        // Only create edge if BOTH nodes exist
        if (matchedCallerId && matchedCalleeId) {
            const edgeKey = `${matchedCallerId}::${matchedCalleeId}`;
            if (!existingEdges.has(edgeKey)) {
                newEdges.push({
                    source: matchedCallerId,
                    target: matchedCalleeId,
                    label: call.callee.module ? `${call.callee.module}.${call.callee.function}()` : undefined
                });
                existingEdges.add(edgeKey);
            }
        }
    }

    _log(`[CROSS-FILE] Added ${newEdges.length} edges`);

    return {
        graph: {
            ...graph,
            edges: [...graph.edges, ...newEdges]
        },
        addedEdges: newEdges.length
    };
}
