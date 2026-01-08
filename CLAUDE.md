# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project Overview

**Codag** (COmpound Directed Acyclic Graphs) - VSCode extension that visualizes AI/LLM workflows using Gemini 2.5 Flash. Analyzes code containing LLM API calls (OpenAI, Anthropic, Gemini, Groq, Ollama, Cohere, Hugging Face) and frameworks (LangGraph, Mastra, LangChain, CrewAI) to generate interactive workflow graphs.

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
- Multi-file analysis: Combines files with `# File: path` markers
- Deterministic LLM output: Temperature 0.0, specific prompt structure
- **AST-aware caching**: Only hashes LLM-relevant code (ignores comments/whitespace changes)
- **Per-file caching**: Each file cached independently; only changed files reanalyzed (no cross-file edges)
- **Separated SVG layers**: Edge paths container rendered before edge labels container
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
- `backend/gemini_client.py` - Async LLM calls using `asyncio.to_thread()` for non-blocking concurrency
- `backend/prompts.py` - LLM prompt for workflow extraction with strict validation rules
- `backend/models.py` - Pydantic models including `WorkflowGraph`, `SourceLocation`, `WorkflowNode`, `OAuthUser`, `DeviceCheckResponse`
- `backend/analyzer.py` - Static analysis patterns for LLM detection
- `backend/main.py` - FastAPI server with `/analyze`, OAuth endpoints (`/auth/github`, `/auth/google`, `/auth/device`)
- `backend/database.py` - Async SQLAlchemy models (`UserDB`, `TrialDeviceDB`), PostgreSQL connection
- `backend/oauth.py` - GitHub/Google OAuth configuration via authlib

**Frontend:**
- `frontend/src/extension.ts` - VSCode commands, analysis orchestration, timing logs, handles `openFile` messages
- `frontend/src/webview-client/` - D3.js/Dagre visualization (modular)
- `frontend/src/webview/styles.ts` - All CSS styling
- `frontend/src/webview/icons.ts` - SVG icons for 8 node types
- `frontend/src/analyzer.ts` - Client-side LLM detection patterns
- `frontend/src/cache.ts` - Per-file caching with AST-aware hashing (`getPerFile`, `setPerFile`, `getMultiplePerFile`)
- `frontend/src/static-analyzer.ts` - TypeScript/Python AST parsing for LLM-relevant code extraction
- `frontend/src/metadata-builder.ts` - File dependency analysis and batching logic
- `frontend/src/auth.ts` - AuthManager class, OAuth flow, device ID tracking via `vscode.env.machineId`
- `frontend/src/api.ts` - APIClient with `X-Device-ID` header, `TrialExhaustedError` handling
- `frontend/src/webview-client/auth.ts` - Auth panel UI logic, trial tag updates

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
- Edit `backend/prompts.py` (main prompt structure)
- Restart backend: `make stop && make run`
- Clear cache via command palette: "Codag: Clear Cache"

## Known Issues & Solutions

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
- **Minimap**: Bottom-left corner with viewport rectangle
- **Legend**: Bottom-left above minimap, shows entry/exit indicators

## Authentication & Trial System

**User Flow:**
1. New users start in **trial mode** (no sign-up required)
2. Trial: 5 analyses/day, tracked by `vscode.env.machineId`
3. Header shows "TRIAL 5/5" tag + "Sign Up" button
4. Clicking "Sign Up" or exhausting trial opens auth panel
5. OAuth via GitHub or Google grants unlimited access

**Architecture:**
- `backend/database.py` - PostgreSQL models (`users`, `trial_devices`)
- `backend/oauth.py` - GitHub/Google OAuth handlers via authlib
- `backend/main.py` - OAuth endpoints (`/auth/github`, `/auth/google`, `/auth/device`)
- `frontend/src/auth.ts` - AuthManager with OAuth flow, device ID tracking
- `frontend/src/webview-client/auth.ts` - Auth panel UI logic

**OAuth Flow:**
1. User clicks OAuth button → extension opens browser
2. Browser → `http://localhost:8000/auth/github` (or google)
3. Provider authenticates → callback to backend
4. Backend creates JWT → redirects to `vscode://codag/auth/callback?token=xxx`
5. Extension URI handler receives token, stores in globalState
6. Device linked to user for future tracking

**Key Files:**
- `backend/database.py` - SQLAlchemy models, trial quota logic
- `backend/oauth.py` - OAuth provider configuration
- `frontend/src/auth.ts` - AuthManager class
- `frontend/src/webview-client/auth.ts` - Auth panel handlers
- `frontend/media/webview/index.html` - Auth section + panel HTML
- `frontend/media/webview/styles.css` - Auth styles

## Environment

Requires `backend/.env` with:
```
SECRET_KEY=your-secret-key
GEMINI_API_KEY=your-gemini-key
DATABASE_URL=postgresql+asyncpg://localhost/codag

# OAuth credentials
GITHUB_CLIENT_ID=xxx
GITHUB_CLIENT_SECRET=xxx
GOOGLE_CLIENT_ID=xxx
GOOGLE_CLIENT_SECRET=xxx
```

Database setup:
```bash
createdb codag  # Tables auto-created on startup
```

Backend logs to `backend.log`, PID stored in `backend.pid`.
