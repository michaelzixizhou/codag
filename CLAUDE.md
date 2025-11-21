# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project Overview

VSCode extension that visualizes AI/LLM workflows using Gemini 2.5 Flash. Analyzes code containing LLM API calls (OpenAI, Anthropic, Gemini, Groq, Ollama, Cohere, Hugging Face) and frameworks (LangGraph, Mastra, LangChain, CrewAI) to generate interactive workflow graphs.

## Architecture

**Two-part system:**
1. **Backend (Python/FastAPI)**: Runs on port 8000, uses Gemini 2.5 Flash for code analysis
2. **Frontend (TypeScript/VSCode Extension)**: Embeds D3.js + Dagre visualization in webview panel

**Data Flow:**
- Frontend detects LLM files via regex patterns (`frontend/src/analyzer.ts`)
- Static analyzer extracts code locations (`frontend/src/static-analyzer.ts`)
- Metadata builder creates file batches (`frontend/src/metadata-builder.ts`)
- Sends code to backend `/analyze` endpoint with file metadata
- Backend uses Gemini to extract workflow nodes/edges (`backend/gemini_client.py`)
- Frontend caches results per-file using AST-aware content hash (`frontend/src/cache.ts`)
- Webview displays interactive graph with clickable nodes (`frontend/src/webview.ts`)

**Key Design Decisions:**
- Auth is **disabled** (TODOs in code for re-enabling)
- Multi-file analysis: Combines files with `# File: path` markers
- Deterministic LLM output: Temperature 0.0, specific prompt structure
- **AST-aware caching**: Only hashes LLM-relevant code (ignores comments/whitespace changes)
- **Per-file caching**: Each file cached independently; only changed files reanalyzed (no cross-file edges)
- **Separated SVG layers**: Edge paths container rendered before edge labels container
- **Critical path validation**: Must start at entry point, end at exit point, no branching
- **Workflow connectivity**: All nodes must be reachable via edges, no orphaned nodes

## Commands

**Setup:**
```bash
make setup          # Install backend + frontend dependencies
```

**Development:**
```bash
make run            # Compile frontend, start backend, launch extension
make stop           # Stop backend server
make debug          # Launch extension without starting backend
```

**Manual:**
```bash
# Backend
cd backend
. venv/bin/activate
python main.py      # Starts on port 8000

# Frontend
cd frontend
npm run compile     # Compile TypeScript
# Then press F5 in VSCode to launch extension
```

## Critical Files

**Backend:**
- `backend/gemini_client.py` - LLM prompt for workflow extraction with strict validation rules (lines 17-280)
  - Critical path rules: Must start at entry, end at exit, no branching (lines 207-235)
  - Workflow connectivity validation: All nodes must be reachable (lines 262-279)
- `backend/models.py` - Pydantic models including `WorkflowGraph`, `SourceLocation`, `WorkflowNode`
- `backend/analyzer.py` - Static analysis patterns for LLM detection
- `backend/main.py` - FastAPI server with `/analyze` endpoint

**Frontend:**
- `frontend/src/extension.ts` - VSCode commands, analysis orchestration, timing logs, handles `openFile` messages
- `frontend/src/webview.ts` - D3.js/Dagre visualization with:
  - Separate containers for edge paths (bottom layer) and edge labels (top layer) (lines 928-956)
  - Edge hover handlers for both regular and critical paths (lines 969-1015)
  - Smart tooltip positioning to prevent cutoff (lines 1542-1578)
  - Expand/collapse all workflows functionality (lines 1422-1439)
  - Edge label visibility logic for collapsed groups (lines 1330-1356)
- `frontend/src/webview/styles.ts` - All CSS styling (NO `!important` on critical path for hover to work)
- `frontend/src/webview/icons.ts` - SVG icons for 8 node types
- `frontend/src/analyzer.ts` - Client-side LLM detection patterns
- `frontend/src/cache.ts` - Per-file caching with AST-aware hashing (`getPerFile`, `setPerFile`, `getMultiplePerFile`)
- `frontend/src/static-analyzer.ts` - TypeScript/Python AST parsing for LLM-relevant code extraction
- `frontend/src/metadata-builder.ts` - File dependency analysis and batching logic

## Workflow Node Types

The system identifies 8 node types (defined in Gemini prompt):
1. **trigger** - Entry points (API endpoints, main functions)
2. **llm** - LLM API calls
3. **tool** - Functions called by/available to LLM
4. **decision** - Conditional logic on LLM output
5. **integration** - External APIs, databases
6. **memory** - State/conversation storage
7. **parser** - Data transformation, formatting
8. **output** - Return statements, responses

Each node includes `source: {file, line, function}` for code navigation.

## Modifying LLM Detection

**Add new LLM provider:**
1. Add import pattern to `frontend/src/analyzer.ts` → `LLM_CLIENT_PATTERNS`
2. Add API call pattern to `frontend/src/analyzer.ts` → `LLM_CALL_PATTERNS`
3. Add detection logic to `backend/gemini_client.py` → "DETECT LLM PROVIDERS" section
4. Run `cd frontend && npm run compile`

**Change prompt behavior:**
- Edit `backend/gemini_client.py` lines 17-280 (main prompt structure)
- Key sections:
  - Node type definitions: Lines ~50-100
  - Critical path rules: Lines 207-235
  - Workflow connectivity validation: Lines 262-279
- Restart backend: `make stop && make run`
- Clear cache via command palette: "AI Workflow Visualizer: Clear Cache"

## Known Issues & Solutions

**Critical path edge hover not working:**
- Cause: CSS `!important` declarations override inline hover styles
- Solution: Remove `!important` from `.link.critical-path` in `styles.ts`

**Edge labels overlap edges:**
- Cause: DOM rendering order (edges and labels interleaved)
- Solution: Separate containers - `edgePathsContainer` before `edgeLabelsContainer`

**Edge labels visible on collapsed workflows:**
- Cause: Labels not checking if endpoints are in same collapsed group
- Solution: Hide labels when both source/target in same collapsed group (`webview.ts` lines 1330-1356)

## Visualization

- **Layout**: Dagre hierarchical (left-to-right, rank direction LR)
- **HUD Controls**:
  - Purple button: Expand/collapse all workflows
  - Blue button: Format graph (reset zoom and layout)
  - Red button: Refresh (reanalyze and update)
- **Interactions**:
  - Click node → opens side panel with source link and description
  - Hover edge label → highlights entire edge path
  - Hover HUD icon → shows tooltip with icon name
- **Navigation**: Clicking source link in side panel jumps to code in editor
- **Styling**: VSCode theme variables, colored icons per node type
- **Special Indicators**:
  - Green outline: Entry point nodes (isEntryPoint: true)
  - Blue outline: Exit point nodes (isExitPoint: true)
  - Red edge: Critical path (isCriticalPath: true)
- **Minimap**: Bottom-left corner with viewport rectangle
- **Legend**: Bottom-left above minimap, shows entry/exit/critical path indicators

## Environment

Requires `backend/.env` with:
```
GEMINI_API_KEY=your-key-here
```

Backend logs to `backend.log`, PID stored in `backend.pid`.
