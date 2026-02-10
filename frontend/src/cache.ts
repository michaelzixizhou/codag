/**
 * Cache Manager for Codag
 *
 * Version 8: New node ID format with :: separator
 *
 * Key features:
 * - Cache analysis results per-file (not per-batch)
 * - Cross-file edges stored separately and validated at merge time
 * - Node IDs are deterministic: {path}::{function} or {path}::{function}::{line}
 * - Uses :: as separator (colons forbidden in filenames, so unambiguous)
 * - AST-aware content hashing for change detection
 * - No prefixing needed - IDs are globally unique by design
 */

import * as vscode from 'vscode';
import * as crypto from 'crypto';
import * as path from 'path';
import { WorkflowGraph, WorkflowNode, WorkflowEdge, WorkflowMetadata } from './types';
import { StaticAnalyzer } from './static-analyzer';
import { buildNodeLookup, findMatchingNodeId } from './edge-resolver';
import { isLLMImport } from './providers';
import { CONFIG } from './config';

const CACHE_VERSION = CONFIG.CACHE.VERSION;

/**
 * Cached analysis result for a single file
 */
interface FileCache {
    hash: string;                    // AST-aware content hash
    nodes: WorkflowNode[];           // Nodes from this file (deterministic IDs)
    internalEdges: WorkflowEdge[];   // Edges within this file
    timestamp: number;
    /** Per-node workflow assignments from LLM (nodeId → { id, name }) */
    nodeWorkflows?: Record<string, { id: string; name: string }>;
}

/**
 * Cross-file edge (stored separately, validated at merge)
 */
interface CrossFileEdge {
    sourceFile: string;
    sourceNodeId: string;            // Deterministic node ID
    targetFile: string;
    targetNodeId: string;            // Deterministic node ID
    label?: string;
    timestamp: number;
}

/**
 * Workflow metadata
 */
interface WorkflowInfo {
    id: string;
    name: string;
    description?: string;
    primaryFile: string;
}

/**
 * Full cache file structure
 */
interface CacheFile {
    version: number;
    files: Record<string, FileCache>;
    crossFileEdges: CrossFileEdge[];
    workflows: Record<string, WorkflowInfo>;
}

/**
 * Metadata layer for compatibility
 */
export interface CachedMetadata {
    labels: Record<string, string>;
    descriptions: Record<string, string>;
    edgeLabels: Record<string, string>;
    timestamp: number;
}

export class CacheManager {
    private cachePath: vscode.Uri | null = null;
    private graphPath: vscode.Uri | null = null;
    private files: Record<string, FileCache> = {};
    private crossFileEdges: CrossFileEdge[] = [];
    private workflows: Record<string, WorkflowInfo> = {};
    private initPromise: Promise<void>;
    private staticAnalyzer: StaticAnalyzer;

    // Debounced save
    private saveTimer: NodeJS.Timeout | null = null;
    private saveDebounceMs = 500;
    private maxSaveWaitMs = 5000;
    private lastSaveTime = 0;

    // Cached merged graph for sync access (instant feedback)
    private lastMergedGraph: WorkflowGraph | null = null;

    // Multi-batch analysis state tracking
    // Prevents premature workflow filtering during first analysis
    private analysisInProgress: boolean = false;
    private pendingBatchCount: number = 0;

    constructor(private context: vscode.ExtensionContext) {
        this.initPromise = this.initializeCache();
        this.staticAnalyzer = new StaticAnalyzer();
    }

    /**
     * Convert full path to relative path using workspace root.
     * Ensures consistent cache keys using relative paths for security and portability.
     */
    private toRelativePath(filePath: string): string {
        // Already relative (doesn't start with / or drive letter)
        if (!filePath.startsWith('/') && !filePath.match(/^[A-Z]:\\/i)) {
            return filePath;
        }
        // Convert absolute to relative
        const workspaceRoot = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
        if (workspaceRoot && filePath.startsWith(workspaceRoot)) {
            return filePath.slice(workspaceRoot.length).replace(/^[/\\]/, '');
        }
        return filePath;
    }

    private async initializeCache() {
        const workspaceFolders = vscode.workspace.workspaceFolders;
        if (!workspaceFolders || workspaceFolders.length === 0) {
            return;
        }

        const workspaceFolder = workspaceFolders[0];
        const vscodeFolderPath = path.join(workspaceFolder.uri.fsPath, '.vscode');
        this.cachePath = vscode.Uri.file(path.join(vscodeFolderPath, 'codag-cache.json'));
        this.graphPath = vscode.Uri.file(path.join(vscodeFolderPath, 'codag-graph.json'));

        try {
            await vscode.workspace.fs.createDirectory(vscode.Uri.file(vscodeFolderPath));
        } catch (error) {
            // Directory might already exist
        }

        await this.loadCache();
    }

    private async loadCache() {
        if (!this.cachePath) return;

        try {
            const cacheContent = await vscode.workspace.fs.readFile(this.cachePath);
            const parsed = JSON.parse(cacheContent.toString());

            if (parsed.version === CACHE_VERSION) {
                this.files = parsed.files || {};
                this.crossFileEdges = parsed.crossFileEdges || [];
                this.workflows = parsed.workflows || {};
            } else {
                // Different version - start fresh
                console.log(`Cache version ${parsed.version} → ${CACHE_VERSION}, clearing cache`);
                this.files = {};
                this.crossFileEdges = [];
                this.workflows = {};
            }
        } catch (error) {
            this.files = {};
            this.crossFileEdges = [];
            this.workflows = {};
        }
    }

    private scheduleSave() {
        const now = Date.now();

        if (this.saveTimer && now - this.lastSaveTime > this.maxSaveWaitMs) {
            clearTimeout(this.saveTimer);
            this.saveTimer = null;
            this.saveNow();
            return;
        }

        if (this.saveTimer) {
            clearTimeout(this.saveTimer);
        }

        this.saveTimer = setTimeout(() => {
            this.saveTimer = null;
            this.saveNow();
        }, this.saveDebounceMs);
    }

    private async saveNow() {
        if (!this.cachePath) return;

        try {
            // Create snapshot to avoid race condition with concurrent modifications
            // Deep clone ensures mutations during async write don't corrupt saved data
            const snapshot: CacheFile = {
                version: CACHE_VERSION,
                files: JSON.parse(JSON.stringify(this.files)),
                crossFileEdges: JSON.parse(JSON.stringify(this.crossFileEdges)),
                workflows: JSON.parse(JSON.stringify(this.workflows))
            };
            const cacheContent = JSON.stringify(snapshot, null, 2);
            await vscode.workspace.fs.writeFile(this.cachePath, Buffer.from(cacheContent, 'utf8'));
            this.lastSaveTime = Date.now();
        } catch (error) {
            console.error('Failed to save cache:', error);
        }
    }

