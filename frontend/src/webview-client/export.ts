// PNG Export functionality for workflow graphs
import * as state from './state';

declare const d3: any;

// Export padding around the content
const EXPORT_PADDING = 40;

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
                // Only hyphenate if character IMMEDIATELY before break is a letter
                // AND character IMMEDIATELY after break is a letter (no space between)
                const charBeforeBreak = i > 0 ? text[i - 1] : '';
                const charAfterBreak = text[i] || '';
                const isHyphenatedBreak = /[a-zA-Z]/.test(charBeforeBreak) && /[a-zA-Z]/.test(charAfterBreak);

                if (isHyphenatedBreak) {
                    // Word was split - add explicit hyphen
                    lines.push(lineText + '-');
                } else {
                    lines.push(lineText);
                }

                lineStart = i;
                lastTop = rect.top;
            }
        } else {
            // End of text - get final line
            const finalLine = text.substring(lineStart);
            if (finalLine) lines.push(finalLine);
        }
    }

    return lines.length > 0 ? lines : [text];
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
    const height = bounds.maxY - bounds.minY;

    // Calculate text scale for large graphs
    const visibleNodeCount = groupId
        ? (workflowGroups.find((g: any) => g.id === groupId)?.nodes.length || 0)
        : currentGraphData.nodes.filter((n: any) => n.type !== 'workflow-title').length;
    const textScale = calculateTextScale(visibleNodeCount, width, height);

    // Resolve common colors once
    const bgColor = resolveCSSVariable('var(--vscode-editor-background)') || '#1e1e1e';
    const fgColor = resolveCSSVariable('var(--vscode-editor-foreground)') || '#cccccc';
    const borderColor = resolveCSSVariable('var(--vscode-editorWidget-border)') || '#454545';
    const descriptionFgColor = resolveCSSVariable('var(--vscode-descriptionForeground)') || '#858585';

    // Create SVG
    const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
    svg.setAttribute('xmlns', 'http://www.w3.org/2000/svg');
    svg.setAttribute('width', String(width));
    svg.setAttribute('height', String(height));
    svg.setAttribute('viewBox', `${bounds.minX} ${bounds.minY} ${width} ${height}`);

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

        // Text label - use SVG text with tspan, extracting hyphenated lines from DOM
        // This captures the browser's actual hyphenation and renders it natively
        const labelSpan = nodeEl.querySelector('.node-title-wrapper span') as HTMLElement | null;
        const labelText = nodeData.label;

        if (labelText) {
            // Apply text scale for large graphs
            const baseFontSize = nodeData.type === 'workflow-title' ? 16 : 15;
            const fontSize = baseFontSize * textScale;
            const fontWeight = nodeData.type === 'workflow-title' ? '600' : '400';

            // Extract hyphenated lines from the actual rendered DOM element
            // This captures exactly where the browser broke lines, including hyphens
            let lines: string[];
            if (labelSpan) {
                lines = extractHyphenatedLines(labelSpan);
            } else {
                // Fallback: single line if DOM element not found
                lines = [labelText];
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
    return svg;
}

type ImageFormat = 'png' | 'jpeg';

/**
 * Convert SVG to image (PNG or JPEG) using canvas
 */
async function svgToImage(svg: SVGSVGElement, format: ImageFormat, scale: number = 2): Promise<Blob> {
    const width = parseInt(svg.getAttribute('width') || '800');
    const height = parseInt(svg.getAttribute('height') || '600');

    // Serialize SVG to string
    const svgString = new XMLSerializer().serializeToString(svg);

    // Use base64 encoding instead of URL encoding
    const base64Svg = btoa(unescape(encodeURIComponent(svgString)));
    const dataUrl = `data:image/svg+xml;base64,${base64Svg}`;

    // Get background color for JPEG (JPEG doesn't support transparency)
    const bgColor = resolveCSSVariable('var(--vscode-editor-background)') || '#1e1e1e';

    return new Promise((resolve, reject) => {
        const img = new Image();
        // Set crossOrigin to help with some browser quirks
        img.crossOrigin = 'anonymous';

        img.onload = () => {
            // Create canvas after image loads
            const canvas = document.createElement('canvas');
            canvas.width = width * scale;
            canvas.height = height * scale;

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

            // Convert to blob - wrap in try-catch for tainted canvas
            const mimeType = format === 'jpeg' ? 'image/jpeg' : 'image/png';
            const quality = format === 'jpeg' ? 0.95 : undefined;

            try {
                canvas.toBlob((blob) => {
                    if (blob) {
                        resolve(blob);
                    } else {
                        reject(new Error(`Failed to create ${format.toUpperCase()} blob`));
                    }
                }, mimeType, quality);
            } catch (e) {
                reject(new Error('Canvas export failed - the graph may contain external resources'));
            }
        };

        img.onerror = () => {
            reject(new Error('Failed to load SVG'));
        };

        img.src = dataUrl;
    });
}

/**
 * Save blob using VSCode save dialog
 */
async function saveBlob(blob: Blob, suggestedName: string): Promise<void> {
    // Convert blob to base64
    const reader = new FileReader();
    const base64Promise = new Promise<string>((resolve, reject) => {
        reader.onload = () => {
            const dataUrl = reader.result as string;
            // Extract base64 part after "data:image/png;base64,"
            const base64 = dataUrl.split(',')[1];
            resolve(base64);
        };
        reader.onerror = reject;
    });
    reader.readAsDataURL(blob);

    const base64Data = await base64Promise;

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
export async function exportAllAsPNG(): Promise<void> {
    try {
        const bounds = getExportBounds();
        if (!bounds) {
            showExportNotification('No graph content to export', true);
            return;
        }

        const svg = prepareSVGForExport(bounds);
        const blob = await svgToImage(svg, 'png', 2);

        const timestamp = new Date().toISOString().slice(0, 10);
        await saveBlob(blob, `codag-workflow-${timestamp}.png`);
    } catch (error) {
        console.error('Export failed:', error);
        showExportNotification('Export failed: ' + (error as Error).message, true);
    }
}

/**
 * Export the entire graph as JPEG with editor background color
 */
export async function exportAllAsJPEG(): Promise<void> {
    try {
        const bounds = getExportBounds();
        if (!bounds) {
            showExportNotification('No graph content to export', true);
            return;
        }

        const svg = prepareSVGForExport(bounds);
        const blob = await svgToImage(svg, 'jpeg', 2);

        const timestamp = new Date().toISOString().slice(0, 10);
        await saveBlob(blob, `codag-workflow-${timestamp}.jpg`);
    } catch (error) {
        console.error('Export failed:', error);
        showExportNotification('Export failed: ' + (error as Error).message, true);
    }
}

/**
 * Export a specific workflow group as PNG
 */
export async function exportWorkflowAsPNG(groupId: string, groupName: string): Promise<void> {
    try {
        const bounds = getExportBounds(groupId);
        if (!bounds) {
            showExportNotification('Workflow not found', true);
            return;
        }

        const svg = prepareSVGForExport(bounds, groupId);
        const blob = await svgToImage(svg, 'png', 2);

        // Sanitize filename
        const safeName = groupName.replace(/[^a-z0-9]/gi, '-').toLowerCase();
        await saveBlob(blob, `codag-${safeName}.png`);
    } catch (error) {
        console.error('Export failed:', error);
        showExportNotification('Export failed: ' + (error as Error).message, true);
    }
}

/**
 * Export a specific workflow group as JPEG with editor background color
 */
export async function exportWorkflowAsJPEG(groupId: string, groupName: string): Promise<void> {
    try {
        const bounds = getExportBounds(groupId);
        if (!bounds) {
            showExportNotification('Workflow not found', true);
            return;
        }

        const svg = prepareSVGForExport(bounds, groupId);
        const blob = await svgToImage(svg, 'jpeg', 2);

        // Sanitize filename
        const safeName = groupName.replace(/[^a-z0-9]/gi, '-').toLowerCase();
        await saveBlob(blob, `codag-${safeName}.jpg`);
    } catch (error) {
        console.error('Export failed:', error);
        showExportNotification('Export failed: ' + (error as Error).message, true);
    }
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
            <span class="export-dropdown-icon">📷</span>
            Export as PNG
            <span class="export-dropdown-hint">Transparent background</span>
        </button>
        <button class="export-dropdown-item" data-format="jpeg">
            <span class="export-dropdown-icon">🖼️</span>
            Export as JPEG
            <span class="export-dropdown-hint">With background color</span>
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

    // Handle format selection
    dropdown.addEventListener('click', async (e) => {
        const target = e.target as HTMLElement;
        const item = target.closest('.export-dropdown-item') as HTMLElement;
        if (!item) return;

        dropdown.classList.remove('visible');
        const format = item.dataset.format;

        if (format === 'png') {
            await exportAllAsPNG();
        } else if (format === 'jpeg') {
            await exportAllAsJPEG();
        }
    });

    // Close dropdown when clicking outside
    document.addEventListener('click', () => {
        dropdown.classList.remove('visible');
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
            <span class="export-dropdown-icon">📷</span>
            Export as PNG
        </button>
        <button class="export-dropdown-item" data-format="jpeg">
            <span class="export-dropdown-icon">🖼️</span>
            Export as JPEG
        </button>
    `;
    menu.style.top = `${y}px`;
    menu.style.left = `${x}px`;
    menu.style.right = 'auto';
    document.body.appendChild(menu);

    // Handle format selection
    menu.addEventListener('click', async (e) => {
        const target = e.target as HTMLElement;
        const item = target.closest('.export-dropdown-item') as HTMLElement;
        if (!item) return;

        menu.remove();
        const format = item.dataset.format;

        if (format === 'png') {
            await exportWorkflowAsPNG(groupId, groupName);
        } else if (format === 'jpeg') {
            await exportWorkflowAsJPEG(groupId, groupName);
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
