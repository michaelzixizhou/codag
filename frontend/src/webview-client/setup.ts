// SVG setup, defs, patterns, zoom behavior
import * as state from './state';

declare const d3: any;

export function setupSVG(): { svg: any; g: any; zoom: any; defs: any } {
    const container = document.getElementById('graph');
    if (!container) throw new Error('Graph container not found');

    const svg = d3.select('#graph')
        .append('svg')
        .attr('width', '100%')
        .attr('height', '100%');

    // Create defs for patterns and markers
    const defs = svg.append('defs');

    // Fine pegboard dot pattern - 5px grid for normal zoom
    const finePattern = defs.append('pattern')
        .attr('id', 'pegboard-fine')
        .attr('x', 0)
        .attr('y', 0)
        .attr('width', 5)
        .attr('height', 5)
        .attr('patternUnits', 'userSpaceOnUse');

    finePattern.append('circle')
        .attr('id', 'pegboard-fine-dot')
        .attr('cx', 2.5)
        .attr('cy', 2.5)
        .attr('r', 0.5)
        .attr('fill', 'var(--vscode-editor-foreground)')
        .attr('opacity', 0.15);

    // Coarse pegboard dot pattern - 20px grid for zoomed out view
    const coarsePattern = defs.append('pattern')
        .attr('id', 'pegboard-coarse')
        .attr('x', 0)
        .attr('y', 0)
        .attr('width', 20)
        .attr('height', 20)
        .attr('patternUnits', 'userSpaceOnUse');

    coarsePattern.append('circle')
        .attr('id', 'pegboard-coarse-dot')
        .attr('cx', 10)
        .attr('cy', 10)
        .attr('r', 1)
        .attr('fill', 'var(--vscode-editor-foreground)')
        .attr('opacity', 0.15);

    // Main group for all graph elements (zoomable, includes pegboard)
    const g = svg.append('g');

    // Add pegboard background inside transform group
    const pegboardBg = g.append('rect')
        .attr('x', -50000)
        .attr('y', -50000)
        .attr('width', 100000)
        .attr('height', 100000)
        .attr('fill', 'url(#pegboard-fine)')
        .attr('class', 'pegboard-bg')
        .lower();

    // Cache pegboard dot selections for performance
    const finePatternDot = d3.select('#pegboard-fine-dot');
    const coarsePatternDot = d3.select('#pegboard-coarse-dot');

    // Store pattern dots in state
    state.setPatternDots(finePatternDot, coarsePatternDot, pegboardBg);

    // Track zoom zone to avoid unnecessary updates
    let lastZoomZone: 'fine' | 'coarse' = 'fine';

    // Create zoom behavior
    const zoom = d3.zoom()
        .scaleExtent([0.1, 10])
        .on('zoom', (event: any) => {
            g.attr('transform', event.transform);

            // Only update pattern when crossing threshold (not every frame)
            const k = event.transform.k;
            const newZone: 'fine' | 'coarse' = k < 0.5 ? 'coarse' : 'fine';

            if (newZone !== lastZoomZone) {
                lastZoomZone = newZone;
                const opacity = Math.min(0.15, Math.max(0.02, 0.15 * k));

                if (newZone === 'coarse') {
                    pegboardBg.attr('fill', 'url(#pegboard-coarse)');
                    coarsePatternDot.attr('opacity', opacity);
                } else {
                    pegboardBg.attr('fill', 'url(#pegboard-fine)');
                    finePatternDot.attr('opacity', opacity);
                }
            }
        });

    svg.call(zoom).on('dblclick.zoom', null);

    // Arrow markers (30% smaller)
    defs.append('marker')
        .attr('id', 'arrowhead')
        .attr('viewBox', '-0 -5 10 10')
        .attr('refX', 0)
        .attr('refY', 0)
        .attr('orient', 'auto')
        .attr('markerWidth', 2.8)
        .attr('markerHeight', 2.8)
        .append('path')
        .attr('d', 'M 0,-5 L 10,0 L 0,5')
        .attr('fill', 'currentColor')
        .style('fill', 'var(--vscode-editor-foreground)');

    // Reverse arrow marker for bidirectional edges (points toward source)
    defs.append('marker')
        .attr('id', 'arrowhead-start')
        .attr('viewBox', '-10 -5 10 10')
        .attr('refX', 0)
        .attr('refY', 0)
        .attr('orient', 'auto')
        .attr('markerWidth', 2.8)
        .attr('markerHeight', 2.8)
        .append('path')
        .attr('d', 'M 0,-5 L -10,0 L 0,5')
        .attr('fill', 'currentColor')
        .style('fill', 'var(--vscode-editor-foreground)');

    return { svg, g, zoom, defs };
}

export function createWorkflowPattern(defs: any, groupId: string, color: string): void {
    const colorPattern = defs.append('pattern')
        .attr('id', `pegboard-${groupId}`)
        .attr('x', 0)
        .attr('y', 0)
        .attr('width', 10)
        .attr('height', 10)
        .attr('patternUnits', 'userSpaceOnUse');

    colorPattern.append('circle')
        .attr('cx', 5)
        .attr('cy', 5)
        .attr('r', 1)
        .attr('fill', color)
        .attr('opacity', 0.25);
}
