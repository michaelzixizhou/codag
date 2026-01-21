// Click/drag handlers (drag disabled - ELK routes are static)
import * as state from './state';
import { openPanel, closePanel } from './panel';

declare const d3: any;

let dragStartX: number = 0;
let dragStartY: number = 0;

export function dragstarted(event: any, d: any): void {
    // Track start position to detect click
    dragStartX = event.x;
    dragStartY = event.y;
}

export function dragged(_event: any, _d: any): void {
    // Drag disabled - ELK routes are static and cannot update dynamically
}

export function dragended(event: any, d: any): void {
    // Only handle clicks (no drag)
    const distance = Math.sqrt(
        Math.pow(event.x - dragStartX, 2) + Math.pow(event.y - dragStartY, 2)
    );

    // Small threshold to account for minor mouse movement during click
    if (distance < 5) {
        if (event.sourceEvent) {
            event.sourceEvent.stopPropagation();
            event.sourceEvent.preventDefault();
        }

        // Toggle panel if clicking the same node
        if (state.currentlyOpenNodeId === d.id) {
            closePanel();
        } else {
            openPanel(d);
        }
    }
}
