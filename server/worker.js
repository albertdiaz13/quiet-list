// Cloudflare Workers entry. Lists live in a D1 database; the app's files are served as static assets.
// Secrets (SETUP_CODE) are set with `wrangler secret put`, never written in this repository.
import { createApp } from './app.js';

const d1 = database => ({
  get: (sql, ...params) => database.prepare(sql).bind(...params).first(),
  all: async (sql, ...params) => (await database.prepare(sql).bind(...params).all()).results,
  run: async (sql, ...params) => ({ changes: (await database.prepare(sql).bind(...params).run()).meta.changes }),
});

let app;
export default {
  async fetch(request, env) {
    app ??= createApp({
      db: d1(env.DB),
      assets: req => env.ASSETS.fetch(req),
      config: { setupCode: env.SETUP_CODE, passwordIterations: env.PW_ITERATIONS, origin: env.PUBLIC_ORIGIN },
    });
    return app(request, { ip: request.headers.get('cf-connecting-ip') || 'unknown' });
  },
};
