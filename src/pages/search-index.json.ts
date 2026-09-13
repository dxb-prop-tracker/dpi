import type { APIRoute } from 'astro';
import { q4 } from '../lib/db';

export const GET: APIRoute = () =>
  new Response(JSON.stringify(q4.searchIndex()), { headers: { 'Content-Type': 'application/json' } });
