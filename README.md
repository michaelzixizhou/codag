# Codag

**CO**mpound **D**irected **A**cyclic **G**raphs

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

Requirements: Python 3.8+, Node.js 16+, VSCode 1.95+

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
SECRET_KEY=your-secret-key
GEMINI_API_KEY=your-gemini-key

# PostgreSQL (for auth & trial tracking)
DATABASE_URL=postgresql+asyncpg://localhost/codag

# OAuth (optional - for sign-up flow)
GITHUB_CLIENT_ID=xxx
GITHUB_CLIENT_SECRET=xxx
GOOGLE_CLIENT_ID=xxx
GOOGLE_CLIENT_SECRET=xxx
```

Create the database:
```bash
createdb codag
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

1. **Analyze Workspace**: `CMD+Shift+P` → "Codag: Auto-detect and Visualize"
   - Scans workspace for LLM-related files
   - Analyzes all files together as unified workflow
   - Shows analysis time in output panel

2. **Visualize Current File**: `CMD+Shift+P` → "Codag: Visualize Current File"
   - Analyze single file

3. **Clear Cache**: `CMD+Shift+P` → "Codag: Clear Cache"
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

The system identifies 3 node types:

- **Step** (rectangle): Any processing - API endpoints, functions, parsing, formatting, database calls, returns
- **LLM** (stadium shape): LLM/AI API calls only (.chat.completions, .generate_content, etc.)
- **Decision** (diamond): Explicit if/else or switch/match branching (must have 2+ labeled outgoing edges)

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
- **Per-file caching**: Each file cached independently; only changed files reanalyzed
- **Cross-batch structure preservation**: Tree-sitter pre-parse enables cross-file edges even when files are in different LLM batches
- **Separated SVG layers**: Edge paths render beneath all edge labels
- **Workflow connectivity**: All nodes in workflow must be reachable via edges

**Authentication:**
- **Trial Mode**: New users get 5 analyses/day tracked by VSCode `machineId`
- **OAuth**: GitHub and Google sign-in for unlimited access
- **URI Callback**: OAuth flow redirects via `vscode://codag/auth/callback`

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
- `cache.ts` - Per-file caching with AST-aware hashing
- `static-analyzer.ts` - TypeScript/Python AST parsing for content hashing
- `metadata-builder.ts` - File dependency analysis and batching
- `repo-structure-extractor.ts` - Pre-parses all files for cross-batch context
- `cross-batch-merger.ts` - Resolves placeholder nodes after batches complete

## Adding LLM Providers

1. Add import pattern to `frontend/src/analyzer.ts` → `LLM_CLIENT_PATTERNS`
2. Add API call pattern to `frontend/src/analyzer.ts` → `LLM_CALL_PATTERNS`
3. Add detection logic to `backend/gemini_client.py` → "DETECT LLM PROVIDERS" section
4. Run `cd frontend && npm run compile`

## Known Limitations

### Export Functionality (Temporarily Removed)

Export buttons (SVG, PNG, Markdown) were removed in commit `2750e0d`. To restore:

```bash
git revert 2750e0d  # Or cherry-pick specific export functionality
```

The export feature will be re-implemented with improved UX in a future update.

## Contributing

### Branch Strategy

- Create feature branches from `main`: `feature/your-feature-name`
- Open PRs against `main`
- Squash merge preferred

### Code Style

**TypeScript (Frontend):**
- ESLint + Prettier (run `npm run lint`)
- 4-space indentation
- Single quotes for strings

**Python (Backend):**
- Black formatter (run `black .`)
- Type hints encouraged
- 4-space indentation

### Pull Request Process

1. Ensure `npm run compile` passes with no errors
2. Test the extension manually (`make run`)
3. Update CLAUDE.md if adding new patterns or conventions
4. Keep PRs focused—one feature or fix per PR

---

## Development

### Troubleshooting

**Backend won't start:**
```bash
# Check if port 8000 is in use
lsof -i :8000
# Kill existing process if needed
make stop
```

**Database connection errors:**
```bash
# Ensure PostgreSQL is running
brew services start postgresql  # macOS
# Create database if missing
createdb codag
```

**OAuth not working:**
- Verify `.env` has valid `GITHUB_CLIENT_ID`, `GITHUB_CLIENT_SECRET`
- Check callback URL matches: `http://localhost:8000/auth/github/callback`

**Extension not loading:**
- Run `npm run compile` in `frontend/`
- Check VSCode Output panel → "Codag" for errors

### Debug Logging

- Backend logs: `backend/backend.log`
- Backend PID: `backend/backend.pid`
- Extension logs: VSCode Output panel → "Codag"

### Hot Reload

Backend doesn't hot-reload. After Python changes:
```bash
make stop && make run
```

Frontend TypeScript auto-compiles with `npm run watch`.

---

## API Reference

### POST `/analyze`

Analyzes code for LLM workflow patterns.

**Request:**
```json
{
  "code": "# File: path/to/file.py\nimport openai...",
  "metadata": [
    {
      "file": "path/to/file.py",
      "locations": [{"line": 10, "type": "llm_call", "function": "main"}]
    }
  ]
}
```

**Response:**
```json
{
  "nodes": [...],
  "edges": [...],
  "llms_detected": ["openai"],
  "workflows": [{"id": "...", "name": "...", "nodeIds": [...]}]
}
```

**Headers:**
- `X-Device-ID`: VSCode machine ID (for trial tracking)
- `Authorization`: `Bearer <token>` (for authenticated users)

### GET `/auth/device/check`

Check trial status for a device.

**Headers:** `X-Device-ID`

**Response:**
```json
{
  "machine_id": "...",
  "remaining_analyses": 5,
  "is_trial": true,
  "is_authenticated": false
}
```

### OAuth Endpoints

- `GET /auth/github` - Initiate GitHub OAuth
- `GET /auth/google` - Initiate Google OAuth
- Callbacks redirect to `vscode://codag.codag/auth/callback?token=...`

---

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
