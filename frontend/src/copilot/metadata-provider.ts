/**
 * Extracts workflow metadata from cached graphs for Copilot context
 */

import { WorkflowGraph } from '../api';
import {
  AdjacentNodeInfo,
  WorkflowInfo,
  CrossFileEdge,
  FileContext,
  WorkflowMetadata
} from './types';
import { filterVisibleWorkflows } from './graph-filter';

export interface MetadataOptions {
  // Code snippets removed - Copilot can read files directly using file:line info
}

export class WorkflowMetadataProvider {
  /**
   * Extract metadata from a workflow graph for a specific file
   * @param graph - The workflow graph to extract from
   * @param targetFile - The file to extract metadata for
   * @param selectedNodeId - Optional selected node ID to prioritize
   * @param visibleNodeIds - Optional array of visible node IDs (from viewport) to prioritize
   * @param options - Optional configuration for metadata extraction
   */
  async extractMetadata(
    graph: WorkflowGraph,
    targetFile: string,
    selectedNodeId?: string,
    visibleNodeIds?: string[],
    options?: MetadataOptions
  ): Promise<WorkflowMetadata> {
    // Build adjacency maps for quick lookup
    const beforeMap = new Map<string, Set<string>>(); // nodeId -> set of nodes that come before
    const afterMap = new Map<string, Set<string>>();  // nodeId -> set of nodes that come after

    graph.edges.forEach(edge => {
      if (!afterMap.has(edge.source)) {
        afterMap.set(edge.source, new Set());
      }
      afterMap.get(edge.source)!.add(edge.target);

      if (!beforeMap.has(edge.target)) {
        beforeMap.set(edge.target, new Set());
      }
      beforeMap.get(edge.target)!.add(edge.source);
    });

    // Extract adjacent node info from ALL files (not just target file)
    let adjacentNodes: AdjacentNodeInfo[] = graph.nodes
      .filter(node => node.source) // Include all files
      .map(node => ({
        nodeId: node.id,
        label: node.label,
        type: node.type,
        beforeNodes: Array.from(beforeMap.get(node.id) || []),
        afterNodes: Array.from(afterMap.get(node.id) || []),
        source: node.source!
      }));

    // Prioritize visible nodes, selected node, and neighbors
    const visibleSet = new Set(visibleNodeIds || []);
    const selectedNode = selectedNodeId ? adjacentNodes.find(n => n.nodeId === selectedNodeId) : undefined;
    const neighborIds = selectedNode ? new Set([
      selectedNodeId!,
      ...selectedNode.beforeNodes,
      ...selectedNode.afterNodes
    ]) : new Set<string>();

    adjacentNodes.sort((a, b) => {
      const aIsVisible = visibleSet.has(a.nodeId);
      const bIsVisible = visibleSet.has(b.nodeId);
      const aIsInTargetFile = a.source.file === targetFile;
      const bIsInTargetFile = b.source.file === targetFile;
      const aIsNeighbor = neighborIds.has(a.nodeId);
      const bIsNeighbor = neighborIds.has(b.nodeId);

      // Priority 1: Visible nodes (from viewport)
      if (aIsVisible && !bIsVisible) return -1;
      if (!aIsVisible && bIsVisible) return 1;

      // Priority 2: Nodes in target file
      if (aIsInTargetFile && !bIsInTargetFile) return -1;
      if (!aIsInTargetFile && bIsInTargetFile) return 1;

      // Priority 3: Selected node
      if (a.nodeId === selectedNodeId) return -1;
      if (b.nodeId === selectedNodeId) return 1;

      // Priority 4: Neighbors of selected node
      if (aIsNeighbor && !bIsNeighbor) return -1;
      if (!aIsNeighbor && bIsNeighbor) return 1;

      return 0;
    });

    // Extract workflow structure info (only workflows visible in the webview)
    const visibleWorkflows = filterVisibleWorkflows(graph);
    const workflows: WorkflowInfo[] = visibleWorkflows.map(wf => ({
      name: wf.name,
      nodeIds: wf.nodeIds || [],
      entryPoints: graph.nodes
        .filter(n => n.isEntryPoint && wf.nodeIds.includes(n.id))
        .map(n => n.id),
      exitPoints: graph.nodes
        .filter(n => n.isExitPoint && wf.nodeIds.includes(n.id))
        .map(n => n.id)
    }));

    // Extract cross-file edges
    const crossFileEdges: CrossFileEdge[] = graph.edges
      .filter(edge => {
        const sourceNode = graph.nodes.find(n => n.id === edge.source);
        const targetNode = graph.nodes.find(n => n.id === edge.target);
        return sourceNode?.source?.file !== targetNode?.source?.file;
      })
      .map(edge => {
        const sourceNode = graph.nodes.find(n => n.id === edge.source)!;
        const targetNode = graph.nodes.find(n => n.id === edge.target)!;
        return {
          from: { file: sourceNode.source!.file, nodeId: edge.source },
          to: { file: targetNode.source!.file, nodeId: edge.target },
          edgeType: edge.label || 'default'
        };
      });

    // Extract file context
    const nodesInFile = graph.nodes
      .filter(n => n.source?.file === targetFile)
      .map(n => n.id);

    const incomingFromFiles = Array.from(new Set(
      crossFileEdges
        .filter(e => e.to.file === targetFile)
        .map(e => e.from.file)
    ));

    const outgoingToFiles = Array.from(new Set(
      crossFileEdges
        .filter(e => e.from.file === targetFile)
        .map(e => e.to.file)
    ));

    const fileContext: FileContext = {
      nodesInFile,
      incomingFromFiles,
      outgoingToFiles
    };

    return {
      adjacentNodes,
      workflows,
      crossFileEdges: crossFileEdges.filter(
        e => e.from.file === targetFile || e.to.file === targetFile
      ),
      fileContext
    };
  }
}
