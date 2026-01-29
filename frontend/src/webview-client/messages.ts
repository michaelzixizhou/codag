// Message handler for extension communication
import * as state from './state';
import { computeGraphDiff, hasDiff } from './graph-diff';
import { detectWorkflowGroups, updateSnapshotStats } from './workflow-detection';
import { openPanel } from './panel';
import { layoutWorkflows } from './layout';
import { renderGroups, updateGroupsIncremental } from './groups';
import { renderEdges, updateEdgesIncremental } from './edges';
import { renderNodes, updateNodesIncremental, fadeInNodes, applyFileChangeState, hydrateLabels, markNodesPending, clearNodesPending } from './nodes';
import { dragstarted, dragged, dragended } from './drag';
import { renderMinimap, pulseMinimapNodes } from './minimap';
import { fitToScreen, formatGraph } from './controls';
import { updateGroupVisibility } from './visibility';
import { populateDirectory, focusOnWorkflow } from './directory';
import { getFilePicker } from './file-picker';
import { notifications } from './notifications';

declare const d3: any;

// Debounce state for updateGraph to prevent jitter from rapid updates
let pendingGraphUpdate: any = null;
let pendingNodeIdsForUpdate: string[] = [];  // Nodes awaiting metadata
let pendingFileChange: { filePath: string; functions: string[] } | null = null;  // File change to apply after render
let updateDebounceTimer: number | null = null;
const UPDATE_DEBOUNCE_MS = 150;

// Track nodes currently in pending state (awaiting metadata)
const pendingNodes = new Set<string>();

// Track active file change states (survives re-renders)
// filePath -> 'active' | 'changed'
const activeFileChanges = new Map<string, 'active' | 'changed'>();

