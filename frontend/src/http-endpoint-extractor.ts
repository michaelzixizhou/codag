/**
 * HTTP Endpoint Extractor
 *
 * Extracts HTTP client calls and route handlers to enable cross-service
 * workflow detection (e.g., frontend → API → backend).
 */

export interface HttpClientCall {
    file: string;
    line: number;
    function: string;
    method: 'GET' | 'POST' | 'PUT' | 'DELETE' | 'PATCH' | string;
    endpoint: string;  // e.g., "/analyze", "http://localhost:8000/analyze"
    normalizedPath: string;  // Just the path part, e.g., "/analyze"
}

export interface HttpRouteHandler {
    file: string;
    line: number;
    function: string;
    method: 'GET' | 'POST' | 'PUT' | 'DELETE' | 'PATCH' | string;
    path: string;  // e.g., "/analyze"
}

export interface HttpEndpointGraph {
    clientCalls: HttpClientCall[];
    routeHandlers: HttpRouteHandler[];
    connections: HttpConnection[];
}

export interface HttpConnection {
    client: HttpClientCall;
    handler: HttpRouteHandler;
    confidence: 'exact' | 'fuzzy';
}

// HTTP client patterns (axios, fetch, got, request, etc.)
const HTTP_CLIENT_PATTERNS: Record<string, RegExp[]> = {
    typescript: [
        // axios.get/post('/path') or this.httpClient.post('/path') with optional generic <T>
        /(?:this\.)?(?:axios|httpClient|apiClient|restClient|fetchClient|client|http)\s*\.\s*(get|post|put|delete|patch)\s*(?:<[^>]*>)?\s*\(\s*['"`]([^'"`]+)['"`]/gi,
        // axios({ method: 'POST', url: '/path' })
        /(?:axios|httpClient)\s*\(\s*\{[^}]*method\s*:\s*['"`](GET|POST|PUT|DELETE|PATCH)['"`][^}]*url\s*:\s*['"`]([^'"`]+)['"`]/gi,
        // fetch('/path') or fetch('/path', { method: 'POST' })
        /fetch\s*\(\s*['"`]([^'"`]+)['"`](?:\s*,\s*\{[^}]*method\s*:\s*['"`](GET|POST|PUT|DELETE|PATCH)['"`][^}]*\})?/gi,
        // fetch(`${BASE_URL}/path`) - template literals
        /fetch\s*\(\s*`[^`]*\/([^`]+)`/gi,
        // got.get/post('url') - got library
        /got\s*\.\s*(get|post|put|delete|patch)\s*\(\s*['"`]([^'"`]+)['"`]/gi,
        /got\s*\(\s*['"`]([^'"`]+)['"`]/gi,
        // ky.get/post('url') - ky library
        /ky\s*\.\s*(get|post|put|delete|patch)\s*\(\s*['"`]([^'"`]+)['"`]/gi,
        // superagent: request.get('url'), superagent.post('url')
        /(?:request|superagent)\s*\.\s*(get|post|put|delete|patch)\s*\(\s*['"`]([^'"`]+)['"`]/gi,
        // ofetch/useFetch (Nuxt): $fetch('/path'), useFetch('/path')
        /\$fetch\s*\(\s*['"`]([^'"`]+)['"`]/gi,
        /useFetch\s*\(\s*['"`]([^'"`]+)['"`]/gi,
        // node-fetch: fetch is same as native
        // undici: request('url'), fetch('url')
        /undici\s*\.\s*(?:request|fetch)\s*\(\s*['"`]([^'"`]+)['"`]/gi,
        // SWR/React Query with fetch
        /useSWR\s*\(\s*['"`]([^'"`]+)['"`]/gi,
        /useQuery\s*\([^,]*,\s*\(\)\s*=>\s*fetch\s*\(\s*['"`]([^'"`]+)['"`]/gi,
    ],
    python: [
        // requests.get/post('/path')
        /requests\s*\.\s*(get|post|put|delete|patch)\s*\(\s*['"]([^'"]+)['"]/gi,
        // httpx.get/post('/path') - sync
        /httpx\s*\.\s*(get|post|put|delete|patch)\s*\(\s*['"]([^'"]+)['"]/gi,
        // httpx.AsyncClient() - async
        /await\s+(?:self\.)?(?:client|session|http_client|httpx_client)\s*\.\s*(get|post|put|delete|patch)\s*\(\s*(?:f)?['"]([^'"]+)['"]/gi,
        // aiohttp session.get/post('/path')
        /(?:self\.)?(?:session|http_session|aiohttp_session|aiohttp_client)\s*\.\s*(get|post|put|delete|patch)\s*\(\s*['"]([^'"]+)['"]/gi,
        // urllib3: http.request('GET', 'url')
        /(?:http|pool|urllib3)\s*\.\s*request\s*\(\s*['"]?(GET|POST|PUT|DELETE|PATCH)['"]?\s*,\s*['"]([^'"]+)['"]/gi,
        // urllib.request.urlopen('url')
        /urllib\.request\.urlopen\s*\(\s*['"]([^'"]+)['"]/gi,
        // tornado AsyncHTTPClient
        /(?:http_client|tornado_client)\s*\.\s*fetch\s*\(\s*['"]([^'"]+)['"]/gi,
        // pycurl (rare but used)
        /curl\s*\.\s*setopt\s*\([^,]*CURLOPT_URL[^,]*,\s*['"]([^'"]+)['"]/gi,
    ],
    go: [
        // http.Get("url") or http.Post("url", ...)
        /http\.(Get|Post)\s*\(\s*"([^"]+)"/gi,
        // http.NewRequest("GET", "url", ...)
        /http\.NewRequest\s*\(\s*"(GET|POST|PUT|DELETE|PATCH)"\s*,\s*"([^"]+)"/gi,
        // client.Get("url"), client.Post("url"), client.Do(req)
        /(?:client|c|httpClient)\.(Get|Post|Do)\s*\(\s*"([^"]+)"/gi,
        // resty: client.R().Get("url"), client.R().Post("url")
        /\.R\(\)\s*\.\s*(Get|Post|Put|Delete|Patch)\s*\(\s*"([^"]+)"/gi,
        // req library: req.Get("url")
        /req\s*\.\s*(Get|Post|Put|Delete|Patch)\s*\(\s*"([^"]+)"/gi,
        // grequests (goroutines)
        /grequests\s*\.\s*(Get|Post|Put|Delete|Patch)\s*\(\s*"([^"]+)"/gi,
    ],
    java: [
        // HttpClient URI.create("url")
        /URI\.create\s*\(\s*"([^"]+)"\s*\)/gi,
        // RestTemplate.getForObject("url", ...) or postForObject
        /(?:restTemplate|template)\s*\.\s*(get|post|put|delete)For(?:Object|Entity)\s*\(\s*"([^"]+)"/gi,
        // WebClient.get().uri("url") or post().uri("url")
        /WebClient[^;]*\.(get|post|put|delete)\s*\(\s*\)[^;]*\.uri\s*\(\s*"([^"]+)"/gi,
        // OkHttp: Request.Builder().url("url")
        /Request\.Builder\s*\(\s*\)[^;]*\.url\s*\(\s*"([^"]+)"/gi,
        // Retrofit: @GET("path"), @POST("path")
        /@(GET|POST|PUT|DELETE|PATCH)\s*\(\s*"([^"]+)"\s*\)/gi,
        // Apache HttpClient: HttpGet("url"), HttpPost("url")
        /new\s+Http(Get|Post|Put|Delete|Patch)\s*\(\s*"([^"]+)"\s*\)/gi,
        // Feign client methods with @RequestLine
        /@RequestLine\s*\(\s*"(GET|POST|PUT|DELETE|PATCH)\s+([^"]+)"\s*\)/gi,
    ],
    ruby: [
        // Net::HTTP.get(URI("url")) or post
        /Net::HTTP\.(get|post)\s*\([^)]*"([^"]+)"/gi,
        // HTTParty.get("url") or post
        /HTTParty\.(get|post|put|delete)\s*\(\s*['"]([^'"]+)['"]/gi,
        // Faraday.get("url") or conn.get("url")
        /(?:Faraday|conn|connection)\.(get|post|put|delete)\s*\(\s*['"]([^'"]+)['"]/gi,
        // RestClient.get("url")
        /RestClient\.(get|post|put|delete|patch)\s*\(\s*['"]([^'"]+)['"]/gi,
        // Typhoeus: Typhoeus.get("url")
        /Typhoeus\.(get|post|put|delete|patch)\s*\(\s*['"]([^'"]+)['"]/gi,
        // HTTP gem: HTTP.get("url")
        /HTTP\.(get|post|put|delete|patch)\s*\(\s*['"]([^'"]+)['"]/gi,
    ],
    php: [
        // file_get_contents("url")
        /file_get_contents\s*\(\s*['"]([^'"]+)['"]/gi,
        // cURL: curl_setopt($ch, CURLOPT_URL, "url")
        /curl_setopt\s*\([^,]+,\s*CURLOPT_URL\s*,\s*['"]([^'"]+)['"]/gi,
        // Guzzle: $client->get("url"), $client->post("url")
        /\$(?:client|guzzle|http)\s*->\s*(get|post|put|delete|patch)\s*\(\s*['"]([^'"]+)['"]/gi,
        // Guzzle request: $client->request('GET', 'url')
        /\$(?:client|guzzle)\s*->\s*request\s*\(\s*['"]?(GET|POST|PUT|DELETE|PATCH)['"]?\s*,\s*['"]([^'"]+)['"]/gi,
        // Laravel Http facade: Http::get("url")
        /Http\s*::\s*(get|post|put|delete|patch)\s*\(\s*['"]([^'"]+)['"]/gi,
        // Symfony HttpClient: $client->request('GET', 'url')
        /\$(?:client|httpClient)\s*->\s*request\s*\(\s*['"]?(GET|POST|PUT|DELETE|PATCH)['"]?\s*,\s*['"]([^'"]+)['"]/gi,
    ],
    rust: [
        // reqwest: client.get("url"), client.post("url")
        /(?:client|reqwest)\s*\.\s*(get|post|put|delete|patch)\s*\(\s*"([^"]+)"/gi,
        // reqwest::get("url")
        /reqwest\s*::\s*(get|post)\s*\(\s*"([^"]+)"/gi,
        // hyper: Request::get("url")
        /Request\s*::\s*(get|post|put|delete)\s*\(\s*"([^"]+)"/gi,
        // surf: surf::get("url")
        /surf\s*::\s*(get|post|put|delete)\s*\(\s*"([^"]+)"/gi,
        // ureq: ureq::get("url")
        /ureq\s*::\s*(get|post|put|delete)\s*\(\s*"([^"]+)"/gi,
    ],
    csharp: [
        // HttpClient: client.GetAsync("url"), client.PostAsync("url")
        /(?:client|httpClient|_client)\s*\.\s*(Get|Post|Put|Delete|Patch)Async\s*\(\s*"([^"]+)"/gi,
        // HttpClient.GetStringAsync("url")
        /(?:client|httpClient)\s*\.\s*GetStringAsync\s*\(\s*"([^"]+)"/gi,
        // RestSharp: client.Execute(request)
        /new\s+RestRequest\s*\(\s*"([^"]+)"\s*,\s*Method\.(GET|POST|PUT|DELETE|PATCH)/gi,
        // WebRequest: WebRequest.Create("url")
        /WebRequest\.Create\s*\(\s*"([^"]+)"/gi,
        // Flurl: "url".GetAsync(), "url".PostAsync()
        /"([^"]+)"\s*\.\s*(Get|Post|Put|Delete|Patch)(?:Json)?Async/gi,
        // Refit: [Get("/path")], [Post("/path")]
        /\[\s*(Get|Post|Put|Delete|Patch)\s*\(\s*"([^"]+)"\s*\)\s*\]/gi,
    ],
    kotlin: [
        // Ktor: client.get("url"), client.post("url")
        /client\s*\.\s*(get|post|put|delete|patch)\s*\(\s*"([^"]+)"/gi,
        // Fuel: Fuel.get("url"), "url".httpGet()
        /Fuel\s*\.\s*(get|post|put|delete|patch)\s*\(\s*"([^"]+)"/gi,
        /"([^"]+)"\s*\.http(Get|Post|Put|Delete|Patch)/gi,
        // OkHttp (same as Java)
        /Request\.Builder\s*\(\s*\)[^;]*\.url\s*\(\s*"([^"]+)"/gi,
        // Retrofit (same as Java)
        /@(GET|POST|PUT|DELETE|PATCH)\s*\(\s*"([^"]+)"\s*\)/gi,
    ],
    swift: [
        // URLSession: URLSession.shared.dataTask(with: URL(string: "url"))
        /URL\s*\(\s*string\s*:\s*"([^"]+)"\s*\)/gi,
        // Alamofire: AF.request("url")
        /AF\s*\.\s*request\s*\(\s*"([^"]+)"/gi,
        // Alamofire method: AF.request("url", method: .post)
        /AF\s*\.\s*request\s*\(\s*"([^"]+)"\s*,\s*method\s*:\s*\.(get|post|put|delete|patch)/gi,
        // Moya: provider.request(.target)
        /\.request\s*\(\s*\.(\w+)/gi,
    ],
};

// HTTP route handler patterns (FastAPI, Express, Flask, etc.)
const ROUTE_HANDLER_PATTERNS: Record<string, RegExp[]> = {
    python: [
        // @app.get("/path") or @router.post("/path")
        /@(?:app|router)\s*\.\s*(get|post|put|delete|patch)\s*\(\s*['"]([^'"]+)['"]/gi,
        // @app.route("/path", methods=["POST"])
        /@(?:app|router)\s*\.\s*route\s*\(\s*['"]([^'"]+)['"][^)]*methods\s*=\s*\[['"]?(GET|POST|PUT|DELETE|PATCH)['"]?\]/gi,
        // Flask: @app.route("/path")
        /@(?:app|blueprint)\s*\.\s*route\s*\(\s*['"]([^'"]+)['"]/gi,
    ],
    typescript: [
        // Express: app.get('/path', handler) or router.post('/path', handler)
        /(?:app|router)\s*\.\s*(get|post|put|delete|patch)\s*\(\s*['"`]([^'"`]+)['"`]/gi,
        // NestJS: @Get('/path'), @Post('/path')
        /@(Get|Post|Put|Delete|Patch)\s*\(\s*['"`]?([^'"`)\s]*)['"`]?\s*\)/gi,
        // Hono: app.get('/path', handler)
        /(?:app|hono)\s*\.\s*(get|post|put|delete|patch)\s*\(\s*['"`]([^'"`]+)['"`]/gi,
    ],
    go: [
        // http.HandleFunc("/path", handler) or mux.HandleFunc("/path", handler)
        /(?:http|mux|r|router)\s*\.(?:HandleFunc|Handle)\s*\(\s*"([^"]+)"/gi,
        // Gin: r.GET("/path", handler) or router.POST("/path", handler)
        /(?:r|router|g|engine)\s*\.\s*(GET|POST|PUT|DELETE|PATCH)\s*\(\s*"([^"]+)"/gi,
        // Echo: e.GET("/path", handler)
        /(?:e|echo)\s*\.\s*(GET|POST|PUT|DELETE|PATCH)\s*\(\s*"([^"]+)"/gi,
        // Fiber: app.Get("/path", handler)
        /(?:app|fiber)\s*\.\s*(Get|Post|Put|Delete|Patch)\s*\(\s*"([^"]+)"/gi,
    ],
    java: [
        // Spring: @GetMapping("/path") or @PostMapping("/path")
        /@(Get|Post|Put|Delete|Patch)Mapping\s*\(\s*(?:value\s*=\s*)?["']?([^"'\s)]+)["']?\s*\)/gi,
        // @RequestMapping(value = "/path", method = RequestMethod.GET)
        /@RequestMapping\s*\([^)]*value\s*=\s*"([^"]+)"[^)]*method\s*=\s*RequestMethod\.(GET|POST|PUT|DELETE|PATCH)/gi,
        // JAX-RS: @GET @Path("/path")
        /@(GET|POST|PUT|DELETE|PATCH)\s*[\s\S]*?@Path\s*\(\s*"([^"]+)"/gi,
    ],
    ruby: [
        // Rails: get '/path', to: 'controller#action'
        /(get|post|put|delete|patch)\s+['"]([^'"]+)['"]/gi,
        // resources :users (RESTful routes - simplified)
        /resources?\s+:(\w+)/gi,
    ],
};

// Supported languages
type SupportedLanguage = 'typescript' | 'python' | 'go' | 'java' | 'ruby';

/**
 * Detect language from file extension
 */
export function detectLanguage(filePath: string): SupportedLanguage {
    const ext = filePath.split('.').pop()?.toLowerCase() || '';
    switch (ext) {
        case 'ts':
        case 'tsx':
        case 'js':
        case 'jsx':
        case 'mjs':
        case 'cjs':
            return 'typescript';
        case 'py':
            return 'python';
        case 'go':
            return 'go';
        case 'java':
        case 'kt':
        case 'scala':
            return 'java';
        case 'rb':
            return 'ruby';
        default:
            return 'typescript'; // Default fallback
    }
}

/**
 * Extract HTTP client calls from source code
 */
export function extractHttpClientCalls(
    code: string,
    filePath: string,
    language?: SupportedLanguage
): HttpClientCall[] {
    // Skip the http-endpoint-extractor file itself - it contains example patterns
    if (filePath.includes('http-endpoint-extractor')) {
        return [];
    }

    const lang = language || detectLanguage(filePath);
    const calls: HttpClientCall[] = [];
    const patterns = HTTP_CLIENT_PATTERNS[lang] || [];
    const lines = code.split('\n');

    // Find which function each line belongs to
    const functionMap = buildFunctionLineMap(code, lang);

    for (const pattern of patterns) {
        // Reset regex state
        pattern.lastIndex = 0;

        let match;
        while ((match = pattern.exec(code)) !== null) {
            const matchPos = match.index;
            const lineNumber = code.substring(0, matchPos).split('\n').length;

            // Parse the match - different patterns have different group orders
            let method: string;
            let endpoint: string;

            if (match[0].includes('fetch')) {
                endpoint = match[1];
                method = match[2] || 'GET';
            } else {
                method = match[1].toUpperCase();
                endpoint = match[2];
            }

            const normalizedPath = normalizeEndpoint(endpoint);

            // Filter out false positives (form fields, etc.)
            if (!isValidHttpPath(normalizedPath)) {
                continue;
            }

            const containingFunction = findContainingFunction(lineNumber, functionMap);

            calls.push({
                file: filePath,
                line: lineNumber,
                function: containingFunction,
                method,
                endpoint,
                normalizedPath,
            });
        }
    }

    return calls;
}

/**
 * Extract HTTP route handlers from source code
 */
export function extractRouteHandlers(
    code: string,
    filePath: string,
    language?: SupportedLanguage
): HttpRouteHandler[] {
    const lang = language || detectLanguage(filePath);
    const handlers: HttpRouteHandler[] = [];
    const patterns = ROUTE_HANDLER_PATTERNS[lang] || [];
    const lines = code.split('\n');

    for (const pattern of patterns) {
        pattern.lastIndex = 0;

        let match;
        while ((match = pattern.exec(code)) !== null) {
            const matchPos = match.index;
            const lineNumber = code.substring(0, matchPos).split('\n').length;

            // Parse method and path from match groups
            let method: string;
            let path: string;

            // Handle different pattern formats
            if (match[0].includes('@') && match[0].includes('route')) {
                // Flask-style @app.route('/path', methods=['POST'])
                path = match[1];
                method = match[2] || 'GET';
            } else {
                method = match[1].toUpperCase();
                path = match[2] || '/';
            }

            // Find the handler function (next function after decorator)
            const handlerFunction = findHandlerFunction(code, lineNumber, lang);

            handlers.push({
                file: filePath,
                line: lineNumber,
                function: handlerFunction,
                method,
                path,
            });
        }
    }

    return handlers;
}

/**
 * Match HTTP client calls to route handlers
 */
export function matchEndpoints(
    clientCalls: HttpClientCall[],
    routeHandlers: HttpRouteHandler[]
): HttpConnection[] {
    const connections: HttpConnection[] = [];

    for (const call of clientCalls) {
        for (const handler of routeHandlers) {
            const match = matchPaths(call.normalizedPath, handler.path, call.method, handler.method);
            if (match) {
                connections.push({
                    client: call,
                    handler,
                    confidence: match,
                });
            }
        }
    }

    return connections;
}

/**
 * Build complete HTTP endpoint graph from all files
 */
export function buildHttpEndpointGraph(
    files: Array<{ path: string; content: string; language: 'typescript' | 'python' }>
): HttpEndpointGraph {
    const clientCalls: HttpClientCall[] = [];
    const routeHandlers: HttpRouteHandler[] = [];

    for (const file of files) {
        clientCalls.push(...extractHttpClientCalls(file.content, file.path, file.language));
        routeHandlers.push(...extractRouteHandlers(file.content, file.path, file.language));
    }

    const connections = matchEndpoints(clientCalls, routeHandlers);

    return {
        clientCalls,
        routeHandlers,
        connections,
    };
}

// Helper functions

function normalizeEndpoint(endpoint: string): string {
    // Remove protocol and host, keep just the path
    try {
        if (endpoint.startsWith('http://') || endpoint.startsWith('https://')) {
            const url = new URL(endpoint);
            return url.pathname;
        }

        // Handle Python f-string interpolation: f"{base_url}/path" → /path
        // Extract the path portion after any {variable} interpolation
        const fstringMatch = endpoint.match(/\{[^}]+\}(.+)/);
        if (fstringMatch && fstringMatch[1]) {
            endpoint = fstringMatch[1];
        }

        // Handle JS template literals with ${...}
        endpoint = endpoint.replace(/\$\{[^}]+\}/g, '');

        // Ensure starts with /
        if (!endpoint.startsWith('/')) {
            endpoint = '/' + endpoint;
        }
        return endpoint;
    } catch {
        return endpoint.startsWith('/') ? endpoint : '/' + endpoint;
    }
}

/**
 * Check if an endpoint looks like a valid HTTP path
 * Filters out false positives like form field names
 */
function isValidHttpPath(endpoint: string): boolean {
    // Must contain a slash (actual paths have structure)
    if (!endpoint.includes('/')) {
        return false;
    }

    // Skip very short single-segment "paths" that are likely form fields
    // e.g., "/email", "/name" are likely false positives
    // Real API paths are usually "/api/...", "/v1/...", etc.
    const segments = endpoint.split('/').filter(s => s.length > 0);
    if (segments.length === 1 && segments[0].length < 10 && !segments[0].includes('-')) {
        // Single short segment without hyphens - likely a form field
        // Allow things like "/analyze", "/login", "/users" but filter "/email", "/name"
        const commonFormFields = ['email', 'name', 'password', 'username', 'phone', 'address', 'message', 'comment', 'title', 'description', 'value', 'data', 'id', 'type', 'status', 'confirmpassword'];
        if (commonFormFields.includes(segments[0].toLowerCase())) {
            return false;
        }
    }

    return true;
}

function matchPaths(
    clientPath: string,
    handlerPath: string,
    clientMethod: string,
    handlerMethod: string
): 'exact' | 'fuzzy' | null {
    // Methods must match (or handler is catch-all)
    if (clientMethod !== handlerMethod && handlerMethod !== 'ALL') {
        return null;
    }

    // Normalize paths
    const normClient = clientPath.replace(/\/+$/, '') || '/';
    const normHandler = handlerPath.replace(/\/+$/, '') || '/';

    // Exact match
    if (normClient === normHandler) {
        return 'exact';
    }

    // Fuzzy match: handler has path params like /users/:id or /users/{id}
    const handlerRegex = normHandler
        .replace(/:[^/]+/g, '[^/]+')  // Express-style :param
        .replace(/\{[^}]+\}/g, '[^/]+');  // OpenAPI-style {param}

    if (new RegExp(`^${handlerRegex}$`).test(normClient)) {
        return 'fuzzy';
    }

    // Partial match: client path starts with handler path
    if (normClient.startsWith(normHandler) || normHandler.startsWith(normClient)) {
        return 'fuzzy';
    }

    return null;
}

function buildFunctionLineMap(code: string, language: SupportedLanguage): Map<number, string> {
    const map = new Map<number, string>();
    const lines = code.split('\n');
    let currentFunction = 'module';

    // Function patterns by language
    // TypeScript needs multiple patterns to catch class methods, arrow functions, etc.
    const funcPatterns: Record<SupportedLanguage, RegExp[]> = {
        python: [/^\s*(?:async\s+)?def\s+(\w+)/],
        typescript: [
            // Regular function: function name()
            /^\s*(?:export\s+)?(?:async\s+)?function\s+(\w+)/,
            // Arrow function: const name = async () => or const name = () =>
            /^\s*(?:export\s+)?(?:const|let|var)\s+(\w+)\s*=\s*(?:async\s*)?\([^)]*\)\s*(?::\s*[^=]+)?\s*=>/,
            // Arrow function: const name = async function or const name = function
            /^\s*(?:export\s+)?(?:const|let|var)\s+(\w+)\s*=\s*(?:async\s+)?function/,
            // Class method: async methodName(...) { or methodName(...): Type { (single line)
            /^\s+(?:async\s+)?(\w+)\s*\([^)]*\)\s*(?::\s*[^{]+)?\s*\{/,
            // Class method multi-line: async methodName( (params on next lines)
            /^\s+(?:async\s+)?(\w+)\s*\(\s*$/,
        ],
        go: [/^func\s+(?:\([^)]+\)\s+)?(\w+)/],
        java: [/^\s*(?:public|private|protected)?\s*(?:static)?\s*\w+\s+(\w+)\s*\(/],
        ruby: [/^\s*def\s+(\w+)/],
    };

    const patterns = funcPatterns[language] || funcPatterns.typescript;

    for (let i = 0; i < lines.length; i++) {
        const line = lines[i];
        // Skip lines that are clearly not function definitions
        if (line.trim().startsWith('//') || line.trim().startsWith('*') || line.trim().startsWith('/*')) {
            map.set(i + 1, currentFunction);
            continue;
        }

        for (const pattern of patterns) {
            const match = line.match(pattern);
            if (match && match[1]) {
                // Filter out keywords and common non-function identifiers
                const name = match[1];
                if (!['if', 'else', 'for', 'while', 'switch', 'catch', 'return', 'const', 'let', 'var', 'new', 'await', 'this', 'constructor', 'super'].includes(name)) {
                    currentFunction = name;
                    break;
                }
            }
        }
        map.set(i + 1, currentFunction);
    }

    return map;
}

function findContainingFunction(lineNumber: number, functionMap: Map<number, string>): string {
    return functionMap.get(lineNumber) || 'module';
}

function findHandlerFunction(code: string, decoratorLine: number, language: SupportedLanguage): string {
    const lines = code.split('\n');

    // Function patterns by language
    const funcPatterns: Record<SupportedLanguage, RegExp> = {
        python: /^\s*(?:async\s+)?def\s+(\w+)/,
        typescript: /^\s*(?:export\s+)?(?:async\s+)?(?:function\s+(\w+)|(\w+)\s*[:=]\s*(?:async\s+)?\(?)/,
        go: /^func\s+(?:\([^)]+\)\s+)?(\w+)/,
        java: /^\s*(?:public|private|protected)?\s*(?:static)?\s*\w+\s+(\w+)\s*\(/,
        ruby: /^\s*def\s+(\w+)/,
    };

    const funcPattern = funcPatterns[language] || funcPatterns.typescript;

    // Look for function definition after decorator/annotation
    for (let i = decoratorLine; i < Math.min(decoratorLine + 5, lines.length); i++) {
        const line = lines[i];
        const match = line.match(funcPattern);
        if (match) return match[1] || match[2];
    }

    return `handler_${decoratorLine}`;
}
