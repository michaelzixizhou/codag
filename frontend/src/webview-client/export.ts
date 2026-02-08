// PNG Export functionality for workflow graphs
import * as state from './state';

declare const d3: any;

// Export padding around the content
const EXPORT_PADDING = 40;

// Max canvas dimension (browser limit)
const MAX_CANVAS_DIM = 16384;

// Resolution options for export
const RESOLUTION_OPTIONS = [
    { label: '200%', scale: 2 },
    { label: '150%', scale: 1.5 },
    { label: '100%', scale: 1 },
    { label: '75%', scale: 0.75 },
    { label: '50%', scale: 0.5 },
    { label: '30%', scale: 0.3 },
];

// Computed style cache for CSS variable resolution
let computedStyles: CSSStyleDeclaration | null = null;

function getComputedStyles(): CSSStyleDeclaration {
    if (!computedStyles) {
        computedStyles = getComputedStyle(document.documentElement);
    }
    return computedStyles;
}

function resolveCSSVariable(value: string): string {
    if (!value.startsWith('var(')) return value;

    const varName = value.match(/var\((--[^,)]+)/)?.[1];
    if (!varName) return value;

    const resolved = getComputedStyles().getPropertyValue(varName).trim();
    return resolved || value;
}

/**
 * Get bounds for all content or a specific workflow group
 */
function getExportBounds(groupId?: string): { minX: number; minY: number; maxX: number; maxY: number } | null {
    const { currentGraphData, workflowGroups } = state;

    if (groupId) {
        // Export specific workflow
        const group = workflowGroups.find((g: any) => g.id === groupId);
        if (!group || !group.bounds) return null;
        return {
            minX: group.bounds.minX - EXPORT_PADDING,
            minY: group.bounds.minY - EXPORT_PADDING,
            maxX: group.bounds.maxX + EXPORT_PADDING,
            maxY: group.bounds.maxY + EXPORT_PADDING
        };
    }

    // Export all content
    const nodesWithPositions = currentGraphData.nodes.filter((n: any) =>
        typeof n.x === 'number' && typeof n.y === 'number' && !isNaN(n.x) && !isNaN(n.y)
    );

    if (nodesWithPositions.length === 0) return null;

    // Calculate bounds from all nodes
    let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;

    nodesWithPositions.forEach((node: any) => {
        const halfWidth = (node.width || 200) / 2;
        const halfHeight = (node.height || 54) / 2;
        minX = Math.min(minX, node.x - halfWidth);
        maxX = Math.max(maxX, node.x + halfWidth);
        minY = Math.min(minY, node.y - halfHeight);
        maxY = Math.max(maxY, node.y + halfHeight);
    });

    return {
        minX: minX - EXPORT_PADDING,
        minY: minY - EXPORT_PADDING,
        maxX: maxX + EXPORT_PADDING,
        maxY: maxY + EXPORT_PADDING
    };
}

/**
 * Read computed style from a DOM element
 */
function getElementComputedStyle(selector: string, property: string): string {
    const el = document.querySelector(selector);
    if (!el) return '';
    return getComputedStyle(el).getPropertyValue(property);
}

/**
 * Extract text with explicit hyphens from a rendered element.
 * Detects where the browser hyphenated and inserts actual hyphen characters.
 * Returns array of lines with hyphens already included.
 */
function extractHyphenatedLines(element: HTMLElement): string[] {
    const textNode = element.firstChild;
    if (!textNode || textNode.nodeType !== Node.TEXT_NODE) {
        return [element.textContent || ''];
    }

    const text = textNode.textContent || '';
    if (!text) return [''];

    const range = document.createRange();
    const lines: string[] = [];
    let lastTop: number | null = null;
    let lineStart = 0;

    // Iterate through each character to find line breaks
    for (let i = 0; i <= text.length; i++) {
        if (i < text.length) {
            range.setStart(textNode, i);
            range.setEnd(textNode, i + 1);
            const rect = range.getBoundingClientRect();

            if (lastTop === null) {
                lastTop = rect.top;
            } else if (Math.abs(rect.top - lastTop) > 2) {
                // Line break detected
                const lineText = text.substring(lineStart, i);

                // Check if this is a hyphenated break (word split in middle)
                const charBeforeBreak = i > 0 ? text[i - 1] : '';
                const charAfterBreak = text[i] || '';
                const isHyphenatedBreak = /[a-zA-Z]/.test(charBeforeBreak) && /[a-zA-Z]/.test(charAfterBreak);

                if (isHyphenatedBreak) {
                    lines.push(lineText + '-');
                } else {
                    lines.push(lineText);
                }

                lineStart = i;
                lastTop = rect.top;
            }
        } else {
            const finalLine = text.substring(lineStart);
            if (finalLine) lines.push(finalLine);
        }
    }

    return lines.length > 0 ? lines : [text];
}

/**
 * Wrap text to fit within a given width using canvas measurement.
 * Used as fallback when DOM-based extraction fails (e.g., large zoomed-out graphs).
 */
