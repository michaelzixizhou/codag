import * as vscode from 'vscode';
import { CacheManager } from '../cache';
import { WorkflowGraph } from '../api';
import { ViewState } from './types';
import { filterToExpandedNodes, filterToExpandedWorkflows } from './filter-utils';

interface NodeQueryInput {
    nodeIds?: string[];
    workflowName?: string;
    nodeType?: string;
    connectedTo?: string;
    includeCodeSnippets?: boolean;
}

/**
 * Language Model Tool for querying specific nodes with filters
 * Allows LLM to search and filter nodes by various criteria
 */
class NodeQueryTool implements vscode.LanguageModelTool<NodeQueryInput> {
    constructor(
        private cacheManager: CacheManager,
        private getViewState: () => ViewState | null
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

            // Filter to only nodes in visible/expanded workflows
            const viewState = this.getViewState();
            let nodes = filterToExpandedNodes(
                graph.nodes,
                graph.workflows,
                viewState?.expandedWorkflowIds || []
            );
            if (viewState?.expandedWorkflowIds && viewState.expandedWorkflowIds.length > 0) {
                const visibleWorkflows = filterToExpandedWorkflows(
                    graph.workflows,
                    viewState.expandedWorkflowIds
                );
                console.log(`[node-query] Filtered to ${nodes.length} nodes in ${visibleWorkflows.length} expanded workflows`);
            }

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
                graph.edges.forEach(edge => {
                    if (edge.source === input.connectedTo) {
                        connectedNodeIds.add(edge.target);
                    }
                    if (edge.target === input.connectedTo) {
                        connectedNodeIds.add(edge.source);
                    }
                });
                nodes = nodes.filter(n => connectedNodeIds.has(n.id));
            }

            if (nodes.length === 0) {
                return new vscode.LanguageModelToolResult([
                    new vscode.LanguageModelTextPart('No nodes found matching the query criteria.')
                ]);
            }

            // Build adjacency info
            const beforeMap = new Map<string, string[]>();
            const afterMap = new Map<string, string[]>();
            graph.edges.forEach(edge => {
                if (!afterMap.has(edge.source)) afterMap.set(edge.source, []);
                afterMap.get(edge.source)!.push(edge.target);

                if (!beforeMap.has(edge.target)) beforeMap.set(edge.target, []);
                beforeMap.get(edge.target)!.push(edge.source);
            });

            // Helper to create clickable node link
            const createNodeLink = (nodeId: string): string => {
                const node = graph.nodes.find(n => n.id === nodeId);
                if (!node) return nodeId;
                const commandUri = `command:aiworkflowviz.focusNode?${encodeURIComponent(JSON.stringify([nodeId, node.label]))}`;
                return `[${node.label}](${commandUri} "${node.label} (${node.type})")`;
            };

            // Build response
            const parts: string[] = [];
            parts.push(`## Query Results: ${nodes.length} node${nodes.length !== 1 ? 's' : ''}\n`);

            for (const node of nodes) {
                parts.push(`### ${createNodeLink(node.id)} (\`${node.type}\`)\n`);

                if (node.source) {
                    parts.push(`- **File:** \`${node.source.file}\``);
                    parts.push(`- **Location:** ${node.source.function} at line ${node.source.line}`);
                }

                // Find which workflow(s) this node belongs to
                const nodeWorkflows = graph.workflows.filter(wf => wf.nodeIds.includes(node.id));
                if (nodeWorkflows.length > 0) {
                    const workflowNames = nodeWorkflows.map(wf => wf.name).join(', ');
                    parts.push(`- **Workflow:** ${workflowNames}`);
                }

                // Show adjacency
                const before = beforeMap.get(node.id) || [];
                if (before.length > 0) {
                    const beforeLinks = before.map(createNodeLink);
                    parts.push(`- **Preceded by:** ${beforeLinks.join(', ')}`);
                }

                const after = afterMap.get(node.id) || [];
                if (after.length > 0) {
                    const afterLinks = after.map(createNodeLink);
                    parts.push(`- **Followed by:** ${afterLinks.join(', ')}`);
                }

                // Include code snippet if requested
                if (input.includeCodeSnippets && node.source) {
                    const snippet = await this.extractCodeSnippet(node.source.file, node.source.line);
                    if (snippet) {
                        parts.push(`- **Code Context:**\n\`\`\`\n${snippet}\n\`\`\``);
                    }
                }

                parts.push('');
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

    private async extractCodeSnippet(filePath: string, line: number, contextLines: number = 3): Promise<string | null> {
        try {
            const uri = vscode.Uri.file(filePath);
            const document = await vscode.workspace.openTextDocument(uri);

            const startLine = Math.max(0, line - contextLines - 1);
            const endLine = Math.min(document.lineCount - 1, line + contextLines);

            const lines: string[] = [];
            for (let i = startLine; i <= endLine; i++) {
                const prefix = i === line - 1 ? '>>> ' : '    ';
                lines.push(`${prefix}${i + 1}: ${document.lineAt(i).text}`);
            }

            return lines.join('\n');
        } catch (error) {
            console.warn(`Failed to extract code snippet from ${filePath}:${line}`, error);
            return null;
        }
    }
}

export function registerNodeQueryTool(
    cacheManager: CacheManager,
    getViewState: () => ViewState | null
): vscode.Disposable | null {
    try {
        if (!vscode.lm || typeof vscode.lm.registerTool !== 'function') {
            console.warn('Language Model Tool API not available for node-query');
            return null;
        }

        const tool = new NodeQueryTool(cacheManager, getViewState);
        const disposable = vscode.lm.registerTool('node-query', tool);
        console.log('✅ Registered node-query tool');
        return disposable;
    } catch (error) {
        console.error('❌ Failed to register node-query tool:', error);
        return null;
    }
}
