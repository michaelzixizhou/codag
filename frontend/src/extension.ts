import * as vscode from 'vscode';
import { APIClient } from './api';
import { AuthManager, AuthState, OAuthProvider } from './auth';
import { CacheManager } from './cache';
import { WorkflowDetector } from './analyzer';
import { WebviewManager } from './webview';
import { metadataBuilder } from './metadata-builder';
import { registerWorkflowParticipant } from './copilot/workflow-participant';
import { registerWorkflowTool } from './copilot/workflow-tool';
import { registerWorkflowQueryTool } from './copilot/workflow-query-tool';
import { registerNodeQueryTool } from './copilot/node-query-tool';
import { registerWorkflowNavigateTool } from './copilot/workflow-navigate-tool';
import { registerListWorkflowsTool } from './copilot/list-workflows-tool';
import { CONFIG } from './config';
import { buildFileTree, saveFilePickerSelection, getSavedSelectedPaths } from './file-picker';
import { getMetadataBatcher } from './metadata-batcher';

// File watching
import { scheduleFileAnalysis } from './file-watching/handler';
import { extractRepoStructure, formatHttpConnectionsForPrompt } from './repo-structure';

// Analysis helpers
import { withHttpEdges } from './analysis/helpers';
import { analyzeAndUpdateSingleFile } from './analysis/single-file';
import { analyzeSelectedFiles } from './analysis/selected-files';
import { analyzeWorkspace } from './analysis/workspace';

// Cost tracking
import { estimateTokens } from './cost-tracking';

// File preparation
import { combineFilesXML, createDependencyBatches } from './file-preparation';

