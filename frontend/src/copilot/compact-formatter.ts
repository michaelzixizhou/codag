/**
 * Compact symbol-based formatter for Copilot output
 * Replaces verbose markdown with scannable graph notation
 */

import { WorkflowGraph, WorkflowNode, WorkflowEdge } from '../api';

// Type symbols (emoji equivalents of SVG icons)
export const TYPE_SYMBOLS: Record<string, string> = {
  trigger: '⚡',
  llm: '🧠',
  tool: '🔧',
  decision: '◇',
  integration: '🔌',
  memory: '💾',
  parser: '⚙️',
  output: '✓'
};

/**
 * Create clickable node link for Copilot
 */
export function createNodeLink(nodeId: string, label: string): string {
  const commandUri = `command:codag.focusNode?${encodeURIComponent(JSON.stringify([nodeId, label]))}`;
  return `[${label}](${commandUri})`;
}

/**
 * Create clickable workflow link for Copilot (zooms to workflow)
 */
export function createWorkflowLink(workflowName: string): string {
  const commandUri = `command:codag.focusWorkflow?${encodeURIComponent(JSON.stringify([workflowName]))}`;
  return `[${workflowName}](${commandUri})`;
}

/**
 * Format a single node in compact format
 * Output: ⚡ [Label](cmd:...) → file:line
 */
export function formatNode(node: WorkflowNode): string {
  const sym = TYPE_SYMBOLS[node.type] || '□';
  const link = createNodeLink(node.id, node.label);
  const location = node.source
    ? `→ ${node.source.file}:${node.source.line}`
    : '';
  return `${sym} ${link} ${location}`;
}

/**
 * Format a node with adjacency info
 * Output: ⚡ [Label](cmd:...) → file:line
 *         ↳ prev: [A], [B] | next: [C]
 */
export function formatNodeWithAdjacency(
  node: WorkflowNode,
  beforeNodes: string[],
  afterNodes: string[],
  graph: WorkflowGraph
): string {
  const mainLine = formatNode(node);

  const parts: string[] = [mainLine];

  if (beforeNodes.length > 0 || afterNodes.length > 0) {
    const prevLinks = beforeNodes.map(id => {
      const n = graph.nodes.find(n => n.id === id);
      return n ? createNodeLink(id, n.label) : id;
    });
    const nextLinks = afterNodes.map(id => {
      const n = graph.nodes.find(n => n.id === id);
      return n ? createNodeLink(id, n.label) : id;
    });

    const adjacency: string[] = [];
    if (prevLinks.length > 0) adjacency.push(`← ${prevLinks.join(', ')}`);
    if (nextLinks.length > 0) adjacency.push(`→ ${nextLinks.join(', ')}`);

    if (adjacency.length > 0) {
      parts.push(`   ${adjacency.join(' | ')}`);
    }
  }

  return parts.join('\n');
}

/**
 * Build tree structure for a workflow
 * Uses BFS from entry points to create visual hierarchy
 */
export function formatWorkflow(
  workflowName: string,
  nodes: WorkflowNode[],
  edges: WorkflowEdge[],
  graph: WorkflowGraph
): string {
  const workflowLink = createWorkflowLink(workflowName);
  const lines: string[] = [`━━━ ${workflowLink} ━━━`];

  // Build adjacency map
  const children = new Map<string, string[]>();
  const parents = new Map<string, string[]>();

  edges.forEach(e => {
    if (!children.has(e.source)) children.set(e.source, []);
    children.get(e.source)!.push(e.target);

    if (!parents.has(e.target)) parents.set(e.target, []);
    parents.get(e.target)!.push(e.source);
  });

  // Find entry points (nodes with no parents in this workflow)
  const nodeIds = new Set(nodes.map(n => n.id));
  const entryPoints = nodes.filter(n => {
    const nodeParents = parents.get(n.id) || [];
    return nodeParents.filter(p => nodeIds.has(p)).length === 0;
  });

  // BFS to build tree
  const visited = new Set<string>();
  const queue: Array<{ nodeId: string; depth: number; isLast: boolean; prefix: string }> = [];

  entryPoints.forEach((entry, i) => {
    queue.push({
      nodeId: entry.id,
      depth: 0,
      isLast: i === entryPoints.length - 1,
      prefix: ''
    });
  });

  while (queue.length > 0) {
    const { nodeId, depth, isLast, prefix } = queue.shift()!;

    if (visited.has(nodeId)) continue;
    visited.add(nodeId);

    const node = nodes.find(n => n.id === nodeId);
    if (!node) continue;

    // Build line with tree characters
    const sym = TYPE_SYMBOLS[node.type] || '□';
    const link = createNodeLink(node.id, node.label);
    const location = node.source ? `→ ${node.source.file}:${node.source.line}` : '';

    let linePrefix = prefix;
    if (depth > 0) {
      linePrefix += isLast ? '└─ ' : '├─ ';
    }

    lines.push(`${linePrefix}${sym} ${link} ${location}`);

    // Add children to queue
    const nodeChildren = (children.get(nodeId) || []).filter(c => nodeIds.has(c) && !visited.has(c));
    const newPrefix = depth > 0 ? prefix + (isLast ? '   ' : '│  ') : '';

    nodeChildren.forEach((childId, i) => {
      queue.push({
        nodeId: childId,
        depth: depth + 1,
        isLast: i === nodeChildren.length - 1,
        prefix: newPrefix
      });
    });
  }

  return lines.join('\n');
}

