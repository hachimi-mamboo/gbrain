# Multi-source brains

**A single gbrain database can hold multiple knowledge repos.** Each one
is a `source`: a logical brain-within-the-brain with its own slug
namespace, its own sync state, and its own federation policy. The rest
of this guide walks the three canonical scenarios.

(Sources are the *within-one-database* axis. If you want to connect a
whole separate database — a team-published brain with its own access
policy — that's the *brain* axis: `gbrain mounts add`. See
`docs/architecture/brains-and-sources.md` for the two-axis topology.)

## The three scenarios

### 1. Unified knowledge recall (wiki + gstack)

You have a personal wiki and a `gstack` checkout. Both belong to you,
both are knowledge you want your agent to recall across. When you ask
"what did I learn about X?" you want the best hit whether it lives in
the wiki or in a gstack plan.

```bash
# Register the gstack source, federate so it joins cross-source search
gbrain sources add gstack --path ~/.gstack --federated

# Pin the directory so `gbrain sync` knows which source it's walking
cd ~/.gstack && gbrain sources attach gstack

# Initial sync
gbrain sync --source gstack

# Now `gbrain search "retry budgets"` returns hits from BOTH wiki and
# gstack. Each result includes source_id so the agent can cite properly.
```

Result: wiki pages and gstack plans are separate (different source_ids,
different slug namespaces) but share the search surface.

### 2. Purpose-separated brains (yc-media + garrys-list)

You run two completely different content pipelines on the same backend.
YC Media covers portfolio news and founder profiles. Garry's List is
personal writing. You explicitly DON'T want them mixed in search — YC
portfolio content leaking into essay searches is a bug, not a feature.

```bash
# Two sources, both isolated (federated=false)
gbrain sources add yc-media --path ~/yc-media --no-federated
gbrain sources add garrys-list --path ~/writing --no-federated

# Pin each checkout directory
(cd ~/yc-media && gbrain sources attach yc-media)
(cd ~/writing && gbrain sources attach garrys-list)

# Sync each independently
gbrain sync --source yc-media
gbrain sync --source garrys-list
```

Result: searching from neither directory returns the `default` source
(your main brain). Searching from inside `~/yc-media` returns only yc-
media hits. Searching from inside `~/writing` returns only garrys-list.
Federation is opt-in, not leaked.

To search across them explicitly on demand:

```bash
gbrain search "tech layoffs" --source yc-media,garrys-list
```

### 3. Mixed (wiki federated + sessions isolated)

Your main wiki is federated with a few trusted sources. Your session
transcripts (`gbrain transcripts` ingests them) land in a separate
isolated source so they don't dominate every search result.

```bash
# Federated sources
gbrain sources add gstack --path ~/.gstack --federated

# Isolated source for session transcripts
gbrain sources add sessions --path ~/.claude/sessions --no-federated
```

## Resolution priority

When any command needs to pick a source, gbrain walks this list (highest
first):

1. Explicit `--source <id>` flag.
2. `GBRAIN_SOURCE` environment variable.
3. `.gbrain-source` dotfile in CWD or any ancestor directory.
4. A registered source whose `local_path` contains the CWD (longest
   prefix wins for nested checkouts).
5. The brain-level default set via `gbrain sources default <id>`.
6. The seeded `default` source.

So inside `~/.gstack/plans/` on a brain that pinned `gstack` to
`~/.gstack` via `.gbrain-source`, `gbrain put` implicitly writes to
the `gstack` source. Outside any registered directory with no env/dotfile
set, it writes to the default.

## Client-local checkout binding

Clients that share one database and Git remote can keep the same source
identity while cloning it to different local paths. Set both variables for
the process running a single-source operation:

```bash
export GBRAIN_SOURCE=wiki
export GBRAIN_SOURCE_PATH=/absolute/path/to/this-client/brain-wiki
```

`GBRAIN_SOURCE_PATH` applies only to the matching `GBRAIN_SOURCE`. It is
process-local, must be absolute, and never persists or overwrites the shared
`sources.local_path`. For a single-source operation, an explicit `--repo`
checkout wins over the matching client binding, which wins over the shared
source or legacy path. It is not applied to `--all` operations.

`gbrain sync trigger` refuses a matching client-local binding because its
queued worker cannot inherit process-local state without persisting the path.
Run `gbrain sync --source <id>` inline in that client instead.

### One client-local checkout for every active source

When one private brain repo is the Git projection for the whole database, bind
that checkout independently of source selection:

