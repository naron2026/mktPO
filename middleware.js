// Vercel Routing Middleware: asks for PO_PASSWORD (HTTP Basic auth, any user
// name) before the page or the API is served. Without PO_PASSWORD set, the
// deployment refuses every request rather than run open.
import { next } from '@vercel/functions';

export const config = { matcher: '/:path*' };

const enc = new TextEncoder();
const digest = async (s) => new Uint8Array(await crypto.subtle.digest('SHA-256', enc.encode(s)));

export default async function middleware(request) {
  const password = process.env.PO_PASSWORD;
  if (!password) return new Response('Set PO_PASSWORD in the Vercel project settings, then redeploy.', { status: 503 });

  const [scheme, value] = (request.headers.get('authorization') || '').split(' ');
  if (scheme === 'Basic' && value) {
    let given = '';
    try { given = new TextDecoder().decode(Uint8Array.from(atob(value), (c) => c.charCodeAt(0))).replace(/^[^:]*:/, ''); } catch {}
    const [a, b] = await Promise.all([digest(given), digest(password)]);
    let diff = 0;
    for (let i = 0; i < a.length; i++) diff |= a[i] ^ b[i];
    if (!diff) return next();
  }
  return new Response('Password required.', {
    status: 401,
    headers: { 'WWW-Authenticate': 'Basic realm="PO Messages Editor", charset="UTF-8"' }
  });
}
