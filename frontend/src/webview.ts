import * as vscode from 'vscode';
import * as fs from 'fs';
import * as path from 'path';
import { WorkflowGraph } from './api';
import { FileTreeNode } from './file-picker';

export interface ViewState {
    selectedNodeId: string | null;
    expandedWorkflowIds: string[];
    lastUpdated: number;
}
export interface LoadingOptions {
    loading?: boolean;
    progress?: { current: number; total: number };
}

export class WebviewManager {
    private panel: vscode.WebviewPanel | undefined;
    private viewState: ViewState = {
        selectedNodeId: null,
        expandedWorkflowIds: [],
        lastUpdated: Date.now()
    };
    private filePickerResolver: ((paths: string[] | null) => void) | null = null;
    private pendingMessages: any[] = [];
    private webviewReady = false;

    // Cumulative batch progress tracking
    private batchState = {
        completed: 0,
        total: 0,
        startTime: 0,
        filesAnalyzed: 0
    };

    constructor(private context: vscode.ExtensionContext) {}

    /**
     * Post message to webview, queuing if not ready yet
     */
    private postMessage(message: any) {
        if (this.panel) {
            if (this.webviewReady) {
                this.panel.webview.postMessage(message);
            } else {
                this.pendingMessages.push(message);
            }
        } else {
            console.log(`[Codag] Message dropped (panel closed): ${message.command}`);
        }
    }

    /**
     * Flush pending messages and mark webview as ready
     */
    private onWebviewReady() {
        console.log('[webview] onWebviewReady: flushing', this.pendingMessages.length, 'messages');
        this.webviewReady = true;
        this.pendingMessages.forEach(msg => {
            console.log('[webview] Sending queued message:', msg.command);
            this.panel?.webview.postMessage(msg);
        });
        this.pendingMessages = [];
    }

    /**
     * Reset ready state when HTML is replaced
     */
    private resetWebviewState() {
        this.webviewReady = false;
        this.pendingMessages = [];
    }

    private getIconPath() {
        return {
            light: vscode.Uri.joinPath(this.context.extensionUri, 'media', 'icon-dark.svg'),
            dark: vscode.Uri.joinPath(this.context.extensionUri, 'media', 'icon-light.svg')
        };
    }

    getViewState(): ViewState | null {
        return this.panel ? this.viewState : null;
    }

    updateViewState(update: Partial<ViewState>) {
        this.viewState = {
            ...this.viewState,
            ...update,
            lastUpdated: Date.now()
        };
    }

    notifyAnalysisStarted() {
        this.postMessage({ command: 'analysisStarted' });
    }

    notifyAnalysisComplete(success: boolean, error?: string) {
        const stats = this.getBatchStats();
        this.postMessage({
            command: 'analysisComplete',
            success,
            error,
            // Include stats for success message
            ...(success && stats.batchCount > 0 ? {
                filesAnalyzed: stats.filesAnalyzed,
                batchCount: stats.batchCount,
                elapsed: stats.elapsed
            } : {})
        });
    }

    notifyWarning(message: string) {
        this.postMessage({
            command: 'warning',
            message
        });
    }

    notifyBackendError() {
        this.postMessage({ command: 'backendError' });
    }

    notifyApiKeyError(reason: 'missing' | 'invalid') {
        this.postMessage({ command: 'apiKeyError', reason });
    }

    /**
     * Notify webview of file state changes for live file indicators
     */
    notifyFileStateChange(changes: Array<{
        filePath: string;
        functions?: string[];  // Specific functions that changed (matches node.source.function)
        state: 'active' | 'changed' | 'unchanged'
    }>) {
        this.postMessage({
            command: 'fileStateChange',
            changes
        });
    }

    /**
     * Show a toast notification in the webview
     */
    showNotification(options: {
        type: 'info' | 'success' | 'warning' | 'error';
        message: string;
        dismissMs?: number;
    }) {
        this.postMessage({
            command: 'showNotification',
            ...options
        });
    }

