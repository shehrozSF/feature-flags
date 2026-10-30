import type { Env } from './env';

export { ProjectHub } from './project-hub';

export default {
  fetch(request: Request, env: Env): Response {
    const url = new URL(request.url);
    if (request.method === 'GET' && url.pathname === '/health') {
      return Response.json({ status: 'ok', version: env.GIT_SHA ?? 'dev' });
    }
    return new Response(null, { status: 404 });
  },
} satisfies ExportedHandler<Env>;
