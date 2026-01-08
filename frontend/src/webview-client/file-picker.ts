/**
 * Custom file picker modal for webview
 * Displays statically analyzed files in a tree structure
 */

import * as state from './state';

// Nerd Font icons for file types (using Unicode escape sequences)
const FILE_ICONS: Record<string, string> = {
    // Folders (nf-fa-folder_open, nf-fa-folder)
    'folder-open': '\uf07c',
    'folder-closed': '\uf07b',

    // JavaScript/TypeScript (nf-seti-javascript, nf-seti-typescript)
    'js': '\ue781',
    'jsx': '\ue7ba',
    'ts': '\ue628',
    'tsx': '\ue7ba',
    'mjs': '\ue781',
    'cjs': '\ue781',

    // Web
    'html': '\ue736',
    'css': '\ue749',
    'scss': '\ue603',
    'sass': '\ue603',
    'less': '\ue758',
    'svg': '\ue698',

    // Data/Config
    'json': '\ue60b',
    'yaml': '\ue6a8',
    'yml': '\ue6a8',
    'toml': '\ue6b2',
    'xml': '\ue619',
    'env': '\uf462',

    // Python
    'py': '\ue73c',
    'pyi': '\ue73c',
    'pyc': '\ue73c',

    // Other languages
    'go': '\ue626',
    'rs': '\ue7a8',
    'rb': '\ue739',
    'php': '\ue73d',
    'java': '\ue738',
    'kt': '\ue634',
    'swift': '\ue755',
    'c': '\ue61e',
    'cpp': '\ue61d',
    'h': '\ue61e',
    'cs': '\uf81a',

    // Shell
    'sh': '\ue795',
    'bash': '\ue795',
    'zsh': '\ue795',
    'fish': '\ue795',

    // Docs
    'md': '\ue73e',
    'mdx': '\ue73e',
    'txt': '\uf15c',
    'pdf': '\uf1c1',

    // Images
    'png': '\uf1c5',
    'jpg': '\uf1c5',
    'jpeg': '\uf1c5',
    'gif': '\uf1c5',
    'ico': '\uf1c5',
    'webp': '\uf1c5',

    // Git
    'gitignore': '\ue702',
    'gitmodules': '\ue702',

    // Config files
    'lock': '\uf023',
    'dockerfile': '\ue7b0',
    'dockerignore': '\ue7b0',

    // Default
    'default': '\uf15b',
};

function getFileIcon(filename: string, isDirectory: boolean, isCollapsed: boolean): string {
    if (isDirectory) {
        return isCollapsed ? FILE_ICONS['folder-closed'] : FILE_ICONS['folder-open'];
    }

    const lowerName = filename.toLowerCase();

    // Special filenames
    if (lowerName === 'dockerfile') return FILE_ICONS['dockerfile'];
    if (lowerName === '.gitignore') return FILE_ICONS['gitignore'];
    if (lowerName === '.env' || lowerName.startsWith('.env.')) return FILE_ICONS['env'];
    if (lowerName.includes('lock')) return FILE_ICONS['lock'];

    // Get extension
    const ext = lowerName.split('.').pop() || '';
    return FILE_ICONS[ext] || FILE_ICONS['default'];
}

export interface FileTreeNode {
    path: string;
    name: string;
    isDirectory: boolean;
    depth: number;
    selected: boolean;
    hasLLMCalls: boolean | null;  // null = unknown, true = confirmed, false = none
    children: FileTreeNode[];
}

interface FilePickerData {
    tree: FileTreeNode;
    totalFiles: number;
}

export class FilePicker {
    private modal: HTMLElement | null = null;
    private tree: FileTreeNode | null = null;
    private totalFiles: number = 0;
    private selectedPaths: Set<string> = new Set();
    private collapsedPaths: Set<string> = new Set();
    private resolvePromise: ((paths: string[] | null) => void) | null = null;
    private llmDetectionComplete: boolean = false;

