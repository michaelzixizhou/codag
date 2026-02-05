// Node rendering
import * as state from './state';
import { NODE_WIDTH, NODE_HEIGHT, NODE_BORDER_RADIUS } from './constants';
import { colorFromString, escapeNodeIdForCSS } from './utils';

declare const d3: any;

export function renderNodes(
    dragstarted: (event: any, d: any) => void,
    dragged: (event: any, d: any) => void,
    dragended: (event: any, d: any) => void
): void {
    const { g, expandedNodes } = state;

    // Use expanded nodes from layout
    const nodesToRender = expandedNodes;

    // Create nodes
    const node = g.append('g')
        .attr('class', 'nodes-container')
        .selectAll('g')
        .data(nodesToRender)
        .enter()
        .append('g')
        .attr('class', 'node')
        .attr('data-node-id', (d: any) => d.id)
        .call(d3.drag()
            .on('start', dragstarted)
            .on('drag', dragged)
            .on('end', dragended));

    // Add full background fill (dynamic dimensions)
    // LLM nodes: blue, Decision nodes: diamond shape, Title nodes: workflow color, Others: background
    node.each(function(this: SVGGElement, d: any) {
        const group = d3.select(this);
        const w = d.width || NODE_WIDTH;
        const h = d.height || NODE_HEIGHT;

        if (d.type === 'decision') {
            // Short hexagon shape for decision nodes (pointy left/right, flat top/bottom)
            const indent = w * 0.1;  // How far top/bottom edges indent from the points (half as long corners)
            const hexPath = `M ${-w/2 + indent} ${-h/2} L ${w/2 - indent} ${-h/2} L ${w/2} 0 L ${w/2 - indent} ${h/2} L ${-w/2 + indent} ${h/2} L ${-w/2} 0 Z`;
            group.append('path')
                .attr('d', hexPath)
                .style('fill', 'var(--vscode-editor-background)')
                .style('stroke', 'none');
        } else if (d.type === 'reference') {
            // Reference node: simple background (purple border added separately)
            group.append('rect')
                .attr('width', w)
                .attr('height', h)
                .attr('x', -w / 2)
                .attr('y', -h / 2)
                .attr('rx', NODE_BORDER_RADIUS)
                .style('fill', 'var(--vscode-editor-background)')
                .style('stroke', 'none');
        } else if (d.type === 'workflow-title') {
            // Title nodes: rounded pill with darker workflow color (for white text contrast)
            const workflowColor = colorFromString(d.id.replace('__title_', ''), 65, 35);
            group.append('rect')
                .attr('width', w)
                .attr('height', h)
                .attr('x', -w / 2)
                .attr('y', -h / 2)
                .attr('rx', h / 2)  // Pill shape
                .style('fill', workflowColor)
                .style('stroke', 'none');
        } else {
            // Rectangle for other nodes
            group.append('rect')
                .attr('width', w)
                .attr('height', h)
                .attr('x', -w / 2)
                .attr('y', -h / 2)
                .attr('rx', NODE_BORDER_RADIUS)
                .style('fill', d.type === 'llm' ? '#1976D2' : 'var(--vscode-editor-background)')
                .style('stroke', 'none');
        }
    });

    // Add border (dynamic dimensions)
    node.each(function(this: SVGGElement, d: any) {
        const group = d3.select(this);
        const w = d.width || NODE_WIDTH;
        const h = d.height || NODE_HEIGHT;

        if (d.type === 'decision') {
            // Short hexagon border for decision nodes
            const indent = w * 0.1;
            const hexPath = `M ${-w/2 + indent} ${-h/2} L ${w/2 - indent} ${-h/2} L ${w/2} 0 L ${w/2 - indent} ${h/2} L ${-w/2 + indent} ${h/2} L ${-w/2} 0 Z`;
            group.append('path')
                .attr('class', 'node-border')
                .attr('d', hexPath)
                .style('fill', 'none')
                .style('stroke', 'var(--vscode-descriptionForeground)')
                .style('stroke-width', '2px')
                .style('pointer-events', 'all');
        } else if (d.type === 'reference') {
            // Reference node: purple border to indicate cross-workflow reference
            group.append('rect')
                .attr('class', 'node-border')
                .attr('width', w)
                .attr('height', h)
                .attr('x', -w / 2)
                .attr('y', -h / 2)
                .attr('rx', NODE_BORDER_RADIUS)
                .style('fill', 'none')
                .style('stroke', '#7c3aed')
                .style('stroke-width', '2px')
                .style('pointer-events', 'all');
        } else if (d.type === 'workflow-title') {
            // Title nodes: pill border matching darker fill color
            const workflowColor = colorFromString(d.id.replace('__title_', ''), 65, 35);
            group.append('rect')
                .attr('class', 'node-border')
                .attr('width', w)
                .attr('height', h)
                .attr('x', -w / 2)
                .attr('y', -h / 2)
                .attr('rx', h / 2)  // Pill shape
                .style('fill', 'none')
                .style('stroke', workflowColor)
                .style('stroke-width', '2px')
                .style('pointer-events', 'all');
        } else {
            // Rectangle border for other nodes
            group.append('rect')
                .attr('class', 'node-border')
                .attr('width', w)
                .attr('height', h)
                .attr('x', -w / 2)
                .attr('y', -h / 2)
                .attr('rx', NODE_BORDER_RADIUS)
                .style('fill', 'none')
                .style('stroke', 'var(--vscode-editorWidget-border)')
                .style('stroke-width', '2px')
                .style('pointer-events', 'all');
        }
    });

    // Add title centered in node with text wrapping
    // For decision nodes, use _textWidth/_textHeight (the inner usable area)
    const titleWrapper = node.append('foreignObject')
        .attr('x', (d: any) => {
            const textW = d._textWidth || d.width || NODE_WIDTH;
            return -textW / 2 + 4;
        })
        .attr('y', (d: any) => {
            const textH = d._textHeight || d.height || NODE_HEIGHT;
            return -textH / 2 + 4;
        })
        .attr('width', (d: any) => {
            const textW = d._textWidth || d.width || NODE_WIDTH;
            return textW - 8;
        })
        .attr('height', (d: any) => {
            const textH = d._textHeight || d.height || NODE_HEIGHT;
            return textH - 8;
        })
        .append('xhtml:div')
        .attr('xmlns', 'http://www.w3.org/1999/xhtml')
        .attr('class', 'node-title-wrapper')
        .style('width', '100%')
        .style('height', '100%')
        .style('display', 'flex')
        .style('align-items', 'center')
        .style('justify-content', 'center');

    titleWrapper.append('xhtml:span')
        .attr('xmlns', 'http://www.w3.org/1999/xhtml')
        .attr('lang', 'en')
        .style('display', 'block')
        .style('width', '100%')
        .style('text-align', 'center')
        .style('color', (d: any) => (d.type === 'llm' || d.type === 'workflow-title') ? '#ffffff' : 'var(--vscode-editor-foreground)')
        .style('font-family', '"DM Sans", "Inter", "Segoe UI", -apple-system, sans-serif')
        .style('font-size', (d: any) => d.type === 'workflow-title' ? '16px' : '15px')
        .style('font-weight', (d: any) => d.type === 'workflow-title' ? '600' : '400')
        .style('letter-spacing', '-0.01em')
        .style('line-height', '1.2')
        .style('word-break', 'break-word')
        .style('word-wrap', 'break-word')
        .style('overflow-wrap', 'break-word')
        .style('hyphens', 'auto')
        .style('-webkit-hyphens', 'auto')
        .text((d: any) => d.label);

    // Add selection indicator (camera corners) - dynamic based on node dimensions
    const cornerSize = 8;
    node.append('g')
        .attr('class', 'node-selection-indicator')
        .attr('data-node-id', (d: any) => d.id)
        .style('display', 'none')
        .each(function(this: SVGGElement, d: any) {
            const group = d3.select(this);
            const cornerOffsetX = (d.width || NODE_WIDTH) / 2 + 8;
            const cornerOffsetY = (d.height || NODE_HEIGHT) / 2 + 8;
            group.append('path').attr('d', `M -${cornerOffsetX} -${cornerOffsetY - cornerSize} L -${cornerOffsetX} -${cornerOffsetY} L -${cornerOffsetX - cornerSize} -${cornerOffsetY}`);
            group.append('path').attr('d', `M ${cornerOffsetX - cornerSize} -${cornerOffsetY} L ${cornerOffsetX} -${cornerOffsetY} L ${cornerOffsetX} -${cornerOffsetY - cornerSize}`);
            group.append('path').attr('d', `M -${cornerOffsetX} ${cornerOffsetY - cornerSize} L -${cornerOffsetX} ${cornerOffsetY} L -${cornerOffsetX - cornerSize} ${cornerOffsetY}`);
            group.append('path').attr('d', `M ${cornerOffsetX - cornerSize} ${cornerOffsetY} L ${cornerOffsetX} ${cornerOffsetY} L ${cornerOffsetX} ${cornerOffsetY - cornerSize}`);
        });

    // Tooltip on hover
    node.append('title')
        .text((d: any) => {
            let text = `${d.label}\nType: ${d.type}`;
            if (d._refWorkflowName) {
                text += `\nFrom: ${d._refWorkflowName}`;
            }
            if (d.description) {
                text += `\n\n${d.description}`;
            }
            return text;
        });

    // Set initial positions
    node.attr('transform', (d: any) => `translate(${d.x},${d.y})`);

    state.setNode(node);
}

