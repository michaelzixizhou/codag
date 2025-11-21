/**
 * HTML template for the webview
 * Extracted from webview.ts to separate concerns
 */

export function getHtmlTemplate(webviewStyles: string, scriptContent: string): string {
    return `<!DOCTYPE html>
<html>
<head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <title>Workflow Visualization</title>
    <script src="https://d3js.org/d3.v7.min.js"></script>
    <script src="https://cdn.jsdelivr.net/npm/dagre@0.8.5/dist/dagre.min.js"></script>
    <style>${webviewStyles}
    </style>
</head>
<body>
    <div id="header">
        <h1>AI Workflow Visualization</h1>
        <div id="controls">
            <button onclick="zoomIn()" title="Zoom In">
                <svg viewBox="0 0 24 24"><path d="M19 13h-6v6h-2v-6H5v-2h6V5h2v6h6v2z"/></svg>
            </button>
            <button onclick="zoomOut()" title="Zoom Out">
                <svg viewBox="0 0 24 24"><path d="M19 13H5v-2h14v2z"/></svg>
            </button>
            <button onclick="resetZoom()" title="Fit to Screen">
                <svg viewBox="0 0 24 24"><path d="M3 3h6v2H5v4H3V3zm18 0v6h-2V5h-4V3h6zM3 15v6h6v-2H5v-4H3zm16 0v4h-4v2h6v-6h-2z"/></svg>
            </button>
            <button class="expand-btn" onclick="toggleExpandAll()" title="Expand/Collapse All Workflows">
                <svg viewBox="0 0 24 24"><path d="M12 5.83L15.17 9l1.41-1.41L12 3 7.41 7.59 8.83 9 12 5.83zm0 12.34L8.83 15l-1.41 1.41L12 21l4.59-4.59L15.17 15 12 18.17z"/></svg>
            </button>
            <button class="format-btn" onclick="formatGraph()" title="Reset Layout">
                <svg viewBox="0 0 24 24"><path d="M3 3v8h8V3H3zm6 6H5V5h4v4zm-6 4v8h8v-8H3zm6 6H5v-4h4v4zm4-16v8h8V3h-8zm6 6h-4V5h4v4zm-6 4v8h8v-8h-8zm6 6h-4v-4h4v4z"/></svg>
            </button>
            <button class="refresh-btn" onclick="refreshAnalysis()" title="Reanalyze Entire Workspace">
                <svg viewBox="0 0 24 24"><path d="M17.65 6.35A7.958 7.958 0 0 0 12 4c-4.42 0-7.99 3.58-7.99 8s3.57 8 7.99 8c3.73 0 6.84-2.55 7.73-6h-2.08A5.99 5.99 0 0 1 12 18c-3.31 0-6-2.69-6-6s2.69-6 6-6c1.66 0 3.14.69 4.22 1.78L13 11h7V4l-2.35 2.35z"/></svg>
            </button>
        </div>
    </div>

    <div id="graph"></div>

    <div id="buttonTooltip" class="button-tooltip"></div>

    <div id="legend" class="legend">
        <div class="legend-header" onclick="toggleLegend()">
            <span>Legend</span>
            <span id="legendToggle" class="legend-toggle">−</span>
        </div>
        <div id="legendContent" class="legend-content">
            <div class="legend-item">
                <div class="legend-line legend-line-entry"></div>
                <span>Entry Point</span>
            </div>
            <div class="legend-item">
                <div class="legend-line legend-line-exit"></div>
                <span>Exit Point</span>
            </div>
            <div class="legend-item">
                <div class="legend-line legend-line-critical"></div>
                <span>Critical Path</span>
            </div>
        </div>
    </div>

    <div id="minimap"></div>

    <div id="edgeTooltip" class="edge-tooltip" style="display: none;"></div>

    <div id="loadingIndicator" class="loading-indicator" style="display: none;">
        <div class="loading-content">
            <div>
                <div class="loading-icon">⏳</div>
                <div class="loading-text">Analyzing workflow...</div>
            </div>
            <div class="progress-bar-container" style="display: none;">
                <div class="progress-bar-fill"></div>
            </div>
        </div>
    </div>

    <div id="progressOverlay" class="progress-overlay" style="display: none;">
        <div class="overlay-content">
            <div class="overlay-spinner">⟳</div>
            <div class="overlay-text">Processing...</div>
        </div>
    </div>

    <div id="sidePanel" class="side-panel">
        <div class="panel-header">
            <h2 id="panelTitle">Node Details</h2>
            <button class="close-btn" onclick="closePanel()">&times;</button>
        </div>
        <div class="panel-content">
            <div class="panel-section">
                <label>Type</label>
                <div id="panelType" class="type-badge">-</div>
            </div>
            <div id="descriptionSection" class="panel-section">
                <label>Description</label>
                <p id="panelDescription">-</p>
            </div>
            <div id="sourceSection" class="panel-section">
                <label>Source Location</label>
                <a id="panelSource" class="source-link" href="#">-</a>
            </div>
            <div id="incomingSection" class="panel-section">
                <label>Incoming Data</label>
                <div id="panelIncoming">-</div>
            </div>
            <div id="outgoingSection" class="panel-section">
                <label>Outgoing Data</label>
                <div id="panelOutgoing">-</div>
            </div>
        </div>
    </div>

    <script>
${scriptContent}
    </script>
</body>
</html>`;
}
