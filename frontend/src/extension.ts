import * as vscode from 'vscode';
import * as fs from 'fs';
import { APIClient, WorkflowGraph, TrialExhaustedError } from './api';
import { AuthManager, AuthState, OAuthProvider } from './auth';
import { CacheManager } from './cache';
import { WorkflowDetector } from './analyzer';
import { WebviewManager } from './webview';
import { metadataBuilder, FileMetadata } from './metadata-builder';
import { registerWorkflowParticipant } from './copilot/workflow-participant';
import { registerWorkflowTool } from './copilot/workflow-tool';
import { registerWorkflowQueryTool } from './copilot/workflow-query-tool';
import { registerNodeQueryTool } from './copilot/node-query-tool';
import { registerWorkflowNavigateTool } from './copilot/workflow-navigate-tool';
import { registerListWorkflowsTool } from './copilot/list-workflows-tool';
import { CONFIG } from './config';
import { buildFileTree, saveFilePickerSelection, getSavedSelectedPaths } from './file-picker';
import { extractCallGraph, diffCallGraphs, ExtractedCallGraph } from './call-graph-extractor';
import { applyLocalUpdate, createGraphFromCallGraph, LocalUpdateResult } from './local-graph-updater';
import { getMetadataBatcher, buildMetadataContext, MetadataContext } from './metadata-batcher';
import { extractRepoStructure, formatStructureForLLM, formatHttpConnectionsForPrompt, RawRepoStructure, FileStructure } from './repo-structure';
import { resolveExternalEdges, logResolutionStats } from './edge-resolver';

// Cost tracking
import { estimateTokens, calculateCost, formatCost, CostAggregator, displayCostReport } from './cost-tracking';

// File preparation
import { formatFileXML, combineFilesXML, createDependencyBatches, FileContent } from './file-preparation';


const outputChannel = vscode.window.createOutputChannel('Codag');

/**
 * Log message with timestamp
 */
function log(message: string): void {
    const now = new Date();
    const hours = now.getHours().toString().padStart(2, '0');
    const minutes = now.getMinutes().toString().padStart(2, '0');
    const seconds = now.getSeconds().toString().padStart(2, '0');
    const timestamp = `${hours}:${minutes}:${seconds}`;
    outputChannel.appendLine(`[${timestamp}] ${message}`);
}

/**
 * Trace call graph from seed files to find all files with LLM calls.
 * Uses imports and function calls to find transitively connected LLM code.
 *
 * @param repoStructure - The extracted repo structure with functions, imports, and calls
 * @param seedFiles - Starting files (e.g., HTTP handlers) to trace from
 * @returns Set of file paths that are connected to LLM calls
 */
function traceCallGraphToLLM(repoStructure: RawRepoStructure, seedFiles: Set<string>): Set<string> {
    const result = new Set<string>();
    const visited = new Set<string>();

    // Build lookup maps for efficient resolution
    const fileByPath = new Map<string, FileStructure>();
    const fileByBasename = new Map<string, FileStructure[]>();
    const exportedSymbolToFile = new Map<string, string>();

    for (const file of repoStructure.files) {
        fileByPath.set(file.path, file);

        // Index by basename for fuzzy matching
        const basename = file.path.split('/').pop() || file.path;
        const basenameNoExt = basename.replace(/\.(py|ts|js|tsx|jsx)$/, '');
        if (!fileByBasename.has(basenameNoExt)) {
            fileByBasename.set(basenameNoExt, []);
        }
        fileByBasename.get(basenameNoExt)!.push(file);

        // Index exported symbols
        for (const exp of file.exports) {
            exportedSymbolToFile.set(exp, file.path);
        }
        for (const func of file.functions) {
            if (func.isExported) {
                exportedSymbolToFile.set(func.name, file.path);
            }
        }
    }

    // Resolve import source to actual file path
    function resolveImport(importSource: string, fromFile: string): string | null {
        // Handle relative imports (./foo, ../bar)
        if (importSource.startsWith('.')) {
            const fromDir = fromFile.split('/').slice(0, -1).join('/');
            const parts = importSource.split('/');
            let resolved = fromDir.split('/');

            for (const part of parts) {
                if (part === '.') continue;
                if (part === '..') {
                    resolved.pop();
                } else {
                    resolved.push(part);
                }
            }

            const basePath = resolved.join('/');
            // Try with different extensions
            for (const ext of ['', '.py', '.ts', '.js', '.tsx', '.jsx']) {
                const tryPath = basePath + ext;
                if (fileByPath.has(tryPath)) {
                    return tryPath;
                }
            }
            // Try as directory with index
            for (const idx of ['index.ts', 'index.js', '__init__.py']) {
                const tryPath = basePath + '/' + idx;
                if (fileByPath.has(tryPath)) {
                    return tryPath;
                }
            }
        }

        // Handle Python module notation (from gemini_client import ...)
        const moduleBasename = importSource.split('.').pop() || importSource;
        const candidates = fileByBasename.get(moduleBasename);
        if (candidates && candidates.length > 0) {
            // Prefer file in same directory as fromFile
            const fromDir = fromFile.split('/').slice(0, -1).join('/');
            const sameDir = candidates.find(c => c.path.startsWith(fromDir + '/'));
            if (sameDir) return sameDir.path;
            return candidates[0].path;
        }

        return null;
    }

    // For each seed file, BFS to check if it's connected to any LLM calls
    // If connected, add the seed file to results (the seed file is what we care about)
    for (const seedFile of seedFiles) {
        const localVisited = new Set<string>();
        const queue = [seedFile];
        let foundLLM = false;

        while (queue.length > 0 && !foundLLM) {
            const filePath = queue.shift()!;
            if (localVisited.has(filePath)) continue;
            localVisited.add(filePath);

            const file = fileByPath.get(filePath);
            if (!file) continue;

            // Check if this file has LLM calls
            if (file.functions.some(f => f.hasLLMCall)) {
                foundLLM = true;
                break;
            }

            // Trace imports to find more files
            for (const imp of file.imports) {
                const resolvedPath = resolveImport(imp.source, filePath);
                if (resolvedPath && !localVisited.has(resolvedPath)) {
                    queue.push(resolvedPath);
                }
            }

            // Trace function calls to find more files
            for (const func of file.functions) {
                for (const call of func.calls) {
                    // Check if call matches an exported symbol
                    const callName = call.split('.').pop() || call;
                    const targetFile = exportedSymbolToFile.get(callName);
                    if (targetFile && !localVisited.has(targetFile)) {
                        queue.push(targetFile);
                    }
                }
            }
        }

        // If this seed file is connected to LLM calls, add it to results
        if (foundLLM) {
            result.add(seedFile);
            // Also add all files in the trace path (they're all part of the LLM chain)
            for (const visitedFile of localVisited) {
                result.add(visitedFile);
            }
        }
    }

    return result;
}