    constructor() {}

    /**
     * Show the file picker modal
     */
    show(data: FilePickerData): Promise<string[] | null> {
        this.tree = data.tree;
        this.totalFiles = data.totalFiles;
        this.selectedPaths.clear();
        this.llmDetectionComplete = false;

        // Initialize selected paths from tree
        this.collectSelectedPaths(this.tree);

        this.render();

        return new Promise((resolve) => {
            this.resolvePromise = resolve;
        });
    }

    /**
     * Collect initially selected paths from tree
     */
    private collectSelectedPaths(node: FileTreeNode) {
        if (!node.isDirectory && node.selected) {
            this.selectedPaths.add(node.path);
        }
        for (const child of node.children) {
            this.collectSelectedPaths(child);
        }
    }

    /**
     * Toggle LLM files in selection (additive/subtractive)
     */
    private toggleLLMFiles(shouldSelect: boolean) {
        const llmPaths = this.collectLLMPaths(this.tree!);
        if (shouldSelect) {
            llmPaths.forEach(p => this.selectedPaths.add(p));
        } else {
            llmPaths.forEach(p => this.selectedPaths.delete(p));
        }
        this.refreshTree();
    }

    /**
     * Collect paths of files with LLM calls
     */
    private collectLLMPaths(node: FileTreeNode): string[] {
        const paths: string[] = [];
        if (!node.isDirectory && node.hasLLMCalls === true) {
            paths.push(node.path);
        }
        for (const child of node.children) {
            paths.push(...this.collectLLMPaths(child));
        }
        return paths;
    }

    /**
     * Check if all LLM files are selected
     */
    private areAllLLMFilesSelected(): boolean {
        const llmPaths = this.collectLLMPaths(this.tree!);
        return llmPaths.length > 0 && llmPaths.every(p => this.selectedPaths.has(p));
    }

    /**
     * Render the modal
     */
    private render() {
        // Remove existing modal if any (no animation for re-render)
        this.close(false);

        this.modal = document.createElement('div');
        this.modal.className = 'file-picker-overlay';
        this.modal.innerHTML = `
            <div class="file-picker-modal">
                <div class="file-picker-header">
                    <h2>Codebase Analysis</h2>
                    <p>Select files to analyze. Files marked <span class="llm-badge-inline">LLM</span> have a high confidence to be related to LLM workflows.</p>
                </div>
                <div class="file-picker-toolbar">
                    <div class="file-picker-toggles">
                        <button class="toggle-btn" id="select-all-btn">
                            <input type="checkbox" id="select-all-checkbox" />
                            <span>Select All</span>
                        </button>
                        <button class="toggle-btn detecting" id="select-llm-btn" disabled>
                            <input type="checkbox" id="select-llm-checkbox" disabled />
                            <span class="llm-badge">LLM</span>
                        </button>
                    </div>
                    <div class="file-picker-search">
                        <input type="text" id="file-picker-search" placeholder="Search files..." />
                    </div>
                </div>
                <div class="file-picker-tree" id="file-picker-tree">
                    ${this.renderTree(this.tree!)}
                </div>
                <div class="file-picker-footer">
                    <div class="file-picker-count">
                        <span id="selected-count">${this.selectedPaths.size}</span> of ${this.totalFiles} files selected
                    </div>
                    <div class="file-picker-actions">
                        <button class="file-picker-btn file-picker-btn-danger" id="file-picker-clear-cache">Delete Cache & Reanalyze</button>
                        <button class="file-picker-btn file-picker-btn-cancel" id="file-picker-cancel">Cancel</button>
                        <button class="file-picker-btn file-picker-btn-primary" id="file-picker-analyze">Analyze</button>
                    </div>
                </div>
            </div>
        `;

        document.body.appendChild(this.modal);

        // Add event listeners
        this.attachEventListeners();
        this.updateSelectAllState();
    }

