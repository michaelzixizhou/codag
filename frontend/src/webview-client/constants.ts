// Webview constants - centralized magic numbers

// ===== NODE DIMENSIONS =====
export const NODE_WIDTH = 200;
export const NODE_HEIGHT = 54;
export const NODE_HALF_WIDTH = 100;
export const NODE_HALF_HEIGHT = 27;
export const NODE_BORDER_RADIUS = 4;

// ===== COLLAPSED GROUP DIMENSIONS =====
export const COLLAPSED_GROUP_WIDTH = 260;
export const COLLAPSED_GROUP_HEIGHT = 150;
export const COLLAPSED_GROUP_HALF_WIDTH = 130;
export const COLLAPSED_GROUP_HALF_HEIGHT = 75;
export const COLLAPSED_GROUP_BORDER_RADIUS = 12;

// ===== COMPONENT STYLING =====
export const COMPONENT_PADDING = 20; // padding around grouped nodes
export const COMPONENT_CORNER_CUT = 0.15; // octagon corner cut ratio (proportion of smaller dimension)

// ===== GROUP BOUNDS PADDING =====
// Visual gap beyond node edges (must be symmetric for consistent workflow spacing)
export const GROUP_BOUNDS_PADDING_X = 20;
export const GROUP_BOUNDS_PADDING_TOP = 20;
export const GROUP_BOUNDS_PADDING_BOTTOM = 20;

// ===== GROUP UI OFFSETS =====
export const GROUP_TITLE_OFFSET_X = 40;
export const GROUP_TITLE_OFFSET_Y = 24;
export const GROUP_COLLAPSE_BTN_X = 10;
export const GROUP_COLLAPSE_BTN_Y = 8;
export const GROUP_COLLAPSE_BTN_SIZE = 24;
export const GROUP_STROKE_WIDTH = 1.5;

// ===== EDGE STYLING =====
export const EDGE_STROKE_WIDTH = 2.8;
export const EDGE_HOVER_STROKE_WIDTH = 3.5;
export const EDGE_HOVER_HIT_WIDTH = 20;
export const EDGE_COLOR_HOVER = '#00d9ff';

// ===== ANIMATIONS =====
export const TRANSITION_FAST = 300;
export const TRANSITION_NORMAL = 500;
export const VIEWPORT_UPDATE_DELAY = 150;

// ===== LAYOUT =====
export const WORKFLOW_SPACING = 15;

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
export const ARROW_HEAD_LENGTH = 8;

// ===== TYPE COLORS =====
export const TYPE_COLORS: Record<string, string> = {
    'trigger': '#FFB74D',      // Orange - entry points
    'llm': '#1E88E5',          // Blue - LLM API calls (darker for contrast)
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
