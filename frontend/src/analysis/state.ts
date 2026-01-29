/**
 * Centralized state management for analysis operations.
 * All mutable state used across the extension is managed here.
 */

import { ExtractedCallGraph } from '../call-graph-extractor';
import { HttpConnection, CrossFileCall } from '../repo-structure';

// ============================================================================
// Static Analysis State (HTTP connections and cross-file calls)
// ============================================================================

let httpConnections: HttpConnection[] = [];
let crossFileCalls: CrossFileCall[] = [];
let repoFiles: { path: string; functions: { name: string; calls: string[]; line: number }[] }[] = [];

export function getHttpConnections(): HttpConnection[] {
    return httpConnections;
}

export function setHttpConnections(connections: HttpConnection[]): void {
    httpConnections = connections;
}

export function getCrossFileCalls(): CrossFileCall[] {
    return crossFileCalls;
}

export function setCrossFileCalls(calls: CrossFileCall[]): void {
    crossFileCalls = calls;
}

export function getRepoFiles(): { path: string; functions: { name: string; calls: string[]; line: number }[] }[] {
    return repoFiles;
}

export function setRepoFiles(files: { path: string; functions: { name: string; calls: string[]; line: number }[] }[]): void {
    repoFiles = files;
}

// ============================================================================
// Analysis Session State
// ============================================================================

let analysisSession = 0;

export function getAnalysisSession(): number {
    return analysisSession;
}

export function incrementAnalysisSession(): number {
    return ++analysisSession;
}

// ============================================================================
// Call Graph Cache (with persistence)
// ============================================================================

const cachedCallGraphs = new Map<string, ExtractedCallGraph>();
let extensionContext: { globalState: { get: (key: string) => any; update: (key: string, value: any) => Thenable<void> } } | null = null;
const CALL_GRAPH_CACHE_KEY = 'codag.callGraphCache.v1';

/** Serializable format for ExtractedCallGraph */
interface SerializedCallGraph {
    filePath: string;
    functions: [string, any][];  // Array of [key, value] tuples
    callGraph: [string, string[]][];
    llmCalls: [string, any[]][];
    imports: string[];
    hash: string;
}

function serializeCallGraph(graph: ExtractedCallGraph): SerializedCallGraph {
    return {
        filePath: graph.filePath,
        functions: Array.from(graph.functions.entries()),
        callGraph: Array.from(graph.callGraph.entries()),
        llmCalls: Array.from(graph.llmCalls.entries()),
        imports: graph.imports,
        hash: graph.hash
    };
}

function deserializeCallGraph(data: SerializedCallGraph): ExtractedCallGraph {
    return {
        filePath: data.filePath,
        functions: new Map(data.functions),
        callGraph: new Map(data.callGraph),
        llmCalls: new Map(data.llmCalls),
        imports: data.imports,
        hash: data.hash
    };
}

/** Initialize call graph persistence with extension context */
export function initCallGraphPersistence(ctx: { globalState: { get: (key: string) => any; update: (key: string, value: any) => Thenable<void> } }): void {
    extensionContext = ctx;
    loadCallGraphsFromStorage();
}

/** Load call graphs from persistent storage */
function loadCallGraphsFromStorage(): void {
    if (!extensionContext) return;

    try {
        const stored = extensionContext.globalState.get(CALL_GRAPH_CACHE_KEY) as Record<string, SerializedCallGraph> | undefined;
        if (stored) {
            cachedCallGraphs.clear();
            for (const [key, value] of Object.entries(stored)) {
                cachedCallGraphs.set(key, deserializeCallGraph(value));
            }
            console.log(`[CallGraph] Loaded ${cachedCallGraphs.size} cached call graphs`);
        }
    } catch (e) {
        console.error('[CallGraph] Failed to load from storage:', e);
    }
}

/** Save call graphs to persistent storage (debounced) */
let saveTimeout: NodeJS.Timeout | null = null;
function saveCallGraphsToStorage(): void {
    if (!extensionContext) return;

    // Debounce saves to avoid excessive writes
    if (saveTimeout) clearTimeout(saveTimeout);
    saveTimeout = setTimeout(() => {
        try {
            const toStore: Record<string, SerializedCallGraph> = {};
            for (const [key, value] of cachedCallGraphs.entries()) {
                toStore[key] = serializeCallGraph(value);
            }
            extensionContext!.globalState.update(CALL_GRAPH_CACHE_KEY, toStore);
        } catch (e) {
            console.error('[CallGraph] Failed to save to storage:', e);
        }
    }, 1000);
}

export function getCachedCallGraph(filePath: string): ExtractedCallGraph | undefined {
    return cachedCallGraphs.get(filePath);
}

export function setCachedCallGraph(filePath: string, graph: ExtractedCallGraph): void {
    cachedCallGraphs.set(filePath, graph);
    saveCallGraphsToStorage();
}

export function hasCachedCallGraph(filePath: string): boolean {
    return cachedCallGraphs.has(filePath);
}

export function clearCachedCallGraphs(): void {
    cachedCallGraphs.clear();
    if (extensionContext) {
        extensionContext.globalState.update(CALL_GRAPH_CACHE_KEY, undefined);
    }
}

// ============================================================================
// File Change Debouncing
// ============================================================================

const pendingChanges = new Map<string, NodeJS.Timeout>();

export function getPendingChange(filePath: string): NodeJS.Timeout | undefined {
    return pendingChanges.get(filePath);
}

export function setPendingChange(filePath: string, timeout: NodeJS.Timeout): void {
    pendingChanges.set(filePath, timeout);
}

export function deletePendingChange(filePath: string): boolean {
    return pendingChanges.delete(filePath);
}

export function clearPendingChange(filePath: string): void {
    const existing = pendingChanges.get(filePath);
    if (existing) {
        clearTimeout(existing);
        pendingChanges.delete(filePath);
    }
}

// ============================================================================
// Live File Indicator State
// ============================================================================

interface ActiveEditingState {
    timer: NodeJS.Timeout;
    functions: string[];
}

const activelyEditingFiles = new Map<string, ActiveEditingState>();
const changedFiles = new Map<string, string[]>();

export function getActivelyEditing(filePath: string): ActiveEditingState | undefined {
    return activelyEditingFiles.get(filePath);
}

export function setActivelyEditing(filePath: string, state: ActiveEditingState): void {
    activelyEditingFiles.set(filePath, state);
}

export function clearActivelyEditing(filePath: string): void {
    const existing = activelyEditingFiles.get(filePath);
    if (existing) {
        clearTimeout(existing.timer);
        activelyEditingFiles.delete(filePath);
    }
}

export function getChangedFunctions(filePath: string): string[] | undefined {
    return changedFiles.get(filePath);
}

export function setChangedFunctions(filePath: string, functions: string[]): void {
    changedFiles.set(filePath, functions);
}

export function clearChangedFunctions(filePath: string): void {
    changedFiles.delete(filePath);
}

// ============================================================================
// State Reset (for testing or clearing)
// ============================================================================

export function resetAllState(): void {
    httpConnections = [];
    crossFileCalls = [];
    analysisSession = 0;
    cachedCallGraphs.clear();

    // Clear all pending change timeouts
    for (const timeout of pendingChanges.values()) {
        clearTimeout(timeout);
    }
    pendingChanges.clear();

    // Clear all editing timers
    for (const state of activelyEditingFiles.values()) {
        clearTimeout(state.timer);
    }
    activelyEditingFiles.clear();
    changedFiles.clear();
}
