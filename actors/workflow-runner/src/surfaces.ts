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
import { existsSync, mkdirSync, readFileSync } from 'node:fs';
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
    opts: { env: Record<string, string | undefined>; cliVersion?: string },
): ResolvedSurface {
    const secrets = new Set<string>();
    const where = `surface "${spec.name}"`;
    const env = Object.fromEntries(
        Object.entries(spec.env ?? {}).map(([k, v]) => [k, fillPlaceholders(v, opts.env, where, secrets)]),
    );
    const cli = spec.cli
        ? { package: spec.cli.package ?? 'apify-cli', version: opts.cliVersion?.trim() || spec.cli.version }
        : null;
    return { name: spec.name, kind: spec.kind, spec, env, secrets: [...secrets], cli };
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
    const { package: pkg, version } = surface.cli;
    const dirName = `${pkg}@${version}`.replace(/[^A-Za-z0-9@._-]/g, '_');
    const preinstalled = opts.preinstalledRoot ? join(opts.preinstalledRoot, dirName) : null;
    let prefix: string;
    if (preinstalled && existsSync(join(preinstalled, 'node_modules', '.bin', 'apify'))) {
        prefix = preinstalled;
    } else {
        prefix = join(opts.cacheRoot ?? join(tmpdir(), 'apify-evals-cli'), dirName);
        if (!existsSync(join(prefix, 'node_modules', '.bin', 'apify'))) {
            mkdirSync(prefix, { recursive: true });
            await execFile(
                'npm',
                ['install', '--prefix', prefix, '--no-save', '--audit=false', '--fund=false', `${pkg}@${version}`],
                { timeout: 300_000 },
            );
        }
    }
    const binDir = join(prefix, 'node_modules', '.bin');
    const { stdout } = await execFile(join(binDir, 'apify'), ['--version'], { timeout: 30_000 });
    surface.cliBinDir = binDir;
    surface.cliVersion = parseCliVersion(stdout) ?? version;
}

/** `apify-cli/1.10.0 (1832d57) running on ...` -> `1.10.0`. */
export function parseCliVersion(output: string): string | null {
    return output.match(/apify-cli\/(\S+)/)?.[1] ?? null;
}

/** PATH for a session: the surface's CLI first, then the runner's own PATH. */
export function sessionPath(basePath: string | undefined, surface: ResolvedSurface | undefined): string | undefined {
    if (!surface?.cliBinDir) return basePath;
    return basePath ? `${surface.cliBinDir}:${basePath}` : surface.cliBinDir;
}
