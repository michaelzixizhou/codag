<div align="center">

<img src="https://raw.githubusercontent.com/michaelzixizhou/codag/main/logo.png" alt="Codag" width="128" />

# Codag

**Visualize AI/LLM workflows in your codebase.**

[![VS Code Marketplace](https://img.shields.io/visual-studio-marketplace/v/codag.codag?label=VS%20Code%20Marketplace)](https://marketplace.visualstudio.com/items?itemName=codag.codag)
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](LICENSE)
[![GitHub Stars](https://img.shields.io/github/stars/michaelzixizhou/codag)](https://github.com/michaelzixizhou/codag/stargazers)
[![PRs Welcome](https://img.shields.io/badge/PRs-welcome-brightgreen.svg)](https://github.com/michaelzixizhou/codag/pulls)

</div>

---

Codag is a VSCode extension that analyzes code containing LLM API calls and AI frameworks, then generates interactive workflow graphs showing how data flows through your AI pipelines.

![Codag Demo](https://raw.githubusercontent.com/michaelzixizhou/codag/main/demo.png)

## Supported Providers

**LLM APIs**: OpenAI, Anthropic, Google Gemini, Azure OpenAI, Vertex AI, AWS Bedrock, Mistral, xAI (Grok), Cohere, Ollama, Together AI, Replicate, Fireworks AI, AI21, DeepSeek, OpenRouter, Groq, Hugging Face

**Frameworks**: LangChain, LangGraph, Mastra, CrewAI, LlamaIndex, AutoGen, Haystack, Semantic Kernel, Pydantic AI, Instructor

**AI Services**: ElevenLabs, RunwayML, Stability AI, D-ID, HeyGen, and more

## Quick Start

```bash
git clone https://github.com/michaelzixizhou/codag.git
cd codag
echo "GEMINI_API_KEY=your-key" > backend/.env
make setup && make run
```

You'll need a [Gemini API key](https://aistudio.google.com/apikey) (free tier available).

**Requirements:** Python 3.11+, Node.js 16+, VSCode 1.95+

## Self-Hosting the Backend

### Option A: Docker (recommended)

```bash
echo "GEMINI_API_KEY=your-key" > backend/.env
docker compose up -d
```

The backend will be running at `http://localhost:52104`.

### Option B: Manual

```bash
cd backend
python3.11 -m venv venv
source venv/bin/activate
pip install -r requirements.txt
python main.py
```

### Frontend Setup

After the backend is running:

```bash
cd frontend
npm install
npm run compile
```

Then press **F5** in VSCode to launch the extension development host.

## Usage

1. Open the command palette (`Cmd+Shift+P` / `Ctrl+Shift+P`)
2. Run **"Codag: Open"**
3. Select files containing LLM/AI code using the file picker
4. Explore the generated workflow graph
5. Click any node to see its description and jump to source code

### Controls

| Control | Action |
|---------|--------|
| Scroll | Zoom in/out |
| Click + drag | Pan |
| Click node | Open details panel |
| **+** / **−** | Zoom in/out |
| Fit to screen | Fit entire graph in view |
| Grid button | Reset layout |
| Folder button | Pick files to analyze |

## How It Works

Codag is a two-part system:

1. **Frontend** (TypeScript/VSCode extension) scans your workspace for files that use LLM APIs, extracts code structure with tree-sitter, and renders interactive D3.js graphs
2. **Backend** (Python/FastAPI) sends code to Gemini 2.5 Flash which identifies workflow nodes, edges, and decision points

The frontend caches results per-file using AST-aware content hashing — only files with meaningful code changes get reanalyzed. When you edit a file, tree-sitter provides instant local graph updates without waiting for the LLM.

### Node Types

- **Step** — Any processing: API calls, functions, parsing, database queries
- **LLM** — LLM/AI API calls (chat completions, content generation, etc.)
- **Decision** — Branching logic with 2+ labeled outgoing edges

## Adding a Provider

Add an entry to the `LLM_PROVIDERS` array in [`frontend/src/providers.ts`](frontend/src/providers.ts):

```ts
{
    id: 'new-provider',
    displayName: 'New Provider',
    identifiers: ['newprovider'],
    importPatterns: [/from\s+newprovider/i],
    callPatterns: [/\.generate\s*\(/],
},
```

Then run `cd frontend && npm run compile`. No backend changes needed.

## Development

```bash
make run          # Compile + start backend + launch extension
make stop         # Stop backend
make debug        # Launch extension without backend
make setup        # Install all dependencies
make docker-up    # Start backend with Docker
make docker-down  # Stop Docker backend
```

### Troubleshooting

**Backend won't start:** `lsof -i :52104` to check for port conflicts, `make stop` to kill it.

**Extension not loading:** Run `npm run compile` in `frontend/`, check the "Codag" output panel in VSCode.

**Backend doesn't hot-reload.** After Python changes: `make stop && make run`. Frontend supports `npm run watch`.

## Contributing

See [CONTRIBUTING.md](CONTRIBUTING.md) for guidelines.

## License

[MIT](LICENSE)
