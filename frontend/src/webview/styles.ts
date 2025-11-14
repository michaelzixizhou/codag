export const webviewStyles = `
    * {
        margin: 0;
        padding: 0;
        box-sizing: border-box;
    }
    body {
        overflow: hidden;
        background: var(--vscode-editor-background);
        color: var(--vscode-editor-foreground);
        font-family: var(--vscode-font-family);
    }
    #header {
        position: fixed;
        top: 0;
        left: 0;
        right: 0;
        height: 36px;
        padding: 0 16px;
        background: var(--vscode-editor-background);
        border-bottom: 1px solid var(--vscode-panel-border);
        z-index: 1000;
        display: flex;
        justify-content: space-between;
        align-items: center;
    }
    #header h1 {
        font-size: 13px;
        font-weight: 500;
        margin: 0;
        color: var(--vscode-foreground);
        opacity: 0.9;
    }
    #controls {
        display: flex;
        gap: 4px;
    }
    #controls button {
        background: transparent;
        color: var(--vscode-icon-foreground);
        border: 1px solid transparent;
        padding: 4px;
        cursor: pointer;
        font-size: 16px;
        border-radius: 3px;
        width: 28px;
        height: 28px;
        display: flex;
        align-items: center;
        justify-content: center;
        transition: all 0.15s ease;
    }
    #controls button:hover {
        background: var(--vscode-toolbar-hoverBackground);
        border-color: var(--vscode-contrastBorder);
    }
    #controls button svg {
        width: 16px;
        height: 16px;
        fill: currentColor;
    }
    #graph {
        position: fixed;
        top: 36px;
        left: 0;
        right: 0;
        bottom: 0;
        width: 100%;
        height: calc(100% - 36px);
    }
    svg {
        width: 100%;
        height: 100%;
        cursor: grab;
    }
    svg:active {
        cursor: grabbing;
    }
    .node {
        cursor: pointer;
    }
    .node rect {
        fill: var(--vscode-editor-background);
        stroke: #ffffff;
        stroke-width: 2px;
        opacity: 1;
        pointer-events: all;
        cursor: pointer;
    }
    .node:hover rect {
        stroke-width: 3px;
        fill: var(--vscode-list-hoverBackground);
    }
    .node-icon {
        pointer-events: none;
        user-select: none;
    }
    .node-icon.trigger { color: #FFB74D; }
    .node-icon.llm { color: #64B5F6; }
    .node-icon.tool { color: #81C784; }
    .node-icon.decision { color: #BA68C8; }
    .node-icon.integration { color: #FF8A65; }
    .node-icon.memory { color: #4DB6AC; }
    .node-icon.parser { color: #A1887F; }
    .node-icon.output { color: #90A4AE; }
    .node text {
        fill: var(--vscode-editor-foreground);
        font-size: 11px;
        pointer-events: none;
        user-select: none;
        text-anchor: middle;
    }
    .link {
        fill: none;
        stroke: var(--vscode-editor-foreground);
        stroke-opacity: 0.6;
        stroke-width: 2px;
    }
    .link.critical-path {
        stroke-width: 4px !important;
        stroke-opacity: 1 !important;
        stroke: #FF6B6B !important;
    }
    .node rect.critical-path {
        stroke-width: 4px !important;
        stroke: #FF6B6B !important;
    }
    .node rect.entry-point {
        stroke-dasharray: 5, 5 !important;
        stroke: #4CAF50 !important;
        stroke-width: 3px !important;
    }
    .node rect.exit-point {
        stroke-dasharray: 5, 5 !important;
        stroke: #2196F3 !important;
        stroke-width: 3px !important;
    }
    .node-selection-indicator {
        stroke: var(--vscode-textLink-foreground);
        stroke-width: 3px;
        fill: none;
        pointer-events: none;
        stroke-linecap: round;
    }
    .link-label {
        fill: var(--vscode-editor-background);
        font-size: 10px;
        font-weight: 600;
        pointer-events: all;
        user-select: none;
        text-anchor: middle;
        cursor: pointer;
        transition: fill 0.2s;
    }
    .link-label-bg {
        fill: var(--vscode-editor-foreground);
        fill-opacity: 0.9;
        pointer-events: all;
        rx: 3;
        ry: 3;
        cursor: pointer;
        transition: fill 0.2s, fill-opacity 0.2s;
    }
    .link-label-group:hover .link-label-bg {
        fill: #00d9ff;
        fill-opacity: 1;
    }
    .link-label-group:hover .link-label {
        fill: #000000;
    }
    .edge-tooltip {
        position: fixed;
        background: var(--vscode-editor-background);
        border: 1px solid var(--vscode-panel-border);
        border-radius: 4px;
        padding: 8px;
        font-size: 12px;
        z-index: 10000;
        box-shadow: 0 2px 8px rgba(0,0,0,0.3);
        max-width: 300px;
        pointer-events: none;
    }
    .edge-tooltip div {
        margin: 4px 0;
    }
    .edge-tooltip strong {
        color: var(--vscode-textLink-foreground);
    }
    .loading-indicator {
        position: fixed;
        bottom: 16px;
        right: 16px;
        background: var(--vscode-editor-background);
        border: 1px solid var(--vscode-panel-border);
        border-radius: 4px;
        padding: 8px 12px;
        font-size: 11px;
        z-index: 2000;
        box-shadow: 0 2px 8px rgba(0,0,0,0.3);
        transition: opacity 0.3s ease;
    }
    .loading-content {
        display: flex;
        align-items: center;
        gap: 8px;
    }
    .loading-icon {
        display: inline-block;
        animation: spin 1s linear infinite;
    }
    .loading-indicator.success {
        border-color: #4CAF50;
    }
    .loading-indicator.success .loading-icon {
        animation: none;
    }
    .loading-indicator.error {
        border-color: #f44336;
    }
    .loading-indicator.error .loading-icon {
        animation: none;
    }
    @keyframes spin {
        from { transform: rotate(0deg); }
        to { transform: rotate(360deg); }
    }
    .side-panel {
        position: fixed;
        top: 36px;
        right: -320px;
        width: 320px;
        bottom: 0;
        background: var(--vscode-editor-background);
        border-left: 1px solid var(--vscode-panel-border);
        transition: right 0.3s ease;
        z-index: 1001;
        display: flex;
        flex-direction: column;
    }
    .side-panel.open {
        right: 0;
    }
    .panel-header {
        padding: 16px;
        border-bottom: 1px solid var(--vscode-panel-border);
        display: flex;
        justify-content: space-between;
        align-items: center;
    }
    .panel-header h2 {
        font-size: 14px;
        font-weight: 600;
        margin: 0;
        color: var(--vscode-foreground);
    }
    .close-btn {
        background: transparent;
        border: none;
        color: var(--vscode-icon-foreground);
        font-size: 24px;
        cursor: pointer;
        padding: 0;
        width: 24px;
        height: 24px;
        display: flex;
        align-items: center;
        justify-content: center;
        border-radius: 3px;
    }
    .close-btn:hover {
        background: var(--vscode-toolbar-hoverBackground);
    }
    .panel-content {
        padding: 16px;
        overflow-y: auto;
        flex: 1;
    }
    .panel-section {
        margin-bottom: 16px;
    }
    .panel-section label {
        display: block;
        font-size: 11px;
        text-transform: uppercase;
        color: var(--vscode-descriptionForeground);
        margin-bottom: 6px;
        font-weight: 600;
    }
    .type-badge {
        display: inline-block;
        padding: 4px 10px;
        border-radius: 12px;
        font-size: 12px;
        font-weight: 500;
    }
    .type-badge.trigger { background: #FFB74D20; color: #FFB74D; }
    .type-badge.llm { background: #64B5F620; color: #64B5F6; }
    .type-badge.tool { background: #81C78420; color: #81C784; }
    .type-badge.decision { background: #BA68C820; color: #BA68C8; }
    .type-badge.integration { background: #FF8A6520; color: #FF8A65; }
    .type-badge.memory { background: #4DB6AC20; color: #4DB6AC; }
    .type-badge.parser { background: #A1887F20; color: #A1887F; }
    .type-badge.output { background: #90A4AE20; color: #90A4AE; }
    .source-link {
        color: var(--vscode-textLink-foreground);
        text-decoration: none;
        font-size: 12px;
        font-family: var(--vscode-editor-font-family);
        display: block;
        padding: 6px;
        background: var(--vscode-editor-inactiveSelectionBackground);
        border-radius: 3px;
        word-break: break-all;
    }
    .source-link:hover {
        text-decoration: underline;
        background: var(--vscode-list-hoverBackground);
    }
    #minimap {
        position: fixed;
        bottom: 16px;
        left: 16px;
        width: 200px;
        height: 150px;
        background: var(--vscode-editor-background);
        border: 1px solid var(--vscode-panel-border);
        border-radius: 4px;
        z-index: 1500;
        overflow: hidden;
        box-shadow: 0 2px 8px rgba(0,0,0,0.3);
    }
    #minimap svg {
        width: 100%;
        height: 100%;
        cursor: pointer;
    }
    #minimap .minimap-node {
        opacity: 0.8;
    }
    #minimap .minimap-node.trigger { fill: #FFB74D; }
    #minimap .minimap-node.llm { fill: #64B5F6; }
    #minimap .minimap-node.tool { fill: #81C784; }
    #minimap .minimap-node.decision { fill: #BA68C8; }
    #minimap .minimap-node.integration { fill: #FF8A65; }
    #minimap .minimap-node.memory { fill: #4DB6AC; }
    #minimap .minimap-node.parser { fill: #A1887F; }
    #minimap .minimap-node.output { fill: #90A4AE; }
    #minimap .minimap-edge {
        stroke: var(--vscode-editor-foreground);
        stroke-width: 1px;
        opacity: 0.3;
        fill: none;
    }
    #minimap .minimap-viewport {
        fill: none;
        stroke: var(--vscode-textLink-foreground);
        stroke-width: 2px;
        opacity: 0.8;
        pointer-events: none;
    }
`;
