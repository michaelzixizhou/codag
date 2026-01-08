// Group visibility management
import * as state from './state';
import { generateEdgePath, getNodeOrCollapsedGroup } from './utils';
import { getNodeDimensions, areNodesInSameCollapsedGroup } from './helpers';
import { populateDirectory } from './directory';
import { getExpandedNodes, renderEdges } from './edges';
import { layoutWorkflows } from './layout';
import { renderNodes } from './nodes';
import { renderGroups, renderCollapsedGroups } from './groups';
import { renderCollapsedComponents } from './components';
import { dragstarted, dragged, dragended } from './drag';
import { renderMinimap } from './minimap';

declare const d3: any;
declare const dagre: any;

export function updateGroupVisibility(): void {
    const {
        groupElements,
        collapsedGroups,
        node,
        linkGroup,
        link,
        linkHover,
        workflowGroups,
        currentGraphData,
        vscode
    } = state;

    // Update Level 1 group backgrounds
    groupElements.select('.group-background')
        .style('opacity', (d: any) => d.collapsed ? 0 : 1);

    // Update Level 1 expanded title
    groupElements.select('.group-title-expanded')
        .style('display', (d: any) => d.collapsed ? 'none' : 'block');

    // Update Level 1 collapse button
    groupElements.select('.group-collapse-btn')
        .style('display', (d: any) => d.collapsed ? 'none' : 'block');

    // Show/hide collapsed groups
    collapsedGroups.style('display', (d: any) => d.collapsed ? 'block' : 'none');

    // Hide nodes that are in collapsed groups
    node.style('display', (d: any) => {
        const nodeId = d._originalId || d.id;
        const nodeWorkflowId = d._workflowId;
        const inCollapsedGroup = workflowGroups.some((g: any) =>
            g.collapsed && g.nodes.includes(nodeId) &&
            (nodeWorkflowId ? g.id === nodeWorkflowId : true)
        );
        return inCollapsedGroup ? 'none' : 'block';
    });

    // Show all edges, but route them to collapsed groups when needed
    linkGroup.style('display', 'block');

    // Update edge paths to route to collapsed groups
    const expandedNodes = getExpandedNodes();
    const getNode = (nodeId: string) => {
        // Check expanded nodes first (for virtual IDs)
        const expanded = expandedNodes.find((n: any) => n.id === nodeId);
        if (expanded) return expanded;
        return getNodeOrCollapsedGroup(nodeId, currentGraphData.nodes, workflowGroups);
    };

    link.attr('d', function(this: SVGPathElement, l: any) {
        const sourceNode = getNode(l.source);
        const targetNode = getNode(l.target);

        // Skip if nodes not found
        if (!sourceNode || !targetNode) return '';

        // Check if both nodes are in the same collapsed group
        if (areNodesInSameCollapsedGroup(l.source, l.target, workflowGroups)) {
            // Internal edge - hide it
            d3.select(this.parentNode).style('display', 'none');
            return '';
        }

        // Edge crosses group boundaries - show it
        d3.select(this.parentNode).style('display', 'block');

        const { width: targetWidth, height: targetHeight } = getNodeDimensions(targetNode);
        const { width: sourceWidth, height: sourceHeight } = getNodeDimensions(sourceNode);

        return generateEdgePath(l, sourceNode, targetNode, workflowGroups, targetWidth, targetHeight, sourceWidth, sourceHeight, currentGraphData.edges);
    });

    linkHover.attr('d', function(this: SVGPathElement, l: any) {
        const sourceNode = getNode(l.source);
        const targetNode = getNode(l.target);

        if (!sourceNode || !targetNode) return '';

        // Check if both nodes are in the same collapsed group
        if (areNodesInSameCollapsedGroup(l.source, l.target, workflowGroups)) {
            return '';
        }

        const { width: targetWidth, height: targetHeight } = getNodeDimensions(targetNode);
        const { width: sourceWidth, height: sourceHeight } = getNodeDimensions(sourceNode);

        return generateEdgePath(l, sourceNode, targetNode, workflowGroups, targetWidth, targetHeight, sourceWidth, sourceHeight, currentGraphData.edges);
    });

    // Notify extension of workflow visibility state
    const expandedWorkflowIds = workflowGroups
        .filter((g: any) => !g.collapsed && g.id !== 'group_orphans')
        .map((g: any) => g.name);

    vscode.postMessage({
        command: 'workflowVisibilityChanged',
        expandedWorkflowIds: expandedWorkflowIds
    });

    // Update workflow directory
    populateDirectory();
}

/**
 * Update visibility when components are expanded/collapsed.
 * This requires a full re-layout since component expansion changes node positions.
 */
export function updateComponentVisibility(): void {
    const { g, svg } = state;

    // Remove existing rendered elements (except SVG defs)
    g.selectAll('.groups').remove();
    g.selectAll('.edge-paths-container').remove();
    g.selectAll('.edge-labels-container').remove();
    g.selectAll('.nodes-container').remove();
    g.selectAll('.collapsed-groups').remove();
    g.selectAll('.collapsed-components').remove();
    g.selectAll('.shared-arrows-container').remove();

    // Get defs element for patterns
    const defs = svg.select('defs');

    // Re-layout with new component state
    layoutWorkflows(defs);

    // Re-render everything
    renderGroups(updateGroupVisibility);
    renderEdges();
    renderNodes(dragstarted, dragged, dragended);
    renderCollapsedGroups(updateGroupVisibility);
    renderCollapsedComponents(updateComponentVisibility);

    // Update minimap
    renderMinimap();

    // Update directory
    populateDirectory();
}
