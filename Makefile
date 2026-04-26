.PHONY: help setup local-setup dev stop logs test clean

help:
	@echo "NCL Market Intelligence — Available commands"
	@echo ""
	@echo "Setup & Local Development:"
	@echo "  make local-setup      Run automated local setup (Docker, deps, .env)"
	@echo "  make dev              Start API and dashboard dev servers"
	@echo "  make stop             Stop Docker containers"
	@echo "  make logs             View Docker container logs"
	@echo ""
	@echo "Testing & Build:"
	@echo "  make test             Run vitest suite"
	@echo "  make build            Build API and dashboard"
	@echo "  make clean            Remove node_modules, dist, and containers"
	@echo ""
	@echo "Database:"
	@echo "  make db-push          Push schema changes to dev database"
	@echo "  make db-studio        Open Drizzle Studio UI"
	@echo ""

local-setup:
	@bash scripts/setup-local.sh

dev:
	@echo "Starting API and dashboard..."
	@npm run dev:api & npm run dev:dashboard
	@wait

stop:
	@echo "Stopping containers..."
	@docker-compose down

logs:
	@docker-compose logs -f

test:
	@npm run test

build:
	@npm run build

clean:
	@echo "Cleaning up..."
	@rm -rf node_modules apps/api/node_modules apps/dashboard/node_modules
	@rm -rf dist apps/api/dist apps/dashboard/.next
	@docker-compose down -v
	@echo "✓ Cleaned"

db-push:
	@npm run db:push

db-studio:
	@npm run db:studio