// Centralized state management
import {
    setHttpConnections, setCrossFileCalls, setRepoFiles,
    getAnalysisSession, incrementAnalysisSession,
    getPendingAnalysisTask, setPendingAnalysisTask, consumePendingAnalysisTask
} from './analysis/state';

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
        const pendingTask = getPendingAnalysisTask();
        log(`[auth] State changed: isAuthenticated=${state.isAuthenticated}, isTrial=${state.isTrial}, pendingTask=${!!pendingTask}`);
        webview.updateAuthState(state);

        // Retry pending task if user just authenticated
        if (state.isAuthenticated && pendingTask) {
            log('[auth] User authenticated, retrying blocked analysis...');
            const task = consumePendingAnalysisTask();
            if (task) {
                try {
                    await task();
                } catch (error: any) {
                    log(`[auth] Retry failed: ${error.message}`);
                }
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

    // Debounce timing
    const DEBOUNCE_MS = CONFIG.WATCHER.DEBOUNCE_MS;

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

    // File watching configuration
    // Shared context for analysis operations
    const analysisCtx = { api, auth, cache, webview, log };
    const workspaceCtx = { ...analysisCtx, metadataBuilder, extensionContext: context };

    // Wrapper for single file analysis that includes context
    const doAnalyzeAndUpdateSingleFile = (uri: vscode.Uri) => analyzeAndUpdateSingleFile(analysisCtx, uri);

    // File watching configuration
    const fileWatchingConfig = {
        debounceMs: DEBOUNCE_MS,
        activeToChangedMs: 4000  // 4 seconds before transitioning to static
    };
    const fileWatchingCtx = { cache, webview, log, metadataBatcher };

    // File watcher for changes
    fileWatcher.onDidChange(async (uri) => {
        await scheduleFileAnalysis(fileWatchingCtx, uri, 'watcher', fileWatchingConfig, doAnalyzeAndUpdateSingleFile);
    });
    fileWatcher.onDidCreate(async (uri) => {
        await scheduleFileAnalysis(fileWatchingCtx, uri, 'create', fileWatchingConfig, doAnalyzeAndUpdateSingleFile);
    });
    context.subscriptions.push(fileWatcher);

    // Document save handler (more reliable than file watcher)
    context.subscriptions.push(
        vscode.workspace.onDidSaveTextDocument(async (document) => {
            await scheduleFileAnalysis(fileWatchingCtx, document.uri, 'save', fileWatchingConfig, doAnalyzeAndUpdateSingleFile);
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
                    await doAnalyzeAndUpdateSingleFile(uri);
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
                incrementAnalysisSession();  // Invalidate any pending analysis results
                metadataBatcher.cancel();  // Cancel pending metadata requests
                await cache.clear();
                log('Cache cleared successfully, reanalyzing workspace');
                await analyzeWorkspace(workspaceCtx, true);
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
            incrementAnalysisSession();  // Invalidate any pending analysis results
            metadataBatcher.cancel();  // Cancel pending metadata requests

            // Invalidate cache for each selected file
            for (const filePath of paths) {
                await cache.invalidateFile(filePath);
                log(`  Cleared: ${vscode.workspace.asRelativePath(filePath)}`);
            }

            log('Cache cleared, reanalyzing selected files...');

            // Save selection with relative paths
            const allSourceFiles = await WorkflowDetector.getAllSourceFiles();
            const pathsRelative = paths.map(p => vscode.workspace.asRelativePath(p, false));
            await saveFilePickerSelection(context, allSourceFiles, pathsRelative);

            // Analyze selected files with bypassCache=true to force fresh analysis
            await analyzeSelectedFiles({ ...analysisCtx, metadataBuilder }, paths, true);
        })
    );

    context.subscriptions.push(
        vscode.commands.registerCommand('codag.open', async () => {
            await analyzeWorkspace(workspaceCtx, false);
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

            // Build file tree and show picker immediately (includes token estimates)
            const { tree, totalFiles } = await buildFileTree(allFiles, context);
            const selectedPaths = await webview.showFilePicker(tree, totalFiles);

            if (!selectedPaths || selectedPaths.length === 0) {
                return; // User cancelled
            }

            // Convert to relative paths for consistency
            const selectedPathsRelative = selectedPaths.map(p => vscode.workspace.asRelativePath(p, false));

            // Save selection with relative paths
            await saveFilePickerSelection(context, allFiles, selectedPathsRelative);

            // Read selected files in parallel (use full paths for file reading)
            const fileReadResults = await Promise.all(
                selectedPaths.map(async (filePath) => {
                    try {
                        const uri = vscode.Uri.file(filePath);
                        const content = await vscode.workspace.fs.readFile(uri);
                        // Store relative path in result
                        return { path: vscode.workspace.asRelativePath(filePath, false), content: Buffer.from(content).toString('utf8') };
                    } catch (error) {
                        log(`⚠️  Skipping file (read error): ${filePath}`);
                        return null;
                    }
                })
            );
            const fileContents = fileReadResults.filter((f): f is { path: string; content: string } => f !== null);

            // Extract HTTP connections and cross-file calls for static edge detection
            const rawHttpStructure = extractRepoStructure(fileContents);
            setHttpConnections(rawHttpStructure.httpConnections);
            setCrossFileCalls(rawHttpStructure.crossFileCalls || []);
            // Store repo files for HTTP caller detection
            setRepoFiles(rawHttpStructure.files.map(f => ({
                path: f.path,
                functions: f.functions.map(fn => ({ name: fn.name, calls: fn.calls, line: fn.line }))
            })));
            const httpConnectionsContext = formatHttpConnectionsForPrompt(rawHttpStructure);

            // Check cache
            const allFilePaths = fileContents.map(f => f.path);
            const allFileContentsArr = fileContents.map(f => f.content);
            const cacheResult = await cache.checkFiles(allFilePaths, allFileContentsArr);

            if (cacheResult.cached.length > 0) {
                const cachedPaths = cacheResult.cached.map(f => f.path);
                let cachedGraph = await cache.getMergedGraph(cachedPaths);
                if (cachedGraph) {
                    // Add HTTP connection edges
                    webview.initGraph(withHttpEdges(cachedGraph, log)!);
                }
            }

            // If there are uncached files, analyze them in batches
            if (cacheResult.uncached.length > 0) {
                log(`Analyzing ${cacheResult.uncached.length} uncached files...`);

                // Convert relative paths back to Uris for metadata builder
                const workspaceFolder = vscode.workspace.workspaceFolders?.[0];
                if (!workspaceFolder) {
                    log('No workspace folder found');
                    return;
                }
                const uncachedUris = cacheResult.uncached.map(f => vscode.Uri.joinPath(workspaceFolder.uri, f.path));
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
                const sessionAtStart = getAnalysisSession();

                webview.notifyAnalysisStarted();
                webview.startBatchProgress(batches.length);

                // Process batches with concurrency limiting (parallel)
                for (let i = 0; i < batches.length; i += maxConcurrency) {
                    const batchSlice = batches.slice(i, i + maxConcurrency);

                    const batchPromises = batchSlice.map(async (batch, sliceIndex) => {
                        const batchIndex = i + sliceIndex;
                        const batchPaths = batch.map(f => f.path);
                        const batchMetadata = metadata.filter(m => batchPaths.includes(vscode.workspace.asRelativePath(m.file, false)));
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
                            if (getAnalysisSession() !== sessionAtStart) {
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
                            webview.batchCompleted(batch.length);

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
                    webview.updateGraph(withHttpEdges(mergedGraph, log)!);
                }
                webview.notifyAnalysisComplete(true);
            }
        })
    );
}

export function deactivate() {}
