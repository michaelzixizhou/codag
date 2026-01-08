/**
 * Chat Participant for providing workflow context to Copilot
 * Users invoke with @codag in Copilot Chat
 */

import * as vscode from 'vscode';
import { CacheManager } from '../cache';
import { WorkflowGraph } from '../api';
import { WorkflowMetadataProvider } from './metadata-provider';
import { ViewState, WorkflowMetadata } from './types';
import { filterOrphanedNodes } from './graph-filter';
import { TYPE_SYMBOLS, createNodeLink, formatWorkflowsCompact, formatLegend, linkifyResponse, linkifyWorkflows } from './compact-formatter';

// Tool definitions for the LLM to use
const TOOL_DEFINITIONS: vscode.LanguageModelChatTool[] = [
  {
    name: 'list-workflows',
    description: 'Get a complete list of ALL workflows with descriptions, node counts, entry/exit points, LLM calls, and files. CALL THIS FIRST for any analysis or overview questions.',
    inputSchema: {
      type: 'object',
      properties: {
        includeNodeTypes: { type: 'boolean', description: 'Include breakdown of node types in each workflow (default: true)' }
      }
    }
  },
  {
    name: 'workflow-query',
    description: 'Get detailed structure of a specific workflow by name - shows all nodes in tree format with connections.',
    inputSchema: {
      type: 'object',
      properties: {
        workflowName: { type: 'string', description: 'The workflow name to query (partial match supported)' },
        includeDetails: { type: 'boolean', description: 'Include node descriptions and metadata' }
      },
      required: ['workflowName']
    }
  },
  {
    name: 'node-query',
    description: 'Search and filter nodes by various criteria - workflow, type, connections, or shared status.',
    inputSchema: {
      type: 'object',
      properties: {
        workflowName: { type: 'string', description: 'Filter to nodes in this workflow' },
        nodeType: { type: 'string', description: 'Filter by type: trigger, llm, tool, decision, integration, memory, parser, output' },
        connectedTo: { type: 'string', description: 'Find nodes connected to this node ID' },
        shared: { type: 'boolean', description: 'Find nodes appearing in multiple workflows' }
      }
    }
  },
  {
    name: 'workflow-navigate',
    description: 'Navigate workflow graphs - find paths between nodes, get upstream dependencies, or downstream effects.',
    inputSchema: {
      type: 'object',
      properties: {
        operation: { type: 'string', description: 'Operation: "path" (find route between nodes), "upstream" (what leads here), "downstream" (what follows)' },
        fromNode: { type: 'string', description: 'Node ID or label to start from' },
        toNode: { type: 'string', description: 'Node ID or label to end at (required for "path" operation)' },
        maxDepth: { type: 'number', description: 'Max depth for upstream/downstream traversal (default: 5)' }
      },
      required: ['operation', 'fromNode']
    }
  },
  {
    name: 'workflow-file-reader',
    description: 'Read source code from a file. Use when you need to see the actual implementation code for a node.',
    inputSchema: {
      type: 'object',
      properties: {
        filePath: { type: 'string', description: 'Absolute path to the file' },
        startLine: { type: 'number', description: 'Start line number (optional, for reading a section)' },
        endLine: { type: 'number', description: 'End line number (optional, for reading a section)' }
      },
      required: ['filePath']
    }
  }
];

