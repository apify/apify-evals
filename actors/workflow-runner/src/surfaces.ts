/**
 * Surfaces as an eval axis: how the agent reaches Apify.
 *
 * A surface is a file `surfaces/<name>.yaml` (schema in the contract). A run
 * names one or more surfaces (`surfaces` input); each (model, surface, skill
 * set) becomes its own experiment, so the compare view shows MCP, CLI and API
 * side by side on the same scenarios. The scenario stays the same; the surface
 * only changes the session: which MCP tools, Bash, WebFetch, a pinned Apify
 * CLI on PATH, extra environment and an optional prompt suffix.
 *
 * Other surfaces are not blocked: a CLI session may still curl the API. The
 * evidence records which surfaces the agent used (contract `surfacesUsed`).
 */
import { execFile as execFileCb } from 'node:child_process';
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { promisify } from 'node:util';

import { type DatasetItemMetadata, type SurfaceSpec, validateSurface } from '@apify-evals/contract';
import YAML from 'yaml';

import { fillPlaceholders } from './mcp.js';

const execFile = promisify(execFileCb);

export const DEFAULT_SURFACE = 'mcp';
const NAME_RE = /^[a-z][a-z0-9-]*$/;

export interface ResolvedSurface {
    name: string;
    kind: SurfaceSpec['kind'];
    spec: SurfaceSpec;
    /** Surface environment with placeholders filled. */
    env: Record<string, string>;
    /** Filled values, for log redaction. */
    secrets: string[];
    /** The CLI to put on PATH (after an optional run-level version override). */
    cli: { package: string; version: string } | null;
    /** Set by installCli: the directory that holds the `apify` binary, and its reported version. */
    cliBinDir?: string;
    cliVersion?: string;
    /** Set by loginCli: a HOME whose CLI login every session copies. */
    cliLoginHome?: string;
    /** mcpc to put on PATH and connect to the Apify MCP server (after an optional version override). */
    mcpc: { package: string; version: string } | null;
    /** Set by installMcpc. */
    mcpcBinDir?: string;
    mcpcVersion?: string;
}

/** Where the repo's `surfaces/` directory is: the image sets SURFACES_DIR; a
 * local run finds it two levels above the Actor directory. */
export function surfacesRoot(env: Record<string, string | undefined> = process.env, cwd = process.cwd()): string {
    if (env.SURFACES_DIR) return resolve(env.SURFACES_DIR);
    for (const candidate of [join(cwd, 'surfaces'), join(cwd, '..', '..', 'surfaces')]) {
        if (existsSync(candidate)) return resolve(candidate);
    }
    return join(cwd, 'surfaces');
}

export function loadSurface(root: string, name: string): SurfaceSpec {
    if (!NAME_RE.test(name)) throw new Error(`Invalid surface name "${name}"`);
    const path = join(root, `${name}.yaml`);
    if (!existsSync(path)) throw new Error(`Unknown surface "${name}": no ${path}`);
    const doc = YAML.parse(readFileSync(path, 'utf8')) as unknown;
    if (!validateSurface(doc)) {
        throw new Error(`surfaces/${name}.yaml: ${JSON.stringify(validateSurface.errors)}`);
    }
    if (doc.name !== name) throw new Error(`surfaces/${name}.yaml: name "${doc.name}" must equal the file name`);
    return doc;
}

/** The surfaces a run covers: the input list (deduplicated) or the default. */
export function resolveSurfaceNames(input: string[] | undefined): string[] {
    const names = [...new Set((input ?? []).map((n) => n.trim()).filter(Boolean))];
    return names.length > 0 ? names : [DEFAULT_SURFACE];
}

/** Fill the environment and apply the run-level CLI version override. */
export function resolveSurface(
    spec: SurfaceSpec,
    opts: { env: Record<string, string | undefined>; cliVersion?: string; mcpcVersion?: string },
): ResolvedSurface {
    const secrets = new Set<string>();
    const where = `surface "${spec.name}"`;
    const env = Object.fromEntries(
        Object.entries(spec.env ?? {}).map(([k, v]) => [k, fillPlaceholders(v, opts.env, where, secrets)]),
    );
    const cli = spec.cli
        ? { package: spec.cli.package ?? 'apify-cli', version: opts.cliVersion?.trim() || spec.cli.version }
        : null;
    const mcpc = spec.mcpc
        ? { package: spec.mcpc.package ?? '@apify/mcpc', version: opts.mcpcVersion?.trim() || spec.mcpc.version }
        : null;
    return { name: spec.name, kind: spec.kind, spec, env, secrets: [...secrets], cli, mcpc };
}

