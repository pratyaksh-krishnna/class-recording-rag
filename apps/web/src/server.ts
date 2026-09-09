import index from '../index.html';

const port = Number(process.env.WEB_PORT ?? 5173);

const server = Bun.serve({
  port,
  routes: {
    '/*': index,
  },
  development: {
    hmr: true,
    console: true,
  },
});

console.log(`Web dev server listening on ${server.url}`);
