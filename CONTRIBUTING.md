# Contributing to Codag

Thanks for your interest in contributing to Codag! This document covers the development workflow.

## Development Setup

```bash
# Clone the repo
git clone https://github.com/michaelzixizhou/codag.git
cd codag

# Install dependencies (backend + frontend)
make setup

# Add your Gemini API key
echo "GEMINI_API_KEY=your-key-here" > backend/.env

# Run everything (compile, start backend, launch extension)
make run
```

## Project Structure

- `backend/` - Python/FastAPI server using Gemini for code analysis
- `frontend/` - VSCode extension (TypeScript, D3.js, Dagre)
- `frontend/src/webview-client/` - Webview visualization code

## Development Workflow

1. **Fork** the repo and create a feature branch from `main`
2. Make your changes
3. Compile the frontend: `cd frontend && npm run compile`
4. Test the extension: `make run`
5. Submit a pull request

## Code Style

- **TypeScript**: Follow existing patterns, use strict types
- **Python**: Follow PEP 8, use type hints
- **Commits**: Use clear, descriptive commit messages

## Pull Requests

- Keep PRs focused on a single change
- Include a description of what changed and why
- Ensure the frontend compiles without errors
- Test the extension end-to-end if possible

## Reporting Issues

Use [GitHub Issues](https://github.com/michaelzixizhou/codag/issues) with the provided templates for bugs and feature requests.

## License

By contributing, you agree that your contributions will be licensed under the MIT License.
