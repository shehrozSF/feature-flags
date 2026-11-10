// `pnpm dev` / `pnpm start`: runs the API as a plain Node server against Postgres,
// for local development and debugging (wiring in node-server.ts).
import { startNodeServer } from './node-server';

const databaseUrl = process.env.DATABASE_URL;
if (!databaseUrl) {
  console.error(
    'Set DATABASE_URL, e.g. postgres://ff:ff@localhost:5432/ff (see docker-compose.yml)',
  );
  process.exit(1);
}

const server = await startNodeServer({
  databaseUrl,
  port: Number(process.env.PORT ?? 8787),
  version: process.env.GIT_SHA ?? 'dev',
});
console.log(`API listening on ${server.url}`);
