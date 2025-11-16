import * as vscode from 'vscode';
import { APIClient } from './api';
import { AuthManager } from './auth';
import { CacheManager } from './cache';
import { WorkflowDetector } from './analyzer';
import { WebviewManager } from './webview';
import { metadataBuilder, FileMetadata } from './metadata-builder';

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

    log('Extension activated successfully');
    outputChannel.show();

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
            const errorMsg = error.response?.data?.detail || error.message;
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

        // Show webview immediately with loading state
        webview.showLoading("Scanning workspace for AI workflows...");

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

            // Check workspace-level cache first (unless bypassing)
            let graph;
            if (!bypassCache) {
                log(`\nChecking workspace cache for ${workflowFiles.length} files...`);
                try {
                    const cachedGraph = await cache.getWorkspace(allPaths, allContents);
                    if (cachedGraph) {
                        log(`✓ Cache HIT: Using cached workspace graph (${cachedGraph.nodes.length} nodes, ${cachedGraph.edges.length} edges)`);
                        graph = cachedGraph;
                    } else {
                        log(`✗ Cache MISS: Analyzing all ${workflowFiles.length} files`);
                    }
                } catch (cacheError: any) {
                    log(`⚠️  Cache check failed: ${cacheError.message}, proceeding with analysis`);
                    console.warn('Cache check error:', cacheError);
                }
            } else {
                log(`\nBypassing cache, analyzing all ${workflowFiles.length} files`);
            }

            if (!graph) {
                    // Analyze all files in batches
                    webview.notifyAnalysisStarted();

                    // Build metadata for all files
                    log(`\nBuilding metadata for ${workflowFiles.length} files...`);
                    const metadata = await metadataBuilder.buildMetadata(workflowFiles);
                    const totalLocations = metadata.reduce((sum, m) => sum + m.locations.length, 0);
                    log(`Found ${totalLocations} code locations`);

                    // Create dependency-based batches with token limits
                    const batches = createDependencyBatches(fileContents, metadata, 15, 800000);
                    log(`\nCreated ${batches.length} batches based on file dependencies:`);
                    for (let i = 0; i < batches.length; i++) {
                        const batchTokens = batches[i].reduce((sum, f) => sum + estimateTokens(f.content), 0);
                        log(`  Batch ${i + 1}: ${batches[i].length} files (~${Math.round(batchTokens / 1000)}k tokens)`);
                    }

                    // Detect framework from all files
                    let framework: string | null = null;
                    for (const file of fileContents) {
                        framework = WorkflowDetector.detectFramework(file.content);
                        if (framework) break;
                    }

                    log(`Detected framework: ${framework || 'generic LLM usage'}`);

                    // Analyze batches in parallel (limit concurrency to avoid rate limits)
                    const newGraphs: any[] = [];
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

                            // Update progress and show partial results
                            webview.updateProgress(batchIndex + 1, totalBatches);
                            const mergedSoFar = cache.mergeGraphs(graphs);
                            webview.updateGraph(mergedSoFar);
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
                                        // Continue with other files
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

                    // Merge all batch graphs into final workspace graph
                    graph = cache.mergeGraphs(newGraphs);

                    // Cache the final workspace graph
                    await cache.setWorkspace(allPaths, allContents, graph);
                    log(`\n✓ Saved to cache: workspace graph with ${graph.nodes.length} nodes, ${graph.edges.length} edges`);

                    // Calculate and log duration
                    const duration = Date.now() - startTime;
                    const minutes = Math.floor(duration / 60000);
                    const seconds = Math.floor((duration % 60000) / 1000);
                    const timeStr = minutes > 0 ? `${minutes} minute${minutes !== 1 ? 's' : ''} ${seconds} second${seconds !== 1 ? 's' : ''}` : `${seconds} second${seconds !== 1 ? 's' : ''}`;

                    log(`\nAnalysis complete: ${graph.nodes.length} nodes, ${graph.edges.length} edges`);
                    log(`Total time: ${timeStr}`);
                    webview.notifyAnalysisComplete(true);
                }

            webview.show(graph);
        } catch (error: any) {
            log(`ERROR: ${error.message}`);
            log(`Status: ${error.response?.status}`);
            log(`Response: ${JSON.stringify(error.response?.data)}`);
            const errorMsg = error.response?.data?.detail || error.message;
            webview.notifyAnalysisComplete(false, errorMsg);
            vscode.window.showErrorMessage(`Workspace scan failed: ${errorMsg}`);
        }
    }

    context.subscriptions.push(
        vscode.commands.registerCommand('aiworkflowviz.visualizeWorkspace', async () => {
            await analyzeWorkspace(false);
        })
    );
}

export function deactivate() {}