function wrapTextToWidth(text: string, maxWidth: number, fontSize: number, fontWeight: string = '400'): string[] {
    const canvas = document.createElement('canvas');
    const ctx = canvas.getContext('2d');
    if (!ctx) return [text];

    ctx.font = `${fontWeight} ${fontSize}px "DM Sans", "Inter", "Segoe UI", -apple-system, sans-serif`;

    const words = text.split(/\s+/);
    const lines: string[] = [];
    let currentLine = '';

    for (const word of words) {
        const testLine = currentLine ? `${currentLine} ${word}` : word;
        const metrics = ctx.measureText(testLine);

        if (metrics.width > maxWidth && currentLine) {
            // Current line is full, start new line
            lines.push(currentLine);
            currentLine = word;
        } else {
            currentLine = testLine;
        }
    }

    // Add the last line
    if (currentLine) {
        lines.push(currentLine);
    }

    // If a single word is too long, we need to break it with hyphens
    const finalLines: string[] = [];
    for (const line of lines) {
        if (ctx.measureText(line).width > maxWidth && !line.includes(' ')) {
            // Single word that's too long - break it
            let remaining = line;
            while (remaining.length > 0) {
                let breakPoint = remaining.length;
                for (let i = 1; i <= remaining.length; i++) {
                    const segment = remaining.substring(0, i) + (i < remaining.length ? '-' : '');
                    if (ctx.measureText(segment).width > maxWidth && i > 1) {
                        breakPoint = i - 1;
                        break;
                    }
                }
                if (breakPoint < remaining.length) {
                    finalLines.push(remaining.substring(0, breakPoint) + '-');
                    remaining = remaining.substring(breakPoint);
                } else {
                    finalLines.push(remaining);
                    remaining = '';
                }
            }
        } else {
            finalLines.push(line);
        }
    }

    return finalLines.length > 0 ? finalLines : [text];
}

/**
 * Calculate text scale factor for large graphs
 * Scales down text when there are many nodes to keep export readable
 */
function calculateTextScale(nodeCount: number, width: number, height: number): number {
    // Base thresholds
    const IDEAL_AREA_PER_NODE = 40000; // ~200x200 pixels per node is comfortable
    const MIN_SCALE = 0.5;  // Don't go below 50% size
    const MAX_SCALE = 1.0;  // Never scale up

    const totalArea = width * height;
    const areaPerNode = totalArea / Math.max(nodeCount, 1);

    // If area per node is less than ideal, scale down
    if (areaPerNode >= IDEAL_AREA_PER_NODE) {
        return MAX_SCALE;
    }

    // Scale proportionally to sqrt of ratio (gentler scaling)
    const ratio = areaPerNode / IDEAL_AREA_PER_NODE;
    const scale = Math.sqrt(ratio);

    return Math.max(MIN_SCALE, Math.min(MAX_SCALE, scale));
}

/**
 * Build SVG for export from scratch, reading positions from DOM
 */
