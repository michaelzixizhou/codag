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
     */
    hashContentAST(content: string, filePath: string): string {
        try {
            const analysis = this.staticAnalyzer.analyze(content, filePath);
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
        // LLM sometimes creates nodes for files mentioned in HTTP connections context
        const filteredNodes: WorkflowNode[] = [];
        const skippedNodes: WorkflowNode[] = [];
        for (const node of graph.nodes) {
            const file = node.source?.file || 'unknown';
            if (file === 'unknown' || isInBatch(file)) {
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
        // Handles mismatch between paths - either direction (full↔relative)
        const findContent = (nodePath: string): string | undefined => {
            // Try exact match first
            if (contents[nodePath]) return contents[nodePath];

            // Normalize both paths for comparison
            const normalizedNode = nodePath.replace(/\\/g, '/').replace(/^\//, '');

            for (const [contentKey, content] of Object.entries(contents)) {
                const normalizedKey = contentKey.replace(/\\/g, '/').replace(/^\//, '');

                // Exact match after normalization
                if (normalizedNode === normalizedKey) return content;

                // Either path could be full or relative, so check both directions
                // Case 1: nodePath is full, contentKey is relative
                if (normalizedNode.endsWith('/' + normalizedKey)) return content;
                if (normalizedNode.endsWith(normalizedKey)) return content;

                // Case 2: contentKey is full, nodePath is relative
                if (normalizedKey.endsWith('/' + normalizedNode)) return content;
                if (normalizedKey.endsWith(normalizedNode)) return content;
            }

            return undefined;
        };

        // Store per-file (normalize to full paths for consistent cache keys)
        // Store ALL nodes returned by LLM - filtering happens post-merge based on connectivity
        console.log(`[CACHE] Storing batch results for ${nodesByFile.size} files with nodes:`);
        for (const [file, nodes] of nodesByFile) {
            const content = findContent(file);
            if (!content) {
                    continue;
            }

            const normalizedPath = this.toRelativePath(file);
            const hash = this.hashContentAST(content, file);

            this.files[normalizedPath] = {
                hash,
                nodes,
                internalEdges: internalEdgesByFile.get(file) || [],
                timestamp: Date.now()
            };
        }

        // Cache files that had no nodes (valid result = no LLM workflow)
        // This prevents re-analyzing files we already know have no workflows
        const emptyFiles: string[] = [];
        for (const [filePath, content] of Object.entries(contents)) {
            // Check if already cached by the node-based loop above
            // Both nodesByFile (from node.source.file) and contents use relative paths now
            let alreadyCached = false;
            const normalizedContent = filePath.replace(/\\/g, '/').replace(/^\//, '');
            for (const nodeFilePath of nodesByFile.keys()) {
                const normalizedNode = nodeFilePath.replace(/\\/g, '/');
                // Check both directions since either could be full or relative
                if (normalizedNode === normalizedContent ||
                    normalizedNode.endsWith('/' + normalizedContent) ||
                    normalizedContent.endsWith('/' + normalizedNode)) {
                    alreadyCached = true;
                    break;
                }
            }
            if (alreadyCached) continue;

            // Cache as empty (no nodes, no edges)
            // Normalize to full path for consistent cache keys
            const normalizedPath = this.toRelativePath(filePath);
            const shortPath = filePath.split('/').slice(-2).join('/');
            emptyFiles.push(shortPath);
            this.files[normalizedPath] = {
                hash: this.hashContentAST(content, filePath),
                nodes: [],
                internalEdges: [],
                timestamp: Date.now()
            };
        }
        if (emptyFiles.length > 0) {
            console.log(`[CACHE] Files with NO nodes (LLM returned NO_LLM_WORKFLOW): ${emptyFiles.length}`);
            for (const f of emptyFiles.slice(0, 10)) {
                console.log(`[CACHE]   ∅ ${f}`);
            }
            if (emptyFiles.length > 10) {
                console.log(`[CACHE]   ... and ${emptyFiles.length - 10} more`);
            }
        }

        // Clean up old cross-file edges from files being updated
        // This prevents stale edges when file structure changes
        const updatedFiles = new Set(Object.keys(contents));
        this.crossFileEdges = this.crossFileEdges.filter(
            edge => !updatedFiles.has(edge.sourceFile)
        );

        // Merge new cross-file edges (dedupe, keep newest)
        this.mergeCrossFileEdges(newCrossFileEdges);

        // Extract workflow info
        for (const wf of graph.workflows || []) {
            const primaryFile = this.findPrimaryFile(wf.nodeIds, nodeToFile);
            this.workflows[wf.id] = {
                id: wf.id,
                name: wf.name,
                description: wf.description,
                primaryFile
            };
        }

        // Clean up stale workflow metadata - remove workflows whose primary file has no nodes
        for (const [wfId, wf] of Object.entries(this.workflows)) {
            if (wf.primaryFile === 'unknown') {
                delete this.workflows[wfId];
                continue;
            }
            const normalizedPrimary = this.toRelativePath(wf.primaryFile);
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

        if (allNodes.length === 0) return null;

        // Add valid cross-file edges with fuzzy ID resolution
        // This handles cases where LLM uses shortened paths (e.g., "file.py::func")
        // but actual node IDs have full paths (e.g., "dir/file.py::func")
        const lookup = buildNodeLookup(allNodes);
        for (const edge of this.crossFileEdges) {
            const resolvedSource = findMatchingNodeId(edge.sourceNodeId, lookup);
            const resolvedTarget = findMatchingNodeId(edge.targetNodeId, lookup);
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

        return {
            nodes: allNodes,
            edges: allEdges,
            llms_detected: Array.from(llmsDetected),
            workflows
        };
    }

    /**
     * Compute workflows from graph connectivity, preserving LLM-provided names
     */
    private computeWorkflows(nodes: WorkflowNode[], edges: WorkflowEdge[]): WorkflowMetadata[] {
        // Build adjacency list
        const adj = new Map<string, Set<string>>();
        for (const node of nodes) {
            adj.set(node.id, new Set());
        }
        for (const edge of edges) {
            adj.get(edge.source)?.add(edge.target);
            adj.get(edge.target)?.add(edge.source);
        }

        // Find connected components
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
            // Find workflow info by matching node IDs (more reliable than primaryFile)
            let name: string | undefined;
            let description: string | undefined;
            let matchedId: string | undefined;

            // Build set for faster lookup
            const nodeIdSet = new Set(nodeIds);

            // Look for cached workflow that shares nodes with this component
            for (const [wfId, wf] of Object.entries(this.workflows)) {
                // Check if this workflow's primary file matches any node in component
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
                // Skip anonymous/lambda function names - use file name instead
                if (funcName && !funcName.startsWith('anonymous') && funcName !== 'lambda') {
                    // Convert function_name to Title Case
                    name = funcName
                        .replace(/_/g, ' ')
                        .replace(/([a-z])([A-Z])/g, '$1 $2')
                        .replace(/\b\w/g, c => c.toUpperCase());
                } else if (fallbackNode?.source?.file) {
                    // Use filename without extension
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
            // Filter out workflows without LLM nodes
            const workflowNodes = nodes.filter(n => wf.nodeIds.includes(n.id));
            const hasLLMNode = workflowNodes.some(n => n.type === 'llm');
            if (!hasLLMNode) {
                console.log(`[CACHE] Filtering workflow "${wf.name}" - no LLM nodes`);
            }
            return hasLLMNode;
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
        await this.saveNow();
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