/**
 * Pulse animation for newly added nodes
 */
export function pulseNodes(nodeIds: string[]): void {
    nodeIds.forEach(id => {
        d3.select(`.node[data-node-id="${escapeNodeIdForCSS(id)}"]`)
            .transition().duration(200)
            .style('opacity', 0.3)
            .transition().duration(400)
            .style('opacity', 1)
            .transition().duration(200)
            .style('opacity', 0.3)
            .transition().duration(400)
            .style('opacity', 1);
    });
}

/**
 * Smooth fade-in animation for newly added nodes.
 * Starts invisible and fades to full opacity.
 */
export function fadeInNodes(nodeIds: string[]): void {
    nodeIds.forEach(id => {
        const node = d3.select(`.node[data-node-id="${escapeNodeIdForCSS(id)}"]`);
        if (node.empty()) return;
        node.style('opacity', 0)
            .transition().duration(400)
            .style('opacity', 1);
    });
}

/**
 * Hydrate node labels after metadata is fetched.
 * Smoothly updates labels without re-rendering the entire graph.
 *
 * @param labelUpdates Map of nodeId → new label
 */
export function hydrateLabels(labelUpdates: Map<string, string>): void {
    labelUpdates.forEach((newLabel, nodeId) => {
        const nodeElement = d3.select(`.node[data-node-id="${escapeNodeIdForCSS(nodeId)}"]`);
        if (!nodeElement.empty()) {
            // Update the text span with smooth fade
            nodeElement.select('.node-title-wrapper span')
                .transition()
                .duration(150)
                .style('opacity', 0.5)
                .transition()
                .duration(150)
                .style('opacity', 1)
                .text(newLabel);

            // Also update the data binding for consistency
            const nodeData = nodeElement.datum() as any;
            if (nodeData) {
                nodeData.label = newLabel;
            }
        }
    });
}