```bash
export GBRAIN_BRAIN_REPO_PATH=/absolute/path/to/this-client/brain-repo
unset GBRAIN_SOURCE_PATH

# Restore or reconcile every source represented by the checkout.
gbrain sync --all --no-embed
```

`GBRAIN_BRAIN_REPO_PATH` is process-local and must be an absolute path naming
the Git checkout root. A repo subdirectory is rejected. Within `gbrain sync`,
this binding supports only the whole-brain `sync --all` path:

| Input | Shared-checkout contract |
|---|---|
| No `--all` | Rejected; the binding is a whole-brain projection. |
| `GBRAIN_SOURCE_PATH` | Rejected; choose shared-checkout or single-source mode. |
| `--repo` | Rejected; the environment binding already names the checkout. |
| `--source` | Rejected; source identity comes from the projection layout. |
| `--src-subpath` | Rejected; monorepo subpath sync is a separate, non-shared mode. |
| `--watch` | Rejected; run explicit `sync --all` cycles. |
| `--timeout` | Rejected; one checkout-level pull covers the whole run. |

The physical layout is stable and source-qualified:

| Logical identity | Git path |
|---|---|
| `(default, <slug>)` | `<repo>/<slug>.md` |
| `(<source-id>, <slug>)` | `<repo>/.sources/<source-id>/<slug>.md` |
| Non-default source identity | `<repo>/.sources/<source-id>/.gbrain-source`, one `<source-id>` line |

`.sources/` is a Git projection detail, never part of a page slug. The `default`
source owns the repository root. A root `.gbrain-source` is optional, but when
present it must be a regular file containing exactly `default` followed by one
LF or CRLF line ending. Non-default markers follow the same read contract with
their directory's source ID; GBrain always writes LF. Every active non-default
source's durable form includes its tracked marker. That marker keeps an
otherwise-empty source directory in Git and lets a fresh clone recover the
source identity before any page exists.

Do not delete or edit managed markers, and do not replace `.sources/`, a source
directory, or a marker with a symlink. Discovery fails closed on invalid source
ids, escaping directories, symlinks, and marker content that does not exactly
match its directory id. On an admitted live run, `sync --all` discovers direct
source directories, registers missing identities with `local_path=NULL`, and
restores the original `source_id` and source-relative slug. Full and incremental
sync use the same mapping for adds, modifications, deletes, and renames.
The first admitted bound operation also performs an idempotent cleanup of stale
client-local path state and cancels queued work that still depends on the old
checkout; source identity, stable remote configuration, commit, and sync
bookmark remain unchanged.

On a fresh database, this Git projection restores active page content and source
IDs only. It does not restore source-catalog metadata such as display names,
federation/config values, archive state, or archive expiry. Migrate or restore
that DB/operator metadata separately when it matters.

Archived DB rows are not active sync sources. Shared `sync --all` does not
import their projection, update their sync bookmark, or create their marker,
even if an old `.sources/<id>/` directory remains in the checkout. Archive state
is DB-only: on a fresh database, that old directory is discoverable as an active
source unless the operator also retired it from Git or restored the catalog.
While the binding is active, explicit permanent purge is rejected and automatic
expired-source purge retains the archived row. More importantly, an archive
created with this binding stores `archive_expires_at=NULL`, so an independent
maintenance process without the environment binding cannot auto-purge it after
72 hours. After checkout, layout, pull, and cost admission have succeeded, a
non-dry-run shared sync also upgrades every older archived row with a TTL to
this NULL no-auto-expiry state. A bound purge pass defensively upgrades any
expired row that still reaches it instead of deleting it. Neither a failed
admission nor `--dry-run` performs that DB migration. This is not a
database-wide topology flag: an explicit destructive remove/purge from an
unbound operator process can still delete the row, after which shared sync can
rediscover its still-present projection as active.

`gbrain sources remove <id>` fails closed while `GBRAIN_BRAIN_REPO_PATH` is
active because a DB-only delete would be reversed by projection discovery;
`gbrain sources purge` uses the same guard. Use `gbrain sources archive <id>`
for temporary reversible retirement while that archived DB row is retained.
Permanent retirement is an operator workflow: stop shared sync, remove
`.sources/<id>/`, commit and push that Git change, then unset
`GBRAIN_BRAIN_REPO_PATH` before hard-removing the DB row.

