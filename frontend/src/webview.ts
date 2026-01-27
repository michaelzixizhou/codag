import * as vscode from 'vscode';
import * as fs from 'fs';
import * as path from 'path';
import { WorkflowGraph } from './api';
import { ViewState } from './copilot/types';
import { FileTreeNode } from './file-picker';
import { AuthState, OAuthProvider } from './auth';

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
    private currentAuthState: AuthState | null = null;  // Track current auth state for re-sending after HTML replacement
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
                        const editor = await vscode.window.showTextDocument(document, vscode.ViewColumn.One);

                        const line = message.line - 1;
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
                } else if (message.command === 'startOAuth') {
                    // Start OAuth flow for specified provider
                    const provider = message.provider as OAuthProvider;
                    vscode.commands.executeCommand('codag.startOAuth', provider);
                } else if (message.command === 'logout') {
                    vscode.commands.executeCommand('codag.logout');
                } else if (message.command === 'webviewReady') {
                    // Webview is ready to receive messages
                    this.onWebviewReady();
                }
            },
            undefined,
            this.context.subscriptions
        );
    }

    /**
     * Update auth state in webview (trial tag, sign-up button visibility)
     */
    updateAuthState(state: AuthState) {
        console.log('[webview] updateAuthState called: panel=', !!this.panel, 'isAuthenticated=', state.isAuthenticated, 'hasUser=', !!state.user);
        // Always track current auth state so we can re-send after HTML replacement
        this.currentAuthState = state;
        if (this.panel) {
            this.postMessage({
                command: 'updateAuthState',
                authState: state
            });
        }
    }

    /**
     * Send current auth state to webview (called after HTML replacement)
     */
    private sendCurrentAuthState() {
        if (this.currentAuthState && this.panel) {
            console.log('[webview] Sending auth state after HTML replacement:', this.currentAuthState.isAuthenticated);
            this.postMessage({
                command: 'updateAuthState',
                authState: this.currentAuthState
            });
        }
    }

    /**
     * Show the auth panel (called when trial is exhausted)
     */
    showAuthPanel() {
        this.postMessage({ command: 'showAuthPanel' });
    }

    /**
     * Show auth error in the webview notification
     */
    showAuthError(error: string) {
        this.postMessage({ command: 'authError', error });
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
                vscode.ViewColumn.Beside,
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

            // Send queued auth state
            this.sendCurrentAuthState();
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
                vscode.ViewColumn.Beside,
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

            // Send queued auth state
            this.sendCurrentAuthState();
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

    updateGraph(graph: WorkflowGraph) {
        this.postMessage({
            command: 'updateGraph',
            graph,
            preserveState: true
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
                vscode.ViewColumn.Beside,
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

        // Send queued auth state AFTER reset (will be queued until webviewReady)
        this.sendCurrentAuthState();
    }

    private getHtml(graph: WorkflowGraph, loadingOptions?: LoadingOptions): string {
        const webview = this.panel!.webview;

        // Generate nonce for CSP
        const nonce = this.getNonce();

        // Get URIs for static files
        const stylesUri = webview.asWebviewUri(
            vscode.Uri.joinPath(this.context.extensionUri, 'media', 'webview', 'styles.css')
        );
        const scriptUri = webview.asWebviewUri(
            vscode.Uri.joinPath(this.context.extensionUri, 'out', 'webview-client', 'main.js')
        );

        // Stringify graph data safely
        let graphJson: string;
        try {
            graphJson = JSON.stringify(graph);
        } catch (error) {
            console.error('Failed to stringify graph:', error);
            graphJson = '{"nodes":[],"edges":[],"llms_detected":[],"workflows":[]}';
        }

        // Read static HTML template
        const htmlPath = path.join(this.context.extensionPath, 'media', 'webview', 'index.html');
        let html = fs.readFileSync(htmlPath, 'utf8');

        // Replace placeholders
        html = html.replace(/\{\{nonce\}\}/g, nonce);
        html = html.replace(/\{\{cspSource\}\}/g, webview.cspSource);
        html = html.replace(/\{\{stylesUri\}\}/g, stylesUri.toString());

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
