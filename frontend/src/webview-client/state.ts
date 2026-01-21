// Shared mutable state for webview client
import { WorkflowGraph, WorkflowGroup, WorkflowComponent, NodePosition, EdgeRoute } from './types';

// VSCode API instance
export let vscode: any = null;

// D3 selections
export let svg: any = null;
export let g: any = null;
export let zoom: any = null;

// Graph data
export let currentGraphData: WorkflowGraph = { nodes: [], edges: [], llms_detected: [], workflows: [] };

// Workflow groups
export let workflowGroups: WorkflowGroup[] = [];

// Original positions for reset
export let originalPositions: Map<string, NodePosition> = new Map();

// Minimap state
export let minimapSvg: any = null;
export let minimapViewportRect: any = null;

// UI state
export let currentlyOpenNodeId: string | null = null;

// Component state (expanded components - default is collapsed)
export let expandedComponents: Set<string> = new Set();

// Shared node copies: originalId -> [virtualIds]
export let sharedNodeCopies: Map<string, string[]> = new Map();

// Per-node dimensions: nodeId -> {width, height}
export let nodeDimensions: Map<string, { width: number; height: number }> = new Map();

// D3 selections for various elements
export let node: any = null;
export let link: any = null;
export let linkHover: any = null;
export let linkGroup: any = null;
export let collapsedGroups: any = null;
export let groupElements: any = null;
export let edgePathsContainer: any = null;
export let sharedArrowsContainer: any = null;
export let edgeLabelsContainer: any = null;
export let edgeLabelGroups: any = null;
export let edgesWithLabels: any[] = [];

// Expanded nodes (including virtual copies with positions)
export let expandedNodes: any[] = [];

// ELK edge routes: edgeId -> EdgeRoute
export let elkEdgeRoutes: Map<string, EdgeRoute> = new Map();

// Containers
export let groupContainer: any = null;
export let collapsedGroupContainer: any = null;

// Patterns
export let finePatternDot: any = null;
export let coarsePatternDot: any = null;
export let pegboardBg: any = null;

// Initialize core state
export function initState(
    vs: any,
    svgSelection: any,
    gSelection: any,
    zoomBehavior: any
): void {
    vscode = vs;
    svg = svgSelection;
    g = gSelection;
    zoom = zoomBehavior;
}

// Set graph data
export function setGraphData(data: WorkflowGraph): void {
    currentGraphData = data;
}

// Set workflow groups
export function setWorkflowGroups(groups: WorkflowGroup[]): void {
    workflowGroups = groups;
}

// Set original positions
export function setOriginalPositions(positions: Map<string, NodePosition>): void {
    originalPositions = positions;
}

// Set node selection
export function setNode(nodeSelection: any): void {
    node = nodeSelection;
}

// Set link selections
export function setLinkSelections(
    linkSelection: any,
    linkHoverSelection: any,
    linkGroupSelection: any
): void {
    link = linkSelection;
    linkHover = linkHoverSelection;
    linkGroup = linkGroupSelection;
}

// Set collapsed groups
export function setCollapsedGroups(collapsedGroupsSelection: any): void {
    collapsedGroups = collapsedGroupsSelection;
}

// Set group elements
export function setGroupElements(elements: any): void {
    groupElements = elements;
}

// Set edge paths container
export function setEdgePathsContainer(container: any): void {
    edgePathsContainer = container;
}

// Set containers
export function setContainers(groupCont: any, collapsedGroupCont: any): void {
    groupContainer = groupCont;
    collapsedGroupContainer = collapsedGroupCont;
}

// Set minimap state
export function setMinimapState(minimapSvgSelection: any, viewportRect: any): void {
    minimapSvg = minimapSvgSelection;
    minimapViewportRect = viewportRect;
}

// Set pattern dots
export function setPatternDots(fineDot: any, coarseDot: any, bg: any): void {
    finePatternDot = fineDot;
    coarsePatternDot = coarseDot;
    pegboardBg = bg;
}

// Set currently open node
export function setCurrentlyOpenNodeId(nodeId: string | null): void {
    currentlyOpenNodeId = nodeId;
}

// Get currently open node
export function getCurrentlyOpenNodeId(): string | null {
    return currentlyOpenNodeId;
}

// Set shared node copies map
export function setSharedNodeCopies(copies: Map<string, string[]>): void {
    sharedNodeCopies = copies;
}

// Get shared node copies
export function getSharedNodeCopies(): Map<string, string[]> {
    return sharedNodeCopies;
}

// Set node dimensions map
export function setNodeDimensions(dimensions: Map<string, { width: number; height: number }>): void {
    nodeDimensions = dimensions;
}

// Get stored node dimensions by ID
export function getStoredNodeDimensions(nodeId: string): { width: number; height: number } | undefined {
    return nodeDimensions.get(nodeId);
}

// Set shared arrows container
export function setSharedArrowsContainer(container: any): void {
    sharedArrowsContainer = container;
}

// Set edge labels state
export function setEdgeLabelsState(container: any, groups: any, edges: any[]): void {
    edgeLabelsContainer = container;
    edgeLabelGroups = groups;
    edgesWithLabels = edges;
}

// Set expanded nodes
export function setExpandedNodes(nodes: any[]): void {
    expandedNodes = nodes;
}

// Component state management
export function isComponentExpanded(componentId: string): boolean {
    return expandedComponents.has(componentId);
}

export function expandComponent(componentId: string): void {
    expandedComponents.add(componentId);
}

export function collapseComponent(componentId: string): void {
    expandedComponents.delete(componentId);
}

export function toggleComponent(componentId: string): void {
    if (expandedComponents.has(componentId)) {
        expandedComponents.delete(componentId);
    } else {
        expandedComponents.add(componentId);
    }
}

export function getExpandedComponents(): Set<string> {
    return expandedComponents;
}

export function setExpandedComponents(components: Set<string>): void {
    expandedComponents = components;
}

// Set ELK edge routes
export function setElkEdgeRoutes(routes: Map<string, EdgeRoute>): void {
    elkEdgeRoutes = routes;
}

// Get ELK edge route for an edge
export function getElkEdgeRoute(edgeId: string): EdgeRoute | undefined {
    return elkEdgeRoutes.get(edgeId);
}
