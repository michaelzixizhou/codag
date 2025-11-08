import * as vscode from 'vscode';
import { APIClient } from './api';
import { AuthManager } from './auth';
import { CacheManager } from './cache';
import { WorkflowDetector } from './analyzer';
import { WebviewManager } from './webview';
import { metadataBuilder } from './metadata-builder';

const outputChannel = vscode.window.createOutputChannel('AI Workflow Visualizer');

export function activate(context: vscode.ExtensionContext) {
    outputChannel.appendLine('AI Workflow Visualizer activating...');

    const config = vscode.workspace.getConfiguration('aiworkflowviz');
    const apiUrl = config.get<string>('apiUrl', 'http://localhost:8000');

    outputChannel.appendLine(`Backend API URL: ${apiUrl}`);

    const api = new APIClient(apiUrl, outputChannel);
    const auth = new AuthManager(context, api);
    const cache = new CacheManager(context);
    const webview = new WebviewManager(context);

    outputChannel.appendLine('Extension activated successfully');
    outputChannel.show();

    context.subscriptions.push(
        vscode.commands.registerCommand('aiworkflowviz.login', () => auth.login())
    );

    context.subscriptions.push(
        vscode.commands.registerCommand('aiworkflowviz.register', () => auth.register())
    );

    context.subscriptions.push(
        vscode.commands.registerCommand('aiworkflowviz.logout', () => auth.logout())
    );

    context.subscriptions.push(
        vscode.commands.registerCommand('aiworkflowviz.visualize', async () => {
            // TODO: Re-enable auth when ready
            // if (!auth.isAuthenticated()) {
            //     vscode.window.showWarningMessage('Please login first');
            //     return;
            // }

            const editor = vscode.window.activeTextEditor;
            if (!editor) {
                vscode.window.showWarningMessage('No active file');
                return;
            }

            const document = editor.document;
            const content = document.getText();
            const filePath = document.uri.fsPath;

            outputChannel.appendLine(`Visualizing file: ${filePath}`);

            if (!WorkflowDetector.isWorkflowFile(document.uri)) {
                vscode.window.showWarningMessage('File type not supported');
                outputChannel.appendLine(`File type not supported: ${filePath}`);
                return;
            }

            try {
                // Check cache
                let graph = await cache.get(filePath, content);

                if (!graph) {
                    vscode.window.showInformationMessage('Analyzing workflow...');
                    webview.notifyAnalysisStarted();

                    // Build metadata using static analysis
                    outputChannel.appendLine(`Building metadata with static analysis...`);
                    const metadata = await metadataBuilder.buildSingleFileMetadata(document.uri);
                    outputChannel.appendLine(`Found ${metadata.locations.length} code locations`);

                    const framework = WorkflowDetector.detectFramework(content);
                    outputChannel.appendLine(`Detected framework: ${framework || 'none'}`);
                    outputChannel.appendLine(`Sending request to backend...`);

                    graph = await api.analyzeWorkflow(content, [filePath], framework || undefined, [metadata]);
                    await cache.set(filePath, content, graph);
                    outputChannel.appendLine(`Analysis complete, cached result`);
                    webview.notifyAnalysisComplete(true);
                } else {
                    outputChannel.appendLine(`Using cached result for ${filePath}`);
                }

                webview.show(graph);
            } catch (error: any) {
                outputChannel.appendLine(`ERROR: ${error.message}`);
                outputChannel.appendLine(`Status: ${error.response?.status}`);
                outputChannel.appendLine(`Response: ${JSON.stringify(error.response?.data)}`);
                const errorMsg = error.response?.data?.detail || error.message;
                webview.notifyAnalysisComplete(false, errorMsg);
                vscode.window.showErrorMessage(`Analysis failed: ${errorMsg}`);
            }
        })
    );

    context.subscriptions.push(
        vscode.commands.registerCommand('aiworkflowviz.visualizeWorkspace', async () => {
            // TODO: Re-enable auth when ready
            // if (!auth.isAuthenticated()) {
            //     vscode.window.showWarningMessage('Please login first');
            //     return;
            // }

            vscode.window.showInformationMessage('Scanning workspace for AI workflows...');
            outputChannel.appendLine('Starting workspace scan...');

            try {
                const workflowFiles = await WorkflowDetector.detectInWorkspace();
                outputChannel.appendLine(`Found ${workflowFiles.length} workflow files:`);

                if (workflowFiles.length === 0) {
                    vscode.window.showInformationMessage('No AI workflow files found in workspace');
                    return;
                }

                // Read all workflow files
                const fileContents: { path: string; content: string; }[] = [];
                for (const uri of workflowFiles) {
                    const relativePath = vscode.workspace.asRelativePath(uri);
                    outputChannel.appendLine(`  - ${relativePath}`);

                    const content = await vscode.workspace.fs.readFile(uri);
                    const text = Buffer.from(content).toString('utf8');
                    fileContents.push({
                        path: uri.fsPath,
                        content: text
                    });
                }

                // Combine all code for analysis
                const combinedCode = fileContents.map(f =>
                    `# File: ${f.path}\n${f.content}`
                ).join('\n\n');

                const allPaths = fileContents.map(f => f.path);

                // Check cache first
                const allContents = fileContents.map(f => f.content);
                let graph = await cache.getMultiple(allPaths, allContents);

                if (!graph) {
                    // Build metadata for all files
                    outputChannel.appendLine(`\nBuilding metadata with static analysis...`);
                    const metadata = await metadataBuilder.buildMetadata(workflowFiles);
                    const totalLocations = metadata.reduce((sum, m) => sum + m.locations.length, 0);
                    outputChannel.appendLine(`Found ${totalLocations} code locations across ${workflowFiles.length} files`);

                    // Log metadata details
                    for (const fileMeta of metadata) {
                        const relativePath = vscode.workspace.asRelativePath(fileMeta.file);
                        if (fileMeta.locations.length > 0) {
                            outputChannel.appendLine(`  ${relativePath}: ${fileMeta.locations.length} locations`);
                        } else {
                            outputChannel.appendLine(`  ${relativePath}: 0 locations (AST parse may have failed)`);
                        }
                    }

                    // Detect framework from any file
                    let framework: string | null = null;
                    for (const file of fileContents) {
                        framework = WorkflowDetector.detectFramework(file.content);
                        if (framework) break;
                    }

                    outputChannel.appendLine(`\nDetected framework: ${framework || 'generic LLM usage'}`);
                    outputChannel.appendLine(`Analyzing ${workflowFiles.length} files together...`);

                    vscode.window.showInformationMessage(`Analyzing ${workflowFiles.length} workflow files...`);
                    webview.notifyAnalysisStarted();

                    graph = await api.analyzeWorkflow(combinedCode, allPaths, framework || undefined, metadata);

                    // Cache the result
                    await cache.setMultiple(allPaths, allContents, graph);

                    outputChannel.appendLine(`\nAnalysis complete: ${graph.nodes.length} nodes, ${graph.edges.length} edges`);
                    webview.notifyAnalysisComplete(true);
                } else {
                    outputChannel.appendLine(`\nUsing cached result for workspace (${workflowFiles.length} files)`);
                }

                webview.show(graph);
            } catch (error: any) {
                outputChannel.appendLine(`ERROR: ${error.message}`);
                outputChannel.appendLine(`Status: ${error.response?.status}`);
                outputChannel.appendLine(`Response: ${JSON.stringify(error.response?.data)}`);
                const errorMsg = error.response?.data?.detail || error.message;
                webview.notifyAnalysisComplete(false, errorMsg);
                vscode.window.showErrorMessage(`Workspace scan failed: ${errorMsg}`);
            }
        })
    );
}

export function deactivate() {}
