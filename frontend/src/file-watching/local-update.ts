/**
 * Instant local graph updates using tree-sitter diff (no LLM).
 */

import * as vscode from 'vscode';
import * as fs from 'fs';
import { CacheManager } from '../cache';
import { extractCallGraph, diffCallGraphs } from '../call-graph-extractor';
import { applyLocalUpdate, LocalUpdateResult } from '../local-graph-updater';
import { getCachedCallGraph, setCachedCallGraph } from '../analysis/state';

/**
 * Context needed for local updates.
 */
export interface LocalUpdateContext {
    cache: CacheManager;
    log: (msg: string) => void;
}

/**
 * Perform instant local structure update (no LLM).
 * Uses tree-sitter to diff call graphs and apply changes.
 *
 * @param ctx - Context with cache and log
 * @param uri - URI of the file that changed
 * @returns LocalUpdateResult or null if update wasn't possible
 */
export async function performLocalUpdate(
    ctx: LocalUpdateContext,
    uri: vscode.Uri
): Promise<LocalUpdateResult | null> {
    const { cache, log } = ctx;
    const filePath = uri.fsPath;
    const relativePath = vscode.workspace.asRelativePath(filePath);

    try {
        // Read file content
        const content = fs.readFileSync(filePath, 'utf-8');

        // Extract call graph (uses acorn for JS/TS, regex for Python)
        const newCallGraph = extractCallGraph(content, filePath);

        // Get cached call graph for comparison
        const oldCallGraph = getCachedCallGraph(filePath);

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
            setCachedCallGraph(filePath, newCallGraph);
            await cache.setAnalysisResult(result.graph, { [relativePath]: content });

            // Get merged graph for display
            const mergedGraph = await cache.getMergedGraph();
            result.graph = mergedGraph!;

            return result;
        } else {
            // No cached call graph - this is first access since extension loaded.
            // Don't create graph from call graph - let the analysis path verify this is an LLM file.
            // Just store the call graph for future comparison if file changes again.
            setCachedCallGraph(filePath, newCallGraph);

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
}
