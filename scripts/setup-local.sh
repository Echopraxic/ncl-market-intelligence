#!/bin/bash
set -e

echo "🚀 NCL Market Intelligence — Local Setup"
echo "========================================"

# Colors
GREEN='\033[0;32m'
BLUE='\033[0;34m'
NC='\033[0m' # No Color

# Check prerequisites
echo -e "\n${BLUE}Checking prerequisites...${NC}"
if ! command -v node &> /dev/null; then
  echo "❌ Node.js not found. Install Node.js 20+ first."
  exit 1
fi
echo "✓ Node.js $(node --version)"

if ! command -v docker &> /dev/null; then
  echo "❌ Docker not found. Install Docker first."
  exit 1
fi
echo "✓ Docker installed"

if ! command -v docker-compose &> /dev/null; then
  echo "❌ Docker Compose not found. Install Docker Compose first."
  exit 1
fi
echo "✓ Docker Compose installed"

# Start containers
echo -e "\n${BLUE}Starting PostgreSQL and Redis...${NC}"
docker-compose up -d postgres redis
echo "✓ Containers started"

# Wait for services to be healthy
echo -e "\n${BLUE}Waiting for services to be ready...${NC}"
for i in {1..30}; do
  if docker-compose exec -T postgres pg_isready -U ncl_user >/dev/null 2>&1 && \
     docker-compose exec -T redis redis-cli ping >/dev/null 2>&1; then
    echo "✓ Services are healthy"
    break
  fi
  echo "  Waiting... ($i/30)"
  sleep 1
done

# Install dependencies
echo -e "\n${BLUE}Installing dependencies...${NC}"
npm install
echo "✓ Dependencies installed"

# Create .env if it doesn't exist
if [ ! -f .env ]; then
  echo -e "\n${BLUE}Creating .env file...${NC}"
  cat > .env << 'ENVFILE'
DATABASE_URL=postgresql://ncl_user:ncl_password@localhost:5432/ncl_mie
REDIS_URL=redis://localhost:6379
API_SECRET_KEY=dev-secret-key-change-in-production
DEEPSEEK_API_KEY=sk-...
RESEND_API_KEY=re_...
RESEND_WEBHOOK_SECRET=whsec_...
EMAIL_FROM=outreach@yourdomain.com
DASHBOARD_URL=http://localhost:3000
NODE_ENV=development
ENVFILE
  echo "✓ Created .env (edit with your API keys)"
else
  echo "✓ .env already exists"
fi

# Summary
echo -e "\n${GREEN}✅ Local setup complete!${NC}"
echo ""
echo "Next steps:"
echo "  1. Edit .env and add your API keys (DEEPSEEK_API_KEY, RESEND_API_KEY, etc.)"
echo "  2. Start the API:       npm run dev:api"
echo "  3. Start the dashboard: npm run dev:dashboard"
echo "  4. Visit http://localhost:3000"
echo ""
echo "Other commands:"
echo "  make dev               # Run both API and dashboard together"
echo "  make stop              # Stop containers"
echo "  make logs              # View container logs"
echo "  npm run test           # Run tests"
