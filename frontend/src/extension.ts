import * as vscode from 'vscode';
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
import { buildFileTree, saveFilePickerSelection, updateLLMStatus, getSavedSelectedPaths } from './file-picker';

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
 * Estimate tokens for a string (rough approximation: 1 token ≈ 4 chars)
 */
function estimateTokens(text: string): number {
    return Math.ceil(text.length / 4);
}

/**
 * Format a single file in XML format with optional imports attribute
 */
function formatFileXML(
    filePath: string,
    content: string,
    metadata?: FileMetadata
): string {
    const relativePath = filePath; // Already relative in most cases
    const imports = metadata?.relatedFiles?.length
        ? ` imports="${metadata.relatedFiles.map(f => f.split('/').pop()).join(', ')}"`
        : '';
    return `<file path="${relativePath}"${imports}>\n${content}\n</file>`;
}

/**
 * Build directory structure string from file paths
 */
function buildDirectoryStructure(filePaths: string[]): string {
    const tree = new Map<string, Set<string>>();

    for (const filePath of filePaths) {
        const parts = filePath.split('/');
        let currentPath = '';
        for (let i = 0; i < parts.length - 1; i++) {
            const parent = currentPath || '.';
            currentPath = currentPath ? `${currentPath}/${parts[i]}` : parts[i];
            if (!tree.has(parent)) tree.set(parent, new Set());
            tree.get(parent)!.add(parts[i] + '/');
        }
        // Add file to its directory
        const dir = parts.slice(0, -1).join('/') || '.';
        if (!tree.has(dir)) tree.set(dir, new Set());
        tree.get(dir)!.add(parts[parts.length - 1]);
    }

    // Build tree string
    const lines: string[] = [];
    function printDir(path: string, indent: string) {
        const children = tree.get(path);
        if (!children) return;
        const sorted = Array.from(children).sort((a, b) => {
            // Directories first
            const aIsDir = a.endsWith('/');
            const bIsDir = b.endsWith('/');
            if (aIsDir !== bIsDir) return aIsDir ? -1 : 1;
            return a.localeCompare(b);
        });
        for (const child of sorted) {
            lines.push(`${indent}${child}`);
            if (child.endsWith('/')) {
                const childPath = path === '.' ? child.slice(0, -1) : `${path}/${child.slice(0, -1)}`;
                printDir(childPath, indent + '  ');
            }
        }
    }
    printDir('.', '');
    return lines.join('\n');
}

/**
 * Combine files into XML format with directory structure
 */
function combineFilesXML(
    files: { path: string; content: string }[],
    metadata: FileMetadata[]
): string {
    const metadataMap = new Map(metadata.map(m => [m.file, m]));

    // Build directory structure
    const dirStructure = buildDirectoryStructure(files.map(f => f.path));

    // Format each file
    const fileContents = files.map(f =>
        formatFileXML(f.path, f.content, metadataMap.get(f.path))
    ).join('\n\n');

    return `<directory_structure>\n${dirStructure}\n</directory_structure>\n\n${fileContents}`;
}

/**
> * Create batches of files based on dependency relationships
 * Groups related files together while respecting token limits
 */
