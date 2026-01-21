// SVG icons for node types

// Shared node indicator icon (overlapping squares)
export const sharedIcon = '<svg viewBox="0 0 16 16" width="12" height="12"><rect x="1" y="4" width="8" height="8" rx="1" fill="none" stroke="currentColor" stroke-width="1.5"/><rect x="5" y="1" width="8" height="8" rx="1" fill="none" stroke="currentColor" stroke-width="1.5"/></svg>';

export function getNodeIcon(type: string): string {
    const icons: Record<string, string> = {
        // Primary 3 types
        step: '<svg viewBox="0 0 24 24" width="24" height="24"><rect x="3" y="6" width="18" height="12" rx="2" fill="none" stroke="currentColor" stroke-width="2"/><path d="M7 12h10M14 9l3 3-3 3" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/></svg>',
        llm: '<svg viewBox="0 0 24 24" width="24" height="24"><path d="M12 2C8.5 2 5.5 3.5 4 6c-.5.8-.7 1.7-.7 2.6 0 1.8 1 3.4 2.5 4.4-.2.6-.3 1.3-.3 2 0 3.9 3.1 7 7 7s7-3.1 7-7c0-.7-.1-1.4-.3-2 1.5-1 2.5-2.6 2.5-4.4 0-.9-.2-1.8-.7-2.6C19.5 3.5 16.5 2 13 2h-1zm0 4c.6 0 1 .4 1 1v2h2c.6 0 1 .4 1 1s-.4 1-1 1h-2v2c0 .6-.4 1-1 1s-1-.4-1-1v-2H9c-.6 0-1-.4-1-1s.4-1 1-1h2V7c0-.6.4-1 1-1z" fill="currentColor"/></svg>',
        decision: '<svg viewBox="0 0 24 24" width="24" height="24"><path d="M12 3l9 9-9 9-9-9 9-9z" fill="none" stroke="currentColor" stroke-width="2"/><path d="M9 12h6" stroke="currentColor" stroke-width="2" stroke-linecap="round"/></svg>'
    };
    // Fallback: unknown types use step icon
    return icons[type] || icons.step;
}