    /**
     * Check if any ancestor is collapsed
     */
    private isAncestorCollapsed(path: string): boolean {
        for (const collapsed of this.collapsedPaths) {
            if (path.startsWith(collapsed + '/')) {
                return true;
            }
        }
        return false;
    }

    /**
     * Render tree recursively
     * @param continuingLines - array of booleans indicating if there are more siblings at each depth level
     */
    private renderTree(node: FileTreeNode, isLast: boolean = true, continuingLines: boolean[] = []): string {
        if (node.depth === 0) {
            // Root node - just render children
            return node.children.map((child, i) =>
                this.renderTree(child, i === node.children.length - 1, [])
            ).join('');
        }

        const isSelected = node.isDirectory
            ? this.isDirectoryFullySelected(node)
            : this.selectedPaths.has(node.path);

        const isPartiallySelected = node.isDirectory && !isSelected && this.isDirectoryPartiallySelected(node);
        const isCollapsed = this.collapsedPaths.has(node.path);
        const isHidden = this.isAncestorCollapsed(node.path);

        // Determine CSS classes
        const classes = ['file-picker-item'];
        if (node.isDirectory) {
            classes.push('is-directory');
            if (isCollapsed) {
                classes.push('collapsed');
            }
        } else {
            classes.push('is-file');
            if (node.hasLLMCalls === true) {
                classes.push('has-llm-calls');
            } else if (node.hasLLMCalls === false) {
                classes.push('no-llm-calls');
            }
        }
        if (isHidden) {
            classes.push('collapsed-child');
        }
        if (isLast) {
            classes.push('is-last');
        }

        // Toggle arrow for directories
        const toggleArrow = node.isDirectory && node.children.length > 0
            ? '<span class="dir-toggle">▼</span>'
            : '<span class="dir-toggle-spacer"></span>';

        const icon = getFileIcon(node.name, node.isDirectory, isCollapsed);
        const llmBadge = !node.isDirectory && node.hasLLMCalls === true
            ? '<span class="llm-badge">LLM</span>'
            : '';

        // Generate vertical lines for ancestor levels that have more siblings
        const ancestorLines = continuingLines.map((hasSibling, idx) =>
            hasSibling ? `<span class="tree-line" style="--line-depth: ${idx}"></span>` : ''
        ).join('');

        let html = `
            <div class="${classes.join(' ')}" data-path="${node.path}" data-is-directory="${node.isDirectory}" style="--depth: ${node.depth - 1}">
                ${ancestorLines}
                ${toggleArrow}
                <label class="file-picker-checkbox">
                    <input type="checkbox"
                        ${isSelected ? 'checked' : ''}
                        ${isPartiallySelected ? 'data-partial="true"' : ''}
                        data-path="${node.path}"
                        data-is-directory="${node.isDirectory}"
                    />
                    <span class="checkmark ${isPartiallySelected ? 'partial' : ''}"></span>
                </label>
                <span class="item-icon">${icon}</span>
                <span class="item-name">${node.name}</span>
                ${llmBadge}
            </div>
        `;

        // Render children - update continuingLines for next level
        const childContinuingLines = [...continuingLines, !isLast];
        for (let i = 0; i < node.children.length; i++) {
            html += this.renderTree(node.children[i], i === node.children.length - 1, childContinuingLines);
        }

        return html;
    }

    /**
     * Check if all files under a directory are selected
     */
    private isDirectoryFullySelected(node: FileTreeNode): boolean {
        if (!node.isDirectory) {
            return this.selectedPaths.has(node.path);
        }
        if (node.children.length === 0) return false;
        return node.children.every(child => this.isDirectoryFullySelected(child));
    }

    /**
     * Check if some (but not all) files under a directory are selected
     */
    private isDirectoryPartiallySelected(node: FileTreeNode): boolean {
        if (!node.isDirectory) return false;
        const selected = this.countSelectedInDirectory(node);
        const total = this.countFilesInDirectory(node);
        return selected > 0 && selected < total;
    }