function prepareSVGForExport(bounds: { minX: number; minY: number; maxX: number; maxY: number }, groupId?: string): SVGSVGElement {
    const { workflowGroups, currentGraphData } = state;

    const width = bounds.maxX - bounds.minX;
    const contentHeight = bounds.maxY - bounds.minY;

    // Calculate badge scale early so we can size the badge area correctly
    const BASE_WIDTH = 1200;  // Reference width for base sizing
    const badgeScale = Math.max(0.8, Math.min(2.5, width / BASE_WIDTH));  // Clamp between 0.8x and 2.5x
    const badgeAreaHeight = (16 + 48 + 16) * badgeScale; // Space for badge (margin + height + margin)
    const totalHeight = contentHeight + badgeAreaHeight;

    // Calculate text scale for large graphs
    const visibleNodeCount = groupId
        ? (workflowGroups.find((g: any) => g.id === groupId)?.nodes.length || 0)
        : currentGraphData.nodes.filter((n: any) => n.type !== 'workflow-title').length;
    const textScale = calculateTextScale(visibleNodeCount, width, contentHeight);

    // Resolve common colors once
    const bgColor = resolveCSSVariable('var(--vscode-editor-background)') || '#1e1e1e';
    const fgColor = resolveCSSVariable('var(--vscode-editor-foreground)') || '#cccccc';
    const borderColor = resolveCSSVariable('var(--vscode-editorWidget-border)') || '#454545';
    const descriptionFgColor = resolveCSSVariable('var(--vscode-descriptionForeground)') || '#858585';

    // Create SVG with extra height for footer
    const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
    svg.setAttribute('xmlns', 'http://www.w3.org/2000/svg');
    svg.setAttribute('width', String(width));
    svg.setAttribute('height', String(totalHeight));
    svg.setAttribute('viewBox', `${bounds.minX} ${bounds.minY} ${width} ${totalHeight}`);

    // Defs with arrow marker - match webview exactly (setup.ts)
    const defs = document.createElementNS('http://www.w3.org/2000/svg', 'defs');
    const marker = document.createElementNS('http://www.w3.org/2000/svg', 'marker');
    marker.setAttribute('id', 'arrow');
    marker.setAttribute('viewBox', '-0 -5 10 10');
    marker.setAttribute('refX', '0');
    marker.setAttribute('refY', '0');
    marker.setAttribute('orient', 'auto');
    marker.setAttribute('markerWidth', '2.25');
    marker.setAttribute('markerHeight', '2.25');
    const arrowPath = document.createElementNS('http://www.w3.org/2000/svg', 'path');
    arrowPath.setAttribute('d', 'M 0,-5 L 10,0 L 0,5');
    arrowPath.setAttribute('fill', fgColor);
    marker.appendChild(arrowPath);
    defs.appendChild(marker);
    svg.appendChild(defs);

    const mainGroup = document.createElementNS('http://www.w3.org/2000/svg', 'g');

    // Filter nodes
    let nodesToExport: Set<string> | null = null;
    if (groupId) {
        const group = workflowGroups.find((g: any) => g.id === groupId);
        if (group) nodesToExport = new Set(group.nodes);
    }

    // 1. Draw workflow group backgrounds
    workflowGroups.forEach((group: any) => {
        if (!group.bounds || group.nodes.length < 3) return;
        if (group.id === 'group_orphans') return;
        if (groupId && group.id !== groupId) return;

        const rect = document.createElementNS('http://www.w3.org/2000/svg', 'rect');
        rect.setAttribute('x', String(group.bounds.minX));
        rect.setAttribute('y', String(group.bounds.minY));
        rect.setAttribute('width', String(group.bounds.maxX - group.bounds.minX));
        rect.setAttribute('height', String(group.bounds.maxY - group.bounds.minY));
        rect.setAttribute('rx', '12');
        rect.setAttribute('fill', group.color);
        rect.setAttribute('fill-opacity', '0.08');
        rect.setAttribute('stroke', group.color);
        rect.setAttribute('stroke-opacity', '0.5');
        rect.setAttribute('stroke-width', '1.5');
        mainGroup.appendChild(rect);
    });

    // 2. Draw edges - read path data from DOM
    document.querySelectorAll('.link').forEach(linkEl => {
        const linkData = d3.select(linkEl).datum() as any;
        if (!linkData) return;
        if (nodesToExport && (!nodesToExport.has(linkData.source) || !nodesToExport.has(linkData.target))) return;

        const pathD = linkEl.getAttribute('d');
        if (!pathD) return;

        const path = document.createElementNS('http://www.w3.org/2000/svg', 'path');
        path.setAttribute('d', pathD);
        path.setAttribute('fill', 'none');
        path.setAttribute('stroke', fgColor);
        path.setAttribute('stroke-opacity', '0.5');
        path.setAttribute('stroke-width', '2.5');
        path.setAttribute('marker-end', 'url(#arrow)');
        mainGroup.appendChild(path);
    });

    // 3. Draw edge labels - read position from DOM
    // Correct selector is '.edge-label' not '.edge-label-group'
    document.querySelectorAll('.edge-label').forEach(labelEl => {
        const labelData = d3.select(labelEl).datum() as any;
        if (!labelData) return;
        if (nodesToExport && (!nodesToExport.has(labelData.source) || !nodesToExport.has(labelData.target))) return;

        // Check computed visibility
        const computedDisplay = getComputedStyle(labelEl).display;
        if (computedDisplay === 'none') return;

        const transform = labelEl.getAttribute('transform');
        const textEl = labelEl.querySelector('.edge-label-text');
        const textContent = textEl?.textContent;
        if (!transform || !textContent) return;

        const g = document.createElementNS('http://www.w3.org/2000/svg', 'g');
        g.setAttribute('transform', transform);

        // Get actual text width from DOM for accurate sizing, apply scale
        const bgEl = labelEl.querySelector('.edge-label-bg') as SVGRectElement;
        const baseRectWidth = bgEl ? parseFloat(bgEl.getAttribute('width') || '0') : textContent.length * 7 + 16;
        const baseRectHeight = bgEl ? parseFloat(bgEl.getAttribute('height') || '0') : 20;
        const rectWidth = baseRectWidth * textScale;
        const rectHeight = baseRectHeight * textScale;
        const rectX = -rectWidth / 2;
        const rectY = -rectHeight / 2;
        const edgeFontSize = 11 * textScale;

        // Background pill
        const rect = document.createElementNS('http://www.w3.org/2000/svg', 'rect');
        rect.setAttribute('x', String(rectX));
        rect.setAttribute('y', String(rectY));
        rect.setAttribute('width', String(rectWidth));
        rect.setAttribute('height', String(rectHeight));
        rect.setAttribute('rx', String(3 * textScale));
        rect.setAttribute('fill', bgColor);
        rect.setAttribute('stroke', borderColor);
        rect.setAttribute('stroke-width', '1');
        g.appendChild(rect);

        // Text
        const text = document.createElementNS('http://www.w3.org/2000/svg', 'text');
        text.setAttribute('text-anchor', 'middle');
        text.setAttribute('dominant-baseline', 'middle');
        text.setAttribute('fill', fgColor);
        text.setAttribute('font-family', '"DM Sans", "Inter", "Segoe UI", sans-serif');
        text.setAttribute('font-size', `${edgeFontSize}px`);
        text.textContent = textContent;
        g.appendChild(text);

        mainGroup.appendChild(g);
    });

    // Helper to generate workflow title color (same as nodes.ts)
    const colorFromString = (str: string, saturation: number = 70, lightness: number = 60): string => {
        let hash = 0;
        for (let i = 0; i < str.length; i++) {
            hash = str.charCodeAt(i) + ((hash << 5) - hash);
        }
        const hue = Math.abs(hash) % 360;
        return `hsl(${hue}, ${saturation}%, ${lightness}%)`;
    };

    // 4. Draw nodes - use explicit colors matching webview rendering
    document.querySelectorAll('.node').forEach(nodeEl => {
        const nodeId = nodeEl.getAttribute('data-node-id');
        if (!nodeId) return;
        if (nodesToExport && !nodesToExport.has(nodeId)) return;
        if ((nodeEl as SVGElement).style.display === 'none') return;

        const transform = nodeEl.getAttribute('transform');
        if (!transform) return;

        // Get node data
        const nodeData = currentGraphData.nodes.find((n: any) => n.id === nodeId);
        if (!nodeData) return;

        // Read actual dimensions from DOM (more accurate than nodeData)
        const rectEl = nodeEl.querySelector('rect');
        const pathEl = nodeEl.querySelector('path');
        let w: number, h: number;

        if (rectEl) {
            w = parseFloat(rectEl.getAttribute('width') || '0');
            h = parseFloat(rectEl.getAttribute('height') || '0');
        } else if (pathEl) {
            // For decision nodes (hexagon), get bounding box
            const bbox = (pathEl as SVGPathElement).getBBox();
            w = bbox.width;
            h = bbox.height;
        } else {
            w = nodeData.width || 200;
            h = nodeData.height || 54;
        }

        const g = document.createElementNS('http://www.w3.org/2000/svg', 'g');
        g.setAttribute('transform', transform);

        // Determine fill and text colors based on node type (matching nodes.ts exactly)
        let fillColor: string;
        let strokeColor: string;
        let textColor: string;

        if (nodeData.type === 'llm') {
            fillColor = '#1976D2';  // Blue for LLM nodes
            strokeColor = borderColor;
            textColor = '#ffffff';
        } else if (nodeData.type === 'workflow-title') {
            fillColor = colorFromString(nodeData.id.replace('__title_', ''), 65, 35);
            strokeColor = fillColor;
            textColor = '#ffffff';
        } else {
            fillColor = bgColor;  // Editor background for other nodes
            strokeColor = borderColor;
            textColor = fgColor;
        }

        if (nodeData.type === 'decision') {
            // Hexagon shape
            const indent = w * 0.1;
            const hexPath = `M ${-w/2 + indent} ${-h/2} L ${w/2 - indent} ${-h/2} L ${w/2} 0 L ${w/2 - indent} ${h/2} L ${-w/2 + indent} ${h/2} L ${-w/2} 0 Z`;

            const bg = document.createElementNS('http://www.w3.org/2000/svg', 'path');
            bg.setAttribute('d', hexPath);
            bg.setAttribute('fill', fillColor);
            g.appendChild(bg);

            const border = document.createElementNS('http://www.w3.org/2000/svg', 'path');
            border.setAttribute('d', hexPath);
            border.setAttribute('fill', 'none');
            border.setAttribute('stroke', descriptionFgColor);  // Match nodes.ts: uses descriptionForeground
            border.setAttribute('stroke-width', '2');
            g.appendChild(border);
        } else if (nodeData.type === 'workflow-title') {
            // Pill shape with colored fill
            const rect = document.createElementNS('http://www.w3.org/2000/svg', 'rect');
            rect.setAttribute('x', String(-w/2));
            rect.setAttribute('y', String(-h/2));
            rect.setAttribute('width', String(w));
            rect.setAttribute('height', String(h));
            rect.setAttribute('rx', String(h/2));
            rect.setAttribute('fill', fillColor);
            g.appendChild(rect);
        } else if (nodeData.type === 'reference') {
            // Reference node: purple border to indicate cross-workflow reference
            const rect = document.createElementNS('http://www.w3.org/2000/svg', 'rect');
            rect.setAttribute('x', String(-w/2));
            rect.setAttribute('y', String(-h/2));
            rect.setAttribute('width', String(w));
            rect.setAttribute('height', String(h));
            rect.setAttribute('rx', '4');
            rect.setAttribute('fill', fillColor);
            rect.setAttribute('stroke', '#7c3aed');
            rect.setAttribute('stroke-width', '2');
            g.appendChild(rect);
        } else {
            // Regular rectangle (step, llm, etc)
            const rect = document.createElementNS('http://www.w3.org/2000/svg', 'rect');
            rect.setAttribute('x', String(-w/2));
            rect.setAttribute('y', String(-h/2));
            rect.setAttribute('width', String(w));
            rect.setAttribute('height', String(h));
            rect.setAttribute('rx', '4');
            rect.setAttribute('fill', fillColor);
            rect.setAttribute('stroke', strokeColor);
            rect.setAttribute('stroke-width', '2');
            g.appendChild(rect);
        }

        // Text label - try DOM extraction first, fallback to canvas wrapping
        const labelSpan = nodeEl.querySelector('.node-title-wrapper span') as HTMLElement | null;
        const labelText = nodeData.label;

        if (labelText) {
            // Apply text scale for large graphs
            const baseFontSize = nodeData.type === 'workflow-title' ? 16 : 15;
            const fontSize = baseFontSize * textScale;
            const fontWeight = nodeData.type === 'workflow-title' ? '600' : '400';

            // Calculate available text width (node width minus padding)
            const textPadding = nodeData.type === 'workflow-title' ? 24 : 16;
            const availableWidth = w - textPadding;

            // Try DOM-based extraction first (more accurate for normal zoom levels)
            let lines: string[];
            if (labelSpan) {
                lines = extractHyphenatedLines(labelSpan);

                // Validate: if DOM returns single line but text is long, use canvas fallback
                // This handles large graphs where DOM might be zoomed out
                if (lines.length === 1 && labelText.length > 25) {
                    const canvas = document.createElement('canvas');
                    const ctx = canvas.getContext('2d');
                    if (ctx) {
                        ctx.font = `${fontWeight} ${fontSize}px "DM Sans", "Inter", "Segoe UI", -apple-system, sans-serif`;
                        const textWidth = ctx.measureText(labelText).width;
                        // If text would overflow, use canvas wrapping
                        if (textWidth > availableWidth * 1.1) {
                            lines = wrapTextToWidth(labelText, availableWidth, fontSize, fontWeight);
                        }
                    }
                }
            } else {
                // No DOM element, use canvas wrapping
                lines = wrapTextToWidth(labelText, availableWidth, fontSize, fontWeight);
            }

            // Create SVG text element
            const text = document.createElementNS('http://www.w3.org/2000/svg', 'text');
            text.setAttribute('text-anchor', 'middle');
            text.setAttribute('dominant-baseline', 'central');
            text.setAttribute('fill', textColor);
            text.setAttribute('font-family', '"DM Sans", "Inter", "Segoe UI", -apple-system, sans-serif');
            text.setAttribute('font-size', `${fontSize}px`);
            text.setAttribute('font-weight', fontWeight);
            text.setAttribute('letter-spacing', '-0.01em');

            // Calculate vertical positioning to center text block
            const lineHeight = fontSize * 1.2;
            const totalHeight = lines.length * lineHeight;
            const startY = -totalHeight / 2 + lineHeight / 2;

            lines.forEach((line, i) => {
                const tspan = document.createElementNS('http://www.w3.org/2000/svg', 'tspan');
                tspan.setAttribute('x', '0');
                tspan.setAttribute('dy', i === 0 ? String(startY) : String(lineHeight));
                tspan.textContent = line;
                text.appendChild(tspan);
            });

            g.appendChild(text);
        }

        mainGroup.appendChild(g);
    });

    svg.appendChild(mainGroup);

    // Add watermark badge with logo and codebase name (bottom left)
    // badgeScale already calculated at top of function for badge area sizing
    const badgeHeight = 48 * badgeScale;
    const badgePadding = 14 * badgeScale;
    const logoDisplayWidth = 120 * badgeScale;
    const logoDisplayHeight = 32 * badgeScale;
    const repoFontSize = 18 * badgeScale;
    const badgeMargin = 16 * badgeScale;
    const separatorRadius = 2.5 * badgeScale;
    const separatorGap = 8 * badgeScale;
    const textGap = 20 * badgeScale;
    const cornerRadius = 10 * badgeScale;
    const workspaceName = getWorkspaceName();

    // Calculate badge width based on content
    const canvas = document.createElement('canvas');
    const ctx = canvas.getContext('2d');
    let textWidth = 0;
    if (ctx && workspaceName) {
        ctx.font = `500 ${repoFontSize}px "DM Sans", "Inter", system-ui, sans-serif`;
        textWidth = ctx.measureText(workspaceName).width + 24 * badgeScale; // + separator space
    }
    const badgeWidth = logoDisplayWidth + textWidth + badgePadding * 2;

    const badgeX = bounds.minX + badgeMargin;
    const badgeY = bounds.maxY + badgeMargin;

    const badgeGroup = document.createElementNS('http://www.w3.org/2000/svg', 'g');
    badgeGroup.setAttribute('class', 'export-watermark');

    // Badge background (rounded rect)
    const badgeBg = document.createElementNS('http://www.w3.org/2000/svg', 'rect');
    badgeBg.setAttribute('x', String(badgeX));
    badgeBg.setAttribute('y', String(badgeY));
    badgeBg.setAttribute('width', String(badgeWidth));
    badgeBg.setAttribute('height', String(badgeHeight));
    badgeBg.setAttribute('rx', String(cornerRadius));
    badgeBg.setAttribute('fill', bgColor);
    badgeBg.setAttribute('stroke', borderColor);
    badgeBg.setAttribute('stroke-width', '1');
    badgeGroup.appendChild(badgeBg);

    // Codag logo - use nested SVG to preserve exact viewBox/aspect ratio
    const logoColor = '#8b5cf6'; // Purple
    const logoSvg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
    logoSvg.setAttribute('x', String(badgeX + badgePadding));
    logoSvg.setAttribute('y', String(badgeY + (badgeHeight - logoDisplayHeight) / 2));
    logoSvg.setAttribute('width', String(logoDisplayWidth));
    logoSvg.setAttribute('height', String(logoDisplayHeight));
    logoSvg.setAttribute('viewBox', '0 0 183.49 48.23');

    // Logo group with original transform
    const logoG = document.createElementNS('http://www.w3.org/2000/svg', 'g');
    logoG.setAttribute('transform', 'translate(-4.663,-100.212)');

    // Circle (bottom left of icon)
    const circle = document.createElementNS('http://www.w3.org/2000/svg', 'circle');
    circle.setAttribute('cx', '12.99');
    circle.setAttribute('cy', '136.378');
    circle.setAttribute('r', '8.327');
    circle.setAttribute('fill', logoColor);
    logoG.appendChild(circle);

    // Square with hole (top right of icon)
    const squarePath = document.createElementNS('http://www.w3.org/2000/svg', 'path');
    squarePath.setAttribute('d', 'm 23.349,100.212 c -1.885,0 -3.402,1.517 -3.402,3.402 v 22.413 c 0,1.885 1.517,3.402 3.402,3.402 h 22.413 c 1.885,0 3.402,-1.517 3.402,-3.402 v -22.413 c 0,-1.885 -1.517,-3.402 -3.402,-3.402 z m 11.303,6.391 a 8.327,8.327 0 0 1 8.327,8.327 8.327,8.327 0 0 1 -8.327,8.327 8.327,8.327 0 0 1 -8.327,-8.327 8.327,8.327 0 0 1 8.327,-8.327 z');
    squarePath.setAttribute('fill', logoColor);
    logoG.appendChild(squarePath);

    // Diagonal connector
    const diagonal = document.createElementNS('http://www.w3.org/2000/svg', 'path');
    diagonal.setAttribute('d', 'm 12.408,130.606 13.191,-13.191 6.269,6.4 -15.412,15.412 z');
    diagonal.setAttribute('fill', logoColor);
    logoG.appendChild(diagonal);

    // "codag" text with original transform
    const logoText = document.createElementNS('http://www.w3.org/2000/svg', 'text');
    logoText.setAttribute('x', '55.822');
    logoText.setAttribute('y', '131.091');
    logoText.setAttribute('transform', 'scale(0.944,1.059)');
    logoText.setAttribute('fill', fgColor);
    logoText.setAttribute('font-family', '"DM Sans", system-ui, sans-serif');
    logoText.setAttribute('font-size', '44px');
    logoText.setAttribute('font-weight', '700');
    logoText.textContent = 'codag';
    logoG.appendChild(logoText);

    logoSvg.appendChild(logoG);
    badgeGroup.appendChild(logoSvg);

    // Workspace name (inline after logo)
    if (workspaceName) {
        // Separator dot
        const separator = document.createElementNS('http://www.w3.org/2000/svg', 'circle');
        separator.setAttribute('cx', String(badgeX + badgePadding + logoDisplayWidth + separatorGap));
        separator.setAttribute('cy', String(badgeY + badgeHeight / 2));
        separator.setAttribute('r', String(separatorRadius));
        separator.setAttribute('fill', descriptionFgColor);
        badgeGroup.appendChild(separator);

        const nameText = document.createElementNS('http://www.w3.org/2000/svg', 'text');
        nameText.setAttribute('x', String(badgeX + badgePadding + logoDisplayWidth + textGap));
        nameText.setAttribute('y', String(badgeY + badgeHeight / 2));
        nameText.setAttribute('dominant-baseline', 'central');
        nameText.setAttribute('fill', descriptionFgColor);
        nameText.setAttribute('font-family', '"DM Sans", "Inter", system-ui, sans-serif');
        nameText.setAttribute('font-size', `${repoFontSize}px`);
        nameText.setAttribute('font-weight', '500');
        nameText.textContent = workspaceName;
        badgeGroup.appendChild(nameText);
    }

    svg.appendChild(badgeGroup);

    return svg;
}

