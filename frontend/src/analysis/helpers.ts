/**
 * Helper functions used across analysis operations.
 */

import { WorkflowGraph } from '../api';
import { addHttpConnectionEdges, addCrossFileCallEdges, addHttpCallerEdges } from '../edge-resolver';
import { getHttpConnections, getCrossFileCalls, getRepoFiles } from './state';
import { RawRepoStructure, FileStructure } from '../repo-structure';

/**
 * Add statically-detected edges (HTTP connections + cross-file calls) to a graph.
 * This should be called before ANY graph display to ensure static edges are included.
 */
export function withHttpEdges(
    graph: WorkflowGraph | null,
    log: (msg: string) => void
): WorkflowGraph | null {
    if (!graph) return null;

    let result = graph;
    const httpConnections = getHttpConnections();
    const crossFileCalls = getCrossFileCalls();
    const repoFiles = getRepoFiles();

    // Add HTTP connection edges (client → backend handler)
    if (httpConnections.length > 0) {
        const httpResult = addHttpConnectionEdges(result, httpConnections, log);
        result = httpResult.graph;

        // Add HTTP caller edges (frontend caller → client)
        if (repoFiles.length > 0) {
            const callerResult = addHttpCallerEdges(result, httpConnections, repoFiles, log);
            result = callerResult.graph;
        }
    }

    // Add cross-file call edges
    if (crossFileCalls.length > 0) {
        const callResult = addCrossFileCallEdges(result, crossFileCalls, log);
        result = callResult.graph;
    }

    return result;
}

/**
 * Trace call graph from seed files to find all files with LLM calls.
 * Uses imports and function calls to find transitively connected LLM code.
 *
 * @param repoStructure - The extracted repo structure with functions, imports, and calls
 * @param seedFiles - Starting files (e.g., HTTP handlers) to trace from
 * @returns Set of file paths that are connected to LLM calls
 */
export function traceCallGraphToLLM(repoStructure: RawRepoStructure, seedFiles: Set<string>): Set<string> {
    const result = new Set<string>();

    // Build lookup maps for efficient resolution
    const fileByPath = new Map<string, FileStructure>();
    const fileByBasename = new Map<string, FileStructure[]>();
    const exportedSymbolToFile = new Map<string, string>();

    for (const file of repoStructure.files) {
        fileByPath.set(file.path, file);

        // Index by basename for fuzzy matching
        const basename = file.path.split('/').pop() || file.path;
        const basenameNoExt = basename.replace(/\.(py|ts|js|tsx|jsx)$/, '');
        if (!fileByBasename.has(basenameNoExt)) {
            fileByBasename.set(basenameNoExt, []);
        }
        fileByBasename.get(basenameNoExt)!.push(file);

        // Index exported symbols
        for (const exp of file.exports) {
            exportedSymbolToFile.set(exp, file.path);
        }
        for (const func of file.functions) {
            if (func.isExported) {
                exportedSymbolToFile.set(func.name, file.path);
            }
        }
    }

    // Resolve import source to actual file path
    function resolveImport(importSource: string, fromFile: string): string | null {
        // Handle relative imports (./foo, ../bar)
        if (importSource.startsWith('.')) {
            const fromDir = fromFile.split('/').slice(0, -1).join('/');
            const parts = importSource.split('/');
            let resolved = fromDir.split('/');

            for (const part of parts) {
                if (part === '.') continue;
                if (part === '..') {
                    resolved.pop();
                } else {
                    resolved.push(part);
                }
            }

            const basePath = resolved.join('/');
            // Try with different extensions
            for (const ext of ['', '.py', '.ts', '.js', '.tsx', '.jsx']) {
                const tryPath = basePath + ext;
                if (fileByPath.has(tryPath)) {
                    return tryPath;
                }
            }
            // Try as directory with index
            for (const idx of ['index.ts', 'index.js', '__init__.py']) {
                const tryPath = basePath + '/' + idx;
                if (fileByPath.has(tryPath)) {
                    return tryPath;
                }
            }
        }

        // Handle Python module notation (from gemini_client import ...)
        const moduleBasename = importSource.split('.').pop() || importSource;
        const candidates = fileByBasename.get(moduleBasename);
        if (candidates && candidates.length > 0) {
            // Prefer file in same directory as fromFile
            const fromDir = fromFile.split('/').slice(0, -1).join('/');
            const sameDir = candidates.find(c => c.path.startsWith(fromDir + '/'));
            if (sameDir) return sameDir.path;
            return candidates[0].path;
        }

        return null;
    }

    // For each seed file, BFS to check if it's connected to any LLM calls
    // If connected, add the seed file to results (the seed file is what we care about)
    for (const seedFile of seedFiles) {
        const localVisited = new Set<string>();
        const queue = [seedFile];
        let foundLLM = false;

        while (queue.length > 0 && !foundLLM) {
            const filePath = queue.shift()!;
            if (localVisited.has(filePath)) continue;
            localVisited.add(filePath);

            const file = fileByPath.get(filePath);
            if (!file) continue;

            // Check if this file has LLM calls
            if (file.functions.some(f => f.hasLLMCall)) {
                foundLLM = true;
                break;
            }

            // Trace imports to find more files
            for (const imp of file.imports) {
                const resolvedPath = resolveImport(imp.source, filePath);
                if (resolvedPath && !localVisited.has(resolvedPath)) {
                    queue.push(resolvedPath);
                }
            }

            // Trace function calls to find more files
            for (const func of file.functions) {
                for (const call of func.calls) {
                    // Check if call matches an exported symbol
                    const callName = call.split('.').pop() || call;
                    const targetFile = exportedSymbolToFile.get(callName);
                    if (targetFile && !localVisited.has(targetFile)) {
                        queue.push(targetFile);
                    }
                }
            }
        }

        // If this seed file is connected to LLM calls, add it to results
        if (foundLLM) {
            result.add(seedFile);
            // Also add all files in the trace path (they're all part of the LLM chain)
            for (const visitedFile of localVisited) {
                result.add(visitedFile);
            }
        }
    }

    return result;
}
