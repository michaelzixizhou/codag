/**
 * Selected files analysis with LLM.
 * Handles batch analysis of user-selected files.
 */

import * as vscode from 'vscode';
import * as path from 'path';
import { APIClient } from '../api';

import { CacheManager } from '../cache';
import { WebviewManager } from '../webview';
import { WorkflowDetector } from '../analyzer';
import { MetadataBuilder } from '../metadata-builder';
import { extractRepoStructure, formatHttpConnectionsForPrompt } from '../repo-structure';
import { createDependencyBatches, combineFilesXML } from '../file-preparation';
import { CONFIG } from '../config';
import { estimateTokens, calculateCost, formatCost } from '../cost-tracking';
import { withHttpEdges, runWithConcurrency } from './helpers';
import {
    getAnalysisSession,
    setHttpConnections,
    setCrossFileCalls,
    getCrossFileCalls,
    setRepoFiles,
    setCachedCallGraph
} from './state';
import { extractCallGraph } from '../call-graph-extractor';

/**
 * Extract and cache call graphs for all files in a content map.
 */
function cacheCallGraphsForFiles(contentMap: Record<string, string>, workspaceRoot: string): void {
    for (const [relativePath, content] of Object.entries(contentMap)) {
        const absolutePath = path.join(workspaceRoot, relativePath);
        const callGraph = extractCallGraph(content, relativePath);
        setCachedCallGraph(absolutePath, callGraph);
    }
}

/**
 * Context needed for selected files analysis.
 */
export interface SelectedFilesContext {
    api: APIClient;
    cache: CacheManager;
    webview: WebviewManager;
    metadataBuilder: MetadataBuilder;
    log: (msg: string) => void;
}

/**
 * Analyze selected files with batching and concurrent API calls.
 *
 * @param ctx - Context with api, cache, webview, metadataBuilder, log
 * @param selectedPaths - Array of file paths to analyze
 * @param bypassCache - If true, skip cache and force fresh analysis
 */
export async function analyzeSelectedFiles(
    ctx: SelectedFilesContext,
    selectedPaths: string[],
    bypassCache: boolean = false
): Promise<void> {
    const { api, cache, webview, metadataBuilder, log } = ctx;
    const startTime = Date.now();
    const sessionAtStart = getAnalysisSession();  // Capture session to detect invalidation

    // Pre-flight: check backend is reachable
    const healthy = await api.checkHealth();
    if (!healthy) {
        log('Backend not reachable — showing error overlay');
        webview.showLoading('Connecting to backend...');
        webview.notifyBackendError();
        return;
    }

    try {
        webview.showLoading('Analyzing selected files...');

        // Read file contents (store relative paths for cache consistency)
        const fileContents: { path: string; content: string }[] = [];
        for (const filePath of selectedPaths) {
            try {
                const content = await vscode.workspace.fs.readFile(vscode.Uri.file(filePath));
                fileContents.push({
                    path: vscode.workspace.asRelativePath(filePath, false),
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
        if (rawHttpStructure.httpConnections.length > 0) {
            log(`Found ${rawHttpStructure.httpConnections.length} HTTP connection(s)`);
        }
        if (getCrossFileCalls().length > 0) {
            log(`Found ${getCrossFileCalls().length} cross-file call(s)`);
        }

        // Build metadata (convert relative paths back to Uris)
        const workspaceFolder = vscode.workspace.workspaceFolders?.[0];
        if (!workspaceFolder) {
            log('No workspace folder found');
            return;
        }
        const workspaceRoot = workspaceFolder.uri.fsPath;
        const uncachedUris = fileContents.map(f => vscode.Uri.joinPath(workspaceFolder.uri, f.path));
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
        webview.startBatchProgress(batches.length);

        const maxConcurrency = CONFIG.CONCURRENCY.MAX_PARALLEL;
        const newGraphs: any[] = [];
        let totalInputTokens = 0;
        let totalOutputTokens = 0;

        // Analyze batches with worker pool - each worker picks up next batch immediately
        const batchTasks = batches.map((batch, batchIndex) => async () => {
            const batchMetadata = metadata.filter(m =>
                batch.some(f => f.path === vscode.workspace.asRelativePath(m.file, false))
            );
            const combinedCode = combineFilesXML(batch, batchMetadata);
            const batchTokens = estimateTokens(combinedCode);

            log(`Analyzing batch ${batchIndex + 1}/${batches.length} (${batch.length} files, ~${Math.round(batchTokens / 1000)}k tokens)...`);

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
                if (getAnalysisSession() !== sessionAtStart) {
                    log(`Batch ${batchIndex + 1} result discarded (session invalidated)`);
                    return null;
                }

                const graph = analyzeResult.graph;


                if (graph && graph.nodes) {
                    newGraphs.push(graph);

                    // Cache per-file (only successful results get cached)
                    const contentMap: Record<string, string> = {};
                    for (const f of batch) contentMap[f.path] = f.content;
                    await cache.setAnalysisResult(graph, contentMap);
                    cacheCallGraphsForFiles(contentMap, workspaceRoot);

                    // Track tokens
                    totalInputTokens += batchTokens;
                    totalOutputTokens += estimateTokens(JSON.stringify(graph));

                    log(`✓ Batch ${batchIndex + 1} complete: ${graph.nodes.length} nodes`);

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
                }

                webview.batchCompleted(batch.length);
                return graph;
            } catch (error: any) {
                log(`Batch ${batchIndex + 1} failed: ${error.message}`);
                // Don't throw - let other batches continue
                return null;
            }
        });

        await runWithConcurrency(batchTasks, maxConcurrency);

        // Check if session was invalidated before displaying
        if (getAnalysisSession() !== sessionAtStart) {
            log('Analysis results discarded (session invalidated)');
            return;
        }

        // Merge and display results from cache (only successful results are cached)
        // HTTP connections are now included in LLM prompt, so edges come from analysis results
        // Pass selectedPaths to only include analyzed files, not all cached files
        const mergedGraph = await cache.getMergedGraph(selectedPaths);

        if (mergedGraph && mergedGraph.nodes.length > 0) {
            webview.show(withHttpEdges(mergedGraph, log)!);
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