/**
 * The item as this surface runs it. Without MCP the item's tool list is
 * dropped (no MCP server at all); Bash also turns on the workspace snapshot.
 */
export function surfaceItemMetadata(
    meta: DatasetItemMetadata,
    surface: ResolvedSurface | undefined,
): DatasetItemMetadata {
    if (!surface) return meta;
    return {
        ...meta,
        ...(surface.spec.mcp ? {} : { tools: [] }),
        ...(surface.spec.bash ? { allowBash: true } : {}),
    };
}

export function surfacePrompt(prompt: string, surface: ResolvedSurface | undefined): string {
    const suffix = surface?.spec.promptSuffix?.trim();
    return suffix ? `${prompt}\n\n${suffix}` : prompt;
}

/** Built-in tools the surface adds to `--allowedTools` (Bash comes from the item metadata). */
export function surfaceAllowedTools(surface: ResolvedSurface | undefined): string[] {
    return surface?.spec.webFetch ? ['WebFetch'] : [];
}

/**
 * The session marker in every curl request's user agent. Apify stores the
 * user agent on API-started runs (`meta.userAgent` on GET /actor-runs/<id>),
 * so the evidence can find runs the agent started without printing their id.
 */
export function curlrc(marker: string): string {
    return `user-agent = "${marker} curl"\n`;
}

/**
 * Put the surface's CLI version where sessions can run it, once per run. The
 * image pre-installs the default version under CLI_ROOT/<version>; any other
 * version (a beta, a release candidate) is installed into a cache directory.
 */
export async function installCli(
    surface: ResolvedSurface,
    opts: { preinstalledRoot?: string; cacheRoot?: string } = {},
): Promise<void> {
    if (!surface.cli) return;
    const binDir = await installPackage(surface.cli, 'apify', [], opts);
    const { stdout } = await execFile(join(binDir, 'apify'), ['--version'], {
        timeout: 30_000,
        env: isolatedCliEnv({}),
    });
    surface.cliBinDir = binDir;
    surface.cliVersion = parseCliVersion(stdout) ?? surface.cli.version;
}

/**
 * Put the surface's mcpc version where sessions can run it, like installCli.
 * Installed without optional dependencies: that leaves out the native keychain
 * module, so mcpc keeps its credentials in a file under MCPC_HOME_DIR on every
 * platform and never touches the developer's Keychain.
 */
export async function installMcpc(
    surface: ResolvedSurface,
    opts: { preinstalledRoot?: string; cacheRoot?: string } = {},
): Promise<void> {
    if (!surface.mcpc) return;
    const binDir = await installPackage(surface.mcpc, 'mcpc', ['--omit=optional'], opts);
    const { stdout } = await execFile(join(binDir, 'mcpc'), ['--version'], { timeout: 30_000 });
    surface.mcpcBinDir = binDir;
    surface.mcpcVersion = stdout.trim().split('\n').pop()?.trim() || surface.mcpc.version;
}

/** The directory holding `bin` of `pkg@version`: the image's copy, a cached one, or a fresh npm install. */
async function installPackage(
    spec: { package: string; version: string },
    bin: string,
    npmArgs: string[],
    opts: { preinstalledRoot?: string; cacheRoot?: string },
): Promise<string> {
    const dirName = `${spec.package}@${spec.version}`.replace(/[^A-Za-z0-9@._-]/g, '_');
    const has = (prefix: string) => existsSync(join(prefix, 'node_modules', '.bin', bin));
    const preinstalled = opts.preinstalledRoot ? join(opts.preinstalledRoot, dirName) : null;
    let prefix: string;
    if (preinstalled && has(preinstalled)) {
        prefix = preinstalled;
    } else {
        prefix = join(opts.cacheRoot ?? join(tmpdir(), 'apify-evals-cli'), dirName);
        if (!has(prefix)) {
            mkdirSync(prefix, { recursive: true });
            await execFile(
                'npm',
                [
                    'install',
                    '--prefix',
                    prefix,
                    '--no-save',
                    '--audit=false',
                    '--fund=false',
                    ...npmArgs,
                    `${spec.package}@${spec.version}`,
                ],
                { timeout: 300_000 },
            );
        }
    }
    return join(prefix, 'node_modules', '.bin');
}