export function registerWorkflowParticipant(
  context: vscode.ExtensionContext,
  cacheManager: CacheManager,
  getViewState: () => ViewState | null
): vscode.Disposable {

  const metadataProvider = new WorkflowMetadataProvider();

  const handler: vscode.ChatRequestHandler = async (
    request: vscode.ChatRequest,
    chatContext: vscode.ChatContext,
    stream: vscode.ChatResponseStream,
    token: vscode.CancellationToken
  ) => {
    console.log('🎯 [@codag] Participant invoked');
    console.log('📝 [@codag] User prompt:', request.prompt);
    console.log('🔧 [@codag] Command:', request.command);

    try {
      stream.progress('Loading workflow context...');

      let filePath: string | undefined;
      let fileContent: string | undefined;
      let graph: WorkflowGraph | null = null;

      // Strategy 1: Check view state for selected node
      const viewState = getViewState();
      if (viewState?.selectedNodeId) {
        console.log('📍 [@codag] Selected node detected:', viewState.selectedNodeId);
        graph = await cacheManager.getMostRecentWorkflows();
        if (graph) {
          const selectedNode = graph.nodes.find((n: any) => n.id === viewState.selectedNodeId);
          if (selectedNode?.source) {
            filePath = selectedNode.source.file;
            console.log('📁 [@codag] Using file from selected node:', filePath);
            try {
              const uri = vscode.Uri.file(filePath);
              const document = await vscode.workspace.openTextDocument(uri);
              fileContent = document.getText();
            } catch (error) {
              console.warn('⚠️  [@codag] Failed to read selected node file:', error);
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
          console.log('📁 [@codag] Using active editor file:', filePath);
          graph = await cacheManager.getPerFile(filePath, fileContent);
        }
      }

      // Strategy 3: Fall back to all cached workflows
      if (!graph) {
        console.log('📊 [@codag] No file context, using workspace-level cache');
        graph = await cacheManager.getMostRecentWorkflows();
      }

      // Only error if no cache exists at all
      if (!graph) {
        stream.markdown('⚠️ No workflow data found.\n\n');
        stream.markdown('Run **Codag: Auto-detect and Visualize** first to analyze workflows.');
        return { metadata: { command: request.command } };
      }

      console.log('✅ [@codag] Found graph with', graph.nodes.length, 'nodes');

      // Filter out orphaned nodes and their edges (match webview rendering)
      const filteredGraph = filterOrphanedNodes(graph);
      console.log('🔍 [@codag] Filtered to', filteredGraph.nodes.length, 'nodes in LLM workflows');

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
      console.log('📊 [@codag] Context size:', contextStr.length, 'chars');

      // Show selected node compactly
      if (viewState?.selectedNodeId) {
        const node = filteredGraph.nodes.find((n: any) => n.id === viewState.selectedNodeId);
        if (node) {
          const sym = TYPE_SYMBOLS[node.type] || '□';
          stream.markdown(`**Viewing:** ${sym} ${node.label}\n\n`);
        }
      }

      // Build LLM messages with workflow context
      stream.progress('Analyzing workflow with AI...');

      const systemPrompt = `You are Codag, a workflow visualization assistant with FULL access to all workflow data through tools.

NODE TYPES: ⚡trigger 🧠llm 🔧tool ◇decision 🔌integration 💾memory ⚙️parser ✓output

TOOLS - USE THEM TO INVESTIGATE:
- list-workflows: Get ALL workflows with details. CALL THIS FIRST for overview/analysis questions.
- workflow-query: Get detailed nodes in a specific workflow by name.
- node-query: Search nodes by type, workflow, connections, or shared status.
- workflow-navigate: Find paths between nodes, upstream dependencies, downstream effects.
- workflow-file-reader: Read source code files to see implementation.

CRITICAL RULES:
- You have COMPLETE access to all workflow data - USE THE TOOLS to investigate
- NEVER ask the user to paste, copy, or provide workflow data - you can get it yourself
- NEVER say "I can't see the full graph" - call list-workflows instead
- NEVER ask the user to run commands - use tools yourself
- For analysis questions, call list-workflows FIRST to see everything
- Be concise in responses
- Use exact workflow/node names from your tool results

If no workflow data exists, suggest running "Codag: Open" and using the analysis panel.

CONTEXT (partial view - use tools for complete data):
${contextStr}`;

      // Build messages with full conversation history
      const buildMessages = (includeFullHistory: boolean): vscode.LanguageModelChatMessage[] => {
        const msgs: vscode.LanguageModelChatMessage[] = [
          vscode.LanguageModelChatMessage.User(systemPrompt),
        ];

        if (includeFullHistory) {
          // Include all previous turns
          for (const turn of chatContext.history) {
            try {
              if (turn instanceof vscode.ChatRequestTurn) {
                msgs.push(vscode.LanguageModelChatMessage.User(turn.prompt));
              } else if (turn instanceof vscode.ChatResponseTurn) {
                // Safely extract text from response parts
                const parts: string[] = [];
                for (const part of turn.response) {
                  if (part instanceof vscode.ChatResponseMarkdownPart) {
                    // Handle both string and MarkdownString
                    const val = part.value;
                    if (typeof val === 'string') {
                      parts.push(val);
                    } else if (val && typeof val.value === 'string') {
                      parts.push(val.value);
                    }
                  }
                }
                const responseText = parts.join('');
                if (responseText) {
                  msgs.push(vscode.LanguageModelChatMessage.Assistant(responseText));
                }
              }
            } catch (e) {
              console.warn('⚠️ [@codag] Failed to parse history turn:', e);
            }
          }
        } else if (chatContext.history.length > 0) {
          // Compact mode: just summarize what was discussed
          const mentions = extractMentionsFromHistory(chatContext.history);
          if (mentions.length > 0) {
            msgs.push(vscode.LanguageModelChatMessage.User(
              `[Previous discussion covered: ${mentions.join(', ')}]`
            ));
          }
        }

        msgs.push(vscode.LanguageModelChatMessage.User(request.prompt));
        return msgs;
      };

      // Get model - use request.model if valid, otherwise get first available
      async function getModel(): Promise<vscode.LanguageModelChat> {
        const models = await vscode.lm.selectChatModels();
        if (models.length === 0) {
          throw new Error('No language models available. Please ensure Copilot is active.');
        }
        return models[0];
      }

      // Check if request.model is valid (not "auto" or undefined)
      let model: vscode.LanguageModelChat;
      if (request.model && request.model.id && !request.model.id.includes('auto')) {
        model = request.model;
      } else {
        // Fallback to first available model
        console.log('⚠️ [@codag] Model is "auto" or invalid, using fallback');
        model = await getModel();
      }

      // Request options with tools
      const requestOptions: vscode.LanguageModelChatRequestOptions = {
        tools: TOOL_DEFINITIONS
      };

      let chatResponse;
      let messages = buildMessages(true);

      try {
        chatResponse = await model.sendRequest(messages, requestOptions, token);
      } catch (error: any) {
        // Handle token limit - use compact history
        if (error?.message?.includes('token') || error?.code === 'TooManyTokens') {
          stream.progress('Compacting conversation history...');
          messages = buildMessages(false);
          chatResponse = await model.sendRequest(messages, requestOptions, token);
        }
        // Handle invalid model - fallback to first available
        else if (error?.message?.includes('Endpoint not found') || error?.message?.includes('model')) {
          console.log('⚠️ [@codag] Model error, using fallback:', error.message);
          model = await getModel();
          chatResponse = await model.sendRequest(messages, requestOptions, token);
        }
        else {
          throw error;
        }
      }

      // Process response with tool call loop
      let fullResponse = '';
      const MAX_TOOL_CALLS = 5;
      let toolCallCount = 0;

      stream.progress('Generating response...');

      // Tool calling loop
      while (true) {
        let hasToolCall = false;

        for await (const part of chatResponse.stream) {
          if (part instanceof vscode.LanguageModelTextPart) {
            fullResponse += part.value;
          } else if (part instanceof vscode.LanguageModelToolCallPart) {
            hasToolCall = true;

            if (toolCallCount >= MAX_TOOL_CALLS) {
              console.log('⚠️ [@codag] Tool call limit reached');
              fullResponse += '\n\n*[Tool call limit reached]*';
              break;
            }
            toolCallCount++;

            console.log(`🔧 [@codag] Tool call: ${part.name}`, part.input);
            stream.progress(`Using ${part.name}...`);

            try {
              // Invoke the registered tool
              const toolResult = await vscode.lm.invokeTool(part.name, {
                input: part.input,
                toolInvocationToken: undefined
              }, token);

              // Extract text from tool result
              let resultText = '';
              for (const content of toolResult.content) {
                if (content instanceof vscode.LanguageModelTextPart) {
                  resultText += content.value;
                }
              }

              console.log(`✅ [@codag] Tool result (${resultText.length} chars)`);

              // Build new messages with tool call and result
              messages.push(vscode.LanguageModelChatMessage.Assistant([part]));
              messages.push(vscode.LanguageModelChatMessage.User([
                new vscode.LanguageModelToolResultPart(part.callId, [new vscode.LanguageModelTextPart(resultText)])
              ]));

              // Continue conversation with tool result
              chatResponse = await model.sendRequest(messages, requestOptions, token);
            } catch (toolError: any) {
              console.error('❌ [@codag] Tool error:', toolError);
              // Send error back to model
              messages.push(vscode.LanguageModelChatMessage.Assistant([part]));
              messages.push(vscode.LanguageModelChatMessage.User([
                new vscode.LanguageModelToolResultPart(part.callId, [new vscode.LanguageModelTextPart(`Error: ${toolError.message}`)])
              ]));
              chatResponse = await model.sendRequest(messages, requestOptions, token);
            }
            break; // Process next response iteration
          }
        }

        if (!hasToolCall) {
          break; // No more tool calls, we're done
        }
      }

      // Output final response
      stream.markdown(fullResponse);

      console.log('✅ [@codag] Response completed');

      return { metadata: { command: request.command } };

    } catch (error) {
      console.error('❌ [@codag] Error:', error);
      stream.markdown(`❌ Error: ${error}`);
      return { metadata: { command: request.command, error: String(error) } };
    }
  };

  // Create and register participant
  const participant = vscode.chat.createChatParticipant(
    'codag.workflow',
    handler
  );

  participant.iconPath = vscode.Uri.joinPath(context.extensionUri, 'media/icon-chat.png');

  context.subscriptions.push(participant);
  console.log('✅ Registered @codag chat participant');

  return participant;
}

/**
 * Format metadata in compact format for the LLM
 */
function formatMetadata(
  metadata: WorkflowMetadata,
  filePath: string,
  viewState: ViewState | null,
  graph: WorkflowGraph
): string {
  const parts: string[] = [];

  // Selected node (if any)
  if (viewState?.selectedNodeId) {
    const node = graph.nodes.find(n => n.id === viewState.selectedNodeId);
    if (node) {
      const sym = TYPE_SYMBOLS[node.type] || '□';
      const link = createNodeLink(node.id, node.label);
      const location = node.source ? `→ ${node.source.file}:${node.source.line}` : '';
      parts.push(`Selected: ${sym} ${link} ${location}`);
      parts.push('');
    }
  }

  // Workflows as clickable links (not verbose tree structure)
  if (metadata.workflows.length > 0) {
    parts.push(formatWorkflowsCompact(metadata.workflows));
  }

  // All nodes list (compact)
  if (metadata.adjacentNodes.length > 0) {
    const visibleNodeIds = viewState?.visibleNodeIds || [];
    const nodeLimit = visibleNodeIds.length > 0 ? 25 : 15;
    const displayNodes = metadata.adjacentNodes.slice(0, nodeLimit);

    parts.push('Nodes:');
    displayNodes.forEach(node => {
      const sym = TYPE_SYMBOLS[node.type] || '□';
      const link = createNodeLink(node.nodeId, node.label);
      const location = `→ ${node.source.file}:${node.source.line}`;

      // Adjacency on same line if present
      const adj: string[] = [];
      if (node.beforeNodes.length > 0) {
        const beforeLinks = node.beforeNodes.slice(0, 2).map(id => {
          const n = graph.nodes.find(n => n.id === id);
          return n ? createNodeLink(id, n.label) : id;
        });
        adj.push(`← ${beforeLinks.join(', ')}`);
      }
      if (node.afterNodes.length > 0) {
        const afterLinks = node.afterNodes.slice(0, 2).map(id => {
          const n = graph.nodes.find(n => n.id === id);
          return n ? createNodeLink(id, n.label) : id;
        });
        adj.push(`→ ${afterLinks.join(', ')}`);
      }

      const adjStr = adj.length > 0 ? ` | ${adj.join(' | ')}` : '';
      parts.push(`${sym} ${link} ${location}${adjStr}`);
    });

    if (metadata.adjacentNodes.length > nodeLimit) {
      parts.push(`... +${metadata.adjacentNodes.length - nodeLimit} more`);
    }
    parts.push('');
  }

  // Cross-file connections (compact)
  if (metadata.crossFileEdges.length > 0) {
    parts.push('Cross-file:');
    metadata.crossFileEdges.slice(0, 5).forEach(edge => {
      const fromNode = graph.nodes.find(n => n.id === edge.from.nodeId);
      const toNode = graph.nodes.find(n => n.id === edge.to.nodeId);
      const fromLink = fromNode ? createNodeLink(edge.from.nodeId, fromNode.label) : edge.from.nodeId;
      const toLink = toNode ? createNodeLink(edge.to.nodeId, toNode.label) : edge.to.nodeId;
      parts.push(`${fromLink} → ${toLink}`);
    });
    parts.push('');
  }

  parts.push(formatLegend());

  return parts.join('\n');
}

/**
 * Extract workflow/node mentions from conversation history for compact mode
 */
function extractMentionsFromHistory(history: readonly (vscode.ChatRequestTurn | vscode.ChatResponseTurn)[]): string[] {
  const mentions: Set<string> = new Set();

  for (const turn of history) {
    if (turn instanceof vscode.ChatRequestTurn) {
      const text = turn.prompt;
      // Extract quoted names or capitalized multi-word phrases (likely workflow/node names)
      const nameMatches = text.match(/["']([^"']+)["']|(?:[A-Z][a-z]+(?:\s+[A-Z][a-z]+)+)/g);
      if (nameMatches) {
        nameMatches.forEach(m => mentions.add(m.replace(/["']/g, '')));
      }
    }
  }

  return Array.from(mentions);
}