/**
 * Format multiple workflows
 */
export function formatWorkflows(
  workflows: Array<{ name: string; nodeIds: string[] }>,
  graph: WorkflowGraph
): string {
  const parts: string[] = [];

  workflows.forEach(wf => {
    const nodes = graph.nodes.filter(n => wf.nodeIds.includes(n.id));
    const edges = graph.edges.filter(e =>
      wf.nodeIds.includes(e.source) && wf.nodeIds.includes(e.target)
    );

    parts.push(formatWorkflow(wf.name, nodes, edges, graph));
    parts.push('');
  });

  return parts.join('\n');
}

/**
 * Format workflows as compact clickable list (just names, no tree structure)
 */
export function formatWorkflowsCompact(
  workflows: Array<{ name: string; nodeIds: string[] }>
): string {
  if (workflows.length === 0) return '';

  const lines = ['Workflows:'];
  workflows.forEach(wf => {
    const link = createWorkflowLink(wf.name);
    lines.push(`• ${link} (${wf.nodeIds.length} nodes)`);
  });
  return lines.join('\n');
}

/**
 * Format legend
 */
export function formatLegend(): string {
  return 'Legend: ⚡=trigger 🧠=llm 🔧=tool ◇=decision 🔌=integration 💾=memory ⚙️=parser ✓=output';
}

/**
 * Format node list (simple compact list)
 */
export function formatNodeList(nodes: WorkflowNode[]): string {
  return nodes.map(n => formatNode(n)).join('\n');
}

/**
 * Format shared nodes (nodes appearing in multiple workflows)
 */
export function formatSharedNodes(
  nodes: WorkflowNode[],
  graph: WorkflowGraph
): string {
  const lines: string[] = ['Shared nodes (in 2+ workflows):'];

  nodes.forEach(node => {
    const nodeWorkflows = graph.workflows
      .filter(wf => wf.nodeIds.includes(node.id))
      .map(wf => wf.name);

    const sym = TYPE_SYMBOLS[node.type] || '□';
    const link = createNodeLink(node.id, node.label);
    const location = node.source ? `→ ${node.source.file}:${node.source.line}` : '';

    lines.push(`${sym} ${link} ${location} ⟵ ${nodeWorkflows.join(', ')}`);
  });

  return lines.join('\n');
}

/**
 * Escape special regex characters in a string
 */
function escapeRegex(str: string): string {
  return str.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/**
 * Post-process LLM response to convert node references to clickable links
 * Matches patterns like: ⚡Node Name, 🧠LLM Call, etc.
 */
export function linkifyResponse(text: string, graph: WorkflowGraph): string {
  // Build label → node map (case-insensitive)
  const labelToNode = new Map<string, WorkflowNode>();
  for (const node of graph.nodes) {
    labelToNode.set(node.label.toLowerCase(), node);
  }

  // Build regex pattern for all type symbols
  const symbolPattern = Object.values(TYPE_SYMBOLS).map(s => escapeRegex(s)).join('|');

  // Match: emoji + optional space + node name (letters/numbers/spaces until delimiter)
  // Negative lookbehind for [ to avoid double-linking already-linked text
  const regex = new RegExp(
    `(?<!\\[)(${symbolPattern})\\s*([A-Za-z][\\w\\s-]*?)(?=\\s*[→|\\n\\r,.;:\\]\\)\\[]|$)`,
    'g'
  );

  return text.replace(regex, (match, symbol, name) => {
    const trimmedName = name.trim();
    const node = labelToNode.get(trimmedName.toLowerCase());
    if (node) {
      return `${symbol}[${node.label}](${createCommandUri(node.id, node.label)})`;
    }
    return match;
  });
}

/**
 * Create command URI for node focus (without markdown wrapper)
 */
function createCommandUri(nodeId: string, label: string): string {
  return `command:codag.focusNode?${encodeURIComponent(JSON.stringify([nodeId, label]))}`;
}

/**
 * Post-process LLM response to convert workflow name references to clickable links
 */
export function linkifyWorkflows(
  text: string,
  workflows: Array<{ name: string; nodeIds: string[] }>
): string {
  let result = text;

  // Sort by name length descending to match longer names first (avoid partial matches)
  const sortedWorkflows = [...workflows].sort((a, b) => b.name.length - a.name.length);

  for (const wf of sortedWorkflows) {
    // Match workflow name with optional bold/italic markers, not already in a link
    // Handles: "Name", **Name**, *Name*, `Name`
    const escapedName = escapeRegex(wf.name);
    const pattern = new RegExp(
      `(?<!\\]\\()(?<!\\[)(?<prefix>[\\*\`]*)${escapedName}(?<suffix>[\\*\`]*)(?!\\]|\\()`,
      'g'
    );
    result = result.replace(pattern, (match, prefix, suffix) => {
      return `${prefix || ''}${createWorkflowLink(wf.name)}${suffix || ''}`;
    });
  }
  return result;
}
