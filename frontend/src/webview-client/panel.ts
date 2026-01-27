// Side panel for node details
import * as state from './state';
import { highlightEdge } from './edges';

declare const d3: any;

export function openPanel(nodeData: any): void {
    const { vscode, currentGraphData, workflowGroups } = state;

    const panel = document.getElementById('sidePanel');
    const title = document.getElementById('panelTitle');
    const type = document.getElementById('panelType');
    const descriptionSection = document.getElementById('descriptionSection');
    const description = document.getElementById('panelDescription');
    const sourceSection = document.getElementById('sourceSection');
    const source = document.getElementById('panelSource');
    const incomingSection = document.getElementById('incomingSection');
    const incoming = document.getElementById('panelIncoming');
    const outgoingSection = document.getElementById('outgoingSection');
    const outgoing = document.getElementById('panelOutgoing');

    if (!panel || !title || !type || !sourceSection || !source || !descriptionSection || !description || !incomingSection || !incoming || !outgoingSection || !outgoing) {
        return;
    }

    title.textContent = nodeData.label;

    // Check if node is a shared copy (has _originalId from node duplication)
    const isSharedCopy = nodeData._originalId != null;
    const originalId = isSharedCopy ? nodeData._originalId : nodeData.id;

    // Set workflow name(s)
    const workflowEl = document.getElementById('panelWorkflow');
    if (workflowEl) {
        if (isSharedCopy && nodeData._workflowId) {
            // For shared copy, show which workflow this copy belongs to, plus others
            const thisWorkflow = workflowGroups?.find((g: any) => g.id === nodeData._workflowId);
            const otherWorkflows = workflowGroups?.filter(
                (g: any) => g.nodes.includes(originalId) && g.id !== nodeData._workflowId
            ) || [];

            let workflowHtml = thisWorkflow ? `<strong>${thisWorkflow.name}</strong> (this copy)` : '';
            if (otherWorkflows.length > 0) {
                workflowHtml += '<br>' + otherWorkflows.map((w: any) => w.name).join('<br>');
            }
            workflowEl.innerHTML = workflowHtml;
            workflowEl.style.display = 'block';
        } else {
            // For non-shared nodes, show the workflow
            const workflows = workflowGroups?.filter(
                (g: any) => g.nodes.includes(nodeData.id)
            ) || [];
            if (workflows.length > 0) {
                workflowEl.innerHTML = workflows.map((w: any) => w.name).join('<br>');
                workflowEl.style.display = 'block';
            } else {
                workflowEl.style.display = 'none';
            }
        }
    }

    // Add type badge with optional SHARED tag
    type.textContent = nodeData.type;
    type.className = `type-badge ${nodeData.type}`;

    // Clean up any existing shared tag first
    const existingTag = type.parentElement?.querySelector('.shared-tag');
    if (existingTag) existingTag.remove();

    if (isSharedCopy) {
        type.insertAdjacentHTML('afterend', '<span class="shared-tag" style="display: inline-block; margin-left: 8px; padding: 4px 8px; border-radius: 12px; font-size: 10px; font-weight: 600; background: rgba(255,255,255,0.1); color: var(--vscode-descriptionForeground); text-transform: uppercase; letter-spacing: 0.5px;">Shared</span>');
    }

    if (nodeData.description) {
        description.textContent = nodeData.description;
        descriptionSection.style.display = 'block';
    } else {
        descriptionSection.style.display = 'none';
    }

    if (nodeData.source) {
        const fileName = nodeData.source.file.split('/').pop();
        const funcName = nodeData.source.function.endsWith('()') ? nodeData.source.function : `${nodeData.source.function}()`;
        source.textContent = `${funcName} in ${fileName}:${nodeData.source.line}`;
        (source as HTMLAnchorElement).onclick = (e: Event) => {
            e.preventDefault();
            vscode.postMessage({
                command: 'openFile',
                file: nodeData.source.file,
                line: nodeData.source.line
            });
        };
        sourceSection.style.display = 'block';
    } else {
        sourceSection.style.display = 'none';
    }

    // Find incoming edges (use original ID for lookup since edges use original IDs)
    const nodeWorkflowId = nodeData._workflowId;
    const incomingEdges = currentGraphData.edges.filter((e: any) => {
        if (e.target !== originalId) return false;
        // For shared nodes, only show edges within this workflow
        if (nodeWorkflowId) {
            const workflow = workflowGroups?.find((g: any) => g.id === nodeWorkflowId);
            if (workflow && !workflow.nodes.includes(e.source)) return false;
        }
        return currentGraphData.nodes.some((n: any) => n.id === e.source);
    });

    if (incomingEdges.length > 0) {
        // Group edges by source node (for decision nodes with multiple branches)
        const edgesBySource = new Map<string, any[]>();
        incomingEdges.forEach((edge: any) => {
            const existing = edgesBySource.get(edge.source) || [];
            existing.push(edge);
            edgesBySource.set(edge.source, existing);
        });

        incoming.innerHTML = Array.from(edgesBySource.entries()).map(([sourceId, edges]) => {
            const sourceNode = currentGraphData.nodes.find((n: any) => n.id === sourceId);
            const sourceLabel = sourceNode ? sourceNode.label : sourceId;
            const sourceType = sourceNode?.type || 'step';
            const isDecision = sourceType === 'decision';

            if (isDecision && edges.length > 0) {
                // Decision node: show node with branches listed below
                const branchesHtml = edges.map((edge: any) =>
                    `<div class="edge-item-branch" data-source-id="${sourceId}" data-target-id="${originalId}" style="display: flex; align-items: center; gap: 6px; padding: 4px 0 4px 24px; cursor: pointer;">
                        <span style="color: var(--vscode-descriptionForeground);">→</span>
                        <span style="font-size: 10px; padding: 2px 6px; background: #7c3aed; color: white; border-radius: 3px;">${edge.label || 'branch'}</span>
                    </div>`
                ).join('');

                return `<div class="edge-item" data-node-id="${sourceId}" style="margin: 8px 0; padding: 8px; background: var(--vscode-input-background); border-radius: 4px; cursor: pointer; transition: background 0.15s;">
                    <div style="display: flex; align-items: center; gap: 8px;">
                        <span class="type-badge ${sourceType}" style="font-size: 9px; padding: 2px 6px;">${sourceType}</span>
                        <span style="font-size: 12px; font-weight: 500;">${sourceLabel}?</span>
                    </div>
                    ${branchesHtml}
                </div>`;
            } else {
                // Regular node: single entry per edge
                return edges.map((edge: any) =>
                    `<div class="edge-item" data-source-id="${sourceId}" data-target-id="${originalId}" data-node-id="${sourceId}" style="margin: 8px 0; padding: 8px; background: var(--vscode-input-background); border-radius: 4px; cursor: pointer; transition: background 0.15s;">
                        <div style="display: flex; align-items: center; gap: 8px;">
                            <span class="type-badge ${sourceType}" style="font-size: 9px; padding: 2px 6px;">${sourceType}</span>
                            <span style="font-size: 12px; font-weight: 500;">${sourceLabel}</span>
                        </div>
                    </div>`
                ).join('');
            }
        }).join('');

        incomingSection.style.display = 'block';
    } else {
        incomingSection.style.display = 'none';
    }

    // Find outgoing edges (use original ID for lookup since edges use original IDs)
    const outgoingEdges = currentGraphData.edges.filter((e: any) => {
        if (e.source !== originalId) return false;
        // For shared nodes, only show edges within this workflow
        if (nodeWorkflowId) {
            const workflow = workflowGroups?.find((g: any) => g.id === nodeWorkflowId);
            if (workflow && !workflow.nodes.includes(e.target)) return false;
        }
        return currentGraphData.nodes.some((n: any) => n.id === e.target);
    });

    if (outgoingEdges.length > 0) {
        // Check if current node is a decision (branches should be grouped)
        const isCurrentNodeDecision = nodeData.type === 'decision';
        const hasLabeledEdges = outgoingEdges.some((e: any) => e.label);

        if (isCurrentNodeDecision && hasLabeledEdges) {
            // Decision node: show branches grouped
            outgoing.innerHTML = `<div style="margin: 8px 0; padding: 8px; background: var(--vscode-input-background); border-radius: 4px;">
                ${outgoingEdges.map((edge: any) => {
                    const targetNode = currentGraphData.nodes.find((n: any) => n.id === edge.target);
                    const targetLabel = targetNode ? targetNode.label : edge.target;
                    const targetType = targetNode?.type || 'step';
                    return `<div class="edge-item" data-source-id="${originalId}" data-target-id="${edge.target}" data-node-id="${edge.target}" style="display: flex; align-items: center; gap: 6px; padding: 4px 0; cursor: pointer;">
                        <span style="font-size: 10px; padding: 2px 6px; background: #7c3aed; color: white; border-radius: 3px;">${edge.label || 'branch'}</span>
                        <span style="color: var(--vscode-descriptionForeground);">→</span>
                        <span class="type-badge ${targetType}" style="font-size: 9px; padding: 2px 6px;">${targetType}</span>
                        <span style="font-size: 12px;">${targetLabel}</span>
                    </div>`;
                }).join('')}
            </div>`;
        } else {
            // Regular nodes: one entry per edge
            outgoing.innerHTML = outgoingEdges.map((edge: any) => {
                const targetNode = currentGraphData.nodes.find((n: any) => n.id === edge.target);
                const targetLabel = targetNode ? targetNode.label : edge.target;
                const targetType = targetNode?.type || 'step';
                return `<div class="edge-item" data-source-id="${originalId}" data-target-id="${edge.target}" data-node-id="${edge.target}" style="margin: 8px 0; padding: 8px; background: var(--vscode-input-background); border-radius: 4px; cursor: pointer; transition: background 0.15s;">
                    <div style="display: flex; align-items: center; gap: 8px;">
                        <span class="type-badge ${targetType}" style="font-size: 9px; padding: 2px 6px;">${targetType}</span>
                        <span style="font-size: 12px; font-weight: 500;">${targetLabel}</span>
                    </div>
                </div>`;
            }).join('');
        }

        outgoingSection.style.display = 'block';
    } else {
        outgoingSection.style.display = 'none';
    }

    panel.classList.add('open');

    // Set up edge item interactions (hover highlight + click navigation)
    setupEdgeItemInteractions();

    // Track currently open node
    state.setCurrentlyOpenNodeId(nodeData.id);

    // Notify extension
    vscode.postMessage({
        command: 'nodeSelected',
        nodeId: nodeData.id,
        nodeLabel: nodeData.label,
        nodeType: nodeData.type
    });

    // Show selection indicator
    d3.selectAll('.node-selection-indicator').style('display', 'none');
    d3.select(`.node-selection-indicator[data-node-id="${nodeData.id}"]`).style('display', 'block');
}

