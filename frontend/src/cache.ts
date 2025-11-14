import * as vscode from 'vscode';
import * as crypto from 'crypto';
import * as path from 'path';
import { WorkflowGraph } from './api';

interface PerFileCacheEntry {
    filePath: string;
    contentHash: string;
    graph: WorkflowGraph;
    timestamp: number;
}

export class CacheManager {
    private cachePath: vscode.Uri | null = null;
    private perFileCache: Record<string, PerFileCacheEntry> = {};
    private initPromise: Promise<void>;

    constructor(private context: vscode.ExtensionContext) {
        this.initPromise = this.initializeCache();
    }

    /**
     * Initialize cache from workspace folder
     */
    private async initializeCache() {
        const workspaceFolders = vscode.workspace.workspaceFolders;
        if (!workspaceFolders || workspaceFolders.length === 0) {
            return;
        }

        // Use first workspace folder
        const workspaceFolder = workspaceFolders[0];
        const vscodeFolderPath = path.join(workspaceFolder.uri.fsPath, '.vscode');
        this.cachePath = vscode.Uri.file(path.join(vscodeFolderPath, 'aiworkflowviz-cache.json'));

        // Ensure .vscode directory exists
        try {
            await vscode.workspace.fs.createDirectory(vscode.Uri.file(vscodeFolderPath));
        } catch (error) {
            // Directory might already exist, that's fine
        }

        // Load existing cache
        await this.loadCache();
    }

    /**
     * Load cache from disk
     */
    private async loadCache() {
        if (!this.cachePath) return;

        try {
            const cacheContent = await vscode.workspace.fs.readFile(this.cachePath);
            const parsed = JSON.parse(cacheContent.toString());
            this.perFileCache = parsed.perFileCache || parsed || {};
        } catch (error) {
            // Cache file doesn't exist or is invalid, start with empty cache
            this.perFileCache = {};
        }
    }

    /**
     * Save cache to disk
     */
    private async saveCache() {
        if (!this.cachePath) return;

        try {
            const cacheContent = JSON.stringify({
                perFileCache: this.perFileCache
            }, null, 2);
            await vscode.workspace.fs.writeFile(this.cachePath, Buffer.from(cacheContent, 'utf8'));
        } catch (error) {
            console.error('Failed to save cache:', error);
        }
    }

    private hashContent(content: string): string {
        return crypto.createHash('sha256').update(content).digest('hex');
    }

    async clear() {
        this.perFileCache = {};
        await this.saveCache();
    }

    /**
     * Get cached graph for a single file by content hash
     */
    async getPerFile(filePath: string, content: string): Promise<WorkflowGraph | null> {
        await this.initPromise;

        const contentHash = this.hashContent(content);
        const cacheKey = `${filePath}:${contentHash}`;
        const entry = this.perFileCache[cacheKey];

        if (!entry) return null;
        return entry.graph;
    }

    /**
     * Cache graph for a single file
     */
    async setPerFile(filePath: string, content: string, graph: WorkflowGraph) {
        await this.initPromise;

        const contentHash = this.hashContent(content);
        const cacheKey = `${filePath}:${contentHash}`;

        this.perFileCache[cacheKey] = {
            filePath,
            contentHash,
            graph,
            timestamp: Date.now()
        };

        await this.saveCache();
    }

    /**
     * Get cached graphs for multiple files, returning which files need analysis
     */
    async getMultiplePerFile(filePaths: string[], contents: string[]): Promise<{
        cachedGraphs: WorkflowGraph[];
        uncachedFiles: { path: string; content: string; }[];
    }> {
        await this.initPromise;

        const cachedGraphs: WorkflowGraph[] = [];
        const uncachedFiles: { path: string; content: string; }[] = [];

        for (let i = 0; i < filePaths.length; i++) {
            const cached = await this.getPerFile(filePaths[i], contents[i]);
            if (cached) {
                cachedGraphs.push(cached);
            } else {
                uncachedFiles.push({ path: filePaths[i], content: contents[i] });
            }
        }

        return { cachedGraphs, uncachedFiles };
    }

    /**
     * Merge multiple workflow graphs into one
     */
    mergeGraphs(graphs: WorkflowGraph[]): WorkflowGraph {
        if (graphs.length === 0) {
            return { nodes: [], edges: [], llms_detected: [] };
        }

        if (graphs.length === 1) {
            return graphs[0];
        }

        const mergedNodes = new Map<string, any>();
        const mergedEdges = new Map<string, any>();
        const llmsDetectedSet = new Set<string>();

        for (const graph of graphs) {
            // Merge nodes (deduplicate by id)
            for (const node of graph.nodes) {
                mergedNodes.set(node.id, node);
            }

            // Merge edges (deduplicate by source-target pair)
            for (const edge of graph.edges) {
                const edgeKey = `${edge.source}->${edge.target}`;
                mergedEdges.set(edgeKey, edge);
            }

            // Merge LLMs detected
            for (const llm of graph.llms_detected || []) {
                llmsDetectedSet.add(llm);
            }
        }

        return {
            nodes: Array.from(mergedNodes.values()),
            edges: Array.from(mergedEdges.values()),
            llms_detected: Array.from(llmsDetectedSet)
        };
    }
}
