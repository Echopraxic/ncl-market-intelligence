-- NCL Market Intelligence Engine — Database Setup
-- Run this as the postgres superuser in pgAdmin or psql:
--   "C:\Program Files\PostgreSQL\18\bin\psql.exe" -U postgres -h localhost -p 5432 -f db-setup.sql

-- 1. Create role
DO $$
BEGIN
  IF NOT EXISTS (SELECT FROM pg_catalog.pg_roles WHERE rolname = 'ncl_user') THEN
    CREATE ROLE ncl_user WITH LOGIN PASSWORD 'ncl_password';
  END IF;
END
$$;

-- 2. Create database
SELECT 'CREATE DATABASE ncl_mie OWNER ncl_user'
WHERE NOT EXISTS (SELECT FROM pg_database WHERE datname = 'ncl_mie')
\gexec

-- 3. Grant privileges
GRANT ALL PRIVILEGES ON DATABASE ncl_mie TO ncl_user;

-- 4. Connect to ncl_mie and enable pgvector
\c ncl_mie

-- Install pgvector (requires the extension to be on disk — see note below)
CREATE EXTENSION IF NOT EXISTS pgvector;

-- Grant schema privileges so ncl_user can create tables
GRANT ALL ON SCHEMA public TO ncl_user;
ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT ALL ON TABLES TO ncl_user;
ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT ALL ON SEQUENCES TO ncl_user;

\echo ''
\echo '✓ Database ncl_mie created with ncl_user owner'
\echo '✓ pgvector extension enabled'
\echo ''
\echo 'Next steps:'
\echo '  cd apps/api && npm run db:push'
\echo '  npm run dev:api'