/**
 * Mark nodes as "syncing" (waiting for metadata).
 * Shows a subtle indicator that metadata is being fetched.
 *
 * @param nodeIds Array of node IDs to mark as syncing
 */
export function markNodesSyncing(nodeIds: string[]): void {
    nodeIds.forEach(id => {
        const nodeElement = d3.select(`.node[data-node-id="${escapeNodeIdForCSS(id)}"]`);
        if (!nodeElement.empty()) {
            // Add subtle opacity pulse to indicate loading
            nodeElement.classed('syncing', true);
            nodeElement.select('.node-title-wrapper span')
                .style('opacity', 0.7);
        }
    });
}

/**
 * Clear syncing state from nodes.
 *
 * @param nodeIds Array of node IDs to clear syncing state
 */
export function clearNodesSyncing(nodeIds: string[]): void {
    nodeIds.forEach(id => {
        const nodeElement = d3.select(`.node[data-node-id="${escapeNodeIdForCSS(id)}"]`);
        if (!nodeElement.empty()) {
            nodeElement.classed('syncing', false);
            nodeElement.select('.node-title-wrapper span')
                .transition()
                .duration(150)
                .style('opacity', 1);
        }
    });
}

/**
 * Mark nodes as "pending" (awaiting LLM metadata).
 * Shows dashed border and italic text via CSS.
 *
 * @param nodeIds Array of node IDs to mark as pending
 */