    /**
     * Count selected files in directory
     */
    private countSelectedInDirectory(node: FileTreeNode): number {
        if (!node.isDirectory) {
            return this.selectedPaths.has(node.path) ? 1 : 0;
        }
        return node.children.reduce((sum, child) => sum + this.countSelectedInDirectory(child), 0);
    }

    /**
     * Count total files in directory
     */
    private countFilesInDirectory(node: FileTreeNode): number {
        if (!node.isDirectory) return 1;
        return node.children.reduce((sum, child) => sum + this.countFilesInDirectory(child), 0);
    }

    /**
     * Get all file paths under a node
     */
    private getAllFilePaths(node: FileTreeNode): string[] {
        if (!node.isDirectory) {
            return [node.path];
        }
        return node.children.flatMap(child => this.getAllFilePaths(child));
    }

    /**
     * Find node by path
     */
    private findNode(path: string, node: FileTreeNode = this.tree!): FileTreeNode | null {
        if (node.path === path) return node;
        for (const child of node.children) {
            const found = this.findNode(path, child);
            if (found) return found;
        }
        return null;
    }

    /**
     * Attach event listeners
     */
    private attachEventListeners() {
        if (!this.modal) return;

        // Cancel button
        const cancelBtn = this.modal.querySelector('#file-picker-cancel');
        cancelBtn?.addEventListener('click', () => {
            this.close();
            this.resolvePromise?.(null);
        });

        // Analyze button
        const analyzeBtn = this.modal.querySelector('#file-picker-analyze');
        analyzeBtn?.addEventListener('click', () => {
            const paths = Array.from(this.selectedPaths);
            this.close();
            this.resolvePromise?.(paths);
        });

        // Select all button click
        const selectAllBtn = this.modal.querySelector('#select-all-btn');
        const selectAllCheckbox = this.modal.querySelector('#select-all-checkbox') as HTMLInputElement;
        selectAllBtn?.addEventListener('click', () => {
            const allPaths = this.getAllFilePaths(this.tree!);
            const shouldCheck = !selectAllCheckbox.checked;
            if (shouldCheck) {
                allPaths.forEach(p => this.selectedPaths.add(p));
            } else {
                this.selectedPaths.clear();
            }
            this.refreshTree();
        });

        // Select LLM files button click (toggle)
        const selectLLMBtn = this.modal.querySelector('#select-llm-btn') as HTMLButtonElement;
        const selectLLMCheckbox = this.modal.querySelector('#select-llm-checkbox') as HTMLInputElement;
        selectLLMBtn?.addEventListener('click', () => {
            if (!this.llmDetectionComplete) return;
            const shouldCheck = !this.areAllLLMFilesSelected();
            selectLLMCheckbox.checked = shouldCheck;
            this.toggleLLMFiles(shouldCheck);
        });

        // Delete Cache & Reanalyze button
        const clearCacheBtn = this.modal.querySelector('#file-picker-clear-cache');
        clearCacheBtn?.addEventListener('click', () => {
            const paths = Array.from(this.selectedPaths);
            this.close();
            this.resolvePromise?.(null);
            // Send selected files to clear cache and reanalyze
            state.vscode.postMessage({ command: 'clearCacheAndReanalyze', paths });
        });

        // Search input
        const searchInput = this.modal.querySelector('#file-picker-search') as HTMLInputElement;
        searchInput?.addEventListener('input', () => {
            this.filterTree(searchInput.value);
        });

        // Tree row clicks (entire row is clickable)
        const treeContainer = this.modal.querySelector('#file-picker-tree');
        treeContainer?.addEventListener('click', (e) => {
            const target = e.target as HTMLElement;

            // Find the row element
            const row = target.closest('.file-picker-item') as HTMLElement;
            if (!row) return;

            const path = row.dataset.path;
            const isDirectory = row.dataset.isDirectory === 'true';

            if (!path) return;

            // Check if clicked on toggle arrow
            if (target.classList.contains('dir-toggle')) {
                if (this.collapsedPaths.has(path)) {
                    this.collapsedPaths.delete(path);
                } else {
                    this.collapsedPaths.add(path);
                }
                this.refreshTree();
                return;
            }

            // Otherwise toggle selection
            const checkbox = row.querySelector('input[type="checkbox"]') as HTMLInputElement;
            if (!checkbox) return;

            const shouldCheck = !checkbox.checked;

            if (isDirectory) {
                const node = this.findNode(path);
                if (node) {
                    const allPaths = this.getAllFilePaths(node);
                    if (shouldCheck) {
                        allPaths.forEach(p => this.selectedPaths.add(p));
                    } else {
                        allPaths.forEach(p => this.selectedPaths.delete(p));
                    }
                }
            } else {
                if (shouldCheck) {
                    this.selectedPaths.add(path);
                } else {
                    this.selectedPaths.delete(path);
                }
            }

            this.refreshTree();
        });

        // Close on overlay click
        this.modal.addEventListener('click', (e) => {
            if (e.target === this.modal) {
                this.close();
                this.resolvePromise?.(null);
            }
        });

        // Close on Escape
        const escHandler = (e: KeyboardEvent) => {
            if (e.key === 'Escape') {
                this.close();
                this.resolvePromise?.(null);
                document.removeEventListener('keydown', escHandler);
            }
        };
        document.addEventListener('keydown', escHandler);
    }

