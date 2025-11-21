import * as vscode from 'vscode';
import * as crypto from 'crypto';
import * as path from 'path';
import { WorkflowGraph } from './api';
import { StaticAnalyzer } from './static-analyzer';

// Cache version - increment when format changes to auto-invalidate old entries
// v1: absolute paths in cache keys
// v2: relative paths in cache keys (for portability)
const CACHE_VERSION = 2;

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
    private staticAnalyzer: StaticAnalyzer;

    constructor(private context: vscode.ExtensionContext) {
        this.initPromise = this.initializeCache();
        this.staticAnalyzer = new StaticAnalyzer();
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

            // Check version compatibility
            const cacheVersion = parsed.version || 1;
            if (cacheVersion !== CACHE_VERSION) {
                console.log(`Cache version mismatch (expected ${CACHE_VERSION}, got ${cacheVersion}), clearing cache`);
                this.perFileCache = {};
                return;
            }

            this.perFileCache = parsed.perFileCache || {};
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
                version: CACHE_VERSION,
                perFileCache: this.perFileCache
            }, null, 2);
            await vscode.workspace.fs.writeFile(this.cachePath, Buffer.from(cacheContent, 'utf8'));
        } catch (error) {
            console.error('Failed to save cache:', error);
        }
    }

    /**
     * Hash file content based on full content (fallback for non-code files)
     */
    private hashContent(content: string): string {
        return crypto.createHash('sha256').update(content).digest('hex');
    }

    /**
     * AST-aware content hashing: only hash LLM-relevant code
     * Ignores comments, whitespace changes, and non-LLM code
     */
    private hashContentAST(content: string, filePath: string): string {
        try {
            // Analyze file to extract LLM-relevant locations
            const analysis = this.staticAnalyzer.analyze(content, filePath);

            // Create normalized representation of LLM-relevant code
            // Include: imports, variables, location line numbers and types
            // Exclude: comments, whitespace, exact column numbers
            const normalized = {
                // LLM-related imports (sorted for consistency)
                imports: analysis.imports.filter(imp =>
                    /openai|anthropic|gemini|groq|ollama|cohere|langchain|langgraph|mastra|crewai/i.test(imp)
                ).sort(),

                // LLM-related variables (sorted)
                variables: Array.from(analysis.llmRelatedVariables).sort(),

                // Code locations (line + type only, ignore column for whitespace tolerance)
                locations: analysis.locations.map(loc => ({
                    line: loc.line,
                    type: loc.type,
                    function: loc.function
                })).sort((a, b) => a.line - b.line)
            };

            // Hash the normalized representation
            const normalizedString = JSON.stringify(normalized);
            return crypto.createHash('sha256').update(normalizedString).digest('hex');
        } catch (error) {
            // Fallback to full content hash if AST parsing fails
            console.warn(`AST-aware hashing failed for ${filePath}, using full content hash:`, error);
            return this.hashContent(content);
        }
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

        // Use AST-aware hashing for code files
        const contentHash = this.hashContentAST(content, filePath);
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

        // Use AST-aware hashing for code files
        const contentHash = this.hashContentAST(content, filePath);
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
     * Get most recent cached workflows (workspace-level or all files merged)
     * Returns null if no cached workflows exist
     */
    async getMostRecentWorkflows(): Promise<WorkflowGraph | null> {
        await this.initPromise;

        let mostRecentEntry: PerFileCacheEntry | null = null;
        let mostRecentTimestamp = 0;

        // Find most recent cache entry (workspace or per-file)
        for (const entry of Object.values(this.perFileCache)) {
            if (entry.timestamp > mostRecentTimestamp) {
                mostRecentEntry = entry;
                mostRecentTimestamp = entry.timestamp;
            }
        }

        return mostRecentEntry?.graph || null;
    }

    /**
     * Merge multiple workflow graphs into one
     */
    mergeGraphs(graphs: WorkflowGraph[]): WorkflowGraph {
        if (graphs.length === 0) {
            return { nodes: [], edges: [], llms_detected: [], workflows: [] };
        }

        if (graphs.length === 1) {
            return graphs[0];
        }

        const mergedNodes = new Map<string, any>();
        const mergedEdges = new Map<string, any>();
        const llmsDetectedSet = new Set<string>();
        const mergedWorkflows = new Map<string, any>();

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

            // Merge workflows (combine nodeIds for same ID)
            for (const workflow of graph.workflows || []) {
                const existing = mergedWorkflows.get(workflow.id);
                if (existing) {
                    // Merge nodeIds arrays and deduplicate
                    const combinedNodeIds = [...new Set([...existing.nodeIds, ...workflow.nodeIds])];
                    mergedWorkflows.set(workflow.id, {
                        ...existing,
                        nodeIds: combinedNodeIds,
                        // Keep description from first workflow or combine
                        description: existing.description || workflow.description
                    });
                } else {
                    mergedWorkflows.set(workflow.id, workflow);
                }
            }
        }

        return {
            nodes: Array.from(mergedNodes.values()),
            edges: Array.from(mergedEdges.values()),
            llms_detected: Array.from(llmsDetectedSet),
            workflows: Array.from(mergedWorkflows.values())
        };
    }

    /**
     * Check if a file is currently cached
     */
    async isFileCached(filePath: string): Promise<boolean> {
        await this.initPromise;

        const workspaceFolders = vscode.workspace.workspaceFolders;
        if (!workspaceFolders || workspaceFolders.length === 0) {
            return false;
        }

        const workspaceRoot = workspaceFolders[0].uri.fsPath;
        const relativePath = path.relative(workspaceRoot, filePath);

        // Check if any cache entry matches this file
        return Object.values(this.perFileCache).some(entry =>
            entry.filePath === relativePath || entry.filePath === filePath
        );
    }

    /**
     * Invalidate cache for a specific file
     */
    async invalidateFile(filePath: string): Promise<void> {
        await this.initPromise;

        const workspaceFolders = vscode.workspace.workspaceFolders;
        if (!workspaceFolders || workspaceFolders.length === 0) {
            return;
        }

        const workspaceRoot = workspaceFolders[0].uri.fsPath;
        const relativePath = path.relative(workspaceRoot, filePath);

        // Remove all cache entries for this file
        const keysToDelete: string[] = [];
        for (const [key, entry] of Object.entries(this.perFileCache)) {
            if (entry.filePath === relativePath || entry.filePath === filePath) {
                keysToDelete.push(key);
            }
        }

        for (const key of keysToDelete) {
            delete this.perFileCache[key];
        }

        await this.saveCache();
    }

    /**
     * Get all cached graphs
     */
    async getAllCachedGraphs(): Promise<WorkflowGraph[]> {
        await this.initPromise;
        return Object.values(this.perFileCache).map(entry => entry.graph);
    }
}