    private setupMessageHandlers() {
        if (!this.panel) return;

        this.panel.webview.onDidReceiveMessage(
            async (message) => {
                if (message.command === 'openFile') {
                    try {
                        let filePath = message.file;

                        if (!filePath || typeof filePath !== 'string') {
                            vscode.window.showErrorMessage(`Invalid file path: ${filePath}`);
                            return;
                        }

                        // Handle relative paths - try to find the file in workspace
                        if (!filePath.startsWith('/')) {
                            const workspaceFolders = vscode.workspace.workspaceFolders;
                            if (workspaceFolders && workspaceFolders.length > 0) {
                                // Search for file matching the relative path/filename
                                const searchPattern = filePath.includes('/') ? `**/${filePath}` : `**/${filePath}`;
                                const matches = await vscode.workspace.findFiles(searchPattern, '**/node_modules/**', 5);
                                if (matches.length === 1) {
                                    filePath = matches[0].fsPath;
                                } else if (matches.length > 1) {
                                    // Multiple matches - try to find exact match
                                    const exactMatch = matches.find(m => m.fsPath.endsWith(filePath));
                                    filePath = exactMatch ? exactMatch.fsPath : matches[0].fsPath;
                                } else {
                                    vscode.window.showErrorMessage(`Could not find file: ${filePath}`);
                                    return;
                                }
                            } else {
                                vscode.window.showErrorMessage(`File path must be absolute: ${filePath}`);
                                return;
                            }
                        }

                        const fileUri = vscode.Uri.file(filePath);
                        const document = await vscode.workspace.openTextDocument(fileUri);

                        // Open in a column different from Codag panel
                        // Find existing text editors to reuse, or create in column that's not Codag's
                        const codagColumn = this.panel?.viewColumn || vscode.ViewColumn.Two;
                        let targetColumn = vscode.ViewColumn.One;

                        // If Codag is in column 1, use column 2; otherwise use column 1
                        if (codagColumn === vscode.ViewColumn.One) {
                            targetColumn = vscode.ViewColumn.Two;
                        }

                        // Check if there's already an editor in our target column we can reuse
                        const existingEditor = vscode.window.visibleTextEditors.find(
                            e => e.viewColumn === targetColumn
                        );
                        if (existingEditor) {
                            // Reuse existing editor's column
                            targetColumn = existingEditor.viewColumn!;
                        }

                        const editor = await vscode.window.showTextDocument(document, targetColumn);

                        const line = Math.max(0, (message.line || 1) - 1);
                        const range = new vscode.Range(line, 0, line, 0);
                        editor.selection = new vscode.Selection(range.start, range.end);
                        editor.revealRange(range, vscode.TextEditorRevealType.InCenter);
                    } catch (error: any) {
                        vscode.window.showErrorMessage(`Could not open file: ${error.message}`);
                    }
                } else if (message.command === 'refreshAnalysis') {
                    vscode.commands.executeCommand('codag.refresh');
                } else if (message.command === 'nodeSelected') {
                    this.updateViewState({
                        selectedNodeId: message.nodeId,
                        selectedNodeLabel: message.nodeLabel,
                        selectedNodeType: message.nodeType
                    });
                } else if (message.command === 'nodeDeselected') {
                    this.updateViewState({
                        selectedNodeId: null,
                        selectedNodeLabel: undefined,
                        selectedNodeType: undefined
                    });
                } else if (message.command === 'workflowVisibilityChanged') {
                    this.updateViewState({
                        expandedWorkflowIds: message.expandedWorkflowIds || []
                    });
                } else if (message.command === 'viewportChanged') {
                    this.updateViewState({
                        visibleNodeIds: message.visibleNodeIds || []
                    });
                } else if (message.command === 'filePickerResult') {
                    // Handle file picker result from webview
                    if (this.filePickerResolver) {
                        this.filePickerResolver(message.selectedPaths);
                        this.filePickerResolver = null;
                    }
                } else if (message.command === 'openAnalyzePanel') {
                    // Just show the file picker on the existing graph
                    vscode.commands.executeCommand('codag.showFilePicker');
                } else if (message.command === 'clearCacheAndReanalyze') {
                    // Clear cache for selected files and reanalyze them
                    vscode.commands.executeCommand('codag.clearCacheAndReanalyze', message.paths);
                } else if (message.command === 'retryAnalysis') {
                    vscode.commands.executeCommand('codag.open');
                } else if (message.command === 'webviewReady') {
                    // Webview is ready to receive messages
                    this.onWebviewReady();
                } else if (message.command === 'saveExport') {
                    // Handle export save dialog with remembered folder
                    try {
                        const os = require('os');
                        const path = require('path');
                        const fs = require('fs');

                        // Get last export folder or default to Desktop
                        const lastExportFolder = this.context.globalState.get<string>('lastExportFolder')
                            || path.join(os.homedir(), 'Desktop');
                        const defaultPath = path.join(lastExportFolder, message.suggestedName);

                        // Determine file type from suggested name
                        const isJpeg = message.suggestedName.endsWith('.jpg') || message.suggestedName.endsWith('.jpeg');
                        const filters = isJpeg
                            ? { 'JPEG Images': ['jpg', 'jpeg'] }
                            : { 'PNG Images': ['png'] };

                        const uri = await vscode.window.showSaveDialog({
                            defaultUri: vscode.Uri.file(defaultPath),
                            filters,
                            saveLabel: 'Export'
                        });

                        if (uri) {
                            // Remember the folder for next time
                            const savedFolder = path.dirname(uri.fsPath);
                            this.context.globalState.update('lastExportFolder', savedFolder);

                            // Decode base64 and write to file
                            const buffer = Buffer.from(message.data, 'base64');
                            fs.writeFileSync(uri.fsPath, buffer);
                            this.postMessage({ command: 'exportSuccess', path: uri.fsPath });
                        } else {
                            // User cancelled
                            this.postMessage({ command: 'exportCancelled' });
                        }
                    } catch (error: any) {
                        console.error('Export save error:', error);
                        this.postMessage({ command: 'exportError', error: error.message });
                    }
                }
            },
            undefined,
            this.context.subscriptions
        );
    }