export function markNodesPending(nodeIds: string[]): void {
    nodeIds.forEach(id => {
        const escapedId = escapeNodeIdForCSS(id);
        const nodeElement = d3.select(`.node[data-node-id="${escapedId}"]`);
        if (!nodeElement.empty()) {
            nodeElement.classed('pending', true);
            nodeElement.select('.node-border').classed('pending', true);
        }
        // Also mark in minimap
        const minimapNode = d3.select(`.minimap-node[data-node-id="${escapedId}"]`);
        if (!minimapNode.empty()) {
            minimapNode.classed('pending', true);
        }
    });
}

/**
 * Clear pending state from nodes (after metadata arrives).
 * Smoothly transitions to normal appearance.
 *
 * @param nodeIds Array of node IDs to clear pending state
 */
export function clearNodesPending(nodeIds: string[]): void {
    nodeIds.forEach(id => {
        const escapedId = escapeNodeIdForCSS(id);
        const nodeElement = d3.select(`.node[data-node-id="${escapedId}"]`);
        if (!nodeElement.empty()) {
            nodeElement.classed('pending', false);
            nodeElement.select('.node-border').classed('pending', false);
        }
        // Also clear in minimap
        const minimapNode = d3.select(`.minimap-node[data-node-id="${escapedId}"]`);
        if (!minimapNode.empty()) {
            minimapNode.classed('pending', false);
        }
    });
}

/**
 * Get all node IDs that match the given file path and optionally specific functions
 */
export function getNodesByFileAndFunctions(filePath: string, functions?: string[]): string[] {
    const { currentGraphData } = state;
    if (!currentGraphData?.nodes) return [];

    const matched = currentGraphData.nodes
        .filter(node => {
            if (node.source?.file !== filePath) return false;
            // If no functions specified, don't match any (require explicit function list)
            if (!functions || functions.length === 0) return false;
            // Match if node's function is in the changed list
            return functions.includes(node.source.function);
        })
        .map(node => node.id);

    return matched;
}

/**
 * Normalize function name for matching (strip parens, underscores).
 */
function normalizeFunctionName(name: string): string {
    return name.replace(/\(\)$/, '').replace(/_/g, '').toLowerCase();
}

/**
 * Apply file change state CSS class to nodes matching the given file path.
 * Uses node.source.function to match against changed function names.
 *
 * Logic:
 * - functions === undefined → highlight ALL nodes (Phase 1: we don't know yet)
 * - functions === [] → highlight NONE (Phase 2: no changes detected)
 * - functions === ['fn1', 'fn2'] → highlight only those specific functions
 */
