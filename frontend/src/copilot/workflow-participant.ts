/**
 * Chat Participant for providing workflow context to Copilot
 * Users invoke with @workflow in Copilot Chat
 */

import * as vscode from 'vscode';
import { CacheManager } from '../cache';
import { WorkflowGraph } from '../api';
import { WorkflowMetadataProvider } from './metadata-provider';
import { ViewState, WorkflowMetadata } from './types';
import { CodeModifier } from './code-modifier';
import { filterOrphanedNodes } from './graph-filter';

export function registerWorkflowParticipant(
  context: vscode.ExtensionContext,
  cacheManager: CacheManager,
  getViewState: () => ViewState | null
): vscode.Disposable {

  const metadataProvider = new WorkflowMetadataProvider();
  const codeModifier = new CodeModifier();

  const handler: vscode.ChatRequestHandler = async (
    request: vscode.ChatRequest,
    chatContext: vscode.ChatContext,
    stream: vscode.ChatResponseStream,
    token: vscode.CancellationToken
  ) => {
    console.log('🎯 [@workflow] Participant invoked');
    console.log('📝 [@workflow] User prompt:', request.prompt);
    console.log('🔧 [@workflow] Command:', request.command);

    try {
      stream.progress('Loading workflow context...');

      let filePath: string | undefined;
      let fileContent: string | undefined;
      let graph: WorkflowGraph | null = null;

      // Strategy 1: Check view state for selected node
      const viewState = getViewState();
      if (viewState?.selectedNodeId) {
        console.log('📍 [@workflow] Selected node detected:', viewState.selectedNodeId);
        graph = await cacheManager.getMostRecentWorkflows();
        if (graph) {
          const selectedNode = graph.nodes.find((n: any) => n.id === viewState.selectedNodeId);
          if (selectedNode?.source) {
            filePath = selectedNode.source.file;
            console.log('📁 [@workflow] Using file from selected node:', filePath);
            try {
              const uri = vscode.Uri.file(filePath);
              const document = await vscode.workspace.openTextDocument(uri);
              fileContent = document.getText();
            } catch (error) {
              console.warn('⚠️  [@workflow] Failed to read selected node file:', error);
            }
          }
        }
      }

      // Strategy 2: Fall back to active editor
      if (!graph || !filePath) {
        const editor = vscode.window.activeTextEditor;
        if (editor) {
          filePath = editor.document.uri.fsPath;
          fileContent = editor.document.getText();
          console.log('📁 [@workflow] Using active editor file:', filePath);
          graph = await cacheManager.getPerFile(filePath, fileContent);
        }
      }

      // Strategy 3: Fall back to all cached workflows
      if (!graph) {
        console.log('📊 [@workflow] No file context, using workspace-level cache');
        graph = await cacheManager.getMostRecentWorkflows();
      }

      // Only error if no cache exists at all
      if (!graph) {
        stream.markdown('⚠️ No workflow data found.\n\n');
        stream.markdown('Run **AI Workflow Visualizer: Auto-detect and Visualize** first to analyze workflows.');
        return { metadata: { command: request.command } };
      }

      console.log('✅ [@workflow] Found graph with', graph.nodes.length, 'nodes');

      // Filter out orphaned nodes and their edges (match webview rendering)
      const filteredGraph = filterOrphanedNodes(graph);
      console.log('🔍 [@workflow] Filtered to', filteredGraph.nodes.length, 'nodes in LLM workflows');

      // Extract metadata with view awareness (including code snippets for visible nodes)
      const selectedNodeId = viewState?.selectedNodeId || undefined;
      const visibleNodeIds = viewState?.visibleNodeIds || undefined;
      const targetFile = filePath || (selectedNodeId ? filteredGraph.nodes.find((n: any) => n.id === selectedNodeId)?.source?.file : undefined) || '';
      const metadata = await metadataProvider.extractMetadata(
        filteredGraph,
        targetFile,
        selectedNodeId,
        visibleNodeIds,
        {
          includeCodeSnippets: visibleNodeIds && visibleNodeIds.length > 0,
          contextLines: 3
        }
      );

      // Build context string
      const contextStr = formatMetadata(metadata, targetFile, viewState, filteredGraph);
      console.log('📊 [@workflow] Context size:', contextStr.length, 'chars');

      // Show what we know
      if (viewState?.selectedNodeId) {
        const node = filteredGraph.nodes.find((n: any) => n.id === viewState.selectedNodeId);
        if (node) {
          stream.markdown(`**Currently viewing:** ${node.label} (${node.type})\n\n`);
        }
      }

      // Build LLM messages with workflow context
      stream.progress('Analyzing workflow with AI...');

      const systemPrompt = `You are an expert in LLM workflow architecture and code generation.

You have access to detailed workflow metadata, including:
- Node names, types (llm, tool, decision, integration, memory, parser, output, trigger), and source locations
- Node adjacency (what comes before/after each node)
- Cross-file dependencies
- Workflow structure (entry points, exit points, critical paths)
- Currently selected node in the visualization (if any)

IMPORTANT: You have STRUCTURAL metadata, not file contents. Each node includes a source location (file path and line number).

AVAILABLE TOOLS - Use these to query workflows dynamically:

1. **workflow-query**: Get complete node lists for specific workflows
   - Input: { workflowName: string, includeDetails?: boolean }
   - Use when user asks "What nodes are in workflow X?" or "List all nodes in X"
   - Returns all nodes in that workflow with clickable links
   - Example: "What nodes are in the 'Register Chat Participant' workflow?"

2. **node-query**: Filter and search nodes by various criteria
   - Input: { nodeIds?: string[], workflowName?: string, nodeType?: string, connectedTo?: string, includeCodeSnippets?: boolean }
   - Use to filter nodes by type, workflow, or connections
   - Can optionally include code snippets with context
   - Example: "Show me all 'llm' type nodes" or "What nodes are connected to node_123?"

3. **workflow-navigate**: Analyze execution flow and find paths
   - Input: { operation: 'path' | 'upstream' | 'downstream', fromNode?: string, toNode?: string, maxDepth?: number }
   - Use to find paths between nodes, or analyze dependencies
   - Example: "Find path from input to output" or "What calls this node?"

IMPORTANT: These tools only show nodes/workflows that are currently visible/expanded in the visualization. If a workflow is not found, it may be collapsed.

CRITICAL - Node References:
- The metadata contains CLICKABLE LINKS for all nodes in markdown format: [Node Label](command:...)
- When describing workflows, ALWAYS use these exact links from the metadata
- DO NOT create your own node IDs or node references
- Users can click these links to focus on nodes in the visualization
- Example: Instead of "node_1 → node_2 → node_3", use the clickable links like "[Receive User Query](command:...) → [Backend LLM Call](command:...) → [Process Response](command:...)"

When the user asks about specific code:
1. Use the file paths and line numbers provided in the node metadata
2. You can read files directly using these locations to see implementation details
3. Answer structural questions (relationships, flow, architecture) directly from the metadata
4. ALWAYS reference nodes using their clickable links from the metadata

When the user wants to ADD or MODIFY code:
1. Provide complete, runnable code in fenced code blocks (\`\`\`language)
2. Include the target file path as a comment at the top of the code block
3. Reference specific nodes by name from the metadata
4. Respect the existing workflow structure shown in node adjacency
5. Maintain proper connections between nodes
6. The user can directly apply your code suggestions - they will be presented with a diff preview first

Example code modification response:
"I'll add a new validation node between the input handler and the LLM call:

\`\`\`typescript
// File: src/handlers/input.ts
// Insert after line 42 (validateInput node)

async function validateUserInput(input: string): Promise<ValidationResult> {
  // Validate input format
  if (!input || input.length === 0) {
    return { valid: false, error: 'Input cannot be empty' };
  }

  // Check for malicious content
  if (containsSQLInjection(input)) {
    return { valid: false, error: 'Invalid characters detected' };
  }

  return { valid: true };
}
\`\`\`

This validation node will run after the input handler and before the LLM call, ensuring all input is sanitized."

Here's the workflow metadata:

${contextStr}`;

      const messages = [
        vscode.LanguageModelChatMessage.User(systemPrompt),
        vscode.LanguageModelChatMessage.User(request.prompt)
      ];

      const chatResponse = await request.model.sendRequest(messages, {}, token);

      // Collect full response for code modification detection
      let fullResponse = '';
      for await (const fragment of chatResponse.text) {
        fullResponse += fragment;
        stream.markdown(fragment);
      }

      // After streaming, check if the response contains code modifications
      await detectAndApplyCodeModifications(fullResponse, graph, viewState, codeModifier, stream);

      // Add source code references for nodes
      if (filePath) {
        // Show nodes in the current file
        stream.markdown('\n\n---\n\n**Workflow Nodes in This File:**\n\n');
        const nodesInFile = graph.nodes.filter((n: any) => n.source?.file === filePath);
        for (const node of nodesInFile.slice(0, 5)) {
          if (node.source) {
            const uri = vscode.Uri.file(node.source.file);
            const position = new vscode.Position(node.source.line - 1, 0);
            const location = new vscode.Location(uri, position);
            stream.anchor(location, `${node.label} (${node.type}, line ${node.source.line})`);
          }
        }
        if (nodesInFile.length > 5) {
          stream.markdown(`\n*...and ${nodesInFile.length - 5} more nodes*`);
        }
      } else {
        // Show visible workflow nodes (from viewport)
        if (visibleNodeIds && visibleNodeIds.length > 0) {
          stream.markdown('\n\n---\n\n**Visible Workflow Nodes:**\n\n');
          const visibleNodes = graph.nodes.filter((n: any) =>
            n.source && visibleNodeIds.includes(n.id)
          );
          for (const node of visibleNodes.slice(0, 10)) {
            if (node.source) {
              const uri = vscode.Uri.file(node.source.file);
              const position = new vscode.Position(node.source.line - 1, 0);
              const location = new vscode.Location(uri, position);
              stream.anchor(location, `${node.label} (${node.type}, ${node.source.file}:${node.source.line})`);
            }
          }
          if (visibleNodes.length > 10) {
            stream.markdown(`\n*...and ${visibleNodes.length - 10} more visible nodes*`);
          }
        } else {
          // Fallback when no viewport data
          stream.markdown('\n\n---\n\n**Recent Workflow Nodes:**\n\n');
          const recentNodes = graph.nodes.filter((n: any) => n.source);
          for (const node of recentNodes.slice(0, 10)) {
            if (node.source) {
              const uri = vscode.Uri.file(node.source.file);
              const position = new vscode.Position(node.source.line - 1, 0);
              const location = new vscode.Location(uri, position);
              stream.anchor(location, `${node.label} (${node.type}, ${node.source.file}:${node.source.line})`);
            }
          }
          if (recentNodes.length > 10) {
            stream.markdown(`\n*...and ${recentNodes.length - 10} more nodes*`);
          }
        }
      }

      console.log('✅ [@workflow] Response completed');

      return { metadata: { command: request.command } };

    } catch (error) {
      console.error('❌ [@workflow] Error:', error);
      stream.markdown(`❌ Error: ${error}`);
      return { metadata: { command: request.command, error: String(error) } };
    }
  };

  // Create and register participant
  const participant = vscode.chat.createChatParticipant(
    'aiworkflowviz.workflow',
    handler
  );

  participant.iconPath = new vscode.ThemeIcon('graph');

  context.subscriptions.push(participant);
  console.log('✅ Registered @workflow chat participant');

  return participant;
}

