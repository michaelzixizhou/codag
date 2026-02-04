<div align="center">

<img src="https://raw.githubusercontent.com/michaelzixizhou/codag/main/logo.png" alt="Codag" width="128" />

# Codag

**See how your AI code actually works.**

</div>

Codag analyzes your code for LLM API calls and AI frameworks, then generates interactive workflow graphs — directly inside VSCode.

<p align="center">
  <img src="https://raw.githubusercontent.com/michaelzixizhou/codag/main/demo.gif" alt="Codag in action" width="800" />
</p>

## Why Codag?

AI codebases are hard to reason about. LLM calls are scattered across files, chained through functions, and wrapped in framework abstractions.

Codag does this automatically:

- **Extracts the workflow** — finds every LLM call, decision branch, and processing step across your codebase
- **Visualizes it as a graph** — interactive DAG with clickable nodes that link back to source code
- **Updates in real-time** — edit a file and watch the graph change instantly, no re-analysis needed

## Features

- **Automatic Workflow Detection** — point at your files, get a full AI pipeline graph
- **Live Graph Updates** — edit code, watch the graph change with green highlights on changed functions
- **Click-to-Source** — every node links to the exact function and line number
- **Export to PNG** — export workflow graphs as high-resolution images
## Supported Providers

**LLM Providers:** OpenAI, Anthropic, Google Gemini, Azure OpenAI, Vertex AI, AWS Bedrock, Mistral, xAI (Grok), Cohere, Ollama, Together AI, Replicate, Fireworks AI, AI21, DeepSeek, OpenRouter, Groq, Hugging Face

**Frameworks:** LangChain, LangGraph, Mastra, CrewAI, LlamaIndex, AutoGen, Haystack, Semantic Kernel, Pydantic AI, Instructor

**AI Services:** ElevenLabs, RunwayML, Stability AI, D-ID, HeyGen, and more

**IDE APIs:** VS Code Language Model API

**Languages:** Python, TypeScript, JavaScript (JSX/TSX), Go, Rust, Java, C, C++, Swift, Lua

## Getting Started

### 1. Start the Backend

Codag uses a self-hosted backend powered by Gemini 2.5 Flash. You'll need a [Gemini API key](https://aistudio.google.com/apikey) (free tier available).

```bash
git clone https://github.com/michaelzixizhou/codag.git
cd codag
cp backend/.env.example backend/.env
# Edit backend/.env and add your Gemini API key
docker compose up -d
```

Verify it's running: `curl http://localhost:52104/health`

See the full [setup guide](https://github.com/michaelzixizhou/codag#quick-start) for manual installation.

### 2. Use It

1. `Cmd+Shift+P` / `Ctrl+Shift+P` → **"Codag: Open"**
2. Select files containing LLM/AI code
3. Explore the graph — click nodes, zoom, pan

## Settings

| Setting | Default | Description |
|---------|---------|-------------|
| `codag.apiUrl` | `http://localhost:52104` | Backend API URL |

## License

[MIT](https://github.com/michaelzixizhou/codag/blob/main/LICENSE)
