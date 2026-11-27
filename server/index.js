// Local server: the API from app.js plus the React app (Vite in development,
// the built files in production).
import express from 'express';
import http from 'node:http';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createApp } from './app.js';

const APP_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const PROD = process.argv.includes('--prod') || process.env.NODE_ENV === 'production';
const PORT = +process.env.PORT || 5173;
const HOST = process.env.HOST || '127.0.0.1';
const WORKSPACE = path.resolve(process.env.PO_WORKSPACE || path.join(APP_DIR, 'workspace'));

const app = await createApp({
  workspace: WORKSPACE,
  dataDir: path.resolve(process.env.PO_DATA || path.join(APP_DIR, 'data')),
  password: process.env.PO_PASSWORD || ''
});

const server = http.createServer(app);
if (PROD) {
  const dist = path.join(APP_DIR, 'dist');
  app.use(express.static(dist));
  app.get(/.*/, (req, res) => res.sendFile(path.join(dist, 'index.html')));
} else {
  const { createServer } = await import('vite');
  const vite = await createServer({ root: APP_DIR, server: { middlewareMode: true, hmr: { server } }, appType: 'spa' });
  app.use(vite.middlewares);
}

server.listen(PORT, HOST, () => {
  console.log(`PO Messages Editor: http://${HOST === '0.0.0.0' ? 'localhost' : HOST}:${PORT}`);
  console.log(`Workspace: ${WORKSPACE}`);
});