/**
 * Format metadata as human-readable text for the LLM
 * (Reused from workflow-tool.ts)
 */
function formatMetadata(
  metadata: WorkflowMetadata,
  filePath: string,
  viewState: ViewState | null,
  graph: WorkflowGraph
): string {
  const parts: string[] = [];

  // Header - show file context or workspace context
  if (filePath && filePath !== '') {
    parts.push(`# Workflow Context for ${filePath}\n`);
  } else {
    parts.push(`# Workflow Context (Workspace-level)\n`);
    // Show all files with nodes
    const filesWithNodes = new Set<string>();
    graph.nodes.forEach(n => {
      if (n.source?.file) {
        filesWithNodes.add(n.source.file);
      }
    });
    if (filesWithNodes.size > 0) {
      parts.push(`## Files in Workflow`);
      Array.from(filesWithNodes).forEach(file => {
        const nodeCount = graph.nodes.filter(n => n.source?.file === file).length;
        parts.push(`- \`${file}\` (${nodeCount} node${nodeCount !== 1 ? 's' : ''})`);
      });
      parts.push('');
    }
  }

  // View state context (show what user is currently looking at in visualization)
  if (viewState && viewState.selectedNodeId) {
    const selectedNode = graph.nodes.find(n => n.id === viewState.selectedNodeId);
    if (selectedNode) {
      parts.push(`## Currently Viewing Node`);
      parts.push(`**${selectedNode.label}** (${selectedNode.type})`);
      parts.push(`- File: \`${selectedNode.source?.file || 'unknown'}\``);
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

  // Node adjacency (prioritized by visibility, then selected node)
  if (metadata.adjacentNodes.length > 0) {
    const visibleNodeIds = viewState?.visibleNodeIds || [];
    const hasVisibleNodes = visibleNodeIds.length > 0;

    // Dynamic limit: show more nodes if we have visible nodes (to supplement with global context)
    const nodeLimit = hasVisibleNodes ? 25 : 10;

    const priorityNote = hasVisibleNodes ? ' (prioritized by viewport visibility)' :
                        viewState?.selectedNodeId ? ' (prioritized by selected node)' : '';
    parts.push(`## Workflow Nodes${priorityNote}`);

    const displayNodes = metadata.adjacentNodes.slice(0, nodeLimit);

    // Helper function for this section (before createNodeLink is defined in Workflows section)
    const makeNodeLink = (nodeId: string): string => {
      const n = graph.nodes.find(n => n.id === nodeId);
      if (!n) return nodeId;
      const uri = `command:aiworkflowviz.focusNode?${encodeURIComponent(JSON.stringify([nodeId, n.label]))}`;
      return `[${n.label}](${uri} "${n.label} (${n.type})")`;
    };

    displayNodes.forEach((node, index) => {
      const isSelected = node.nodeId === viewState?.selectedNodeId;
      const isVisible = hasVisibleNodes && visibleNodeIds.includes(node.nodeId);
      const marker = isSelected ? '⭐ ' : isVisible ? '👁️ ' : '';

      parts.push(`### ${index + 1}. ${marker}${node.label} (${node.type})`);
      parts.push(`- File: \`${node.source.file}\``);
      parts.push(`- Location: ${node.source.function} at line ${node.source.line}`);

      // Clickable "preceded by" links
      if (node.beforeNodes.length > 0) {
        const beforeLinks = node.beforeNodes.map(makeNodeLink);
        parts.push(`- Preceded by: ${beforeLinks.join(', ')}`);
      }

      // Clickable "followed by" links
      if (node.afterNodes.length > 0) {
        const afterLinks = node.afterNodes.map(makeNodeLink);
        parts.push(`- Followed by: ${afterLinks.join(', ')}`);
      }

      // Include code snippet if available
      const nodeWithSnippet = node as any;
      if (nodeWithSnippet.codeSnippet) {
        parts.push(`- Code context:\n\`\`\`\n${nodeWithSnippet.codeSnippet}\n\`\`\``);
      }

      parts.push('');
    });

    if (metadata.adjacentNodes.length > nodeLimit) {
      parts.push(`_... and ${metadata.adjacentNodes.length - nodeLimit} more nodes_\n`);
    }
  }

  // Helper function to create clickable node link
  const createNodeLink = (nodeId: string): string => {
    const node = graph.nodes.find(n => n.id === nodeId);
    if (!node) return nodeId;

    const commandUri = `command:aiworkflowviz.focusNode?${encodeURIComponent(JSON.stringify([nodeId, node.label]))}`;
    return `[${node.label}](${commandUri} "${node.label} (${node.type})")`;
  };

  // Workflows
  if (metadata.workflows.length > 0) {
    parts.push(`## Workflows`);
    metadata.workflows.forEach(wf => {
      parts.push(`### ${wf.name}`);

      // Entry points with clickable links
      const entryLinks = wf.entryPoints.map(createNodeLink);
      parts.push(`- Entry points: ${entryLinks.join(', ')}`);

      // Exit points with clickable links
      const exitLinks = wf.exitPoints.map(createNodeLink);
      parts.push(`- Exit points: ${exitLinks.join(', ')}`);

      // Critical path with clickable links and arrows
      if (wf.criticalPath.length > 0) {
        const pathLinks = wf.criticalPath.map(createNodeLink);
        parts.push(`- Critical path: ${pathLinks.join(' → ')}`);
      }
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

/**
 * Detect code modifications in LLM response and offer to apply them
 */
async function detectAndApplyCodeModifications(
  response: string,
  graph: WorkflowGraph,
  viewState: ViewState | null,
  codeModifier: CodeModifier,
  stream: vscode.ChatResponseStream
): Promise<void> {
  // Look for code blocks with file paths
  const codeBlockRegex = /```(\w+)\n\/\/\s*File:\s*(.+?)\n\/\/\s*Insert after line (\d+).*?\n([\s\S]*?)```/g;
  const modifyBlockRegex = /```(\w+)\n\/\/\s*File:\s*(.+?)\n\/\/\s*Modify.*?line (\d+).*?\n([\s\S]*?)```/g;

  let match;
  const modifications: Array<{ type: 'insert' | 'modify', file: string, line: number, code: string, language: string }> = [];

  // Detect insertions
  while ((match = codeBlockRegex.exec(response)) !== null) {
    modifications.push({
      type: 'insert',
      language: match[1],
      file: match[2].trim(),
      line: parseInt(match[3]),
      code: match[4].trim()
    });
  }

  // Detect modifications
  while ((match = modifyBlockRegex.exec(response)) !== null) {
    modifications.push({
      type: 'modify',
      language: match[1],
      file: match[2].trim(),
      line: parseInt(match[3]),
      code: match[4].trim()
    });
  }

  if (modifications.length === 0) {
    return;
  }

  // Offer to apply modifications
  stream.markdown('\n\n---\n\n');
  stream.markdown(`**💡 Code modifications detected** (${modifications.length})\n\n`);

  for (const mod of modifications) {
    const button = stream.button({
      command: 'aiworkflowviz.applyCodeModification',
      arguments: [mod],
      title: `Apply ${mod.type} to ${mod.file}:${mod.line}`
    });

    stream.markdown(`- ${mod.type === 'insert' ? '➕ Insert' : '✏️ Modify'} code in \`${mod.file}\` at line ${mod.line}\n`);
  }

  stream.markdown('\n*Click a button above to preview and apply the changes*\n');
}
