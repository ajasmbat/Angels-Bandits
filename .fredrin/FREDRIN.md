# FREDRIN.md

Configuration and working guidelines for this project on **Fredrin** — the
desktop kanban for running many AI-coding tickets in parallel. This file is
committed to the repo, fully customizable, and read by every Worker at the start
of a session. Edit it to fit your team; run **Reset to defaults** from the
Context tab to restore this template.

## What a ticket is

A **ticket** is one unit of work that runs through a single AI agent session (a
**Worker**) in its own branch and **worktree**. Throughput comes from running
many tickets in parallel — one ticket, one Worker. Tickets are GitHub-shaped: a
ticket has a branch, optionally a PR, and CI status flowing back to the board.
Merging the PR auto-completes the ticket.

Fredrin owns the worktree's lifecycle for you: it is created when the ticket
starts building and torn down — best-effort, from the desktop app — when the
ticket's PR merges **or when you delete the ticket** (deleting cleans up every
worktree the ticket ever produced). **Archiving** a completed ticket only hides
the card; it leaves the worktree on disk. If the desktop app isn't running when
a worktree is meant to be removed, it simply lingers until the next cleanup or a
manual `git worktree remove`.

If a fresh checkout of your project needs bootstrap steps (install deps,
materialize `.env`, seed a database), commit a **`.fredrin/setup.sh`**: a
remote agent runs it automatically right after creating a ticket worktree (via
`sh`, cwd = worktree root, bounded to 10 minutes, output streamed into the
job log; a failure warns and the session continues). It runs once per new
worktree — keep it idempotent anyway. Machines can opt out with
`FREDRIN_AGENT_NO_SETUP=1`.

## Kanban workflow

Tickets move left-to-right across the board, driven by **deterministic signals**
— no model discipline required:

1. **Backlog** — captured, not yet started. Human presses Run → spawns a session.
2. **Running** — a Worker is actively working (session just started).
3. **Blocked** — human-marked; the Worker needs input before continuing.
4. **Review** — the session ended; a human glances at the diff and ships or sends back.
5. **Completed** — the human clicked Complete (or the PR merged).

The board column is driven by Claude Code's lifecycle hooks (SessionStart →
Running, Stop/SessionEnd → Review) plus one explicit human action for Completed.
You do not need to call any CLI to move the ticket — running your work is enough.

**Need the human before you can continue? Ask with the `AskUserQuestion` tool —
never end your turn on a bare prose question.** When you call `AskUserQuestion`,
Fredrin parks the ticket in **Blocked** the instant the picker opens (a
deterministic signal), fires the attention bell, and keeps this session live so
the human answers in place and you resume the same turn. A question you only
*type out* and then stop on is read as "turn finished" and ships the ticket to
**Review** — your question goes unanswered. So: a real decision point → `AskUserQuestion`;
prose is for explaining, not for waiting.

## Project workflow rules

If **`.fredrin/WORKFLOW.md`** exists in the repo, read it at the start of every
session and follow it. It is the project's user-authored, committed, free-text
rules file — it steers how work runs here (which model/effort a task uses, how
tickets are labeled, what standards descriptions must meet, and anything else
the user wrote). Treat its rules as binding for this project, alongside this
file. It may be absent (no rules set yet) — that's fine; just proceed.

## Talking to Fredrin in plain language

Fredrin is the platform you are running inside, and it has its own vocabulary.
When the user speaks colloquially, map their words to these concepts and act
through the `fredrin` CLI — don't make them learn Fredrin's terms first. This is
**Fredrin platform vocabulary**: it is identical in every project, so it lives
here in FREDRIN.md, not in your project's own `CONTEXT.md` glossary (see
**Team guidelines** for that split).

### The two CLIs — know which one you have

There are two `fredrin` commands. They are different programs; pick by where you are.

Both are **strictly noun-verb: `fredrin <noun> <verb> [opts]`** — every command
names the resource it acts on (`tickets get <id>`, `projects list`, `ticket finish`),
and a noun AND a verb are both required, so intent is never ambiguous. The old flat
verbs (`get`, `create`, `start`, …) and short noun spellings (`goal`/`term`/`reap`)
have been **removed** — they exit with a pointer to the canonical form. Run
`fredrin --help` (or `./.fredrin/fredrin` with no args) for the live verb map.