/**
 * Get the current workspace/codebase name from state
 */
function getWorkspaceName(): string {
    return state.workspaceName || '';
}

type ImageFormat = 'png' | 'jpeg';

/**
 * Convert SVG to base64 image data (PNG or JPEG) using canvas
 * Returns base64-encoded image data (without data URL prefix)
 */
async function svgToBase64(svg: SVGSVGElement, format: ImageFormat, scale: number = 2): Promise<string> {
    const width = parseInt(svg.getAttribute('width') || '800');
    const height = parseInt(svg.getAttribute('height') || '600');

    // Serialize SVG to string
    const svgString = new XMLSerializer().serializeToString(svg);

    // Use base64 encoding instead of URL encoding
    const base64Svg = btoa(unescape(encodeURIComponent(svgString)));
    const svgDataUrl = `data:image/svg+xml;base64,${base64Svg}`;

    // Get background color for JPEG (JPEG doesn't support transparency)
    const bgColor = resolveCSSVariable('var(--vscode-editor-background)') || '#1e1e1e';

    return new Promise((resolve, reject) => {
        const img = new Image();
        img.crossOrigin = 'anonymous';

        img.onload = () => {
            // Create canvas after image loads
            const canvas = document.createElement('canvas');
            canvas.width = Math.round(width * scale);
            canvas.height = Math.round(height * scale);

            const ctx = canvas.getContext('2d', { willReadFrequently: true });
            if (!ctx) {
                reject(new Error('Could not get canvas context'));
                return;
            }

            // Scale for higher resolution
            ctx.scale(scale, scale);

            // For JPEG, fill background first (JPEG doesn't support transparency)
            if (format === 'jpeg') {
                ctx.fillStyle = bgColor;
                ctx.fillRect(0, 0, width, height);
            }

            // Draw the image
            ctx.drawImage(img, 0, 0, width, height);

            // Convert to data URL - more reliable than toBlob in webview contexts
            try {
                const mimeType = format === 'jpeg' ? 'image/jpeg' : 'image/png';
                const quality = format === 'jpeg' ? 0.95 : undefined;
                const dataUrl = canvas.toDataURL(mimeType, quality);

                // Extract base64 data (remove "data:image/xxx;base64," prefix)
                const base64Data = dataUrl.split(',')[1];
                if (!base64Data) {
                    reject(new Error(`Failed to create ${format.toUpperCase()} image (canvas ${canvas.width}x${canvas.height} may exceed browser limits)`));
                    return;
                }
                resolve(base64Data);
            } catch (e) {
                reject(new Error('Canvas export failed - the graph may contain external resources'));
            }
        };

        img.onerror = () => {
            reject(new Error('Failed to load SVG'));
        };

        img.src = svgDataUrl;
    });
}

