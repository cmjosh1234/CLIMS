.PHONY: help build-backend run-backend build-frontend run-frontend install-frontend docker-up docker-down docker-build clean test

# Recipes are POSIX sh. On Windows outside Git Bash/WSL, make falls back to cmd.exe; use Git's sh.
ifeq ($(OS),Windows_NT)
ifeq ($(SHELL),sh.exe)
GIT_SH := $(subst \,/,$(or $(ProgramW6432),$(ProgramFiles)))/Git/usr/bin/sh.exe
ifeq ($(shell if exist "$(GIT_SH)" echo yes),yes)
SHELL := $(GIT_SH)
export PATH := $(GIT_SH:/sh.exe=);$(PATH)
else
$(error Install Git for Windows, or run make from Git Bash or WSL)
endif
endif
PYTHON ?= python
# Scripts read/write UTF-8 (seed SQL, docs); Windows Python defaults to cp1252.
export PYTHONUTF8 := 1
endif
PYTHON ?= python3

ENVIRONMENT ?= dev
ifeq ($(filter $(ENVIRONMENT),dev prod),)
$(error ENVIRONMENT must be dev or prod)
endif
ENV_FILE ?= infra/env/$(ENVIRONMENT).env
COMPOSE = docker compose --env-file $(ENV_FILE) -f infra/compose/docker-compose.yml -f infra/compose/docker-compose.$(ENVIRONMENT).yml

# Project variables
VERSION ?= $(shell tr -d '\r\n' < VERSION)
COMMIT_HASH ?= $(shell git rev-parse --short HEAD 2>/dev/null || echo "unknown")
BUILD_TIME ?= $(shell date -u +"%Y-%m-%dT%H:%M:%SZ")

help:
	@echo "Available commands:"
	@echo "  Backend:"
	@echo "    make build-backend   - Build the backend binary with version ldflags"
	@echo "    make run-backend     - Run the backend server locally"
	@echo ""
	@echo "  Frontend:"
	@echo "    make install-frontend- Install frontend dependencies (npm ci)"
	@echo "    make run-frontend    - Run the Next.js frontend development server"
	@echo "    make build-frontend  - Build the Next.js frontend for production"
	@echo "    make check-frontend  - Format check, lint, type-check, test and build the frontend"
	@echo ""
	@echo "  Mobile:"
	@echo "    make install-mobile  - Install Expo/React Native dependencies"
	@echo "    make run-mobile      - Start Expo on the host"
	@echo "    make check-mobile    - Lint and type-check the mobile project"
	@echo ""
	@echo "  Docker Compose:"
	@echo "    make docker-up       - Start the selected ENVIRONMENT (default: dev)"
	@echo "    make dev-up/prod-up   - Start the development or production stack"
	@echo "    make compose-config  - Validate the selected Compose configuration"
	@echo "    make mobile-export   - Export production mobile JavaScript artifacts"
	@echo "    make docker-down     - Stop and remove Docker Compose containers"
	@echo "    make docker-build    - Rebuild and start the Docker stack"
	@echo ""
	@echo "    make setup           - Create the local environment file if missing"
	@echo "    make db-up           - Start PostgreSQL only"
	@echo "    make db-seed         - Import legacy data into an empty migrated database"
	@echo "    make db-demo         - Add a simulated year of stock activity for the reports (dev)"
	@echo "    make db-demo-remove  - Remove that demo activity again"
	@echo "    make sql-convert     - Regenerate PostgreSQL SQL from the MySQL dump"
	@echo "    make migrate-create NAME=description - Generate the next SQL up/down pair"
	@echo ""
	@echo "  General:"
	@echo "    make clean           - Remove build binaries and artifacts"
	@echo "    make test            - Run backend tests"
	@echo "    make lint            - Run Go, web, mobile, and Python linters"
	@echo "    make format          - Format Go, Python, web/mobile, and documentation"
	@echo "    make format-check    - Check formatting without modifying files"
	@echo "    make version-check   - Check shared application version metadata"
	@echo "    make version-set VERSION=x.y.z - Update all application versions"
	@echo "    make check-stack     - Verify selected environment routes (dev includes Metro)"
	@echo "    make check-environments - Verify dev/prod Docker and Compose conventions"
	@echo "    make docs-check      - Validate OpenAPI, documentation links, and Swagger assets"
	@echo "    make docs-serve      - Preview the documentation site with live reload"
	@echo "    make docs-build      - Build the documentation site (fails on broken links)"

# --- Backend Targets ---
build-backend:
	@echo "Building backend binary (Version: $(VERSION), Commit: $(COMMIT_HASH))..."
	cd backend && CGO_ENABLED=0 GOOS=linux go build \
		-ldflags="-s -w -X main.Version=$(VERSION) -X main.CommitHash=$(COMMIT_HASH) -X main.BuildTime=$(BUILD_TIME)" \
		-o bin/server ./cmd/server

run-backend:
	@echo "Starting backend server locally..."
	set -a; eval "$$(tr -d '\r' < $(ENV_FILE))"; set +a; cd backend && go run ./cmd/server

# --- Frontend Targets ---
install-frontend:
	@echo "Installing frontend dependencies..."
	cd frontend && npm ci

run-frontend:
	@echo "Starting Next.js frontend dev server..."
	cd frontend && npm run dev

build-frontend:
	@echo "Building Next.js frontend production bundle..."
	cd frontend && npm run build

# --- Docker Compose Targets ---
docker-up:
	@echo "Starting Docker Compose environment..."
	$(COMPOSE) up -d --build --wait

docker-down:
	@echo "Stopping Docker Compose environment..."
	$(COMPOSE) down

