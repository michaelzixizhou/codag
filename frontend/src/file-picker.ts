import * as vscode from 'vscode';
import * as path from 'path';

const SELECTION_CACHE_KEY = 'codag.fileSelection';

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
}

/**
 * Get selection cache from workspace state
 */
function getSelectionCache(context: vscode.ExtensionContext): FileSelectionCache {
    return context.workspaceState.get<FileSelectionCache>(SELECTION_CACHE_KEY, {
        files: {},
        version: 1
    });
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
 */
export async function saveFilePickerSelection(
    context: vscode.ExtensionContext,
    allFiles: vscode.Uri[],
    selectedPaths: string[]
): Promise<void> {
    const cache = getSelectionCache(context);
    const selectedSet = new Set(selectedPaths);

    for (const file of allFiles) {
        const isSelected = selectedSet.has(file.fsPath);
        if (!cache.files[file.fsPath]) {
            cache.files[file.fsPath] = { selected: isSelected };
        } else {
            cache.files[file.fsPath].selected = isSelected;
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
 */
export function buildFileTree(
    files: vscode.Uri[],
    context: vscode.ExtensionContext
): { tree: FileTreeNode; totalFiles: number } {
    const workspaceRoot = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
    if (!workspaceRoot) {
        return { tree: createEmptyRoot(), totalFiles: 0 };
    }

    const cache = getSelectionCache(context);

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
                const filePath = file.fsPath;
                const cached = cache.files[filePath];

                // Determine selection: use cache if exists, otherwise select by default
                const isSelected = isLast
                    ? (cached !== undefined ? cached.selected : true)
                    : false;

                child = {
                    path: currentPath,  // Both files and directories get paths
                    name: part,
                    isDirectory: !isLast,
                    depth: i + 1,
                    selected: isSelected,
                    children: []
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
