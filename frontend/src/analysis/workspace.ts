/**
 * Full workspace analysis with LLM.
 * Handles file detection, caching, batching, and analysis.
 */

import * as vscode from 'vscode';
import * as path from 'path';
import { APIClient, WorkflowGraph } from '../api';
import { CacheManager } from '../cache';
import { WebviewManager } from '../webview';
import { WorkflowDetector } from '../analyzer';
import { MetadataBuilder } from '../metadata-builder';
import { CONFIG } from '../config';
import { buildFileTree, saveFilePickerSelection, getSavedSelectedPaths } from '../file-picker';
import { extractRepoStructure, formatStructureForLLM, formatHttpConnectionsForPrompt } from '../repo-structure';
import { resolveExternalEdges, logResolutionStats } from '../edge-resolver';
import { formatFileXML, combineFilesXML, createDependencyBatches } from '../file-preparation';
import { estimateTokens, CostAggregator, displayCostReport, estimateAnalysisCost } from '../cost-tracking';
import { withHttpEdges, traceCallGraphToLLM, runWithConcurrency } from './helpers';
import {
    getAnalysisSession,
    setHttpConnections,
    setCrossFileCalls,
    setRepoFiles,
    setCachedCallGraph
} from './state';
import { extractCallGraph } from '../call-graph-extractor';

/**
 * Context needed for workspace analysis.
 */
export interface WorkspaceContext {
    api: APIClient;
    cache: CacheManager;
    webview: WebviewManager;
    metadataBuilder: MetadataBuilder;
    extensionContext: vscode.ExtensionContext;
    log: (msg: string) => void;
}


/**
 * Extract and cache call graphs for all files in a content map.
 * This enables instant local updates on the first edit after analysis.
 */
function cacheCallGraphsForFiles(contentMap: Record<string, string>, workspaceRoot: string): void {
    for (const [relativePath, content] of Object.entries(contentMap)) {
        // Build absolute path for call graph cache key (matches handler.ts usage)
        const absolutePath = path.join(workspaceRoot, relativePath);
        const callGraph = extractCallGraph(content, relativePath);
        setCachedCallGraph(absolutePath, callGraph);
    }
}

/**
 * Analyze the entire workspace.
 *
 * @param ctx - Context with api, cache, webview, metadataBuilder, extensionContext, log
 * @param bypassCache - If true, skip cache and force fresh analysis
 */