The entire checkout is one sync coordination boundary: GBrain takes the
cross-process repo-level `gbrain-sync:brain-repo` lock, processes its logical
sources serially, and performs one pull before discovery when an origin exists.
That DB lock serializes shared sync waves only; it is not a universal Git-writer
lock for write-through, `sources pull`, `sources harden`, DB-free cron jobs, or
operator Git commands.
Without `--no-pull`, uncommitted changes fail the run before DB cleanup or
source registration. `--no-pull` only skips the remote update and can let a
dirty checkout proceed; incremental change detection still follows committed
Git history. It neither turns uncommitted files into a new sync anchor nor
claims that the checkout is current with the remote.

Use the shared hardening command to make the projection format durable:

```bash
gbrain sources harden --all
```

This is the formal path that creates or validates markers for every active
non-default source, tracks them, commits them, and pushes the shared checkout.
A live sync may materialize a missing marker after admission, but an unhardened
local marker is not yet a fresh-clone recovery guarantee.

Shared dry-runs are read-only. Neither `gbrain sync --all --dry-run` nor
`gbrain sources harden --all --dry-run` registers sources, runs client-path
cleanup, creates projection directories or markers, or changes Git history.
Ordinary `sources add --path`, `GBRAIN_SOURCE_PATH`, and monorepo
`--src-subpath` deployments keep their existing non-shared behavior.

## Federation flag

Every source row stores `config.federated: boolean` in its JSONB config.

| Value | Meaning |
|-------|---------|
| `true` | Source participates in unqualified `gbrain search "X"` results. |
| `false` (default for new sources) | Source only searched when explicitly named via `--source <id>` or qualified citation. |

The seeded `default` source is `federated=true` so single-source brains
behave as you'd expect — every page appears in search.

Flip later with `gbrain sources federate <id>` / `unfederate <id>`.

## Commands

The most-used subcommands (run `gbrain sources --help` for the full,
always-current reference — it also covers `status`, `current`,
`set-cr-mode`, and the `push`/`pull` durability surface):

```
gbrain sources add <id> --path <p> [--name <n>] [--federated|--no-federated] [--force]
                               Register a source. id: [a-z0-9](?:[a-z0-9-]{0,30}[a-z0-9])?
                               --path must be a git repo (or a subdirectory of one) — see
                               "The git requirement for --path sources" below. --force
                               skips that check to register before git-init exists.
gbrain sources add <id> --url <git-url> [--pat-file <p>] [--clone-dir <path>] [--no-harden]
                               Clone + register a remote repo in one step; auto-hardens
                               for durability when a PAT is provided (see "Durability" below).
gbrain sources list [--json]   List all sources with page counts + federation state.
gbrain sources archive <id>    Soft-delete: hide from search, keep data for a TTL
                               grace window. Prefer this over `remove`.
gbrain sources restore <id>    Un-archive. `gbrain sources archived` lists expiries;
                               `gbrain sources purge` permanently deletes expired archives.
gbrain sources remove <id> [--confirm-destructive] [--dry-run]
                               Permanently cascade-delete a source (pages, chunks,
                               timeline). Shows an impact preview first.
gbrain sources rename <id> <new-name>
                               Change display name only; id is immutable.
gbrain sources default <id>    Set the brain-level default.
gbrain sources attach <id>     Write .gbrain-source in CWD (like kubectl context).
gbrain sources detach          Remove .gbrain-source from CWD.
gbrain sources federate <id>
gbrain sources unfederate <id>
```

## The git requirement for --path sources

Every `--path` source must be a git repository (or live inside one — a
subdirectory of a git repo works too) with at least one committed, tracked
file under that path. `gbrain sources add` validates this at registration
time and refuses a directory that doesn't qualify — no `.git` at all, a
`git init` with no commit yet, or a commit made before `git add` — with an
actionable error instead of silently registering a source that will fail
(or worse, "succeed" while importing nothing) on its first `gbrain sync`.
Fix it with:

```bash
git -C <path> init
git -C <path> add -A
git -C <path> commit -m "initial import"
gbrain sources add <id> --path <path>
```

Two details that are easy to miss:

- **Files must actually be committed, not just present.** The sync walker
  reads files through git objects, so `git init` alone — even followed by an
  empty commit (`git commit --allow-empty`) — isn't enough. Registration
  checks for real tracked content (`git ls-tree HEAD` scoped to the path),
  not just a resolvable `HEAD`, so this footgun is caught immediately
  instead of surfacing later as a sync that imports nothing.
- **`--force` registers the source anyway**, skipping the check. Use this if
  you're registering a path before an automated pipeline gets around to
  `git init`-ing it. GBrain never auto-`git init`s a `--path` source for
  you — it's your directory, not a gbrain-managed clone (same consent
  boundary as sync-time self-heal, which also never mutates a `--path`
  source without an explicit ask).

