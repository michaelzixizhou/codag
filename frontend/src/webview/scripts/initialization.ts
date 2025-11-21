/**
 * Initialization script for webview
 * Sets up VSCode API and global variables
 */

export function getInitializationScript(graphJson: string): string {
    return `        const vscode = acquireVsCodeApi();
        let currentGraphData = ${graphJson};`;
}
