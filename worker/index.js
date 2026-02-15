// Cloudflare Worker — GHIN API Proxy
// Forwards requests to api2.ghin.com/api/v1, adds required headers, handles CORS.

const GHIN_API = 'https://api2.ghin.com/api/v1';

// Set this to your GitHub Pages origin once deployed, e.g.:
// 'https://<username>.github.io'
const ALLOWED_ORIGIN = '*'; // TODO: restrict to your GitHub Pages URL

async function handleRequest(request) {
  // Handle CORS preflight
  if (request.method === 'OPTIONS') {
    return new Response(null, { status: 204, headers: corsHeaders(request) });
  }

  // Build the target URL: everything after the worker root → GHIN API path
  const url = new URL(request.url);
  const targetUrl = GHIN_API + url.pathname + url.search;

  // Clone relevant headers from the incoming request
  const headers = new Headers();
  headers.set('Content-Type', 'application/json');
  headers.set('source', 'GHINcom');

  // Forward Authorization header if present (JWT token)
  const auth = request.headers.get('Authorization');
  if (auth) {
    headers.set('Authorization', auth);
  }

  // Forward the request to GHIN API
  const init = {
    method: request.method,
    headers,
  };

  // Forward body for POST/PUT/PATCH
  if (['POST', 'PUT', 'PATCH'].includes(request.method)) {
    init.body = await request.text();
  }

  const response = await fetch(targetUrl, init);

  // Build the response back to the browser with CORS headers
  const responseHeaders = new Headers(response.headers);
  for (const [key, value] of Object.entries(corsHeaders(request))) {
    responseHeaders.set(key, value);
  }

  return new Response(response.body, {
    status: response.status,
    statusText: response.statusText,
    headers: responseHeaders,
  });
}

function corsHeaders(request) {
  const origin = request.headers.get('Origin') || '*';
  const allowedOrigin = ALLOWED_ORIGIN === '*' ? origin : ALLOWED_ORIGIN;

  return {
    'Access-Control-Allow-Origin': allowedOrigin,
    'Access-Control-Allow-Methods': 'GET, POST, PUT, DELETE, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type, Authorization',
    'Access-Control-Max-Age': '86400',
  };
}

export default {
  fetch: handleRequest,
};