/**
 * Save base64 image data using VSCode save dialog
 */
async function saveBase64Image(base64Data: string, suggestedName: string): Promise<void> {
    // Send to extension to show save dialog
    state.vscode.postMessage({
        command: 'saveExport',
        data: base64Data,
        suggestedName: suggestedName
    });
}

/**
 * Show export notification
 */
function showExportNotification(message: string, isError: boolean = false): void {
    const queue = document.getElementById('notificationQueue');
    if (!queue) return;

    const notification = document.createElement('div');
    notification.className = `notification ${isError ? 'notification-error' : 'notification-success'}`;
    notification.innerHTML = `
        <span class="notification-icon">${isError ? '✗' : '✓'}</span>
        <span class="notification-text">${message}</span>
    `;

    queue.appendChild(notification);

    // Animate in
    requestAnimationFrame(() => {
        notification.classList.add('notification-visible');
    });

    // Remove after delay
    setTimeout(() => {
        notification.classList.remove('notification-visible');
        setTimeout(() => notification.remove(), 300);
    }, 3000);
}

/**
 * Export the entire graph as PNG
 */
export async function exportAllAsPNG(scale: number = 2): Promise<void> {
    try {
        const bounds = getExportBounds();
        if (!bounds) {
            showExportNotification('No graph content to export', true);
            return;
        }

        const svg = prepareSVGForExport(bounds);
        const base64Data = await svgToBase64(svg, 'png', scale);

        const timestamp = new Date().toISOString().slice(0, 10);
        await saveBase64Image(base64Data, `codag-workflow-${timestamp}.png`);
    } catch (error) {
        console.error('Export failed:', error);
        showExportNotification('Export failed: ' + (error as Error).message, true);
    }
}