export async function activate(context: vscode.ExtensionContext) {
    log('Codag activating...');

    const config = vscode.workspace.getConfiguration('codag');
    const apiUrl = config.get<string>('apiUrl', 'http://localhost:8000');

    log(`Backend API URL: ${apiUrl}`);

    const api = new APIClient(apiUrl, outputChannel);
    const auth = new AuthManager(context, api);
    await auth.initialize(); // Load token from secure storage
    const cache = new CacheManager(context);
    const webview = new WebviewManager(context);

    // Analysis session counter - incremented when cache is cleared to invalidate pending requests
    let analysisSession = 0;

    // Store pending task when blocked by trial quota
    let pendingAnalysisTask: (() => Promise<void>) | null = null;

    // Register URI handler for OAuth callbacks
    const uriHandler = vscode.window.registerUriHandler({
        handleUri(uri: vscode.Uri) {
            log(`URI Handler received: ${uri.toString()}`);
            if (uri.path === '/auth/callback') {
                const params = new URLSearchParams(uri.query);
                const token = params.get('token');
                const error = params.get('error');

                if (error) {
                    auth.handleOAuthError(error);
                } else if (token) {
                    auth.handleOAuthCallback(token);
                }
            }
        }
    });
    context.subscriptions.push(uriHandler);
    log('Registered OAuth URI handler (vscode://codag.codag/auth/callback)');

    // Wire up auth state changes to webview
    auth.setOnAuthStateChange(async (state: AuthState) => {
        log(`[auth] State changed: isAuthenticated=${state.isAuthenticated}, isTrial=${state.isTrial}, pendingTask=${!!pendingAnalysisTask}`);
        webview.updateAuthState(state);

        // Retry pending task if user just authenticated
        if (state.isAuthenticated && pendingAnalysisTask) {
            log('[auth] User authenticated, retrying blocked analysis...');
            const task = pendingAnalysisTask;
            pendingAnalysisTask = null;
            try {
                await task();
            } catch (error: any) {
                log(`[auth] Retry failed: ${error.message}`);
            }
        }
    });

    // Wire up auth errors to webview
    auth.setOnAuthError((error: string) => {
        log(`[auth] Error: ${error}`);
        webview.showAuthError(error);
    });

    // Check trial status on activation (validates token with backend) - non-blocking
    auth.checkTrialStatus().then(remaining => {
        log(`Trial status: ${remaining} analyses remaining`);
        webview.updateAuthState(auth.getAuthState());
    }).catch(err => {
        log(`Trial status check failed: ${err.message}`);
    });

    // Handle OAuth start command from webview
    context.subscriptions.push(
        vscode.commands.registerCommand('codag.startOAuth', async (provider: OAuthProvider) => {
            log(`Starting OAuth flow for ${provider}`);
            await auth.startOAuth(provider);
        })
    );

    // Handle logout command
    context.subscriptions.push(
        vscode.commands.registerCommand('codag.logout', async () => {
            await auth.logout();
        })
    );

    // Register Copilot integrations (dual approach for reliability)

    // 1. Language Model Tool - Auto-invoked by Copilot (may be unreliable)
    const toolDisposable = registerWorkflowTool(cache, () => webview.getViewState());
    if (toolDisposable) {
        context.subscriptions.push(toolDisposable);
        log('Registered workflow-context tool (automatic)');
    } else {
        log('Warning: Language Model Tool API not available');
    }

    // 2. File Reader Tool - Allows LLM to read file contents on demand
    const { registerFileReaderTool } = require('./copilot/file-reader-tool');
    const fileReaderTool = registerFileReaderTool();
    if (fileReaderTool) {
        context.subscriptions.push(fileReaderTool);
        log('Registered workflow-file-reader tool');
    }

    // 3. List Workflows Tool - Allows LLM to get overview of ALL workflows
    const listWorkflowsTool = registerListWorkflowsTool(cache);
    if (listWorkflowsTool) {
        context.subscriptions.push(listWorkflowsTool);
        log('Registered list-workflows tool');
    }

    // 4. Workflow Query Tool - Allows LLM to query complete workflows by name
    const workflowQueryTool = registerWorkflowQueryTool(cache);
    if (workflowQueryTool) {
        context.subscriptions.push(workflowQueryTool);
        log('Registered workflow-query tool');
    }

    // 5. Node Query Tool - Allows LLM to filter and search nodes
    const nodeQueryTool = registerNodeQueryTool(cache);
    if (nodeQueryTool) {
        context.subscriptions.push(nodeQueryTool);
        log('Registered node-query tool');
    }

    // 7. Workflow Navigate Tool - Allows LLM to find paths and analyze dependencies
    const navigateTool = registerWorkflowNavigateTool(cache);
    if (navigateTool) {
        context.subscriptions.push(navigateTool);
        log('Registered workflow-navigate tool');
    }

    // 6. Chat Participant - Explicit @codag mention (100% reliable)
    context.subscriptions.push(registerWorkflowParticipant(context, cache, () => webview.getViewState()));
    log('Registered @codag chat participant (explicit)');

    // File watching for auto-refresh on save
    const fileWatcher = vscode.workspace.createFileSystemWatcher(
        '**/*.{py,ts,js,jsx,tsx,mjs,cjs}',
        false, // ignoreCreateEvents
        false, // ignoreChangeEvents
        true   // ignoreDeleteEvents
    );

    // Shared debounce mechanism to batch file changes
    const pendingChanges = new Map<string, NodeJS.Timeout>();
    const DEBOUNCE_MS = CONFIG.WATCHER.DEBOUNCE_MS;
    const cachedCallGraphs = new Map<string, ExtractedCallGraph>();

    // Initialize metadata batcher for incremental label updates
    const metadataBatcher = getMetadataBatcher({
        debounceMs: 3000,
        maxWaitMs: 30000
    });
    metadataBatcher.setCacheManager(cache);

    // Handle metadata fetch (call LLM endpoint for labels)
    metadataBatcher.onFetch(async (files, contexts) => {
        log(`[Metadata Batch] Fetching metadata for ${files.length} files...`);

        try {
            const apiFiles = contexts.map(ctx => ({
                filePath: ctx.filePath,
                functions: ctx.functions.map(f => ({
                    name: f.name,
                    line: f.line,
                    type: f.type,
                    calls: f.calls,
                    code: f.code
                })),
                imports: ctx.imports
            }));

            const result = await api.analyzeMetadataOnly(apiFiles);
            log(`[Metadata Batch] Received metadata for ${result.files.length} files`);

            const metadataMap = new Map<string, {
                labels: Record<string, string>;
                descriptions: Record<string, string>;
                edgeLabels: Record<string, string>;
                timestamp: number;
            }>();

            for (const fileResult of result.files) {
                const labels: Record<string, string> = {};
                const descriptions: Record<string, string> = {};

                for (const func of fileResult.functions) {
                    labels[func.name] = func.label;
                    descriptions[func.name] = func.description;
                }

                metadataMap.set(fileResult.filePath, {
                    labels,
                    descriptions,
                    edgeLabels: fileResult.edgeLabels || {},
                    timestamp: Date.now()
                });
            }

            return metadataMap;
        } catch (error) {
            log(`[Metadata Batch] Error: ${error}`);
            throw error;
        }
    });

    // Handle metadata ready (hydrate labels in UI)
    metadataBatcher.onReady((filePath, metadata) => {
        log(`[Metadata Batch] Hydrating labels for ${filePath}: ${Object.keys(metadata.labels).length} labels`);
        webview.hydrateLabels(filePath, metadata.labels, metadata.descriptions);
    });

    /**
     * Perform instant local structure update (no LLM)
     */
    const performLocalUpdate = async (uri: vscode.Uri): Promise<LocalUpdateResult | null> => {
        const filePath = uri.fsPath;
        const relativePath = vscode.workspace.asRelativePath(filePath);

        try {
            // Read file content
            const content = fs.readFileSync(filePath, 'utf-8');

            // Extract call graph (uses acorn for JS/TS, regex for Python)
            const newCallGraph = extractCallGraph(content, filePath);

            // Get cached call graph for comparison
            const oldCallGraph = cachedCallGraphs.get(filePath);

            // Get this file's cached graph
            const fileGraph = await cache.getMergedGraph([filePath]);

            if (oldCallGraph && fileGraph) {
                // Compute diff
                const diff = diffCallGraphs(oldCallGraph, newCallGraph);

                // Check if structure actually changed
                const hasChanges = diff.addedFunctions.length > 0 ||
                                   diff.removedFunctions.length > 0 ||
                                   diff.modifiedFunctions.length > 0 ||
                                   diff.addedEdges.length > 0 ||
                                   diff.removedEdges.length > 0;

                if (!hasChanges) {
                    log(`No structural changes in ${filePath}`);
                    const mergedGraph = await cache.getMergedGraph();
                    return { graph: mergedGraph!, nodesAdded: [], nodesRemoved: [], nodesUpdated: [], edgesAdded: 0, edgesRemoved: 0, needsMetadata: [], changedFunctions: [] };
                }

                // Apply local update to this file's graph (not merged)
                const result = applyLocalUpdate(fileGraph, diff, newCallGraph, relativePath);
                log(`Local update: +${result.nodesAdded.length} nodes, -${result.nodesRemoved.length} nodes, +${result.edgesAdded} edges`);

                // Populate changedFunctions from diff
                result.changedFunctions = [
                    ...diff.addedFunctions,
                    ...diff.removedFunctions,
                    ...diff.modifiedFunctions
                ];

                // Update caches with the file-specific graph
                cachedCallGraphs.set(filePath, newCallGraph);
                await cache.setAnalysisResult(result.graph, { [filePath]: content });

                // Get merged graph for display
                const mergedGraph = await cache.getMergedGraph();
                result.graph = mergedGraph!;

                return result;
            } else {
                // No cached call graph - this is first access since extension loaded.
                // Don't create graph from call graph - let the analysis path verify this is an LLM file.
                // Just store the call graph for future comparison if file changes again.
                cachedCallGraphs.set(filePath, newCallGraph);

                // Return the existing cached graph without modification
                const existingGraph = await cache.getMergedGraph([filePath]);
                if (existingGraph) {
                    const mergedGraph = await cache.getMergedGraph();
                    return {
                        graph: mergedGraph!,
                        nodesAdded: [],
                        nodesRemoved: [],
                        nodesUpdated: [],
                        edgesAdded: 0,
                        edgesRemoved: 0,
                        needsMetadata: [],
                        changedFunctions: []
                    };
                }
                return null;
            }
        } catch (error) {
            log(`Local update failed: ${error}`);
            return null;
        }
    };

    // Live file change indicator state
    const activelyEditingFiles = new Map<string, { timer: NodeJS.Timeout; functions: string[] }>();
    const changedFiles = new Map<string, string[]>();  // filePath → function names
    const ACTIVE_TO_CHANGED_MS = 4000;  // 4 seconds before transitioning to static

    const scheduleFileAnalysis = async (uri: vscode.Uri, source: string) => {
        const filePath = uri.fsPath;

        // Ignore compiled output files (they change when source files compile)
        if (filePath.includes('/out/') || filePath.includes('\\out\\')) {
            return;
        }

        // NOTE: We don't send immediate notification here.
        // We wait for tree-sitter diff to know WHICH functions changed.
        // Notification is sent after performLocalUpdate() completes.

        // Clear existing timeout for this file
        const existing = pendingChanges.get(filePath);
        if (existing) {
            clearTimeout(existing);
        }

        // Schedule new analysis after debounce period
        const timeout = setTimeout(async () => {
            pendingChanges.delete(filePath);
            log(`File changed (${source}): ${filePath}`);

            // Check if this file is in our cached workflows
            const isCached = await cache.isFileCached(filePath);
            if (isCached) {
                // Try instant local update first (tree-sitter/call-graph extraction)
                const localResult = await performLocalUpdate(uri);

                if (localResult) {
                    // Local update succeeded
                    if (localResult.nodesAdded.length > 0 || localResult.nodesRemoved.length > 0 ||
                        localResult.edgesAdded > 0 || localResult.edgesRemoved > 0) {
                        // Update graph in webview
                        webview.updateGraph(localResult.graph);
                        log(`Graph updated locally (instant) via tree-sitter`);

                        // Queue for metadata if new nodes need labels
                        if (localResult.needsMetadata.length > 0) {
                            const relativePath = vscode.workspace.asRelativePath(filePath);
                            const newCallGraph = cachedCallGraphs.get(filePath);
                            const context = buildMetadataContext(relativePath, cache, newCallGraph);
                            if (context) {
                                metadataBatcher.queueFile(relativePath, context);
                                log(`Queued ${relativePath} for metadata batch (${context.functions.length} functions)`);
                            }
                        }

                        // === Live file indicator: Send "active" notification with changed functions ===
                        if (localResult.changedFunctions.length > 0) {
                            webview.notifyFileStateChange([{
                                filePath,
                                functions: localResult.changedFunctions,
                                state: 'active'
                            }]);

                            // Clear existing transition timer
                            const existingTimer = activelyEditingFiles.get(filePath);
                            if (existingTimer) {
                                clearTimeout(existingTimer.timer);
                            }

                            // Set timer to transition to "changed" state after inactivity
                            const transitionTimer = setTimeout(() => {
                                activelyEditingFiles.delete(filePath);
                                changedFiles.set(filePath, localResult.changedFunctions);
                                webview.notifyFileStateChange([{
                                    filePath,
                                    functions: localResult.changedFunctions,
                                    state: 'changed'
                                }]);
                            }, ACTIVE_TO_CHANGED_MS);

                            activelyEditingFiles.set(filePath, {
                                timer: transitionTimer,
                                functions: localResult.changedFunctions
                            });
                        }
                    } else {
                        // No structural changes - clear any existing indicators
                        const existingTimer = activelyEditingFiles.get(filePath);
                        if (existingTimer) {
                            clearTimeout(existingTimer.timer);
                            activelyEditingFiles.delete(filePath);
                        }
                        changedFiles.delete(filePath);
                        webview.notifyFileStateChange([{ filePath, state: 'unchanged' }]);
                    }
                } else {
                    // Fall back to full LLM analysis
                    log(`Falling back to full analysis: ${filePath}`);
                    webview.showLoading('Detecting changes...');
                    await analyzeAndUpdateSingleFile(uri);

                    // Clear file change indicator after LLM analysis
                    changedFiles.delete(filePath);
                    webview.notifyFileStateChange([{ filePath, state: 'unchanged' }]);
                }
            }
        }, DEBOUNCE_MS);

        pendingChanges.set(filePath, timeout);
    };

    // File watcher for changes
    fileWatcher.onDidChange(async (uri) => {
        await scheduleFileAnalysis(uri, 'watcher');
    });
    fileWatcher.onDidCreate(async (uri) => {
        await scheduleFileAnalysis(uri, 'create');
    });
    context.subscriptions.push(fileWatcher);

    // Document save handler (more reliable than file watcher)
    context.subscriptions.push(
        vscode.workspace.onDidSaveTextDocument(async (document) => {
            await scheduleFileAnalysis(document.uri, 'save');
        })
    );

    // Register code modification command for Copilot integration
    const { CodeModifier } = require('./copilot/code-modifier');
    const codeModifier = new CodeModifier();

    context.subscriptions.push(
        vscode.commands.registerCommand('codag.applyCodeModification', async (modification: {
            type: 'insert' | 'modify',
            file: string,
            line: number,
            code: string,
            language: string
        }) => {
            try {
                let success = false;

                if (modification.type === 'insert') {
                    // For insert, use the same file/line for before and after
                    success = await codeModifier.insertNodeBetween(
                        modification.file,
                        modification.line,
                        modification.file,
                        modification.line + 10, // Estimate
                        modification.code,
                        `Code inserted via @codag at line ${modification.line}`
                    );
                } else {
                    // For modify
                    success = await codeModifier.modifyNode(
                        modification.file,
                        modification.line,
                        'Node',
                        modification.code,
                        `Code modified via @codag at line ${modification.line}`
                    );
                }

                if (success) {
                    // After successful modification, invalidate cache and re-analyze
                    await cache.invalidateFile(modification.file);
                    const uri = vscode.Uri.file(modification.file);
                    await analyzeAndUpdateSingleFile(uri);
                }
            } catch (error: any) {
                vscode.window.showErrorMessage(`Failed to apply modification: ${error.message}`);
            }
        })
    );

    // Register command to focus on a specific node (for clickable links from Copilot)
    context.subscriptions.push(
        vscode.commands.registerCommand('codag.focusNode', (nodeId: string, nodeLabel?: string) => {
            log(`Focusing on node: ${nodeId} (${nodeLabel || 'unknown'})`);
            webview.focusNode(nodeId);
        })
    );

    // Register command to focus on a specific workflow (for clickable links from Copilot)
    context.subscriptions.push(
        vscode.commands.registerCommand('codag.focusWorkflow', (workflowName: string) => {
            log(`Focusing on workflow: ${workflowName}`);
            webview.focusWorkflow(workflowName);
        })
    );

    log('Extension activated successfully');

    async function analyzeCurrentFile(bypassCache: boolean = false) {
        const editor = vscode.window.activeTextEditor;
        if (!editor) {
            webview.notifyWarning('No active file. Open a file to analyze.');
            return;
        }

        const document = editor.document;
        const content = document.getText();
        const filePath = document.uri.fsPath;

        log(`Visualizing file: ${filePath}${bypassCache ? ' (bypassing cache)' : ''}`);

        if (!WorkflowDetector.isWorkflowFile(document.uri)) {
            webview.notifyWarning('File type not supported. Open a Python or TypeScript file.');
            log(`File type not supported: ${filePath}`);
            return;
        }

        try {
            let graph;

            // Check cache only if not bypassing
            if (!bypassCache) {
                const hash = cache.hashContentAST(content, filePath);
                if (cache.isFileValid(filePath, hash)) {
                    graph = await cache.getMergedGraph([filePath]);
                }
            }

            if (!graph) {
                webview.notifyAnalysisStarted();

                // Track analysis start time
                const startTime = Date.now();

                // Build metadata using static analysis
                log(`Building metadata with static analysis...`);
                const metadata = await metadataBuilder.buildSingleFileMetadata(document.uri);
                log(`Found ${metadata.locations.length} code locations`);

                const framework = WorkflowDetector.detectFramework(content);
                log(`Detected framework: ${framework || 'none'}`);

                const relativePath = vscode.workspace.asRelativePath(filePath);
                const sizeKb = Math.round(content.length / 1024);
                const inputTokens = estimateTokens(content);
                log(`File: ${relativePath} (${sizeKb} KB, ~${Math.round(inputTokens / 1000)}k tokens)`);
                log(`Sending POST /analyze: 1 file, framework: ${framework || 'none'}`);

                const costAggregator = new CostAggregator();
                costAggregator.start();

                const result = await api.analyzeWorkflow(content, [filePath], framework || undefined, [metadata]);
                graph = result.graph;
                if (result.remainingAnalyses >= 0) {
                    await auth.updateRemainingAnalyses(result.remainingAnalyses);
                }

                // Track actual cost from API
                costAggregator.add('analyze', 1, result.usage, result.cost);

                // Only cache if not in bypass mode
                if (!bypassCache) {
                    await cache.setAnalysisResult(graph, { [filePath]: content });
                }

                // Calculate and log duration
                const duration = Date.now() - startTime;
                const minutes = Math.floor(duration / 60000);
                const seconds = Math.floor((duration % 60000) / 1000);
                const timeStr = minutes > 0 ? `${minutes} minute${minutes !== 1 ? 's' : ''} ${seconds} second${seconds !== 1 ? 's' : ''}` : `${seconds} second${seconds !== 1 ? 's' : ''}`;
                log(`Analysis complete in ${timeStr}${bypassCache ? ' (not cached)' : ', cached result'}`);

                // Display cost report if we have actual cost data
                if (costAggregator.hasOperations()) {
                    displayCostReport(costAggregator.getReport(), log);
                }
                webview.notifyAnalysisComplete(true);
            } else {
                log(`Using cached result for ${filePath}`);
            }

            webview.show(graph);
        } catch (error: any) {
            log(`ERROR: ${error.message}`);
            log(`Status: ${error.response?.status}`);
            log(`Response: ${JSON.stringify(error.response?.data)}`);

            // Filter out VSCode internal errors (e.g., missing prompts directory)
            const errorMsg = error.response?.data?.detail || error.message;
            if (errorMsg.includes('Application Support/Code/User/prompts') ||
                (error.code === 'ENOENT' && errorMsg.includes('/User/'))) {
                log(`Ignoring VSCode internal error: ${errorMsg}`);
                return;
            }

            webview.notifyAnalysisComplete(false, errorMsg);
        }
    }

    context.subscriptions.push(
        vscode.commands.registerCommand('codag.refresh', async () => {
            // Confirm before clearing cache
            const confirm = await vscode.window.showWarningMessage(
                'This will clear all cached analysis and reanalyze the entire workspace. Continue?',
                { modal: true },
                'Yes',
                'No'
            );

            if (confirm === 'Yes') {
                log('Clearing cache...');
                analysisSession++;  // Invalidate any pending analysis results
                metadataBatcher.cancel();  // Cancel pending metadata requests
                await cache.clear();
                log('Cache cleared successfully, reanalyzing workspace');
                await analyzeWorkspace(true);
            }
        })
    );

    // Clear cache for specific files and reanalyze them
    context.subscriptions.push(
        vscode.commands.registerCommand('codag.clearCacheAndReanalyze', async (paths: string[]) => {
            if (!paths || paths.length === 0) {
                vscode.window.showWarningMessage('No files selected to clear cache.');
                return;
            }

            log(`Clearing cache for ${paths.length} selected files...`);
            analysisSession++;  // Invalidate any pending analysis results
            metadataBatcher.cancel();  // Cancel pending metadata requests

            // Invalidate cache for each selected file
            for (const filePath of paths) {
                await cache.invalidateFile(filePath);
                log(`  Cleared: ${vscode.workspace.asRelativePath(filePath)}`);
            }

            log('Cache cleared, reanalyzing selected files...');

            // Save selection and analyze directly
            const allSourceFiles = await WorkflowDetector.getAllSourceFiles();
            await saveFilePickerSelection(context, allSourceFiles, paths);

            // Analyze selected files with bypassCache=true to force fresh analysis
            await analyzeSelectedFiles(paths, true);
        })
    );

    async function analyzeSelectedFiles(selectedPaths: string[], bypassCache: boolean = false) {
        const startTime = Date.now();
        const sessionAtStart = analysisSession;  // Capture session to detect invalidation

        try {
            webview.showLoading('Analyzing selected files...');

            // Read file contents
            const fileContents: { path: string; content: string }[] = [];
            for (const filePath of selectedPaths) {
                try {
                    const content = await vscode.workspace.fs.readFile(vscode.Uri.file(filePath));
                    fileContents.push({
                        path: filePath,
                        content: Buffer.from(content).toString('utf8')
                    });
                } catch (error) {
                    console.warn(`⚠️  Skipping file (read error): ${filePath}`, error);
                }
            }

            if (fileContents.length === 0) {
                webview.notifyWarning('No valid files to analyze.');
                return;
            }

            log(`Analyzing ${fileContents.length} files...`);

            // Extract HTTP connections for cross-service edge detection
            const rawHttpStructure = extractRepoStructure(fileContents);
            const httpConnectionsContext = formatHttpConnectionsForPrompt(rawHttpStructure);
            if (rawHttpStructure.httpConnections.length > 0) {
                log(`Found ${rawHttpStructure.httpConnections.length} HTTP connection(s)`);
            }

            // Build metadata
            const uncachedUris = fileContents.map(f => vscode.Uri.file(f.path));
            const metadata = await metadataBuilder.buildMetadata(uncachedUris);

            // Detect framework/services
            let framework: string | null = null;
            const allServices = new Set<string>();
            for (const file of fileContents) {
                if (!framework) {
                    framework = WorkflowDetector.detectFramework(file.content);
                }
                const services = WorkflowDetector.detectAllAIServices(file.content);
                services.forEach(s => allServices.add(s));
            }

            if (allServices.size > 0) {
                log(`Detected AI services: ${Array.from(allServices).join(', ')}`);
            }

            // Create batches
            const batches = createDependencyBatches(fileContents, metadata, CONFIG.BATCH.MAX_SIZE, CONFIG.BATCH.MAX_TOKENS);
            log(`Created ${batches.length} batch${batches.length > 1 ? 'es' : ''} for ${fileContents.length} files`);

            webview.notifyAnalysisStarted();
            webview.updateProgress(0, batches.length);

            const maxConcurrency = CONFIG.CONCURRENCY.MAX_PARALLEL;
            const newGraphs: any[] = [];
            let totalInputTokens = 0;
            let totalOutputTokens = 0;

            // Analyze batches
            for (let i = 0; i < batches.length; i += maxConcurrency) {
                const batchSlice = batches.slice(i, i + maxConcurrency);

                const batchPromises = batchSlice.map(async (batch, sliceIndex) => {
                    const batchIndex = i + sliceIndex;
                    const batchMetadata = metadata.filter(m =>
                        batch.some(f => f.path === m.file)
                    );
                    const combinedCode = combineFilesXML(batch, batchMetadata);
                    const batchTokens = estimateTokens(combinedCode);

                    log(`Analyzing batch ${batchIndex + 1}/${batches.length} (${batch.length} files, ~${Math.round(batchTokens / 1000)}k tokens)...`);
                    // DEBUG: Log files being sent to LLM
                    console.log(`[DEBUG] Batch ${batchIndex + 1} files:`, batch.map(f => f.path));

                    try {
                        const analyzeResult = await api.analyzeWorkflow(
                            combinedCode,
                            batch.map(f => f.path),
                            framework || undefined,
                            batchMetadata,
                            undefined,  // condensedStructure
                            httpConnectionsContext
                        );

                        // Check if session was invalidated (cache cleared) during request
                        if (analysisSession !== sessionAtStart) {
                            log(`Batch ${batchIndex + 1} result discarded (session invalidated)`);
                            return null;
                        }

                        const graph = analyzeResult.graph;
                        if (analyzeResult.remainingAnalyses >= 0) {
                            await auth.updateRemainingAnalyses(analyzeResult.remainingAnalyses);
                        }

                        if (graph && graph.nodes) {
                            newGraphs.push(graph);
                            // DEBUG: Log nodes returned per file
                            const nodesByFile = new Map<string, number>();
                            for (const node of graph.nodes) {
                                const file = node.source?.file || 'unknown';
                                nodesByFile.set(file, (nodesByFile.get(file) || 0) + 1);
                            }
                            console.log(`[DEBUG] Batch ${batchIndex + 1} nodes by file:`, Object.fromEntries(nodesByFile));

                            // Cache per-file (only successful results get cached)
                            const contentMap: Record<string, string> = {};
                            for (const f of batch) contentMap[f.path] = f.content;
                            await cache.setAnalysisResult(graph, contentMap);

                            // Track tokens
                            totalInputTokens += batchTokens;
                            totalOutputTokens += estimateTokens(JSON.stringify(graph));

                            log(`✓ Batch ${batchIndex + 1} complete: ${graph.nodes.length} nodes`);

                            // Incremental graph update - only if THIS batch added nodes
                            if (graph.nodes.length > 0) {
                                try {
                                    const currentMerged = await cache.getMergedGraph();
                                    if (currentMerged && currentMerged.nodes.length > 0) {
                                        webview.updateGraph(currentMerged);
                                    }
                                } catch (updateError: any) {
                                    log(`Warning: Incremental update failed: ${updateError.message}`);
                                }
                            }
                        } else {
                            // DEBUG: Log when no nodes returned
                            console.log(`[DEBUG] Batch ${batchIndex + 1} returned NO nodes. Files were:`, batch.map(f => f.path));
                        }

                        webview.updateProgress(batchIndex + 1, batches.length);
                        return graph;
                    } catch (error: any) {
                        log(`Batch ${batchIndex + 1} failed: ${error.message}`);
                        // Don't throw - let other batches continue
                        return null;
                    }
                });

                await Promise.all(batchPromises);
            }

            // Check if session was invalidated before displaying
            if (analysisSession !== sessionAtStart) {
                log('Analysis results discarded (session invalidated)');
                return;
            }

            // Merge and display results from cache (only successful results are cached)
            // HTTP connections are now included in LLM prompt, so edges come from analysis results
            // Pass selectedPaths to only include analyzed files, not all cached files
            const mergedGraph = await cache.getMergedGraph(selectedPaths);

            if (mergedGraph && mergedGraph.nodes.length > 0) {
                webview.show(mergedGraph);
                const elapsed = ((Date.now() - startTime) / 1000).toFixed(1);
                log(`✓ Analysis complete in ${elapsed}s: ${mergedGraph.nodes.length} nodes, ${mergedGraph.edges.length} edges`);
                const totalTokens = totalInputTokens + totalOutputTokens;
                const totalCost = calculateCost(totalInputTokens, totalOutputTokens);
                log(`  Tokens: ~${Math.round(totalInputTokens / 1000)}k input, ~${Math.round(totalOutputTokens / 1000)}k output (~${Math.round(totalTokens / 1000)}k total)`);
                log(`  Est. cost: ${formatCost(totalCost)} (Gemini 2.5 Flash)`);
                webview.notifyAnalysisComplete(true);
            } else {
                webview.notifyWarning('No workflow data found in selected files.');
            }
        } catch (error: any) {
            log(`Analysis failed: ${error.message}`);
            webview.notifyAnalysisComplete(false, error.message);
        }
    }

    async function analyzeWorkspace(bypassCache: boolean = false) {
        // Track analysis start time
        const startTime = Date.now();
        const sessionAtStart = analysisSession;  // Capture session to detect invalidation

        // Pipeline stats tracking - shows what gets filtered at each stage
        const pipelineStats = {
            detected: { llmFiles: 0, httpFiles: 0, httpClientFilesAdded: 0 },
            cached: { filesFromCache: 0, filesNeedAnalysis: 0 },
            analyzed: { filesSentToLLM: 0, httpConnections: 0 },
            results: { filesWithNodes: 0, filesWithNoWorkflow: 0, totalNodes: 0 },
            edges: { llmGenerated: 0, resolved: 0, orphaned: 0 }
        };

        log('Starting workspace scan...');
        log(`Workspace root: ${vscode.workspace.workspaceFolders?.[0]?.uri.fsPath}`);
        if (bypassCache) {
            log('⚠️  BYPASS MODE: Cache reading/writing disabled for this analysis');
        }

        try {
            // Show panel immediately (don't block on file detection)
            webview.showLoading('Scanning workspace...');

            const workflowFiles = await WorkflowDetector.detectInWorkspace();
            pipelineStats.detected.llmFiles = workflowFiles.length;
            log(`Found ${workflowFiles.length} workflow files (LLM import patterns)`);

            if (workflowFiles.length === 0) {
                webview.notifyWarning('No AI workflow files found. Open a folder with LLM API calls.');
                return;
            }

            // Prune stale cache entries for files that no longer exist
            const existingFilePaths = workflowFiles.map(uri => uri.fsPath);
            const pruned = await cache.pruneStaleEntries(existingFilePaths);
            if (pruned > 0) {
                log(`Pruned ${pruned} stale cache entries`);
            }

            // Read ALL workflow files first to check cache
            const allFileContents: { path: string; content: string; }[] = [];
            for (const uri of workflowFiles) {
                try {
                    const content = await vscode.workspace.fs.readFile(uri);
                    const text = Buffer.from(content).toString('utf8');
                    allFileContents.push({
                        path: uri.fsPath,
                        content: text
                    });
                } catch (error) {
                    console.warn(`⚠️  Skipping file (read error): ${uri.fsPath}`, error);
                }
            }

            // Extract HTTP connections from ALL source files (not just LLM files)
            // This enables cross-service workflow detection (e.g., frontend api.ts → backend main.py)
            log(`\nScanning all source files for HTTP connections...`);
            const httpScanSourceFiles = await WorkflowDetector.getAllSourceFiles();
            const httpSourceContents: { path: string; content: string }[] = [];

            // Only read files that aren't already in allFileContents (avoid duplicate reads)
            const workflowPaths = new Set(allFileContents.map(f => f.path));
            for (const uri of httpScanSourceFiles) {
                if (!workflowPaths.has(uri.fsPath)) {
                    try {
                        const content = await vscode.workspace.fs.readFile(uri);
                        httpSourceContents.push({
                            path: uri.fsPath,
                            content: Buffer.from(content).toString('utf8')
                        });
                    } catch (error) {
                        // Skip files that can't be read
                    }
                }
            }

            // Combine workflow files + additional source files for HTTP extraction
            const allFilesForHttpExtraction = [...allFileContents, ...httpSourceContents];
            log(`Scanning ${allFilesForHttpExtraction.length} files (${allFileContents.length} LLM + ${httpSourceContents.length} other)`);

            const rawHttpStructure = extractRepoStructure(allFilesForHttpExtraction);
            const allHttpConnections = rawHttpStructure.httpConnections;
            pipelineStats.analyzed.httpConnections = allHttpConnections.length;
            pipelineStats.detected.httpFiles = httpSourceContents.length;
            // Format HTTP connections for inclusion in LLM prompt
            const httpConnectionsContext = formatHttpConnectionsForPrompt(rawHttpStructure);
            if (allHttpConnections.length > 0) {
                log(`Found ${allHttpConnections.length} HTTP connection(s) between services:`);
                for (const conn of allHttpConnections) {
                    log(`  ${vscode.workspace.asRelativePath(conn.client.file)}::${conn.client.function} → ${vscode.workspace.asRelativePath(conn.handler.file)}::${conn.handler.function}`);
                    log(`    (${conn.client.method} ${conn.client.normalizedPath})`);
                }
            } else {
                log(`No HTTP connections detected`);
            }

            // Use call graph tracing to find HTTP handlers connected to LLM calls
            // This is more general than pattern matching - it traces imports and function calls
            const allHttpHandlers = new Set<string>();
            for (const conn of allHttpConnections) {
                if (!workflowPaths.has(conn.handler.file)) {
                    allHttpHandlers.add(conn.handler.file);
                }
            }

            // Trace call graph from all HTTP handlers to find which ones lead to LLM calls
            const llmConnectedHandlers = traceCallGraphToLLM(rawHttpStructure, allHttpHandlers);

            // Now determine which HTTP connections involve LLM-connected handlers
            log(`\n[DEBUG] LLM-connected handlers: ${[...llmConnectedHandlers].map(f => vscode.workspace.asRelativePath(f)).join(', ')}`);
            log(`[DEBUG] Processing ${allHttpConnections.length} HTTP connections...`);

            const httpClientFilesToAdd = new Set<string>();
            const httpHandlerFilesToAdd = new Set<string>();
            for (const conn of allHttpConnections) {
                // Check if this handler is connected to LLM calls via call graph
                const handlerConnectedToLLM = llmConnectedHandlers.has(conn.handler.file) ||
                    // Also check if handler file itself has LLM calls
                    rawHttpStructure.files.find(f => f.path === conn.handler.file)?.functions.some(f => f.hasLLMCall);

                log(`[DEBUG]   ${vscode.workspace.asRelativePath(conn.client.file)}::${conn.client.function} -> ${vscode.workspace.asRelativePath(conn.handler.file)}::${conn.handler.function} (${conn.client.method} ${conn.client.normalizedPath}) - LLM connected: ${handlerConnectedToLLM}`);

                if (handlerConnectedToLLM) {
                    if (!workflowPaths.has(conn.client.file)) {
                        httpClientFilesToAdd.add(conn.client.file);
                    }
                    if (!workflowPaths.has(conn.handler.file)) {
                        httpHandlerFilesToAdd.add(conn.handler.file);
                    }
                }
            }

            // Add HTTP client files (frontend files that call LLM-connected handlers)
            if (httpClientFilesToAdd.size > 0) {
                pipelineStats.detected.httpClientFilesAdded = httpClientFilesToAdd.size;
                log(`\nAdding ${httpClientFilesToAdd.size} HTTP client file(s) to analysis:`);
                log(`[DEBUG] httpSourceContents has ${httpSourceContents.length} files`);
                for (const clientFile of httpClientFilesToAdd) {
                    log(`  + ${vscode.workspace.asRelativePath(clientFile)}`);
                    const found = httpSourceContents.find(f => f.path === clientFile);
                    if (found) {
                        allFileContents.push(found);
                        workflowPaths.add(clientFile);
                        log(`    [DEBUG] Found in httpSourceContents, added to allFileContents`);
                    } else {
                        log(`    [DEBUG] ⚠️  NOT found in httpSourceContents! Looking for: ${clientFile}`);
                        log(`    [DEBUG] httpSourceContents paths sample: ${httpSourceContents.slice(0, 3).map(f => f.path).join(', ')}`);
                    }
                }
            }

            // Add HTTP handler files and their LLM-connected dependencies
            if (httpHandlerFilesToAdd.size > 0) {
                log(`\nAdding ${httpHandlerFilesToAdd.size} HTTP handler file(s) to analysis:`);
                for (const handlerFile of httpHandlerFilesToAdd) {
                    log(`  + ${vscode.workspace.asRelativePath(handlerFile)}`);
                    const found = httpSourceContents.find(f => f.path === handlerFile);
                    if (found) {
                        allFileContents.push(found);
                        workflowPaths.add(handlerFile);
                    }
                }

                // Use call graph tracing to find all files connected to LLM calls
                // This follows imports and function calls from HTTP handlers to find the full workflow chain
                const llmConnectedFiles = traceCallGraphToLLM(rawHttpStructure, httpHandlerFilesToAdd);

                const llmFilesToAdd: string[] = [];
                for (const llmFile of llmConnectedFiles) {
                    if (!workflowPaths.has(llmFile)) {
                        llmFilesToAdd.push(llmFile);
                    }
                }

                if (llmFilesToAdd.length > 0) {
                    log(`\nAdding ${llmFilesToAdd.length} LLM file(s) via call graph tracing:`);
                    for (const llmFile of llmFilesToAdd) {
                        log(`  + ${vscode.workspace.asRelativePath(llmFile)}`);
                        const found = httpSourceContents.find(f => f.path === llmFile);
                        if (found) {
                            allFileContents.push(found);
                            workflowPaths.add(llmFile);
                        }
                    }
                }
            }

            // Check cache for ALL files before showing file picker
            let hasCachedData = false;
            if (!bypassCache) {
                log(`\nChecking cache for ${allFileContents.length} files...`);
                try {
                    const allPaths = allFileContents.map(f => f.path);
                    const allContents = allFileContents.map(f => f.content);
                    const cacheResult = await cache.checkFiles(allPaths, allContents);
                    hasCachedData = cacheResult.cached.length > 0;
                    if (hasCachedData) {
                        log(`✓ Found ${cacheResult.cached.length} cached file(s)`);
                    } else {
                        log(`No cached files found (${cacheResult.uncached.length} files uncached)`);
                    }
                } catch (cacheError: any) {
                    log(`⚠️  Cache check failed: ${cacheError.message}`);
                }
            }

            // Check if this is a subsequent run (has cached data)
            const isFirstRun = !hasCachedData;

            if (!isFirstRun) {
                // SUBSEQUENT RUN: Silent background analysis
                const savedSelection = getSavedSelectedPaths(context);

                if (savedSelection.length > 0) {
                    log(`\nSubsequent run detected - performing silent background analysis`);
                    log(`Using ${savedSelection.length} previously selected files`);

                    // Filter to previously selected files that are still workflow files
                    const selectedFiles = workflowFiles.filter(f => savedSelection.includes(f.fsPath));
                    const fileContents = allFileContents.filter(f => savedSelection.includes(f.path));

                    if (fileContents.length === 0) {
                        log(`No selected files found in current workflow files, showing picker`);
                    } else {
                        // Check cache for selected files
                        const cacheResult = await cache.checkFiles(
                            fileContents.map(f => f.path),
                            fileContents.map(f => f.content)
                        );

                        const uncachedCount = cacheResult.uncached.length;
                        log(`Cache result: ${cacheResult.cached.length} cached, ${uncachedCount} uncached`);
                        const newGraphs: any[] = [];

                        if (uncachedCount === 0) {
                            // All files up to date - show cached graph
                            log(`✓ All ${fileContents.length} files up to date`);
                            const selectedPaths = fileContents.map(f => f.path);
                            const mergedGraph = await cache.getMergedGraph(selectedPaths);
                            webview.show(mergedGraph!);
                            return;
                        }

                        // Analyze changed files in background
                        log(`Found ${uncachedCount} files needing analysis:`);
                        cacheResult.uncached.forEach(f => {
                            log(`  - ${vscode.workspace.asRelativePath(f.path)}`);
                        });

                        // Show cached graphs immediately while analyzing
                        const allCached = await cache.getMergedGraph();
                        if (allCached && allCached.nodes.length > 0) {
                            log(`Showing ${allCached.nodes.length} cached nodes while analyzing ${uncachedCount} more...`);
                            webview.show(allCached, { loading: true });
                        } else {
                            log(`No cached graphs to show, showing loading...`);
                            webview.showLoading(`Analyzing ${uncachedCount} file${uncachedCount !== 1 ? 's' : ''}...`);
                        }

                        const filesToAnalyze = cacheResult.uncached;
                        const uncachedUris = filesToAnalyze.map(f => vscode.Uri.file(f.path));
                        const metadata = await metadataBuilder.buildMetadata(uncachedUris);

                        // Create batches (same as initial analysis)
                        const batches = createDependencyBatches(filesToAnalyze, metadata, CONFIG.BATCH.MAX_SIZE, CONFIG.BATCH.MAX_TOKENS);
                        log(`Created ${batches.length} batch${batches.length > 1 ? 'es' : ''} for ${filesToAnalyze.length} files`);

                        // Detect framework
                        let framework: string | null = null;
                        for (const file of filesToAnalyze) {
                            framework = WorkflowDetector.detectFramework(file.content);
                            if (framework) break;
                        }

                        webview.notifyAnalysisStarted();
                        webview.updateProgress(0, batches.length);

                        const maxConcurrency = CONFIG.CONCURRENCY.MAX_PARALLEL;
                        const costAggregator = new CostAggregator();
                        costAggregator.start();

                        // Process batches with concurrency limiting
                        for (let i = 0; i < batches.length; i += maxConcurrency) {
                            const batchSlice = batches.slice(i, i + maxConcurrency);

                            const batchPromises = batchSlice.map(async (batch, sliceIndex) => {
                                const batchIndex = i + sliceIndex;
                                const batchPaths = batch.map(f => f.path);
                                const batchMetadata = metadata.filter(m => batchPaths.includes(m.file));
                                const combinedCode = combineFilesXML(batch, batchMetadata);
                                const batchInputTokens = estimateTokens(combinedCode);

                                log(`Analyzing batch ${batchIndex + 1}/${batches.length} (${batch.length} files, ~${Math.round(batchInputTokens / 1000)}k tokens)...`);

                                try {
                                    const analyzeResult = await api.analyzeWorkflow(
                                        combinedCode,
                                        batchPaths,
                                        framework || undefined,
                                        batchMetadata,
                                        undefined,  // condensedStructure
                                        httpConnectionsContext
                                    );

                                    // Check if session was invalidated (cache cleared) during request
                                    if (analysisSession !== sessionAtStart) {
                                        log(`Batch ${batchIndex + 1} result discarded (session invalidated)`);
                                        return null;
                                    }

                                    const graph = analyzeResult.graph;
                                    if (analyzeResult.remainingAnalyses >= 0) {
                                        await auth.updateRemainingAnalyses(analyzeResult.remainingAnalyses);
                                    }

                                    // Track actual cost from API
                                    costAggregator.add('analyze', batch.length, analyzeResult.usage, analyzeResult.cost, batchIndex);

                                    newGraphs.push(graph);

                                    // Cache per-file
                                    const contentMap: Record<string, string> = {};
                                    for (const f of batch) contentMap[f.path] = f.content;
                                    await cache.setAnalysisResult(graph, contentMap);

                                    // Incremental graph update - only if THIS batch added nodes
                                    if (graph.nodes.length > 0) {
                                        try {
                                            const currentMerged = await cache.getMergedGraph();
                                            if (currentMerged && currentMerged.nodes.length > 0) {
                                                webview.updateGraph(currentMerged);
                                            }
                                        } catch (updateError: any) {
                                            log(`Warning: Incremental update failed: ${updateError.message}`);
                                        }
                                    }

                                    // Update progress bar
                                    webview.updateProgress(batchIndex + 1, batches.length);

                                    log(`✓ Batch ${batchIndex + 1} complete: ${graph.nodes.length} nodes`);
                                    return graph;
                                } catch (error: any) {
                                    // Re-throw trial exhaustion, log others
                                    if (error instanceof TrialExhaustedError) {
                                        throw error;
                                    }
                                    log(`Batch ${batchIndex + 1} failed: ${error.message}`);
                                    return null; // Don't throw - let other batches continue
                                }
                            });

                            try {
                                await Promise.all(batchPromises);
                            } catch (error: any) {
                                // Handle trial quota exhaustion - store task for retry after login
                                if (error instanceof TrialExhaustedError) {
                                    log('[auth] Trial quota exhausted during subsequent run, storing pending task...');
                                    pendingAnalysisTask = () => analyzeWorkspace(false);
                                    webview.showAuthPanel();
                                    return;
                                }
                                log(`Analysis failed: ${error.message}`);
                                webview.notifyAnalysisComplete(false, error.message);
                                return;
                            }
                        }

                        // Check if session was invalidated before displaying
                        if (analysisSession !== sessionAtStart) {
                            log('Analysis results discarded (session invalidated)');
                            return;
                        }

                        log(`✓ Analysis complete: ${newGraphs.reduce((sum, g) => sum + g.nodes.length, 0)} nodes total`);

                        // Display detailed cost report with actual API usage
                        if (costAggregator.hasOperations()) {
                            displayCostReport(costAggregator.getReport(), log);
                        }

                        // Update graph ONCE after all batches complete (avoids flickering)
                        const allSelectedPaths = fileContents.map(f => f.path);
                        const finalMerged = await cache.getMergedGraph(allSelectedPaths);
                        if (finalMerged) {
                            webview.updateGraph(finalMerged);
                        }

                        webview.notifyAnalysisComplete(true);
                        return;
                    }
                }
            }

            // FIRST RUN: Show file picker
            // If we have cached data, show it BEFORE the file picker
            if (hasCachedData) {
                const cachedGraph = await cache.getMergedGraph();
                if (cachedGraph) {
                    webview.show(cachedGraph);
                    log(`✓ Displayed cached graph behind file picker`);
                }
            }

            // Get ALL source files for the picker (shows all files, not just LLM)
            const allSourceFiles = await WorkflowDetector.getAllSourceFiles();

            // Build file tree with all source files
            const { tree, totalFiles } = buildFileTree(allSourceFiles, context);

            // Show file picker immediately
            const selectedPaths = await webview.showFilePicker(tree, totalFiles);
            if (!selectedPaths || selectedPaths.length === 0) {
                webview.notifyWarning('No files selected for analysis.');
                return;
            }

            // Save selection to cache
            await saveFilePickerSelection(context, allSourceFiles, selectedPaths);

            // Filter to selected files only
            const selectedFiles = workflowFiles.filter(f => selectedPaths.includes(f.fsPath));
            const fileContents = allFileContents.filter(f => selectedPaths.includes(f.path));

            log(`User selected ${selectedFiles.length} of ${workflowFiles.length} files for analysis`);
            for (const f of fileContents) {
                const relativePath = vscode.workspace.asRelativePath(f.path);
                log(`  - ${relativePath}`);
            }

            const allPaths = fileContents.map(f => f.path);
            const allContents = fileContents.map(f => f.content);

            // Check cache for SELECTED files (unless bypassing)
            let cachedPaths: string[] = [];
            let filesToAnalyze = fileContents;

            if (!bypassCache) {
                log(`\nChecking cache for ${selectedFiles.length} selected files...`);
                try {
                    const cacheResult = await cache.checkFiles(allPaths, allContents);
                    cachedPaths = cacheResult.cached.map(f => f.path);
                    filesToAnalyze = cacheResult.uncached;

                    const cachedCount = cacheResult.cached.length;
                    const uncachedCount = filesToAnalyze.length;

                    if (cachedCount > 0) {
                        log(`✓ Cache HIT: ${cachedCount} file(s) cached`);
                    }
                    if (uncachedCount > 0) {
                        log(`✗ Cache MISS: ${uncachedCount} file${uncachedCount !== 1 ? 's' : ''} need analysis`);
                    }
                } catch (cacheError: any) {
                    log(`⚠️  Cache check failed: ${cacheError.message}, proceeding with full analysis`);
                    console.warn('Cache check error:', cacheError);
                }
            } else {
                log(`\nBypassing cache, analyzing all ${selectedFiles.length} files`);
            }

            // Show cached graphs for selected files (closes file picker and displays)
            if (cachedPaths.length > 0) {
                const cachedGraph = await cache.getMergedGraph(cachedPaths);
                if (cachedGraph) {
                    webview.initGraph(cachedGraph);
                    log(`✓ Displayed cached graph (${cachedGraph.nodes.length} nodes, ${cachedGraph.edges.length} edges)`);
                }
            } else {
                // For fresh repos with no cached graphs, close file picker immediately
                // so the loading indicator is visible during analysis
                webview.closeFilePicker();
            }

            // Store newly analyzed graphs
            const newGraphs: any[] = [];

            // HTTP connections already extracted earlier from ALL source files (allHttpConnections)

            if (filesToAnalyze.length > 0) {
                    // Analyze uncached files in batches
                    webview.notifyAnalysisStarted();

                    // Build metadata only for uncached files
                    const uncachedUris = filesToAnalyze.map(f => vscode.Uri.file(f.path));
                    log(`\nBuilding metadata for ${filesToAnalyze.length} uncached files...`);
                    const metadata = await metadataBuilder.buildMetadata(uncachedUris);
                    const totalLocations = metadata.reduce((sum, m) => sum + m.locations.length, 0);
                    log(`Found ${totalLocations} code locations`);

                    // Create dependency-based batches with token limits (only for uncached files)
                    const batches = createDependencyBatches(filesToAnalyze, metadata, CONFIG.BATCH.MAX_SIZE, CONFIG.BATCH.MAX_TOKENS);

                    // Track costs for this analysis run
                    const costAggregator = new CostAggregator();
                    costAggregator.start();

                    // Condense structure for cross-batch context (only if multiple batches)
                    // Note: This uses just the selected LLM files, not all source files
                    // HTTP connections are included in the LLM prompt via httpConnectionsContext
                    let condensedStructure: string | undefined;
                    if (batches.length > 1) {
                        const rawStructure = extractRepoStructure(fileContents);
                        const structureJson = formatStructureForLLM(rawStructure);
                        log(`Raw structure: ${rawStructure.files.length} files, ${structureJson.length} chars`);

                        try {
                            log(`Condensing structure via LLM...`);
                            const condenseResult = await api.condenseStructure(structureJson);
                            condensedStructure = condenseResult.condensed_structure;
                            costAggregator.add('condense', filesToAnalyze.length, condenseResult.usage, condenseResult.cost);
                            log(`Condensed structure: ${condensedStructure.length} chars`);
                        } catch (condenseError: any) {
                            log(`⚠️  Structure condensation failed: ${condenseError.message}`);
                            // Continue without cross-batch context
                        }
                    }

                    // Calculate and log token info
                    const totalTokens = filesToAnalyze.reduce((sum, f) => sum + estimateTokens(f.content), 0);
                    log(`\nTotal tokens: ~${Math.round(totalTokens / 1000)}k (limit: ${CONFIG.BATCH.MAX_TOKENS / 1000}k per batch)`);
                    log(`Created ${batches.length} batch${batches.length > 1 ? 'es' : ''} based on file dependencies:`);

                    for (let i = 0; i < batches.length; i++) {
                        const batchTokens = batches[i].reduce((sum, f) => sum + estimateTokens(f.content), 0);
                        const utilization = Math.round((batchTokens / CONFIG.BATCH.MAX_TOKENS) * 100);
                        const warning = utilization > 80 ? ' ⚠️ HIGH' : '';
                        log(`  Batch ${i + 1}: ${batches[i].length} files (~${Math.round(batchTokens / 1000)}k tokens, ${utilization}% of limit${warning})`);
                    }

                    // Update progress with correct batch total
                    webview.updateProgress(0, batches.length);

                    // Detect all AI services from uncached files
                    let framework: string | null = null;
                    const allServices = new Set<string>();
                    for (const file of filesToAnalyze) {
                        if (!framework) {
                            framework = WorkflowDetector.detectFramework(file.content);
                        }
                        // Collect all AI services across all files
                        const services = WorkflowDetector.detectAllAIServices(file.content);
                        services.forEach(s => allServices.add(s));
                    }

                    if (allServices.size > 0) {
                        log(`Detected AI services: ${Array.from(allServices).join(', ')}`);
                    } else {
                        log(`Detected framework: ${framework || 'generic LLM usage'}`)
                    }

                    // Analyze batches in parallel (limit concurrency to avoid rate limits)
                    const maxConcurrency = CONFIG.CONCURRENCY.MAX_PARALLEL;
                    let totalInputTokens = 0;
                    let totalOutputTokens = 0;

                    // Helper to cache batch immediately after it completes
                    async function cacheBatchGraph(
                        files: { path: string; content: string }[],
                        graph: WorkflowGraph
                    ) {
                        if (!bypassCache) {
                            const contentMap: Record<string, string> = {};
                            for (const f of files) contentMap[f.path] = f.content;
                            await cache.setAnalysisResult(graph, contentMap);
                        }
                    }

                    // Track completed batches for incremental updates
                    let completedBatchCount = 0;

                    // Process batches in chunks of maxConcurrency with incremental graph updates
                    for (let chunkStart = 0; chunkStart < batches.length; chunkStart += maxConcurrency) {
                        const chunkEnd = Math.min(chunkStart + maxConcurrency, batches.length);
                        const batchChunk = batches.slice(chunkStart, chunkEnd);

                        // Process this chunk in parallel, update progress as each completes
                        const chunkPromises = batchChunk.map((batch, chunkIdx) => {
                            const batchIndex = chunkStart + chunkIdx;
                            return analyzeBatch(batch, batchIndex, batches.length, metadata, cache, newGraphs, costAggregator, condensedStructure, httpConnectionsContext)
                                .then(async (batchGraph) => {
                                    completedBatchCount++;
                                    if (batchGraph) {
                                        // Cache per-file (only successful results get cached)
                                        await cacheBatchGraph(batch, batchGraph);
                                        log(`✓ Cached batch ${batchIndex + 1} with ${batch.length} files`);

                                        // Incremental graph update - only if THIS batch added nodes
                                        if (batchGraph.nodes.length > 0) {
                                            try {
                                                const currentMerged = await cache.getMergedGraph();
                                                if (currentMerged && currentMerged.nodes.length > 0) {
                                                    webview.updateGraph(currentMerged);
                                                }
                                            } catch (updateError: any) {
                                                log(`Warning: Incremental update failed: ${updateError.message}`);
                                            }
                                        }
                                    }
                                    // Update progress bar
                                    webview.updateProgress(completedBatchCount, batches.length);
                                    log(`✓ Progress: ${completedBatchCount}/${batches.length} batches`);
                                })
                                .catch((batchError: any) => {
                                    // Don't let individual batch failures kill the whole analysis
                                    // TrialExhaustedError is re-thrown to trigger auth flow
                                    if (batchError instanceof TrialExhaustedError) {
                                        throw batchError;
                                    }
                                    log(`⚠️ Batch ${batchIndex + 1} error: ${batchError.message}`);
                                    completedBatchCount++;
                                    webview.updateProgress(completedBatchCount, batches.length);
                                });
                        });

                        try {
                            await Promise.all(chunkPromises);
                        } catch (chunkError: any) {
                            // Only TrialExhaustedError should propagate here
                            if (chunkError instanceof TrialExhaustedError) {
                                log('[auth] Trial quota exhausted, storing pending task...');
                                pendingAnalysisTask = () => analyzeWorkspace(false);
                                webview.showAuthPanel();
                                return;
                            }
                            log(`Chunk failed: ${chunkError.message}`);
                        }
                    }

                    async function analyzeBatch(
                        batch: { path: string; content: string; }[],
                        batchIndex: number,
                        totalBatches: number,
                        allMetadata: any[],
                        cacheManager: typeof cache,
                        graphs: any[],
                        costTracker: CostAggregator,
                        condensedStructure?: string,
                        httpConnectionsContext?: string
                    ) {
                        const batchPaths = batch.map(f => f.path);
                        const batchMetadata = allMetadata.filter(m => batchPaths.includes(m.file));

                        // Detect framework for THIS batch (use first detected in batch)
                        let batchFramework: string | null = null;
                        for (const file of batch) {
                            batchFramework = WorkflowDetector.detectFramework(file.content);
                            if (batchFramework) break;
                        }

                        // Combine batch files for analysis in XML format
                        const combinedBatchCode = combineFilesXML(batch, batchMetadata);
                        const batchTokens = estimateTokens(combinedBatchCode);

                        log(`\nAnalyzing batch ${batchIndex + 1}/${totalBatches} (${batch.length} files, ~${Math.round(batchTokens / 1000)}k tokens)...`);
                        log(`Files in batch:`);
                        batch.forEach(f => {
                            const relativePath = vscode.workspace.asRelativePath(f.path);
                            const sizeKb = Math.round(f.content.length / 1024);
                            log(`  - ${relativePath} (${sizeKb} KB)`);
                        });

                        try {

                            log(`Sending POST /analyze: ${batch.length} file(s), ~${Math.round(batchTokens / 1000)}k tokens, framework: ${batchFramework || 'none'}${condensedStructure ? ', with cross-batch context' : ''}${httpConnectionsContext ? ', with HTTP connections' : ''}`);
                            const batchResult = await api.analyzeWorkflow(
                                combinedBatchCode,
                                batchPaths,
                                batchFramework || undefined,
                                batchMetadata,
                                condensedStructure,
                                httpConnectionsContext
                            );

                            // Check if session was invalidated (cache cleared) during request
                            if (analysisSession !== sessionAtStart) {
                                log(`Batch ${batchIndex + 1} result discarded (session invalidated)`);
                                return null;
                            }

                            const batchGraph = batchResult.graph;
                            if (batchResult.remainingAnalyses >= 0) {
                                await auth.updateRemainingAnalyses(batchResult.remainingAnalyses);
                            }

                            // Track actual cost from API
                            costTracker.add('analyze', batch.length, batchResult.usage, batchResult.cost, batchIndex);

                            // Track tokens for legacy logging (accumulate in outer scope)
                            totalInputTokens += batchTokens;
                            const outputTokens = estimateTokens(JSON.stringify(batchGraph));
                            totalOutputTokens += outputTokens;

                            graphs.push(batchGraph);
                            log(`Batch ${batchIndex + 1} complete: ${batchGraph.nodes.length} nodes, ${batchGraph.edges.length} edges`);

                            // Update progress
                            webview.updateProgress(batchIndex + 1, totalBatches);

                            // Return batchGraph for incremental updates
                            return batchGraph;
                        } catch (batchError: any) {
                            // Re-throw trial exhaustion so outer handler can queue retry
                            if (batchError instanceof TrialExhaustedError) {
                                throw batchError;
                            }

                            // Check if it's a file size error (HTTP 413)
                            if (batchError.response?.status === 413) {
                                const sizeErrorMsg = `Batch ${batchIndex + 1}: Files too large. Try analyzing fewer files.`;
                                log(sizeErrorMsg);
                                // Don't fallback for size errors - skip this batch
                                return null;
                            }

                            // Check if it's "No LLM workflow detected" (HTTP 400)
                            // This is a valid response meaning the code has no LLM calls - cache empty results
                            const errorDetail = batchError.response?.data?.detail || batchError.message || '';
                            if (batchError.response?.status === 400 &&
                                errorDetail.toLowerCase().includes('no llm workflow')) {
                                log(`Batch ${batchIndex + 1}: No LLM workflow detected (caching empty)`);
                                // Cache all files in batch as having 0 nodes
                                if (!bypassCache) {
                                    const contentMap: Record<string, string> = {};
                                    for (const f of batch) contentMap[f.path] = f.content;
                                    await cache.setAnalysisResult({ nodes: [], edges: [], llms_detected: [], workflows: [] }, contentMap);
                                }
                                return null;
                            }

                            // If batch fails (safety filter, etc), try analyzing files individually
                            log(`Batch ${batchIndex + 1} failed: ${batchError.message}`);
                            log(`Falling back to individual file analysis for this batch...`);

                            // Parallelize individual file analysis (use same concurrency limit)
                            const fallbackPromises = batch.map((file, fileIndex) => {
                                return async () => {
                                    const fileMeta = batchMetadata.find(m => m.file === file.path);
                                    const relativePath = vscode.workspace.asRelativePath(file.path);
                                    const sizeKb = Math.round(file.content.length / 1024);

                                    // Detect framework per-file in fallback mode (don't reuse batch framework)
                                    const fileFramework = WorkflowDetector.detectFramework(file.content);

                                    try {
                                        log(`  Analyzing file ${fileIndex + 1}/${batch.length}: ${relativePath} (${sizeKb} KB)`);
                                        log(`  Sending POST /analyze: 1 file, framework: ${fileFramework || 'none'}`);

                                        const fileResult = await api.analyzeWorkflow(
                                            formatFileXML(file.path, file.content, fileMeta),
                                            [file.path],
                                            fileFramework || undefined,
                                            fileMeta ? [fileMeta] : [],
                                            condensedStructure,
                                            httpConnectionsContext
                                        );

                                        // Check if session was invalidated
                                        if (analysisSession !== sessionAtStart) {
                                            log(`  File result discarded (session invalidated)`);
                                            return;
                                        }

                                        const fileGraph = fileResult.graph;
                                        if (fileResult.remainingAnalyses >= 0) {
                                            await auth.updateRemainingAnalyses(fileResult.remainingAnalyses);
                                        }

                                        // Track cost from fallback file analysis
                                        costTracker.add('analyze', 1, fileResult.usage, fileResult.cost, batchIndex);

                                        graphs.push(fileGraph);
                                        log(`  Fallback file complete: ${fileGraph.nodes.length} nodes`);

                                        // Cache successful fallback analysis (only successful results get cached)
                                        if (!bypassCache) {
                                            await cache.setAnalysisResult(fileGraph, { [file.path]: file.content });
                                            log(`  Cached ${relativePath}`);
                                        }
                                    } catch (fileError: any) {
                                        // Re-throw trial exhaustion so outer handler can queue retry
                                        if (fileError instanceof TrialExhaustedError) {
                                            throw fileError;
                                        }

                                        // Check if it's "No LLM workflow" - not a failure, just no LLM code
                                        const detail = fileError.response?.data?.detail || fileError.message || '';
                                        if (fileError.response?.status === 400 &&
                                            detail.toLowerCase().includes('no llm workflow')) {
                                            log(`  ${relativePath}: No LLM workflow (caching empty)`);
                                            // Cache this file as having 0 nodes
                                            if (!bypassCache) {
                                                await cache.setAnalysisResult({ nodes: [], edges: [], llms_detected: [], workflows: [] }, { [file.path]: file.content });
                                            }
                                            return;
                                        }

                                        log(`  Failed to analyze ${file.path}: ${fileError.message}`);
                                        // Don't cache failures - leave uncached for retry
                                    }
                                };
                            });

                            // Process fallback files in parallel chunks
                            for (let i = 0; i < fallbackPromises.length; i += maxConcurrency) {
                                const chunk = fallbackPromises.slice(i, i + maxConcurrency);
                                await Promise.all(chunk.map(fn => fn()));
                            }

                            // Return null to indicate fallback was used (graphs array already updated)
                            return null;
                        }
                    }

                    // Calculate and log duration
                    const duration = Date.now() - startTime;
                    const minutes = Math.floor(duration / 60000);
                    const seconds = Math.floor((duration % 60000) / 1000);
                    const timeStr = minutes > 0 ? `${minutes} minute${minutes !== 1 ? 's' : ''} ${seconds} second${seconds !== 1 ? 's' : ''}` : `${seconds} second${seconds !== 1 ? 's' : ''}`;
                    log(`Analysis complete in ${timeStr}`);

                    // Display detailed cost report with actual API usage
                    if (costAggregator.hasOperations()) {
                        displayCostReport(costAggregator.getReport(), log);
                    }

                    webview.notifyAnalysisComplete(true);
                } else {
                    log(`\n✓ All files cached, no analysis needed`);
                }

            // Check if session was invalidated before displaying
            if (analysisSession !== sessionAtStart) {
                log('Analysis results discarded (session invalidated)');
                return;
            }

            // Get merged graph from cache (only successful results are cached)
            let graph = await cache.getMergedGraph();

            // Resolve cross-batch edge references (file:function → actual node IDs)
            // HTTP connection edges are now produced by the LLM, so they're included in analysis results
            if (graph && graph.edges.length > 0) {
                pipelineStats.edges.llmGenerated = graph.edges.length;
                const resolution = resolveExternalEdges(graph);
                graph = resolution.graph;
                pipelineStats.edges.resolved = resolution.resolved;
                pipelineStats.edges.orphaned = resolution.unresolved.length;
                logResolutionStats(resolution.resolved, resolution.unresolved, log);
            }

            // Count nodes and files in final graph
            if (graph) {
                pipelineStats.results.totalNodes = graph.nodes.length;
                const filesWithNodes = new Set(graph.nodes.map(n => n.source?.file).filter(Boolean));
                pipelineStats.results.filesWithNodes = filesWithNodes.size;
            }

            log(`\n✓ Final graph: ${graph?.nodes.length || 0} nodes, ${graph?.edges.length || 0} edges`);

            if (!graph || (graph.nodes.length === 0 && graph.edges.length === 0)) {
                webview.notifyWarning('No workflows detected. Check your files use supported LLM APIs.');
                log('⚠️  Final graph is empty - all files rejected or contain no LLM usage');
            }

            // Validate graph - remove orphaned edges that reference missing nodes
            let orphanedEdgesRemoved = 0;
            if (graph && graph.edges.length > 0) {
                const nodeIds = new Set(graph.nodes.map(n => n.id));
                const validEdges = graph.edges.filter(e => {
                    const valid = nodeIds.has(e.source) && nodeIds.has(e.target);
                    if (!valid) {
                        log(`⚠️  Removing orphaned edge: ${e.source} → ${e.target}`);
                    }
                    return valid;
                });
                if (validEdges.length !== graph.edges.length) {
                    orphanedEdgesRemoved = graph.edges.length - validEdges.length;
                    log(`⚠️  Removed ${orphanedEdgesRemoved} orphaned edges`);
                    graph = { ...graph, edges: validEdges };
                }
            }
            pipelineStats.edges.orphaned += orphanedEdgesRemoved;

            // Log pipeline summary
            log(`\n${'═'.repeat(50)}`);
            log(`PIPELINE SUMMARY`);
            log(`${'═'.repeat(50)}`);
            log(`1. DETECTION`);
            log(`   └─ Files with LLM imports:     ${pipelineStats.detected.llmFiles}`);
            log(`   └─ HTTP client files added:    ${pipelineStats.detected.httpClientFilesAdded}`);
            log(`   └─ Total files for analysis:   ${pipelineStats.detected.llmFiles + pipelineStats.detected.httpClientFilesAdded}`);
            log(`2. HTTP CONNECTIONS`);
            log(`   └─ Files scanned for HTTP:     ${pipelineStats.detected.httpFiles + pipelineStats.detected.llmFiles}`);
            log(`   └─ Connections found:          ${pipelineStats.analyzed.httpConnections}`);
            log(`3. RESULTS`);
            log(`   └─ Files with nodes:           ${pipelineStats.results.filesWithNodes}`);
            log(`   └─ Total nodes:                ${pipelineStats.results.totalNodes}`);
            log(`4. EDGES`);
            log(`   └─ LLM generated:              ${pipelineStats.edges.llmGenerated}`);
            log(`   └─ Resolved:                   ${pipelineStats.edges.resolved}`);
            log(`   └─ Orphaned (removed):         ${pipelineStats.edges.orphaned}`);
            log(`   └─ Final edge count:           ${graph?.edges.length || 0}`);
            log(`${'═'.repeat(50)}\n`);

            // Single show() at end with complete graph (no loading indicator)
            if (graph) {
                webview.show(graph);
            }
        } catch (error: any) {
            // Handle trial quota exhaustion - store task for retry after login
            if (error instanceof TrialExhaustedError) {
                log('[auth] Trial quota exhausted, storing pending task and showing auth panel...');
                pendingAnalysisTask = () => analyzeWorkspace(bypassCache);
                log(`[auth] pendingAnalysisTask set: ${!!pendingAnalysisTask}`);
                webview.showAuthPanel();
                return;
            }

            log(`ERROR: ${error.message}`);
            log(`Status: ${error.response?.status}`);
            log(`Response: ${JSON.stringify(error.response?.data)}`);

            // Filter out VSCode internal errors (e.g., missing prompts directory)
            const errorMsg = error.response?.data?.detail || error.message;
            if (errorMsg.includes('Application Support/Code/User/prompts') ||
                (error.code === 'ENOENT' && errorMsg.includes('/User/'))) {
                log(`Ignoring VSCode internal error: ${errorMsg}`);
                return;
            }

            // Handle file size errors (HTTP 413) with clearer messaging
            if (error.response?.status === 413) {
                webview.notifyAnalysisComplete(false, 'Files too large. Try analyzing fewer files.');
            } else {
                webview.notifyAnalysisComplete(false, errorMsg);
            }
        }
    }

    async function analyzeAndUpdateSingleFile(uri: vscode.Uri) {
        try {
            const filePath = uri.fsPath;
            const startTime = Date.now();
            log(`\n=== Incremental File Analysis ===`);
            log(`File: ${vscode.workspace.asRelativePath(filePath)}`);

            // Read file content
            const document = await vscode.workspace.openTextDocument(uri);
            const content = document.getText();

            // Get cached graph BEFORE invalidating (includes stale version of changed file)
            const cachedGraph = await cache.getMergedGraph();

            // Show cached graph immediately with loading indicator
            if (cachedGraph && cachedGraph.nodes.length > 0) {
                webview.show(cachedGraph, { loading: true });
            } else {
                webview.showLoading(`Updating ${vscode.workspace.asRelativePath(filePath)}...`);
            }

            // NOW invalidate cache for this file
            await cache.invalidateFile(filePath);

            // Analyze single file
            const analyzeResult = await api.analyzeWorkflow(content, [filePath]);
            const result = analyzeResult.graph;
            if (analyzeResult.remainingAnalyses >= 0) {
                await auth.updateRemainingAnalyses(analyzeResult.remainingAnalyses);
            }

            if (result && result.nodes && result.nodes.length > 0) {
                // Cache the new result
                await cache.setAnalysisResult(result, { [filePath]: content });
                log(`✓ Updated cache for ${vscode.workspace.asRelativePath(filePath)}: ${result.nodes.length} nodes`);
            } else {
                // Cache empty result
                await cache.setAnalysisResult({
                    nodes: [],
                    edges: [],
                    llms_detected: [],
                    workflows: []
                }, { [filePath]: content });
                log(`⚠️  No nodes found after update`);
            }

            // Get merged graph from cache
            const mergedGraph = await cache.getMergedGraph();

            // Update webview with merged graph
            if (mergedGraph) {
                webview.show(mergedGraph);
                webview.notifyAnalysisComplete(true);
                const duration = Date.now() - startTime;
                const seconds = (duration / 1000).toFixed(1);
                log(`✓ Graph updated: ${mergedGraph.nodes.length} nodes, ${mergedGraph.edges.length} edges (${seconds}s)`);
            } else {
                webview.notifyAnalysisComplete(true);
                const duration = Date.now() - startTime;
                const seconds = (duration / 1000).toFixed(1);
                log(`✓ Graph updated: empty (${seconds}s)`);
            }
        } catch (error: any) {
            // Handle trial quota exhaustion - store task for retry after login
            if (error instanceof TrialExhaustedError) {
                log('Trial quota exhausted, showing auth panel...');
                pendingAnalysisTask = () => analyzeAndUpdateSingleFile(uri);
                webview.showAuthPanel();
                return;
            }

            log(`ERROR updating file: ${error.message}`);
            webview.notifyAnalysisComplete(false, error.message);
        }
    }

    context.subscriptions.push(
        vscode.commands.registerCommand('codag.open', async () => {
            await analyzeWorkspace(false);
        })
    );

    // Show file picker without re-rendering graph (used from within webview)
    context.subscriptions.push(
        vscode.commands.registerCommand('codag.showFilePicker', async () => {
            log('Opening file picker (preserving current graph)...');

            // Fast: get all source files without LLM analysis
            const allFiles = await WorkflowDetector.getAllSourceFiles();
            if (allFiles.length === 0) {
                webview.notifyWarning('No source files found.');
                return;
            }

            // Build file tree and show picker immediately
            const { tree, totalFiles } = buildFileTree(allFiles, context);
            const selectedPaths = await webview.showFilePicker(tree, totalFiles);

            if (!selectedPaths || selectedPaths.length === 0) {
                return; // User cancelled
            }

            // Save selection and trigger analysis for selected files
            await saveFilePickerSelection(context, allFiles, selectedPaths);

            // Read selected files in parallel
            const fileReadResults = await Promise.all(
                selectedPaths.map(async (filePath) => {
                    try {
                        const uri = vscode.Uri.file(filePath);
                        const content = await vscode.workspace.fs.readFile(uri);
                        return { path: filePath, content: Buffer.from(content).toString('utf8') };
                    } catch (error) {
                        log(`⚠️  Skipping file (read error): ${filePath}`);
                        return null;
                    }
                })
            );
            const fileContents = fileReadResults.filter((f): f is { path: string; content: string } => f !== null);

            // Extract HTTP connections for cross-service edge detection
            const rawHttpStructure = extractRepoStructure(fileContents);
            const httpConnectionsContext = formatHttpConnectionsForPrompt(rawHttpStructure);

            // Check cache
            const allFilePaths = fileContents.map(f => f.path);
            const allFileContentsArr = fileContents.map(f => f.content);
            const cacheResult = await cache.checkFiles(allFilePaths, allFileContentsArr);

            if (cacheResult.cached.length > 0) {
                const cachedPaths = cacheResult.cached.map(f => f.path);
                const cachedGraph = await cache.getMergedGraph(cachedPaths);
                if (cachedGraph) {
                    webview.initGraph(cachedGraph);
                }
            }

            // If there are uncached files, analyze them in batches
            if (cacheResult.uncached.length > 0) {
                log(`Analyzing ${cacheResult.uncached.length} uncached files...`);

                const uncachedUris = cacheResult.uncached.map(f => vscode.Uri.file(f.path));
                const metadata = await metadataBuilder.buildMetadata(uncachedUris);

                let framework: string | null = null;
                for (const file of cacheResult.uncached) {
                    framework = WorkflowDetector.detectFramework(file.content);
                    if (framework) break;
                }

                // Create dependency-based batches (same as main analysis flow)
                const batches = createDependencyBatches(
                    cacheResult.uncached,
                    metadata,
                    CONFIG.BATCH.MAX_SIZE,
                    CONFIG.BATCH.MAX_TOKENS
                );
                log(`Created ${batches.length} batch${batches.length > 1 ? 'es' : ''} for ${cacheResult.uncached.length} files`);

                const newGraphs: any[] = [];
                const maxConcurrency = CONFIG.CONCURRENCY.MAX_PARALLEL;
                const sessionAtStart = analysisSession;

                webview.notifyAnalysisStarted();
                webview.updateProgress(0, batches.length);

                // Process batches with concurrency limiting (parallel)
                for (let i = 0; i < batches.length; i += maxConcurrency) {
                    const batchSlice = batches.slice(i, i + maxConcurrency);

                    const batchPromises = batchSlice.map(async (batch, sliceIndex) => {
                        const batchIndex = i + sliceIndex;
                        const batchPaths = batch.map(f => f.path);
                        const batchMetadata = metadata.filter(m => batchPaths.includes(m.file));
                        const combinedCode = combineFilesXML(batch, batchMetadata);
                        const batchTokens = estimateTokens(combinedCode);

                        log(`Analyzing batch ${batchIndex + 1}/${batches.length} (${batch.length} files, ~${Math.round(batchTokens / 1000)}k tokens)...`);

                        try {
                            const batchResult = await api.analyzeWorkflow(
                                combinedCode,
                                batchPaths,
                                framework || undefined,
                                batchMetadata,
                                undefined,  // condensedStructure
                                httpConnectionsContext
                            );

                            // Check if session was invalidated (cache cleared) during request
                            if (analysisSession !== sessionAtStart) {
                                log(`Batch ${batchIndex + 1} result discarded (session invalidated)`);
                                return null;
                            }

                            const batchGraph = batchResult.graph;

                            if (batchResult.remainingAnalyses >= 0) {
                                await auth.updateRemainingAnalyses(batchResult.remainingAnalyses);
                            }

                            newGraphs.push(batchGraph);

                            // Cache per-file
                            const contentMap: Record<string, string> = {};
                            for (const f of batch) contentMap[f.path] = f.content;
                            await cache.setAnalysisResult(batchGraph, contentMap);

                            // Update progress only - graph updated once at end
                            webview.updateProgress(batchIndex + 1, batches.length);

                            log(`✓ Batch ${batchIndex + 1} complete: ${batchGraph.nodes.length} nodes`);
                            return batchGraph;
                        } catch (batchError: any) {
                            log(`Batch ${batchIndex + 1} failed: ${batchError.message}`);
                            return null;
                        }
                    });

                    await Promise.all(batchPromises);
                }

                // Final merge and completion
                const mergedGraph = await cache.getMergedGraph(allFilePaths);
                if (mergedGraph) {
                    webview.updateGraph(mergedGraph);
                }
                webview.notifyAnalysisComplete(true);
            }
        })
    );
}

export function deactivate() {}
