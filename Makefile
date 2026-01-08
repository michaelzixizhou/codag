.PHONY: setup run stop debug db-setup

setup: db-setup
	@echo "Setting up backend..."
	cd backend && python3 -m venv venv && \
		./venv/bin/pip install -r requirements.txt
	@if [ ! -f backend/.env ]; then \
		cp backend/.env.example backend/.env 2>/dev/null || echo "SECRET_KEY=dev-secret-change-in-prod\nGEMINI_API_KEY=your-key-here\nDATABASE_URL=postgresql+asyncpg://localhost/codag" > backend/.env; \
		echo "Created backend/.env - add your API keys!"; \
	fi
	@echo "Setting up frontend..."
	cd frontend && npm install && npm run compile
	@echo "Setup complete!"

db-setup:
	@echo "Checking PostgreSQL..."
	@if command -v createdb > /dev/null 2>&1; then \
		if ! psql -lqt | cut -d \| -f 1 | grep -qw codag; then \
			createdb codag && echo "Created 'codag' database"; \
		else \
			echo "Database 'codag' already exists"; \
		fi; \
	else \
		echo "WARNING: PostgreSQL not found. Install it and run: createdb codag"; \
	fi

run:
	@echo "Compiling frontend..."
	cd frontend && npm run compile
	@echo "Starting backend..."
	@cd backend && ./venv/bin/python main.py > ../backend.log 2>&1 & echo $$! > ../backend.pid && \
		echo "Backend running on port 8000 (PID: $$!)"
	@sleep 2
	@echo "Launching VSCode extension..."
	@code --extensionDevelopmentPath=$(PWD)/frontend --user-data-dir=$(PWD)/.vscode-dev $(PWD)

debug:
	@echo "Compiling frontend..."
	cd frontend && npm run compile
	@echo "Launching VSCode extension in debug mode..."
	@code --extensionDevelopmentPath=$(PWD)/frontend --user-data-dir=$(PWD)/.vscode-dev $(PWD)

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
	@if lsof -ti:8000 > /dev/null 2>&1; then \
		echo "Found process on port 8000, killing..."; \
		lsof -ti:8000 | xargs kill -9 2>/dev/null; \
		echo "Port 8000 cleared"; \
	else \
		echo "No process on port 8000"; \
	fi