/**
 * Set up hover and click handlers on edge list items
 */
function setupEdgeItemInteractions(): void {
    // Handle main edge items (for navigation to node)
    document.querySelectorAll('.edge-item').forEach((item) => {
        const el = item as HTMLElement;
        const sourceId = el.dataset.sourceId;
        const targetId = el.dataset.targetId;
        const nodeId = el.dataset.nodeId;

        // Hover to highlight edge in the graph (only if this item has edge data)
        el.addEventListener('mouseenter', () => {
            if (sourceId && targetId) {
                highlightEdge(sourceId, targetId, true);
            }
            el.style.background = 'var(--vscode-list-hoverBackground)';
        });

        el.addEventListener('mouseleave', () => {
            if (sourceId && targetId) {
                highlightEdge(sourceId, targetId, false);
            }
            el.style.background = 'var(--vscode-input-background)';
        });

        // Click to navigate to the connected node
        el.addEventListener('click', (e) => {
            // Don't navigate if clicking on a branch item
            if ((e.target as HTMLElement).closest('.edge-item-branch')) return;
            if (nodeId) {
                navigateToNode(nodeId);
            }
        });
    });

    // Handle branch items inside decision groups (for edge highlighting)
    document.querySelectorAll('.edge-item-branch').forEach((item) => {
        const el = item as HTMLElement;
        const sourceId = el.dataset.sourceId;
        const targetId = el.dataset.targetId;
        const nodeId = el.dataset.nodeId;

        el.addEventListener('mouseenter', () => {
            if (sourceId && targetId) {
                highlightEdge(sourceId, targetId, true);
            }
            el.style.background = 'var(--vscode-list-hoverBackground)';
        });

        el.addEventListener('mouseleave', () => {
            if (sourceId && targetId) {
                highlightEdge(sourceId, targetId, false);
            }
            el.style.background = 'transparent';
        });

        el.addEventListener('click', (e) => {
            e.stopPropagation();
            if (nodeId) {
                navigateToNode(nodeId);
            }
        });
    });
}

