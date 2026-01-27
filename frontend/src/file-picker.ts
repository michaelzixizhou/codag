import * as vscode from 'vscode';
import * as path from 'path';
import { estimateTokens } from './cost-tracking';

const SELECTION_CACHE_KEY = 'codag.fileSelection';
// Version 2: Changed from full paths to relative paths for consistency and security
const SELECTION_CACHE_VERSION = 2;

interface FileSelectionEntry {
    selected: boolean;
}

interface FileSelectionCache {
    files: Record<string, FileSelectionEntry>;
    version: number;
}

/**
 * Tree node structure for webview file picker
 */
export interface FileTreeNode {
    path: string;           // Full path for files, empty for directories
    name: string;           // Display name
    isDirectory: boolean;
    depth: number;
    selected: boolean;
    children: FileTreeNode[];
    tokens?: number;        // Estimated tokens for this file (files only)
}

/**
 * Get selection cache from workspace state
 * Clears cache if version mismatch (e.g., old full paths vs new relative paths)
 */
function getSelectionCache(context: vscode.ExtensionContext): FileSelectionCache {
    const cached = context.workspaceState.get<FileSelectionCache>(SELECTION_CACHE_KEY);
    if (!cached || cached.version !== SELECTION_CACHE_VERSION) {
        // Version mismatch - return empty cache (old full path entries won't work)
        return { files: {}, version: SELECTION_CACHE_VERSION };
    }
    return cached;
}

/**
 * Save selection cache to workspace state
 */
async function saveSelectionCache(
    context: vscode.ExtensionContext,
    cache: FileSelectionCache
): Promise<void> {
    await context.workspaceState.update(SELECTION_CACHE_KEY, cache);
}

/**
 * Save selection from webview file picker result
 * @param selectedPaths - Array of relative paths that were selected
 */
export async function saveFilePickerSelection(
    context: vscode.ExtensionContext,
    allFiles: vscode.Uri[],
    selectedPaths: string[]
): Promise<void> {
    const cache = getSelectionCache(context);
    const selectedSet = new Set(selectedPaths);

    for (const file of allFiles) {
        // Use relative path as cache key for consistency and security
        const relativePath = vscode.workspace.asRelativePath(file, false);
        const isSelected = selectedSet.has(relativePath);
        if (!cache.files[relativePath]) {
            cache.files[relativePath] = { selected: isSelected };
        } else {
            cache.files[relativePath].selected = isSelected;
        }
    }

    await saveSelectionCache(context, cache);
}

/**
 * Get previously saved selected file paths (for silent background analysis)
 */
export function getSavedSelectedPaths(context: vscode.ExtensionContext): string[] {
    const cache = getSelectionCache(context);
    return Object.entries(cache.files)
        .filter(([_, entry]) => entry.selected)
        .map(([filePath, _]) => filePath);
}

/**
 * Build a tree structure for the webview file picker
 * Optionally includes token estimates for cost calculation
 */
export async function buildFileTree(
    files: vscode.Uri[],
    context: vscode.ExtensionContext,
    includeTokens: boolean = true
): Promise<{ tree: FileTreeNode; totalFiles: number }> {
    const workspaceRoot = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
    if (!workspaceRoot) {
        return { tree: createEmptyRoot(), totalFiles: 0 };
    }

    const cache = getSelectionCache(context);

    // Get file sizes for token estimation (batch stat calls)
    const fileSizes = new Map<string, number>();
    if (includeTokens) {
        await Promise.all(files.map(async (file) => {
            try {
                const stat = await vscode.workspace.fs.stat(file);
                fileSizes.set(file.fsPath, stat.size);
            } catch {
                fileSizes.set(file.fsPath, 0);
            }
        }));
    }

    const root: FileTreeNode = {
        path: workspaceRoot,
        name: path.basename(workspaceRoot),
        isDirectory: true,
        depth: 0,
        selected: false,
        children: []
    };

    for (const file of files) {
        const relativePath = path.relative(workspaceRoot, file.fsPath);
        const parts = relativePath.split(path.sep);

        let current = root;
        let currentPath = workspaceRoot;
        for (let i = 0; i < parts.length; i++) {
            const part = parts[i];
            const isLast = i === parts.length - 1;
            currentPath = path.join(currentPath, part);

            let child = current.children.find(c => c.name === part);
            if (!child) {
                // Use relative path for cache lookup (cache stores relative paths)
                const cached = cache.files[relativePath];

                // Determine selection: use cache if exists, otherwise select by default
                const isSelected = isLast
                    ? (cached !== undefined ? cached.selected : true)
                    : false;

                // Estimate tokens from file size (1 token ≈ 4 bytes for code)
                const fileSize = fileSizes.get(file.fsPath) || 0;
                const tokens = isLast ? Math.ceil(fileSize / 4) : undefined;

                child = {
                    path: currentPath,  // Both files and directories get paths
                    name: part,
                    isDirectory: !isLast,
                    depth: i + 1,
                    selected: isSelected,
                    children: [],
                    tokens
                };
                current.children.push(child);
            }
            current = child;
        }
    }

    // Sort children: directories first, then alphabetically
    sortChildren(root);

    return { tree: root, totalFiles: files.length };
}

function createEmptyRoot(): FileTreeNode {
    return {
        path: 'root',
        name: 'root',
        isDirectory: true,
        depth: 0,
        selected: false,
        children: []
    };
}

function sortChildren(node: FileTreeNode) {
    node.children.sort((a, b) => {
        if (a.isDirectory !== b.isDirectory) {
            return a.isDirectory ? -1 : 1;
        }
        return a.name.localeCompare(b.name);
    });
    node.children.forEach(sortChildren);
}