export function setupMessageHandler(): void {
    const { svg, zoom } = state;

    window.addEventListener('message', async (event: MessageEvent) => {
        const message = event.data;

        switch (message.command) {
            case 'showLoading':
                notifications.show({
                    type: 'loading',
                    message: message.text || 'Loading...'
                });
                break;

            case 'updateProgress':
                // Legacy support - convert to new format
                notifications.updateProgress({
                    completed: message.current,
                    total: message.total
                });
                break;

            case 'batchProgress':
                // New cumulative progress format
                notifications.updateProgress({
                    completed: message.completed,
                    total: message.total,
                    filesAnalyzed: message.filesAnalyzed,
                    elapsed: message.elapsed
                });
                break;

            case 'showProgressOverlay':
                const overlay = document.getElementById('progressOverlay');
                const overlayText = overlay?.querySelector('.overlay-text') as HTMLElement;
                if (overlay && overlayText) {
                    overlayText.textContent = message.text || 'Processing...';
                    overlay.style.display = 'flex';
                }
                break;

            case 'hideProgressOverlay':
                const progressOverlay = document.getElementById('progressOverlay');
                if (progressOverlay) progressOverlay.style.display = 'none';
                break;

            case 'analysisStarted': {
                const backendErr = document.getElementById('backendError');
                if (backendErr) backendErr.style.display = 'none';
                notifications.show({
                    type: 'loading',
                    message: 'Analyzing workflow...'
                });
                break;
            }

            case 'analysisComplete':
                notifications.dismissType('loading');
                notifications.dismissType('progress');

                if (message.success) {
                    // Build completion message with stats if available
                    let subtext: string | undefined;
                    if (message.filesAnalyzed || message.batchCount || message.elapsed) {
                        const parts: string[] = [];
                        if (message.filesAnalyzed) parts.push(`${message.filesAnalyzed} files`);
                        if (message.batchCount) parts.push(`${message.batchCount} batches`);
                        if (message.elapsed) parts.push(`${(message.elapsed / 1000).toFixed(1)}s`);
                        subtext = parts.join(' · ');
                    }
                    notifications.show({
                        type: 'success',
                        message: 'Analysis complete',
                        subtext,
                        dismissMs: 2000
                    });
                } else {
                    notifications.show({
                        type: 'error',
                        message: message.error || 'Analysis failed',
                        dismissMs: 5000
                    });
                }
                break;

            case 'warning':
                notifications.show({
                    type: 'warning',
                    message: message.message || 'Warning',
                    dismissMs: 4000
                });
                break;

            case 'backendError': {
                notifications.dismissType('loading');
                const errorOverlay = document.getElementById('backendError');
                if (errorOverlay) {
                    errorOverlay.style.display = 'flex';
                    const retryBtn = document.getElementById('btn-retry-backend');
                    if (retryBtn) {
                        retryBtn.onclick = () => {
                            errorOverlay.style.display = 'none';
                            state.vscode.postMessage({ command: 'retryAnalysis' });
                        };
                    }
                }
                break;
            }

            case 'fileStateChange':
                // Handle live file change indicators
                if (message.changes && Array.isArray(message.changes)) {
                    message.changes.forEach((change: {
                        filePath: string;
                        functions?: string[];
                        state: 'active' | 'changed' | 'unchanged'
                    }) => {
                        // Track state for re-application after re-renders
                        if (change.state === 'unchanged') {
                            activeFileChanges.delete(change.filePath);
                        } else {
                            activeFileChanges.set(change.filePath, change.state);
                        }
                        applyFileChangeState(change.filePath, change.functions, change.state);
                    });
                }
                break;

            case 'hydrateLabels':
                // Handle metadata batch results - update node labels smoothly
                // Update nodes that are: (1) in pendingNodes set, OR (2) have a raw function name as label
                // This handles both normal flow and recovery after webview reset
                if (message.filePath && message.labels) {
                    const labelUpdates = new Map<string, string>();
                    const { currentGraphData } = state;

                    for (const node of currentGraphData.nodes) {
                        if (node.source?.file !== message.filePath) continue;

                        const funcName = node.source.function;
                        const newLabel = message.labels[funcName];
                        if (!newLabel) continue;

                        // Check if node needs hydration:
                        // 1. It's in the pending set (normal flow)
                        // 2. Its current label matches function name (recovery after reset)
                        const isPending = pendingNodes.has(node.id);
                        const hasRawLabel = node.label === funcName || node.label === funcName.replace(/_/g, ' ');

                        if (isPending || hasRawLabel) {
                            labelUpdates.set(node.id, newLabel);
                        }
                    }

                    if (labelUpdates.size > 0) {
                        // Clear pending state for nodes that got labels
                        const nodeIdsWithLabels = Array.from(labelUpdates.keys());
                        clearNodesPending(nodeIdsWithLabels);
                        nodeIdsWithLabels.forEach(id => pendingNodes.delete(id));

                        hydrateLabels(labelUpdates);

                        notifications.show({
                            type: 'success',
                            message: `Updated ${labelUpdates.size} labels`,
                            dismissMs: 2000
                        });
                    }
                }
                break;

            case 'updateGraph':
                if (message.preserveState && message.graph) {
                    // Debounce rapid updates to prevent jitter
                    pendingGraphUpdate = message.graph;
                    // Accumulate pending node IDs across debounced updates
                    if (message.pendingNodeIds && message.pendingNodeIds.length > 0) {
                        pendingNodeIdsForUpdate = [...new Set([...pendingNodeIdsForUpdate, ...message.pendingNodeIds])];
                    }
                    // Capture file change (last one wins for same file)
                    if (message.fileChange) {
                        pendingFileChange = message.fileChange;
                    }

                    if (updateDebounceTimer !== null) {
                        clearTimeout(updateDebounceTimer);
                    }

                    updateDebounceTimer = window.setTimeout(async () => {
                        updateDebounceTimer = null;
                        const graphToApply = pendingGraphUpdate;
                        const pendingIdsToApply = pendingNodeIdsForUpdate;
                        const fileChangeToApply = pendingFileChange;
                        pendingGraphUpdate = null;
                        pendingNodeIdsForUpdate = [];
                        pendingFileChange = null;

                        if (!graphToApply) return;

                        // Compute diff for toast message
                        const diff = computeGraphDiff(state.currentGraphData, graphToApply);

                        if (!hasDiff(diff)) {
                            return;
                        }

                        // Show loading notification with update summary
                        const addedCount = diff.nodes.added.length;
                        const removedCount = diff.nodes.removed.length;
                        const parts = [];
                        if (addedCount > 0) parts.push(`+${addedCount}`);
                        if (removedCount > 0) parts.push(`-${removedCount}`);

                        if (parts.length > 0) {
                            notifications.show({
                                type: 'loading',
                                message: `Updating: ${parts.join(', ')} nodes`
                            });
                        }

                        // Preserve collapsed states from old groups
                        const oldCollapsedIds = new Set(
                            state.workflowGroups.filter((g: any) => g.collapsed).map((g: any) => g.id)
                        );

                        // Update graph data
                        state.setGraphData(graphToApply);

                        // Re-detect workflow groups
                        const newWorkflowGroups = detectWorkflowGroups(graphToApply);

                        // Restore collapsed states
                        newWorkflowGroups.forEach((g: any) => {
                            if (oldCollapsedIds.has(g.id)) {
                                g.collapsed = true;
                            }
                        });

                        state.setWorkflowGroups(newWorkflowGroups);

                        // Get defs from svg
                        const defs = svg.select('defs');

                        // Run layout FIRST (calculates positions without touching DOM)
                        await layoutWorkflows(defs);

                        // Check if this is an additive-only update (batch analysis adds nodes, doesn't remove)
                        const isAdditiveOnly = diff.nodes.removed.length === 0 && diff.edges.removed.length === 0;
                        const structureChanged = diff.nodes.added.length > 0 || diff.nodes.removed.length > 0 ||
                                               diff.edges.added.length > 0 || diff.edges.removed.length > 0;

                        if (structureChanged && !isAdditiveOnly) {
                            // Structure changed with removals - crossfade to new render
                            const oldContainers = state.g.selectAll('.groups, .collapsed-groups, .nodes-container, .edge-paths-container, .edge-labels-container, .shared-arrows-container');

                            // Render new elements (they'll be appended after old ones)
                            renderGroups();
                            renderEdges();
                            renderNodes(dragstarted, dragged, dragended);

                            // Get newly rendered containers (last of each type)
                            const newGroups = state.g.select('.groups:last-of-type');
                            const newNodes = state.g.select('.nodes-container:last-of-type');
                            const newEdgePaths = state.g.select('.edge-paths-container:last-of-type');
                            const newEdgeLabels = state.g.select('.edge-labels-container:last-of-type');

                            // Start new elements invisible
                            [newGroups, newNodes, newEdgePaths, newEdgeLabels].forEach(sel => {
                                if (!sel.empty()) sel.style('opacity', 0);
                            });

                            // Crossfade: fade out old, fade in new
                            oldContainers.transition().duration(150).style('opacity', 0).remove();
                            [newGroups, newNodes, newEdgePaths, newEdgeLabels].forEach(sel => {
                                if (!sel.empty()) sel.transition().duration(150).style('opacity', 1);
                            });
                        } else if (isAdditiveOnly && structureChanged) {
                            // Additive-only update (batch analysis) - use incremental updates
                            // This avoids the flickering by only adding/removing changed elements
                            updateGroupsIncremental();
                            updateEdgesIncremental();
                            updateNodesIncremental(dragstarted, dragged, dragended);
                        } else {
                            // No structure change - just update positions in place (no blink)
                            state.g.select('.nodes-container').selectAll('.node').each(function(this: SVGGElement, d: any) {
                                const newData = state.currentGraphData.nodes.find((n: any) => n.id === d.id);
                                if (newData) Object.assign(d, newData);
                            });

                            state.g.selectAll('.workflow-group').each(function(this: SVGGElement, d: any) {
                                const newGroup = state.workflowGroups.find((g: any) => g.id === d.id);
                                if (newGroup) Object.assign(d, newGroup);
                            });

                            state.g.selectAll('.link, .link-hover').each(function(this: SVGPathElement, d: any) {
                                const newEdge = state.currentGraphData.edges.find((e: any) =>
                                    e.source === d.source && e.target === d.target
                                );
                                if (newEdge) Object.assign(d, newEdge);
                            });

                            formatGraph();
                        }

                        renderMinimap();
                        updateGroupVisibility();
                        updateSnapshotStats(state.workflowGroups, state.currentGraphData);

                        // Fade in newly added nodes
                        if (diff.nodes.added.length > 0) {
                            const newNodeIds = diff.nodes.added.map((n: any) => n.id);
                            fadeInNodes(newNodeIds);
                            pulseMinimapNodes(newNodeIds);
                        }

                        // Mark nodes as pending (awaiting metadata)
                        if (pendingIdsToApply.length > 0) {
                            markNodesPending(pendingIdsToApply);
                            // Track in global set for cleanup when labels arrive
                            pendingIdsToApply.forEach(id => pendingNodes.add(id));
                        }

                        // Track and apply new file change state
                        if (fileChangeToApply) {
                            activeFileChanges.set(fileChangeToApply.filePath, 'active');
                        }

                        // Re-apply ALL active file change states after render
                        // (CSS classes are lost when DOM elements are recreated)
                        for (const [filePath, changeState] of activeFileChanges) {
                            applyFileChangeState(filePath, undefined, changeState);
                        }

                        // Show success notification
                        notifications.dismissType('loading');
                        notifications.show({
                            type: 'success',
                            message: 'Graph updated',
                            dismissMs: 2000
                        });
                    }, UPDATE_DEBOUNCE_MS);
                }
                break;

            case 'focusNode':
                if (message.nodeId) {
                    const node = state.currentGraphData.nodes.find((n: any) => n.id === message.nodeId);
                    if (node) {
                        openPanel(node);

                        if (node.x !== undefined && node.y !== undefined) {
                            const svgElement = svg.node();
                            const width = svgElement.clientWidth;
                            const height = svgElement.clientHeight;
                            const scale = 1.2;

                            const transform = d3.zoomIdentity
                                .translate(width / 2, height / 2)
                                .scale(scale)
                                .translate(-node.x, -node.y);

                            svg.transition()
                                .duration(750)
                                .call(zoom.transform, transform);
                        }
                    }
                }
                break;

            case 'focusWorkflow':
                if (message.workflowName) {
                    focusOnWorkflow(message.workflowName);
                }
                break;

            case 'showFilePicker':
                if (message.tree && message.totalFiles !== undefined) {
                    const filePicker = getFilePicker();
                    filePicker.show({
                        tree: message.tree,
                        totalFiles: message.totalFiles,
                        pricing: message.pricing
                    }).then((selectedPaths) => {
                        // Send result back to extension
                        state.vscode.postMessage({
                            command: 'filePickerResult',
                            selectedPaths: selectedPaths
                        });
                    });
                }
                break;

            case 'closeFilePicker':
                // Close file picker immediately (no animation)
                getFilePicker().close(false);
                break;

            case 'initGraph':
                // Close file picker if open (no animation - show graph immediately)
                getFilePicker().close(false);

                if (message.graph) {
                    // Update graph data
                    state.setGraphData(message.graph);

                    // Detect workflow groups
                    const groups = detectWorkflowGroups(message.graph);
                    state.setWorkflowGroups(groups);

                    // Clear all graph elements
                    state.g.selectAll('.groups, .collapsed-groups, .nodes-container, .edge-paths-container, .edge-labels-container').remove();

                    // Get defs from svg
                    const defs = svg.select('defs');

                    // Run layout
                    await layoutWorkflows(defs);

                    // Render everything
                    renderGroups();
                    renderEdges();
                    renderNodes(dragstarted, dragged, dragended);

                    // Render minimap
                    renderMinimap();

                    // Fit to screen
                    fitToScreen();

                    // Apply group visibility
                    updateGroupVisibility();

                    // Update header stats
                    updateSnapshotStats(state.workflowGroups, state.currentGraphData);

                    // Show success notification
                    notifications.show({
                        type: 'success',
                        message: 'Loaded from cache',
                        dismissMs: 2000
                    });
                }
                break;
        }
    });
}