/**
 * Export the entire graph as JPEG with editor background color
 */
export async function exportAllAsJPEG(scale: number = 2): Promise<void> {
    try {
        const bounds = getExportBounds();
        if (!bounds) {
            showExportNotification('No graph content to export', true);
            return;
        }

        const svg = prepareSVGForExport(bounds);
        const base64Data = await svgToBase64(svg, 'jpeg', scale);

        const timestamp = new Date().toISOString().slice(0, 10);
        await saveBase64Image(base64Data, `codag-workflow-${timestamp}.jpg`);
    } catch (error) {
        console.error('Export failed:', error);
        showExportNotification('Export failed: ' + (error as Error).message, true);
    }
}

/**
 * Export a specific workflow group as PNG
 */
export async function exportWorkflowAsPNG(groupId: string, groupName: string, scale: number = 2): Promise<void> {
    try {
        const bounds = getExportBounds(groupId);
        if (!bounds) {
            showExportNotification('Workflow not found', true);
            return;
        }

        const svg = prepareSVGForExport(bounds, groupId);
        const base64Data = await svgToBase64(svg, 'png', scale);

        // Sanitize filename
        const safeName = groupName.replace(/[^a-z0-9]/gi, '-').toLowerCase();
        await saveBase64Image(base64Data, `codag-${safeName}.png`);
    } catch (error) {
        console.error('Export failed:', error);
        showExportNotification('Export failed: ' + (error as Error).message, true);
    }
}