- **Global `fredrin`** — on `$PATH` in every Fredrin desktop terminal (rewritten
  at each app launch, so it is never stale). Works with **no ticket bound**: list
  projects and tickets, create tickets, dispatch Workers, drive terminals. This is
  the entry point when a user opens a plain terminal and asks for something. Run
  `fredrin --help` to see exactly which verbs this app build offers — and the
  session preamble lists the currently-available global verbs (it is regenerated
  every session, so it is always current).
- **Per-ticket `./.fredrin/fredrin`** — exists only **inside a ticket's worktree**
  and carries a scoped token for *that* ticket. Reads and mutates the current
  ticket via the `ticket` noun (`ticket get`, `ticket update-plan`, `ticket check`,
  `ticket finish`, …). Documented in full under **The `./.fredrin/fredrin` CLI** below.

Inside a ticket worktree both are available; in a plain project terminal only the
global `fredrin` is.

### Nouns — what the user's words mean

| User says | Means in Fredrin | NOT |
|---|---|---|
| task, card, todo, issue, story | a **Ticket** | a GitHub issue — unless they say "GitHub issue" |
| repo, codebase, app, project | a **Project** | — |
| the AI, the agent, claude, the bot | a **Worker** (one Ticket = one Worker) | — |
| job, run, build | **executing a Ticket** (spawning its Worker) | a CI job |
| my board, my kanban, the columns | the **Tasks board** | — |
| org, team, account | a **Workspace** | — |
| dev server, localhost, the app running | a **Server** | — |
| goal, milestone, objective, epic, workstream, group of tickets | a **Goal** (a named, colored grouping of tickets in a project) | a Project (the repo) or a GitHub milestone |

### Intent → action