/**
 * Navigate to a node: pan to center it and open its panel
 */
function navigateToNode(nodeId: string): void {
    const { currentGraphData, svg, zoom, expandedNodes } = state;

    // Find the node data
    const node = currentGraphData.nodes.find((n: any) => n.id === nodeId);
    if (!node) return;

    // Find the node's position from expanded nodes (which have layout positions)
    const expandedNode = expandedNodes.find((n: any) => {
        const origId = n._originalId || n.id;
        return origId === nodeId;
    });

    if (expandedNode && expandedNode.x !== undefined && expandedNode.y !== undefined) {
        // Get SVG dimensions
        const svgNode = svg.node();
        const width = svgNode.clientWidth;
        const height = svgNode.clientHeight;

        // Calculate transform to center on the node
        const scale = 1;  // Keep current scale or use 1 for default
        const x = width / 2 - expandedNode.x * scale;
        const y = height / 2 - expandedNode.y * scale;

        // Animate to the node position
        svg.transition()
            .duration(500)
            .call(zoom.transform, d3.zoomIdentity.translate(x, y).scale(scale));
    }

    // Open the panel for this node (use the node data with potential virtual copy info)
    const nodeToOpen = expandedNode || node;
    openPanel(nodeToOpen);
}

export function closePanel(): void {
    const { vscode } = state;
    const panel = document.getElementById('sidePanel');
    if (panel) panel.classList.remove('open');

    state.setCurrentlyOpenNodeId(null);

    vscode.postMessage({ command: 'nodeDeselected' });

    d3.selectAll('.node-selection-indicator').style('display', 'none');
}

export function setupClosePanel(): void {
    document.getElementById('btn-close-panel')?.addEventListener('click', closePanel);
}
