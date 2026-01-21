/**
 * File preparation utilities for code analysis
 */
import * as vscode from 'vscode';
import { FileMetadata } from './metadata-builder';
import { CONFIG } from './config';
import { estimateTokens } from './cost-tracking';

export interface FileContent {
    path: string;
    content: string;
}

/**
 * Convert absolute path to workspace-relative path
 */
export function toRelativePath(filePath: string): string {
    // If already relative (doesn't start with /), return as-is
    if (!filePath.startsWith('/') && !filePath.match(/^[A-Z]:\\/i)) {
        return filePath;
    }

    // Use vscode workspace to get relative path
    const workspaceFolder = vscode.workspace.workspaceFolders?.[0];
    if (workspaceFolder) {
        const wsRoot = workspaceFolder.uri.fsPath;
        if (filePath.startsWith(wsRoot)) {
            // Strip workspace root and leading slash
            return filePath.slice(wsRoot.length).replace(/^[/\\]/, '');
        }
    }

    // Fallback: return as-is (shouldn't happen in normal use)
    return filePath;
}

/**
 * Format a single file in XML format with optional imports attribute
 */
export function formatFileXML(
    filePath: string,
    content: string,
    metadata?: FileMetadata
): string {
    const relativePath = toRelativePath(filePath);
    const imports = metadata?.relatedFiles?.length
        ? ` imports="${metadata.relatedFiles.map(f => f.split('/').pop()).join(', ')}"`
        : '';
    return `<file path="${relativePath}"${imports}>\n${content}\n</file>`;
}

/**
 * Build directory structure string from file paths
 */
export function buildDirectoryStructure(filePaths: string[]): string {
    const tree = new Map<string, Set<string>>();

    for (const filePath of filePaths) {
        const parts = filePath.split('/');
        let currentPath = '';
        for (let i = 0; i < parts.length - 1; i++) {
            const parent = currentPath || '.';
            currentPath = currentPath ? `${currentPath}/${parts[i]}` : parts[i];
            if (!tree.has(parent)) tree.set(parent, new Set());
            tree.get(parent)!.add(parts[i] + '/');
        }
        // Add file to its directory
        const dir = parts.slice(0, -1).join('/') || '.';
        if (!tree.has(dir)) tree.set(dir, new Set());
        tree.get(dir)!.add(parts[parts.length - 1]);
    }

    // Build tree string
    const lines: string[] = [];
    function printDir(path: string, indent: string) {
        const children = tree.get(path);
        if (!children) return;
        const sorted = Array.from(children).sort((a, b) => {
            // Directories first
            const aIsDir = a.endsWith('/');
            const bIsDir = b.endsWith('/');
            if (aIsDir !== bIsDir) return aIsDir ? -1 : 1;
            return a.localeCompare(b);
        });
        for (const child of sorted) {
            lines.push(`${indent}${child}`);
            if (child.endsWith('/')) {
                const childPath = path === '.' ? child.slice(0, -1) : `${path}/${child.slice(0, -1)}`;
                printDir(childPath, indent + '  ');
            }
        }
    }
    printDir('.', '');
    return lines.join('\n');
}

/**
 * Combine files into XML format with directory structure
 */
export function combineFilesXML(
    files: FileContent[],
    metadata: FileMetadata[]
): string {
    // Normalize all paths to relative
    const normalizedFiles = files.map(f => ({
        ...f,
        path: toRelativePath(f.path)
    }));

    const metadataMap = new Map(metadata.map(m => [toRelativePath(m.file), m]));

    // Build directory structure with relative paths
    const dirStructure = buildDirectoryStructure(normalizedFiles.map(f => f.path));

    // Format each file (paths already relative)
    const fileContents = normalizedFiles.map(f =>
        formatFileXML(f.path, f.content, metadataMap.get(f.path))
    ).join('\n\n');

    return `<directory_structure>\n${dirStructure}\n</directory_structure>\n\n${fileContents}`;
}

/**
 * Create batches of files based on dependency relationships
 * Groups related files together while respecting token limits
 */
export function createDependencyBatches(
    files: FileContent[],
    metadata: FileMetadata[],
    maxBatchSize: number = CONFIG.BATCH.MAX_SIZE,
    maxTokensPerBatch: number = CONFIG.BATCH.MAX_TOKENS
): FileContent[][] {
    // Build adjacency list from metadata
    const graph = new Map<string, Set<string>>();

    for (const meta of metadata) {
        if (!graph.has(meta.file)) {
            graph.set(meta.file, new Set());
        }
        for (const related of meta.relatedFiles) {
            graph.get(meta.file)!.add(related);
            if (!graph.has(related)) {
                graph.set(related, new Set());
            }
            graph.get(related)!.add(meta.file);
        }
    }

    // Find connected components using DFS
    const visited = new Set<string>();
    const components: string[][] = [];

    function dfs(filePath: string, component: string[]) {
        visited.add(filePath);
        component.push(filePath);

        const neighbors = graph.get(filePath) || new Set();
        for (const neighbor of neighbors) {
            if (!visited.has(neighbor)) {
                dfs(neighbor, component);
            }
        }
    }

    // Find all connected components
    for (const file of files) {
        if (!visited.has(file.path)) {
            const component: string[] = [];
            dfs(file.path, component);
            components.push(component);
        }
    }

    // Split large components to respect both batch size and token limits
    const batches: FileContent[][] = [];

    for (const component of components) {
        const componentSet = new Set(component);
        const componentFiles = files.filter(f => componentSet.has(f.path));

        // Try to fit component in one batch
        const totalTokens = componentFiles.reduce((sum, f) => sum + estimateTokens(f.content), 0);

        if (componentFiles.length <= maxBatchSize && totalTokens <= maxTokensPerBatch) {
            // Component fits in one batch
            batches.push(componentFiles);
        } else {
            // Split component into token-aware batches
            let currentBatch: FileContent[] = [];
            let currentBatchTokens = 0;

            for (const file of componentFiles) {
                const fileTokens = estimateTokens(file.content);

                // Check if adding this file would exceed limits
                if (currentBatch.length >= maxBatchSize ||
                    (currentBatch.length > 0 && currentBatchTokens + fileTokens > maxTokensPerBatch)) {
                    // Start new batch
                    batches.push(currentBatch);
                    currentBatch = [file];
                    currentBatchTokens = fileTokens;
                } else {
                    currentBatch.push(file);
                    currentBatchTokens += fileTokens;
                }
            }

            // Add final batch if not empty
            if (currentBatch.length > 0) {
                batches.push(currentBatch);
            }
        }
    }

    return batches;
}
