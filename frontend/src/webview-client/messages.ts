// Message handler for extension communication
import * as state from './state';
import { computeGraphDiff, hasDiff } from './graph-diff';
import { detectWorkflowGroups, updateSnapshotStats, ensureVisualCues } from './workflow-detection';
import { openPanel } from './panel';
import { layoutWorkflows } from './layout';
import { renderGroups, renderCollapsedGroups } from './groups';
import { renderEdges } from './edges';
import { renderNodes, pulseNodes } from './nodes';
import { dragstarted, dragged, dragended } from './drag';
import { renderMinimap, pulseMinimapNodes } from './minimap';
import { fitToScreen } from './controls';
import { updateGroupVisibility } from './visibility';
import { populateDirectory, focusOnWorkflow } from './directory';
import { getFilePicker } from './file-picker';
import { setAuthState, openAuthPanel, AuthState } from './auth';

declare const d3: any;

export function setupMessageHandler(): void {
    const { svg, zoom } = state;

    window.addEventListener('message', (event: MessageEvent) => {
        const message = event.data;
        const indicator = document.getElementById('loadingIndicator');
        const iconSpan = indicator?.querySelector('.loading-icon') as HTMLElement;
        const textSpan = indicator?.querySelector('.loading-text') as HTMLElement;

        if (!indicator || !iconSpan || !textSpan) return;

        switch (message.command) {
            case 'showLoading':
                indicator.className = 'loading-indicator';
                iconSpan.innerHTML = '<svg class="spinner-pill" viewBox="0 0 24 24" width="14" height="14"><rect x="8" y="2" width="8" height="20" rx="4" ry="4" fill="currentColor"/></svg>';
                textSpan.textContent = message.text || 'Loading...';
                indicator.style.display = 'block';
                break;

            case 'updateProgress':
                indicator.className = 'loading-indicator';
                iconSpan.innerHTML = '<svg class="spinner-pill" viewBox="0 0 24 24" width="14" height="14"><rect x="8" y="2" width="8" height="20" rx="4" ry="4" fill="currentColor"/></svg>';
                indicator.style.display = 'block';

                const progressContainer = indicator.querySelector('.progress-bar-container') as HTMLElement;
                const progressFill = indicator.querySelector('.progress-bar-fill') as HTMLElement;
                if (progressContainer && progressFill) {
                    progressContainer.style.display = 'block';
                    const percent = (message.current / message.total) * 100;
                    progressFill.style.width = `${percent}%`;
                    textSpan.textContent = `Analyzing batch ${message.current}/${message.total}...`;
                }
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

            case 'analysisStarted':
                indicator.className = 'loading-indicator';
                iconSpan.innerHTML = '<svg class="spinner-pill" viewBox="0 0 24 24" width="14" height="14"><rect x="8" y="2" width="8" height="20" rx="4" ry="4" fill="currentColor"/></svg>';
                textSpan.textContent = 'Analyzing workflow...';
                indicator.style.display = 'block';
                // Initialize progress bar at 0%
                const startProgressContainer = indicator.querySelector('.progress-bar-container') as HTMLElement;
                const startProgressFill = indicator.querySelector('.progress-bar-fill') as HTMLElement;
                if (startProgressContainer && startProgressFill) {
                    startProgressContainer.style.display = 'block';
                    startProgressFill.style.width = '0%';
                }
                break;

            case 'analysisComplete':
                // Hide progress bar
                const completeProgressBar = indicator.querySelector('.progress-bar-container') as HTMLElement;
                if (completeProgressBar) completeProgressBar.style.display = 'none';

                if (message.success) {
                    indicator.className = 'loading-indicator success';
                    iconSpan.textContent = '✓';
                    textSpan.textContent = 'Analysis complete';
                    setTimeout(() => {
                        indicator.style.display = 'none';
                    }, 2000);
                } else {
                    indicator.className = 'loading-indicator error';
                    iconSpan.textContent = '✕';
                    textSpan.textContent = message.error || 'Analysis failed';
                    setTimeout(() => {
                        indicator.style.display = 'none';
                    }, 3000);
                }
                break;

            case 'warning':
                indicator.className = 'loading-indicator warning';
                iconSpan.textContent = '⚠';
                textSpan.textContent = message.message || 'Warning';
                indicator.style.display = 'block';
                setTimeout(() => {
                    indicator.style.display = 'none';
                }, 4000);
                break;

            case 'updateGraph':
                if (message.preserveState && message.graph) {
                    console.log('[webview] updateGraph: applying update');

                    // Capture zoom transform
                    const zoomTransform = d3.zoomTransform(svg.node());

                    // Compute diff for toast message
                    const diff = computeGraphDiff(state.currentGraphData, message.graph);

                    if (!hasDiff(diff)) {
                        console.log('[webview] updateGraph: no changes detected');
                        break;
                    }

                    // Show loading indicator with update summary (don't hide progress bar)
                    const addedCount = diff.nodes.added.length;
                    const removedCount = diff.nodes.removed.length;
                    const parts = [];
                    if (addedCount > 0) parts.push(`+${addedCount}`);
                    if (removedCount > 0) parts.push(`-${removedCount}`);

                    indicator.className = 'loading-indicator';
                    indicator.classList.remove('hidden');
                    iconSpan.innerHTML = '<svg class="spinner-pill" viewBox="0 0 24 24" width="14" height="14"><rect x="8" y="2" width="8" height="20" rx="4" ry="4" fill="currentColor"/></svg>';
                    // Only update text if progress bar is not visible (batch analysis in progress)
                    const updateProgressBar = indicator.querySelector('.progress-bar-container') as HTMLElement;
                    if (!updateProgressBar || updateProgressBar.style.display === 'none') {
                        textSpan.textContent = `Updating: ${parts.join(', ')} nodes`;
                    }
                    indicator.style.display = 'block';

                    // Preserve collapsed states from old groups
                    const oldCollapsedIds = new Set(
                        state.workflowGroups.filter((g: any) => g.collapsed).map((g: any) => g.id)
                    );

                    // Ensure visual cues on new data
                    ensureVisualCues(message.graph);

                    // Update graph data
                    state.setGraphData(message.graph);

                    // Re-detect workflow groups
                    const newWorkflowGroups = detectWorkflowGroups(message.graph);

                    // Restore collapsed states
                    newWorkflowGroups.forEach((g: any) => {
                        if (oldCollapsedIds.has(g.id)) {
                            g.collapsed = true;
                        }
                    });

                    state.setWorkflowGroups(newWorkflowGroups);

                    // Clear all graph elements (keep pegboard bg and defs)
                    state.g.selectAll('.groups, .collapsed-groups, .nodes-container, .edge-paths-container').remove();

                    // Get defs from svg
                    const defs = svg.select('defs');

                    // Re-run layout
                    layoutWorkflows(defs);

                    // Re-render everything
                    renderGroups(updateGroupVisibility);
                    renderEdges();
                    renderNodes(dragstarted, dragged, dragended);
                    renderCollapsedGroups(updateGroupVisibility);

                    // Restore zoom transform
                    svg.call(zoom.transform, zoomTransform);

                    // Re-render minimap
                    renderMinimap();

                    // Apply group visibility
                    updateGroupVisibility();

                    // Pulse newly added nodes
                    if (diff.nodes.added.length > 0) {
                        const newNodeIds = diff.nodes.added.map((n: any) => n.id);
                        setTimeout(() => {
                            pulseNodes(newNodeIds);
                            pulseMinimapNodes(newNodeIds);
                        }, 100); // Small delay to ensure DOM is ready
                    }

                    // Update header stats
                    updateSnapshotStats(state.workflowGroups, state.currentGraphData);

                    console.log('[webview] updateGraph: complete', {
                        nodesAdded: addedCount,
                        nodesRemoved: removedCount
                    });

                    // Show success
                    indicator.className = 'loading-indicator success';
                    iconSpan.textContent = '✓';
                    textSpan.textContent = 'Graph updated';
                    setTimeout(() => {
                        indicator.classList.add('hidden');
                        setTimeout(() => indicator.style.display = 'none', 300);
                    }, 2000);
                } else {
                    console.log('[webview] updateGraph: no graph data or preserveState=false');
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
                        totalFiles: message.totalFiles
                    }).then((selectedPaths) => {
                        // Send result back to extension
                        state.vscode.postMessage({
                            command: 'filePickerResult',
                            selectedPaths: selectedPaths
                        });
                    });
                }
                break;

            case 'updateFilePickerLLM':
                if (message.llmFiles) {
                    getFilePicker().updateLLMFiles(message.llmFiles);
                }
                break;

            case 'updateAuthState':
                // Update auth state (trial tag, sign-up button)
                console.log('[webview-msg] Received updateAuthState:', message.authState);
                if (message.authState) {
                    setAuthState(message.authState as AuthState);
                }
                break;

            case 'showAuthPanel':
                // Show the auth panel (when trial exhausted)
                openAuthPanel();
                break;

            case 'authError':
                // Show auth error in loading indicator
                indicator.className = 'loading-indicator error';
                iconSpan.textContent = '✕';
                textSpan.textContent = message.error || 'Authentication failed';
                indicator.style.display = 'block';
                setTimeout(() => {
                    indicator.style.display = 'none';
                }, 4000);
                break;

            case 'closeFilePicker':
                // Close file picker immediately (no animation)
                getFilePicker().close(false);
                break;

            case 'initGraph':
                // Close file picker if open (no animation - show graph immediately)
                getFilePicker().close(false);

                if (message.graph) {
                    console.log('[webview] initGraph: initializing with cached data');

                    // Ensure visual cues on new data
                    ensureVisualCues(message.graph);

                    // Update graph data
                    state.setGraphData(message.graph);

                    // Detect workflow groups
                    const groups = detectWorkflowGroups(message.graph);
                    state.setWorkflowGroups(groups);

                    // Clear all graph elements
                    state.g.selectAll('.groups, .collapsed-groups, .nodes-container, .edge-paths-container').remove();

                    // Get defs from svg
                    const defs = svg.select('defs');

                    // Run layout
                    layoutWorkflows(defs);

                    // Render everything
                    renderGroups(updateGroupVisibility);
                    renderEdges();
                    renderNodes(dragstarted, dragged, dragended);
                    renderCollapsedGroups(updateGroupVisibility);

                    // Render minimap
                    renderMinimap();

                    // Fit to screen
                    fitToScreen();

                    // Apply group visibility
                    updateGroupVisibility();

                    // Update header stats
                    updateSnapshotStats(state.workflowGroups, state.currentGraphData);

                    // Show success indicator
                    indicator.className = 'loading-indicator success';
                    iconSpan.textContent = '✓';
                    textSpan.textContent = 'Loaded from cache';
                    indicator.style.display = 'block';
                    setTimeout(() => {
                        indicator.classList.add('hidden');
                        setTimeout(() => indicator.style.display = 'none', 300);
                    }, 2000);
                }
                break;
        }
    });
}