    /**
     * Refresh tree display after selection change
     */
    private refreshTree() {
        const treeContainer = this.modal?.querySelector('#file-picker-tree');
        if (treeContainer && this.tree) {
            treeContainer.innerHTML = this.renderTree(this.tree);
        }

        const countEl = this.modal?.querySelector('#selected-count');
        if (countEl) {
            countEl.textContent = String(this.selectedPaths.size);
        }

        this.updateSelectAllState();
    }

    /**
     * Update select all checkbox state
     */
    private updateSelectAllState() {
        const selectAllCheckbox = this.modal?.querySelector('#select-all-checkbox') as HTMLInputElement;
        if (selectAllCheckbox) {
            const allSelected = this.selectedPaths.size === this.totalFiles;
            const someSelected = this.selectedPaths.size > 0 && !allSelected;
            selectAllCheckbox.checked = allSelected;
            selectAllCheckbox.indeterminate = someSelected;
        }

        // Also update LLM checkbox
        const selectLLMCheckbox = this.modal?.querySelector('#select-llm-checkbox') as HTMLInputElement;
        if (selectLLMCheckbox) {
            const llmPaths = this.collectLLMPaths(this.tree!);
            const allLLMSelected = llmPaths.length > 0 && llmPaths.every(p => this.selectedPaths.has(p));
            const someLLMSelected = llmPaths.some(p => this.selectedPaths.has(p)) && !allLLMSelected;
            selectLLMCheckbox.checked = allLLMSelected;
            selectLLMCheckbox.indeterminate = someLLMSelected;
        }
    }

    /**
     * Filter tree based on search query
     */
    private filterTree(query: string) {
        const treeContainer = this.modal?.querySelector('#file-picker-tree');
        if (!treeContainer) return;

        const items = treeContainer.querySelectorAll('.file-picker-item');
        const lowerQuery = query.toLowerCase().trim();

        if (!lowerQuery) {
            // Show all items
            items.forEach(item => {
                (item as HTMLElement).style.display = '';
            });
            return;
        }

        // First pass: determine which items match
        const matchingPaths = new Set<string>();
        items.forEach(item => {
            const name = item.querySelector('.item-name')?.textContent?.toLowerCase() || '';
            const path = (item as HTMLElement).dataset.path || '';
            if (name.includes(lowerQuery) || path.toLowerCase().includes(lowerQuery)) {
                matchingPaths.add(path);
            }
        });

        // Second pass: show matching items and their ancestors
        items.forEach(item => {
            const el = item as HTMLElement;
            const path = el.dataset.path || '';
            const isDirectory = el.dataset.isDirectory === 'true';

            // Show if this item matches or if it's a parent of a matching item
            let shouldShow = matchingPaths.has(path);
            if (isDirectory && !shouldShow) {
                // Check if any matching path starts with this directory path
                for (const matchPath of matchingPaths) {
                    if (matchPath.startsWith(path + '/')) {
                        shouldShow = true;
                        break;
                    }
                }
            }

            el.style.display = shouldShow ? '' : 'none';
        });
    }

