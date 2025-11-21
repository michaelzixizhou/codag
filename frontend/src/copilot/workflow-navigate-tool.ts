import * as vscode from 'vscode';
import { CacheManager } from '../cache';
import { WorkflowGraph } from '../api';
import { ViewState } from './types';
import { filterGraphToExpanded } from './filter-utils';
import { filterOrphanedNodes } from './graph-filter';

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
        private cacheManager: CacheManager,
        private getViewState: () => ViewState | null
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
            const graphWithoutOrphans = filterOrphanedNodes(graph);
            console.log(`[workflow-navigate] Filtered to ${graphWithoutOrphans.nodes.length} nodes in LLM workflows`);

            // Filter to only nodes in visible/expanded workflows
            const viewState = this.getViewState();
            const filteredGraph = filterGraphToExpanded(
                graphWithoutOrphans,
                viewState?.expandedWorkflowIds || []
            );
            if (viewState?.expandedWorkflowIds && viewState.expandedWorkflowIds.length > 0) {
                console.log(`[workflow-navigate] Filtered to ${filteredGraph.nodes.length} nodes in ${filteredGraph.workflows.length} expanded workflows`);
            }

            // Helper to create clickable node link
            const createNodeLink = (nodeId: string): string => {
                const node = filteredGraph.nodes.find(n => n.id === nodeId);
                if (!node) return nodeId;
                const commandUri = `command:aiworkflowviz.focusNode?${encodeURIComponent(JSON.stringify([nodeId, node.label]))}`;
                return `[${node.label}](${commandUri} "${node.label} (${node.type})")`;
            };

            switch (input.operation) {
                case 'path':
                    return this.findPath(filteredGraph, input.fromNode!, input.toNode!, createNodeLink);

                case 'upstream':
                    return this.findUpstream(filteredGraph, input.fromNode!, input.maxDepth || 5, createNodeLink);

                case 'downstream':
                    return this.findDownstream(filteredGraph, input.fromNode!, input.maxDepth || 5, createNodeLink);

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
                // Found the path!
                const pathLinks = path.map(createLink);
                const parts: string[] = [];
                parts.push(`## Path Found: ${createLink(fromNodeId)} → ${createLink(toNodeId)}\n`);
                parts.push(`**Length:** ${path.length - 1} hop${path.length - 1 !== 1 ? 's' : ''}\n`);
                parts.push(`**Path:**`);
                parts.push(pathLinks.join(' → '));
                parts.push('');

                // Show files involved
                const filesInPath = new Set<string>();
                path.forEach(nodeId => {
                    const node = graph.nodes.find(n => n.id === nodeId);
                    if (node?.source?.file) {
                        filesInPath.add(node.source.file);
                    }
                });

                if (filesInPath.size > 0) {
                    parts.push(`\n**Files involved:** ${filesInPath.size}`);
                    Array.from(filesInPath).forEach(file => {
                        parts.push(`- \`${file}\``);
                    });
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

        const parts: string[] = [];
        parts.push(`## Upstream Dependencies of ${createLink(nodeId)}\n`);
        parts.push(`**Found:** ${upstream.size} upstream node${upstream.size !== 1 ? 's' : ''} (max depth: ${maxDepth})\n`);

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
                    parts.push(`\n**Depth ${d}:**`);
                    nodesAtDepth.forEach(n => {
                        parts.push(`- ${createLink(n)}`);
                    });
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

        const parts: string[] = [];
        parts.push(`## Downstream Dependencies of ${createLink(nodeId)}\n`);
        parts.push(`**Found:** ${downstream.size} downstream node${downstream.size !== 1 ? 's' : ''} (max depth: ${maxDepth})\n`);

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
                    parts.push(`\n**Depth ${d}:**`);
                    nodesAtDepth.forEach(n => {
                        parts.push(`- ${createLink(n)}`);
                    });
                }
            }
        }

        return new vscode.LanguageModelToolResult([
            new vscode.LanguageModelTextPart(parts.join('\n'))
        ]);
    }
}

export function registerWorkflowNavigateTool(
    cacheManager: CacheManager,
    getViewState: () => ViewState | null
): vscode.Disposable | null {
    try {
        if (!vscode.lm || typeof vscode.lm.registerTool !== 'function') {
            console.warn('Language Model Tool API not available for workflow-navigate');
            return null;
        }

        const tool = new WorkflowNavigateTool(cacheManager, getViewState);
        const disposable = vscode.lm.registerTool('workflow-navigate', tool);
        console.log('✅ Registered workflow-navigate tool');
        return disposable;
    } catch (error) {
        console.error('❌ Failed to register workflow-navigate tool:', error);
        return null;
    }
}