function createDependencyBatches(
    files: { path: string; content: string; }[],
    metadata: FileMetadata[],
    maxBatchSize: number = CONFIG.BATCH.MAX_SIZE,
    maxTokensPerBatch: number = CONFIG.BATCH.MAX_TOKENS
): { path: string; content: string; }[][] {
    // Build adjacency list from metadata
    const graph = new Map<string, Set<string>>();

    for (const meta of metadata) {
        if (!graph.has(meta.file)) {
            graph.set(meta.file, new Set());
        }
        for (const related of meta.relatedFiles) {
            graph.get(meta.file)!.add(related);
            if (!graph.has(related)) {
                graph.set(related, new Set());
            }
            graph.get(related)!.add(meta.file);
        }
    }

    // Find connected components using DFS
    const visited = new Set<string>();
    const components: string[][] = [];

    function dfs(filePath: string, component: string[]) {
        visited.add(filePath);
        component.push(filePath);

        const neighbors = graph.get(filePath) || new Set();
        for (const neighbor of neighbors) {
            if (!visited.has(neighbor)) {
                dfs(neighbor, component);
            }
        }
    }

    // Find all connected components
    for (const file of files) {
        if (!visited.has(file.path)) {
            const component: string[] = [];
            dfs(file.path, component);
            components.push(component);
        }
    }

    // Split large components to respect both batch size and token limits
    const batches: { path: string; content: string; }[][] = [];

    for (const component of components) {
        const componentSet = new Set(component);
        const componentFiles = files.filter(f => componentSet.has(f.path));

        // Try to fit component in one batch
        const totalTokens = componentFiles.reduce((sum, f) => sum + estimateTokens(f.content), 0);

        if (componentFiles.length <= maxBatchSize && totalTokens <= maxTokensPerBatch) {
            // Component fits in one batch
            batches.push(componentFiles);
        } else {
            // Split component into token-aware batches
            let currentBatch: { path: string; content: string; }[] = [];
            let currentBatchTokens = 0;

            for (const file of componentFiles) {
                const fileTokens = estimateTokens(file.content);

                // Check if adding this file would exceed limits
                if (currentBatch.length >= maxBatchSize ||
                    (currentBatch.length > 0 && currentBatchTokens + fileTokens > maxTokensPerBatch)) {
                    // Start new batch
                    batches.push(currentBatch);
                    currentBatch = [file];
                    currentBatchTokens = fileTokens;
                } else {
                    currentBatch.push(file);
                    currentBatchTokens += fileTokens;
                }
            }

            // Add final batch if not empty
            if (currentBatch.length > 0) {
                batches.push(currentBatch);
            }
        }
    }

    return batches;
}

