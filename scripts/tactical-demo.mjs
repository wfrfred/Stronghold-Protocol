import { createServer } from 'node:http';
import { createReadStream } from 'node:fs';
import { stat } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('../', import.meta.url));
const mounts = [
  ['/dist/', path.join(root, 'dist')],
  ['/fixtures/', path.join(root, 'test/fixtures/arknights')],
  ['/data/', path.join(root, 'data')],
  ['/shared/', path.join(root, 'shared')],
  ['/sim/', path.join(root, 'server/sim')],
  ['/', path.join(root, 'public')],
];
const mime = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.map': 'application/json; charset=utf-8',
  '.txt': 'text/plain; charset=utf-8',
  '.atlas': 'text/plain; charset=utf-8',
  '.svg': 'image/svg+xml; charset=utf-8',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.webp': 'image/webp',
  '.gif': 'image/gif',
  '.avif': 'image/avif',
  '.ico': 'image/x-icon',
  '.woff2': 'font/woff2',
  '.woff': 'font/woff',
  '.ttf': 'font/ttf',
  '.otf': 'font/otf',
  '.mp3': 'audio/mpeg',
  '.ogg': 'audio/ogg',
  '.wav': 'audio/wav',
  '.mp4': 'video/mp4',
  '.webm': 'video/webm',
  '.wasm': 'application/wasm',
};

async function serve(request, response) {
  const finish = (status, message) => {
    response.writeHead(status, { 'Content-Type': 'text/plain; charset=utf-8' });
    response.end(message);
  };
  if (request.method !== 'GET' && request.method !== 'HEAD') {
    response.setHeader('Allow', 'GET, HEAD');
    return finish(405, 'Method not allowed');
  }
  let pathname;
  try {
    pathname = decodeURIComponent(new URL(request.url, 'http://localhost').pathname);
  } catch {
    return finish(400, 'Invalid URL');
  }
  if (pathname.includes('\0') || pathname.includes('\\') || pathname.split('/').some((part) => part.startsWith('.'))) {
    return finish(403, 'Forbidden');
  }
  if (pathname === '/') {
    response.writeHead(302, { Location: '/dev/render-demo.html?scene=core&mode=combat&stage=act1autochess_m01' });
    return response.end();
  }
  const [prefix, directory] = mounts.find(([prefix]) => pathname.startsWith(prefix));
  const file = path.resolve(directory, pathname.slice(prefix.length));
  if (!file.startsWith(directory + path.sep)) return finish(403, 'Forbidden');
  try {
    const metadata = await stat(file);
    if (!metadata.isFile()) return finish(404, 'Not found');
    response.writeHead(200, {
      'Content-Type': mime[path.extname(file).toLowerCase()] || 'application/octet-stream',
      'Content-Length': metadata.size,
      'Cache-Control': 'no-store',
    });
    if (request.method === 'HEAD') return response.end();
    const stream = createReadStream(file);
    stream.on('error', () => response.destroy());
    stream.pipe(response);
  } catch (error) {
    return finish(error.code === 'ENOENT' || error.code === 'ENOTDIR' ? 404 : 500, 'Not found');
  }
}

export function startTacticalDemo({ port = 3001 } = {}) {
  const server = createServer((request, response) => {
    serve(request, response).catch(() => response.destroy());
  });
  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(port, '127.0.0.1', () => {
      server.removeListener('error', reject);
      resolve(server);
    });
  });
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const server = await startTacticalDemo({ port: Number(process.env.PORT || 3001) });
  console.log(`Tactical demo: http://127.0.0.1:${server.address().port}/`);
  process.once('SIGINT', () => server.close());
  process.once('SIGTERM', () => server.close());
}
