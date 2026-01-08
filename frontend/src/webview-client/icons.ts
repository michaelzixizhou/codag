// SVG icons for node types

// Shared node indicator icon (overlapping squares)
export const sharedIcon = '<svg viewBox="0 0 16 16" width="12" height="12"><rect x="1" y="4" width="8" height="8" rx="1" fill="none" stroke="currentColor" stroke-width="1.5"/><rect x="5" y="1" width="8" height="8" rx="1" fill="none" stroke="currentColor" stroke-width="1.5"/></svg>';

export function getNodeIcon(type: string): string {
    const icons: Record<string, string> = {
        trigger: '<svg viewBox="0 0 24 24" width="24" height="24"><path d="M13 3v7h9l-9 11v-7H4l9-11z" fill="currentColor"/></svg>',
        llm: '<svg viewBox="0 0 24 24" width="24" height="24"><path d="M12 2C8.5 2 5.5 3.5 4 6c-.5.8-.7 1.7-.7 2.6 0 1.8 1 3.4 2.5 4.4-.2.6-.3 1.3-.3 2 0 3.9 3.1 7 7 7s7-3.1 7-7c0-.7-.1-1.4-.3-2 1.5-1 2.5-2.6 2.5-4.4 0-.9-.2-1.8-.7-2.6C19.5 3.5 16.5 2 13 2h-1zm0 4c.6 0 1 .4 1 1v2h2c.6 0 1 .4 1 1s-.4 1-1 1h-2v2c0 .6-.4 1-1 1s-1-.4-1-1v-2H9c-.6 0-1-.4-1-1s.4-1 1-1h2V7c0-.6.4-1 1-1z" fill="currentColor"/></svg>',
        tool: '<svg viewBox="0 0 24 24" width="24" height="24"><path d="M14.7 6.3a1 1 0 0 0 0 1.4l1.6 1.6a1 1 0 0 0 1.4 0l3.77-3.77a6 6 0 0 1-7.94 7.94l-6.91 6.91a2.12 2.12 0 0 1-3-3l6.91-6.91a6 6 0 0 1 7.94-7.94l-3.76 3.76z" fill="currentColor"/></svg>',
        decision: '<svg viewBox="0 0 24 24" width="24" height="24"><circle cx="12" cy="4" r="2" fill="currentColor"/><circle cx="6" cy="20" r="2" fill="currentColor"/><circle cx="18" cy="20" r="2" fill="currentColor"/><path d="M12 6v5m0 0l-5 7m5-7l5 7" stroke="currentColor" stroke-width="2" fill="none" stroke-linecap="round"/></svg>',
        integration: '<svg viewBox="0 0 24 24" width="24" height="24"><path d="M12 2L2 7l10 5 10-5-10-5zM2 17l10 5 10-5M2 12l10 5 10-5" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/></svg>',
        memory: '<svg viewBox="0 0 24 24" width="24" height="24"><ellipse cx="12" cy="6" rx="7" ry="3" fill="none" stroke="currentColor" stroke-width="2"/><path d="M5 6v12c0 1.66 3.13 3 7 3s7-1.34 7-3V6" fill="none" stroke="currentColor" stroke-width="2"/><path d="M5 12c0 1.66 3.13 3 7 3s7-1.34 7-3" fill="none" stroke="currentColor" stroke-width="2"/></svg>',
        parser: '<svg viewBox="0 0 24 24" width="24" height="24"><circle cx="12" cy="12" r="3" fill="none" stroke="currentColor" stroke-width="2"/><path d="M12 2v4m0 12v4M2 12h4m12 0h4m-2.93-7.07l-2.83 2.83m-8.48 8.48l-2.83 2.83m14.14 0l-2.83-2.83m-8.48-8.48L4.93 4.93" stroke="currentColor" stroke-width="2" stroke-linecap="round"/></svg>',
        output: '<svg viewBox="0 0 24 24" width="24" height="24"><path d="M5 12l5 5L20 7" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"/><circle cx="12" cy="12" r="10" fill="none" stroke="currentColor" stroke-width="2"/></svg>',
        // Hub/network icon for orchestrator - coordinates multiple services
        orchestrator: '<svg viewBox="0 0 24 24" width="24" height="24"><circle cx="12" cy="12" r="3" fill="currentColor"/><circle cx="4" cy="8" r="2" fill="currentColor"/><circle cx="20" cy="8" r="2" fill="currentColor"/><circle cx="4" cy="16" r="2" fill="currentColor"/><circle cx="20" cy="16" r="2" fill="currentColor"/><path d="M6 8h3M15 8h3M6 16h3M15 16h3" stroke="currentColor" stroke-width="2" stroke-linecap="round"/></svg>',
        // Robot/agent icon for autonomous agents
        agent: '<svg viewBox="0 0 24 24" width="24" height="24"><rect x="5" y="7" width="14" height="12" rx="2" fill="none" stroke="currentColor" stroke-width="2"/><circle cx="9" cy="12" r="1.5" fill="currentColor"/><circle cx="15" cy="12" r="1.5" fill="currentColor"/><path d="M9 16h6" stroke="currentColor" stroke-width="2" stroke-linecap="round"/><path d="M12 3v4M8 5l4-2 4 2" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/></svg>',
        // Search/magnifying glass for retrieval
        retriever: '<svg viewBox="0 0 24 24" width="24" height="24"><circle cx="10" cy="10" r="6" fill="none" stroke="currentColor" stroke-width="2"/><path d="M14.5 14.5L20 20" stroke="currentColor" stroke-width="2.5" stroke-linecap="round"/><path d="M7 10h6M10 7v6" stroke="currentColor" stroke-width="1.5" stroke-linecap="round"/></svg>',
        // Shield icon for safety guardrails
        guardrail: '<svg viewBox="0 0 24 24" width="24" height="24"><path d="M12 2L4 6v6c0 5.5 3.4 10.3 8 12 4.6-1.7 8-6.5 8-12V6l-8-4z" fill="none" stroke="currentColor" stroke-width="2"/><path d="M9 12l2 2 4-4" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/></svg>'
    };
    return icons[type] || icons.output;
}
