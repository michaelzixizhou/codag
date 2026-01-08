// Webview constants - centralized magic numbers

// ===== NODE DIMENSIONS =====
export const NODE_WIDTH = 140;
export const NODE_HEIGHT = 122;
export const NODE_HALF_WIDTH = 70;
export const NODE_HALF_HEIGHT = 61;
export const NODE_BORDER_RADIUS = 4;

// ===== COLLAPSED GROUP DIMENSIONS =====
export const COLLAPSED_GROUP_WIDTH = 260;
export const COLLAPSED_GROUP_HEIGHT = 150;
export const COLLAPSED_GROUP_HALF_WIDTH = 130;
export const COLLAPSED_GROUP_HALF_HEIGHT = 75;
export const COLLAPSED_GROUP_BORDER_RADIUS = 12;

// ===== COLLAPSED COMPONENT DIMENSIONS =====
export const COLLAPSED_COMPONENT_WIDTH = 180;
export const COLLAPSED_COMPONENT_HEIGHT = 80;
export const COLLAPSED_COMPONENT_HALF_WIDTH = 90;
export const COLLAPSED_COMPONENT_HALF_HEIGHT = 40;
export const COLLAPSED_COMPONENT_BORDER_RADIUS = 8;

// ===== GROUP BOUNDS PADDING =====
export const GROUP_BOUNDS_PADDING_X = 90;
export const GROUP_BOUNDS_PADDING_TOP = 126;
export const GROUP_BOUNDS_PADDING_BOTTOM = 81;

// ===== GROUP UI OFFSETS =====
export const GROUP_TITLE_OFFSET_X = 40;
export const GROUP_TITLE_OFFSET_Y = 24;
export const GROUP_COLLAPSE_BTN_X = 10;
export const GROUP_COLLAPSE_BTN_Y = 8;
export const GROUP_COLLAPSE_BTN_SIZE = 24;
export const GROUP_STROKE_WIDTH = 3;

// ===== EDGE STYLING =====
export const EDGE_STROKE_WIDTH = 6;
export const EDGE_HOVER_STROKE_WIDTH = 8;
export const EDGE_HOVER_HIT_WIDTH = 20;
export const EDGE_COLOR_HOVER = '#00d9ff';

// ===== ANIMATIONS =====
export const TRANSITION_FAST = 300;
export const TRANSITION_NORMAL = 500;
export const VIEWPORT_UPDATE_DELAY = 150;

// ===== DAGRE LAYOUT =====
export const DAGRE_NODESEP = 50;
export const DAGRE_RANKSEP = 78;
export const DAGRE_MARGIN = 30;
export const WORKFLOW_SPACING = 75;

// ===== INTERACTION =====
export const DRAG_THRESHOLD = 5;
export const GRID_SIZE = 5;
export const TOOLTIP_OFFSET_X = 15;
export const TOOLTIP_OFFSET_Y = 10;

// ===== MINIMAP =====
export const MINIMAP_PADDING = 10;

// ===== NODE ICON =====
export const NODE_ICON_SCALE = 0.8;

// ===== ARROW =====
export const ARROW_HEAD_LENGTH = 16.8;

// ===== TYPE COLORS =====
export const TYPE_COLORS: Record<string, string> = {
    'trigger': '#FFB74D',      // Orange - entry points
    'llm': '#64B5F6',          // Blue - LLM API calls
    'tool': '#81C784',         // Green - functions/tools
    'decision': '#BA68C8',     // Purple - conditional logic
    'integration': '#FF8A65',  // Coral - external APIs
    'memory': '#4DB6AC',       // Teal - state storage
    'parser': '#A1887F',       // Brown - data transformation
    'output': '#90A4AE',       // Gray - results/responses
    'orchestrator': '#E040FB', // Magenta - coordinates multiple services
    'agent': '#FF4081',        // Pink - autonomous AI agents
    'retriever': '#7C4DFF',    // Deep purple - RAG/vector search
    'guardrail': '#FFAB00'     // Amber - safety checks
};
