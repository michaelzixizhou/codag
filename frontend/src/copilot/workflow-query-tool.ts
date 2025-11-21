import * as vscode from 'vscode';
import { CacheManager } from '../cache';
import { WorkflowGraph } from '../api';
import { ViewState } from './types';
import { filterToExpandedWorkflows } from './filter-utils';
import { filterOrphanedNodes } from './graph-filter';

interface WorkflowQueryInput {
    workflowName: string;
    includeDetails?: boolean;
}

/**
 * Language Model Tool for querying complete node lists for specific workflows
 * Allows LLM to get ALL nodes in a workflow by name
 */
class WorkflowQueryTool implements vscode.LanguageModelTool<WorkflowQueryInput> {
    constructor(
        private cacheManager: CacheManager,
        private getViewState: () => ViewState | null
    ) {}

    async invoke(
        options: vscode.LanguageModelToolInvocationOptions<WorkflowQueryInput>,
        _token: vscode.CancellationToken
    ): Promise<vscode.LanguageModelToolResult> {
        const input = options.input;

        try {
            console.log(`[workflow-query] Querying workflow: "${input.workflowName}"`);

            // Get the complete workflow graph
            const graph = await this.cacheManager.getMostRecentWorkflows();
            if (!graph) {
                return new vscode.LanguageModelToolResult([
                    new vscode.LanguageModelTextPart('No workflow data found. Please run visualization first.')
                ]);
            }

            // Filter out orphaned nodes and their edges (match webview rendering)
            const filteredGraph = filterOrphanedNodes(graph);
            console.log(`[workflow-query] Filtered to ${filteredGraph.nodes.length} nodes in LLM workflows`);

            // Filter to only visible/expanded workflows from ViewState
            const viewState = this.getViewState();
            const visibleWorkflows = filterToExpandedWorkflows(
                filteredGraph.workflows,
                viewState?.expandedWorkflowIds || []
            );
            if (viewState?.expandedWorkflowIds && viewState.expandedWorkflowIds.length > 0) {
                console.log(`[workflow-query] Filtered to ${visibleWorkflows.length} expanded workflows`);
            }

            // Find the workflow by name (case-insensitive partial match)
            const workflow = visibleWorkflows.find(wf =>
                wf.name.toLowerCase().includes(input.workflowName.toLowerCase())
            );

            if (!workflow) {
                const availableWorkflows = visibleWorkflows.map(wf => wf.name).join(', ');
                return new vscode.LanguageModelToolResult([
                    new vscode.LanguageModelTextPart(
                        `Workflow "${input.workflowName}" not found in visible workflows.\n\nAvailable workflows: ${availableWorkflows}`
                    )
                ]);
            }

            // Get all nodes in this workflow
            const workflowNodes = filteredGraph.nodes.filter(n => workflow.nodeIds.includes(n.id));

            // Helper to create clickable node link
            const createNodeLink = (nodeId: string): string => {
                const node = filteredGraph.nodes.find(n => n.id === nodeId);
                if (!node) return nodeId;
                const commandUri = `command:aiworkflowviz.focusNode?${encodeURIComponent(JSON.stringify([nodeId, node.label]))}`;
                return `[${node.label}](${commandUri} "${node.label} (${node.type})")`;
            };

            // Build the response
            const parts: string[] = [];
            parts.push(`## Workflow: ${workflow.name}\n`);
            parts.push(`**Node Count:** ${workflowNodes.length} nodes\n`);

            // Group nodes by file
            const nodesByFile = new Map<string, typeof workflowNodes>();
            workflowNodes.forEach(node => {
                const file = node.source?.file || 'unknown';
                if (!nodesByFile.has(file)) {
                    nodesByFile.set(file, []);
                }
                nodesByFile.get(file)!.push(node);
            });

            parts.push(`**Files:** ${nodesByFile.size} file${nodesByFile.size !== 1 ? 's' : ''}\n`);

            // Show all nodes
            if (input.includeDetails) {
                parts.push(`\n### All Nodes\n`);
                workflowNodes.forEach((node, index) => {
                    parts.push(`${index + 1}. ${createNodeLink(node.id)} - \`${node.type}\``);
                    if (node.source) {
                        parts.push(`   - File: \`${node.source.file}\``);
                        parts.push(`   - Location: ${node.source.function} at line ${node.source.line}`);
                    }
                    parts.push('');
                });
            } else {
                // Just show clickable links
                parts.push(`\n### All Nodes\n`);
                const nodeLinks = workflowNodes.map((node, index) =>
                    `${index + 1}. ${createNodeLink(node.id)}`
                );
                parts.push(nodeLinks.join('\n'));
                parts.push('');
            }

            // Show entry/exit points
            const entryNodes = workflowNodes.filter(n => n.isEntryPoint);
            if (entryNodes.length > 0) {
                const entryLinks = entryNodes.map(n => createNodeLink(n.id));
                parts.push(`\n**Entry Points:** ${entryLinks.join(', ')}`);
            }

            const exitNodes = workflowNodes.filter(n => n.isExitPoint);
            if (exitNodes.length > 0) {
                const exitLinks = exitNodes.map(n => createNodeLink(n.id));
                parts.push(`**Exit Points:** ${exitLinks.join(', ')}`);
            }

            // Show critical path if available
            const criticalPathEdges = filteredGraph.edges.filter(e => e.isCriticalPath);
            if (criticalPathEdges.length > 0) {
                // Build path from edges
                const criticalNodeIds = new Set<string>();
                criticalPathEdges.forEach(e => {
                    criticalNodeIds.add(e.source);
                    criticalNodeIds.add(e.target);
                });
                const criticalNodes = Array.from(criticalNodeIds)
                    .filter(id => workflow.nodeIds.includes(id))
                    .map(createNodeLink);

                if (criticalNodes.length > 0) {
                    parts.push(`\n**Critical Path Nodes:** ${criticalNodes.join(' → ')}`);
                }
            }

            return new vscode.LanguageModelToolResult([
                new vscode.LanguageModelTextPart(parts.join('\n'))
            ]);

        } catch (error: any) {
            console.error('[workflow-query] Error:', error);
            return new vscode.LanguageModelToolResult([
                new vscode.LanguageModelTextPart(`Error querying workflow: ${error.message}`)
            ]);
        }
    }
}

export function registerWorkflowQueryTool(
    cacheManager: CacheManager,
    getViewState: () => ViewState | null
): vscode.Disposable | null {
    try {
        if (!vscode.lm || typeof vscode.lm.registerTool !== 'function') {
            console.warn('Language Model Tool API not available for workflow-query');
            return null;
        }

        const tool = new WorkflowQueryTool(cacheManager, getViewState);
        const disposable = vscode.lm.registerTool('workflow-query', tool);
        console.log('✅ Registered workflow-query tool');
        return disposable;
    } catch (error) {
        console.error('❌ Failed to register workflow-query tool:', error);
        return null;
    }
}
