import * as vscode from 'vscode';
import { APIClient } from './api';
import { AuthManager } from './auth';
import { CacheManager } from './cache';
import { WorkflowDetector } from './analyzer';
import { WebviewManager } from './webview';
import { metadataBuilder, FileMetadata } from './metadata-builder';
import { registerWorkflowParticipant } from './copilot/workflow-participant';
import { registerWorkflowTool } from './copilot/workflow-tool';
import { registerWorkflowQueryTool } from './copilot/workflow-query-tool';
import { registerNodeQueryTool } from './copilot/node-query-tool';
import { registerWorkflowNavigateTool } from './copilot/workflow-navigate-tool';

const outputChannel = vscode.window.createOutputChannel('AI Workflow Visualizer');

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
 * Create batches of files based on dependency relationships
 * Groups related files together while respecting token limits
 */
function createDependencyBatches(
    files: { path: string; content: string; }[],
    metadata: FileMetadata[],
    maxBatchSize: number = 15,
    maxTokensPerBatch: number = 800000  // Keep well under 1M limit
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

export function activate(context: vscode.ExtensionContext) {
    log('AI Workflow Visualizer activating...');

    const config = vscode.workspace.getConfiguration('aiworkflowviz');
    const apiUrl = config.get<string>('apiUrl', 'http://localhost:8000');

    log(`Backend API URL: ${apiUrl}`);

    const api = new APIClient(apiUrl, outputChannel);
    const auth = new AuthManager(context, api);
    const cache = new CacheManager(context);
    const webview = new WebviewManager(context);

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

    // 3. Workflow Query Tool - Allows LLM to query complete workflows by name
    const workflowQueryTool = registerWorkflowQueryTool(cache, () => webview.getViewState());
    if (workflowQueryTool) {
        context.subscriptions.push(workflowQueryTool);
        log('Registered workflow-query tool');
    }

    // 4. Node Query Tool - Allows LLM to filter and search nodes
    const nodeQueryTool = registerNodeQueryTool(cache, () => webview.getViewState());
    if (nodeQueryTool) {
        context.subscriptions.push(nodeQueryTool);
        log('Registered node-query tool');
    }

    // 5. Workflow Navigate Tool - Allows LLM to find paths and analyze dependencies
    const navigateTool = registerWorkflowNavigateTool(cache, () => webview.getViewState());
    if (navigateTool) {
        context.subscriptions.push(navigateTool);
        log('Registered workflow-navigate tool');
    }

    // 6. Chat Participant - Explicit @workflow mention (100% reliable)
    context.subscriptions.push(registerWorkflowParticipant(context, cache, () => webview.getViewState()));
    log('Registered @workflow chat participant (explicit)');

    // File watching for auto-refresh on save
    const fileWatcher = vscode.workspace.createFileSystemWatcher(
        '**/*.{py,ts,js,jsx,tsx,mjs,cjs}',
        false, // ignoreCreateEvents
        false, // ignoreChangeEvents
        true   // ignoreDeleteEvents
    );

    // Shared debounce mechanism to batch file changes
    const pendingChanges = new Map<string, NodeJS.Timeout>();
    const DEBOUNCE_MS = 2000; // 2 second debounce to handle compilation + multiple saves

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
        vscode.commands.registerCommand('aiworkflowviz.applyCodeModification', async (modification: {
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
                        `Code inserted via @workflow at line ${modification.line}`
                    );
                } else {
                    // For modify
                    success = await codeModifier.modifyNode(
                        modification.file,
                        modification.line,
                        'Node',
                        modification.code,
                        `Code modified via @workflow at line ${modification.line}`
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
        vscode.commands.registerCommand('aiworkflowviz.focusNode', (nodeId: string, nodeLabel?: string) => {
            log(`Focusing on node: ${nodeId} (${nodeLabel || 'unknown'})`);
            webview.focusNode(nodeId);
        })
    );

    log('Extension activated successfully');

    context.subscriptions.push(
        vscode.commands.registerCommand('aiworkflowviz.login', () => auth.login())
    );

    context.subscriptions.push(
        vscode.commands.registerCommand('aiworkflowviz.register', () => auth.register())
    );

    context.subscriptions.push(
        vscode.commands.registerCommand('aiworkflowviz.logout', () => auth.logout())
    );

    async function analyzeCurrentFile(bypassCache: boolean = false) {
        const editor = vscode.window.activeTextEditor;
        if (!editor) {
            vscode.window.showWarningMessage('No active file');
            return;
        }

        const document = editor.document;
        const content = document.getText();
        const filePath = document.uri.fsPath;

        log(`Visualizing file: ${filePath}${bypassCache ? ' (bypassing cache)' : ''}`);

        if (!WorkflowDetector.isWorkflowFile(document.uri)) {
            vscode.window.showWarningMessage('File type not supported');
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
                vscode.window.showInformationMessage('Analyzing workflow...');
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

                graph = await api.analyzeWorkflow(content, [filePath], framework || undefined, [metadata]);
                await cache.setPerFile(filePath, content, graph);

                // Calculate and log duration
                const duration = Date.now() - startTime;
                const minutes = Math.floor(duration / 60000);
                const seconds = Math.floor((duration % 60000) / 1000);
                const timeStr = minutes > 0 ? `${minutes} minute${minutes !== 1 ? 's' : ''} ${seconds} second${seconds !== 1 ? 's' : ''}` : `${seconds} second${seconds !== 1 ? 's' : ''}`;
                log(`Analysis complete in ${timeStr}, cached result`);
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
            vscode.window.showErrorMessage(`Analysis failed: ${errorMsg}`);
        }
    }

    context.subscriptions.push(
        vscode.commands.registerCommand('aiworkflowviz.visualize', async () => {
            await analyzeCurrentFile(false);
        })
    );

    context.subscriptions.push(
        vscode.commands.registerCommand('aiworkflowviz.refresh', async () => {
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

    async function analyzeWorkspace(bypassCache: boolean = false) {
        // TODO: Re-enable auth when ready
        // if (!auth.isAuthenticated()) {
        //     vscode.window.showWarningMessage('Please login first');
        //     return;
        // }

        // Show notification with timeout (5 seconds)
        vscode.window.withProgress({
            location: vscode.ProgressLocation.Notification,
            title: 'Scanning workspace for AI workflows...',
            cancellable: false
        }, async (progress) => {
            // Keep notification visible for 5 seconds
            await new Promise(resolve => setTimeout(resolve, 5000));
        });

        // Track analysis start time
        const startTime = Date.now();

        log('Starting workspace scan...');
        log(`Workspace root: ${vscode.workspace.workspaceFolders?.[0]?.uri.fsPath}`);

        try {
            const workflowFiles = await WorkflowDetector.detectInWorkspace();
            log(`Found ${workflowFiles.length} workflow files:`);

            if (workflowFiles.length === 0) {
                vscode.window.showInformationMessage('No AI workflow files found in workspace');
                return;
            }

            // Read all workflow files
            const fileContents: { path: string; content: string; }[] = [];
            for (const uri of workflowFiles) {
                const relativePath = vscode.workspace.asRelativePath(uri);
                log(`  - ${relativePath}`);

                try {
                    const content = await vscode.workspace.fs.readFile(uri);
                    const text = Buffer.from(content).toString('utf8');
                    fileContents.push({
                        path: uri.fsPath,
                        content: text
                    });
                } catch (error) {
                    console.warn(`⚠️  Skipping file (read error): ${uri.fsPath}`, error);
                }
            }

            const allPaths = fileContents.map(f => f.path);
            const allContents = fileContents.map(f => f.content);

            // Check per-file cache FIRST (unless bypassing)
            let cachedGraphs: any[] = [];
            let filesToAnalyze = fileContents;

            if (!bypassCache) {
                log(`\nChecking per-file cache for ${workflowFiles.length} files...`);
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
                log(`\nBypassing cache, analyzing all ${workflowFiles.length} files`);
            }

            // Show cached data immediately if available
            if (cachedGraphs.length > 0) {
                const cachedGraph = cache.mergeGraphs(cachedGraphs);
                webview.show(cachedGraph);
                log(`✓ Displayed ${cachedGraphs.length} cached graphs (${cachedGraph.nodes.length} nodes, ${cachedGraph.edges.length} edges)`);
            } else {
                // No cache, show loading screen
                webview.showLoading("Scanning workspace for AI workflows...");
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
                    const batches = createDependencyBatches(filesToAnalyze, metadata, 15, 800000);
                    log(`\nCreated ${batches.length} batches based on file dependencies:`);
                    for (let i = 0; i < batches.length; i++) {
                        const batchTokens = batches[i].reduce((sum, f) => sum + estimateTokens(f.content), 0);
                        log(`  Batch ${i + 1}: ${batches[i].length} files (~${Math.round(batchTokens / 1000)}k tokens)`);
                    }

                    // Detect framework from uncached files
                    let framework: string | null = null;
                    for (const file of filesToAnalyze) {
                        framework = WorkflowDetector.detectFramework(file.content);
                        if (framework) break;
                    }

                    log(`Detected framework: ${framework || 'generic LLM usage'}`);

                    // Analyze batches in parallel (limit concurrency to avoid rate limits)
                    const maxConcurrency = 10;  // Gemini Flash supports ~25 req/sec (1500 RPM)

                    // Process batches in chunks of maxConcurrency
                    for (let chunkStart = 0; chunkStart < batches.length; chunkStart += maxConcurrency) {
                        const chunkEnd = Math.min(chunkStart + maxConcurrency, batches.length);
                        const batchChunk = batches.slice(chunkStart, chunkEnd);

                        // Process this chunk in parallel
                        const chunkPromises = batchChunk.map((batch, chunkIdx) => {
                            const batchIndex = chunkStart + chunkIdx;
                            return analyzeBatch(batch, batchIndex, batches.length, framework, metadata, cache, newGraphs);
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
                        vscode.window.showInformationMessage(`Analyzing batch ${batchIndex + 1}/${totalBatches}...`);

                        try {
                            // Combine batch files for analysis
                            const combinedBatchCode = batch.map(f =>
                                `# File: ${f.path}\n${f.content}`
                            ).join('\n\n');

                            log(`Sending POST /analyze: ${batch.length} file(s), framework: ${framework || 'none'}`);
                            const batchGraph = await api.analyzeWorkflow(
                                combinedBatchCode,
                                batchPaths,
                                framework || undefined,
                                batchMetadata
                            );

                            graphs.push(batchGraph);
                            log(`Batch ${batchIndex + 1} complete: ${batchGraph.nodes.length} nodes, ${batchGraph.edges.length} edges`);

                            // Update progress
                            webview.updateProgress(batchIndex + 1, totalBatches);
                        } catch (batchError: any) {
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

                                        const fileGraph = await api.analyzeWorkflow(
                                            `# File: ${file.path}\n${file.content}`,
                                            [file.path],
                                            framework || undefined,
                                            fileMeta ? [fileMeta] : []
                                        );

                                        graphs.push(fileGraph);
                                        log(`  Fallback file complete: ${fileGraph.nodes.length} nodes`);
                                    } catch (fileError: any) {
                                        log(`  Failed to analyze ${file.path}: ${fileError.message}`);
                                        log(`  ${relativePath} is unrelated to LLM workflows, caching empty result`);
                                        // Cache empty graph to prevent infinite retries
                                        await cache.setPerFile(file.path, file.content, {
                                            nodes: [],
                                            edges: [],
                                            llms_detected: [],
                                            workflows: []
                                        });
                                    }
                                };
                            });

                            // Process fallback files in parallel chunks
                            for (let i = 0; i < fallbackPromises.length; i += maxConcurrency) {
                                const chunk = fallbackPromises.slice(i, i + maxConcurrency);
                                await Promise.all(chunk.map(fn => fn()));
                            }
                        }
                    }

                    // Cache each newly analyzed file individually
                    log(`\n✓ Caching ${filesToAnalyze.length} newly analyzed files...`);
                    for (const file of filesToAnalyze) {
                        // Find the graph that contains nodes from this file
                        const fileGraph = newGraphs.find(g => g.nodes.some((n: any) => n.source?.file === file.path));
                        if (fileGraph) {
                            // Extract only nodes/edges for this specific file
                            const fileNodes = fileGraph.nodes.filter((n: any) => n.source?.file === file.path);
                            const fileNodeIds = new Set(fileNodes.map((n: any) => n.id));
                            const fileEdges = fileGraph.edges.filter((e: any) =>
                                fileNodeIds.has(e.source) && fileNodeIds.has(e.target)
                            );

                            const isolatedGraph = {
                                nodes: fileNodes,
                                edges: fileEdges,
                                llms_detected: fileGraph.llms_detected || [],
                                workflows: fileGraph.workflows || []
                            };

                            await cache.setPerFile(file.path, file.content, isolatedGraph);
                        } else {
                            // File produced no nodes (rejected by LLM or no LLM usage)
                            // Cache empty graph to prevent retries
                            log(`  ${vscode.workspace.asRelativePath(file.path)} is unrelated to LLM workflows, caching empty result`);
                            await cache.setPerFile(file.path, file.content, {
                                nodes: [],
                                edges: [],
                                llms_detected: [],
                                workflows: []
                            });
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


            // Show final graph (or update if cached was already shown)
            if (graph.nodes.length === 0 && graph.edges.length === 0) {
                vscode.window.showWarningMessage(
                    'No workflows detected. Files may have been rejected by the LLM or contain no LLM usage.'
                );
                log('⚠️  Final graph is empty - all files rejected or contain no LLM usage');
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
            vscode.window.showErrorMessage(`Workspace scan failed: ${errorMsg}`);
        }
    }

    async function analyzeAndUpdateSingleFile(uri: vscode.Uri) {
        try {
            const filePath = uri.fsPath;
            log(`\n=== Incremental File Analysis ===`);
            log(`File: ${vscode.workspace.asRelativePath(filePath)}`);

            // Read file content
            const document = await vscode.workspace.openTextDocument(uri);
            const content = document.getText();

            // Invalidate cache for this file
            await cache.invalidateFile(filePath);

            // Show loading indicator
            webview.showLoading(`Updating ${vscode.workspace.asRelativePath(filePath)}...`);

            // Analyze single file
            const result = await api.analyzeWorkflow(content, [filePath]);

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

            // Update webview incrementally
            webview.show(mergedGraph, true); // true = incremental update
            webview.notifyAnalysisComplete(true);

            log(`✓ Graph updated: ${mergedGraph.nodes.length} nodes, ${mergedGraph.edges.length} edges`);
        } catch (error: any) {
            log(`ERROR updating file: ${error.message}`);
            webview.notifyAnalysisComplete(false, error.message);
        }
    }

    context.subscriptions.push(
        vscode.commands.registerCommand('aiworkflowviz.visualizeWorkspace', async () => {
            await analyzeWorkspace(false);
        })
    );
}

export function deactivate() {}
