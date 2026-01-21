import * as vscode from 'vscode';
import { CacheManager } from '../cache';
import { filterOrphanedNodes } from './graph-filter';
import { TYPE_SYMBOLS, createNodeLink, formatWorkflow, formatLegend } from './compact-formatter';

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
        private cacheManager: CacheManager
    ) {}

    async invoke(
        options: vscode.LanguageModelToolInvocationOptions<WorkflowQueryInput>,
        _token: vscode.CancellationToken
    ): Promise<vscode.LanguageModelToolResult> {
        const input = options.input;

        try {
            console.log(`[workflow-query] Querying workflow: "${input.workflowName}"`);

            // Get the complete workflow graph
            const graph = await this.cacheManager.getMergedGraph();
            if (!graph) {
                return new vscode.LanguageModelToolResult([
                    new vscode.LanguageModelTextPart('No workflow data found. Please run visualization first.')
                ]);
            }

            // Filter out orphaned nodes and their edges (match webview rendering)
            const filteredGraph = filterOrphanedNodes(graph);
            console.log(`[workflow-query] Filtered to ${filteredGraph.nodes.length} nodes in LLM workflows`);

            // Use ALL workflows - don't filter by ViewState (LLM needs access to everything)
            const allWorkflows = filteredGraph.workflows;

            // Find the workflow by name (case-insensitive partial match)
            const workflow = allWorkflows.find(wf =>
                wf.name.toLowerCase().includes(input.workflowName.toLowerCase())
            );

            if (!workflow) {
                const availableWorkflows = allWorkflows.map(wf => wf.name).join(', ');
                return new vscode.LanguageModelToolResult([
                    new vscode.LanguageModelTextPart(
                        `Workflow "${input.workflowName}" not found.\n\nAvailable workflows: ${availableWorkflows}`
                    )
                ]);
            }

            // Get all nodes in this workflow
            const workflowNodes = filteredGraph.nodes.filter(n => workflow.nodeIds.includes(n.id));
            const workflowEdges = filteredGraph.edges.filter(e =>
                workflow.nodeIds.includes(e.source) && workflow.nodeIds.includes(e.target)
            );

            // Build compact response
            const parts: string[] = [];

            // Show workflow as tree structure
            parts.push(formatWorkflow(workflow.name, workflowNodes, workflowEdges, filteredGraph));
            parts.push('');


            parts.push('');
            parts.push(formatLegend());

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
    cacheManager: CacheManager
): vscode.Disposable | null {
    try {
        if (!vscode.lm || typeof vscode.lm.registerTool !== 'function') {
            console.warn('Language Model Tool API not available for workflow-query');
            return null;
        }

        const tool = new WorkflowQueryTool(cacheManager);
        const disposable = vscode.lm.registerTool('workflow-query', tool);
        console.log('✅ Registered workflow-query tool');
        return disposable;
    } catch (error) {
        console.error('❌ Failed to register workflow-query tool:', error);
        return null;
    }
}
