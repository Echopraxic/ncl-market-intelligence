import Fastify from 'fastify';
import cors from '@fastify/cors';
import { logger } from '../lib/logger.js';

export async function buildServer() {
  const server = Fastify({ logger: false });

  await server.register(cors, {
    origin: process.env.DASHBOARD_URL ?? 'http://localhost:3000',
    credentials: true,
  });

  server.addHook('onRequest', async (request, reply) => {
    if (request.url === '/health') return;
    const apiKey = request.headers['x-api-key'];
    if (!apiKey || apiKey !== process.env.API_SECRET_KEY) {
      return reply.code(401).send({ error: 'Unauthorized' });
    }
  });

  server.get('/health', async () => ({
    status: 'ok',
    timestamp: new Date().toISOString(),
    service: 'ncl-mie-api',
  }));

  // Routes registered in Phase 1 Week 4
  // server.register(brandsRoutes, { prefix: '/api/brands' });

  return server;
}
