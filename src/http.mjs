import http from 'node:http';

export class HTTPError extends Error {
  constructor(status, message) { super(message); this.status = status; }
}

function sendJSON(response, status, data, close = false) {
  if (response.destroyed || response.writableEnded) return;
  response.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store',
    'X-Content-Type-Options': 'nosniff', 'Access-Control-Allow-Origin': '*',
    ...(close ? { Connection: 'close' } : {}),
  });
  response.end(JSON.stringify(data));
}

function readBody(request, limit, timeout) {
  const advertised = request.headers['content-length'];
  if (advertised !== undefined && (!/^\d+$/.test(advertised) || Number(advertised) > limit)) {
    return Promise.reject(new HTTPError(413, `Request body is too large. The limit is ${limit} bytes.`));
  }
  return new Promise((resolve, reject) => {
    const chunks = [];
    let length = 0;
    let settled = false;
    const finish = error => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      request.removeAllListeners('data');
      if (error) { request.pause(); reject(error); } else resolve(Buffer.concat(chunks, length));
    };
    const timer = setTimeout(() => finish(new HTTPError(408, 'The upload timed out.')), timeout);
    timer.unref();
    request.on('data', chunk => {
      length += chunk.length;
      if (length > limit) finish(new HTTPError(413, `Request body is too large. The limit is ${limit} bytes.`));
      else chunks.push(chunk);
    });
    request.once('end', () => finish());
    request.once('aborted', () => finish(new HTTPError(400, 'The upload was interrupted.')));
    request.once('error', () => finish(new HTTPError(400, 'The upload failed.')));
  });
}

/**
 * JSON-over-HTTP server. `routes` maps "METHOD /path" to
 * `{ handler(context) -> { status?, body }, bodyLimit? }`.
 */
export async function startServer({ routes, port, host, maxInFlight = 32, bodyTimeout = 15_000, log = () => {} }) {
  let closing = false;
  const active = new Set();
  const server = http.createServer({ maxHeaderSize: 16 * 1024, requestTimeout: 30_000, headersTimeout: 10_000 }, (request, response) => {
    if (closing) { sendJSON(response, 503, { error: 'The node is shutting down.' }, true); return; }
    if (active.size >= maxInFlight) { sendJSON(response, 429, { error: 'The node is busy. Please retry shortly.' }, true); return; }
    const operation = (async () => {
      try {
        if (!request.url?.startsWith('/') || request.url.startsWith('//') || request.url.length > 4096) throw new HTTPError(400, 'Invalid request path.');
        const url = new URL(request.url, 'http://localhost');
        if (request.method === 'OPTIONS') { response.writeHead(204, { 'Access-Control-Allow-Origin': '*', 'Access-Control-Allow-Headers': 'Content-Type', 'Access-Control-Allow-Methods': 'GET, POST' }); response.end(); return; }
        const route = routes[`${request.method} ${url.pathname}`];
        if (!route) throw new HTTPError(404, 'Unknown endpoint.');
        let body;
        if (request.method === 'POST') {
          if (!/^application\/json(?:\s*;|$)/i.test(request.headers['content-type'] ?? '')) throw new HTTPError(415, 'Expected application/json.');
          const bytes = await readBody(request, route.bodyLimit ?? 32 * 1024, bodyTimeout);
          try { body = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes)); }
          catch { throw new HTTPError(400, 'Request body must be valid JSON.'); }
        }
        const result = await route.handler({ url, query: url.searchParams, body, request });
        sendJSON(response, result.status ?? 200, result.body);
      } catch (error) {
        if (error instanceof HTTPError) { sendJSON(response, error.status, { error: error.message }, error.status >= 413); return; }
        log({ event: 'http-error', error: error.message });
        sendJSON(response, 500, { error: 'Internal node error.' }, true);
      }
    })();
    active.add(operation);
    operation.finally(() => active.delete(operation));
  });
  server.keepAliveTimeout = 5_000;
  server.maxConnections = 256;
  server.on('clientError', (_error, socket) => { if (socket.writable) socket.end('HTTP/1.1 400 Bad Request\r\nConnection: close\r\nContent-Length: 0\r\n\r\n'); });
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(port, host, () => { server.removeListener('error', reject); resolve(); });
  });
  return {
    port: server.address().port,
    async close() {
      closing = true;
      const timer = setTimeout(() => server.closeAllConnections(), 5_000);
      timer.unref();
      await new Promise(done => { server.close(done); server.closeIdleConnections(); });
      await Promise.allSettled([...active]);
      clearTimeout(timer);
    },
  };
}

/** Fetch JSON with a timeout and a hard response-size limit. Throws on non-2xx. */
export async function fetchJSON(url, { method = 'GET', body, headers = {}, timeout = 10_000, maxBytes = 1024 * 1024 } = {}) {
  const response = await fetch(url, {
    method, signal: AbortSignal.timeout(timeout), redirect: 'error',
    headers: body === undefined ? headers : { ...headers, 'Content-Type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const reader = response.body?.getReader();
  const chunks = [];
  let length = 0;
  if (reader) {
    while (true) {
      const { value, done } = await reader.read();
      if (done) break;
      length += value.byteLength;
      if (length > maxBytes) { await reader.cancel(); throw new Error(`Response from ${new URL(url).host} is too large`); }
      chunks.push(value);
    }
  }
  const text = Buffer.concat(chunks, length).toString('utf8');
  let data;
  try { data = text ? JSON.parse(text) : null; } catch { throw new Error(`Invalid JSON from ${new URL(url).host}`); }
  if (!response.ok) {
    const error = new Error(data?.error ?? `HTTP ${response.status}`);
    error.status = response.status;
    error.data = data;
    throw error;
  }
  return data;
}