    /**
     * Close the modal with optional animation toward the analyze button
     */
    close(animate: boolean = true) {
        if (!this.modal) return;

        if (animate) {
            const btn = document.getElementById('btn-analyze');
            const modalContent = this.modal.querySelector('.file-picker-modal') as HTMLElement;

            if (btn && modalContent) {
                const btnRect = btn.getBoundingClientRect();
                const modalRect = modalContent.getBoundingClientRect();

                // Calculate the center of the button relative to the modal's current position
                const btnCenterX = btnRect.left + btnRect.width / 2;
                const btnCenterY = btnRect.top + btnRect.height / 2;
                const modalCenterX = modalRect.left + modalRect.width / 2;
                const modalCenterY = modalRect.top + modalRect.height / 2;

                // Calculate translation to move modal center toward button
                const translateX = btnCenterX - modalCenterX;
                const translateY = btnCenterY - modalCenterY;

                // Apply animation
                modalContent.style.transition = 'transform 0.25s ease-in, opacity 0.25s ease-in';
                modalContent.style.transformOrigin = 'center center';
                modalContent.style.transform = `translate(${translateX}px, ${translateY}px) scale(0.05)`;
                modalContent.style.opacity = '0';

                // Fade out overlay
                this.modal.style.transition = 'background 0.25s ease-in';
                this.modal.style.background = 'transparent';

                // Remove after animation completes
                setTimeout(() => {
                    this.modal?.remove();
                    this.modal = null;
                }, 250);
                return;
            }
        }

        // Fallback: instant close
        this.modal.remove();
        this.modal = null;
    }

    /**
     * Update file picker with LLM detection results (called after picker is shown)
     */
    updateLLMFiles(llmFilePaths: string[]) {
        if (!this.modal || !this.tree) return;

        const llmSet = new Set(llmFilePaths);

        // Update tree data with LLM status
        this.updateTreeLLMStatus(this.tree, llmSet);

        // Update selection to only include LLM files
        this.selectedPaths.clear();
        llmFilePaths.forEach(p => this.selectedPaths.add(p));

        // Mark detection complete and enable LLM button
        this.llmDetectionComplete = true;
        const selectLLMBtn = this.modal.querySelector('#select-llm-btn') as HTMLButtonElement;
        const selectLLMCheckbox = this.modal.querySelector('#select-llm-checkbox') as HTMLInputElement;
        if (selectLLMBtn) {
            selectLLMBtn.disabled = false;
            selectLLMBtn.classList.remove('detecting');
        }
        if (selectLLMCheckbox) {
            selectLLMCheckbox.disabled = false;
        }

        // Refresh the tree to reflect changes
        this.refreshTree();
    }

    /**
     * Recursively update tree nodes with LLM status
     */
    private updateTreeLLMStatus(node: FileTreeNode, llmSet: Set<string>) {
        if (!node.isDirectory) {
            node.hasLLMCalls = llmSet.has(node.path);
        }
        for (const child of node.children) {
            this.updateTreeLLMStatus(child, llmSet);
        }
    }
}

// Singleton instance
let filePickerInstance: FilePicker | null = null;

export function getFilePicker(): FilePicker {
    if (!filePickerInstance) {
        filePickerInstance = new FilePicker();
    }
    return filePickerInstance;
}
