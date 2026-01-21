/**
 * Language Model Tool for injecting workflow context into Copilot
 */

import * as vscode from 'vscode';
import { CacheManager } from '../cache';
import { WorkflowGraph } from '../api';
import { WorkflowMetadataProvider } from './metadata-provider';
import { WorkflowToolInput, WorkflowMetadata, ViewState } from './types';
import { filterOrphanedNodes } from './graph-filter';

export class WorkflowContextTool implements vscode.LanguageModelTool<WorkflowToolInput> {
  constructor(
    private cacheManager: CacheManager,
    private getViewState: () => ViewState | null,
    private metadataProvider: WorkflowMetadataProvider
  ) {}

  async invoke(
    options: vscode.LanguageModelToolInvocationOptions<WorkflowToolInput>,
    _token: vscode.CancellationToken
  ): Promise<vscode.LanguageModelToolResult> {
    console.log('🔧 [Workflow Tool] Invoked by Copilot');
    console.log('📥 [Workflow Tool] Input:', options.input);

    try {
      // Auto-detect file from active editor if not provided
      let filePath = options.input.filePath;
      let fileContent = '';

      if (!filePath) {
        const editor = vscode.window.activeTextEditor;
        if (!editor) {
          console.log('⚠️  [Workflow Tool] No active editor found');
          return new vscode.LanguageModelToolResult([
            new vscode.LanguageModelTextPart(
              'No file specified and no active editor found. Please open a file or specify a filePath.'
            )
          ]);
        }
        filePath = editor.document.uri.fsPath;
        fileContent = editor.document.getText();
        console.log('📁 [Workflow Tool] Auto-detected file:', filePath);
      } else {
        // Read file content if filePath was provided
        try {
          const uri = vscode.Uri.file(filePath);
          const document = await vscode.workspace.openTextDocument(uri);
          fileContent = document.getText();
        } catch (error) {
          console.error('⚠️  [Workflow Tool] Failed to read file:', error);
          return new vscode.LanguageModelToolResult([
            new vscode.LanguageModelTextPart(
              `Failed to read file: ${filePath}`
            )
          ]);
        }
      }

      // Get cached workflow data for this specific file
      const hash = this.cacheManager.hashContentAST(fileContent, filePath);
      const graph = this.cacheManager.isFileValid(filePath, hash)
        ? await this.cacheManager.getMergedGraph([filePath])
        : null;

      if (!graph) {
        console.log('❌ [Workflow Tool] No workflow data found for file');
        return new vscode.LanguageModelToolResult([
          new vscode.LanguageModelTextPart(
            `No workflow data found for ${filePath}. Run "Codag: Auto-detect and Visualize" first.`
          )
        ]);
      }

      console.log('✅ [Workflow Tool] Found graph with', graph.nodes.length, 'nodes');

      // Filter out orphaned nodes and their edges (match webview rendering)
      const filteredGraph = filterOrphanedNodes(graph);
      console.log('🔍 [Workflow Tool] Filtered to', filteredGraph.nodes.length, 'nodes in LLM workflows');

      // Get view state from webview
      const viewState = this.getViewState();
      console.log('👁️  [Workflow Tool] View state:', viewState);

      // Extract metadata for this file with view awareness
      const selectedNodeId = viewState?.selectedNodeId || undefined;
      const visibleNodeIds = viewState?.visibleNodeIds || undefined;
      const metadata = await this.metadataProvider.extractMetadata(filteredGraph, filePath, selectedNodeId, visibleNodeIds);

      console.log('📊 [Workflow Tool] Returning context with', metadata.adjacentNodes.length, 'nodes');
      if (visibleNodeIds && visibleNodeIds.length > 0) {
        console.log('👁️  [Workflow Tool] Prioritizing', visibleNodeIds.length, 'visible nodes');
      }
      if (selectedNodeId) {
        console.log('⭐ [Workflow Tool] Selected node prioritized:', selectedNodeId);
      }

      // Return formatted metadata as text
      const formattedContext = this.formatMetadata(metadata, filePath, viewState, filteredGraph);
      console.log('📤 [Workflow Tool] Context preview:', formattedContext.substring(0, 200) + '...');

      return new vscode.LanguageModelToolResult([
        new vscode.LanguageModelTextPart(formattedContext)
      ]);
    } catch (error) {
      console.error('❌ [Workflow Tool] Error:', error);
      return new vscode.LanguageModelToolResult([
        new vscode.LanguageModelTextPart(
          `Error retrieving workflow context: ${error}`
        )
      ]);
    }
  }