    /**
     * Close the file picker immediately (no animation)
     */
    closeFilePicker() {
        this.postMessage({ command: 'closeFilePicker' });
    }

    /**
     * Show file picker in webview and wait for user selection
     */
    async showFilePicker(tree: FileTreeNode, totalFiles: number): Promise<string[] | null> {
        // Ensure panel is created
        if (!this.panel) {
            this.panel = vscode.window.createWebviewPanel(
                'codag',
                'LLM Architecture',
                vscode.ViewColumn.Two,
                {
                    enableScripts: true,
                    retainContextWhenHidden: true,
                    localResourceRoots: [
                        vscode.Uri.joinPath(this.context.extensionUri, 'media'),
                        vscode.Uri.joinPath(this.context.extensionUri, 'out')
                    ]
                }
            );

            this.panel.iconPath = this.getIconPath();

            this.panel.onDidDispose(() => {
                this.panel = undefined;
                // If file picker was open, resolve with null
                if (this.filePickerResolver) {
                    this.filePickerResolver(null);
                    this.filePickerResolver = null;
                }
            });

            this.setupMessageHandlers();

            // Show empty graph initially - reset ready state since HTML is replaced
            this.resetWebviewState();
            this.panel.webview.html = this.getHtml({ nodes: [], edges: [], llms_detected: [], workflows: [] });

        } else {
            this.panel.reveal();
        }

        // Send file picker message to webview (queued until ready)
        // Include pricing for cost estimation in file picker
        this.postMessage({
            command: 'showFilePicker',
            tree,
            totalFiles,
            pricing: {
                inputPer1M: 0.075,   // Gemini 2.5 Flash input cost
                outputPer1M: 0.30,   // Gemini 2.5 Flash output cost
                outputPerFile: 2000  // Estimated output tokens per file
            }
        });

        // Wait for result
        return new Promise((resolve) => {
            this.filePickerResolver = resolve;
        });
    }

    showLoading(message: string) {
        if (!this.panel) {
            this.panel = vscode.window.createWebviewPanel(
                'codag',
                'LLM Architecture',
                vscode.ViewColumn.Two,
                {
                    enableScripts: true,
                    retainContextWhenHidden: true,
                    localResourceRoots: [
                        vscode.Uri.joinPath(this.context.extensionUri, 'media'),
                        vscode.Uri.joinPath(this.context.extensionUri, 'out')
                    ]
                }
            );

            this.panel.iconPath = this.getIconPath();

            this.panel.onDidDispose(() => {
                this.panel = undefined;
            });

            this.setupMessageHandlers();

            // Reset ready state since HTML is replaced
            this.resetWebviewState();
            this.panel.webview.html = this.getHtml({ nodes: [], edges: [], llms_detected: [], workflows: [] });

        } else {
            this.panel.reveal();
        }

        this.postMessage({ command: 'showLoading', text: message });
    }

    updateProgress(current: number, total: number) {
        this.postMessage({ command: 'updateProgress', current, total });
    }

    /**
     * Start tracking batch progress (resets counters).
     */
    startBatchProgress(total: number): void {
        this.batchState = {
            completed: 0,
            total,
            startTime: Date.now(),
            filesAnalyzed: 0
        };
        this.postMessage({
            command: 'batchProgress',
            completed: 0,
            total,
            filesAnalyzed: 0,
            elapsed: 0
        });
    }

    /**
     * Mark a batch as completed (increments cumulative counter).
     */
    batchCompleted(filesInBatch: number): void {
        this.batchState.completed++;
        this.batchState.filesAnalyzed += filesInBatch;
        this.postMessage({
            command: 'batchProgress',
            completed: this.batchState.completed,
            total: this.batchState.total,
            filesAnalyzed: this.batchState.filesAnalyzed,
            elapsed: Date.now() - this.batchState.startTime
        });
    }

    /**
     * Get current batch stats for completion message.
     */
    getBatchStats(): { filesAnalyzed: number; batchCount: number; elapsed: number } {
        return {
            filesAnalyzed: this.batchState.filesAnalyzed,
            batchCount: this.batchState.completed,
            elapsed: Date.now() - this.batchState.startTime
        };
    }

    updateGraph(graph: WorkflowGraph, pendingNodeIds?: string[], fileChange?: { filePath: string; functions: string[] }) {
        this.postMessage({
            command: 'updateGraph',
            graph,
            preserveState: true,
            pendingNodeIds,
            fileChange
        });
    }