    /**
     * Write the merged graph to a standalone JSON file for external consumers (e.g., MCP server).
     */
    private async writeGraphFile(graph: WorkflowGraph | null): Promise<void> {
        if (!this.graphPath) return;
        try {
            if (graph) {
                const content = JSON.stringify(graph, null, 2);
                await vscode.workspace.fs.writeFile(this.graphPath, Buffer.from(content, 'utf8'));
            } else {
                try { await vscode.workspace.fs.delete(this.graphPath); } catch { /* may not exist */ }
            }
        } catch (error) {
            console.error('Failed to write graph file:', error);
        }
    }

    /**
     * Force immediate save of any pending changes.
     * Call this on extension deactivation to ensure cache is persisted.
     */
    async flush(): Promise<void> {
        if (this.saveTimer) {
            clearTimeout(this.saveTimer);
            this.saveTimer = null;
        }
        await this.saveNow();
        await this.writeGraphFile(this.lastMergedGraph);
    }

    // =========================================================================
    // Multi-Batch Analysis State
    // =========================================================================

    /**
     * Start tracking a multi-batch analysis.
     * During multi-batch analysis, workflow filtering is deferred until all batches complete.
     * This prevents nodes from being filtered out before their cross-batch connections are established.
     */
    startMultiBatchAnalysis(totalBatches: number): void {
        this.analysisInProgress = true;
        this.pendingBatchCount = totalBatches;
    }

    /**
     * Mark a batch as completed.
     * When all batches complete, analysis state resets and full filtering is applied.
     */
    batchCompleted(): void {
        if (this.pendingBatchCount > 0) {
            this.pendingBatchCount--;
        }
        if (this.pendingBatchCount === 0) {
            this.analysisInProgress = false;
        }
    }

    /**
     * Check if multi-batch analysis is complete.
     */
    isAnalysisComplete(): boolean {
        return !this.analysisInProgress;
    }

    /**
     * Reset analysis state (e.g., on error or cancellation).
     */
    resetAnalysisState(): void {
        this.analysisInProgress = false;
        this.pendingBatchCount = 0;
    }

    // =========================================================================
    // Hashing
    // =========================================================================

    /**
     * Generate stable file prefix (6 chars) for node ID namespacing
     */
    getFilePrefix(filePath: string): string {
        return crypto.createHash('md5').update(filePath).digest('hex').substring(0, 6);
    }

    /**
     * Hash content (raw)
     */
    private hashContent(content: string): string {
        return crypto.createHash('sha256').update(content).digest('hex');
    }

    /**
     * Hash content using AST-aware method (ignores comments, whitespace)
     *
     * Falls back to raw content hash when:
     * - Tree-sitter is unavailable (parser not initialized)
     * - Analysis returns empty results (no functions/imports detected)
     *
     * This ensures consistent hashing between store and check operations,
     * even if tree-sitter initialization state differs between sessions.
     */
    hashContentAST(content: string, filePath: string): string {
        try {
            const analysis = this.staticAnalyzer.analyze(content, filePath);

            // If analysis returned empty (tree-sitter unavailable or no code),
            // fall back to raw content hash for consistency
            if (analysis.locations.length === 0 && analysis.imports.length === 0) {
                return this.hashContent(content);
            }

            const normalized = {
                imports: analysis.imports.filter(isLLMImport).sort(),
                variables: Array.from(analysis.llmRelatedVariables).sort(),
                locations: analysis.locations.map(loc => ({
                    line: loc.line,
                    type: loc.type,
                    function: loc.function
                })).sort((a, b) => a.line - b.line)
            };
            return crypto.createHash('sha256').update(JSON.stringify(normalized)).digest('hex');
        } catch (error) {
            return this.hashContent(content);
        }
    }

    // =========================================================================
    // Cache Check
    // =========================================================================

    /**
     * Check if file is cached with matching hash
     */
    isFileValid(filePath: string, contentHash: string): boolean {
        const normalizedPath = this.toRelativePath(filePath);
        const cached = this.files[normalizedPath];
        return cached !== undefined && cached.hash === contentHash;
    }

    /**
     * Check if file exists in cache (regardless of hash)
     */
    async isFileCached(filePath: string): Promise<boolean> {
        await this.initPromise;
        const normalizedPath = this.toRelativePath(filePath);
        return normalizedPath in this.files;
    }

    /**
     * Get cached file data
     */
    getFile(filePath: string): FileCache | null {
        const normalizedPath = this.toRelativePath(filePath);
        return this.files[normalizedPath] || null;
    }

    /**
     * Debug: Get info about why a file might be uncached
     */
    debugFileStatus(filePath: string, content: string): {
        inputPath: string;
        normalizedPath: string;
        computedHash: string;
        cachedEntry: boolean;
        cachedHash: string | null;
        hashMatch: boolean;
    } {
        const normalizedPath = this.toRelativePath(filePath);
        const computedHash = this.hashContentAST(content, filePath);
        const cached = this.files[normalizedPath];
        return {
            inputPath: filePath,
            normalizedPath,
            computedHash: computedHash.substring(0, 16) + '...',
            cachedEntry: !!cached,
            cachedHash: cached ? cached.hash.substring(0, 16) + '...' : null,
            hashMatch: cached ? cached.hash === computedHash : false
        };
    }

    /**
     * Check multiple files, return cached vs uncached
     */
    async checkFiles(filePaths: string[], contents: string[]): Promise<{
        cached: { path: string; content: string }[];
        uncached: { path: string; content: string }[];
    }> {
        await this.initPromise;

        const cached: { path: string; content: string }[] = [];
        const uncached: { path: string; content: string }[] = [];

        for (let i = 0; i < filePaths.length; i++) {
            const fp = filePaths[i];
            const content = contents[i];
            const hash = this.hashContentAST(content, fp);
            const normalizedPath = this.toRelativePath(fp);
            const cachedEntry = this.files[normalizedPath];

            if (this.isFileValid(fp, hash)) {
                cached.push({ path: fp, content });
            } else {
                uncached.push({ path: fp, content });
            }
        }

        return { cached, uncached };
    }

    // =========================================================================
    // Store Analysis Results
    // =========================================================================

