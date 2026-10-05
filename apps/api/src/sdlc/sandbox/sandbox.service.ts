import { Inject, Injectable, Logger } from '@nestjs/common';
import { spawn } from 'node:child_process';
import { mkdir, mkdtemp, readFile, rm, writeFile, readdir, stat } from 'node:fs/promises';
import { dirname, join, relative, resolve, sep } from 'node:path';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import * as tar from 'tar';
import { ToolError } from '@forgeline/shared';
import type { GitHubClient } from '@forgeline/integrations';
import { APP_CONFIG, type AppConfig } from '../../config/configuration';

export interface CommandResult {
  command: string;
  exitCode: number | null;
  durationMs: number;
  output: string;
  timedOut: boolean;
}

export interface Workspace {
  id: string;
  root: string;
  ref: string;
  dispose(): Promise<void>;
}

const MAX_OUTPUT = 120_000;

/**
 * Isolated execution of repository commands (install, lint, typecheck, tests).
 *
 *  - docker (production): `docker run --rm` with CPU/memory limits, no
 *    capabilities, read-only root filesystem and configurable network.
 *  - local (development only): runs in a temp directory on the host.
 *  - disabled: validation steps report "not run" — never "passed".
 *
 * Repository code is materialised from a GitHub tarball so credentials are
 * never written to disk or exposed to the sandboxed process.
 */
@Injectable()
export class SandboxService {
  private readonly logger = new Logger(SandboxService.name);

  constructor(@Inject(APP_CONFIG) private readonly config: AppConfig) {}

  get enabled(): boolean {
    return this.config.sandbox.driver !== 'disabled';
  }

  get driver(): string {
    return this.config.sandbox.driver;
  }

  async createWorkspace(gh: GitHubClient, owner: string, repo: string, ref: string, signal?: AbortSignal): Promise<Workspace> {
    await mkdir(this.config.sandbox.workdir, { recursive: true });
    const root = await mkdtemp(join(this.config.sandbox.workdir, 'ws-'));
    try {
      const tarball = await gh.downloadTarball(owner, repo, ref, signal);
      await pipeline(Readable.from(Buffer.from(tarball)), tar.x({ cwd: root, strip: 1, filter: (p) => !p.includes('..') }));
    } catch (err) {
      await rm(root, { recursive: true, force: true });
      throw err;
    }
    return { id: root.split(sep).pop()!, root, ref, dispose: () => rm(root, { recursive: true, force: true }) };
  }

  /** Apply full-content file changes inside the workspace (path-traversal safe). */
  async applyChanges(ws: Workspace, files: { path: string; content: string | null }[]): Promise<void> {
    for (const f of files) {
      const target = resolve(ws.root, f.path);
      if (!target.startsWith(resolve(ws.root) + sep)) throw new ToolError('validation', `Refusing to write outside the workspace: ${f.path}`, { retryable: false });
      if (f.content === null) {
        await rm(target, { force: true });
      } else {
        await mkdir(dirname(target), { recursive: true });
        await writeFile(target, f.content, 'utf8');
      }
    }
  }

  async readFile(ws: Workspace, path: string): Promise<string | null> {
    const target = resolve(ws.root, path);
    if (!target.startsWith(resolve(ws.root) + sep)) return null;
    try {
      return await readFile(target, 'utf8');
    } catch {
      return null;
    }
  }

  async listFiles(ws: Workspace, limit = 5000): Promise<string[]> {
    const out: string[] = [];
    const walk = async (dir: string) => {
      if (out.length >= limit) return;
      for (const entry of await readdir(dir)) {
        if (['node_modules', '.git', 'dist', 'build', 'coverage'].includes(entry)) continue;
        const full = join(dir, entry);
        const s = await stat(full);
        if (s.isDirectory()) await walk(full);
        else out.push(relative(ws.root, full));
        if (out.length >= limit) return;
      }
    };
    await walk(ws.root);
    return out;
  }

  async run(ws: Workspace, command: string, options: { image?: string; timeoutMs?: number; signal?: AbortSignal; env?: Record<string, string> } = {}): Promise<CommandResult> {
    if (!this.enabled) throw new ToolError('not_configured', 'Sandbox execution is disabled (SANDBOX_DRIVER=disabled)', { retryable: false });
    const timeoutMs = options.timeoutMs ?? this.config.sandbox.timeoutMs;
    const started = Date.now();
    const env = { CI: 'true', FORCE_COLOR: '0', HOME: '/tmp', npm_config_cache: '/tmp/.npm', NODE_OPTIONS: '--max-old-space-size=3072', ...options.env };
    let child;
    if (this.config.sandbox.driver === 'docker') {
      const args = [
        'run', '--rm', '--init',
        '--name', `forgeline-${ws.id}-${Date.now().toString(36)}`,
        '--network', this.config.sandbox.network,
        '--memory', `${this.config.sandbox.memoryMb}m`,
        '--cpus', String(this.config.sandbox.cpus),
        '--pids-limit', '512',
        '--read-only',
        '--cap-drop', 'ALL',
        '--security-opt', 'no-new-privileges',
        '--tmpfs', '/tmp:rw,size=1g',
        '-v', `${ws.root}:/workspace`,
        '-w', '/workspace',
        ...Object.entries(env).flatMap(([k, v]) => ['-e', `${k}=${v}`]),
        options.image ?? this.config.sandbox.defaultImage,
        'sh', '-lc', command,
      ];
      child = spawn('docker', args, { stdio: ['ignore', 'pipe', 'pipe'] });
    } else {
      // Development driver: minimal environment, no inherited secrets.
      child = spawn('sh', ['-lc', command], { cwd: ws.root, env: { PATH: process.env.PATH ?? '/usr/bin:/bin', ...env, HOME: ws.root, npm_config_cache: join(ws.root, '.npm-cache') }, stdio: ['ignore', 'pipe', 'pipe'] });
    }
    let output = '';
    const append = (chunk: Buffer) => {
      output += chunk.toString('utf8');
      if (output.length > MAX_OUTPUT * 2) output = output.slice(-MAX_OUTPUT);
    };
    child.stdout?.on('data', append);
    child.stderr?.on('data', append);
    let timedOut = false;
    const kill = () => {
      timedOut = true;
      child.kill('SIGKILL');
    };
    const timer = setTimeout(kill, timeoutMs);
    const onAbort = () => child.kill('SIGKILL');
    options.signal?.addEventListener('abort', onAbort, { once: true });
    const exitCode = await new Promise<number | null>((resolveExit) => {
      child.on('close', (code) => resolveExit(code));
      child.on('error', (err) => {
        append(Buffer.from(`\n[sandbox] ${err.message}\n`));
        resolveExit(127);
      });
    });
    clearTimeout(timer);
    options.signal?.removeEventListener('abort', onAbort);
    if (options.signal?.aborted) throw new ToolError('cancelled', 'Sandbox command cancelled', { retryable: false });
    return {
      command,
      exitCode,
      durationMs: Date.now() - started,
      output: output.length > MAX_OUTPUT ? `…[truncated]\n${output.slice(-MAX_OUTPUT)}` : output,
      timedOut,
    };
  }
}
