import * as vscode from 'vscode';
import * as path from 'path';
import { APIClient } from './api';
import { CacheManager } from './cache';
import { WorkflowDetector } from './analyzer';
import { WebviewManager } from './webview';
import { metadataBuilder } from './metadata-builder';
import { CONFIG } from './config';
import { buildFileTree, saveFilePickerSelection, getSavedSelectedPaths } from './file-picker';
import { getMetadataBatcher } from './metadata-batcher';
import { ParserManager } from './tree-sitter/parser-manager';

// File watching
import { scheduleFileAnalysis } from './file-watching/handler';
import { extractRepoStructure, formatHttpConnectionsForPrompt } from './repo-structure';

// Analysis helpers
import { withHttpEdges, runWithConcurrency } from './analysis/helpers';
import { analyzeAndUpdateSingleFile } from './analysis/single-file';
import { analyzeSelectedFiles } from './analysis/selected-files';
import { analyzeWorkspace } from './analysis/workspace';

// Cost tracking
import { estimateTokens } from './cost-tracking';

// File preparation
import { combineFilesXML, createDependencyBatches } from './file-preparation';

// Centralized state management
import {
    setHttpConnections, setCrossFileCalls, setRepoFiles,
    getAnalysisSession, incrementAnalysisSession,
    initCallGraphPersistence
} from './analysis/state';

const outputChannel = vscode.window.createOutputChannel('Codag');

// Module-level cache reference for deactivate flush
let cacheInstance: CacheManager | null = null;

/**
 * Register the bundled MCP server in the workspace config for the current editor.
 * Writes .cursor/mcp.json (Cursor) or .mcp.json (Claude Code / other).
 */
async function registerMcpServer(extensionPath: string, workspacePath: string): Promise<void> {
    const mcpServerPath = path.join(extensionPath, 'out', 'mcp-server.js');

    const appName = vscode.env.appName || '';
    const isCursor = appName.toLowerCase().includes('cursor');

    // Determine config file location
    const configDir = isCursor
        ? path.join(workspacePath, '.cursor')
        : workspacePath;
    const configFileName = isCursor ? 'mcp.json' : '.mcp.json';
    const configPath = path.join(configDir, configFileName);

    const configUri = vscode.Uri.file(configPath);

    // Read existing config if present
    let existing: Record<string, unknown> = {};
    try {
        const raw = await vscode.workspace.fs.readFile(configUri);
        existing = JSON.parse(Buffer.from(raw).toString('utf8'));
    } catch {
        // File doesn't exist yet
    }

    const servers = (existing.mcpServers ?? {}) as Record<string, unknown>;
    if (servers.codag) {
        return; // Already registered
    }

    servers.codag = {
        command: 'node',
        args: [mcpServerPath, workspacePath],
    };
    existing.mcpServers = servers;

    // Ensure directory exists
    await vscode.workspace.fs.createDirectory(vscode.Uri.file(configDir));
    await vscode.workspace.fs.writeFile(configUri, Buffer.from(JSON.stringify(existing, null, 2) + '\n', 'utf8'));
}

/**
 * Log message with timestamp
 */
function log(message: string): void {
    const now = new Date();
    const hours = now.getHours().toString().padStart(2, '0');
    const minutes = now.getMinutes().toString().padStart(2, '0');
    const seconds = now.getSeconds().toString().padStart(2, '0');
    const timestamp = `${hours}:${minutes}:${seconds}`;
    outputChannel.appendLine(`[${timestamp}] ${message}`);
}