export function applyFileChangeState(
    filePath: string,
    functions: string[] | undefined,
    changeState: 'active' | 'changed' | 'unchanged'
): void {
    const { currentGraphData } = state;
    if (!currentGraphData?.nodes) return;

    // Get nodes from this file
    const fileNodes = currentGraphData.nodes.filter(node => node.source?.file === filePath);

    // Determine which nodes to highlight based on functions parameter
    let nodesToHighlight: typeof fileNodes;

    if (functions === undefined) {
        // Phase 1: No functions specified = highlight ALL nodes (optimistic)
        nodesToHighlight = fileNodes;
    } else if (functions.length === 0) {
        // Phase 2 with no changes: empty array = highlight NONE
        nodesToHighlight = [];
    } else {
        // Phase 2 with changes: highlight only specified functions
        const changedFuncsNormalized = new Set(functions.map(normalizeFunctionName));
        nodesToHighlight = fileNodes.filter(node => {
            const nodeFunc = node.source?.function;
            if (!nodeFunc) return false;
            return changedFuncsNormalized.has(normalizeFunctionName(nodeFunc));
        });
    }

    const nodeIdsToHighlight = new Set(nodesToHighlight.map(n => n.id));
    const allFileNodeIds = fileNodes.map(n => n.id);

    if (changeState === 'unchanged') {
        // Clear all indicators for this file
        allFileNodeIds.forEach(nodeId => {
            const escapedId = escapeNodeIdForCSS(nodeId);
            const border = document.querySelector(`.node[data-node-id="${escapedId}"] .node-border`);
            if (border) {
                border.classList.remove('file-active', 'file-changed');
            }
            const minimapNode = document.querySelector(`.minimap-node[data-node-id="${escapedId}"]`);
            if (minimapNode) {
                minimapNode.classList.remove('file-active', 'file-changed');
            }
        });
        return;
    }

    // For 'active' or 'changed', apply only to matched nodes
    allFileNodeIds.forEach(nodeId => {
        const escapedId = escapeNodeIdForCSS(nodeId);
        const border = document.querySelector(`.node[data-node-id="${escapedId}"] .node-border`);
        if (!border) return;

        // Remove existing file state classes
        border.classList.remove('file-active', 'file-changed');

        // Apply new state only if this node is in the highlight set
        if (nodeIdsToHighlight.has(nodeId)) {
            if (changeState === 'active') {
                border.classList.add('file-active');
            } else if (changeState === 'changed') {
                border.classList.add('file-changed');
            }
        }
    });

    // Also update minimap nodes
    allFileNodeIds.forEach(nodeId => {
        const escapedId = escapeNodeIdForCSS(nodeId);
        const minimapNode = document.querySelector(`.minimap-node[data-node-id="${escapedId}"]`);
        if (!minimapNode) return;

        minimapNode.classList.remove('file-active', 'file-changed');
        if (nodeIdsToHighlight.has(nodeId)) {
            if (changeState === 'active') {
                minimapNode.classList.add('file-active');
            } else if (changeState === 'changed') {
                minimapNode.classList.add('file-changed');
            }
        }
    });
}

/**
 * Clear all file change indicators from all nodes
 */
export function clearFileChangeIndicators(): void {
    document.querySelectorAll('.node-border.file-active, .node-border.file-changed')
        .forEach(el => {
            el.classList.remove('file-active', 'file-changed');
        });
    document.querySelectorAll('.minimap-node.file-active, .minimap-node.file-changed')
        .forEach(el => {
            el.classList.remove('file-active', 'file-changed');
        });
}

/**
 * Helper to create a single node element with all its structure.
 * Extracted from renderNodes for reuse in incremental updates.
 */
