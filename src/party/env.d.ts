/**
 * Declaration merge with the ambient `Env` interface `wrangler types`
 * generates into worker-configuration.d.ts (which declares the Main /
 * CaptureBridge Durable Object bindings from wrangler.jsonc). This adds the
 * two Supabase fields, which are deliberately NOT declared in
 * wrangler.jsonc's `vars`: SUPABASE_KEY is a secret (`wrangler secret put
 * SUPABASE_KEY`, never committed), and SUPABASE_URL sits alongside it for
 * consistency even though it isn't sensitive. Both stay optional -- see
 * server.ts's initSupabase(), which disables persistence gracefully when
 * either is missing, same as the old partykit-deployed version did via
 * process.env.
 *
 * No import/export here on purpose -- that would make this a module and
 * scope its `interface Env` locally instead of merging with the global one.
 */
interface Env {
  SUPABASE_URL?: string;
  SUPABASE_KEY?: string;
}
