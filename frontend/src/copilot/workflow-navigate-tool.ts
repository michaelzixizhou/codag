import * as vscode from 'vscode';
import { CacheManager } from '../cache';
import { WorkflowGraph } from '../api';
import { filterOrphanedNodes } from './graph-filter';
import { TYPE_SYMBOLS, createNodeLink } from './compact-formatter';

interface WorkflowNavigateInput {
    operation: 'path' | 'upstream' | 'downstream';
    fromNode?: string;
    toNode?: string;
    workflowName?: string;
    maxDepth?: number;
}

/**
 * Language Model Tool for navigating workflow graphs and finding paths
 * Allows LLM to analyze execution flow and dependencies
 */
class WorkflowNavigateTool implements vscode.LanguageModelTool<WorkflowNavigateInput> {
    constructor(
        private cacheManager: CacheManager
    ) {}

    async invoke(
        options: vscode.LanguageModelToolInvocationOptions<WorkflowNavigateInput>,
        _token: vscode.CancellationToken
    ): Promise<vscode.LanguageModelToolResult> {
        const input = options.input;

        try {
            console.log('[workflow-navigate] Operation:', input.operation);

            // Get the complete workflow graph
            const graph = await this.cacheManager.getMostRecentWorkflows();
            if (!graph) {
                return new vscode.LanguageModelToolResult([
                    new vscode.LanguageModelTextPart('No workflow data found. Please run visualization first.')
                ]);
            }

            // Filter out orphaned nodes and their edges (match webview rendering)
            // Use ALL nodes - don't filter by ViewState (LLM needs access to everything)
            const filteredGraph = filterOrphanedNodes(graph);
            console.log(`[workflow-navigate] Filtered to ${filteredGraph.nodes.length} nodes in LLM workflows`);

            // Helper to create compact node link with symbol
            const makeLink = (nodeId: string): string => {
                const node = filteredGraph.nodes.find(n => n.id === nodeId);
                if (!node) return nodeId;
                const sym = TYPE_SYMBOLS[node.type] || '□';
                return `${sym} ${createNodeLink(nodeId, node.label)}`;
            };

            switch (input.operation) {
                case 'path':
                    return this.findPath(filteredGraph, input.fromNode!, input.toNode!, makeLink);

                case 'upstream':
                    return this.findUpstream(filteredGraph, input.fromNode!, input.maxDepth || 5, makeLink);

                case 'downstream':
                    return this.findDownstream(filteredGraph, input.fromNode!, input.maxDepth || 5, makeLink);

                default:
                    return new vscode.LanguageModelToolResult([
                        new vscode.LanguageModelTextPart(`Unknown operation: ${input.operation}`)
                    ]);
            }

        } catch (error: any) {
            console.error('[workflow-navigate] Error:', error);
            return new vscode.LanguageModelToolResult([
                new vscode.LanguageModelTextPart(`Error navigating workflow: ${error.message}`)
            ]);
        }
    }

    private findPath(
        graph: WorkflowGraph,
        fromNodeId: string,
        toNodeId: string,
        createLink: (id: string) => string
    ): vscode.LanguageModelToolResult {
        // Build adjacency map
        const adjMap = new Map<string, string[]>();
        graph.edges.forEach(edge => {
            if (!adjMap.has(edge.source)) adjMap.set(edge.source, []);
            adjMap.get(edge.source)!.push(edge.target);
        });

        // BFS to find shortest path
        const queue: Array<{ node: string; path: string[] }> = [{ node: fromNodeId, path: [fromNodeId] }];
        const visited = new Set<string>([fromNodeId]);

        while (queue.length > 0) {
            const { node, path } = queue.shift()!;

            if (node === toNodeId) {
                // Found the path - compact format
                const pathLinks = path.map(createLink);
                const parts: string[] = [];
                parts.push(`Path (${path.length - 1} hop${path.length - 1 !== 1 ? 's' : ''}):`);
                parts.push(pathLinks.join(' → '));

                // Show files involved
                const filesInPath = new Set<string>();
                path.forEach(nodeId => {
                    const n = graph.nodes.find(n => n.id === nodeId);
                    if (n?.source?.file) {
                        filesInPath.add(n.source.file);
                    }
                });

                if (filesInPath.size > 1) {
                    parts.push(`Files: ${Array.from(filesInPath).join(', ')}`);
                }

                return new vscode.LanguageModelToolResult([
                    new vscode.LanguageModelTextPart(parts.join('\n'))
                ]);
            }

            const neighbors = adjMap.get(node) || [];
            for (const neighbor of neighbors) {
                if (!visited.has(neighbor)) {
                    visited.add(neighbor);
                    queue.push({ node: neighbor, path: [...path, neighbor] });
                }
            }
        }

        return new vscode.LanguageModelToolResult([
            new vscode.LanguageModelTextPart(`No path found from ${createLink(fromNodeId)} to ${createLink(toNodeId)}`)
        ]);
    }