function createNodeElement(nodeGroup: any, d: any): void {
    const w = d.width || NODE_WIDTH;
    const h = d.height || NODE_HEIGHT;

    // Add background fill
    if (d.type === 'decision') {
        const indent = w * 0.1;
        const hexPath = `M ${-w/2 + indent} ${-h/2} L ${w/2 - indent} ${-h/2} L ${w/2} 0 L ${w/2 - indent} ${h/2} L ${-w/2 + indent} ${h/2} L ${-w/2} 0 Z`;
        nodeGroup.append('path')
            .attr('d', hexPath)
            .style('fill', 'var(--vscode-editor-background)')
            .style('stroke', 'none');
    } else if (d.type === 'reference') {
        nodeGroup.append('rect')
            .attr('width', w)
            .attr('height', h)
            .attr('x', -w / 2)
            .attr('y', -h / 2)
            .attr('rx', NODE_BORDER_RADIUS)
            .style('fill', 'var(--vscode-editor-background)')
            .style('stroke', 'none');
    } else if (d.type === 'workflow-title') {
        const workflowColor = colorFromString(d.id.replace('__title_', ''), 65, 35);
        nodeGroup.append('rect')
            .attr('width', w)
            .attr('height', h)
            .attr('x', -w / 2)
            .attr('y', -h / 2)
            .attr('rx', h / 2)
            .style('fill', workflowColor)
            .style('stroke', 'none');
    } else {
        nodeGroup.append('rect')
            .attr('width', w)
            .attr('height', h)
            .attr('x', -w / 2)
            .attr('y', -h / 2)
            .attr('rx', NODE_BORDER_RADIUS)
            .style('fill', d.type === 'llm' ? '#1976D2' : 'var(--vscode-editor-background)')
            .style('stroke', 'none');
    }

    // Add border
    if (d.type === 'decision') {
        const indent = w * 0.1;
        const hexPath = `M ${-w/2 + indent} ${-h/2} L ${w/2 - indent} ${-h/2} L ${w/2} 0 L ${w/2 - indent} ${h/2} L ${-w/2 + indent} ${h/2} L ${-w/2} 0 Z`;
        nodeGroup.append('path')
            .attr('class', 'node-border')
            .attr('d', hexPath)
            .style('fill', 'none')
            .style('stroke', 'var(--vscode-editorWidget-border)')
            .style('stroke-width', '2px')
            .style('pointer-events', 'all');
    } else if (d.type === 'reference') {
        nodeGroup.append('rect')
            .attr('class', 'node-border')
            .attr('width', w)
            .attr('height', h)
            .attr('x', -w / 2)
            .attr('y', -h / 2)
            .attr('rx', NODE_BORDER_RADIUS)
            .style('fill', 'none')
            .style('stroke', '#7c3aed')
            .style('stroke-width', '2px')
            .style('pointer-events', 'all');
    } else if (d.type === 'workflow-title') {
        const workflowColor = colorFromString(d.id.replace('__title_', ''), 65, 35);
        nodeGroup.append('rect')
            .attr('class', 'node-border')
            .attr('width', w)
            .attr('height', h)
            .attr('x', -w / 2)
            .attr('y', -h / 2)
            .attr('rx', h / 2)
            .style('fill', 'none')
            .style('stroke', workflowColor)
            .style('stroke-width', '2px')
            .style('pointer-events', 'all');
    } else {
        nodeGroup.append('rect')
            .attr('class', 'node-border')
            .attr('width', w)
            .attr('height', h)
            .attr('x', -w / 2)
            .attr('y', -h / 2)
            .attr('rx', NODE_BORDER_RADIUS)
            .style('fill', 'none')
            .style('stroke', 'var(--vscode-editorWidget-border)')
            .style('stroke-width', '2px')
            .style('pointer-events', 'all');
    }

    // Add title
    const textW = d._textWidth || d.width || NODE_WIDTH;
    const textH = d._textHeight || d.height || NODE_HEIGHT;
    const titleWrapper = nodeGroup.append('foreignObject')
        .attr('x', -textW / 2 + 4)
        .attr('y', -textH / 2 + 4)
        .attr('width', textW - 8)
        .attr('height', textH - 8)
        .append('xhtml:div')
        .attr('xmlns', 'http://www.w3.org/1999/xhtml')
        .attr('class', 'node-title-wrapper')
        .style('width', '100%')
        .style('height', '100%')
        .style('display', 'flex')
        .style('align-items', 'center')
        .style('justify-content', 'center');

    titleWrapper.append('xhtml:span')
        .attr('xmlns', 'http://www.w3.org/1999/xhtml')
        .attr('lang', 'en')
        .style('display', 'block')
        .style('width', '100%')
        .style('text-align', 'center')
        .style('color', (d.type === 'llm' || d.type === 'workflow-title') ? '#ffffff' : 'var(--vscode-editor-foreground)')
        .style('font-family', '"DM Sans", "Inter", "Segoe UI", -apple-system, sans-serif')
        .style('font-size', d.type === 'workflow-title' ? '16px' : '15px')
        .style('font-weight', d.type === 'workflow-title' ? '600' : '400')
        .style('letter-spacing', '-0.01em')
        .style('line-height', '1.2')
        .style('word-break', 'break-word')
        .style('word-wrap', 'break-word')
        .style('overflow-wrap', 'break-word')
        .style('hyphens', 'auto')
        .style('-webkit-hyphens', 'auto')
        .text(d.label);

    // Add selection indicator
    const cornerSize = 8;
    const selIndicator = nodeGroup.append('g')
        .attr('class', 'node-selection-indicator')
        .attr('data-node-id', d.id)
        .style('display', 'none');

    const cornerOffsetX = w / 2 + 8;
    const cornerOffsetY = h / 2 + 8;
    selIndicator.append('path').attr('d', `M -${cornerOffsetX} -${cornerOffsetY - cornerSize} L -${cornerOffsetX} -${cornerOffsetY} L -${cornerOffsetX - cornerSize} -${cornerOffsetY}`);
    selIndicator.append('path').attr('d', `M ${cornerOffsetX - cornerSize} -${cornerOffsetY} L ${cornerOffsetX} -${cornerOffsetY} L ${cornerOffsetX} -${cornerOffsetY - cornerSize}`);
    selIndicator.append('path').attr('d', `M -${cornerOffsetX} ${cornerOffsetY - cornerSize} L -${cornerOffsetX} ${cornerOffsetY} L -${cornerOffsetX - cornerSize} ${cornerOffsetY}`);
    selIndicator.append('path').attr('d', `M ${cornerOffsetX - cornerSize} ${cornerOffsetY} L ${cornerOffsetX} ${cornerOffsetY} L ${cornerOffsetX} ${cornerOffsetY - cornerSize}`);

    // Add tooltip
    nodeGroup.append('title')
        .text(() => {
            let text = `${d.label}\nType: ${d.type}`;
            if (d.description) {
                text += `\n\n${d.description}`;
            }
            return text;
        });
}

