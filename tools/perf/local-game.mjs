// SOLO: how a harness reaches the game now that it runs in the page. The
// game server is the page's own sim worker (client/src/sim/worker.ts), so
// the host flags a harness used to set on the server it spawned — a quiet
// city, no carrier war, a long liveness bound, a fixed epoch — ride the page
// URL instead, as `?sim=KEY:VALUE,…` (client/src/sim/local.ts simEnv,
// server/src/host-options.ts names). The server a harness still spawns only
// serves the built client (and /healthz).
//
// Harnesses keep the same flags on that server's environment too: an
// `--ab-ref` / `--repo` build from before SOLO ignores `sim` and plays on the
// spawned server over ws, exactly as it always did.

/** `{ AB_QUIET_CITY: "1", … }` → `AB_QUIET_CITY:1,…` (the `sim` value). */
export function simValue(env) {
  return Object.entries(env)
    .filter(([, v]) => v !== undefined && v !== null && v !== "")
    .map(([k, v]) => `${k}:${v}`)
    .join(",");
}

/** `url` with the host flags `env` appended as its `sim` parameter. */
export function withSim(url, env) {
  const value = simValue(env);
  if (value === "") return url;
  const sep = url.includes("?") ? "&" : "?";
  return `${url}${sep}sim=${encodeURIComponent(value)}`;
}
