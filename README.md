# AI Workflow Visualizer

VSCode extension that visualizes AI/LLM workflows using Gemini 2.5 Flash. Analyzes code containing LLM API calls and frameworks to generate interactive workflow graphs with critical path analysis.

## Features

- **Workspace-wide Analysis**: Scans entire workspace for AI workflow files
- **Interactive Graphs**: D3.js-powered visualization with pan, zoom, and click-to-navigate
- **Critical Path Highlighting**: Identifies longest execution path from entry to exit
- **Smart Caching**: AST-aware content hashing for efficient reanalysis
- **Workflow Grouping**: Automatically organizes nodes into logical workflows
- **Code Navigation**: Click nodes to view source and jump to code location
- **HUD Controls**: Expand/collapse workflows, format graph, refresh analysis

## Supported Technologies

**LLM APIs**: OpenAI, Anthropic, Gemini, Groq, Ollama, Cohere, Hugging Face
**Frameworks**: LangGraph, Mastra, LangChain, CrewAI

## Quick Start

```bash
make setup  # Install all dependencies
make run    # Start backend + launch extension
```

Requirements: Python 3.8+, Node.js 16+, VSCode

## Setup

### 1. Backend Setup

```bash
cd backend
python -m venv venv
source venv/bin/activate  # Windows: venv\Scripts\activate
pip install -r requirements.txt
```

Create `backend/.env`:
```bash
GEMINI_API_KEY=your-key-here
```

### 2. Frontend Setup

```bash
cd frontend
npm install
npm run compile
```

### 3. Launch Extension

Press F5 in VSCode to open extension development host.

## Usage

In the extension development window:

1. **Analyze Workspace**: `CMD+Shift+P` → "AI Workflow Visualizer: Analyze Workspace"
   - Scans workspace for LLM-related files
   - Analyzes all files together as unified workflow
   - Shows analysis time in output panel

2. **Visualize Current File**: `CMD+Shift+P` → "AI Workflow Visualizer: Visualize Current File"
   - Analyze single file

3. **Clear Cache**: `CMD+Shift+P` → "AI Workflow Visualizer: Clear Cache"
   - Forces reanalysis on next visualization

### Graph Controls

- **Pan/Zoom**: Click and drag to pan, scroll to zoom
- **Expand/Collapse All**: Purple button - toggle all workflows
- **Format Graph**: Blue button - reset layout and zoom
- **Refresh**: Red button - reanalyze and update graph
- **Minimap**: Bottom-left overview with viewport indicator
- **Legend**: Shows entry/exit points and critical path

### Interactions

- **Click nodes**: Opens side panel with source location and description
- **Click source link**: Jumps to code in editor
- **Hover edge labels**: Highlights entire edge path
- **Hover HUD icons**: Shows icon descriptions

## Workflow Components

The system identifies 8 node types:

- **Triggers** (orange): Entry points (API endpoints, main functions)
- **LLM Calls** (blue): LLM API invocations
- **Tools** (green): Functions callable by LLMs
- **Decisions** (purple): Conditional logic on LLM output
- **Integrations** (red-orange): External APIs, databases
- **Memory** (teal): State/conversation storage
- **Parsers** (brown): Data transformation, formatting
- **Output** (gray): Return statements, responses

### Special Indicators

- **Green outline**: Entry point nodes (workflow starts)
- **Blue outline**: Exit point nodes (workflow ends)
- **Red edge**: Critical path (longest execution time from entry to exit)

## Architecture

**Two-part system:**
- **Backend** (Python/FastAPI): Port 8000, uses Gemini 2.5 Flash for code analysis
- **Frontend** (TypeScript/VSCode): D3.js + Dagre visualization in webview panel

**Data Flow:**
1. Frontend detects LLM files via regex patterns (`analyzer.ts`)
2. Sends code to backend `/analyze` endpoint with file metadata
3. Backend uses Gemini to extract workflow nodes/edges (`gemini_client.py`)
4. Frontend caches results using workspace-level content hash (`cache.ts`)
5. Webview displays interactive graph with separate containers for edges/labels

**Key Design Decisions:**
- **AST-aware caching**: Only hashes LLM-relevant code (ignores comments/whitespace)
- **Workspace-level caching**: Preserves cross-file edges in batch analysis
- **Deterministic file ordering**: Sorts files by path before hashing for consistent cache hits
- **Separated SVG layers**: Edge paths render beneath all edge labels
- **Critical path validation**: Enforces singular linear path from entry to exit
- **Workflow connectivity**: All nodes in workflow must be reachable via edges

**Note**: Auth is currently disabled (TODOs exist in code for re-enabling).

## Development Commands

```bash
make run      # Compile frontend, start backend, launch extension
make stop     # Stop backend server
make debug    # Launch extension without starting backend
make setup    # Install dependencies
```

Manual backend start:
```bash
cd backend
. venv/bin/activate
python main.py  # Runs on http://localhost:8000
```

## Key Files

**Backend:**
- `gemini_client.py` - LLM prompt for workflow extraction with validation rules
- `models.py` - Pydantic models (`WorkflowGraph`, `SourceLocation`, `WorkflowNode`)
- `analyzer.py` - Static analysis patterns for LLM detection
- `main.py` - FastAPI server with `/analyze` endpoint

**Frontend:**
- `extension.ts` - VSCode commands, analysis orchestration, caching logic
- `webview.ts` - D3.js/Dagre visualization with tooltips, side panel, minimap
- `webview/styles.ts` - All CSS styling including node types and hover effects
- `webview/icons.ts` - SVG icons for each node type
- `analyzer.ts` - Client-side LLM detection patterns
- `cache.ts` - Workspace-level caching with AST-aware hashing
- `static-analyzer.ts` - TypeScript/Python AST parsing for content hashing
- `metadata-builder.ts` - File dependency analysis and batching

## Adding LLM Providers

1. Add import pattern to `frontend/src/analyzer.ts` → `LLM_CLIENT_PATTERNS`
2. Add API call pattern to `frontend/src/analyzer.ts` → `LLM_CALL_PATTERNS`
3. Add detection logic to `backend/gemini_client.py` → "DETECT LLM PROVIDERS" section
4. Run `cd frontend && npm run compile`

## Future Enhancements

### Consider Migrating to Dagre Compound Graphs

The current layout system uses manual bounding box calculation and overlap resolution. A cleaner approach would be to use **Dagre's built-in compound graph support**:

**Benefits:**
- Native workflow grouping (no manual bounds calculation)
- Automatic layout optimization for grouped nodes
- Eliminates manual overlap resolution algorithm
- More maintainable and predictable layout behavior

**Implementation:**
- Enable `compound: true` in Dagre graph config
- Define workflow groups as parent nodes: `dagreGraph.setNode(workflowId, { isGroup: true })`
- Set parent-child relationships: `dagreGraph.setParent(nodeId, workflowId)`
- Let Dagre compute group bounds automatically

**Trade-offs:**
- Requires refactoring collapse/expand logic (currently visual-only CSS)
- Could implement dynamic re-layout on collapse (remove nodes from graph) or keep current visual-only approach
- Migration effort moderate but would future-proof the visualization system