    /**
     * Initialize graph after file picker closes (for cached data)
     */
    initGraph(graph: WorkflowGraph) {
        this.postMessage({
            command: 'initGraph',
            graph
        });
    }

    /**
     * Clear the graph completely (used when cache is cleared before reanalysis)
     */
    clearGraph() {
        this.postMessage({
            command: 'clearGraph'
        });
    }

    showProgressOverlay(message: string) {
        this.postMessage({ command: 'showProgressOverlay', text: message });
    }

    hideProgressOverlay() {
        this.postMessage({ command: 'hideProgressOverlay' });
    }

    focusNode(nodeId: string) {
        if (this.panel) {
            this.panel.reveal();
            this.postMessage({ command: 'focusNode', nodeId });
        }
    }

    focusWorkflow(workflowName: string) {
        if (this.panel) {
            this.panel.reveal();
            this.postMessage({ command: 'focusWorkflow', workflowName });
        }
    }

    /**
     * Send label hydration updates from metadata batch
     */
    hydrateLabels(filePath: string, labels: Record<string, string>, descriptions: Record<string, string>) {
        this.postMessage({
            command: 'hydrateLabels',
            filePath,
            labels,
            descriptions
        });
    }

    show(graph: WorkflowGraph, loadingOptions?: LoadingOptions) {
        if (!this.panel) {
            this.panel = vscode.window.createWebviewPanel(
                'codag',
                'LLM Architecture',
                vscode.ViewColumn.Two,
                {
                    enableScripts: true,
                    retainContextWhenHidden: true,
                    localResourceRoots: [
                        vscode.Uri.joinPath(this.context.extensionUri, 'media'),
                        vscode.Uri.joinPath(this.context.extensionUri, 'out')
                    ]
                }
            );

            this.panel.iconPath = this.getIconPath();

            this.panel.onDidDispose(() => {
                this.panel = undefined;
            });

            this.setupMessageHandlers();
        } else {
            this.panel.reveal();
        }

        // Reset ready state since HTML is replaced
        this.resetWebviewState();
        this.panel.webview.html = this.getHtml(graph, loadingOptions);

    }

    private getHtml(graph: WorkflowGraph, loadingOptions?: LoadingOptions): string {
        const webview = this.panel!.webview;

        // Generate nonce for CSP
        const nonce = this.getNonce();

        // Get URIs for static files
        const scriptUri = webview.asWebviewUri(
            vscode.Uri.joinPath(this.context.extensionUri, 'out', 'webview-client', 'main.js')
        );
        const d3Uri = webview.asWebviewUri(
            vscode.Uri.joinPath(this.context.extensionUri, 'media', 'webview', 'd3.v7.min.js')
        );
        const fontsUri = webview.asWebviewUri(
            vscode.Uri.joinPath(this.context.extensionUri, 'media', 'webview', 'fonts')
        );

        // Stringify graph data safely
        let graphJson: string;
        try {
            graphJson = JSON.stringify(graph);
        } catch (error) {
            console.error('Failed to stringify graph:', error);
            graphJson = '{"nodes":[],"edges":[],"llms_detected":[],"workflows":[]}';
        }

        // Read and process CSS with font URI replacement
        const cssPath = path.join(this.context.extensionPath, 'media', 'webview', 'styles.css');
        let css = fs.readFileSync(cssPath, 'utf8');
        css = css.replace(/\{\{fontsUri\}\}/g, fontsUri.toString());

        // Read static HTML template
        const htmlPath = path.join(this.context.extensionPath, 'media', 'webview', 'index.html');
        let html = fs.readFileSync(htmlPath, 'utf8');

        // Replace placeholders
        html = html.replace(/\{\{nonce\}\}/g, nonce);
        html = html.replace(/\{\{cspSource\}\}/g, webview.cspSource);
        html = html.replace(/\{\{d3Uri\}\}/g, d3Uri.toString());
        // Inline the processed CSS (with font URIs resolved)
        html = html.replace(/\{\{inlineStyles\}\}/g, css);

        // Replace script tag with graph data injection and bundled script
        const loadingState = loadingOptions?.loading ? 'true' : 'false';
        const scriptReplacement = `
    <script nonce="${nonce}">
        window.__GRAPH_DATA__ = ${graphJson};
        window.__LOADING_STATE__ = ${loadingState};
    </script>
    <script nonce="${nonce}" src="${scriptUri}"></script>
</body>`;

        html = html.replace('</body>', scriptReplacement);

        return html;
    }

    private getNonce(): string {
        let text = '';
        const possible = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';
        for (let i = 0; i < 32; i++) {
            text += possible.charAt(Math.floor(Math.random() * possible.length));
        }
        return text;
    }
}
