/**
 * Metadata Batcher - batches files for LLM metadata fetching
 *
 * Queues files that need labels/descriptions and batches them
 * to reduce API calls.
 */

import { CacheManager, CachedMetadata } from './cache';

/**
 * Context for metadata generation
 */
export interface MetadataContext {
    filePath: string;
    functions: Array<{
        name: string;
        line: number;
        type: string;
        calls: string[];
        code?: string;
    }>;
    imports: string[];
}

/**
 * Callback type for fetching metadata from API
 */
type FetchCallback = (
    files: string[],
    contexts: MetadataContext[]
) => Promise<Map<string, CachedMetadata>>;

/**
 * Callback type when metadata is ready
 */
type ReadyCallback = (
    filePath: string,
    metadata: CachedMetadata
) => void;

export interface MetadataBatcherOptions {
    debounceMs?: number;
    maxWaitMs?: number;
}

export class MetadataBatcher {
    private queue: Map<string, MetadataContext> = new Map();
    private debounceTimer: NodeJS.Timeout | null = null;
    private maxWaitTimer: NodeJS.Timeout | null = null;
    private debounceMs: number;
    private maxWaitMs: number;
    private fetchCallback: FetchCallback | null = null;
    private readyCallback: ReadyCallback | null = null;
    private cacheManager: CacheManager | null = null;

    constructor(options: MetadataBatcherOptions = {}) {
        this.debounceMs = options.debounceMs || 3000;
        this.maxWaitMs = options.maxWaitMs || 30000;
    }

    setCacheManager(cache: CacheManager) {
        this.cacheManager = cache;
    }

    onFetch(callback: FetchCallback) {
        this.fetchCallback = callback;
    }

    onReady(callback: ReadyCallback) {
        this.readyCallback = callback;
    }

    queueFile(filePath: string, context: MetadataContext) {
        this.queue.set(filePath, context);
        this.scheduleFlush();
    }

    cancel() {
        if (this.debounceTimer) {
            clearTimeout(this.debounceTimer);
            this.debounceTimer = null;
        }
        if (this.maxWaitTimer) {
            clearTimeout(this.maxWaitTimer);
            this.maxWaitTimer = null;
        }
        this.queue.clear();
    }

    private scheduleFlush() {
        // Reset debounce timer
        if (this.debounceTimer) {
            clearTimeout(this.debounceTimer);
        }

        this.debounceTimer = setTimeout(() => {
            this.flush();
        }, this.debounceMs);

        // Start max wait timer if not already running
        if (!this.maxWaitTimer) {
            this.maxWaitTimer = setTimeout(() => {
                this.flush();
            }, this.maxWaitMs);
        }
    }

    private async flush() {
        if (this.debounceTimer) {
            clearTimeout(this.debounceTimer);
            this.debounceTimer = null;
        }
        if (this.maxWaitTimer) {
            clearTimeout(this.maxWaitTimer);
            this.maxWaitTimer = null;
        }

        if (this.queue.size === 0) return;
        if (!this.fetchCallback) return;

        const files = Array.from(this.queue.keys());
        const contexts = Array.from(this.queue.values());
        this.queue.clear();

        try {
            const metadataMap = await this.fetchCallback(files, contexts);

            for (const [filePath, metadata] of metadataMap) {
                // Update cache
                if (this.cacheManager) {
                    this.cacheManager.updateMetadata(filePath, metadata);
                }

                // Notify ready callback
                if (this.readyCallback) {
                    this.readyCallback(filePath, metadata);
                }
            }
        } catch (error) {
            console.error('Metadata batch fetch failed:', error);
        }
    }
}

/**
 * Build metadata context from call graph extractor results
 */
export function buildMetadataContext(
    relativePath: string,
    cache: CacheManager,
    callGraph?: { functions: Map<string, any>; callGraph: Map<string, string[]>; imports: string[] },
    codeContent?: string
): MetadataContext | null {
    // Get cached file data
    const fileCache = cache.getFile(relativePath);
    if (!fileCache && !callGraph) {
        return null;
    }

    // Build function info from call graph if available, otherwise from cache nodes
    const functions: MetadataContext['functions'] = [];

    if (callGraph) {
        // Use call graph for more detailed info
        for (const [funcName, funcInfo] of callGraph.functions) {
            // Skip anonymous functions
            if (funcName.startsWith('anonymous_')) continue;

            const calls = callGraph.callGraph.get(funcName) || [];
            functions.push({
                name: funcName,
                line: funcInfo.startLine || 0,
                type: 'function',
                calls: calls
            });
        }
    } else if (fileCache) {
        // Fall back to cache nodes (less detail)
        for (const node of fileCache.nodes) {
            if (node.source?.function) {
                functions.push({
                    name: node.source.function,
                    line: node.source.line || 0,
                    type: node.type,
                    calls: []
                });
            }
        }
    }

    if (functions.length === 0) {
        return null;
    }

    return {
        filePath: relativePath,
        functions,
        imports: callGraph?.imports || []
    };
}

/**
 * Singleton batcher instance
 */
let globalBatcher: MetadataBatcher | null = null;

export function getMetadataBatcher(options?: MetadataBatcherOptions): MetadataBatcher {
    if (!globalBatcher) {
        globalBatcher = new MetadataBatcher(options);
    }
    return globalBatcher;
}

export function resetMetadataBatcher() {
    if (globalBatcher) {
        globalBatcher.cancel();
        globalBatcher = null;
    }
}