/**
 * Export a specific workflow group as JPEG with editor background color
 */
export async function exportWorkflowAsJPEG(groupId: string, groupName: string, scale: number = 2): Promise<void> {
    try {
        const bounds = getExportBounds(groupId);
        if (!bounds) {
            showExportNotification('Workflow not found', true);
            return;
        }

        const svg = prepareSVGForExport(bounds, groupId);
        const base64Data = await svgToBase64(svg, 'jpeg', scale);

        // Sanitize filename
        const safeName = groupName.replace(/[^a-z0-9]/gi, '-').toLowerCase();
        await saveBase64Image(base64Data, `codag-${safeName}.jpg`);
    } catch (error) {
        console.error('Export failed:', error);
        showExportNotification('Export failed: ' + (error as Error).message, true);
    }
}

/**
 * Build resolution picker HTML for a given graph bounds.
 * Disables options that exceed browser canvas limits.
 */
function buildResolutionPicker(bounds: { minX: number; minY: number; maxX: number; maxY: number }): string {
    const baseW = bounds.maxX - bounds.minX;
    const baseH = bounds.maxY - bounds.minY;

    return RESOLUTION_OPTIONS.map(opt => {
        const w = Math.round(baseW * opt.scale);
        const h = Math.round(baseH * opt.scale);
        const exceeds = w > MAX_CANVAS_DIM || h > MAX_CANVAS_DIM;
        return `
            <button class="export-dropdown-item export-res-item${exceeds ? ' disabled' : ''}"
                    data-scale="${opt.scale}" ${exceeds ? 'disabled' : ''}>
                <span class="export-res-label">${opt.label}</span>
                <span class="export-res-dims">${w.toLocaleString()} × ${h.toLocaleString()}px</span>
                ${exceeds ? '<span class="export-res-warn">Exceeds export limit — pick a lower resolution</span>' : ''}
            </button>`;
    }).join('');
}

/**
 * Show a resolution picker dropdown, returns selected scale or null if cancelled.
 */
function showResolutionPicker(
    anchorRect: DOMRect,
    bounds: { minX: number; minY: number; maxX: number; maxY: number }
): Promise<number | null> {
    return new Promise(resolve => {
        // Remove any existing resolution picker
        document.querySelector('.export-resolution-picker')?.remove();

        const picker = document.createElement('div');
        picker.className = 'export-dropdown export-resolution-picker visible';
        picker.innerHTML = `
            <div class="export-dropdown-header">Resolution</div>
            ${buildResolutionPicker(bounds)}
        `;
        picker.style.top = `${anchorRect.bottom + 4}px`;
        picker.style.right = `${window.innerWidth - anchorRect.right}px`;
        document.body.appendChild(picker);

        let resolved = false;

        picker.addEventListener('click', (e) => {
            const item = (e.target as HTMLElement).closest('.export-res-item:not(.disabled)') as HTMLElement;
            if (!item) return;
            resolved = true;
            picker.remove();
            document.removeEventListener('click', closeHandler);
            resolve(parseFloat(item.dataset.scale!));
        });

        const closeHandler = (e: MouseEvent) => {
            if (!picker.contains(e.target as Node)) {
                picker.remove();
                document.removeEventListener('click', closeHandler);
                if (!resolved) resolve(null);
            }
        };
        // Delay to avoid the current click from closing it
        setTimeout(() => document.addEventListener('click', closeHandler), 0);
    });
}

/**
 * Setup global export button with format dropdown
 */
export function setupExportButton(): void {
    const exportBtn = document.getElementById('btn-export');
    if (!exportBtn) return;

    // Create dropdown menu
    const dropdown = document.createElement('div');
    dropdown.className = 'export-dropdown';
    dropdown.innerHTML = `
        <button class="export-dropdown-item" data-format="png">
            PNG
            <span class="export-dropdown-hint">Transparent</span>
        </button>
        <button class="export-dropdown-item" data-format="jpeg">
            JPEG
            <span class="export-dropdown-hint">With background</span>
        </button>
    `;
    document.body.appendChild(dropdown);

    // Position and show dropdown on click
    exportBtn.addEventListener('click', (e) => {
        e.stopPropagation();
        const rect = exportBtn.getBoundingClientRect();
        dropdown.style.top = `${rect.bottom + 4}px`;
        dropdown.style.right = `${window.innerWidth - rect.right}px`;
        dropdown.classList.toggle('visible');
    });

    // Handle format selection → show resolution picker
    dropdown.addEventListener('click', async (e) => {
        const target = e.target as HTMLElement;
        const item = target.closest('.export-dropdown-item') as HTMLElement;
        if (!item) return;
        e.stopPropagation();

        const format = item.dataset.format as 'png' | 'jpeg';
        if (!format) return;

        const bounds = getExportBounds();
        if (!bounds) {
            dropdown.classList.remove('visible');
            showExportNotification('No graph content to export', true);
            return;
        }

        // Show resolution picker anchored to the export button (same position as format dropdown)
        const btnRect = exportBtn.getBoundingClientRect();
        dropdown.classList.remove('visible');
        const scale = await showResolutionPicker(btnRect, bounds);
        if (scale === null) return;

        if (format === 'png') {
            await exportAllAsPNG(scale);
        } else {
            await exportAllAsJPEG(scale);
        }
    });

    // Close all export dropdowns when clicking outside
    document.addEventListener('click', () => {
        dropdown.classList.remove('visible');
        document.querySelector('.export-resolution-picker')?.remove();
        document.querySelector('.workflow-export-menu')?.remove();
    });
}

