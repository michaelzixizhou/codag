/**
 * Script loader for webview
 * Combines all JavaScript modules into a single script for the webview
 */

import { getInitializationScript } from './scripts/initialization';
import { utilitiesScript } from './scripts/utilities';
import { workflowDetectionScript } from './scripts/workflow-detection';

/**
 * Loads and combines all webview scripts in the correct order
 * @param graphJson - JSON string of the graph data
 * @param mainRendererScript - The main D3 rendering script (kept separate for now)
 * @returns Combined JavaScript string
 */
export function loadScripts(graphJson: string, mainRendererScript: string): string {
    return `${getInitializationScript(graphJson)}

${utilitiesScript}

${workflowDetectionScript}

${mainRendererScript}`;
}