export async function analyzeWorkspace(
    ctx: WorkspaceContext,
    bypassCache: boolean = false
): Promise<void> {
    const { api, cache, webview, metadataBuilder, extensionContext, log } = ctx;

    // Pre-flight: check backend is reachable
    const healthy = await api.checkHealth();
    if (!healthy) {
        log('Backend not reachable — showing error overlay');
        webview.showLoading('Connecting to backend...');
        webview.notifyBackendError();
        return;
    }

    // Track analysis start time
    const startTime = Date.now();
    const sessionAtStart = getAnalysisSession();  // Capture session to detect invalidation

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

    // Check if workspace is open
    const workspaceFolders = vscode.workspace.workspaceFolders;
    if (!workspaceFolders || workspaceFolders.length === 0) {
        vscode.window.showWarningMessage(
            'No folder open. Use File > Open Folder to open a project.'
        );
        return;
    }
    const workspaceRoot = workspaceFolders[0].uri.fsPath;

    try {
        // Show panel immediately (don't block on file detection)
        webview.showLoading('Scanning workspace...');

        // Check if workspace has any source files
        const sourceFileCount = (await WorkflowDetector.getAllSourceFiles()).length;
        if (sourceFileCount === 0) {
            vscode.window.showWarningMessage(
                'No source files found (.py, .ts, .js). Open a folder containing code.'
            );
            return;
        }

        const workflowFiles = await WorkflowDetector.detectInWorkspace();
        pipelineStats.detected.llmFiles = workflowFiles.length;
        log(`Found ${workflowFiles.length} workflow files (LLM import patterns)`);

        if (workflowFiles.length === 0) {
            vscode.window.showWarningMessage(
                `Found ${sourceFileCount} source files but no LLM/AI code detected. ` +
                'Codag visualizes code using OpenAI, Anthropic, Gemini, etc.'
            );
            return;
        }

        // Read ALL workflow files first to check cache
        const allFileContents: { path: string; content: string; }[] = [];
        for (const uri of workflowFiles) {
            try {
                const content = await vscode.workspace.fs.readFile(uri);
                const text = Buffer.from(content).toString('utf8');
                allFileContents.push({
                    path: vscode.workspace.asRelativePath(uri, false),
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
            const relativePath = vscode.workspace.asRelativePath(uri, false);
            if (!workflowPaths.has(relativePath)) {
                try {
                    const content = await vscode.workspace.fs.readFile(uri);
                    httpSourceContents.push({
                        path: relativePath,
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
        setHttpConnections(allHttpConnections);
        setCrossFileCalls(rawHttpStructure.crossFileCalls || []);
        // Store repo files for HTTP caller detection
        setRepoFiles(rawHttpStructure.files.map(f => ({
            path: f.path,
            functions: f.functions.map(fn => ({ name: fn.name, calls: fn.calls, line: fn.line }))
        })));
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

        const httpClientFilesToAdd = new Set<string>();
        const httpHandlerFilesToAdd = new Set<string>();
        for (const conn of allHttpConnections) {
            // Check if this handler is connected to LLM calls via call graph
            const handlerConnectedToLLM = llmConnectedHandlers.has(conn.handler.file) ||
                // Also check if handler file itself has LLM calls
                rawHttpStructure.files.find(f => f.path === conn.handler.file)?.functions.some(f => f.hasLLMCall);

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
            for (const clientFile of httpClientFilesToAdd) {
                log(`  + ${vscode.workspace.asRelativePath(clientFile)}`);
                const found = httpSourceContents.find(f => f.path === clientFile);
                if (found) {
                    allFileContents.push(found);
                    workflowPaths.add(clientFile);
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

        // Prune stale cache entries for files that no longer exist
        // IMPORTANT: Do this AFTER HTTP client/handler files are added to allFileContents
        // Otherwise, HTTP files (like api.ts) get pruned and then immediately need re-analysis
        const existingFilePaths = allFileContents.map(f => f.path);
        const pruned = await cache.pruneStaleEntries(existingFilePaths);
        if (pruned > 0) {
            log(`Pruned ${pruned} stale cache entries`);
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
            const savedSelection = getSavedSelectedPaths(extensionContext);

            if (savedSelection.length > 0) {
                log(`\nSubsequent run detected - performing silent background analysis`);
                log(`Using ${savedSelection.length} previously selected files`);

                // Filter to previously selected files that are still workflow files
                const selectedFiles = workflowFiles.filter(f => savedSelection.includes(vscode.workspace.asRelativePath(f, false)));
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
                        webview.show(withHttpEdges(mergedGraph, log)!);
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
                        webview.show(withHttpEdges(allCached, log)!, { loading: true });
                    } else {
                        log(`No cached graphs to show, showing loading...`);
                        webview.showLoading(`Analyzing ${uncachedCount} file${uncachedCount !== 1 ? 's' : ''}...`);
                    }

                    const filesToAnalyze = cacheResult.uncached;

                    // Log cost estimate (user already saw live estimate in file picker)
                    const costEstimate = estimateAnalysisCost(filesToAnalyze);
                    log(`Cost estimate: ~${Math.round(costEstimate.inputTokens / 1000)}k input = ${costEstimate.formattedCost}`);

                    // Convert relative paths back to Uris for metadata builder
                    const workspaceUri = workspaceFolders[0].uri;
                    const uncachedUris = filesToAnalyze.map(f => vscode.Uri.joinPath(workspaceUri, f.path));
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
                    webview.startBatchProgress(batches.length);

                    const maxConcurrency = CONFIG.CONCURRENCY.MAX_PARALLEL;
                    const costAggregator = new CostAggregator();
                    costAggregator.start();

                    // Process batches with concurrency limiting
                    for (let i = 0; i < batches.length; i += maxConcurrency) {
                        const batchSlice = batches.slice(i, i + maxConcurrency);

                        const batchPromises = batchSlice.map(async (batch, sliceIndex) => {
                            const batchIndex = i + sliceIndex;
                            const batchPaths = batch.map(f => f.path);
                            const batchMetadata = metadata.filter(m => batchPaths.includes(vscode.workspace.asRelativePath(m.file, false)));
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
                                if (getAnalysisSession() !== sessionAtStart) {
                                    log(`Batch ${batchIndex + 1} result discarded (session invalidated)`);
                                    return null;
                                }

                                const graph = analyzeResult.graph;


                                // Track actual cost from API
                                costAggregator.add('analyze', batch.length, analyzeResult.usage, analyzeResult.cost, batchIndex);

                                newGraphs.push(graph);

                                // Cache per-file
                                const contentMap: Record<string, string> = {};
                                for (const f of batch) contentMap[f.path] = f.content;

                                await cache.setAnalysisResult(graph, contentMap);
                                cacheCallGraphsForFiles(contentMap, workspaceRoot);

                                // Incremental graph update - only if THIS batch added nodes
                                if (graph.nodes.length > 0) {
                                    try {
                                        const currentMerged = await cache.getMergedGraph();
                                        if (currentMerged && currentMerged.nodes.length > 0) {
                                            webview.updateGraph(withHttpEdges(currentMerged, log)!);
                                        }
                                    } catch (updateError: any) {
                                        log(`Warning: Incremental update failed: ${updateError.message}`);
                                    }
                                }

                                // Update progress bar
                                webview.batchCompleted(batch.length);

                                log(`✓ Batch ${batchIndex + 1} complete: ${graph.nodes.length} nodes`);
                                return graph;
                            } catch (error: any) {
                                log(`Batch ${batchIndex + 1} failed: ${error.message}`);
                                return null; // Don't throw - let other batches continue
                            }
                        });

                        try {
                            await Promise.all(batchPromises);
                        } catch (error: any) {
                            log(`Analysis failed: ${error.message}`);
                            webview.notifyAnalysisComplete(false, error.message);
                            return;
                        }
                    }

                    // Check if session was invalidated before displaying
                    if (getAnalysisSession() !== sessionAtStart) {
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
                        webview.updateGraph(withHttpEdges(finalMerged, log)!);
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
                webview.show(withHttpEdges(cachedGraph, log)!);
                log(`✓ Displayed cached graph behind file picker`);
            }
        }

        // Get ALL source files for the picker (shows all files, not just LLM)
        const allSourceFiles = await WorkflowDetector.getAllSourceFiles();

        // Build file tree with all source files (includes token estimates for cost)
        const { tree, totalFiles } = await buildFileTree(allSourceFiles, extensionContext);

        // Show file picker immediately
        const selectedPaths = await webview.showFilePicker(tree, totalFiles);
        if (!selectedPaths || selectedPaths.length === 0) {
            webview.notifyWarning('No files selected for analysis.');
            return;
        }

        // Filter to selected files only
        // Note: selectedPaths from webview are full paths, convert for comparison with relative paths
        const selectedPathsRelative = selectedPaths.map(p => vscode.workspace.asRelativePath(p, false));

        // Save selection to cache (using relative paths)
        await saveFilePickerSelection(extensionContext, allSourceFiles, selectedPathsRelative);
        const selectedFiles = workflowFiles.filter(f => selectedPathsRelative.includes(vscode.workspace.asRelativePath(f, false)));
        const fileContents = allFileContents.filter(f => selectedPathsRelative.includes(f.path));

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
            let cachedGraph = await cache.getMergedGraph(cachedPaths);
            if (cachedGraph) {
                const graphWithHttp = withHttpEdges(cachedGraph, log)!;
                webview.initGraph(graphWithHttp);
                log(`✓ Displayed cached graph (${graphWithHttp.nodes.length} nodes, ${graphWithHttp.edges.length} edges)`);
            }
        } else {
            // For fresh repos with no cached graphs, close file picker immediately
            // so the loading indicator is visible during analysis
            webview.closeFilePicker();
        }

        // Store newly analyzed graphs
        const newGraphs: any[] = [];

        // HTTP connections already extracted earlier from ALL source files (allHttpConnections)

        // Track tokens for legacy logging
        let totalInputTokens = 0;
        let totalOutputTokens = 0;

        if (filesToAnalyze.length > 0) {
                // Log cost estimate (user already saw live estimate in file picker)
                const costEstimate = estimateAnalysisCost(filesToAnalyze);
                log(`\nCost estimate: ~${Math.round(costEstimate.inputTokens / 1000)}k input + ~${Math.round(costEstimate.outputTokens / 1000)}k output = ${costEstimate.formattedCost}`);

                // Analyze uncached files in batches
                webview.notifyAnalysisStarted();

                // Build metadata only for uncached files
                // Convert relative paths back to Uris for metadata builder
                const workspaceUri = workspaceFolders[0].uri;
                const uncachedUris = filesToAnalyze.map(f => vscode.Uri.joinPath(workspaceUri, f.path));
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
                webview.startBatchProgress(batches.length);

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

                // Helper to cache batch immediately after it completes
                async function cacheBatchGraph(
                    files: { path: string; content: string }[],
                    graph: WorkflowGraph
                ) {
                    if (!bypassCache) {
                        const contentMap: Record<string, string> = {};
                        for (const f of files) contentMap[f.path] = f.content;
                        await cache.setAnalysisResult(graph, contentMap);
                        cacheCallGraphsForFiles(contentMap, workspaceRoot);
                    }
                }

                // Track completed batches for incremental updates
                let completedBatchCount = 0;

                // Inner function to analyze a single batch
                async function analyzeBatch(
                    batch: { path: string; content: string; }[],
                    batchIndex: number,
                    totalBatches: number,
                    allMetadata: any[],
                    graphs: any[],
                    costTracker: CostAggregator,
                    condensedStructureParam?: string,
                    httpConnectionsContextParam?: string
                ): Promise<WorkflowGraph | null> {
                    const batchPaths = batch.map(f => f.path);
                    const batchMetadata = allMetadata.filter(m => batchPaths.includes(vscode.workspace.asRelativePath(m.file, false)));

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

                        log(`Sending POST /analyze: ${batch.length} file(s), ~${Math.round(batchTokens / 1000)}k tokens, framework: ${batchFramework || 'none'}${condensedStructureParam ? ', with cross-batch context' : ''}${httpConnectionsContextParam ? ', with HTTP connections' : ''}`);
                        const batchResult = await api.analyzeWorkflow(
                            combinedBatchCode,
                            batchPaths,
                            batchFramework || undefined,
                            batchMetadata,
                            condensedStructureParam,
                            httpConnectionsContextParam
                        );

                        // Check if session was invalidated (cache cleared) during request
                        if (getAnalysisSession() !== sessionAtStart) {
                            log(`Batch ${batchIndex + 1} result discarded (session invalidated)`);
                            return null;
                        }

                        const batchGraph = batchResult.graph;


                        // Track actual cost from API
                        costTracker.add('analyze', batch.length, batchResult.usage, batchResult.cost, batchIndex);

                        // Track tokens for legacy logging (accumulate in outer scope)
                        totalInputTokens += batchTokens;
                        const outputTokens = estimateTokens(JSON.stringify(batchGraph));
                        totalOutputTokens += outputTokens;

                        graphs.push(batchGraph);
                        log(`Batch ${batchIndex + 1} complete: ${batchGraph.nodes.length} nodes, ${batchGraph.edges.length} edges`);

                        // Update progress
                        webview.batchCompleted(batch.length);

                        // Return batchGraph for incremental updates
                        return batchGraph;
                    } catch (batchError: any) {
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
                                cacheCallGraphsForFiles(contentMap, workspaceRoot);
                            }
                            return null;
                        }

                        // If batch fails (safety filter, etc), try analyzing files individually
                        log(`Batch ${batchIndex + 1} failed: ${batchError.message}`);
                        log(`Falling back to individual file analysis for this batch...`);

                        // Parallelize individual file analysis (use same concurrency limit)
                        const fallbackPromises = batch.map((file, fileIndex) => {
                            return async () => {
                                const fileMeta = batchMetadata.find(m => vscode.workspace.asRelativePath(m.file, false) === file.path);
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
                                        condensedStructureParam,
                                        httpConnectionsContextParam
                                    );

                                    // Check if session was invalidated
                                    if (getAnalysisSession() !== sessionAtStart) {
                                        log(`  File result discarded (session invalidated)`);
                                        return;
                                    }

                                    const fileGraph = fileResult.graph;


                                    // Track cost from fallback file analysis
                                    costTracker.add('analyze', 1, fileResult.usage, fileResult.cost, batchIndex);

                                    graphs.push(fileGraph);
                                    log(`  Fallback file complete: ${fileGraph.nodes.length} nodes`);

                                    // Cache successful fallback analysis (only successful results get cached)
                                    if (!bypassCache) {
                                        await cache.setAnalysisResult(fileGraph, { [file.path]: file.content });
                                        cacheCallGraphsForFiles({ [file.path]: file.content }, workspaceRoot);
                                        log(`  Cached ${relativePath}`);
                                    }
                                } catch (fileError: any) {
                                    // Check if it's "No LLM workflow" - not a failure, just no LLM code
                                    const detail = fileError.response?.data?.detail || fileError.message || '';
                                    if (fileError.response?.status === 400 &&
                                        detail.toLowerCase().includes('no llm workflow')) {
                                        log(`  ${relativePath}: No LLM workflow (caching empty)`);
                                        // Cache this file as having 0 nodes
                                        if (!bypassCache) {
                                            await cache.setAnalysisResult({ nodes: [], edges: [], llms_detected: [], workflows: [] }, { [file.path]: file.content });
                                            cacheCallGraphsForFiles({ [file.path]: file.content }, workspaceRoot);
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

                // Process batches with worker pool - each worker picks up next batch immediately
                const batchTasks = batches.map((batch, batchIndex) => async () => {
                    try {
                        const batchGraph = await analyzeBatch(batch, batchIndex, batches.length, metadata, newGraphs, costAggregator, condensedStructure, httpConnectionsContext);
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
                                        webview.updateGraph(withHttpEdges(currentMerged, log)!);
                                    }
                                } catch (updateError: any) {
                                    log(`Warning: Incremental update failed: ${updateError.message}`);
                                }
                            }
                        }
                        // Note: batchCompleted already called in analyzeBatch on success
                        // For non-throwing failures (null return), we still need to mark progress
                        if (!batchGraph) {
                            webview.batchCompleted(0);
                        }
                        log(`✓ Progress: ${completedBatchCount}/${batches.length} batches`);
                        return batchGraph;
                    } catch (batchError: any) {
                        log(`⚠️ Batch ${batchIndex + 1} error: ${batchError.message}`);
                        completedBatchCount++;
                        // Mark failed batch as processed (0 files analyzed)
                        webview.batchCompleted(0);
                        return null;
                    }
                });

                try {
                    await runWithConcurrency(batchTasks, maxConcurrency);
                } catch (poolError: any) {
                    log(`Analysis pool failed: ${poolError.message}`);
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
        if (getAnalysisSession() !== sessionAtStart) {
            log('Analysis results discarded (session invalidated)');
            return;
        }

        // Get merged graph from cache (only successful results are cached)
        let graph = await cache.getMergedGraph();

        // Resolve cross-batch edge references (file:function → actual node IDs)
        if (graph && graph.edges.length > 0) {
            pipelineStats.edges.llmGenerated = graph.edges.length;
            const resolution = resolveExternalEdges(graph);
            graph = resolution.graph;
            pipelineStats.edges.resolved = resolution.resolved;
            pipelineStats.edges.orphaned = resolution.unresolved.length;
            logResolutionStats(resolution.resolved, resolution.unresolved, log);
        }

        // HTTP connection edges are added via withHttpEdges() at display time

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

        // Notify user about unresolved cross-file connections
        if (pipelineStats.edges.orphaned > 0) {
            webview.notifyWarning(
                `${pipelineStats.edges.orphaned} cross-file connection(s) could not be resolved. Some workflow paths may be incomplete.`
            );
        }

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
            webview.show(withHttpEdges(graph, log)!);
        }
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

        // Handle file size errors (HTTP 413) with clearer messaging
        if (error.response?.status === 413) {
            webview.notifyAnalysisComplete(false, 'Files too large. Try analyzing fewer files.');
        } else {
            webview.notifyAnalysisComplete(false, errorMsg);
        }
    }
}
