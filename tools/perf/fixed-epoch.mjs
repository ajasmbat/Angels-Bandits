// Preload for a QA server (`node --import ./fixed-epoch.mjs …`): the server
// clock starts at AB_EPOCH_MS instead of wall time, then runs at real speed.
//
// Everything time-driven in this game — searchlight sweeps, helicopters,
// aircraft, the storm schedule, living windows, signage — is a pure function
// of (seed, server time). Two builds served from the same epoch therefore
// show the same world at the same server time, which is what lets
// flicker.mjs compare a frozen view across builds without one of them
// happening to have a helicopter's spotlight sweeping through the frame.
// Not a server change: without AB_EPOCH_MS set this does nothing.

const epoch = Number(process.env.AB_EPOCH_MS);
if (Number.isFinite(epoch) && epoch > 0) {
  const realNow = Date.now.bind(Date);
  const start = realNow();
  Date.now = () => epoch + (realNow() - start);
}