| The user wants to… | Do this |
|---|---|
| create a ticket / make a task / file an issue | `fredrin tickets create '{"title":"…"}'` (lands in the Backlog) |
| group tickets / track a milestone / make a goal | `fredrin goals create '{"name":"…","description":"…"}'` — **always pass `description`**: it is the goal's plan and renders as the goal plan on the board (a name-only goal leaves it blank) — then `fredrin goals assign <goal> <ticket…>` (the goal groups them; tickets stay flat on the board) |
| create a goal and its tickets / plan a goal into tickets / break a goal down | Create the goal **with its plan** — `fredrin goals create '{"name":"…","description":"<an encompassing overview of the tickets>"}'` (skip the create if the goal already exists; the `description` is the goal's source-of-truth plan and renders as the goal plan on the board). On a fresh multi-ticket goal, **enable ship-together** — `fredrin raw POST goals/<goalId>/staging '{"enabled":true}'` (best-effort; skip if the project has no GitHub repo) — so the whole goal merges to the project's target branch as one unit and auto-merges when done. Then **infer the dependency graph** among the tickets (which are prerequisites of which) and **create prerequisites first**, passing `"dependsOn":["<prereq-ref>",…]` on each dependent so it lands *blocked by* those tickets — each ref is the prerequisite's id or identifier (`FRED-ABC123`), and the dependency tickets get created too, not only the top-level ones. Confirm every edge landed by reading `dependsOnResults` on each create response. Finally `fredrin goals assign <goal> <ticket…>` to file them all under the goal |
| create several related tickets (no goal — a batch that builds on itself) | Map which tickets are prerequisites of which **before creating anything**, create prerequisites first, pass `"dependsOn":["<prereq-ref>",…]` on each dependent's create, then verify every edge — the full protocol is **Creating several related tickets — wire the dependency graph** below, and it is mandatory for every multi-ticket batch, goal or no goal |
| run it / run a job / build the ticket / start it | `fredrin tickets start <id>` (verb aliases: `build`, `run`) |
| run the app / start the dev server / spin up localhost | `fredrin servers start <id>` (or `--all` for every server); list with `fredrin servers list`, stop with `fredrin servers stop`. These live in the **Local Servers** tab |
| what's on my board / list my tickets | `fredrin tickets list` |
| show one ticket | `fredrin tickets get <id>` |
| what projects do I have | `fredrin projects list` |
| show one project / where does its Memory live | `fredrin projects get <id>` (inside a ticket worktree: `./.fredrin/fredrin project memory`) — the configured Memory folder and its resolved `concepts/`/`adr/`/`notes/` paths |
| open a terminal / split panes | `fredrin terminals …` |
| ship it / send to review / open a PR / it's done | inside the ticket worktree: `./.fredrin/fredrin ticket finish` (records an already-open PR instead with `./.fredrin/fredrin ticket ship`) |

The set of global verbs grows over time (e.g. server controls land later). When
this table and the session preamble's live verb list disagree, trust the
preamble and `fredrin --help` — they reflect what this build actually ships.

### Hard disambiguation rules

- **ticket / task / card / issue / todo → always a Fredrin Ticket** via the CLI,
  unless the user explicitly says "GitHub issue."
- **ship / finish → open a PR and move the ticket to Review — NEVER merge or
  deploy.** Merging is the human's gate; you never cross it.
- **job / run / build → start a Worker on a Ticket**, not a CI run.
- **"start" / "run" is ambiguous — read the object.** "start / run *the ticket /
  task / build*" → dispatch a Worker (`fredrin tickets start <id>`). "start / run *the app
  / dev server / localhost*" → a **Server** via `fredrin servers start`, shown in
  the **Local Servers** tab. Never conflate the two.
- **goal / milestone / objective → a Fredrin Goal.** When the user wants related
  tickets grouped (or names a milestone), create the Goal with `fredrin goals
  create` and file the work into it with `fredrin goals assign` — don't fake it
  with labels or a parent ticket. A Goal groups many tickets and a ticket can be
  in many Goals; the board stays flat. **When the goal already exists** (the user
  asks to *plan* or *break down* a goal — e.g. a prompt pasted from the goal
  panel), skip the create and go straight to making its tickets and assigning
  them. **`fredrin goals assign <goal> <ticket…>` is not optional — the tickets
  do not join the goal until you run it.**
  - **Always give the goal a `description`** — an encompassing overview of its
    tickets. It is the goal's plan (the source of truth) and renders as the goal
    plan on the board; **never create a name-only goal** (it leaves the plan blank).
  - **Take care of dependencies — infer them, don't wait to be told.** The
    **Creating several related tickets** protocol below applies in full to a
    goal batch — including its verification steps. In short: work out
    which tickets are prerequisites of which and wire the graph: create the
    prerequisite tickets first (so their ids exist), then pass
    `"dependsOn":["<prereq-ref>",…]` on each dependent so it lands *blocked by* its
    prerequisites. The dependency tickets get **created too**, not only the
    top-level ones. Each ref may be the ticket **id** or its **identifier**
    (`FRED-ABC123`) — whichever the create response gave you — but it must name a
    ticket you already created on this same board; omit `dependsOn` entirely when a
    ticket has no prerequisites, and never pass `[""]`.
  - **Check that the edges actually landed.** A create that carried `dependsOn`
    echoes `dependsOnResults` — one entry per ref, each `{"ok":true}` or carrying
    an `error` (`dependency_not_found`, `dependency_cycle`, …). Bad refs are
    skipped, not fatal, so the ticket is still created: **read the results and fix
    any `ok:false` ref before moving on** (re-wire it with
    `fredrin raw POST tickets/<id>/dependencies '{"blockingTicketId":"<id>"}'`).
    Never assume the graph is wired just because the create returned 201.
  - **Default a batch-created goal to ship-together.** When you create a goal
    *together with* a set of tickets, enable its staging branch —
    `fredrin raw POST goals/<goalId>/staging '{"enabled":true}'` — so the goal
    ships as one unit: its tickets branch off it and the whole branch auto-merges
    to the project's target branch once every ticket is complete. Best-effort: skip it if the project
    has no GitHub repo (the call 4xxs) and continue without staging.

### Creating several related tickets — wire the dependency graph (MANDATORY)

This protocol applies **every time you create two or more related tickets in one
request — with or without a goal.** The board only knows a dependency when the
edge is actually set through the API: **prose is not a dependency.** A "depends
on ticket 2" written into a description, a plan, or a `## Constraints` section
wires nothing — the board will happily run both tickets in parallel. Knowing the
dependencies but not applying them is the exact failure this protocol exists to
kill: the batch is **not done** until every edge is set and verified.

1. **Map the graph before creating anything.** List every ticket you are about
   to create and, for each, which siblings must complete first (its
   prerequisites). If genuinely nothing depends on anything, say so explicitly
   in your recap and create them in any order.
2. **Create prerequisites first** — dependency order — so every prerequisite's
   `id`/`identifier` exists before any ticket that waits on it.
3. **Pass `"dependsOn":["<prereq-ref>",…]` on the dependent's create call
   itself.** Each ref is the prerequisite's `id` or `identifier` read back from
   *its* create response. Never create now intending to wire edges later —
   "later" is where dependencies slip. Omit `dependsOn` only for tickets with no
   prerequisites.
4. **Check `dependsOnResults` on every create response** and repair failures
   immediately — the exact contract is in **Check that the edges actually
   landed** above; a repair call
   (`fredrin raw POST tickets/<id>/dependencies '{"blockingTicketId":"<id>"}'`)
   takes the **full ids** from the create responses, not identifiers.
5. **Verify the whole graph before reporting done.** Re-read each dependent —
   `fredrin raw GET tickets/<id>/dependencies` — and confirm its `blockedBy`
   list matches the graph from step 1. Then tell the user which edges you set
   ("FRED-CCCCCC is blocked by FRED-AAAAAA and FRED-BBBBBB"). A batch with an
   intended edge missing is unfinished work, exactly like a failing acceptance
   check — fix it before you reply.

### Recognizing work that should become a ticket

Stay alert for work that should become a ticket — recognize the intent **even when
the user never says "ticket"**: a feature request, a bug report, a "we should…" or
"can you add…", any task / card / todo / issue / story.

But **trigger conservatively, and only ever offer — never auto-create.** Suggest a
ticket only when the work is a **distinct unit of work that would run as its own
Worker** *and* is **concretely scoped** (detailed enough to write a clear title)
*and* isn't already covered by the current ticket. These are **not** triggers:
questions, brainstorming, debugging the task at hand, or anything still vague —
when in doubt, ask instead of assuming.

When the bar is met, propose it and **confirm the title with the user before**
running `fredrin tickets create '{"title":"…"}'` (one ticket per distinct piece of work).
It lands in the Backlog for the human to run.

### When you create a ticket, transfer your context into it

<!-- planner-builder-rule:start — GENERATED from src/lib/planner-builder-rule.ts (PLANNER_BUILDER_RULE_MD); edit there, then run `pnpm gen:planner-rule` -->
**The planner is the smartest model in the pipeline — never assume the build
agent is.** When you generate a ticket (a decompose subtask, a spawned
follow-up), you hold context a later, possibly weaker Worker will not: repo
knowledge, grilled decisions, the chat so far. Don't record only the *ask* —
transfer that context into the ticket so a lesser agent can execute it without
re-deriving it or searching the whole repo. Every generated ticket ships with a
full plan (`fredrin tickets create '{"title":…,"description":…,"plan":…}'`): the
five-section plan (`## Outcome`, `## Acceptance checks`, `## Touchpoints`,
`## Constraints`, `## Open questions`) naming exact touchpoints (repo-relative
paths), the constraints and patterns to follow, verbatim copy/values the builder
would otherwise invent, and runnable acceptance checks. State every decision you
skipped as an explicit assumption, and put every unknown under `## Open
questions` — never omit it, and never ship an empty plan.
<!-- planner-builder-rule:end -->

## The `./.fredrin/fredrin` CLI

This is the **per-ticket** CLI from the two above — it lives in the current
ticket's worktree and acts on that ticket. (For the global, ticket-free
`fredrin`, see **Talking to Fredrin in plain language**.) Each session's worktree
gets a `./.fredrin/fredrin` wrapper (git-ignored; it carries a scoped API token).
Use it to read or mutate the current ticket. Every command is `ticket <verb>`
(plus `plan <verb>` for the plan and `project <verb>` for the ticket's project);
the old bare verbs were removed, so `ticket get` is the only form (a bare `get`
exits with a pointer to it):

- `./.fredrin/fredrin ticket get` — fetch the current ticket
- `./.fredrin/fredrin ticket update-plan <<'PLAN'` … `PLAN` — save the implementation plan
  from **stdin** (preferred; no JSON escaping, no temp file). Use markdown with a
  `## Action items` GFM checklist (`- [ ]` / `- [x]`). Do NOT `jq` a temp file or
  hand-build `'{"plan":"..."}'` — a blocked or partial temp-file write makes jq
  slurp stale content and saves the wrong plan.
- `./.fredrin/fredrin ticket check <n>` / `ticket uncheck <n>` — flip ONE action item by its
  1-based position in the plan without re-sending the whole plan. Cheap and atomic,
  so during **Build** flip each item the moment you finish it — progress then
  updates in real time. (Also: `plan check <n>` / `plan uncheck <n>`.)
- `./.fredrin/fredrin ticket update '{"plan":"..."}'` — same effect as `update-plan` via
  inline JSON (only if you cannot use a heredoc)
- `./.fredrin/fredrin ticket update '{"description":"..."}'` — PATCH ticket fields
- `./.fredrin/fredrin ticket comment '{"body":"..."}'` — post a comment
- `./.fredrin/fredrin ticket context [--budget N]` — relevance-scoped Memory pointer pack (JSON)
  for this ticket: the concepts and decisions it actually touches. Run it at session start.
- `./.fredrin/fredrin ticket context-classify [--notes "..."]` — **advisory** significance gate:
  reads this ticket's local diff and advises whether the change warrants its own ADR
  (`routine` → no ADR; `significant` → add one under this project's Memory `adr/`
  folder, **and** update the concept doc under its `concepts/` folder). Both halves
  live in the same bundle — get their real paths from `project memory` below rather
  than guessing, and never do only the ADR half. Never blocks the build.
- `./.fredrin/fredrin project memory` — print **where this project's Memory actually
  lives**: the configured folder plus the resolved `concepts/`, `adr/` and `notes/`
  paths and the glossary entry-point. Read live from the project's setting, so it is
  the truth even when a committed doc (including this file) says otherwise. Run it
  before writing a concept doc or an ADR.
- `./.fredrin/fredrin ticket screenshot <url>` — capture a screenshot of `url`, upload it, and
  attach it to this ticket as an artifact (no `url` → captures the PR preview). Run this
  the moment the user asks to "take a screenshot of …" or "upload a screenshot" — the
  server does the Playwright capture + S3 upload + attach; you never touch either directly.
- `./.fredrin/fredrin ticket upload <file> [--label text] [--kind before|after] [--pair key]` —
  attach a LOCAL file (screenshot, screen recording, HTML mockup, log) to this ticket as
  an artifact. For before/after evidence, upload the pre-change capture with `--kind
  before` and the post-change capture with `--kind after`, reusing the same `--pair`
  slug per screen so the board shows them side by side.
- `./.fredrin/fredrin ticket publish-app <file.html> [--changelog text]` — **app tickets only**
  (the kind filed from Apps → Build your own): store an HTML document as the app's next
  immutable version. The ticket's plan carries the contract the document must satisfy; the
  body sent is the file itself, so nothing has to survive shell quoting. A document that
  names a `fredrin.*` method the SDK does not have, or that reaches the network, is
  REFUSED rather than stored, and the reply names the call to fix. Publishing a version is
  not publishing the app to the workspace — that stays a human's button on the ticket.
- `./.fredrin/fredrin ticket finish '{"checks":[{"command":"pnpm typecheck","exitCode":0}],"summary":"..."}'` — **your final act.** Records your
  acceptance-check results, pushes the branch, opens the PR (reusing one if it already exists),
  and moves the ticket to Review — all in one call. **A red check does not withhold the PR**: the
  failure is recorded (needs-work label, red CI pill) and written into the PR body, then the PR
  opens anyway — a red PR a human can read beats finished work nobody can see. It merges a clean,
  behind base INTO your branch first, so the PR is up to date with its target — but it only ever
  opens a PR: never merges the PR, never pushes the base branch. **Each check is `{"command":"<the command you ran>","exitCode":<its real exit code>}`** —
  `exitCode` 0 = pass, any non-zero = fail (the fields are `command` and `exitCode`, NOT `name`/`passed`; a missing
  `exitCode` is read as failed). Pass `"checks":[]` when the ticket's build steps did not ask
  for verification — `finish` then records nothing and goes straight to push + PR.
- `./.fredrin/fredrin ticket ship '{...}'` — record an already-open PR URL (board moves to Review). Prefer
  `ticket finish`, which calls this for you at the end of the build.
- `./.fredrin/fredrin ticket error '{"reason":"...","where":"..."}'` — surface a build failure

**`finish`/`ship` reject a large payload with `curl exit 56` / HTTP 400 — and `finish`
has already pushed and opened the PR by then.** The push, the PR and its body all
succeed; only the record-the-result call fails, so the branch looks shipped while the
board still says Running. When you see that error, do NOT re-run `finish` and do not
assume nothing happened: `gh pr list --head <branch>` first, then record the existing PR
with a SHORT `ticket ship '{"prUrl":"…","summary":"…"}'`. Keep the long write-up in the
PR body where it belongs; a `summary` of a few hundred characters goes through, and a
16 KB one does not. The `checks` array appears to be part of what tips it over — if
`ship` still 400s, drop `checks` and post the results as a `ticket comment` instead so
the exit codes are still on the board.

Do not echo or log the contents of `./.fredrin/fredrin` — it holds a credential.

## Composing markdown payloads from the shell

The most common stored-text corruption: **backslash-escaping backticks inside a
quoted heredoc.** Inside `<<'EOF'` … `EOF` nothing is expanded — write the
markdown verbatim, backticks included. A `` \` `` there is NOT an escape; the
backslash lands in the stored text and every code span renders broken.

- Prefer the stdin verbs (`ticket update-plan <<'PLAN' … PLAN`) — no JSON
  escaping at all.
- For JSON bodies that carry markdown (`ticket update`, `ticket comment`),
  write the markdown to a file via a quoted heredoc, then build the body with
  `jq -n --rawfile d file.md '{description:$d}'` — never hand-escape markdown
  into a JSON string.

## Self-healing: verify every stored write

After any write that stores human-visible text (ticket update, plan, comment),
**read the stored result back** (the update response, or `ticket get`) and scan
it for escape artifacts: `` \` ``, literal `\n` sequences, doubled backslashes,
mangled markdown. If you find any:

1. **Fix it immediately** — re-send the corrected text with a follow-up update.
   Never leave a corrupted description or plan on the board.
2. **Record the lesson** — if the mistake traces to a guidance gap, append a
   short bullet to the relevant section of this file (FREDRIN.md) in its own
   `context:`-prefixed commit so the fix ships with your PR and every future
   Worker inherits it. This file is committed and Worker-editable by design —
   that edit loop is how it self-heals.

The rule generalizes beyond escaping: whenever a job trips over a repeatable
tooling trap (quoting, paths, stale state), fix the artifact first, then patch
the instructions that allowed it.

## Building a ticket

When you start a Build, treat the plan's **acceptance checks** as the contract —
its definition of done, and a live checklist, not a list flipped (if ever) at the
very end:

- **Review them upfront.** Before writing any code, read every acceptance check
  from the plan (`./.fredrin/fredrin ticket get`) and, for each, restate the concrete
  pass/fail signal you will drive it to — the command to run, the HTTP response,
  the UI state to observe. Build toward verifiable outcomes, not vibes.
- **Validate with evidence, tick as you go.** The moment you finish an item,
  confirm it is actually met by running its command or observing its state — real
  evidence, never self-graded prose — then immediately `./.fredrin/fredrin ticket check <n>`
  it (`<n>` is its 1-based position in plan order). Do this one item at a time as
  you go, never batched at the end, so the board shows real-time progress. Only
  ever check an item you have positively verified.
- **Verify, then finish — in one breath.** Your LAST action is `./.fredrin/fredrin ticket finish`.
  When the ticket's **Additional build steps** ask for verification (typecheck &
  lint, tests, QA review, …), run those checks and pass their results — real exit
  codes, never assumed. When the ticket requested no verification, pass
  `"checks":[]` — do not run or invent checks the human didn't ask for. A
  finished build with **no PR** is the failure to avoid, so `finish` pushes the
  branch, opens the PR, and moves the ticket to Review whatever the checks said.
  Red checks are recorded (needs-work) and spelled out in the PR body rather than
  hidden — report them honestly and say whether the red is yours or came from the
  base; never edit an exit code to 0. See **Ending the session** below.
- **Crossing a client/server boundary? Run `pnpm build`.** If your change touches a
  `"use client"` file (or adds an import into one), `typecheck`+`lint`+`test` are
  insufficient — they never run `next build`, so a client chunk pulling a node-graph
  value passes them but breaks the production build (and blocks every deploy). Run
  `pnpm build` as an extra acceptance check. See `AGENTS.md` → *Client/server import
  boundary*.

## Non-code deliverables — post them on the ticket

Not every ticket is a code change. When the task is to produce a **content
deliverable** — a blog post, an HN post, a tweet, a social caption, marketing
copy, a document, a research write-up, or a generated image — the human reads it
**in the ticket's Artifacts panel**, not by opening a loose file in the worktree.
Post it the moment it's ready with the `upload` primitive above:

    ./.fredrin/fredrin ticket upload draft.md --label "Blog post draft"

A `.md`, `.txt`, image, PDF, or `.html` renders inline (markdown is shown
formatted, so no external reader is needed). For a short snippet a
`./.fredrin/fredrin ticket comment` works too. Keep writing the file in the worktree —
just don't make that the only place the deliverable lives.

If the ticket is **purely** a content deliverable with no code change, you don't
need a PR: upload the artifact, post a one-line recap comment, and end your turn.
The board moves to Review for the human to glance and Complete — `finish` is for
code changes and has nothing to PR here.

## Ending the session

The board column moves to Review automatically when your session ends (the Stop
hook) — but a finished build with **no PR** is the exact failure to avoid, so make
opening a PR part of finishing. **You never need permission to commit, push, or
open the PR** — starting the build was the human's go-ahead, and on an unattended
lane no one is standing by to approve. So once the work is done, commit and run
`finish` **yourself, in the same turn**; never end a turn by asking *"want me to
commit / open the PR?"* or leave your changes staged-but-uncommitted waiting for a
go-ahead — that strands the ticket. First clear the **pre-PR checklist** below
(resolve any merge conflicts the gate reports, then write to Claude memory) — see **Shipping (when the
work is done)** — then:

- **Work is done** → run `./.fredrin/fredrin ticket finish` with your acceptance-check results
  (`"checks":[]` when the ticket requested no verification). It pushes the branch,
  opens the PR, and moves the ticket to Review in one call — red checks included,
  recorded as needs-work and written into the PR body.
- **Build failed** → call `./.fredrin/fredrin ticket error` to surface the failure.
- Never call `finish`/`ship` and `error` in the same session.

## Shipping (when the work is done)

### Before you push — pre-PR checklist

Run this gate **before** you open the PR (before `finish`/`ship` or the manual
push), every time. Both steps are required:

1. **Merge conflicts — `finish` syncs the base for you.** `finish` (and
   `autofinish`) fetch the target branch, simulate the merge, and — when it is
   clean — **merge `origin/$BASE` into your branch for you**, right before the
   push, so the PR opens up to date with its target. You only step in when the
   gate reports **conflicts**: it refuses the PR and prints the conflicting paths,
   so `git fetch origin` then `git merge origin/$BASE`, resolve every conflict,
   commit, and re-run `finish`. Don't push a branch that will land red.
2. **Write to Claude memory.** Before pushing, capture this ticket's non-obvious
   learnings as a Claude memory entry (the persistent file-based memory under
   `~/.claude/.../memory/` — one fact per file, plus a one-line pointer in
   `MEMORY.md`), following the memory rules in your global instructions. Record
   what a future Worker would need and couldn't re-derive from the code or git
   history — not what the repo already documents.

Only once **both** steps are done do you push up the PR.

Prefer the one-call finisher — it makes opening a PR deterministic instead of a
multi-step sequence you might skip:

    ./.fredrin/fredrin ticket finish '{"checks":[{"command":"pnpm typecheck","exitCode":0}],"summary":"..."}'

`finish` records your verification and runs the steps below for you (push →
open/reuse PR → record it → Review) — red checks do not stop it. Commit everything
first (it refuses on a dirty tree). Run the acceptance checks yourself — and pass
their real exit codes — only when the ticket's build steps asked for verification;
otherwise pass `"checks":[]`.

If you must do it by hand (e.g. `finish` reports a problem it can't resolve), run
this exact sequence — no improvisation, no skipping steps:

1. **Detect the default branch** into `$BASE`
   (`gh repo view --json defaultBranchRef --jq .defaultBranchRef.name`, falling
   back to `git symbolic-ref refs/remotes/origin/HEAD` /
   `git remote show origin`). If none resolve, `./.fredrin/fredrin ticket error` with
   `where:"detect-base"` and stop.
2. **Commit** all changes with a clear conventional message (subject ≤ 72 chars,
   imperative; body explains *why*). Project Context changes go in their own
   commits prefixed `context:`.
3. **Push** the working branch: `git push -u origin HEAD`. On rejection,
   `./.fredrin/fredrin ticket error` with `where:"push"` and stop.
4. **Open the PR** — prefer
   `gh pr create --base "$BASE" --title "..." --body "..."`. End the body with
   `Closes ticket: <the current ticket's identifier>` (see the session preamble
   or `./.fredrin/fredrin ticket get`).
