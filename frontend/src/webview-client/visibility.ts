// Group visibility management
import * as state from './state';
import { populateDirectory } from './directory';
import { renderEdges } from './edges';
import { layoutWorkflows } from './layout';
import { renderNodes } from './nodes';
import { renderGroups } from './groups';
import { renderCollapsedComponents } from './components';
import { dragstarted, dragged, dragended } from './drag';
import { renderMinimap } from './minimap';

declare const d3: any;

export function updateGroupVisibility(): void {
    // Groups no longer collapse - this function is kept for API compatibility
    // Just update the directory
    populateDirectory();
}

/**
 * Update visibility when components are expanded/collapsed.
 * This requires a full re-layout since component expansion changes node positions.
 */
export async function updateComponentVisibility(): Promise<void> {
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
    await layoutWorkflows(defs);

    // Re-render everything
    renderGroups();
    renderEdges();
    renderNodes(dragstarted, dragged, dragended);
    renderCollapsedComponents(updateComponentVisibility);

    // Update minimap
    renderMinimap();

    // Update directory
    populateDirectory();
}