docker-build:
	@echo "Building and starting Docker stack with version args..."
	VERSION=$(VERSION) COMMIT_HASH=$(COMMIT_HASH) BUILD_TIME=$(BUILD_TIME) $(COMPOSE) up --build -d --wait

# --- Utility Targets ---
clean:
	@echo "Cleaning build artifacts..."
	rm -rf backend/bin
	rm -f backend/server
	rm -rf frontend/.next
	rm -rf frontend/coverage
	rm -rf frontend/out

test:
	@echo "Running backend tests..."
	cd backend && go test -v ./...
.PHONY: setup db-up db-seed db-demo db-demo-remove sql-convert
setup:
	@test -f $(ENV_FILE) || cp infra/env/$(ENVIRONMENT).env.example $(ENV_FILE)
	@echo "Environment ready: $(ENV_FILE)"

db-up:
	$(COMPOSE) up -d --wait postgres

db-seed:
	@seed_file=$$(mktemp) && trap 'rm -f "$$seed_file"' EXIT && \
		$(PYTHON) scripts/prepare_legacy_seed.py > "$$seed_file" && \
		$(COMPOSE) exec -T postgres sh -c 'psql -U "$$POSTGRES_USER" -d "$$POSTGRES_DB" -v ON_ERROR_STOP=1' < "$$seed_file"

# Demo activity for the reports and analytics screens; every row it adds has an id starting de300000-.
DEMO_SEED ?= 2026
db-demo:
	@refs=$$(mktemp) && demo=$$(mktemp) && trap 'rm -f "$$refs" "$$demo"' EXIT && \
		$(COMPOSE) exec -T postgres sh -c 'psql -U "$$POSTGRES_USER" -d "$$POSTGRES_DB" -At -v ON_ERROR_STOP=1' < scripts/demo_activity_refs.sql > "$$refs" && \
		$(PYTHON) scripts/demo_activity.py --seed $(DEMO_SEED) "$$refs" > "$$demo" && \
		$(COMPOSE) exec -T postgres sh -c 'psql -U "$$POSTGRES_USER" -d "$$POSTGRES_DB" -q -v ON_ERROR_STOP=1' < "$$demo"

db-demo-remove:
	$(COMPOSE) exec -T postgres sh -c 'psql -U "$$POSTGRES_USER" -d "$$POSTGRES_DB" -q -v ON_ERROR_STOP=1' < scripts/demo_activity_remove.sql

sql-convert:
	$(PYTHON) scripts/convert_mysql_dump.py

.PHONY: migrate-create
migrate-create: export MIGRATION_NAME = $(NAME)
migrate-create:
	$(PYTHON) scripts/create_migration.py

.PHONY: create-admin test-integration
create-admin:
	set -a; eval "$$(tr -d '\r' < $(ENV_FILE))"; set +a; cd backend && go run ./cmd/create-admin

test-integration:
	@test -n "$(TEST_DATABASE_URL)" || (echo "Set TEST_DATABASE_URL to an isolated PostgreSQL server with CREATE DATABASE permission"; exit 1)
	cd backend && go test -count=1 ./internal/integration

.PHONY: docs-check
docs-check:
	$(PYTHON) scripts/check_docs.py
	docker run --rm -v "$(CURDIR)/docs:/docs:ro" python:3.13-alpine sh -c 'pip install --disable-pip-version-check --quiet openapi-spec-validator==0.7.2 && python -m openapi_spec_validator /docs/api/openapi.json'

.PHONY: docs-serve docs-build
docs-serve:
	cd website && npm ci && npm start

docs-build:
	cd website && npm ci && npm run build

.PHONY: install-mobile run-mobile check-mobile check-stack
install-mobile:
	cd mobile && npm ci

run-mobile:
	cd mobile && npm start

check-frontend:
	cd frontend && npm run check

check-mobile:
	cd mobile && npm run lint && npm run typecheck

check-stack:
	STACK_ENV=$(ENVIRONMENT) $(PYTHON) scripts/check_stack.py

.PHONY: dev-up prod-up dev-down prod-down compose-config mobile-export
dev-up:
	$(MAKE) ENVIRONMENT=dev docker-up

prod-up:
	$(MAKE) ENVIRONMENT=prod docker-up

dev-down:
	$(MAKE) ENVIRONMENT=dev docker-down

prod-down:
	$(MAKE) ENVIRONMENT=prod docker-down

compose-config:
	$(COMPOSE) config --quiet

mobile-export:
	$(MAKE) ENVIRONMENT=prod mobile-export-run

.PHONY: mobile-export-run
mobile-export-run:
	@test "$(ENVIRONMENT)" = prod || (echo "Mobile release artifacts use ENVIRONMENT=prod"; exit 1)
	$(COMPOSE) run --build --rm --no-deps mobile

.PHONY: check-environments
check-environments:
	$(PYTHON) scripts/check_environments.py

.PHONY: lint format format-check
lint:
	cd backend && go vet ./...
	cd frontend && npm run lint -- --max-warnings=0
	cd mobile && npm run lint -- --max-warnings=0 --no-cache
	$(PYTHON) -m ruff check scripts

format:
	npm run format
	cd frontend && npm run format
	$(PYTHON) -m ruff format scripts
	gofmt -w backend

format-check:
	npm run format:check
	cd frontend && npm run format:check
	$(PYTHON) -m ruff format --check scripts
	@test -z "$$(gofmt -l backend)" || (gofmt -l backend; exit 1)

.PHONY: version-check version-set
version-check:
	$(PYTHON) scripts/project_version.py check

version-set:
	$(PYTHON) scripts/project_version.py set "$(VERSION)"