    /**
     * Store analysis result, splitting by file
     * Node IDs are deterministic (file__function format) so no prefixing needed
     */
    async setAnalysisResult(
        graph: WorkflowGraph,
        contents: Record<string, string>
    ): Promise<void> {
        await this.initPromise;

        // Helper to check if a relative path matches any content key
        const isInBatch = (relativePath: string): boolean => {
            if (contents[relativePath]) return true;
            const normalizedRel = relativePath.replace(/\\/g, '/').replace(/^\//, '');
            for (const fullPath of Object.keys(contents)) {
                const normalizedFull = fullPath.replace(/\\/g, '/');
                if (normalizedFull === normalizedRel) return true;
                if (normalizedFull.endsWith('/' + normalizedRel)) return true;
                if (normalizedFull.endsWith(normalizedRel)) return true;
            }
            return false;
        };

        // Filter nodes to only those for files in this batch
        // LLM sometimes creates symbolic nodes (Frontend_UI, Telnyx_API) — skip them.
        // Also skip nodes for files not in this batch.
        const filteredNodes: WorkflowNode[] = [];
        const skippedNodes: WorkflowNode[] = [];
        for (const node of graph.nodes) {
            const file = node.source?.file || 'unknown';
            // Skip symbolic/unknown nodes — they're not real code locations
            if (file === 'unknown' || !file.includes('.')) {
                skippedNodes.push(node);
            } else if (isInBatch(file)) {
                filteredNodes.push(node);
            } else {
                skippedNodes.push(node);
            }
        }

        // Build node lookup from filtered nodes
        const nodeById = new Map<string, WorkflowNode>();
        const nodeToFile = new Map<string, string>();

        for (const node of filteredNodes) {
            nodeById.set(node.id, node);
            const file = node.source?.file || 'unknown';
            nodeToFile.set(node.id, file);
        }

        // Group nodes by file (IDs are already deterministic)
        const nodesByFile = new Map<string, WorkflowNode[]>();
        for (const node of filteredNodes) {
            const file = node.source?.file || 'unknown';
            if (!nodesByFile.has(file)) nodesByFile.set(file, []);
            nodesByFile.get(file)!.push(node);
        }

        // Categorize edges
        const internalEdgesByFile = new Map<string, WorkflowEdge[]>();
        const newCrossFileEdges: CrossFileEdge[] = [];

        for (const edge of graph.edges) {
            const sourceFile = nodeToFile.get(edge.source);
            const targetFile = nodeToFile.get(edge.target);

            // For cross-batch edges, target might not be in nodeToFile
            // Extract file from deterministic ID format: path::function or path::function::line
            const extractFileFromId = (id: string): string | undefined => {
                // Format: relative/path.ext::function or relative/path.ext::function::line
                // Split on :: (unambiguous since : is forbidden in filenames)
                const parts = id.split('::');
                if (parts.length >= 2) {
                    return parts[0]; // First part is the relative file path
                }
                return undefined;
            };

            const resolvedSourceFile = sourceFile || extractFileFromId(edge.source);
            const resolvedTargetFile = targetFile || extractFileFromId(edge.target);

            if (!resolvedSourceFile) continue;
            // Skip pure garbage edges (source is "--" etc.)
            if (resolvedSourceFile === 'unknown' && resolvedTargetFile === 'unknown') continue;

            if (resolvedSourceFile === resolvedTargetFile) {
                // Internal edge
                if (!internalEdgesByFile.has(resolvedSourceFile)) {
                    internalEdgesByFile.set(resolvedSourceFile, []);
                }
                internalEdgesByFile.get(resolvedSourceFile)!.push(edge);
            } else if (resolvedTargetFile) {
                // Cross-file edge - normalize paths to full paths for consistent matching
                newCrossFileEdges.push({
                    sourceFile: this.toRelativePath(resolvedSourceFile),
                    sourceNodeId: edge.source,
                    targetFile: this.toRelativePath(resolvedTargetFile),
                    targetNodeId: edge.target,
                    label: edge.label,
                    timestamp: Date.now()
                });
            }
        }

        // Helper to find content by matching path suffix
        // Returns both content AND the canonical key (for consistent cache storage)
        const findContentWithKey = (nodePath: string): { content: string; key: string } | undefined => {
            // Try exact match first
            if (contents[nodePath]) return { content: contents[nodePath], key: nodePath };

            // Normalize both paths for comparison
            const normalizedNode = nodePath.replace(/\\/g, '/').replace(/^\//, '');

            for (const [contentKey, content] of Object.entries(contents)) {
                const normalizedKey = contentKey.replace(/\\/g, '/').replace(/^\//, '');

                // Exact match after normalization
                if (normalizedNode === normalizedKey) return { content, key: contentKey };

                // Either path could be full or relative, so check both directions
                // Case 1: nodePath is full, contentKey is relative
                if (normalizedNode.endsWith('/' + normalizedKey)) return { content, key: contentKey };
                if (normalizedNode.endsWith(normalizedKey)) return { content, key: contentKey };

                // Case 2: contentKey is full, nodePath is relative (LLM returned short path)
                if (normalizedKey.endsWith('/' + normalizedNode)) return { content, key: contentKey };
                if (normalizedKey.endsWith(normalizedNode)) return { content, key: contentKey };
            }

            return undefined;
        };

        // Build per-node workflow mapping from LLM-assigned workflows
        // A single file can have nodes in multiple workflows (e.g., gemini.ts serves 5 workflows)
        const nodeToWorkflow = new Map<string, { id: string; name: string }>();
        for (const wf of graph.workflows || []) {
            for (const nodeId of wf.nodeIds) {
                if (!nodeToWorkflow.has(nodeId)) {
                    nodeToWorkflow.set(nodeId, { id: wf.id, name: wf.name });
                }
            }
        }

        // Store per-file using CONTENT key (not LLM's path) for consistent cache lookup
        // Store ALL nodes returned by LLM - filtering happens post-merge based on connectivity
        // Track which content keys we've cached (for the empty-files loop below)
        const cachedContentKeys = new Set<string>();
        for (const [file, nodes] of nodesByFile) {
            const match = findContentWithKey(file);
            if (!match) {
                    continue;
            }

            // Use the content key for storage (matches how checkFiles looks up)
            const normalizedPath = this.toRelativePath(match.key);
            cachedContentKeys.add(normalizedPath);
            const hash = this.hashContentAST(match.content, match.key);

            // Build per-node workflow assignments for this file
            // IMPORTANT: Preserve existing LLM-assigned nodeWorkflows if no new assignments provided
            // This prevents incremental updates from losing workflow assignments
            const existingCache = this.files[normalizedPath];
            const existingNodeWfs = existingCache?.nodeWorkflows || {};

            const nodeWfs: Record<string, { id: string; name: string }> = {};
            for (const n of nodes) {
                const wfAssignment = nodeToWorkflow.get(n.id);
                if (wfAssignment) {
                    // New assignment from graph.workflows
                    nodeWfs[n.id] = wfAssignment;
                } else if (existingNodeWfs[n.id]) {
                    // Preserve existing assignment (from previous LLM analysis)
                    nodeWfs[n.id] = existingNodeWfs[n.id];
                }
            }

            this.files[normalizedPath] = {
                hash,
                nodes,
                internalEdges: internalEdgesByFile.get(file) || [],
                timestamp: Date.now(),
                nodeWorkflows: Object.keys(nodeWfs).length > 0 ? nodeWfs : undefined
            };
        }

        // Cache files that had no nodes (valid result = no LLM workflow)
        // This prevents re-analyzing files we already know have no workflows
        const emptyFiles: string[] = [];
        for (const [filePath, content] of Object.entries(contents)) {
            // Check if already cached by the node-based loop above
            const normalizedPath = this.toRelativePath(filePath);
            if (cachedContentKeys.has(normalizedPath)) continue;

            // Cache as empty (no nodes, no edges)
            const shortPath = filePath.split('/').slice(-2).join('/');
            emptyFiles.push(shortPath);
            this.files[normalizedPath] = {
                hash: this.hashContentAST(content, filePath),
                nodes: [],
                internalEdges: [],
                timestamp: Date.now()
            };
        }
        // Clean up old cross-file edges from files being updated
        // This prevents stale edges when file structure changes
        // IMPORTANT: Normalize paths to match stored edge.sourceFile format (relative paths)
        const updatedFilesNormalized = new Set(
            Object.keys(contents).map(p => this.toRelativePath(p))
        );
        this.crossFileEdges = this.crossFileEdges.filter(
            edge => !updatedFilesNormalized.has(edge.sourceFile)
        );

        // Merge new cross-file edges (dedupe, keep newest)
        this.mergeCrossFileEdges(newCrossFileEdges);

        // Extract workflow info - ONLY for workflows that have nodes in this batch
        // This prevents incremental updates from corrupting workflow metadata for unrelated files
        const batchFilesNormalized = new Set(
            Object.keys(contents).map(p => this.toRelativePath(p))
        );
        for (const wf of graph.workflows || []) {
            // Check if this workflow has nodes in the current batch
            const workflowHasBatchNodes = wf.nodeIds.some(nodeId => {
                const node = nodeById.get(nodeId);
                if (!node?.source?.file) return false;
                const nodeFile = this.toRelativePath(node.source.file);
                return batchFilesNormalized.has(nodeFile);
            });

            if (workflowHasBatchNodes) {
                const primaryFile = this.findPrimaryFile(wf.nodeIds, nodeToFile);
                // Only update if we can determine the primary file from this batch
                if (primaryFile !== 'unknown') {
                    this.workflows[wf.id] = {
                        id: wf.id,
                        name: wf.name,
                        description: wf.description,
                        primaryFile
                    };
                }
            }
        }

        // Clean up stale workflow metadata - but ONLY for workflows whose primary file
        // is in this batch AND now has no nodes. Don't touch workflows from other files.
        for (const [wfId, wf] of Object.entries(this.workflows)) {
            if (wf.primaryFile === 'unknown') {
                delete this.workflows[wfId];
                continue;
            }
            const normalizedPrimary = this.toRelativePath(wf.primaryFile);
            // Only clean up if the primary file was in this batch
            if (!batchFilesNormalized.has(normalizedPrimary)) continue;
            const fileCache = this.files[normalizedPrimary];
            if (!fileCache || fileCache.nodes.length === 0) {
                delete this.workflows[wfId];
            }
        }

        this.scheduleSave();
    }

    /**
     * Find primary file for a workflow (file with most nodes)
     */
    private findPrimaryFile(
        nodeIds: string[],
        nodeToFile: Map<string, string>
    ): string {
        const fileCounts = new Map<string, number>();

        for (const id of nodeIds) {
            const file = nodeToFile.get(id);
            if (file) {
                fileCounts.set(file, (fileCounts.get(file) || 0) + 1);
            }
        }

        let maxFile = 'unknown';
        let maxCount = 0;
        for (const [file, count] of fileCounts) {
            if (count > maxCount) {
                maxCount = count;
                maxFile = file;
            }
        }
        return maxFile;
    }

    /**
     * Merge new cross-file edges with replace-on-conflict behavior
     * Newer edges (by timestamp) replace older ones, preserving latest labels
     */
    private mergeCrossFileEdges(newEdges: CrossFileEdge[]) {
        const edgeKey = (e: CrossFileEdge) =>
            `${e.sourceFile}:${e.sourceNodeId}->${e.targetFile}:${e.targetNodeId}`;

        // Build map from existing edges
        const edgeMap = new Map<string, CrossFileEdge>();
        for (const edge of this.crossFileEdges) {
            edgeMap.set(edgeKey(edge), edge);
        }

        // Merge new edges - replace if newer timestamp
        for (const edge of newEdges) {
            const key = edgeKey(edge);
            const existing = edgeMap.get(key);
            if (!existing || edge.timestamp > existing.timestamp) {
                edgeMap.set(key, edge);
            }
        }

        // Convert back to array
        this.crossFileEdges = Array.from(edgeMap.values());
    }

    // =========================================================================
    // Retrieve & Merge
    // =========================================================================

    /**
     * Get merged graph for display from cached files
     */
    async getMergedGraph(filePaths?: string[]): Promise<WorkflowGraph | null> {
        await this.initPromise;

        // Normalize input paths to relative paths (cache keys are always relative)
        const targetFiles = filePaths
            ? filePaths.map(fp => this.toRelativePath(fp))
            : Object.keys(this.files);
        const allNodes: WorkflowNode[] = [];
        const allEdges: WorkflowEdge[] = [];
        const nodeIds = new Set<string>();
        const llmsDetected = new Set<string>();

        // Collect from cached files (dedupe nodes by ID, keep most complete)
        const nodeById = new Map<string, WorkflowNode>();
        for (const fp of targetFiles) {
            const cached = this.files[fp];
            if (cached) {
                for (const node of cached.nodes) {
                    const existing = nodeById.get(node.id);
                    // Keep node with more complete info (has source.line vs doesn't)
                    if (!existing || (node.source?.line && !existing.source?.line)) {
                        nodeById.set(node.id, node);
                    }
                    nodeIds.add(node.id);
                    if (node.model) llmsDetected.add(node.model);
                }
                allEdges.push(...cached.internalEdges);
            }
        }
        allNodes.push(...nodeById.values());

        // Sanitize purely-numeric labels (LLM sometimes returns sequence numbers instead of names).
        // Replace with the function name from source metadata.
        for (const node of allNodes) {
            if (/^\d+$/.test(node.label) && node.source?.function) {
                node.label = node.source.function.replace(/\(\)$/, '');
            }
        }

        if (allNodes.length === 0) return null;

        // Add valid cross-file edges with fuzzy ID resolution
        // This handles cases where LLM uses shortened paths (e.g., "file.py::func")
        // but actual node IDs have full paths (e.g., "dir/file.py::func")
        const lookup = buildNodeLookup(allNodes);
        for (const edge of this.crossFileEdges) {
            let resolvedSource = findMatchingNodeId(edge.sourceNodeId, lookup);
            let resolvedTarget = findMatchingNodeId(edge.targetNodeId, lookup);

            // Create stub node for cross-file edge targets that don't exist as cached nodes.
            if (resolvedSource && !resolvedTarget) {
                const targetId = edge.targetNodeId;
                const parts = targetId.split('::');
                const isRealFile = parts.length >= 2 && /\.\w+$/.test(parts[0]);

                let stubNode: WorkflowNode | null = null;

                if (isRealFile) {
                    // Real file::function target (endpoint in file with no LLM workflows)
                    const file = parts[0];
                    const func = parts[1];
                    const lineFromId = parts[2] ? parseInt(parts[2], 10) : NaN;
                    stubNode = {
                        id: targetId,
                        label: func,
                        type: 'step',
                        source: { file, line: isNaN(lineFromId) ? 1 : lineFromId, function: func }
                    };
                } else if (targetId !== '--' && targetId.length > 1) {
                    // Symbolic target = external service boundary (Telnyx_API, Frontend_UI, etc.)
                    // Point source to the CALLER's code location so clicking opens where the call is made
                    const sourceNode = nodeById.get(resolvedSource);
                    const callerFile = sourceNode?.source?.file || '';
                    const callerLine = sourceNode?.source?.line || 1;
                    const callerFunc = sourceNode?.source?.function || '';
                    const cleanLabel = targetId
                        .replace(/_/g, ' ')
                        .replace(/([a-z])([A-Z])/g, '$1 $2')
                        .trim();
                    stubNode = {
                        id: targetId,
                        label: cleanLabel,
                        type: 'step',
                        source: { file: callerFile, line: callerLine, function: callerFunc }
                    };
                }

                if (stubNode) {
                    allNodes.push(stubNode);
                    nodeById.set(targetId, stubNode);
                    nodeIds.add(targetId);
                    lookup.exact.add(targetId);
                    lookup.exact.add(targetId.toLowerCase());
                    resolvedTarget = targetId;
                }
            }

            // Same for symbolic sources (external service calling INTO the repo)
            if (!resolvedSource && resolvedTarget) {
                const sourceId = edge.sourceNodeId;
                const parts = sourceId.split('::');
                const isRealFile = parts.length >= 2 && /\.\w+$/.test(parts[0]);

                if (!isRealFile && sourceId !== '--' && sourceId.length > 1) {
                    const targetNode = nodeById.get(resolvedTarget);
                    const targetFile = targetNode?.source?.file || '';
                    const targetLine = targetNode?.source?.line || 1;
                    const targetFunc = targetNode?.source?.function || '';
                    const cleanLabel = sourceId
                        .replace(/_/g, ' ')
                        .replace(/([a-z])([A-Z])/g, '$1 $2')
                        .trim();
                    const stubNode: WorkflowNode = {
                        id: sourceId,
                        label: cleanLabel,
                        type: 'step',
                        source: { file: targetFile, line: targetLine, function: targetFunc }
                    };
                    allNodes.push(stubNode);
                    nodeById.set(sourceId, stubNode);
                    nodeIds.add(sourceId);
                    lookup.exact.add(sourceId);
                    lookup.exact.add(sourceId.toLowerCase());
                    resolvedSource = sourceId;
                }
            }

            if (resolvedSource && resolvedTarget) {
                allEdges.push({
                    source: resolvedSource,
                    target: resolvedTarget,
                    label: edge.label
                });
            }
        }

        // Build workflows from connectivity
        const workflows = this.computeWorkflows(allNodes, allEdges);

        // Filter nodes and edges to only include those in a workflow
        // This prevents ELK layout errors from edges referencing filtered-out nodes
        // IMPORTANT: During multi-batch analysis, defer filtering until all batches complete
        // to prevent nodes from being filtered out before cross-batch connections are established
        let filteredNodes: WorkflowNode[];
        let filteredEdges: WorkflowEdge[];

        if (this.analysisInProgress) {
            // During multi-batch analysis, return ALL nodes/edges
            // Filtering will happen on final merge when all batches complete
            filteredNodes = allNodes;
            filteredEdges = allEdges;
        } else {
            // Analysis complete - apply workflow filtering
            const workflowNodeIds = new Set(workflows.flatMap(wf => wf.nodeIds));
            filteredNodes = allNodes.filter(n => workflowNodeIds.has(n.id));
            // Keep edges where both endpoints are in workflows (including cross-workflow edges)
            filteredEdges = allEdges.filter(e =>
                workflowNodeIds.has(e.source) && workflowNodeIds.has(e.target)
            );
        }

        // Remove self-loop edges (source === target) — never meaningful in a workflow
        filteredEdges = filteredEdges.filter(e => e.source !== e.target);

        const result: WorkflowGraph = {
            nodes: filteredNodes,
            edges: filteredEdges,
            llms_detected: Array.from(llmsDetected),
            workflows
        };

        // Cache for sync access (instant feedback during file changes)
        this.lastMergedGraph = result;

        // Persist for external consumers (MCP server)
        this.writeGraphFile(result);

        return result;
    }

    /**
     * Synchronously get the last known merged graph (for instant feedback).
     * Returns null if no graph has been computed yet.
     * Use this for immediate UI responses before async operations complete.
     */
    getCachedGraphSync(): WorkflowGraph | null {
        return this.lastMergedGraph;
    }

    /**
     * Compute workflows using LLM-assigned workflow names per file,
     * with hub detection for end-to-end shared service inclusion.
     * Falls back to connectivity-based grouping if no assignments exist.
     */
    private computeWorkflows(nodes: WorkflowNode[], edges: WorkflowEdge[]): WorkflowMetadata[] {
        // Phase 1: Group nodes by stored workflow name (per-node from LLM analysis)
        const workflowGroups = new Map<string, { id: string; name: string; description?: string; nodeIds: string[] }>();
        let hasAnyAssignment = false;

        for (const node of nodes) {
            const file = node.source?.file;
            if (!file) continue;
            const normalizedFile = this.toRelativePath(file);
            const cached = this.files[normalizedFile];
            const wfAssignment = cached?.nodeWorkflows?.[node.id];
            if (wfAssignment) {
                hasAnyAssignment = true;
                const key = wfAssignment.name;
                if (!workflowGroups.has(key)) {
                    workflowGroups.set(key, {
                        id: wfAssignment.id || `workflow_${workflowGroups.size}`,
                        name: key,
                        description: this.workflows[wfAssignment.id || '']?.description,
                        nodeIds: []
                    });
                }
                workflowGroups.get(key)!.nodeIds.push(node.id);
            }
        }

        // Fallback: if no files have workflow assignments, use connectivity-based grouping
        if (!hasAnyAssignment) {
            return this.computeWorkflowsByConnectivity(nodes, edges);
        }

        // Phase 2: Iteratively assign orphan nodes via edges until no more changes
        // This handles chains like A→B→C where only A is initially assigned
        const assignedNodes = new Set(
            [...workflowGroups.values()].flatMap(g => g.nodeIds)
        );

        let changed = true;
        let iterations = 0;
        const maxIterations = 20; // Prevent infinite loops

        while (changed && iterations < maxIterations) {
            changed = false;
            iterations++;

            for (const node of nodes) {
                if (assignedNodes.has(node.id)) continue;

                // Find any edge connecting this node to an assigned node
                const connectedEdge = edges.find(
                    e => (e.source === node.id && assignedNodes.has(e.target)) ||
                         (e.target === node.id && assignedNodes.has(e.source))
                );

                if (connectedEdge) {
                    const assignedId = connectedEdge.source === node.id
                        ? connectedEdge.target : connectedEdge.source;
                    for (const wf of workflowGroups.values()) {
                        if (wf.nodeIds.includes(assignedId)) {
                            wf.nodeIds.push(node.id);
                            assignedNodes.add(node.id);
                            changed = true;
                            break;
                        }
                    }
                }
            }
        }

        // Phase 2.5: Reassign misplaced nodes
        // If a node has NO edges within its assigned workflow but DOES have edges to another workflow,
        // move it to where its edges connect. This fixes LLM misassignments.
        const nodeToWf = new Map<string, string>();
        for (const [name, wf] of workflowGroups) {
            for (const nid of wf.nodeIds) nodeToWf.set(nid, name);
        }

        // Build edge adjacency
        const nodeNeighbors = new Map<string, Set<string>>();
        for (const edge of edges) {
            if (!nodeNeighbors.has(edge.source)) nodeNeighbors.set(edge.source, new Set());
            if (!nodeNeighbors.has(edge.target)) nodeNeighbors.set(edge.target, new Set());
            nodeNeighbors.get(edge.source)!.add(edge.target);
            nodeNeighbors.get(edge.target)!.add(edge.source);
        }

        // Find and reassign misplaced nodes
        for (const node of nodes) {
            const currentWf = nodeToWf.get(node.id);
            if (!currentWf) continue;

            const neighbors = nodeNeighbors.get(node.id);
            if (!neighbors || neighbors.size === 0) continue;

            // Count neighbors in current workflow vs other workflows
            let internalCount = 0;
            const externalCounts = new Map<string, number>();

            for (const neighborId of neighbors) {
                const neighborWf = nodeToWf.get(neighborId);
                if (!neighborWf) continue;

                if (neighborWf === currentWf) {
                    internalCount++;
                } else {
                    externalCounts.set(neighborWf, (externalCounts.get(neighborWf) || 0) + 1);
                }
            }

            // If NO internal connections but HAS external connections, reassign
            if (internalCount === 0 && externalCounts.size > 0) {
                // Find workflow with most connections
                let bestWf = currentWf;
                let bestCount = 0;
                for (const [wfName, count] of externalCounts) {
                    if (count > bestCount) {
                        bestCount = count;
                        bestWf = wfName;
                    }
                }

                if (bestWf !== currentWf) {
                    // Remove from current workflow
                    const oldWf = workflowGroups.get(currentWf);
                    if (oldWf) {
                        oldWf.nodeIds = oldWf.nodeIds.filter(id => id !== node.id);
                    }
                    // Add to new workflow
                    const newWf = workflowGroups.get(bestWf);
                    if (newWf && !newWf.nodeIds.includes(node.id)) {
                        newWf.nodeIds.push(node.id);
                        nodeToWf.set(node.id, bestWf);
                    }
                }
            }
        }

        // Phase 3: Handle remaining orphans by creating new workflows for disconnected subgraphs
        // HTTP edges (labeled with [METHOD /path]) are used by webview for layout merging
        const isHttpEdge = (label?: string) => label && /^\s*\[?\s*(GET|POST|PUT|DELETE|PATCH|HEAD|OPTIONS)\s/.test(label);

        // Find any remaining orphan nodes (not in any workflow) and create workflows for their connected components
        const stillOrphaned = nodes.filter(n => !nodeToWf.has(n.id));
        if (stillOrphaned.length > 0) {
            // Build adjacency for orphans
            const orphanAdj = new Map<string, Set<string>>();
            for (const n of stillOrphaned) orphanAdj.set(n.id, new Set());
            for (const edge of edges) {
                const srcOrphan = orphanAdj.has(edge.source);
                const tgtOrphan = orphanAdj.has(edge.target);
                if (srcOrphan && tgtOrphan) {
                    orphanAdj.get(edge.source)!.add(edge.target);
                    orphanAdj.get(edge.target)!.add(edge.source);
                }
            }

            // Find connected components among orphans
            const visited = new Set<string>();
            for (const orphan of stillOrphaned) {
                if (visited.has(orphan.id)) continue;

                // BFS to find connected component
                const component: string[] = [];
                const queue = [orphan.id];
                while (queue.length > 0) {
                    const curr = queue.shift()!;
                    if (visited.has(curr)) continue;
                    visited.add(curr);
                    component.push(curr);
                    for (const neighbor of orphanAdj.get(curr) || []) {
                        if (!visited.has(neighbor)) queue.push(neighbor);
                    }
                }

                // Create workflow for this orphan component
                if (component.length > 0) {
                    const primaryNode = nodes.find(n => n.id === component[0]);
                    const fileName = primaryNode?.source?.file?.split('/').pop()?.replace(/\.[^.]+$/, '') || 'orphan';
                    const wfName = `${fileName.replace(/[-_]/g, ' ').replace(/\b\w/g, c => c.toUpperCase())}`;
                    const wfId = `orphan_${crypto.createHash('md5').update(component.join(',')).digest('hex').slice(0, 8)}`;

                    workflowGroups.set(wfName, {
                        id: wfId,
                        name: wfName,
                        nodeIds: component
                    });
                    for (const nid of component) nodeToWf.set(nid, wfName);
                }
            }
        }

        // Phase 4: Auto-create workflows for orphan HTTP endpoint nodes
        // Nodes targeted by HTTP edges but not in any workflow need a home,
        // otherwise the inter-workflow HTTP edges get filtered out.
        const assignedAfterMerge = new Set(
            [...workflowGroups.values()].flatMap(g => g.nodeIds)
        );
        const httpOrphansByFile = new Map<string, string[]>();
        for (const edge of edges) {
            if (!isHttpEdge(edge.label)) continue;
            if (assignedAfterMerge.has(edge.target)) continue;
            // Target is an orphan endpoint node
            const targetNode = nodes.find(n => n.id === edge.target);
            const file = targetNode?.source?.file || 'unknown';
            if (!httpOrphansByFile.has(file)) httpOrphansByFile.set(file, []);
            if (!httpOrphansByFile.get(file)!.includes(edge.target)) {
                httpOrphansByFile.get(file)!.push(edge.target);
            }
        }
        if (httpOrphansByFile.size > 0) {
            for (const [file, orphanIds] of httpOrphansByFile) {
                const shortName = file.split('/').pop()?.replace(/\.[^.]+$/, '') || file;
                const wfName = `${shortName.replace(/[-_]/g, ' ').replace(/\b\w/g, c => c.toUpperCase())} API`;
                workflowGroups.set(wfName, {
                    id: `api_${crypto.createHash('md5').update(file).digest('hex').slice(0, 8)}`,
                    name: wfName,
                    nodeIds: orphanIds
                });
                for (const nid of orphanIds) nodeToWf.set(nid, wfName);
            }
        }

        // Phase 5: Hub detection — identify shared service files
        const nodeFile = new Map<string, string>();
        for (const node of nodes) {
            if (node.source?.file) nodeFile.set(node.id, node.source.file);
        }

        // Count how many distinct workflow groups target each file
        const fileIncomingWorkflows = new Map<string, Set<string>>();
        for (const edge of edges) {
            const sourceFile = nodeFile.get(edge.source);
            const targetFile = nodeFile.get(edge.target);
            if (!sourceFile || !targetFile || sourceFile === targetFile) continue;

            const sourceWf = [...workflowGroups.values()]
                .find(wf => wf.nodeIds.includes(edge.source));
            if (!sourceWf) continue;

            if (!fileIncomingWorkflows.has(targetFile)) {
                fileIncomingWorkflows.set(targetFile, new Set());
            }
            fileIncomingWorkflows.get(targetFile)!.add(sourceWf.name);
        }

        const hubFiles = new Set<string>();
        for (const [file, wfNames] of fileIncomingWorkflows) {
            if (wfNames.size >= CONFIG.WORKFLOW.HUB_FILE_THRESHOLD) {
                hubFiles.add(file);
            }
        }

        // Phase 6: BFS through hub files for end-to-end workflow paths
        // Each workflow follows its outgoing edges through shared services
        // IMPORTANT: A node can only belong to ONE workflow - don't add if already assigned
        const hubNodeIds = new Set(
            nodes.filter(n => hubFiles.has(n.source?.file || '')).map(n => n.id)
        );
        const edgesBySource = new Map<string, string[]>();
        for (const edge of edges) {
            if (!edgesBySource.has(edge.source)) edgesBySource.set(edge.source, []);
            edgesBySource.get(edge.source)!.push(edge.target);
        }

        // Rebuild global node→workflow mapping before hub traversal
        const globalNodeToWf = new Map<string, string>();
        for (const [name, wf] of workflowGroups) {
            for (const nid of wf.nodeIds) {
                if (!globalNodeToWf.has(nid)) {
                    globalNodeToWf.set(nid, name);
                }
            }
        }

        for (const wf of workflowGroups.values()) {
            const queue = [...wf.nodeIds];
            const visited = new Set(wf.nodeIds);

            while (queue.length > 0) {
                const curr = queue.shift()!;
                for (const target of edgesBySource.get(curr) || []) {
                    if (visited.has(target)) continue;
                    // Only traverse into hub nodes that aren't already assigned to another workflow
                    if (hubNodeIds.has(target) && !globalNodeToWf.has(target)) {
                        wf.nodeIds.push(target);
                        visited.add(target);
                        globalNodeToWf.set(target, wf.name);
                        queue.push(target);
                    }
                }
            }
        }

        // Phase 7: Filter workflows.
        // A workflow must either contain an LLM node, or be connected via cross-workflow
        // edges to a workflow that does. UI-only files (droppable-cell.tsx, etc.) get removed.
        const nodeByIdMap = new Map(nodes.map(n => [n.id, n]));
        const edgeNodeIds = new Set(edges.flatMap(e => [e.source, e.target]));

        const mapped = [...workflowGroups.values()]
            .map(wf => {
                // Fix numeric-only workflow names — derive from primary file instead
                let name = wf.name;
                if (/^\d+$/.test(name)) {
                    const primaryNode = nodes.find(n => wf.nodeIds.includes(n.id) && n.source?.file);
                    if (primaryNode?.source?.file) {
                        const fileName = primaryNode.source.file.split('/').pop()?.replace(/\.[^.]+$/, '') || name;
                        name = fileName.replace(/[-_]/g, ' ').replace(/\b\w/g, c => c.toUpperCase());
                    }
                }
                return {
                    id: wf.id,
                    name,
                    description: wf.description,
                    nodeIds: wf.nodeIds
                };
            })
            .filter(wf => {
                // Drop tiny single-node workflows that participate in no edges
                if (wf.nodeIds.length < CONFIG.WORKFLOW.MIN_NODES_RENDERED) {
                    if (!wf.nodeIds.some(id => edgeNodeIds.has(id))) return false;
                }
                return true;
            });

        // Identify which workflows have LLM nodes
        const hasLLM = new Map<string, boolean>();
        for (const wf of mapped) {
            hasLLM.set(wf.id, wf.nodeIds.some(id => nodeByIdMap.get(id)?.type === 'llm'));
        }

        // Check cross-workflow connectivity: a non-LLM workflow is kept only if
        // it shares an edge with a workflow that has LLM nodes
        const wfByNodeId = new Map<string, string>();
        for (const wf of mapped) {
            for (const nid of wf.nodeIds) wfByNodeId.set(nid, wf.id);
        }

        // Build cross-workflow adjacency
        const wfNeighbors = new Map<string, Set<string>>();
        for (const wf of mapped) wfNeighbors.set(wf.id, new Set());
        for (const edge of edges) {
            const srcWf = wfByNodeId.get(edge.source);
            const tgtWf = wfByNodeId.get(edge.target);
            if (srcWf && tgtWf && srcWf !== tgtWf) {
                wfNeighbors.get(srcWf)?.add(tgtWf);
                wfNeighbors.get(tgtWf)?.add(srcWf);
            }
        }

        // BFS from LLM workflows to find all reachable workflows
        const reachable = new Set<string>();
        const queue: string[] = [];
        for (const wf of mapped) {
            if (hasLLM.get(wf.id)) {
                reachable.add(wf.id);
                queue.push(wf.id);
            }
        }
        while (queue.length > 0) {
            const curr = queue.shift()!;
            for (const neighbor of wfNeighbors.get(curr) || []) {
                if (!reachable.has(neighbor)) {
                    reachable.add(neighbor);
                    queue.push(neighbor);
                }
            }
        }

        const result = mapped.filter(wf => reachable.has(wf.id));

        return result;
    }

    /**
     * Fallback: compute workflows from graph connectivity (original algorithm).
     * Used when no LLM workflow assignments are stored in cache.
     */
    private computeWorkflowsByConnectivity(nodes: WorkflowNode[], edges: WorkflowEdge[]): WorkflowMetadata[] {
        // Build undirected adjacency list
        const adj = new Map<string, Set<string>>();
        for (const node of nodes) {
            adj.set(node.id, new Set());
        }
        for (const edge of edges) {
            adj.get(edge.source)?.add(edge.target);
            adj.get(edge.target)?.add(edge.source);
        }

        // Find connected components via BFS
        const visited = new Set<string>();
        const components: string[][] = [];

        for (const node of nodes) {
            if (visited.has(node.id)) continue;

            const component: string[] = [];
            const stack = [node.id];

            while (stack.length > 0) {
                const curr = stack.pop()!;
                if (visited.has(curr)) continue;
                visited.add(curr);
                component.push(curr);

                for (const neighbor of adj.get(curr) || []) {
                    if (!visited.has(neighbor)) {
                        stack.push(neighbor);
                    }
                }
            }

            if (component.length > 0) {
                components.push(component);
            }
        }

        // Create workflow metadata for each component
        return components.map((nodeIds, idx) => {
            let name: string | undefined;
            let description: string | undefined;
            let matchedId: string | undefined;

            const nodeIdSet = new Set(nodeIds);

            // Look for cached workflow that shares nodes with this component
            for (const [wfId, wf] of Object.entries(this.workflows)) {
                const componentNodes = nodes.filter(n => nodeIdSet.has(n.id));
                const hasMatchingFile = componentNodes.some(n => n.source?.file === wf.primaryFile);

                if (hasMatchingFile) {
                    name = wf.name;
                    description = wf.description;
                    matchedId = wfId;
                    break;
                }
            }

            // Fallback: derive name from primary node's function/file
            if (!name) {
                const primaryNode = nodes.find(n => nodeIdSet.has(n.id) && n.type === 'llm');
                const fallbackNode = primaryNode || nodes.find(n => nodeIdSet.has(n.id));

                const funcName = fallbackNode?.source?.function;
                if (funcName && !funcName.startsWith('anonymous') && funcName !== 'lambda') {
                    name = funcName
                        .replace(/_/g, ' ')
                        .replace(/([a-z])([A-Z])/g, '$1 $2')
                        .replace(/\b\w/g, c => c.toUpperCase());
                } else if (fallbackNode?.source?.file) {
                    const fileName = fallbackNode.source.file.split('/').pop() || 'unknown';
                    name = fileName.replace(/\.[^.]+$/, '')
                        .replace(/[-_]/g, ' ')
                        .replace(/\b\w/g, c => c.toUpperCase());
                } else {
                    name = `Workflow ${idx + 1}`;
                }
            }

            return {
                id: matchedId || `workflow_${idx}`,
                name,
                description,
                nodeIds
            };
        }).filter(wf => {
            const workflowNodes = nodes.filter(n => wf.nodeIds.includes(n.id));
            return workflowNodes.some(n => n.type === 'llm');
        });
    }

    // =========================================================================
    // Invalidation & Clear
    // =========================================================================

    /**
     * Invalidate a single file and its cross-file edges
     */
    async invalidateFile(filePath: string): Promise<void> {
        await this.initPromise;

        // Normalize path to full path (cache keys are always full paths)
        const normalizedPath = this.toRelativePath(filePath);

        // Remove file cache
        delete this.files[normalizedPath];

        // Remove cross-file edges involving this file
        this.crossFileEdges = this.crossFileEdges.filter(
            e => e.sourceFile !== normalizedPath && e.targetFile !== normalizedPath
        );

        this.scheduleSave();
    }

    /**
     * Clear all cache
     */
    async clear() {
        this.files = {};
        this.crossFileEdges = [];
        this.workflows = {};
        this.lastMergedGraph = null;
        await this.saveNow();
        await this.writeGraphFile(null);
    }

    // =========================================================================
    // Compatibility methods
    // =========================================================================

    /**
     * Get all cached file paths
     */
    async getCachedFilePaths(): Promise<string[]> {
        await this.initPromise;
        return Object.keys(this.files);
    }

    /**
     * Update metadata for nodes in a cached file
     */
    updateMetadata(filePath: string, metadata: CachedMetadata) {
        const normalizedPath = this.toRelativePath(filePath);
        const fileCache = this.files[normalizedPath];
        if (!fileCache) return;

        let updated = false;
        for (const node of fileCache.nodes) {
            const funcName = node.source?.function;
            if (!funcName) continue;

            // Update label if provided
            if (metadata.labels[funcName] && metadata.labels[funcName] !== node.label) {
                node.label = metadata.labels[funcName];
                updated = true;
            }

            // Update description if provided
            if (metadata.descriptions?.[funcName]) {
                node.description = metadata.descriptions[funcName];
                updated = true;
            }
        }

        // Update edge labels
        if (metadata.edgeLabels && Object.keys(metadata.edgeLabels).length > 0) {
            for (const edge of fileCache.internalEdges) {
                const edgeKey = `${edge.source}->${edge.target}`;
                if (metadata.edgeLabels[edgeKey]) {
                    edge.label = metadata.edgeLabels[edgeKey];
                    updated = true;
                }
            }
        }

        if (updated) {
            this.scheduleSave();
        }
    }

    /**
     * Prune stale entries for files that no longer exist
     */
    async pruneStaleEntries(existingFiles: string[]): Promise<number> {
        await this.initPromise;

        // Normalize input paths to match cache keys (always relative paths)
        const existingSet = new Set(existingFiles.map(fp => this.toRelativePath(fp)));
        const toDelete: string[] = [];

        for (const filePath of Object.keys(this.files)) {
            if (!existingSet.has(filePath)) {
                toDelete.push(filePath);
            }
        }

        for (const fp of toDelete) {
            delete this.files[fp];
        }

        // Also prune cross-file edges
        this.crossFileEdges = this.crossFileEdges.filter(
            e => existingSet.has(e.sourceFile) && existingSet.has(e.targetFile)
        );

        if (toDelete.length > 0) {
            this.scheduleSave();
        }

        return toDelete.length;
    }

    /**
     * Get cache stats for debugging
     */
    async getStats(): Promise<{ fileCount: number; nodeCount: number; edgeCount: number }> {
        await this.initPromise;

        let nodeCount = 0;
        let edgeCount = 0;

        for (const fc of Object.values(this.files)) {
            nodeCount += fc.nodes.length;
            edgeCount += fc.internalEdges.length;
        }
        edgeCount += this.crossFileEdges.length;

        return {
            fileCount: Object.keys(this.files).length,
            nodeCount,
            edgeCount
        };
    }
}
