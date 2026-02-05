<div align="center">

<img src="media/logo.png" alt="Codag" width="128" />

# Codag

**See how your AI code actually works.**

[![VS Code Marketplace](https://img.shields.io/visual-studio-marketplace/v/codag.codag?label=VS%20Code%20Marketplace&color=7c83ff)](https://marketplace.visualstudio.com/items?itemName=codag.codag)
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](LICENSE)
[![GitHub Stars](https://img.shields.io/github/stars/michaelzixizhou/codag?style=flat)](https://github.com/michaelzixizhou/codag/stargazers)
[![PRs Welcome](https://img.shields.io/badge/PRs-welcome-brightgreen.svg)](https://github.com/michaelzixizhou/codag/pulls)
<!-- [![Discord](https://img.shields.io/discord/YOUR_SERVER_ID?color=5865F2&label=Discord)](https://discord.gg/YOUR_INVITE) -->

Codag analyzes your code for LLM API calls and AI frameworks, then generates interactive workflow graphs — directly inside VSCode.

</div>

<br/>

<p align="center">
  <img src="media/demo.gif" alt="Codag in action" width="800" />
</p>

<p align="center">
  <strong>If you find Codag useful, please consider giving it a ⭐ — it helps others discover the project!</strong>
</p>

### Gallery

<p align="center">
  <img src="media/aichatbot.png" alt="Vercel AI Chatbot" width="800" /><br/>
  <a href="https://github.com/vercel/ai-chatbot"><strong>vercel/ai-chatbot</strong></a>
</p>

<p align="center">
  <img src="media/langchain.png" alt="LangChain" width="800" /><br/>
  <a href="https://github.com/langchain-ai/langchain"><strong>langchain-ai/langchain</strong></a>
</p>

<p align="center">
  <img src="media/trycua.png" alt="TryCua" width="800" /><br/>
  <a href="https://github.com/trycua/cua"><strong>trycua/cua</strong></a>
</p>

## Why Codag?

You're building an AI agent that chains 3 LLM calls across 5 files. A prompt change breaks something downstream. Which call? Which branch? You `grep` for `openai.chat`, open 8 tabs, and mentally trace the flow. Again.

Or you're onboarding onto someone's LangChain project — 20 files, tool calls inside tool calls, retry logic wrapping everything. The README says "it's straightforward." It's not.

Codag maps it out for you:

- **Extracts the workflow** — finds every LLM call, decision branch, and processing step across your entire codebase
- **Visualizes it as a graph** — interactive DAG with clickable nodes that link back to source code
- **Updates in real-time** — edit a file and watch the graph change instantly, no re-analysis needed

**Built for** AI engineers, agent builders, and anyone maintaining code that talks to LLMs — whether it's a single OpenAI call or a multi-agent LangGraph pipeline.

## Features

### Automatic Workflow Detection

Point Codag at your files and it maps out the entire AI pipeline — LLM calls, branching logic, data transformations — without any configuration.

<!-- ![Workflow Detection](features/workflow-detection.png) -->

### Live Graph Updates

Edit your code and the graph updates instantly using tree-sitter parsing. Changed functions get a green highlight so you can see exactly what moved.

<!-- ![Live Updates](features/live-updates.gif) -->

### Click-to-Source Navigation

Every node links back to the exact function and line number. Click a node to open the side panel, click the source link to jump straight to the code.

<!-- ![Click to Source](features/click-to-source.gif) -->

### Export to PNG

Export your workflow graphs as high-resolution PNG images — the entire graph or individual workflows.

### Native Theme Support

Graphs automatically match your VS Code theme — light or dark. No configuration needed.

<details>
<summary><strong>Supported Providers & Frameworks</strong></summary>

<br/>

**LLM Providers:** OpenAI, Anthropic, Google Gemini, Azure OpenAI, Vertex AI, AWS Bedrock, Mistral, xAI (Grok), Cohere, Ollama, Together AI, Replicate, Fireworks AI, AI21, DeepSeek, OpenRouter, Groq, Hugging Face

**Frameworks:** LangChain, LangGraph, Mastra, CrewAI, LlamaIndex, AutoGen, Haystack, Semantic Kernel, Pydantic AI, Instructor

**AI Services:** ElevenLabs, RunwayML, Stability AI, D-ID, HeyGen, and more

**IDE APIs:** VS Code Language Model API

**Languages:** Python, TypeScript, JavaScript (JSX/TSX), Go, Rust, Java, C, C++, Swift, Lua

Don't see yours? [Adding a provider](CONTRIBUTING.md#adding-a-provider) takes 5 lines of code.

</details>

## Quick Start

### 1. Start the Backend

Codag requires a self-hosted backend for code analysis. You'll need a [Gemini API key](https://aistudio.google.com/apikey) (free tier available).

```bash
git clone https://github.com/michaelzixizhou/codag.git
cd codag
cp backend/.env.example backend/.env
# Add your GEMINI_API_KEY to backend/.env
docker compose up -d
```

Verify: `curl http://localhost:52104/health`

<details>
<summary>Without Docker (macOS/Linux)</summary>

```bash
cd backend
python3.11 -m venv venv && source venv/bin/activate
pip install -r requirements.txt
python main.py
```

</details>

### 2. Install the Extension

Search **"Codag"** in VS Code Extensions, or install from the [Marketplace](https://marketplace.visualstudio.com/items?itemName=codag.codag).

<details>
<summary>Using Cursor?</summary>

Build and install the extension manually:

```bash
cd frontend
npm install
npx vsce package
cursor --install-extension codag-*.vsix
```

</details>

### 3. Use It

1. `Cmd+Shift+P` → **"Codag: Open"**
2. Select files containing LLM/AI code
3. Explore the graph

## How It Works

**Analysis Pipeline:**
1. Tree-sitter parses your code into ASTs across 10+ languages
2. Pattern matching detects LLM API calls and framework usage
3. Call graph extraction maps function relationships
4. Backend (Gemini 2.5 Flash) identifies workflow semantics — nodes, edges, decision points

**Live Updates:**
- File changes trigger incremental tree-sitter re-parsing
- AST diffs determine which functions changed
- Graph updates instantly without LLM round-trip

**Rendering:**
- ELK (Eclipse Layout Kernel) for orthogonal graph layout
- D3.js for interactive SVG rendering
- Per-file caching with content hashing — only changed files reanalyze

## Roadmap

- [ ] Hosted backend (no self-hosting required)
- [ ] Diff view: compare workflows across git commits
- [ ] Support for more languages and frameworks

Have a feature request? [Open an issue](https://github.com/michaelzixizhou/codag/issues/new).

## Star History

<a href="https://star-history.com/#michaelzixizhou/codag&Date">
 <picture>
   <source media="(prefers-color-scheme: dark)" srcset="https://api.star-history.com/svg?repos=michaelzixizhou/codag&type=Date&theme=dark&v=2" />
   <source media="(prefers-color-scheme: light)" srcset="https://api.star-history.com/svg?repos=michaelzixizhou/codag&type=Date&v=2" />
   <img alt="Star History Chart" src="https://api.star-history.com/svg?repos=michaelzixizhou/codag&type=Date&v=2" />
 </picture>
</a>

## Development

For contributors working on the extension itself:

```bash
cd frontend
npm install
npm run compile
```

Then press `F5` in VS Code to launch the Extension Development Host.

## Contributing

Contributions welcome! See [CONTRIBUTING.md](CONTRIBUTING.md) for full development setup.

## Contact

Questions or feedback? Reach out at michael@codag.ai

## License

[MIT](LICENSE)
