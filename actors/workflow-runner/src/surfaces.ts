/**
 * Surfaces as an eval axis: how the agent reaches Apify.
 *
 * A surface is a file `surfaces/<name>.yaml` (schema in the contract). A run
 * names one or more surfaces (`surfaces` input); each (model, surface, skill
 * set) becomes its own experiment, so the compare view shows MCP, CLI and API
 * side by side on the same scenarios. The scenario stays the same; the surface
 * only changes the session: which MCP tools, Bash, WebFetch, extra
 * environment and an optional prompt suffix.
 *
 * Other surfaces are not blocked: an API session may still use another. The
 * evidence records which surfaces the agent used (contract `surfacesUsed`).
 */
import { existsSync, readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';

import { type DatasetItemMetadata, type SurfaceSpec, validateSurface } from '@apify-evals/contract';
import YAML from 'yaml';

import { fillPlaceholders } from './mcp.js';

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

/** Fill the environment placeholders from the runner environment. */
export function resolveSurface(spec: SurfaceSpec, opts: { env: Record<string, string | undefined> }): ResolvedSurface {
    const secrets = new Set<string>();
    const where = `surface "${spec.name}"`;
    const env = Object.fromEntries(
        Object.entries(spec.env ?? {}).map(([k, v]) => [k, fillPlaceholders(v, opts.env, where, secrets)]),
    );
    return { name: spec.name, kind: spec.kind, spec, env, secrets: [...secrets] };
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