export async function activate(context: vscode.ExtensionContext) {
    log('Codag activating...');

    const config = vscode.workspace.getConfiguration('codag');
    const apiUrl = config.get<string>('apiUrl', 'http://localhost:8000');

    log(`Backend API URL: ${apiUrl}`);

    const api = new APIClient(apiUrl, outputChannel);
    const auth = new AuthManager(context, api);
    
    // Set auth refresh callback to handle 401 responses
    api.setAuthRefreshCallback(() => auth.refreshAccessToken());
    
    await auth.initialize(); // Load token from secure storage
    const cache = new CacheManager(context);
    const webview = new WebviewManager(context);

    // Store pending task when blocked by trial quota
    let pendingAnalysisTask: (() => Promise<void>) | null = null;

    // Register URI handler for OAuth callbacks
    const uriHandler = vscode.window.registerUriHandler({
        handleUri(uri: vscode.Uri) {
            log(`URI Handler received: ${uri.toString()}`);
            if (uri.path === '/auth/callback') {
                const params = new URLSearchParams(uri.query);
                const token = params.get('token');
                const refreshToken = params.get('refreshToken');
                const error = params.get('error');

                if (error) {
                    auth.handleOAuthError(error);
                } else if (token) {
                    auth.handleOAuthCallback(token, refreshToken || undefined);
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

    const scheduleFileAnalysis = async (uri: vscode.Uri, source: string) => {
        const filePath = uri.fsPath;

        // Ignore compiled output files (they change when source files compile)
        if (filePath.includes('/out/') || filePath.includes('\\out\\')) {
            return;
        }

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
                log(`Re-analyzing changed file: ${filePath}`);
                // Show detecting indicator before analysis
                webview.showLoading('Detecting changes...');
                await analyzeAndUpdateSingleFile(uri);
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
                graph = await cache.getPerFile(filePath, content);
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
                log(`File: ${relativePath} (${sizeKb} KB)`);
                log(`Sending POST /analyze: 1 file, framework: ${framework || 'none'}`);

                const result = await api.analyzeWorkflow(content, [filePath], framework || undefined, [metadata]);
                graph = result.graph;
                if (typeof result.remainingAnalyses === 'number') {
                    await auth.updateRemainingAnalyses(result.remainingAnalyses);
                }

                // Only cache if not in bypass mode
                if (!bypassCache) {
                    await cache.setPerFile(filePath, content, graph);
                }

                // Calculate and log duration
                const duration = Date.now() - startTime;
                const minutes = Math.floor(duration / 60000);
                const seconds = Math.floor((duration % 60000) / 1000);
                const timeStr = minutes > 0 ? `${minutes} minute${minutes !== 1 ? 's' : ''} ${seconds} second${seconds !== 1 ? 's' : ''}` : `${seconds} second${seconds !== 1 ? 's' : ''}`;
                log(`Analysis complete in ${timeStr}${bypassCache ? ' (not cached)' : ', cached result'}`);
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
        const batchId = `batch-${Date.now()}-${Math.random().toString(16).slice(2)}`;

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
            log(`Created ${batches.length} batch${batches.length > 1 ? 'es' : ''}`);

            webview.notifyAnalysisStarted();
            webview.updateProgress(0, batches.length);

            const maxConcurrency = CONFIG.CONCURRENCY.MAX_PARALLEL;
            const newGraphs: any[] = [];

            // Analyze batches
            for (let i = 0; i < batches.length; i += maxConcurrency) {
                const batchSlice = batches.slice(i, i + maxConcurrency);

                const batchPromises = batchSlice.map(async (batch, sliceIndex) => {
                    const batchIndex = i + sliceIndex;
                    const batchMetadata = metadata.filter(m =>
                        batch.some(f => f.path === m.file)
                    );
                    const combinedCode = combineFilesXML(batch, batchMetadata);

                    try {
                        const analyzeResult = await api.analyzeWorkflow(
                            combinedCode,
                            batch.map(f => f.path),
                            framework || undefined,
                            batchMetadata,
                            batchId
                        );

                        const graph = analyzeResult.graph;
                        if (typeof analyzeResult.remainingAnalyses === 'number') {
                            await auth.updateRemainingAnalyses(analyzeResult.remainingAnalyses);
                        }

                        if (graph && graph.nodes) {
                            newGraphs.push(graph);
                            // Cache results
                            for (const file of batch) {
                                const fileNodes = graph.nodes.filter((n: any) => n.source?.file === file.path);
                                const fileNodeIds = new Set(fileNodes.map((n: any) => n.id));
                                const fileEdges = graph.edges.filter((e: any) =>
                                    fileNodeIds.has(e.source) && fileNodeIds.has(e.target)
                                );
                                const fileWorkflows = (graph.workflows || []).filter((wf: any) =>
                                    wf.nodeIds.some((id: string) => fileNodeIds.has(id))
                                ).map((wf: any) => ({
                                    ...wf,
                                    nodeIds: wf.nodeIds.filter((id: string) => fileNodeIds.has(id))
                                }));

                                // Always cache results (even empty) to avoid re-analyzing
                                await cache.setPerFile(file.path, file.content, {
                                    nodes: fileNodes,
                                    edges: fileEdges,
                                    llms_detected: fileNodes.length > 0 ? (graph.llms_detected || []) : [],
                                    workflows: fileWorkflows
                                });
                            }
                        }

                        webview.updateProgress(batchIndex + 1, batches.length);
                        return graph;
                    } catch (error: any) {
                        log(`Batch ${batchIndex + 1} failed: ${error.message}`);
                        throw error;
                    }
                });

                await Promise.all(batchPromises);
            }

            // Merge and display results
            if (newGraphs.length > 0) {
                const mergedGraph = cache.mergeGraphs(newGraphs);
                webview.show(mergedGraph);

                const elapsed = ((Date.now() - startTime) / 1000).toFixed(1);
                log(`✓ Analysis complete in ${elapsed}s: ${mergedGraph.nodes.length} nodes, ${mergedGraph.edges.length} edges`);
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
        const batchId = `batch-${Date.now()}-${Math.random().toString(16).slice(2)}`;

        log('Starting workspace scan...');
        log(`Workspace root: ${vscode.workspace.workspaceFolders?.[0]?.uri.fsPath}`);
        if (bypassCache) {
            log('⚠️  BYPASS MODE: Cache reading/writing disabled for this analysis');
        }

        try {
            // Show panel immediately (don't block on file detection)
            webview.showLoading('Scanning workspace...');

            const workflowFiles = await WorkflowDetector.detectInWorkspace();
            log(`Found ${workflowFiles.length} workflow files`);

            if (workflowFiles.length === 0) {
                webview.notifyWarning('No AI workflow files found. Open a folder with LLM API calls.');
                return;
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

            // Check cache for ALL files before showing file picker
            let allCachedGraphs: any[] = [];
            if (!bypassCache) {
                log(`\nChecking cache for all ${allFileContents.length} files...`);
                try {
                    const allPaths = allFileContents.map(f => f.path);
                    const allContents = allFileContents.map(f => f.content);
                    const cacheResult = await cache.getMultiplePerFile(allPaths, allContents);
                    allCachedGraphs = cacheResult.cachedGraphs;
                    if (allCachedGraphs.length > 0) {
                        log(`✓ Found ${allCachedGraphs.length} cached graphs`);
                    }
                } catch (cacheError: any) {
                    log(`⚠️  Cache check failed: ${cacheError.message}`);
                }
            }

            // Check if this is a subsequent run (has cached data)
            const isFirstRun = allCachedGraphs.length === 0;

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
                        const cacheResult = await cache.getMultiplePerFile(
                            fileContents.map(f => f.path),
                            fileContents.map(f => f.content)
                        );

                        const uncachedCount = cacheResult.uncachedFiles.length;
                        const cachedGraphs = cacheResult.cachedGraphs;
                        const totalCachedNodes = cachedGraphs.reduce((sum, g) => sum + (g?.nodes?.length || 0), 0);
                        log(`Cache result: ${cachedGraphs.length} cached (${totalCachedNodes} nodes), ${uncachedCount} uncached`);
                        const newGraphs: any[] = [];

                        if (uncachedCount === 0) {
                            // All files up to date - show cached graph
                            log(`✓ All ${fileContents.length} files up to date`);
                            const mergedGraph = cache.mergeGraphs(cachedGraphs);
                            webview.show(mergedGraph);
                            return;
                        }

                        // Analyze changed files in background
                        log(`Found ${uncachedCount} files needing analysis:`);
                        cacheResult.uncachedFiles.forEach(f => {
                            log(`  - ${vscode.workspace.asRelativePath(f.path)}`);
                        });

                        // Show cached graphs immediately while analyzing
                        // getMostRecentPerFile() deduplicates by file path to avoid NaN errors from conflicting entries
                        const allCached = await cache.getMostRecentPerFile();
                        if (allCached && allCached.nodes.length > 0) {
                            log(`Showing ${allCached.nodes.length} cached nodes (may include stale) while analyzing...`);
                            webview.show(allCached, { loading: true });
                        } else {
                            log(`No cached graphs to show, showing loading...`);
                            webview.showLoading(`Analyzing ${uncachedCount} file${uncachedCount !== 1 ? 's' : ''}...`);
                        }

                        const filesToAnalyze = cacheResult.uncachedFiles;
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

                        // Process batches with concurrency limiting
                        for (let i = 0; i < batches.length; i += maxConcurrency) {
                            const batchSlice = batches.slice(i, i + maxConcurrency);

                            const batchPromises = batchSlice.map(async (batch, sliceIndex) => {
                                const batchIndex = i + sliceIndex;
                                const batchPaths = batch.map(f => f.path);
                                const batchMetadata = metadata.filter(m => batchPaths.includes(m.file));
                                const combinedCode = combineFilesXML(batch, batchMetadata);

                                log(`Analyzing batch ${batchIndex + 1}/${batches.length} (${batch.length} files)...`);

                                try {
                                    const analyzeResult = await api.analyzeWorkflow(
                                        combinedCode,
                                        batchPaths,
                                        framework || undefined,
                                        batchMetadata,
                                        batchId
                                    );
                                    const graph = analyzeResult.graph;
                                    if (typeof analyzeResult.remainingAnalyses === 'number') {
                                        await auth.updateRemainingAnalyses(analyzeResult.remainingAnalyses);
                                    }

                                    newGraphs.push(graph);

                                    // Cache results per file
                                    for (const file of batch) {
                                        const fileNodes = graph.nodes.filter((n: any) => n.source?.file === file.path);
                                        const fileNodeIds = new Set(fileNodes.map((n: any) => n.id));
                                        const fileEdges = graph.edges.filter((e: any) =>
                                            fileNodeIds.has(e.source) && fileNodeIds.has(e.target)
                                        );

                                        const fileWorkflows = (graph.workflows || []).filter((wf: any) =>
                                            wf.nodeIds.some((id: string) => fileNodeIds.has(id))
                                        ).map((wf: any) => ({
                                            ...wf,
                                            nodeIds: wf.nodeIds.filter((id: string) => fileNodeIds.has(id))
                                        }));

                                        // Always cache results (even empty) to avoid re-analyzing
                                        await cache.setPerFile(file.path, file.content, {
                                            nodes: fileNodes,
                                            edges: fileEdges,
                                            llms_detected: fileNodes.length > 0 ? (graph.llms_detected || []) : [],
                                            workflows: fileWorkflows
                                        });
                                    }

                                    // Update progress and show incremental results
                                    webview.updateProgress(batchIndex + 1, batches.length);
                                    const partialMerged = cache.mergeGraphs([...cachedGraphs, ...newGraphs]);
                                    webview.updateGraph(partialMerged);

                                    log(`✓ Batch ${batchIndex + 1} complete: ${graph.nodes.length} nodes`);
                                    return graph;
                                } catch (error: any) {
                                    log(`Batch ${batchIndex + 1} failed: ${error.message}`);
                                    throw error;
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

                        log(`✓ Analysis complete: ${newGraphs.reduce((sum, g) => sum + g.nodes.length, 0)} nodes total`);
                        webview.notifyAnalysisComplete(true);

                        // Show merged graph (cached + new)
                        const mergedGraph = cache.mergeGraphs([...cachedGraphs, ...newGraphs]);
                        webview.show(mergedGraph);

                        return;
                    }
                }
            }

            // FIRST RUN: Show file picker
            // If we have cached graphs, show them BEFORE the file picker
            if (allCachedGraphs.length > 0) {
                const cachedGraph = cache.mergeGraphs(allCachedGraphs);
                webview.show(cachedGraph);
                log(`✓ Displayed ${allCachedGraphs.length} cached graphs behind file picker`);
            }

            // Get ALL source files for the picker (shows all files, not just LLM)
            const allSourceFiles = await WorkflowDetector.getAllSourceFiles();

            // Build file tree with all source files
            const { tree, totalFiles } = buildFileTree(allSourceFiles, context);

            // Show file picker immediately
            const pickerPromise = webview.showFilePicker(tree, totalFiles);

            // Update picker with LLM file selection (workflowFiles already detected)
            webview.updateFilePickerLLM(workflowFiles.map(f => f.fsPath));

            const selectedPaths = await pickerPromise;
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

            // Check per-file cache for SELECTED files (unless bypassing)
            let cachedGraphs: any[] = [];
            let filesToAnalyze = fileContents;

            if (!bypassCache) {
                log(`\nChecking per-file cache for ${selectedFiles.length} selected files...`);
                try {
                    const cacheResult = await cache.getMultiplePerFile(allPaths, allContents);
                    cachedGraphs = cacheResult.cachedGraphs;
                    filesToAnalyze = cacheResult.uncachedFiles;

                    const cachedCount = cachedGraphs.length;
                    const uncachedCount = filesToAnalyze.length;

                    if (cachedCount > 0) {
                        log(`✓ Cache HIT: ${cachedCount} file${cachedCount !== 1 ? 's' : ''} cached`);
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
            if (cachedGraphs.length > 0) {
                const cachedGraph = cache.mergeGraphs(cachedGraphs);
                webview.initGraph(cachedGraph);
                log(`✓ Displayed ${cachedGraphs.length} cached graphs (${cachedGraph.nodes.length} nodes, ${cachedGraph.edges.length} edges)`);
            } else {
                // For fresh repos with no cached graphs, close file picker immediately
                // so the loading indicator is visible during analysis
                webview.closeFilePicker();
            }

            // Store newly analyzed graphs
            const newGraphs: any[] = [];

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

                    // Helper to cache files immediately after batch completes
                    async function cacheFilesFromGraph(
                        files: { path: string; content: string }[],
                        graph: WorkflowGraph
                    ) {
                        for (const file of files) {
                            const fileNodes = graph.nodes.filter((n: any) => n.source?.file === file.path);
                            const fileNodeIds = new Set(fileNodes.map((n: any) => n.id));
                            const fileEdges = graph.edges.filter((e: any) =>
                                fileNodeIds.has(e.source) && fileNodeIds.has(e.target)
                            );

                            // Only include workflows that contain nodes from this file
                            const fileWorkflows = (graph.workflows || []).filter((wf: any) =>
                                wf.nodeIds.some((id: string) => fileNodeIds.has(id))
                            ).map((wf: any) => ({
                                ...wf,
                                nodeIds: wf.nodeIds.filter((id: string) => fileNodeIds.has(id))
                            }));

                            const isolatedGraph = {
                                nodes: fileNodes,
                                edges: fileEdges,
                                llms_detected: graph.llms_detected || [],
                                workflows: fileWorkflows
                            };

                            if (!bypassCache) {
                                if (fileNodes.length > 0) {
                                    await cache.setPerFile(file.path, file.content, isolatedGraph);
                                } else {
                                    log(`  ${vscode.workspace.asRelativePath(file.path)} has no LLM nodes, caching empty result`);
                                    await cache.setPerFile(file.path, file.content, {
                                        nodes: [],
                                        edges: [],
                                        llms_detected: [],
                                        workflows: []
                                    });
                                }
                            }
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
                            return analyzeBatch(batch, batchIndex, batches.length, framework, metadata, cache, newGraphs)
                                .then(async (batchGraph) => {
                                    completedBatchCount++;
                                    if (batchGraph) {
                                        // Cache files from this batch immediately
                                        await cacheFilesFromGraph(batch, batchGraph);
                                        log(`✓ Cached ${batch.length} files from batch ${batchIndex + 1}`);

                                        // Incremental graph update - merge all graphs so far and send to webview
                                        const partialMerged = cache.mergeGraphs([...cachedGraphs, ...newGraphs]);
                                        webview.updateGraph(partialMerged);
                                        log(`✓ Updated webview with ${partialMerged.nodes.length} nodes`);
                                    }
                                    // Update progress bar
                                    webview.updateProgress(completedBatchCount, batches.length);
                                    log(`✓ Progress: ${completedBatchCount}/${batches.length} batches`);
                                });
                        });

                        await Promise.all(chunkPromises);
                    }

                    async function analyzeBatch(
                        batch: { path: string; content: string; }[],
                        batchIndex: number,
                        totalBatches: number,
                        framework: string | null,
                        allMetadata: any[],
                        cacheManager: typeof cache,
                        graphs: any[]
                    ) {
                        const batchPaths = batch.map(f => f.path);
                        const batchMetadata = allMetadata.filter(m => batchPaths.includes(m.file));

                        log(`\nAnalyzing batch ${batchIndex + 1}/${totalBatches} (${batch.length} files)...`);
                        log(`Files in batch:`);
                        batch.forEach(f => {
                            const relativePath = vscode.workspace.asRelativePath(f.path);
                            const sizeKb = Math.round(f.content.length / 1024);
                            log(`  - ${relativePath} (${sizeKb} KB)`);
                        });

                        try {
                            // Combine batch files for analysis in XML format
                            const combinedBatchCode = combineFilesXML(batch, batchMetadata);
                            const batchTokens = estimateTokens(combinedBatchCode);

                            log(`Sending POST /analyze: ${batch.length} file(s), ~${Math.round(batchTokens / 1000)}k tokens, framework: ${framework || 'none'}`);
                            const batchResult = await api.analyzeWorkflow(
                                combinedBatchCode,
                                batchPaths,
                                framework || undefined,
                                batchMetadata,
                                batchId
                            );
                            const batchGraph = batchResult.graph;
                            if (typeof batchResult.remainingAnalyses === 'number') {
                                await auth.updateRemainingAnalyses(batchResult.remainingAnalyses);
                            }

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

                            // If batch fails (safety filter, etc), try analyzing files individually
                            log(`Batch ${batchIndex + 1} failed: ${batchError.message}`);
                            log(`Falling back to individual file analysis for this batch...`);

                            // Parallelize individual file analysis (use same concurrency limit)
                            const fallbackPromises = batch.map((file, fileIndex) => {
                                return async () => {
                                    const fileMeta = batchMetadata.find(m => m.file === file.path);
                                    const relativePath = vscode.workspace.asRelativePath(file.path);
                                    const sizeKb = Math.round(file.content.length / 1024);

                                    try {
                                        log(`  Analyzing file ${fileIndex + 1}/${batch.length}: ${relativePath} (${sizeKb} KB)`);
                                        log(`  Sending POST /analyze: 1 file, framework: ${framework || 'none'}`);

                                        const fileResult = await api.analyzeWorkflow(
                                            formatFileXML(file.path, file.content, fileMeta),
                                            [file.path],
                                            framework || undefined,
                                            fileMeta ? [fileMeta] : [],
                                            batchId
                                        );
                                        const fileGraph = fileResult.graph;
                                        if (typeof fileResult.remainingAnalyses === 'number') {
                                            await auth.updateRemainingAnalyses(fileResult.remainingAnalyses);
                                        }

                                        graphs.push(fileGraph);
                                        log(`  Fallback file complete: ${fileGraph.nodes.length} nodes`);

                                        // Cache successful fallback analysis immediately
                                        if (!bypassCache) {
                                            await cache.setPerFile(file.path, file.content, fileGraph);
                                            log(`  Cached ${relativePath}`);
                                        }
                                    } catch (fileError: any) {
                                        // Re-throw trial exhaustion so outer handler can queue retry
                                        if (fileError instanceof TrialExhaustedError) {
                                            throw fileError;
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
                    webview.notifyAnalysisComplete(true);
                } else {
                    log(`\n✓ All files cached, no analysis needed`);
                }

            // Merge all graphs: cached + newly analyzed
            const graph = cache.mergeGraphs([...cachedGraphs, ...newGraphs]);
            log(`\n✓ Final graph: ${cachedGraphs.length} cached + ${newGraphs.length} new = ${graph.nodes.length} nodes, ${graph.edges.length} edges`);

            // Update file selection cache with which files actually have LLM calls
            const analyzedFilePaths = selectedFiles.map(f => f.fsPath);
            const filesWithLLMCalls = new Set<string>();
            for (const node of graph.nodes) {
                if (node.source?.file) {
                    // Convert relative path to absolute if needed
                    const workspaceRoot = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
                    if (workspaceRoot) {
                        const absolutePath = node.source.file.startsWith('/')
                            ? node.source.file
                            : vscode.Uri.file(workspaceRoot + '/' + node.source.file).fsPath;
                        filesWithLLMCalls.add(absolutePath);
                    }
                }
            }
            await updateLLMStatus(context, analyzedFilePaths, Array.from(filesWithLLMCalls));

            if (graph.nodes.length === 0 && graph.edges.length === 0) {
                webview.notifyWarning('No workflows detected. Check your files use supported LLM APIs.');
                log('⚠️  Final graph is empty - all files rejected or contain no LLM usage');
            }

            // Single show() at end with complete graph (no loading indicator)
            webview.show(graph);
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

            // Get ALL cached graphs BEFORE invalidating (includes stale version of changed file)
            const allCachedGraphs = await cache.getAllCachedGraphs();

            // Show cached graph immediately with loading indicator
            if (allCachedGraphs.length > 0) {
                const cachedGraph = cache.mergeGraphs(allCachedGraphs);
                webview.show(cachedGraph, { loading: true });
            } else {
                webview.showLoading(`Updating ${vscode.workspace.asRelativePath(filePath)}...`);
            }

            // NOW invalidate cache for this file
            await cache.invalidateFile(filePath);

            // Analyze single file
            const analyzeResult = await api.analyzeWorkflow(content, [filePath]);
            const result = analyzeResult.graph;
            if (typeof analyzeResult.remainingAnalyses === 'number') {
                await auth.updateRemainingAnalyses(analyzeResult.remainingAnalyses);
            }

            if (result && result.nodes && result.nodes.length > 0) {
                // Cache the new result
                await cache.setPerFile(filePath, content, result);
                log(`✓ Updated cache for ${vscode.workspace.asRelativePath(filePath)}: ${result.nodes.length} nodes`);
            } else {
                // Cache empty result
                await cache.setPerFile(filePath, content, {
                    nodes: [],
                    edges: [],
                    llms_detected: [],
                    workflows: []
                });
                log(`⚠️  No nodes found after update`);
            }

            // Get all cached graphs and merge
            const allGraphs = await cache.getAllCachedGraphs();
            const mergedGraph = cache.mergeGraphs(allGraphs);

            // Update webview with merged graph
            webview.show(mergedGraph);
            webview.notifyAnalysisComplete(true);

            const duration = Date.now() - startTime;
            const seconds = (duration / 1000).toFixed(1);
            log(`✓ Graph updated: ${mergedGraph.nodes.length} nodes, ${mergedGraph.edges.length} edges (${seconds}s)`);
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
            const pickerPromise = webview.showFilePicker(tree, totalFiles);

            // Background: detect LLM files and update picker with badges
            WorkflowDetector.detectInWorkspace().then(llmFiles => {
                webview.updateFilePickerLLM(llmFiles.map(f => f.fsPath));
            });

            const selectedPaths = await pickerPromise;

            if (!selectedPaths || selectedPaths.length === 0) {
                return; // User cancelled
            }

            // Save selection and trigger analysis for selected files
            await saveFilePickerSelection(context, allFiles, selectedPaths);

            // Read selected files
            const fileContents: { path: string; content: string; }[] = [];
            const batchId = `batch-${Date.now()}-${Math.random().toString(16).slice(2)}`;
            for (const filePath of selectedPaths) {
                try {
                    const uri = vscode.Uri.file(filePath);
                    const content = await vscode.workspace.fs.readFile(uri);
                    fileContents.push({ path: filePath, content: Buffer.from(content).toString('utf8') });
                } catch (error) {
                    log(`⚠️  Skipping file (read error): ${filePath}`);
                }
            }

            // Check cache
            const allPaths = fileContents.map(f => f.path);
            const allContents = fileContents.map(f => f.content);
            const cacheResult = await cache.getMultiplePerFile(allPaths, allContents);

            if (cacheResult.cachedGraphs.length > 0) {
                const cachedGraph = cache.mergeGraphs(cacheResult.cachedGraphs);
                webview.initGraph(cachedGraph);
            }

            // If there are uncached files, analyze them in batches
            if (cacheResult.uncachedFiles.length > 0) {
                log(`Analyzing ${cacheResult.uncachedFiles.length} uncached files...`);
                webview.notifyAnalysisStarted();

                const uncachedUris = cacheResult.uncachedFiles.map(f => vscode.Uri.file(f.path));
                const metadata = await metadataBuilder.buildMetadata(uncachedUris);

                let framework: string | null = null;
                for (const file of cacheResult.uncachedFiles) {
                    framework = WorkflowDetector.detectFramework(file.content);
                    if (framework) break;
                }

                // Create dependency-based batches (same as main analysis flow)
                const batches = createDependencyBatches(
                    cacheResult.uncachedFiles,
                    metadata,
                    CONFIG.BATCH.MAX_SIZE,
                    CONFIG.BATCH.MAX_TOKENS
                );
                log(`Created ${batches.length} batch${batches.length > 1 ? 'es' : ''}`);

                const newGraphs: any[] = [];

                // Process batches
                for (let i = 0; i < batches.length; i++) {
                    const batch = batches[i];
                    const batchPaths = batch.map(f => f.path);
                    const batchMetadata = metadata.filter(m => batchPaths.includes(m.file));

                    log(`Analyzing batch ${i + 1}/${batches.length} (${batch.length} files)...`);

                    try {
                        const combinedCode = combineFilesXML(batch, batchMetadata);
                        const batchResult = await api.analyzeWorkflow(
                            combinedCode,
                            batchPaths,
                            framework || undefined,
                            batchMetadata,
                            batchId
                        );
                        const batchGraph = batchResult.graph;

                        if (typeof batchResult.remainingAnalyses === 'number') {
                            await auth.updateRemainingAnalyses(batchResult.remainingAnalyses);
                        }

                        newGraphs.push(batchGraph);

                        // Cache files from this batch
                        for (const file of batch) {
                            const fileNodes = batchGraph.nodes.filter((n: any) => n.source?.file === file.path);
                            const fileNodeIds = new Set(fileNodes.map((n: any) => n.id));
                            const fileEdges = batchGraph.edges.filter((e: any) =>
                                fileNodeIds.has(e.source) && fileNodeIds.has(e.target)
                            );

                            const fileWorkflows = (batchGraph.workflows || []).filter((wf: any) =>
                                wf.nodeIds.some((id: string) => fileNodeIds.has(id))
                            ).map((wf: any) => ({
                                ...wf,
                                nodeIds: wf.nodeIds.filter((id: string) => fileNodeIds.has(id))
                            }));

                            await cache.setPerFile(file.path, file.content, {
                                nodes: fileNodes,
                                edges: fileEdges,
                                llms_detected: batchGraph.llms_detected || [],
                                workflows: fileWorkflows
                            });
                        }

                        log(`Batch ${i + 1} complete: ${batchGraph.nodes.length} nodes`);
                    } catch (batchError: any) {
                        log(`Batch ${i + 1} failed: ${batchError.message}`);
                    }
                }

                // Merge all graphs
                const allGraphs = [...cacheResult.cachedGraphs, ...newGraphs];
                const mergedGraph = cache.mergeGraphs(allGraphs);
                webview.updateGraph(mergedGraph);
                webview.notifyAnalysisComplete(true);
            }
        })
    );
}

export function deactivate() {}
