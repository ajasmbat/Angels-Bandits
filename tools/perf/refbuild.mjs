// Another commit's build, for `--ab-ref <git-ref>` (O3) and for
// `flicker.mjs --ref`: check the commit out into a detached worktree of its
// own, give it its OWN `npm ci`, and build its client. The caller serves it
// with that tree's server (`node --import tsx server/src/index.ts`, cwd =
// the returned dir), so client, server and common all come from the same
// commit — exactly what a player on that build would have run.
//
// Why a real `npm ci` and not a symlinked node_modules: npm workspaces link
// `node_modules/@angels-bandits/common` RELATIVELY to `../../common`, so a
// symlinked tree resolves common/ to THIS checkout's — the old client would
// silently be built against the new city generator.
//
// The worktree is kept (under the OS temp dir, keyed by commit) so a second
// run against the same ref skips the install and the build. Remove it with
// `git worktree remove <dir>` when done; the harness prints the path.

import { spawn, spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const REPO = resolve(dirname(fileURLToPath(import.meta.url)), "../..");

function git(args) {
  const r = spawnSync("git", args, { cwd: REPO, encoding: "utf8" });
  if (r.status !== 0) {
    throw new Error(`git ${args.join(" ")} failed:\n${r.stderr.trim()}`);
  }
  return r.stdout.trim();
}

function run(cmd, args, cwd, quiet) {
  return new Promise((ok, fail) => {
    const p = spawn(cmd, args, { cwd, stdio: quiet ? "ignore" : "inherit" });
    p.on("exit", (code) =>
      code === 0
        ? ok()
        : fail(new Error(`${cmd} ${args.join(" ")} exited ${code}`)),
    );
  });
}

/**
 * Resolve `ref` to a commit, then make sure a built checkout of it exists.
 * Returns `{ dir, sha, label }`; `label` ("ref 86e5982") names the arm.
 */
export async function prepareRefBuild(ref, { quiet = false } = {}) {
  const sha = git(["rev-parse", "--verify", `${ref}^{commit}`]);
  const short = sha.slice(0, 7);
  const dir = join(tmpdir(), `ab-perf-ref-${sha.slice(0, 12)}`);
  if (!existsSync(join(dir, "package.json"))) {
    console.log(`checking out ${short} into ${dir}…`);
    git(["worktree", "add", "--detach", "--force", dir, sha]);
  }
  if (!existsSync(join(dir, "node_modules"))) {
    console.log(`installing ${short}'s dependencies…`);
    await run("npm", ["ci", "--no-audit", "--no-fund"], dir, quiet);
  }
  if (!existsSync(join(dir, "client", "dist", "index.html"))) {
    console.log(`building ${short}'s client…`);
    await run("npm", ["run", "build", "-w", "client"], dir, quiet);
  }
  console.log(
    `ref ${short} ready (${dir}; remove with: git worktree remove ${dir})`,
  );
  return { dir, sha, label: `ref ${short}` };
}
