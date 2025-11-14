/**
 * Get SVG icon for a node type
 */
export function getNodeIcon(type: string): string {
    const icons: Record<string, string> = {
        trigger: '<svg viewBox="0 0 24 24" width="24" height="24"><path d="M13 3v7h9l-9 11v-7H4l9-11z" fill="currentColor"/></svg>',
        llm: '<svg viewBox="0 0 24 24" width="24" height="24"><circle cx="12" cy="12" r="3" fill="currentColor"/><path d="M12 2v4m0 12v4M4.93 4.93l2.83 2.83m8.48 8.48l2.83 2.83M2 12h4m12 0h4M4.93 19.07l2.83-2.83m8.48-8.48l2.83-2.83" stroke="currentColor" stroke-width="2" fill="none"/></svg>',
        tool: '<svg viewBox="0 0 24 24" width="24" height="24"><path d="M14.7 6.3a1 1 0 0 0 0 1.4l1.6 1.6a1 1 0 0 0 1.4 0l3.77-3.77a6 6 0 0 1-7.94 7.94l-6.91 6.91a2.12 2.12 0 0 1-3-3l6.91-6.91a6 6 0 0 1 7.94-7.94l-3.76 3.76z" fill="currentColor"/></svg>',
        decision: '<svg viewBox="0 0 24 24" width="24" height="24"><path d="M12 2l10 10-10 10L2 12 12 2z" fill="none" stroke="currentColor" stroke-width="2"/><path d="M8 12h8M12 8v8" stroke="currentColor" stroke-width="2"/></svg>',
        integration: '<svg viewBox="0 0 24 24" width="24" height="24"><circle cx="12" cy="12" r="2" fill="currentColor"/><circle cx="19" cy="12" r="2" fill="currentColor"/><circle cx="5" cy="12" r="2" fill="currentColor"/><path d="M7 12h10" stroke="currentColor" stroke-width="2"/></svg>',
        memory: '<svg viewBox="0 0 24 24" width="24" height="24"><rect x="3" y="6" width="18" height="12" rx="2" fill="none" stroke="currentColor" stroke-width="2"/><path d="M3 10h18M7 6v12M11 6v12M15 6v12M19 6v12" stroke="currentColor" stroke-width="1.5"/></svg>',
        parser: '<svg viewBox="0 0 24 24" width="24" height="24"><path d="M8 3v3m8-3v3M5 6h14a2 2 0 012 2v10a2 2 0 01-2 2H5a2 2 0 01-2-2V8a2 2 0 012-2zm0 4h14" fill="none" stroke="currentColor" stroke-width="2"/></svg>',
        output: '<svg viewBox="0 0 24 24" width="24" height="24"><path d="M9 3v18m6-18v18M3 12h18" stroke="currentColor" stroke-width="2" fill="none"/><circle cx="12" cy="12" r="2" fill="currentColor"/></svg>'
    };
    return icons[type] || icons.output;
}