/**
 * Add export buttons to workflow groups
 */
export function addWorkflowExportButtons(): void {
    const { g, workflowGroups } = state;

    // Remove existing export buttons
    d3.selectAll('.workflow-export-btn').remove();

    // Resolve background color once
    const bgColor = resolveCSSVariable('var(--vscode-editor-background)') || '#1e1e1e';

    // Get the LAST groups container (the newest one during transitions)
    // This ensures we add buttons to the new groups, not old ones being removed
    const groupsContainers = g.selectAll('.groups').nodes();
    const targetContainer = groupsContainers.length > 0
        ? d3.select(groupsContainers[groupsContainers.length - 1])
        : null;

    if (!targetContainer) {
        console.warn('Export button: no groups container found');
        return;
    }

    // Add export button to each workflow group
    // Must match the filter in updateGroupsIncremental: bounds && nodes.length >= 3
    workflowGroups.forEach((group: any) => {
        if (!group.bounds) return;
        if (group.id === 'group_orphans') return;
        if (group.nodes.length < 3) return;  // Match updateGroupsIncremental filter

        // Select from the target container specifically to avoid matching old elements
        const groupEl = targetContainer.select(`[data-group-id="${group.id}"]`);
        if (groupEl.empty()) {
            console.warn('Export button: group element not found for', group.id);
            return;
        }

        // Position: top-left corner, inside the bounded box
        const btnX = group.bounds.minX + 20;
        const btnY = group.bounds.minY + 20;

        // Create export button group
        const btnGroup = groupEl.append('g')
            .attr('class', 'workflow-export-btn')
            .attr('transform', `translate(${btnX}, ${btnY})`)
            .style('cursor', 'pointer')
            .on('click', (event: MouseEvent) => {
                event.stopPropagation();
                // Show format selection menu at click position
                showWorkflowExportMenu(event.clientX, event.clientY, group.id, group.name);
            })
            // Maintain parent hover state when hovering export button
            .on('mouseenter', () => {
                groupEl.classed('hover', true);
            })
            .on('mouseleave', () => {
                groupEl.classed('hover', false);
            });

        // Tooltip on hover
        btnGroup.append('title')
            .text('Export workflow');

        // Button background circle
        btnGroup.append('circle')
            .attr('r', 14)
            .attr('fill', bgColor)
            .attr('stroke', group.color)
            .attr('stroke-width', 1.5)
            .attr('stroke-opacity', 0.6);

        // Share icon - simple arrow pointing up-right
        const iconColor = group.color;
        btnGroup.append('path')
            .attr('d', 'M -4 4 L 4 -4 M 4 -4 L 4 2 M 4 -4 L -2 -4')
            .attr('stroke', iconColor)
            .attr('stroke-width', 2)
            .attr('stroke-linecap', 'round')
            .attr('fill', 'none');
    });
}

/**
 * Show workflow export context menu with format options
 */
export function showWorkflowExportMenu(x: number, y: number, groupId: string, groupName: string): void {
    // Remove any existing menu
    document.querySelector('.workflow-export-menu')?.remove();

    const menu = document.createElement('div');
    menu.className = 'workflow-export-menu export-dropdown visible';
    menu.innerHTML = `
        <button class="export-dropdown-item" data-format="png">
            PNG
            <span class="export-dropdown-hint">Transparent</span>
        </button>
        <button class="export-dropdown-item" data-format="jpeg">
            JPEG
            <span class="export-dropdown-hint">With background</span>
        </button>
    `;
    menu.style.top = `${y}px`;
    menu.style.left = `${x}px`;
    menu.style.right = 'auto';
    document.body.appendChild(menu);

    // Handle format selection → show resolution picker
    menu.addEventListener('click', async (e) => {
        const target = e.target as HTMLElement;
        const item = target.closest('.export-dropdown-item') as HTMLElement;
        if (!item) return;
        e.stopPropagation();

        const format = item.dataset.format as 'png' | 'jpeg';
        if (!format) return;

        const bounds = getExportBounds(groupId);
        if (!bounds) {
            menu.remove();
            showExportNotification('Workflow not found', true);
            return;
        }

        const menuRect = menu.getBoundingClientRect();
        menu.remove();
        document.removeEventListener('click', closeHandler);
        const scale = await showResolutionPicker(menuRect, bounds);
        if (scale === null) return;

        if (format === 'png') {
            await exportWorkflowAsPNG(groupId, groupName, scale);
        } else {
            await exportWorkflowAsJPEG(groupId, groupName, scale);
        }
    });

    // Close on outside click
    const closeHandler = (e: MouseEvent) => {
        if (!menu.contains(e.target as Node)) {
            menu.remove();
            document.removeEventListener('click', closeHandler);
        }
    };
    // Delay to prevent immediate close
    setTimeout(() => document.addEventListener('click', closeHandler), 0);
}
