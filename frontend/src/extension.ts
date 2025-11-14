import * as vscode from 'vscode';
import { APIClient } from './api';
import { AuthManager } from './auth';
import { CacheManager } from './cache';
import { WorkflowDetector } from './analyzer';
import { WebviewManager } from './webview';
import { metadataBuilder, FileMetadata } from './metadata-builder';

const outputChannel = vscode.window.createOutputChannel('AI Workflow Visualizer');

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
    outputChannel.appendLine('AI Workflow Visualizer activating...');

    const config = vscode.workspace.getConfiguration('aiworkflowviz');
    const apiUrl = config.get<string>('apiUrl', 'http://localhost:8000');

    outputChannel.appendLine(`Backend API URL: ${apiUrl}`);

    const api = new APIClient(apiUrl, outputChannel);
    const auth = new AuthManager(context, api);
    const cache = new CacheManager(context);
    const webview = new WebviewManager(context);

    outputChannel.appendLine('Extension activated successfully');
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

        outputChannel.appendLine(`Visualizing file: ${filePath}${bypassCache ? ' (bypassing cache)' : ''}`);

        if (!WorkflowDetector.isWorkflowFile(document.uri)) {
            vscode.window.showWarningMessage('File type not supported');
            outputChannel.appendLine(`File type not supported: ${filePath}`);
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

                // Build metadata using static analysis
                outputChannel.appendLine(`Building metadata with static analysis...`);
                const metadata = await metadataBuilder.buildSingleFileMetadata(document.uri);
                outputChannel.appendLine(`Found ${metadata.locations.length} code locations`);

                const framework = WorkflowDetector.detectFramework(content);
                outputChannel.appendLine(`Detected framework: ${framework || 'none'}`);

                const relativePath = vscode.workspace.asRelativePath(filePath);
                const sizeKb = Math.round(content.length / 1024);
                outputChannel.appendLine(`File: ${relativePath} (${sizeKb} KB)`);
                outputChannel.appendLine(`Sending POST /analyze: 1 file, framework: ${framework || 'none'}`);

                graph = await api.analyzeWorkflow(content, [filePath], framework || undefined, [metadata]);
                await cache.setPerFile(filePath, content, graph);
                outputChannel.appendLine(`Analysis complete, cached result`);
                webview.notifyAnalysisComplete(true);
            } else {
                outputChannel.appendLine(`Using cached result for ${filePath}`);
            }

            webview.show(graph);
        } catch (error: any) {
            outputChannel.appendLine(`ERROR: ${error.message}`);
            outputChannel.appendLine(`Status: ${error.response?.status}`);
            outputChannel.appendLine(`Response: ${JSON.stringify(error.response?.data)}`);
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
            await analyzeCurrentFile(true);
        })
    );

    context.subscriptions.push(
        vscode.commands.registerCommand('aiworkflowviz.visualizeWorkspace', async () => {
            // TODO: Re-enable auth when ready
            // if (!auth.isAuthenticated()) {
            //     vscode.window.showWarningMessage('Please login first');
            //     return;
            // }

            vscode.window.showInformationMessage('Scanning workspace for AI workflows...');
            outputChannel.appendLine('Starting workspace scan...');
            outputChannel.appendLine(`Workspace root: ${vscode.workspace.workspaceFolders?.[0]?.uri.fsPath}`);

            try {
                const workflowFiles = await WorkflowDetector.detectInWorkspace();
                outputChannel.appendLine(`Found ${workflowFiles.length} workflow files:`);

                if (workflowFiles.length === 0) {
                    vscode.window.showInformationMessage('No AI workflow files found in workspace');
                    return;
                }

                // Read all workflow files
                const fileContents: { path: string; content: string; }[] = [];
                for (const uri of workflowFiles) {
                    const relativePath = vscode.workspace.asRelativePath(uri);
                    outputChannel.appendLine(`  - ${relativePath}`);

                    const content = await vscode.workspace.fs.readFile(uri);
                    const text = Buffer.from(content).toString('utf8');
                    fileContents.push({
                        path: uri.fsPath,
                        content: text
                    });
                }

                const allPaths = fileContents.map(f => f.path);

                // Check per-file cache first
                const allContents = fileContents.map(f => f.content);
                const { cachedGraphs, uncachedFiles } = await cache.getMultiplePerFile(allPaths, allContents);

                outputChannel.appendLine(`\nCache status: ${cachedGraphs.length} files cached, ${uncachedFiles.length} files need analysis`);

                let graph;
                if (uncachedFiles.length === 0) {
                    // All files cached
                    outputChannel.appendLine(`Using cached results for all ${workflowFiles.length} files`);
                    graph = cache.mergeGraphs(cachedGraphs);
                } else {
                    // Analyze uncached files in batches
                    webview.notifyAnalysisStarted();

                    // Build metadata only for uncached files
                    outputChannel.appendLine(`\nBuilding metadata for ${uncachedFiles.length} uncached files...`);
                    const uncachedUris = workflowFiles.filter(uri =>
                        uncachedFiles.some(f => f.path === uri.fsPath)
                    );
                    const metadata = await metadataBuilder.buildMetadata(uncachedUris);
                    const totalLocations = metadata.reduce((sum, m) => sum + m.locations.length, 0);
                    outputChannel.appendLine(`Found ${totalLocations} code locations`);

                    // Create dependency-based batches with token limits
                    const batches = createDependencyBatches(uncachedFiles, metadata, 15, 800000);
                    outputChannel.appendLine(`\nCreated ${batches.length} batches based on file dependencies:`);
                    for (let i = 0; i < batches.length; i++) {
                        const batchTokens = batches[i].reduce((sum, f) => sum + estimateTokens(f.content), 0);
                        outputChannel.appendLine(`  Batch ${i + 1}: ${batches[i].length} files (~${Math.round(batchTokens / 1000)}k tokens)`);
                    }

                    // Detect framework from uncached files
                    let framework: string | null = null;
                    for (const file of uncachedFiles) {
                        framework = WorkflowDetector.detectFramework(file.content);
                        if (framework) break;
                    }

                    outputChannel.appendLine(`Detected framework: ${framework || 'generic LLM usage'}`);

                    // Analyze batches in parallel (limit concurrency to avoid rate limits)
                    const newGraphs: any[] = [];
                    const maxConcurrency = 3;

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

                        outputChannel.appendLine(`\nAnalyzing batch ${batchIndex + 1}/${totalBatches} (${batch.length} files)...`);
                        outputChannel.appendLine(`Files in batch:`);
                        batch.forEach(f => {
                            const relativePath = vscode.workspace.asRelativePath(f.path);
                            const sizeKb = Math.round(f.content.length / 1024);
                            outputChannel.appendLine(`  - ${relativePath} (${sizeKb} KB)`);
                        });
                        vscode.window.showInformationMessage(`Analyzing batch ${batchIndex + 1}/${totalBatches}...`);

                        try {
                            // Combine batch files for analysis
                            const combinedBatchCode = batch.map(f =>
                                `# File: ${f.path}\n${f.content}`
                            ).join('\n\n');

                            outputChannel.appendLine(`Sending POST /analyze: ${batch.length} file(s), framework: ${framework || 'none'}`);
                            const batchGraph = await api.analyzeWorkflow(
                                combinedBatchCode,
                                batchPaths,
                                framework || undefined,
                                batchMetadata
                            );

                            // Cache the full batch graph for each file in the batch
                            // This way, editing one file will only re-analyze its batch, not all files
                            for (const file of batch) {
                                await cacheManager.setPerFile(file.path, file.content, batchGraph);
                            }

                            graphs.push(batchGraph);
                            outputChannel.appendLine(`Batch ${batchIndex + 1} complete: ${batchGraph.nodes.length} nodes, ${batchGraph.edges.length} edges`);
                        } catch (batchError: any) {
                            // If batch fails (safety filter, etc), try analyzing files individually
                            outputChannel.appendLine(`Batch ${batchIndex + 1} failed: ${batchError.message}`);
                            outputChannel.appendLine(`Falling back to individual file analysis for this batch...`);

                            for (let fileIndex = 0; fileIndex < batch.length; fileIndex++) {
                                const file = batch[fileIndex];
                                const fileMeta = batchMetadata.find(m => m.file === file.path);

                                try {
                                    const relativePath = vscode.workspace.asRelativePath(file.path);
                                    const sizeKb = Math.round(file.content.length / 1024);
                                    outputChannel.appendLine(`  Analyzing file ${fileIndex + 1}/${batch.length}: ${relativePath} (${sizeKb} KB)`);
                                    outputChannel.appendLine(`  Sending POST /analyze: 1 file, framework: ${framework || 'none'}`);

                                    const fileGraph = await api.analyzeWorkflow(
                                        `# File: ${file.path}\n${file.content}`,
                                        [file.path],
                                        framework || undefined,
                                        fileMeta ? [fileMeta] : []
                                    );

                                    await cacheManager.setPerFile(file.path, file.content, fileGraph);
                                    graphs.push(fileGraph);
                                } catch (fileError: any) {
                                    outputChannel.appendLine(`  Failed to analyze ${file.path}: ${fileError.message}`);
                                    // Continue with other files
                                }
                            }
                        }
                    }

                    // Merge cached + new graphs
                    graph = cache.mergeGraphs([...cachedGraphs, ...newGraphs]);

                    outputChannel.appendLine(`\nAnalysis complete: ${graph.nodes.length} nodes, ${graph.edges.length} edges`);
                    webview.notifyAnalysisComplete(true);
                }

                webview.show(graph);
            } catch (error: any) {
                outputChannel.appendLine(`ERROR: ${error.message}`);
                outputChannel.appendLine(`Status: ${error.response?.status}`);
                outputChannel.appendLine(`Response: ${JSON.stringify(error.response?.data)}`);
                const errorMsg = error.response?.data?.detail || error.message;
                webview.notifyAnalysisComplete(false, errorMsg);
                vscode.window.showErrorMessage(`Workspace scan failed: ${errorMsg}`);
            }
        })
    );
}

export function deactivate() {}
