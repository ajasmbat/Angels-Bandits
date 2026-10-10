// A1: preloaded by server-tick.mjs `--cpu-prof`: exit cleanly on SIGTERM, so
// node writes the CPU profile it only writes on a normal exit.
process.on("SIGTERM", () => process.exit(0));