/**
 * Incrementally update nodes without destroying existing DOM elements.
 * Uses D3 enter/update/exit pattern to minimize DOM operations.
 */
export function updateNodesIncremental(
    dragstarted: (event: any, d: any) => void,
    dragged: (event: any, d: any) => void,
    dragended: (event: any, d: any) => void
): void {
    const { g, expandedNodes } = state;

    // Get or create the nodes container
    let nodesContainer = g.select('.nodes-container');
    if (nodesContainer.empty()) {
        nodesContainer = g.append('g').attr('class', 'nodes-container');
    }

    // Data join with key function
    const nodeSelection = nodesContainer.selectAll('.node')
        .data(expandedNodes, (d: any) => d.id);

    // EXIT: Remove nodes that no longer exist
    nodeSelection.exit().remove();

    // ENTER: Create new nodes
    const enterNodes = nodeSelection.enter()
        .append('g')
        .attr('class', 'node')
        .attr('data-node-id', (d: any) => d.id)
        .call(d3.drag()
            .on('start', dragstarted)
            .on('drag', dragged)
            .on('end', dragended));

    // Build each new node's internal structure
    enterNodes.each(function(this: SVGGElement, d: any) {
        createNodeElement(d3.select(this), d);
    });

    // UPDATE + ENTER: Update positions on all nodes
    const allNodes = nodeSelection.merge(enterNodes);
    allNodes.attr('transform', (d: any) => `translate(${d.x},${d.y})`);

    state.setNode(allNodes);
}
