/**
 * Durability cron generators (v0.42.44, D2 + D12): pure-string renderers.
 * Asserts the cron is DB-free (gbrain sources pull --path, NOT `pull <id>`),
 * secret-free, self-disabling, and that the launchd plist is periodic.
 */
import { describe, test, expect } from 'bun:test';
import { execFileSync } from 'node:child_process';
import {
  chmodSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, symlinkSync, utimesSync, writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { withEnv } from './helpers/with-env.ts';
import {
  generateBrainPullPlist,
  renderCronWrapper,
  installDurabilityCron,
  durabilityJobStatus,
} from '../src/core/brain-repo-durability.ts';

const TOKEN = 'ghp_SHOULD_NEVER_APPEAR';

describe('renderCronWrapper (D2 DB-free)', () => {
  const w = renderCronWrapper('wiki', '/data/clones/wiki', 'main', ['/usr/local/bin/gbrain'], '/home/u/.gbrain/brain-push.log');

  test('calls the DB-free path command, not the engine-opening one', () => {
    expect(w).toContain("sources pull --path '/data/clones/wiki'");
    expect(w).toContain("--branch 'main'");
    expect(w).not.toMatch(/sources pull '?wiki'?(\s|$)/); // never `sources pull wiki`
  });

  test('self-disables via git rev-parse (recognizes worktrees where the git marker is a FILE), not a bare dir test', () => {
    expect(w).toContain("if ! git -C '/data/clones/wiki' rev-parse --is-inside-work-tree");
    expect(w).not.toContain("-d '/data/clones/wiki/.git'");
    expect(w).not.toContain("-d '/data/clones/wiki'");
    expect(w).toContain('not a git work tree, skipping');
  });

  test('sources the shell profile (secret-free) and never bakes a token', () => {
    expect(w).toContain('source ~/.zshenv');
    expect(w.includes(TOKEN)).toBe(false);
  });

  test('prefers Bun plus cli.ts over a package-local shim that launchd cannot run', () => {
    const home = mkdtempSync(join(tmpdir(), 'gbrain-cron-source-cli-'));
    const repo = join(home, 'brain');
    const cliDir = join(home, 'node_modules', 'gbrain', 'src');
    const cli = join(cliDir, 'cli.ts');
    const binDir = join(home, 'node_modules', '.bin');
    const shim = join(binDir, 'gbrain');
    const output = join(home, 'args.json');
    const wrapper = join(home, 'pull.sh');
    const launchdPath = join(home, 'launchd-path');
    const durabilityModule = join(import.meta.dir, '..', 'src', 'core', 'brain-repo-durability.ts');
    mkdirSync(join(repo, '.git'), { recursive: true });
    mkdirSync(cliDir, { recursive: true });
    mkdirSync(binDir, { recursive: true });
    mkdirSync(launchdPath);
    writeFileSync(cli, `#!/usr/bin/env bun
import { writeFileSync } from 'node:fs';
import { renderCronWrapper, resolveGbrainCliInvocation } from ${JSON.stringify(durabilityModule)};
if (process.argv[2] === 'sources') {
  writeFileSync(${JSON.stringify(output)}, JSON.stringify(process.argv.slice(2)));
} else {
  process.stdout.write(renderCronWrapper(
    'wiki', ${JSON.stringify(repo)}, 'main', resolveGbrainCliInvocation(), ${JSON.stringify(join(home, 'pull.log'))},
  ));
}
`);
    chmodSync(cli, 0o755);
    symlinkSync('../gbrain/src/cli.ts', shim);

    try {
      const body = execFileSync(shim, [], {
        encoding: 'utf-8', env: { HOME: home, PATH: `${binDir}:${dirname(process.execPath)}:/usr/bin:/bin` },
      });
      expect(body).toContain(`exec '${process.execPath}' '${realpathSync(cli)}' sources pull`);
      writeFileSync(wrapper, body);
      chmodSync(wrapper, 0o755);
      execFileSync(wrapper, [], { env: { HOME: home, PATH: launchdPath } });
      expect(JSON.parse(readFileSync(output, 'utf-8'))).toEqual([
        'sources', 'pull', '--path', repo, '--branch', 'main',
      ]);
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });

  test('refuses to install a bare gbrain command when no absolute invocation resolves', () => {
    const home = mkdtempSync(join(tmpdir(), 'gbrain-cron-unresolved-cli-'));
    const probe = join(home, 'probe.ts');
    const emptyPath = join(home, 'empty-path');
    const durabilityModule = join(import.meta.dir, '..', 'src', 'core', 'brain-repo-durability.ts');
    mkdirSync(emptyPath);
    writeFileSync(probe, `
import { resolveGbrainCliInvocation } from ${JSON.stringify(durabilityModule)};
try {
  process.stdout.write(JSON.stringify(resolveGbrainCliInvocation()));
} catch (error) {
  process.stderr.write((error as Error).message);
  process.exitCode = 23;
}
`);

    try {
      const result = Bun.spawnSync({
        cmd: [process.execPath, probe], env: { HOME: home, PATH: emptyPath },
      });
      expect(result.exitCode).toBe(23);
      expect(result.stderr.toString()).toContain('Could not resolve an absolute gbrain CLI invocation');
      expect(result.stdout.toString()).not.toContain('gbrain');
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });
});

describe('generateBrainPullPlist (D12 launchd)', () => {
  const plist = generateBrainPullPlist('com.gbrain.brain-pull.wiki', '/home/u/.gbrain/brain-pull-wiki.sh', '/home/u', 1800);

  test('is periodic (StartInterval), not a KeepAlive daemon', () => {
    expect(plist).toContain('<key>StartInterval</key><integer>1800</integer>');
    expect(plist).not.toContain('<key>KeepAlive</key>');
  });

  test('carries the per-source label and the wrapper path only (no secret)', () => {
    expect(plist).toContain('<string>com.gbrain.brain-pull.wiki</string>');
    expect(plist).toContain('/home/u/.gbrain/brain-pull-wiki.sh');
    expect(plist.includes(TOKEN)).toBe(false);
  });
});


describe('installDurabilityCron — crontab probe [B2/D-cloud]', () => {
  test('crontab absent on a non-darwin host → skipped (expected in containers), never needs_attention', async () => {
    const empty = mkdtempSync(join(tmpdir(), 'no-bin-'));
    const home = mkdtempSync(join(tmpdir(), 'gb-cron-'));
    await withEnv({ PATH: empty, GBRAIN_HOME: home }, async () => {
      const r = installDurabilityCron('wiki', '/data/clones/wiki', 'main', 1800, false, 'linux');
      expect(r.status).toBe('skipped');
      expect(r.detail).toContain('no crontab on this host');
      expect(r.detail).toContain('post-commit auto-push');
    });
  });

  test('crontab present but failing → needs_attention (a real breakage stays loud)', async () => {
    const shim = mkdtempSync(join(tmpdir(), 'shim-cron-'));
    // -l lists empty; writing the new tab (crontab -) fails.
    writeFileSync(join(shim, 'crontab'), '#!/bin/sh\ncase "$1" in -l) exit 0;; esac\nexit 1\n', { mode: 0o755 });
    const home = mkdtempSync(join(tmpdir(), 'gb-cron2-'));
    await withEnv({ PATH: `${shim}:${process.env.PATH ?? ''}`, GBRAIN_HOME: home }, async () => {
      const r = installDurabilityCron('wiki', '/data/clones/wiki', 'main', 1800, false, 'linux');
      expect(r.status).toBe('needs_attention');
      expect(r.detail).toContain('crontab install failed');
    });
  });

  test('dry-run on a crontab-less host still reports the honest skip', async () => {
    const empty = mkdtempSync(join(tmpdir(), 'no-bin2-'));
    await withEnv({ PATH: empty }, async () => {
      const r = installDurabilityCron('wiki', '/data/clones/wiki', 'main', 1800, true, 'linux');
      expect(r.status).toBe('skipped');
    });
  });
});

describe('durabilityJobStatus — presence + liveness [D7]', () => {
  test('no scheduler binaries at all → kind none (never throws)', async () => {
    const empty = mkdtempSync(join(tmpdir(), 'no-bin3-'));
    const home = mkdtempSync(join(tmpdir(), 'jb-home-'));
    await withEnv({ PATH: empty, HOME: home }, async () => {
      const s = durabilityJobStatus('wiki', 1800, 'linux');
      expect(s.kind).toBe('none');
      expect(s.wrapperPresent).toBe(false);
    });
  });

  test('crontab line present (shim) → kind crontab, live', async () => {
    const shim = mkdtempSync(join(tmpdir(), 'shim-jb-'));
    writeFileSync(
      join(shim, 'crontab'),
      '#!/bin/sh\ncase "$1" in -l) echo "*/30 * * * * /x.sh # com.gbrain.brain-pull.wiki"; exit 0;; esac\nexit 1\n',
      { mode: 0o755 },
    );
    const home = mkdtempSync(join(tmpdir(), 'jb-home2-'));
    await withEnv({ PATH: shim, HOME: home }, async () => {
      const s = durabilityJobStatus('wiki', 1800, 'linux');
      expect(s.kind).toBe('crontab');
      expect(s.live).toBe(true);
    });
  });

  test('stale pull log is reported (logFresh false)', async () => {
    const empty = mkdtempSync(join(tmpdir(), 'no-bin4-'));
    const home = mkdtempSync(join(tmpdir(), 'jb-home3-'));
    const logDir = join(home, '.gbrain');
    // A log last touched 3 hours ago against a 30-min interval.
    mkdirSync(logDir, { recursive: true });
    const log = join(logDir, 'brain-pull.log');
    writeFileSync(log, 'old\n');
    const old = new Date(Date.now() - 3 * 60 * 60 * 1000);
    utimesSync(log, old, old);
    await withEnv({ PATH: empty, HOME: home }, async () => {
      const s = durabilityJobStatus('wiki', 1800, 'linux');
      expect(s.logFresh).toBe(false);
    });
  });
});

describe('durabilityJobStatus — darwin launchd liveness [D7]', () => {
  async function darwinFixture(launchctlExit: number): Promise<ReturnType<typeof durabilityJobStatus>> {
    const home = mkdtempSync(join(tmpdir(), 'jb-mac-'));
    const plistDir = join(home, 'Library', 'LaunchAgents');
    mkdirSync(plistDir, { recursive: true });
    writeFileSync(join(plistDir, 'com.gbrain.brain-pull.wiki.plist'), '<plist/>');
    const shim = mkdtempSync(join(tmpdir(), 'shim-lc-'));
    writeFileSync(join(shim, 'launchctl'), `#!/bin/sh\nexit ${launchctlExit}\n`, { mode: 0o755 });
    return withEnv({ PATH: shim, HOME: home }, async () => durabilityJobStatus('wiki', 1800, 'darwin'));
  }

  test('plist present + launchctl reports loaded → live', async () => {
    const s = await darwinFixture(0);
    expect(s.kind).toBe('launchd');
    expect(s.live).toBe(true);
  });

  test('plist present but NOT loaded (the dead-job shape [D7]) → live=false', async () => {
    const s = await darwinFixture(1);
    expect(s.kind).toBe('launchd');
    expect(s.live).toBe(false);
  });
});
