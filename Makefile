.PHONY: setup run stop debug kill docker-up docker-down

setup:
	@echo "Setting up backend..."
	cd backend && python3.11 -m venv venv && \
		./venv/bin/pip install -r requirements.txt
	@if [ ! -f backend/.env ]; then \
		cp backend/.env.example backend/.env 2>/dev/null || echo "GEMINI_API_KEY=your-key-here" > backend/.env; \
		echo "Created backend/.env - add your Gemini API key!"; \
	fi
	@echo "Setting up frontend..."
	cd frontend && npm install && npm run compile
	@echo "Setup complete!"

run:
	@echo "Compiling frontend..."
	cd frontend && npm run compile
	@echo "Starting backend..."
	@cd backend && ./venv/bin/python3.11 main.py > ../backend.log 2>&1 & echo $$! > ../backend.pid && \
		echo "Backend running on port 52104 (PID: $$!)"
	@sleep 2
	@echo "Backend running on port 52104"
	@echo "Launching VSCode extension..."
	@code --extensionDevelopmentPath=$(PWD)/frontend --user-data-dir=$(PWD)/.vscode-dev $(PWD)
	@echo ""
	@echo "=== Backend logs (Ctrl+C to stop) ==="
	@tail -f backend.log

debug:
	@echo "Compiling frontend..."
	cd frontend && npm run compile
	@echo "Launching VSCode extension in debug mode..."
	@code --extensionDevelopmentPath=$(PWD)/frontend --user-data-dir=$(PWD)/.vscode-dev $(PWD)

kill: stop

stop:
	@echo "Stopping backend..."
	@if [ -f backend.pid ]; then \
		PID=$$(cat backend.pid); \
		if ps -p $$PID > /dev/null 2>&1; then \
			kill $$PID && echo "Stopped backend (PID: $$PID)"; \
		else \
			echo "PID $$PID not running (stale PID file)"; \
		fi; \
		rm backend.pid; \
	fi
	@if lsof -ti:52104 > /dev/null 2>&1; then \
		echo "Found process on port 52104, killing..."; \
		lsof -ti:52104 | xargs kill -9 2>/dev/null; \
		echo "Port 52104 cleared"; \
	else \
		echo "No process on port 52104"; \
	fi

docker-up:
	docker compose up -d --build
	@echo "Backend running at http://localhost:52104"

docker-down:
	docker compose down