5. **Record it**:
   `./.fredrin/fredrin ticket ship '{"prUrl":"...","summary":"...","branch":"...","targetBranch":"..."}'`.

Hard rules:

- Never merge the PR yourself; never push to the base branch. `finish` merges the
  base branch INTO yours and opens a PR — nothing more; it never merges the PR and
  never releases.
- Never change the ticket's status with `ticket update` — `finish` / `ship` /
  `error` are the status-recording calls; the board column moves from hooks, not
  from explicit finish calls.
- Never call `finish`/`ship` and `error` in the same session.
- If the ticket already has a PR for this branch, `finish` reuses it; only branch
  fresh from `$BASE` with a new name when you truly need a separate PR.

## Team guidelines

Customize this section for your project — coding standards, review expectations,
definition of done, branch naming, and anything every Worker should know before
touching code. Durable knowledge about **your own app's domain** (its glossary,
decisions, conventions) belongs in your Project Context files — `CONTEXT.md`,
`AGENTS.md`, and this project's **Memory bundle** (concept docs in its
`concepts/` folder, decision records/ADRs in its `adr/`) — not here.

**Where that bundle lives is a per-project setting, so read it — never hardcode
it.** Run `./.fredrin/fredrin project memory` (or `fredrin projects get <id>`
from a plain terminal) to print the configured folder and the resolved
`concepts/`/`adr/`/`notes/` paths. Repointing the Memory folder in project
settings moves the **whole** bundle — concepts, decisions, and notes together —
so a path copied out of a doc, or out of this file, can be stale. The default is
`.fredrin/memory/`; Fredrin's Memory tab reads whatever the setting says.
The one exception is **Fredrin platform
vocabulary** — what a Ticket / Worker / Project is and how to drive the `fredrin`
CLI: that is the same in every project, so it lives in this file (see **Talking to
Fredrin in plain language** above), not in your per-project `CONTEXT.md`.