/** CLI settings for every call the eval makes: file credentials (never the
 * Keychain), no update check, no telemetry. */
const CLI_ENV = { APIFY_DISABLE_KEYRING: '1', APIFY_CLI_SKIP_UPDATE_CHECK: '1', APIFY_CLI_DISABLE_TELEMETRY: '1' };

/**
 * Environment for the runner's own CLI calls (version, login, preflight): a
 * HOME of its own, so no developer login or Keychain entry is ever read.
 */
export function isolatedCliEnv(
    extra: Record<string, string>,
    home = join(tmpdir(), 'apify-evals-cli-home'),
): Record<string, string | undefined> {
    mkdirSync(home, { recursive: true });
    return { PATH: process.env.PATH, HOME: home, ...CLI_ENV, ...extra };
}

/**
 * Log the surface's CLI in once per run. The CLI ignores APIFY_TOKEN in the
 * environment (1.10.0 reads only its own login), so a session needs a login:
 * `apify login --token` into a throwaway HOME with file credentials, which
 * every session then copies (installCliShim). Remove it with logoutCli.
 */
export async function loginCli(surface: ResolvedSurface): Promise<void> {
    if (!surface.cliBinDir) return;
    const token = surface.env.APIFY_TOKEN;
    if (!token) throw new Error(`surface "${surface.name}": the CLI needs APIFY_TOKEN in the surface env to log in`);
    const home = mkdtempSync(join(tmpdir(), 'apify-evals-cli-login-'));
    await execFile(join(surface.cliBinDir, 'apify'), ['login', '--token', token], {
        timeout: 60_000,
        env: isolatedCliEnv({}, home),
    });
    surface.cliLoginHome = home;
}

/** Delete the run's CLI login (it holds the token in a file). */
export function logoutCli(surface: ResolvedSurface): void {
    if (surface.cliLoginHome) rmSync(surface.cliLoginHome, { recursive: true, force: true });
    surface.cliLoginHome = undefined;
}

/** `apify-cli/1.10.0 (1832d57) running on ...` -> `1.10.0`. */
export function parseCliVersion(output: string): string | null {
    return output.match(/apify-cli\/(\S+)/)?.[1] ?? null;
}

/**
 * The session's own `apify` and `mcpc` commands, first on PATH. The CLI keeps its login in
 * `$HOME/.apify` (on macOS backed by the Keychain), so it runs with an empty
 * HOME of its own: the session's APIFY_TOKEN is the only credential it sees,
 * and a local run never reaches the developer's login. On a surface without
 * the CLI the command is missing, as in the image, even when the developer's
 * PATH has one.
 */
export function cliShim(
    sessionHome: string,
    surface: ResolvedSurface,
    marker?: string,
): { binDir: string; script: string; mcpcScript: string } {
    const binDir = join(sessionHome, 'bin');
    const lines = ['#!/bin/sh', 'export APIFY_DISABLE_KEYRING=1'];
    if (marker) {
        // The CLI's API requests carry the session marker (see MARKER_PRELOAD).
        lines.push(
            `export APIFY_EVALS_MARKER=${shellQuote(marker)}`,
            `export NODE_OPTIONS="--import=${join(binDir, MARKER_PRELOAD_FILE)} $NODE_OPTIONS"`,
        );
    }
    lines.push(
        `HOME=${shellQuote(join(sessionHome, 'cli-home'))} exec ${shellQuote(join(surface.cliBinDir ?? '', 'apify'))} "$@"`,
    );
    const missing = (name: string) => `#!/bin/sh\necho "${name}: command not found" >&2\nexit 127\n`;
    const script = surface.cliBinDir ? `${lines.join('\n')}\n` : missing('apify');
    // mcpc keeps its sessions, bridges and credentials under MCPC_HOME_DIR.
    const mcpcScript = surface.mcpcBinDir
        ? `#!/bin/sh\nexport MCPC_HOME_DIR=${shellQuote(mcpcHome(sessionHome))}\nexec ${shellQuote(join(surface.mcpcBinDir, 'mcpc'))} "$@"\n`
        : missing('mcpc');
    return { binDir, script, mcpcScript };
}

