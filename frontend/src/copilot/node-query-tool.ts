import * as vscode from 'vscode';
import { CacheManager } from '../cache';
import { WorkflowGraph } from '../api';
import { filterOrphanedNodes } from './graph-filter';
import { TYPE_SYMBOLS, createNodeLink, formatSharedNodes } from './compact-formatter';

interface NodeQueryInput {
    nodeIds?: string[];
    workflowName?: string;
    nodeType?: string;
    connectedTo?: string;
    shared?: boolean;  // Filter to nodes appearing in multiple workflows
    includeCodeSnippets?: boolean;
}

/**
 * Language Model Tool for querying specific nodes with filters
 * Allows LLM to search and filter nodes by various criteria
 */
class NodeQueryTool implements vscode.LanguageModelTool<NodeQueryInput> {
    constructor(
        private cacheManager: CacheManager
    ) {}

    async invoke(
        options: vscode.LanguageModelToolInvocationOptions<NodeQueryInput>,
        _token: vscode.CancellationToken
    ): Promise<vscode.LanguageModelToolResult> {
        const input = options.input;

        try {
            console.log('[node-query] Query:', JSON.stringify(input));

            // Get the complete workflow graph
            const graph = await this.cacheManager.getMostRecentWorkflows();
            if (!graph) {
                return new vscode.LanguageModelToolResult([
                    new vscode.LanguageModelTextPart('No workflow data found. Please run visualization first.')
                ]);
            }

            // Filter out orphaned nodes and their edges (match webview rendering)
            const filteredGraph = filterOrphanedNodes(graph);
            console.log(`[node-query] Filtered to ${filteredGraph.nodes.length} nodes in LLM workflows`);

            // Use ALL nodes - don't filter by ViewState (LLM needs access to everything)
            let nodes = filteredGraph.nodes;

            // Filter by node IDs
            if (input.nodeIds && input.nodeIds.length > 0) {
                nodes = nodes.filter(n => input.nodeIds!.includes(n.id));
            }

            // Filter by workflow name
            if (input.workflowName) {
                const workflow = graph.workflows.find(wf =>
                    wf.name.toLowerCase().includes(input.workflowName!.toLowerCase())
                );
                if (workflow) {
                    nodes = nodes.filter(n => workflow.nodeIds.includes(n.id));
                } else {
                    return new vscode.LanguageModelToolResult([
                        new vscode.LanguageModelTextPart(`Workflow "${input.workflowName}" not found.`)
                    ]);
                }
            }

            // Filter by node type
            if (input.nodeType) {
                nodes = nodes.filter(n => n.type.toLowerCase() === input.nodeType!.toLowerCase());
            }

            // Filter by connectivity
            if (input.connectedTo) {
                const connectedNodeIds = new Set<string>();
                // Find edges connected to this node
                filteredGraph.edges.forEach(edge => {
                    if (edge.source === input.connectedTo) {
                        connectedNodeIds.add(edge.target);
                    }
                    if (edge.target === input.connectedTo) {
                        connectedNodeIds.add(edge.source);
                    }
                });
                nodes = nodes.filter(n => connectedNodeIds.has(n.id));
            }

            // Filter to shared nodes (appear in multiple workflows)
            if (input.shared) {
                const nodeWorkflowCount = new Map<string, number>();
                graph.workflows.forEach(wf => {
                    wf.nodeIds.forEach(id => {
                        nodeWorkflowCount.set(id, (nodeWorkflowCount.get(id) || 0) + 1);
                    });
                });
                nodes = nodes.filter(n => (nodeWorkflowCount.get(n.id) || 0) > 1);
            }

            if (nodes.length === 0) {
                return new vscode.LanguageModelToolResult([
                    new vscode.LanguageModelTextPart('No nodes found matching the query criteria.')
                ]);
            }

            // Build adjacency info
            const beforeMap = new Map<string, string[]>();
            const afterMap = new Map<string, string[]>();
            filteredGraph.edges.forEach(edge => {
                if (!afterMap.has(edge.source)) afterMap.set(edge.source, []);
                afterMap.get(edge.source)!.push(edge.target);

                if (!beforeMap.has(edge.target)) beforeMap.set(edge.target, []);
                beforeMap.get(edge.target)!.push(edge.source);
            });

            // Use compact format for shared nodes
            if (input.shared) {
                return new vscode.LanguageModelToolResult([
                    new vscode.LanguageModelTextPart(formatSharedNodes(nodes, graph))
                ]);
            }

            // Build compact response
            const parts: string[] = [];
            parts.push(`Query: ${nodes.length} node${nodes.length !== 1 ? 's' : ''}`);
            parts.push('');

            for (const node of nodes) {
                const sym = TYPE_SYMBOLS[node.type] || '□';
                const link = createNodeLink(node.id, node.label);
                const location = node.source ? `→ ${node.source.file}:${node.source.line}` : '';

                // Find which workflow(s) this node belongs to
                const nodeWorkflows = graph.workflows.filter(wf => wf.nodeIds.includes(node.id));
                const workflowInfo = nodeWorkflows.length > 0 ? ` ⟵ ${nodeWorkflows.map(wf => wf.name).join(', ')}` : '';

                parts.push(`${sym} ${link} ${location}${workflowInfo}`);

                // Show adjacency on next line if present
                const before = beforeMap.get(node.id) || [];
                const after = afterMap.get(node.id) || [];

                if (before.length > 0 || after.length > 0) {
                    const adjacency: string[] = [];
                    if (before.length > 0) {
                        const beforeLinks = before.map(id => {
                            const n = filteredGraph.nodes.find(n => n.id === id);
                            return n ? createNodeLink(id, n.label) : id;
                        });
                        adjacency.push(`← ${beforeLinks.join(', ')}`);
                    }
                    if (after.length > 0) {
                        const afterLinks = after.map(id => {
                            const n = filteredGraph.nodes.find(n => n.id === id);
                            return n ? createNodeLink(id, n.label) : id;
                        });
                        adjacency.push(`→ ${afterLinks.join(', ')}`);
                    }
                    parts.push(`   ${adjacency.join(' | ')}`);
                }
            }

            return new vscode.LanguageModelToolResult([
                new vscode.LanguageModelTextPart(parts.join('\n'))
            ]);

        } catch (error: any) {
            console.error('[node-query] Error:', error);
            return new vscode.LanguageModelToolResult([
                new vscode.LanguageModelTextPart(`Error querying nodes: ${error.message}`)
            ]);
        }
    }
}

export function registerNodeQueryTool(
    cacheManager: CacheManager
): vscode.Disposable | null {
    try {
        if (!vscode.lm || typeof vscode.lm.registerTool !== 'function') {
            console.warn('Language Model Tool API not available for node-query');
            return null;
        }

        const tool = new NodeQueryTool(cacheManager);
        const disposable = vscode.lm.registerTool('node-query', tool);
        console.log('✅ Registered node-query tool');
        return disposable;
    } catch (error) {
        console.error('❌ Failed to register node-query tool:', error);
        return null;
    }
}
