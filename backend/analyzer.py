import re

class StaticAnalyzer:
    # LLM Client Detection Patterns
    LLM_CLIENT_PATTERNS = [
        # OpenAI
        r"from\s+openai\s+import",
        r"import\s+openai",
        r"OpenAI\s*\(",
        r"import\s+.*from\s+['\"]openai['\"]",

        # Anthropic
        r"from\s+anthropic\s+import",
        r"import\s+anthropic",
        r"Anthropic\s*\(",
        r"import\s+.*from\s+['\"]@anthropic-ai/sdk['\"]",

        # Google Gemini (old and new SDKs)
        r"import\s+google\.generativeai",
        r"from\s+google\s+import\s+genai",
        r"genai\.configure",
        r"genai\.Client",
        r"genai\.GenerativeModel",
        r"from\s+['\"]@google/generative-ai['\"]",
        r"GoogleGenerativeAI",

        # Ollama
        r"from\s+ollama\s+import",
        r"import\s+ollama",
        r"import\s+.*from\s+['\"]ollama['\"]",

        # Cohere
        r"import\s+cohere",
        r"cohere\.Client",
        r"from\s+['\"]cohere-ai['\"]",

        # Hugging Face
        r"from\s+huggingface_hub\s+import",
        r"InferenceClient",
        r"from\s+['\"]@huggingface/inference['\"]",

        # xAI/Grok
        r"from\s+xai\s+import",
        r"import\s+xai",
        r"api\.x\.ai",

        # Mistral AI
        r"from\s+mistralai\s+import",
        r"MistralClient",
        r"Mistral\s*\(",

        # Together AI
        r"from\s+together\s+import",
        r"Together\s*\(",

        # Replicate
        r"import\s+replicate",
        r"from\s+replicate\s+import",
        r"replicate\.run",

        # Fireworks AI
        r"from\s+fireworks\s+import",
        r"fireworks\.client",

        # AWS Bedrock
        r"bedrock-runtime",
        r"InvokeModel",
        r"BedrockRuntimeClient",

        # Azure OpenAI
        r"AzureOpenAI",
        r"azure\.ai\.openai",

        # Vertex AI
        r"google\.cloud\.aiplatform",
        r"from\s+vertexai",
        r"import\s+vertexai",

        # AI21
        r"from\s+ai21\s+import",
        r"AI21Client",

        # DeepSeek
        r"api\.deepseek\.com",

        # OpenRouter
        r"openrouter\.ai",

        # llama.cpp / GGUF
        r"from\s+llama_cpp\s+import",
        r"import\s+llama_cpp",
        r"from\s+ctransformers\s+import",
        r"from\s+gguf\s+import",
        r"import\s+gguf",
        r"from\s+langchain.*import\s+LlamaCpp",
        r"from\s+langchain_community.*import\s+LlamaCpp",
        r"node-llama-cpp",

        # MCP (Model Context Protocol) - JS/TS
        r"import\s+.*from\s+['\"]@modelcontextprotocol/sdk",
        r"require\s*\(\s*['\"]@modelcontextprotocol/sdk",
        r"import\s+.*from\s+['\"]fastmcp['\"]",
        r"require\s*\(\s*['\"]fastmcp['\"]",
        # MCP - Python
        r"from\s+mcp\.server\s+import",
        r"from\s+mcp\.server\.",
        r"from\s+mcp\s+import",
        r"import\s+mcp\.server",
        r"import\s+mcp\b",
        r"from\s+fastmcp\s+import",
        r"import\s+fastmcp",
        r"McpServer\s*\(",
        r"MCPServer\s*\(",
        r"FastMCP\s*\(",
        # MCP - Go
        r"github\.com/mark3labs/mcp-go",
        r"github\.com/modelcontextprotocol/go-sdk",
        # MCP - Rust
        r"use\s+rmcp\b",
        r"use\s+mcp_server\b",
        r"use\s+mcp_sdk\b",
        # MCP - C++
        r'#include\s+[<"]mcp_server\.h[>"]',
        r'#include\s+[<"]mcp_tool\.h[>"]',
        r"mcp::server",
    ]

    # LLM API Call Patterns
    LLM_CALL_PATTERNS = [
        r"\.chat\.completions\.create",
        r"\.completions\.create",
        r"\.messages\.create",
        r"\.generate_content",
        r"\.generateContent",
        r"\.chat\(",
        r"\.generate\(",
        r"\.create_completion\(",
        r"\.create_chat_completion\(",
        r"Llama\s*\(",
        r"GGUFReader\s*\(",
        r"AutoModelForCausalLM\.from_pretrained",
        # MCP - server instantiation
        r"new\s+McpServer\s*\(",
        r"McpServer\s*\(",
        r"MCPServer\s*\(",
        r"FastMCP\s*\(",
        # MCP - tool/resource/prompt registration
        r"\.tool\s*\(",
        r"\.resource\s*\(",
        r"\.prompt\s*\(",
        r"\.addTool\s*\(",
        r"\.addResource\s*\(",
        r"\.addPrompt\s*\(",
        r"\.AddTool\s*\(",
        r"\.AddResource\s*\(",
        r"\.AddPrompt\s*\(",
        # MCP - Go constructors
        r"NewMCPServer\s*\(",
        r"mcp\.NewTool\s*\(",
        r"mcp\.NewResource\s*\(",
        # MCP - Python decorators
        r"@\w+\.tool\b",
        r"@\w+\.resource\b",
        r"@\w+\.prompt\b",
        r"@\w+\.call_tool\b",
        r"@\w+\.list_tools\b",
        r"@\w+\.list_prompts\b",
        r"@\w+\.get_prompt\b",
        r"@\w+\.list_resources\b",
        r"@\w+\.read_resource\b",
        # MCP - C++
        r"register_tool\s*\(",
        r"register_resource\s*\(",
        r"tool_builder\s*\(",
        # MCP - Rust
        r"\.serve\s*\(\s*transport",
        # MCP - transport
        r"StdioServerTransport",
        r"[Ss]seServerTransport",
        r"server\.connect\s*\(",
    ]

    # Framework Patterns (keep for framework-specific detection)
    FRAMEWORK_PATTERNS = {
        "langgraph": [
            r"from\s+langgraph",
            r"import\s+.*from\s+['\"]@langchain/langgraph['\"]",
            r"StateGraph|MessageGraph",
        ],
        "mastra": [
            r"from\s+mastra",
            r"import\s+.*from\s+['\"]mastra['\"]",
            r"@mastra/",
        ],
        "langchain": [
            r"from\s+langchain",
            r"import\s+.*from\s+['\"]@langchain",
            r"LLMChain|SequentialChain",
        ],
        "crewai": [
            r"from\s+crewai",
            r"import\s+.*from\s+['\"]crewai['\"]",
            r"Crew\s*\(",
        ],
        "llamaindex": [
            r"from\s+llama_index",
            r"import\s+.*from\s+['\"]llamaindex['\"]",
            r"import\s+.*from\s+['\"]@llama-index",
        ],
        "autogen": [
            r"from\s+autogen",
            r"from\s+pyautogen",
        ],
        "haystack": [
            r"from\s+haystack",
        ],
        "semantickernel": [
            r"from\s+semantic_kernel",
        ],
        "pydanticai": [
            r"from\s+pydantic_ai",
        ],
        "instructor": [
            r"import\s+instructor",
            r"from\s+instructor\s+import",
        ]
    }

    @staticmethod
    def detect_workflow(code: str) -> bool:
        """Detect if code contains LLM workflow patterns"""

        # Check for LLM client imports
        has_llm_client = any(re.search(pattern, code) for pattern in StaticAnalyzer.LLM_CLIENT_PATTERNS)

        # Check for actual LLM API calls
        has_llm_calls = any(re.search(pattern, code) for pattern in StaticAnalyzer.LLM_CALL_PATTERNS)

        # Check for framework usage
        has_framework = any(
            any(re.search(pattern, code) for pattern in patterns)
            for patterns in StaticAnalyzer.FRAMEWORK_PATTERNS.values()
        )

        # File is a workflow if it has LLM clients + calls, or uses a framework
        return (has_llm_client and has_llm_calls) or has_framework

    @staticmethod
    def detect_framework(code: str, file_path: str) -> str | None:
        """Detect workflow framework from actual imports"""

        # Check for specific frameworks first
        for framework, patterns in StaticAnalyzer.FRAMEWORK_PATTERNS.items():
            if any(re.search(pattern, code) for pattern in patterns):
                return framework

        # Detect generic LLM usage and identify the client
        if re.search(r"from\s+openai\s+import|import\s+openai|OpenAI\s*\(", code):
            return "openai"
        if re.search(r"from\s+anthropic\s+import|import\s+anthropic|Anthropic\s*\(", code):
            return "anthropic"
        if re.search(r"import\s+google\.generativeai|from\s+google\s+import\s+genai|genai\.Client|GoogleGenerativeAI", code):
            return "gemini"
        if re.search(r"from\s+ollama\s+import|import\s+ollama", code):
            return "ollama"
        if re.search(r"from\s+llama_cpp\s+import|import\s+llama_cpp|from\s+gguf\s+import|from\s+ctransformers\s+import", code):
            return "llama-cpp"
        if re.search(r"@modelcontextprotocol/sdk|from\s+mcp\.server|from\s+mcp\s+import|from\s+fastmcp\s+import|McpServer\s*\(|MCPServer\s*\(|FastMCP\s*\(|mcp-go|modelcontextprotocol/go-sdk|use\s+rmcp\b|mcp::server|mcp_server\.h", code):
            return "mcp"

        # Check if it has any LLM patterns
        if StaticAnalyzer.detect_workflow(code):
            return "generic-llm"

        return None

static_analyzer = StaticAnalyzer()
