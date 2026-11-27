// Vercel function serving every /api route (see vercel.json). Files and team
// memory are kept in Upstash Redis; the password is checked by middleware.js.
import { createApp } from '../server/app.js';

export default await createApp({});