**If sync ever reports a problem with the sync anchor** (`last_commit`) —
after a force-push, a history rewrite, or a from-scratch `git init` on a
directory that was synced before — you do not need to reset anything by
hand. `gbrain sync` detects an unreachable or non-ancestor anchor
automatically and recovers: either a full reimport (anchor object missing)
or a direct tree-to-tree diff against the orphaned bookmark (anchor present
but rewritten), advancing the anchor to the new HEAD when it completes.

## Citation format for agents

When agents receive multi-source results they MUST cite pages in
`[source-id:slug]` form. Example:

> You told me about the distillation protocol — see [wiki:topics/ai]
> and [gstack:plans/multi-repo] for where this came from.

The citation key is `sources.id` (immutable). Renaming a source via
`gbrain sources rename` changes the display name only; existing
citations keep working.

## Writing to a specific source

```bash
# Pass --source explicitly
gbrain put topics/ai ... --source wiki

# Or rely on the dotfile / env / CWD match
cd ~/.gstack && gbrain put plans/multi-repo ...
# → source auto-resolves to gstack
```

Reads span federated sources by default. Writes require a resolved
source (explicit, inferred, or default). The resolver never picks a
source silently when ambiguous — it errors with a clear fix.

## Durability: keep a brain repo in sync (auto-harden)

A long-lived agent that writes to a knowledge-wiki git repo needs three
things to never lose work: pull before it edits, push every write, and not
go stale while it sits idle. `gbrain sources harden` installs all of that,
idempotently. The moment you add a brain repo with a token, it runs
automatically:

```bash
# Clone + register a GitHub repo, then auto-harden it for durability.
# Use a fine-grained PAT scoped to just this repo.
gbrain sources add wiki --url https://github.com/you/brain-wiki.git --pat-file ~/.secrets/wiki-pat
#   → clones, then installs: local auto-push hook, scripts/brain-commit-push.sh,
#     always-on durability rules in AGENTS.md/RESOLVER.md, a 30-min pull cron,
#     and a repo-scoped credential. Verifies push works before declaring done.

# Run the same audit on an existing source any time (idempotent):
gbrain sources harden wiki --pat-file ~/.secrets/wiki-pat

# Pull on demand (the cron calls the --path form, which never opens the DB):
gbrain sources pull wiki

# Remove the durability scaffolding (also runs automatically on `sources remove`):
gbrain sources unharden wiki
```

What hardening guarantees:

- **Pull-first, conflict-safe.** Every pull is a divergence-safe rebase. A
  dirty working tree is skipped (your in-progress edits are never touched); a
  rebase conflict is aborted cleanly and flagged for attention, never left
  half-applied.
- **Push is never deferred.** `scripts/brain-commit-push.sh "<msg>" <path>`
  commits and pushes atomically and refuses to report success without a
  confirmed push. The post-commit hook is a best-effort background fallback;
  the helper is the guarantee.
- **No silent staleness.** A 30-minute background pull keeps an idle session
  current. It runs DB-free, so it never contends with a live brain for the
  PGLite single-writer lock.

Flags: `--no-cron` skips the scheduled pull, `--no-verify` skips the push
probe, `--dry-run` reports what would change, `--json` emits a machine
report, `--all` hardens every source with a remote (same-account only).
`--no-harden` on `sources add` opts out of auto-harden.

Security: the push automation is installed locally per machine (never
committed into the repo), the token is wired per-repo (an existing
credential helper is reused when present), and it never appears in the repo,
the remote URL, logs, or the JSON report. For a self-hosted git server
reachable only over a filesystem path, set `GBRAIN_GIT_ALLOW_FILE_TRANSPORT=1`
(default is HTTPS-only).

## Upgrading an existing brain

`gbrain upgrade` runs the needed schema migrations automatically. Your
existing pages all live under `source_id='default'`. Behavior is
unchanged until you add a second source.

To add one:

```bash
gbrain sources add gstack --path ~/.gstack --federated
cd ~/.gstack && gbrain sources attach gstack && gbrain sync
```

Two commands. The existing default source is untouched.

## Related features that build on sources

- **Session transcript ingest** — `gbrain transcripts` (server-private:
  raw chat exports stay on the host machine).
- **Per-source retention** — `gbrain sources archive` / `archived` /
  `purge` (soft-delete with a TTL grace window).
- **One-shot remote bootstrap** — `gbrain sources add <id> --url <git-url>`
  (clone + register + auto-harden).
- **Access control across brains** — the *brain* axis (`gbrain mounts`);
  see `docs/architecture/brains-and-sources.md`.
