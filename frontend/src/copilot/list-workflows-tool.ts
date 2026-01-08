import * as vscode from 'vscode';
import { CacheManager } from '../cache';
import { WorkflowGraph, WorkflowNode } from '../api';
import { filterOrphanedNodes } from './graph-filter';
import { TYPE_SYMBOLS, createWorkflowLink } from './compact-formatter';

interface ListWorkflowsInput {
    includeNodeTypes?: boolean;
}

/**
 * Language Model Tool for listing ALL workflows with comprehensive details
 * This gives the LLM a complete overview to reason about the codebase
 */
class ListWorkflowsTool implements vscode.LanguageModelTool<ListWorkflowsInput> {
    constructor(
        private cacheManager: CacheManager
    ) {}

    async invoke(
        options: vscode.LanguageModelToolInvocationOptions<ListWorkflowsInput>,
        _token: vscode.CancellationToken
    ): Promise<vscode.LanguageModelToolResult> {
        const input = options.input || {};

        try {
            console.log('[list-workflows] Listing all workflows');

            // Get the complete workflow graph
            const graph = await this.cacheManager.getMostRecentWorkflows();
            if (!graph) {
                return new vscode.LanguageModelToolResult([
                    new vscode.LanguageModelTextPart('No workflow data found. Please run "Codag: Open" and use the analysis panel first.')
                ]);
            }

            // Filter out orphaned nodes (match webview rendering)
            const filteredGraph = filterOrphanedNodes(graph);
            console.log(`[list-workflows] Found ${filteredGraph.workflows.length} workflows`);

            if (filteredGraph.workflows.length === 0) {
                return new vscode.LanguageModelToolResult([
                    new vscode.LanguageModelTextPart('No workflows found in the analyzed code.')
                ]);
            }

            const parts: string[] = [];
            parts.push(`Found ${filteredGraph.workflows.length} workflow(s):\n`);

            for (const wf of filteredGraph.workflows) {
                const nodes = filteredGraph.nodes.filter(n => wf.nodeIds.includes(n.id));
                const edges = filteredGraph.edges.filter(e =>
                    wf.nodeIds.includes(e.source) && wf.nodeIds.includes(e.target)
                );

                // Get entry and exit nodes
                const entryNodes = nodes.filter(n => n.isEntryPoint);
                const exitNodes = nodes.filter(n => n.isExitPoint);

                // Count node types
                const nodeTypeCounts = this.countNodeTypes(nodes);

                // Get unique files
                const files = this.getUniqueFiles(nodes);

                // Get LLM nodes specifically (important for understanding workflow purpose)
                const llmNodes = nodes.filter(n => n.type === 'llm');

                // Build workflow summary
                parts.push(`━━━ ${wf.name} ━━━`);
                parts.push(`  Nodes: ${nodes.length} | Edges: ${edges.length}`);

                if (input.includeNodeTypes !== false) {
                    parts.push(`  Types: ${nodeTypeCounts}`);
                }

                if (entryNodes.length > 0) {
                    const entryLabels = entryNodes.map(n => `${TYPE_SYMBOLS[n.type] || '□'} ${n.label}`);
                    parts.push(`  Entry: ${entryLabels.join(', ')}`);
                }

                if (exitNodes.length > 0) {
                    const exitLabels = exitNodes.map(n => `${TYPE_SYMBOLS[n.type] || '□'} ${n.label}`);
                    parts.push(`  Exit: ${exitLabels.join(', ')}`);
                }

                if (llmNodes.length > 0) {
                    const llmLabels = llmNodes.map(n => n.label);
                    parts.push(`  LLM Calls: ${llmLabels.join(', ')}`);
                }

                if (files.length > 0) {
                    // Show just filenames for brevity
                    const fileNames = files.map(f => f.split('/').pop() || f);
                    parts.push(`  Files: ${fileNames.join(', ')}`);
                }

                // Check for potential issues
                if (entryNodes.length === 0) {
                    parts.push(`  ⚠️ No entry point detected`);
                }
                if (exitNodes.length === 0) {
                    parts.push(`  ⚠️ No exit point detected`);
                }

                parts.push('');
            }

            // Summary at the end
            const totalNodes = filteredGraph.nodes.length;
            const totalEdges = filteredGraph.edges.length;
            const totalLlmNodes = filteredGraph.nodes.filter(n => n.type === 'llm').length;
            parts.push(`Summary: ${filteredGraph.workflows.length} workflows, ${totalNodes} nodes, ${totalEdges} edges, ${totalLlmNodes} LLM calls`);

            return new vscode.LanguageModelToolResult([
                new vscode.LanguageModelTextPart(parts.join('\n'))
            ]);

        } catch (error: any) {
            console.error('[list-workflows] Error:', error);
            return new vscode.LanguageModelToolResult([
                new vscode.LanguageModelTextPart(`Error listing workflows: ${error.message}`)
            ]);
        }
    }

    private countNodeTypes(nodes: WorkflowNode[]): string {
        const counts: Record<string, number> = {};
        nodes.forEach(n => {
            counts[n.type] = (counts[n.type] || 0) + 1;
        });

        return Object.entries(counts)
            .map(([type, count]) => `${count} ${type}`)
            .join(', ');
    }

    private getUniqueFiles(nodes: WorkflowNode[]): string[] {
        const files = new Set<string>();
        nodes.forEach(n => {
            if (n.source?.file) {
                files.add(n.source.file);
            }
        });
        return Array.from(files);
    }
}

export function registerListWorkflowsTool(
    cacheManager: CacheManager
): vscode.Disposable | null {
    try {
        if (!vscode.lm || typeof vscode.lm.registerTool !== 'function') {
            console.warn('Language Model Tool API not available for list-workflows');
            return null;
        }

        const tool = new ListWorkflowsTool(cacheManager);
        const disposable = vscode.lm.registerTool('list-workflows', tool);
        console.log('✅ Registered list-workflows tool');
        return disposable;
    } catch (error) {
        console.error('❌ Failed to register list-workflows tool:', error);
        return null;
    }
}