const mcpcHome = (sessionHome: string) => join(sessionHome, 'mcpc');

/** The mcpc session the agent finds already connected to the Apify MCP server. */
export const MCPC_SESSION = '@apify';

/**
 * Connect the session's mcpc to the Apify MCP server before the agent starts,
 * as `@apify`, with the surface's token as a bearer header (kept in the
 * session's file store, see installMcpc).
 */
export async function connectMcpc(sessionHome: string, surface: ResolvedSurface, mcpUrl: string): Promise<void> {
    if (!surface.mcpcBinDir) return;
    const token = surface.env.APIFY_TOKEN;
    if (!token) throw new Error(`surface "${surface.name}": mcpc needs APIFY_TOKEN in the surface env`);
    await execFile(
        join(sessionHome, 'bin', 'mcpc'),
        ['connect', mcpUrl, MCPC_SESSION, '--header', `Authorization: Bearer ${token}`],
        { timeout: 60_000, env: { PATH: process.env.PATH, HOME: sessionHome } },
    );
}

/**
 * Close every mcpc session of this agent session (the pre-connected one and any
 * the agent opened): each holds a background bridge process that would outlive
 * the session.
 */
export async function closeMcpc(sessionHome: string): Promise<void> {
    const mcpc = join(sessionHome, 'bin', 'mcpc');
    if (!existsSync(join(mcpcHome(sessionHome), 'sessions.json'))) return;
    const env = { PATH: process.env.PATH, HOME: sessionHome };
    try {
        const { stdout } = await execFile(mcpc, ['--json'], { timeout: 30_000, env });
        const sessions = ((JSON.parse(stdout) as { sessions?: { name?: string }[] }).sessions ?? [])
            .map((x) => x.name)
            .filter((name): name is string => typeof name === 'string');
        for (const name of sessions) {
            await execFile(mcpc, ['close', name], { timeout: 30_000, env }).catch(() => undefined);
        }
    } catch {
        /* best effort: the session directory is removed next */
    }
}

const MARKER_PRELOAD_FILE = 'apify-evals-marker.mjs';

/**
 * Node preload for the session's CLI: appends the session marker to the
 * User-Agent of every request to api.apify.com. Apify stores it on the run
 * (`meta.userAgent`), so the evidence finds CLI runs whose output names no
 * run (`apify call -s` prints only the items). The CLI's own user agent
 * setting (APIFY_CLI_USER_AGENT) feeds telemetry only, not the API.
 */
export const MARKER_PRELOAD = `import https from 'node:https';
const marker = process.env.APIFY_EVALS_MARKER;
if (marker) {
    const original = https.request;
    https.request = function (...args) {
        const req = original.apply(this, args);
        try {
            if (/(^|\\.)api\\.apify\\.com$/.test(req.host ?? '')) {
                const ua = req.getHeader('user-agent');
                req.setHeader('user-agent', ua ? \`\${ua} \${marker}\` : marker);
            }
        } catch {}
        return req;
    };
}
`;

/** Write the shim into the session directory; returns the directory to put first on PATH. */
export function installCliShim(sessionHome: string, surface: ResolvedSurface, marker?: string): string {
    const { binDir, script, mcpcScript } = cliShim(sessionHome, surface, marker);
    const cliHome = join(sessionHome, 'cli-home');
    if (surface.cliLoginHome) cpSync(surface.cliLoginHome, cliHome, { recursive: true });
    else mkdirSync(cliHome, { recursive: true });
    mkdirSync(binDir, { recursive: true });
    writeFileSync(join(binDir, 'apify'), script, { mode: 0o755 });
    writeFileSync(join(binDir, 'mcpc'), mcpcScript, { mode: 0o755 });
    if (marker && surface.cliBinDir) writeFileSync(join(binDir, MARKER_PRELOAD_FILE), MARKER_PRELOAD);
    return binDir;
}

/** PATH for a session: the shim directory first, then the runner's own PATH. */
export function sessionPath(basePath: string | undefined, shimDir: string | undefined): string | undefined {
    if (!shimDir) return basePath;
    return basePath ? `${shimDir}:${basePath}` : shimDir;
}

function shellQuote(value: string): string {
    return `'${value.replace(/'/g, `'\\''`)}'`;
}