  /**
   * Format metadata as human-readable text for the LLM
   */
  private formatMetadata(
    metadata: WorkflowMetadata,
    filePath: string,
    viewState: ViewState | null,
    graph: WorkflowGraph
  ): string {
    const parts: string[] = [];

    parts.push(`# Workflow Context for ${filePath}\n`);

    // View state context (show what user is currently looking at in visualization)
    if (viewState && viewState.selectedNodeId) {
      const selectedNode = graph.nodes.find(n => n.id === viewState.selectedNodeId);
      if (selectedNode) {
        parts.push(`## Currently Viewing Node`);
        parts.push(`**${selectedNode.label}** (${selectedNode.type})`);
        parts.push(`- Location: ${selectedNode.source?.function || 'unknown'} at line ${selectedNode.source?.line || 'unknown'}`);
        if (selectedNode.description) {
          parts.push(`- Description: ${selectedNode.description}`);
        }
        parts.push('');
      }
    }

    // Show expanded workflows
    if (viewState && viewState.expandedWorkflowIds.length > 0) {
      parts.push(`## Visible Workflows`);
      parts.push(`- Expanded: ${viewState.expandedWorkflowIds.join(', ')}`);
      parts.push('');
    }

    // File context
    if (metadata.fileContext.nodesInFile.length > 0) {
      parts.push(`## File Role`);
      parts.push(`- Contains ${metadata.fileContext.nodesInFile.length} workflow nodes`);
      if (metadata.fileContext.incomingFromFiles.length > 0) {
        parts.push(`- Receives calls from: ${metadata.fileContext.incomingFromFiles.join(', ')}`);
      }
      if (metadata.fileContext.outgoingToFiles.length > 0) {
        parts.push(`- Calls out to: ${metadata.fileContext.outgoingToFiles.join(', ')}`);
      }
      parts.push('');
    }

    // Node adjacency (prioritized by selected node if available)
    if (metadata.adjacentNodes.length > 0) {
      const priorityNote = viewState?.selectedNodeId ? ' (prioritized by selected node)' : '';
      parts.push(`## Nodes in File${priorityNote}`);

      // Limit to top 10 nodes to avoid overwhelming the LLM
      const displayNodes = metadata.adjacentNodes.slice(0, 10);

      displayNodes.forEach((node, index) => {
        const isSelected = node.nodeId === viewState?.selectedNodeId;
        const marker = isSelected ? '⭐ ' : '';

        parts.push(`### ${index + 1}. ${marker}${node.label} (${node.type})`);
        parts.push(`- Location: ${node.source.function} at line ${node.source.line}`);
        if (node.beforeNodes.length > 0) {
          parts.push(`- Preceded by: ${node.beforeNodes.join(', ')}`);
        }
        if (node.afterNodes.length > 0) {
          parts.push(`- Followed by: ${node.afterNodes.join(', ')}`);
        }
        parts.push('');
      });

      if (metadata.adjacentNodes.length > 10) {
        parts.push(`_... and ${metadata.adjacentNodes.length - 10} more nodes_\n`);
      }
    }

    // Workflows
    if (metadata.workflows.length > 0) {
      parts.push(`## Workflows`);
      metadata.workflows.forEach(wf => {
        parts.push(`### ${wf.name}`);
        parts.push(`- Nodes: ${wf.nodeIds.length}`);
        parts.push('');
      });
    }

    // Cross-file edges
    if (metadata.crossFileEdges.length > 0) {
      parts.push(`## Cross-File Connections`);
      metadata.crossFileEdges.forEach(edge => {
        if (edge.from.file === filePath) {
          parts.push(`- ${edge.from.nodeId} → ${edge.to.nodeId} (in ${edge.to.file})`);
        } else {
          parts.push(`- ${edge.from.nodeId} (in ${edge.from.file}) → ${edge.to.nodeId}`);
        }
      });
      parts.push('');
    }

    return parts.join('\n');
  }
}

/**
 * Register the workflow context tool with VSCode
 */
export function registerWorkflowTool(
  cacheManager: CacheManager,
  getViewState: () => ViewState | null
): vscode.Disposable | undefined {
  try {
    // Check if Language Model API is available
    if (!vscode.lm || typeof vscode.lm.registerTool !== 'function') {
      console.warn('⚠️  Language Model Tools API not available. Requires VSCode 1.90+ and GitHub Copilot.');
      console.warn('⚠️  Workflow context tool will not be registered.');
      return undefined;
    }

    const metadataProvider = new WorkflowMetadataProvider();
    const tool = new WorkflowContextTool(cacheManager, getViewState, metadataProvider);

    console.log('🔧 Registering workflow-context tool with vscode.lm API');
    const disposable = vscode.lm.registerTool('workflow-context', tool);
    console.log('✅ Successfully registered workflow-context tool');

    return disposable;
  } catch (error) {
    console.error('❌ Failed to register workflow tool:', error);
    return undefined;
  }
}