export async function activate(context: vscode.ExtensionContext) {
    log('Codag activating...');

    // Register MCP server config for coding agents (Cursor, Claude Code, etc.)
    const workspaceFolder = vscode.workspace.workspaceFolders?.[0];
    if (workspaceFolder) {
        registerMcpServer(context.extensionPath, workspaceFolder.uri.fsPath)
            .then(() => log('MCP server registered'))
            .catch(err => log(`MCP registration skipped: ${err}`));
    }

    // Initialize tree-sitter parser (must happen before any parsing)
    const parserManager = ParserManager.create(context.extensionUri);
    try {
        await parserManager.init();
        log('Tree-sitter parser initialized (JS, TS, TSX, Python)');
    } catch (error) {
        log(`Warning: Tree-sitter init failed: ${error}. Parsing will be unavailable.`);
    }

    const config = vscode.workspace.getConfiguration('codag');
    const apiUrl = config.get<string>('apiUrl', 'http://localhost:52104');

    log(`Backend API URL: ${apiUrl}`);

    const api = new APIClient(apiUrl, outputChannel);
    const cache = new CacheManager(context);
    cacheInstance = cache;  // Store for deactivate flush
    const webview = new WebviewManager(context);

    // Initialize call graph persistence for instant local updates
    initCallGraphPersistence(context);

    // File watching for auto-refresh on save
    const fileWatcher = vscode.workspace.createFileSystemWatcher(
        '**/*.{py,ts,js,jsx,tsx,mjs,cjs,go,rs,c,h,cpp,cc,cxx,hpp,swift,java,lua}',
        false, // ignoreCreateEvents
        false, // ignoreChangeEvents
        true   // ignoreDeleteEvents
    );

    // Debounce timing
    const DEBOUNCE_MS = CONFIG.WATCHER.DEBOUNCE_MS;

    // Initialize metadata batcher for incremental label updates
    const metadataBatcher = getMetadataBatcher({
        debounceMs: 3000,
        maxWaitMs: 30000
    });
    metadataBatcher.setCacheManager(cache);

    // Handle metadata fetch (call LLM endpoint for labels)
    metadataBatcher.onFetch(async (files, contexts) => {
        log(`[Metadata Batch] Fetching metadata for ${files.length} files...`);

        try {
            const apiFiles = contexts.map(ctx => ({
                filePath: ctx.filePath,
                functions: ctx.functions.map(f => ({
                    name: f.name,
                    line: f.line,
                    type: f.type,
                    calls: f.calls,
                    code: f.code
                })),
                imports: ctx.imports
            }));

            const result = await api.analyzeMetadataOnly(apiFiles);
            log(`[Metadata Batch] Received metadata for ${result.files.length} files`);

            const metadataMap = new Map<string, {
                labels: Record<string, string>;
                descriptions: Record<string, string>;
                edgeLabels: Record<string, string>;
                timestamp: number;
            }>();

            for (const fileResult of result.files) {
                const labels: Record<string, string> = {};
                const descriptions: Record<string, string> = {};

                for (const func of fileResult.functions) {
                    labels[func.name] = func.label;
                    descriptions[func.name] = func.description;
                }

                metadataMap.set(fileResult.filePath, {
                    labels,
                    descriptions,
                    edgeLabels: fileResult.edgeLabels || {},
                    timestamp: Date.now()
                });
            }

            return metadataMap;
        } catch (error) {
            log(`[Metadata Batch] Error: ${error}`);
            throw error;
        }
    });

    // Handle metadata ready (hydrate labels in UI and persist to cache)
    metadataBatcher.onReady((filePath, metadata) => {
        log(`[Metadata Batch] Hydrating labels for ${filePath}: ${Object.keys(metadata.labels).length} labels`);
        webview.hydrateLabels(filePath, metadata.labels, metadata.descriptions);
        // Persist to cache so labels survive restarts
        cache.updateMetadata(filePath, {
            labels: metadata.labels,
            descriptions: metadata.descriptions,
            edgeLabels: {},
            timestamp: Date.now()
        });
    });

    // File watching configuration
    // Shared context for analysis operations
    const analysisCtx = { api, cache, webview, log };
    const workspaceCtx = { ...analysisCtx, metadataBuilder, extensionContext: context };

    // Wrapper for single file analysis that includes context
    const doAnalyzeAndUpdateSingleFile = (uri: vscode.Uri) => analyzeAndUpdateSingleFile(analysisCtx, uri);

    // File watching configuration
    const fileWatchingConfig = {
        debounceMs: DEBOUNCE_MS,
        activeToChangedMs: 4000  // 4 seconds before transitioning to static
    };
    const fileWatchingCtx = { cache, webview, log, metadataBatcher };

    // File watcher for changes
    fileWatcher.onDidChange(async (uri) => {
        await scheduleFileAnalysis(fileWatchingCtx, uri, 'watcher', fileWatchingConfig, doAnalyzeAndUpdateSingleFile);
    });
    fileWatcher.onDidCreate(async (uri) => {
        await scheduleFileAnalysis(fileWatchingCtx, uri, 'create', fileWatchingConfig, doAnalyzeAndUpdateSingleFile);
    });
    context.subscriptions.push(fileWatcher);

    // Document save handler (more reliable than file watcher)
    context.subscriptions.push(
        vscode.workspace.onDidSaveTextDocument(async (document) => {
            await scheduleFileAnalysis(fileWatchingCtx, document.uri, 'save', fileWatchingConfig, doAnalyzeAndUpdateSingleFile);
        })
    );

    // Track text edits for incremental tree-sitter parsing.
    // Applies edits to cached syntax trees so the next parse() reuses unchanged subtrees.
    context.subscriptions.push(
        vscode.workspace.onDidChangeTextDocument((event) => {
            if (!ParserManager.isAvailable()) return;
            const manager = ParserManager.get();
            for (const change of event.contentChanges) {
                manager.applyEdit(event.document.uri.fsPath, change);
            }
        })
    );

    log('Extension activated successfully');

    context.subscriptions.push(
        vscode.commands.registerCommand('codag.refresh', async () => {
            // Confirm before clearing cache
            const confirm = await vscode.window.showWarningMessage(
                'This will clear all cached analysis and reanalyze the entire workspace. Continue?',
                { modal: true },
                'Yes',
                'No'
            );

            if (confirm === 'Yes') {
                log('Clearing cache...');
                incrementAnalysisSession();  // Invalidate any pending analysis results
                metadataBatcher.cancel();  // Cancel pending metadata requests
                webview.clearGraph();  // Clear webview immediately so stale data isn't shown
                await cache.clear();
                log('Cache cleared successfully, reanalyzing workspace');
                await analyzeWorkspace(workspaceCtx, true);
            }
        })
    );

    // Clear cache for specific files and reanalyze them
    context.subscriptions.push(
        vscode.commands.registerCommand('codag.clearCacheAndReanalyze', async (paths: string[]) => {
            if (!paths || paths.length === 0) {
                vscode.window.showWarningMessage('No files selected to clear cache.');
                return;
            }

            log(`Clearing cache for ${paths.length} selected files...`);
            incrementAnalysisSession();  // Invalidate any pending analysis results
            metadataBatcher.cancel();  // Cancel pending metadata requests
            webview.clearGraph();  // Clear webview immediately so stale data isn't shown

            // Invalidate cache for each selected file
            for (const filePath of paths) {
                await cache.invalidateFile(filePath);
                log(`  Cleared: ${vscode.workspace.asRelativePath(filePath)}`);
            }

            log('Cache cleared, reanalyzing selected files...');

            // Save selection with relative paths
            const allSourceFiles = await WorkflowDetector.getAllSourceFiles();
            const pathsRelative = paths.map(p => vscode.workspace.asRelativePath(p, false));
            await saveFilePickerSelection(context, allSourceFiles, pathsRelative);

            // Analyze selected files with bypassCache=true to force fresh analysis
            await analyzeSelectedFiles({ ...analysisCtx, metadataBuilder }, paths, true);
        })
    );

    context.subscriptions.push(
        vscode.commands.registerCommand('codag.open', async () => {
            await analyzeWorkspace(workspaceCtx, false);
        })
    );

    // Show file picker without re-rendering graph (used from within webview)
    context.subscriptions.push(
        vscode.commands.registerCommand('codag.showFilePicker', async () => {
            log('Opening file picker (preserving current graph)...');
            webview.showLoading('Loading file tree...');

            // Fast: get all source files without LLM analysis
            const allFiles = await WorkflowDetector.getAllSourceFiles();
            if (allFiles.length === 0) {
                webview.notifyWarning('No source files found.');
                return;
            }

            webview.updateLoadingText('Building file tree...', `${allFiles.length.toLocaleString()} files`);

            // Build file tree and show picker immediately (includes token estimates)
            const { tree, totalFiles } = await buildFileTree(allFiles, context);
            const selectedPaths = await webview.showFilePicker(tree, totalFiles);

            if (!selectedPaths || selectedPaths.length === 0) {
                return; // User cancelled
            }

            // Convert to relative paths for consistency
            const selectedPathsRelative = selectedPaths.map(p => vscode.workspace.asRelativePath(p, false));

            // Save selection with relative paths
            await saveFilePickerSelection(context, allFiles, selectedPathsRelative);

            // Read selected files in parallel (use full paths for file reading)
            const fileReadResults = await Promise.all(
                selectedPaths.map(async (filePath) => {
                    try {
                        const uri = vscode.Uri.file(filePath);
                        const content = await vscode.workspace.fs.readFile(uri);
                        // Store relative path in result
                        return { path: vscode.workspace.asRelativePath(filePath, false), content: Buffer.from(content).toString('utf8') };
                    } catch (error) {
                        log(`⚠️  Skipping file (read error): ${filePath}`);
                        return null;
                    }
                })
            );
            const fileContents = fileReadResults.filter((f): f is { path: string; content: string } => f !== null);

            // Extract HTTP connections and cross-file calls for static edge detection
            const rawHttpStructure = extractRepoStructure(fileContents);
            setHttpConnections(rawHttpStructure.httpConnections);
            setCrossFileCalls(rawHttpStructure.crossFileCalls || []);
            // Store repo files for HTTP caller detection
            setRepoFiles(rawHttpStructure.files.map(f => ({
                path: f.path,
                functions: f.functions.map(fn => ({ name: fn.name, calls: fn.calls, line: fn.line }))
            })));
            const httpConnectionsContext = formatHttpConnectionsForPrompt(rawHttpStructure);

            // Check cache
            const allFilePaths = fileContents.map(f => f.path);
            const allFileContentsArr = fileContents.map(f => f.content);
            const cacheResult = await cache.checkFiles(allFilePaths, allFileContentsArr);

            if (cacheResult.cached.length > 0) {
                const cachedPaths = cacheResult.cached.map(f => f.path);
                let cachedGraph = await cache.getMergedGraph(cachedPaths);
                if (cachedGraph) {
                    // Add HTTP connection edges
                    webview.initGraph(withHttpEdges(cachedGraph, log)!);
                }
            }

            // If there are uncached files, analyze them in batches
            if (cacheResult.uncached.length > 0) {
                log(`Analyzing ${cacheResult.uncached.length} uncached files...`);

                // Convert relative paths back to Uris for metadata builder
                const workspaceFolder = vscode.workspace.workspaceFolders?.[0];
                if (!workspaceFolder) {
                    log('No workspace folder found');
                    return;
                }
                const uncachedUris = cacheResult.uncached.map(f => vscode.Uri.joinPath(workspaceFolder.uri, f.path));
                const metadata = await metadataBuilder.buildMetadata(uncachedUris);

                let framework: string | null = null;
                for (const file of cacheResult.uncached) {
                    framework = WorkflowDetector.detectFramework(file.content);
                    if (framework) break;
                }

                // Create dependency-based batches (same as main analysis flow)
                const batches = createDependencyBatches(
                    cacheResult.uncached,
                    metadata,
                    CONFIG.BATCH.MAX_SIZE,
                    CONFIG.BATCH.MAX_TOKENS
                );
                log(`Created ${batches.length} batch${batches.length > 1 ? 'es' : ''} for ${cacheResult.uncached.length} files`);

                const newGraphs: any[] = [];
                const maxConcurrency = CONFIG.CONCURRENCY.MAX_PARALLEL;
                const sessionAtStart = getAnalysisSession();

                webview.notifyAnalysisStarted();
                webview.startBatchProgress(batches.length);
                cache.startMultiBatchAnalysis(batches.length);

                // Process batches with worker pool - each worker picks up next batch immediately
                const batchTasks = batches.map((batch, batchIndex) => async () => {
                    const batchPaths = batch.map(f => f.path);
                    const batchMetadata = metadata.filter(m => batchPaths.includes(vscode.workspace.asRelativePath(m.file, false)));
                    const combinedCode = combineFilesXML(batch, batchMetadata);
                    const batchTokens = estimateTokens(combinedCode);

                    log(`Analyzing batch ${batchIndex + 1}/${batches.length} (${batch.length} files, ~${Math.round(batchTokens / 1000)}k tokens)...`);

                    try {
                        const batchResult = await api.analyzeWorkflow(
                            combinedCode,
                            batchPaths,
                            framework || undefined,
                            batchMetadata,
                            undefined,  // condensedStructure
                            httpConnectionsContext
                        );

                        // Check if session was invalidated (cache cleared) during request
                        if (getAnalysisSession() !== sessionAtStart) {
                            log(`Batch ${batchIndex + 1} result discarded (session invalidated)`);
                            return null;
                        }

                        const batchGraph = batchResult.graph;

                        newGraphs.push(batchGraph);

                        // Cache per-file
                        const contentMap: Record<string, string> = {};
                        for (const f of batch) contentMap[f.path] = f.content;
                        await cache.setAnalysisResult(batchGraph, contentMap);
                        cache.batchCompleted();

                        // Update progress only - graph updated once at end
                        webview.batchCompleted(batch.length);

                        log(`✓ Batch ${batchIndex + 1} complete: ${batchGraph.nodes.length} nodes`);
                        return batchGraph;
                    } catch (batchError: any) {
                        log(`Batch ${batchIndex + 1} failed: ${batchError.message}`);
                        cache.batchCompleted();  // Still decrement to prevent stuck state
                        return null;
                    }
                });

                await runWithConcurrency(batchTasks, maxConcurrency);

                // Final merge and completion
                const mergedGraph = await cache.getMergedGraph(allFilePaths);
                if (mergedGraph) {
                    webview.updateGraph(withHttpEdges(mergedGraph, log)!);
                }
                webview.notifyAnalysisComplete(true);
            }
        })
    );
}

export async function deactivate() {
    // Flush any pending cache writes before extension closes
    if (cacheInstance) {
        await cacheInstance.flush();
    }
    if (ParserManager.isAvailable()) {
        ParserManager.get().dispose();
    }
}
