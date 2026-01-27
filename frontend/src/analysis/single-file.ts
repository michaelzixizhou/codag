/**
 * Single file analysis with LLM.
 * Used as fallback when local update isn't possible.
 */

import * as vscode from 'vscode';
import { APIClient, TrialExhaustedError } from '../api';
import { AuthManager } from '../auth';
import { CacheManager } from '../cache';
import { WebviewManager } from '../webview';
import { withHttpEdges } from './helpers';
import { setPendingAnalysisTask } from './state';

/**
 * Context needed for single file analysis.
 */
export interface SingleFileContext {
    api: APIClient;
    auth: AuthManager;
    cache: CacheManager;
    webview: WebviewManager;
    log: (msg: string) => void;
}

/**
 * Analyze a single file with LLM and update the graph.
 * Shows cached graph immediately, then updates with new analysis.
 *
 * @param ctx - Context with api, auth, cache, webview, log
 * @param uri - URI of the file to analyze
 */
export async function analyzeAndUpdateSingleFile(
    ctx: SingleFileContext,
    uri: vscode.Uri
): Promise<void> {
    const { api, auth, cache, webview, log } = ctx;

    try {
        const filePath = vscode.workspace.asRelativePath(uri, false);
        const startTime = Date.now();
        log(`\n=== Incremental File Analysis ===`);
        log(`File: ${filePath}`);

        // Read file content
        const document = await vscode.workspace.openTextDocument(uri);
        const content = document.getText();

        // Get cached graph BEFORE invalidating (includes stale version of changed file)
        const cachedGraph = await cache.getMergedGraph();

        // Show cached graph immediately with loading indicator
        if (cachedGraph && cachedGraph.nodes.length > 0) {
            webview.show(withHttpEdges(cachedGraph, log)!, { loading: true });
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
            log(`Updated cache for ${vscode.workspace.asRelativePath(filePath)}: ${result.nodes.length} nodes`);
        } else {
            // Cache empty result
            await cache.setAnalysisResult({
                nodes: [],
                edges: [],
                llms_detected: [],
                workflows: []
            }, { [filePath]: content });
            log(`No nodes found after update`);
        }

        // Get merged graph from cache
        const mergedGraph = await cache.getMergedGraph();

        // Update webview with merged graph
        if (mergedGraph) {
            webview.show(withHttpEdges(mergedGraph, log)!);
            webview.notifyAnalysisComplete(true);
            const duration = Date.now() - startTime;
            const seconds = (duration / 1000).toFixed(1);
            log(`Graph updated: ${mergedGraph.nodes.length} nodes, ${mergedGraph.edges.length} edges (${seconds}s)`);
        } else {
            webview.notifyAnalysisComplete(true);
            const duration = Date.now() - startTime;
            const seconds = (duration / 1000).toFixed(1);
            log(`Graph updated: empty (${seconds}s)`);
        }
    } catch (error: any) {
        // Handle trial quota exhaustion - store task for retry after login
        if (error instanceof TrialExhaustedError) {
            ctx.log('Trial quota exhausted, showing auth panel...');
            // Store retry task - note: this creates a closure over ctx and uri
            setPendingAnalysisTask(() => analyzeAndUpdateSingleFile(ctx, uri));
            ctx.webview.showAuthPanel();
            return;
        }

        ctx.log(`ERROR updating file: ${error.message}`);
        ctx.webview.notifyAnalysisComplete(false, error.message);
    }
}
