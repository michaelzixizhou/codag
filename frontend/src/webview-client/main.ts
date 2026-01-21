// Main entry point for webview client
import './types';
import * as state from './state';
import { setupSVG } from './setup';
import { layoutWorkflows } from './layout';
import { renderGroups } from './groups';
import { renderCollapsedComponents } from './components';
import { renderEdges, updateEdgePaths, updateEdgeLabels } from './edges';
import { renderNodes } from './nodes';
import { dragstarted, dragged, dragended } from './drag';
import { setupControls, fitToScreen, formatGraph } from './controls';
import { renderMinimap, setupMinimapZoomListener } from './minimap';
import { setupClosePanel, closePanel } from './panel';
import { setupMessageHandler } from './messages';
import { updateGroupVisibility, updateComponentVisibility } from './visibility';
import { detectWorkflowGroups, updateSnapshotStats } from './workflow-detection';
import { setupDirectory } from './directory';
import { setupAuthHandlers } from './auth';

declare const d3: any;
declare function acquireVsCodeApi(): any;

// Initialize on load
(async function init() {
    // Get VSCode API
    const vscode = acquireVsCodeApi();

    // Get graph data from window
    const graphData = (window as any).__GRAPH_DATA__;

    if (!graphData) {
        console.error('No graph data found');
        return;
    }

    // Detect workflow groups
    const groups = detectWorkflowGroups(graphData);

    // Setup SVG
    const { svg, g, zoom, defs } = setupSVG();

    // Initialize state
    state.initState(vscode, svg, g, zoom);
    state.setGraphData(graphData);
    state.setWorkflowGroups(groups);

    // Layout workflows using ELK (async)
    await layoutWorkflows(defs);

    // Render groups (before edges/nodes for z-index)
    renderGroups();

    // Render edges
    renderEdges();

    // Render nodes
    renderNodes(dragstarted, dragged, dragended);

    // Render collapsed components (within workflows)
    renderCollapsedComponents(updateComponentVisibility);

    // Setup controls (zoom, format, refresh)
    setupControls();
    setupClosePanel();
    setupDirectory();

    // Setup auth handlers (trial tag, sign-up button, auth panel)
    setupAuthHandlers();

    // Setup message handler
    setupMessageHandler();

    // Show loading indicator if analysis is in progress
    const loadingState = (window as any).__LOADING_STATE__;
    if (loadingState) {
        const indicator = document.getElementById('loadingIndicator');
        if (indicator) {
            const iconSpan = indicator.querySelector('.loading-icon') as HTMLElement;
            const textSpan = indicator.querySelector('.loading-text') as HTMLElement;
            if (iconSpan) {
                iconSpan.innerHTML = '<svg class="spinner-pill" viewBox="0 0 24 24" width="14" height="14"><rect x="8" y="2" width="8" height="20" rx="4" ry="4" fill="currentColor"/></svg>';
            }
            if (textSpan) {
                textSpan.textContent = 'Analyzing...';
            }
            indicator.style.display = 'block';
        }
    }

    // Signal extension that webview is ready to receive messages
    vscode.postMessage({ command: 'webviewReady' });

    // Setup minimap zoom listener
    setupMinimapZoomListener();

    // Close panel when clicking on SVG background
    svg.on('click', function(event: any) {
        const target = event.target;
        if (target.tagName === 'svg' || (target.tagName === 'rect' && target.classList.contains('pegboard-bg'))) {
            closePanel();
        }
    });

    // Initial view - fit entire graph to screen
    setTimeout(() => {
        // Reset layout to clean ELK positions
        formatGraph(updateGroupVisibility);
        renderMinimap();
        fitToScreen();
        // Apply initial group collapse states (also populates directory)
        updateGroupVisibility();
        // Update header stats
        updateSnapshotStats(state.workflowGroups, state.currentGraphData);

        // Force edge paths update (component edges need this)
        updateEdgePaths();
        updateEdgeLabels();

        // Double-update after frame to catch any late renders
        requestAnimationFrame(() => {
            updateEdgePaths();
            updateEdgeLabels();
        });
    }, 50);

    // Re-render minimap on window resize (debounced)
    let resizeTimeout: ReturnType<typeof setTimeout> | null = null;
    window.addEventListener('resize', () => {
        if (resizeTimeout) clearTimeout(resizeTimeout);
        resizeTimeout = setTimeout(() => {
            renderMinimap();
        }, 150);
    });
})();