    private findUpstream(
        graph: WorkflowGraph,
        nodeId: string,
        maxDepth: number,
        createLink: (id: string) => string
    ): vscode.LanguageModelToolResult {
        // Build reverse adjacency map (who points to this node)
        const reverseMap = new Map<string, string[]>();
        graph.edges.forEach(edge => {
            if (!reverseMap.has(edge.target)) reverseMap.set(edge.target, []);
            reverseMap.get(edge.target)!.push(edge.source);
        });

        // BFS backwards
        const upstream = new Map<string, number>(); // nodeId -> depth
        const queue: Array<{ node: string; depth: number }> = [{ node: nodeId, depth: 0 }];
        const visited = new Set<string>([nodeId]);

        while (queue.length > 0) {
            const { node, depth } = queue.shift()!;

            if (depth >= maxDepth) continue;

            const predecessors = reverseMap.get(node) || [];
            for (const pred of predecessors) {
                if (!visited.has(pred)) {
                    visited.add(pred);
                    upstream.set(pred, depth + 1);
                    queue.push({ node: pred, depth: depth + 1 });
                }
            }
        }

        // Compact format
        const parts: string[] = [];
        parts.push(`Upstream of ${createLink(nodeId)} (${upstream.size} nodes):`);

        if (upstream.size > 0) {
            // Group by depth
            const byDepth = new Map<number, string[]>();
            upstream.forEach((depth, node) => {
                if (!byDepth.has(depth)) byDepth.set(depth, []);
                byDepth.get(depth)!.push(node);
            });

            for (let d = 1; d <= maxDepth; d++) {
                const nodesAtDepth = byDepth.get(d);
                if (nodesAtDepth && nodesAtDepth.length > 0) {
                    const links = nodesAtDepth.map(n => createLink(n));
                    parts.push(`  ←${d}: ${links.join(', ')}`);
                }
            }
        }

        return new vscode.LanguageModelToolResult([
            new vscode.LanguageModelTextPart(parts.join('\n'))
        ]);
    }

    private findDownstream(
        graph: WorkflowGraph,
        nodeId: string,
        maxDepth: number,
        createLink: (id: string) => string
    ): vscode.LanguageModelToolResult {
        // Build adjacency map
        const adjMap = new Map<string, string[]>();
        graph.edges.forEach(edge => {
            if (!adjMap.has(edge.source)) adjMap.set(edge.source, []);
            adjMap.get(edge.source)!.push(edge.target);
        });

        // BFS forward
        const downstream = new Map<string, number>(); // nodeId -> depth
        const queue: Array<{ node: string; depth: number }> = [{ node: nodeId, depth: 0 }];
        const visited = new Set<string>([nodeId]);

        while (queue.length > 0) {
            const { node, depth } = queue.shift()!;

            if (depth >= maxDepth) continue;

            const successors = adjMap.get(node) || [];
            for (const succ of successors) {
                if (!visited.has(succ)) {
                    visited.add(succ);
                    downstream.set(succ, depth + 1);
                    queue.push({ node: succ, depth: depth + 1 });
                }
            }
        }

        // Compact format
        const parts: string[] = [];
        parts.push(`Downstream of ${createLink(nodeId)} (${downstream.size} nodes):`);

        if (downstream.size > 0) {
            // Group by depth
            const byDepth = new Map<number, string[]>();
            downstream.forEach((depth, node) => {
                if (!byDepth.has(depth)) byDepth.set(depth, []);
                byDepth.get(depth)!.push(node);
            });

            for (let d = 1; d <= maxDepth; d++) {
                const nodesAtDepth = byDepth.get(d);
                if (nodesAtDepth && nodesAtDepth.length > 0) {
                    const links = nodesAtDepth.map(n => createLink(n));
                    parts.push(`  →${d}: ${links.join(', ')}`);
                }
            }
        }

        return new vscode.LanguageModelToolResult([
            new vscode.LanguageModelTextPart(parts.join('\n'))
        ]);
    }
}

export function registerWorkflowNavigateTool(
    cacheManager: CacheManager
): vscode.Disposable | null {
    try {
        if (!vscode.lm || typeof vscode.lm.registerTool !== 'function') {
            console.warn('Language Model Tool API not available for workflow-navigate');
            return null;
        }

        const tool = new WorkflowNavigateTool(cacheManager);
        const disposable = vscode.lm.registerTool('workflow-navigate', tool);
        console.log('✅ Registered workflow-navigate tool');
        return disposable;
    } catch (error) {
        console.error('❌ Failed to register workflow-navigate tool:', error);
        return null;
    }
}
