import { buildServer } from './api/server.js';
import { logger } from './lib/logger.js';

const PORT = parseInt(process.env.PORT ?? '3001', 10);
const HOST = process.env.HOST ?? '0.0.0.0';

async function main() {
  const server = await buildServer();
  try {
    await server.listen({ port: PORT, host: HOST });
    logger.info('NCL MIE API running on http://' + HOST + ':' + PORT);
  } catch (err) {
    logger.error(err, 'Failed to start server');
    process.exit(1);
  }
}
main();
