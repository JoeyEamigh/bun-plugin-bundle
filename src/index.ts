import type { BunPlugin } from 'bun';
import { mkdir, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

export type AssetInput =
  | string
  | {
      /**
       * Import specifier or path passed to {@link import.meta.resolve}
       */
      specifier: string;
      /**
       * Optional name to use for the bundled file.
       */
      targetName?: string;
      /**
       * Additional runtime identifiers that should resolve to this asset at runtime.
       * Useful for mapping relative specifiers (e.g. "./assets/file.txt") or package aliases.
       */
      runtimeKeys?: string[];
    };

export interface BundleAssetsPluginOptions {
  assets: AssetInput[];
  /**
   * Custom global key used to expose resolved asset paths at runtime.
   * @default "__bundleAssets"
   */
  globalKey?: string;
  /**
   * Helper function name assigned on `globalThis` to fetch a bundled asset path.
   * Set to `null` to disable helper installation.
   * @default "getBundleAsset"
   */
  helperName?: string | null;
  /**
   * Logging mode.
   * @default "default"
   */
  logging?: 'default' | 'quiet' | 'plain';
  /**
   * Absolute directory used to materialize embedded assets at runtime when `compile` is enabled.
   * If omitted, the plugin falls back to `path.join(os.tmpdir(), "bun-plugin-bundle")`.
   */
  extractionDir?: string;
}

type ResolvedAsset = {
  specifier: string;
  sourcePath: string;
  sourceUrl: string;
  relativePath: string;
  runtimeKeys: string[];
  base64?: string;
};

const sanitizeSegment = (value: string): string => value.replace(/[^A-Za-z0-9._-]/g, '-');

const normalizeTargetName = (value: string): string => {
  const segments = value.split(/[\\/]+/).filter(Boolean);
  if (segments.length === 0) return sanitizeSegment('asset');
  return segments.map(sanitizeSegment).join('/');
};

const toFilePath = (resolved: string): string => {
  if (resolved.startsWith('file://')) {
    return fileURLToPath(resolved);
  }
  return path.isAbsolute(resolved) ? resolved : path.resolve(process.cwd(), resolved);
};

const logFactory = (mode: BundleAssetsPluginOptions['logging']) => {
  if (mode === 'quiet') return () => {};
  const formatter =
    mode === 'plain'
      ? (msg: string) => msg
      : (msg: string, color: 'green' | 'yellow') => {
          const codes = color === 'green' ? ['\u001b[32m', '\u001b[0m'] : ['\u001b[33m', '\u001b[0m'];
          return `${codes[0]}${msg}${codes[1]}`;
        };

  return (message: string, color: 'green' | 'yellow' = 'green') => {
    if (mode === 'plain') {
      console.log(message);
    } else {
      console.log(formatter(message, color));
    }
  };
};

export function bundleAssetsPlugin(options: BundleAssetsPluginOptions): BunPlugin {
  const {
    assets,
    globalKey = '__bundleAssets',
    helperName = 'getBundleAsset',
    logging = 'default',
    extractionDir,
  } = options;
  if (!assets || assets.length === 0) {
    throw new Error('bundleAssetsPlugin requires at least one asset to bundle.');
  }

  return {
    name: 'bundle-assets',
    async setup(build) {
      const print = logFactory(logging);
      const target = build.config.target;
      if (target === 'browser') {
        throw new Error('bundleAssetsPlugin does not support browser builds.');
      }

      let extractionDirAbs: string | undefined;
      if (extractionDir !== undefined) {
        if (!path.isAbsolute(extractionDir)) {
          throw new Error('bundleAssetsPlugin option `extractionDir` must be an absolute path.');
        }
        extractionDirAbs = path.resolve(extractionDir);
      }

      const compileConfig = 'compile' in build.config ? build.config.compile : undefined;
      const compileOutfile =
        typeof compileConfig === 'object' &&
        compileConfig !== null &&
        'outfile' in compileConfig &&
        typeof compileConfig.outfile === 'string'
          ? compileConfig.outfile
          : undefined;
      const isCompile = compileConfig !== undefined && compileConfig !== false;
      const outdir = build.config.outdir;
      const bundleOutputRoot = outdir ?? (compileOutfile ? path.dirname(path.resolve(compileOutfile)) : undefined);

      if (!isCompile && !bundleOutputRoot) {
        throw new Error(
          'bundleAssetsPlugin requires `outdir` or `outfile` when not using compile mode in order to emit bundled files.',
        );
      }

      const resolvedAssets: ResolvedAsset[] = [];
      const configuredEntrypoints = Array.isArray(build.config.entrypoints) ? build.config.entrypoints : [];
      const entrypointAbsPaths = configuredEntrypoints.map(entry => path.resolve(process.cwd(), entry));
      const entrypointDirs = entrypointAbsPaths.map(entry => path.dirname(entry));
      const entrypointUrlParents = entrypointAbsPaths.map(entry => pathToFileURL(entry).href);

      for (const entry of assets) {
        const specifier = typeof entry === 'string' ? entry : entry.specifier;
        const targetName = typeof entry === 'string' ? undefined : entry.targetName;

        const attempted: string[] = [];
        const resolutionErrors: string[] = [];
        let sourcePath: string | null = null;
        let sourceUrl: string | null = null;

        const registerMatch = (absolutePath: string, url?: string) => {
          sourcePath = path.normalize(absolutePath);
          sourceUrl = url ?? pathToFileURL(sourcePath).href;
        };

        const tryPath = async (candidatePath: string) => {
          const normalized = path.normalize(candidatePath);
          if (attempted.includes(normalized)) {
            return false;
          }
          attempted.push(normalized);
          const exists = await Bun.file(normalized).exists();
          if (exists) {
            registerMatch(normalized);
            return true;
          }
          return false;
        };

        const tryUrl = async (candidateUrl: string) => {
          try {
            const filePath = toFilePath(candidateUrl);
            const matched = await tryPath(filePath);
            if (matched && sourcePath) {
              sourceUrl = candidateUrl.startsWith('file://') ? candidateUrl : pathToFileURL(sourcePath).href;
            }
            return matched;
          } catch (err) {
            resolutionErrors.push(String(err));
            return false;
          }
        };

        const attemptImportMetaResolve = async (parentUrl?: string) => {
          try {
            const resolvedUrl = parentUrl
              ? await Promise.resolve(import.meta.resolve(specifier, parentUrl))
              : await Promise.resolve(import.meta.resolve(specifier));
            return await tryUrl(resolvedUrl);
          } catch (err) {
            resolutionErrors.push(String(err));
            return false;
          }
        };

        if (specifier.startsWith('file://')) {
          await tryUrl(specifier);
        } else if (path.isAbsolute(specifier)) {
          await tryPath(specifier);
        }

        if (!sourcePath && (specifier.startsWith('./') || specifier.startsWith('../'))) {
          await tryPath(path.resolve(process.cwd(), specifier));
          if (!sourcePath) {
            for (const dir of entrypointDirs) {
              if (await tryPath(path.resolve(dir, specifier))) {
                break;
              }
            }
          }
        }

        if (!sourcePath) {
          for (const parentUrl of entrypointUrlParents) {
            if (await attemptImportMetaResolve(parentUrl)) {
              break;
            }
          }
        }

        if (!sourcePath) {
          await attemptImportMetaResolve();
        }

        if (!sourcePath && !(specifier.startsWith('file://') || path.isAbsolute(specifier))) {
          await tryPath(path.resolve(process.cwd(), specifier));
        }

        if (!sourcePath) {
          const resolutionSummary = attempted.length > 0 ? `\nChecked: ${attempted.join(', ')}` : '';
          const errorSummary = resolutionErrors.length > 0 ? `\nResolver errors: ${resolutionErrors.join('; ')}` : '';
          throw new Error(
            `bundleAssetsPlugin could not locate asset "${specifier}".${resolutionSummary}${errorSummary}`,
          );
        }

        const runtimeKeys = typeof entry === 'string' ? [] : (entry.runtimeKeys ?? []);
        const baseName = targetName ?? path.basename(sourcePath);
        const relativePath =
          targetName !== undefined ? normalizeTargetName(targetName) : sanitizeSegment(baseName || specifier);
        resolvedAssets.push({
          specifier,
          sourcePath,
          sourceUrl: sourceUrl ?? pathToFileURL(sourcePath).href,
          relativePath,
          runtimeKeys,
        });
      }

      const tempOutdir =
        !bundleOutputRoot && isCompile ? await mkdtemp(path.join(tmpdir(), 'bundle-assets-')) : undefined;
      const emissionRoot = bundleOutputRoot ?? tempOutdir ?? process.cwd();

      print('\nBundling static assets...\n', 'green');

      if (!isCompile) {
        await mkdir(emissionRoot, { recursive: true });
      }

      for (const asset of resolvedAssets) {
        const fromDisplay = path.relative(process.cwd(), asset.sourcePath);
        const outputSegments = asset.relativePath.split('/');
        if (isCompile) {
          const raw = await Bun.file(asset.sourcePath).arrayBuffer();
          asset.base64 = Buffer.from(raw).toString('base64');
          print(`  ${asset.specifier}\n      ${fromDisplay} -> [embedded]\n`, 'yellow');
        } else {
          const targetPath = path.join(emissionRoot, ...outputSegments);
          await mkdir(path.dirname(targetPath), { recursive: true });
          await Bun.write(targetPath, Bun.file(asset.sourcePath));
          print(
            `  ${asset.specifier}\n      ${fromDisplay} -> ${path.relative(process.cwd(), targetPath)}\n`,
            'yellow',
          );
        }
      }

      print('Done\n', 'green');

      const runtimeAssetsLiteral = JSON.stringify(
        resolvedAssets.map(asset => ({
          specifier: asset.specifier,
          relativePath: asset.relativePath,
          keys: Array.from(
            new Set(
              [
                ...asset.runtimeKeys,
                ...asset.runtimeKeys
                  .filter(key => key.startsWith('./'))
                  .flatMap(key => {
                    const normalized = key.replace(/^\.\//, '');
                    return [`file:///$bunfs/root/${normalized}`, `/$bunfs/root/${normalized}`];
                  }),
                asset.specifier,
                asset.sourcePath,
                asset.sourceUrl,
              ].filter(Boolean),
            ),
          ),
        })),
      );

      const compileAssetsLiteral = isCompile
        ? JSON.stringify(
            resolvedAssets.map(asset => ({
              specifier: asset.specifier,
              relativePath: asset.relativePath,
              data: asset.base64 ?? '',
              keys: Array.from(
                new Set(
                  [
                    ...asset.runtimeKeys,
                    ...asset.runtimeKeys
                      .filter(key => key.startsWith('./'))
                      .flatMap(key => {
                        const normalized = key.replace(/^\.\//, '');
                        return [`file:///$bunfs/root/${normalized}`, `/$bunfs/root/${normalized}`];
                      }),
                    asset.specifier,
                    asset.sourcePath,
                    asset.sourceUrl,
                  ].filter(Boolean),
                ),
              ),
            })),
          )
        : undefined;

      const fingerprint = isCompile ? Bun.hash(String(compileAssetsLiteral ?? '')).toString(36) : null;
      const runtimeDirExpr = build.config.target === 'node' ? 'import.meta.dirname' : 'import.meta.dir';
      const cacheRootExpr = extractionDirAbs
        ? JSON.stringify(extractionDirAbs)
        : "path.join(os.tmpdir(), 'bun-plugin-bundle')";
      const runtimeFingerprint = fingerprint ?? Bun.hash(String(Date.now())).toString(36);

      const lines: string[] = [];
      lines.push('(() => {');
      lines.push(`  const globalKey = '${globalKey}';`);
      lines.push("  const path = require('node:path');");
      lines.push("  const { pathToFileURL, fileURLToPath } = require('node:url');");
      lines.push(`  const runtimeDir = ${runtimeDirExpr};`);
      lines.push(`  const entries = ${runtimeAssetsLiteral};`);
      lines.push('  const overrides = Object.create(null);');
      lines.push('  const hasOwn = (object, key) => Object.prototype.hasOwnProperty.call(object, key);');
      lines.push('  const registerKey = (key, value) => {');
      lines.push('    if (typeof key !== "string" || key.length === 0) return;');
      lines.push('    const variants = new Set([key]);');
      lines.push('    const addVariant = candidate => {');
      lines.push('      if (typeof candidate === "string" && candidate.length > 0) {');
      lines.push('        variants.add(candidate);');
      lines.push('      }');
      lines.push('    };');
      lines.push('    if (key.startsWith("file://")) {');
      lines.push('      try { addVariant(fileURLToPath(key)); } catch (err) { /* ignore */ }');
      lines.push('    } else if (key.startsWith("/$bunfs/root/")) {');
      lines.push('      addVariant(`file://${key}`);');
      lines.push('    } else if (path.isAbsolute(key)) {');
      lines.push('      try { addVariant(pathToFileURL(key).href); } catch (err) { /* ignore */ }');
      lines.push('    } else if (key.startsWith("./") || key.startsWith("../")) {');
      lines.push('      const absoluteFromRuntime = path.resolve(runtimeDir, key);');
      lines.push('      addVariant(absoluteFromRuntime);');
      lines.push('      try { addVariant(pathToFileURL(absoluteFromRuntime).href); } catch (err) { /* ignore */ }');
      lines.push('      if (key.startsWith("./")) {');
      lines.push('        const trimmed = key.slice(2);');
      lines.push('        addVariant(`/$bunfs/root/${trimmed}`);');
      lines.push('        addVariant(`file:///$bunfs/root/${trimmed}`);');
      lines.push('      }');
      lines.push('    }');
      lines.push('    for (const variant of variants) {');
      lines.push('      if (!hasOwn(overrides, variant)) {');
      lines.push('        overrides[variant] = value;');
      lines.push('      }');
      lines.push('    }');
      lines.push('  };');
      lines.push('  const registerAll = (keys, value) => {');
      lines.push('    registerKey(value, value);');
      lines.push('    try { registerKey(pathToFileURL(value).href, value); } catch (err) { /* ignore */ }');
      lines.push('    if (Array.isArray(keys)) {');
      lines.push('      for (const key of keys) { registerKey(key, value); }');
      lines.push('    }');
      lines.push('  };');

      if (isCompile) {
        lines.push("  const fs = require('node:fs');");
        lines.push("  const os = require('node:os');");
        lines.push("  const { Buffer } = require('node:buffer');");
        lines.push(`  const encoded = ${compileAssetsLiteral ?? '[]'};`);
        lines.push(`  const cacheRoot = ${cacheRootExpr};`);
        lines.push(`  const cacheDir = path.join(cacheRoot, '${runtimeFingerprint}');`);
        lines.push('  try {');
        lines.push('    if (!fs.existsSync(cacheDir)) { fs.mkdirSync(cacheDir, { recursive: true }); }');
        lines.push('  } catch (err) { /* ignore */ }');
        lines.push('  for (const asset of encoded) {');
        lines.push('    const outputPath = path.join(cacheDir, ...asset.relativePath.split("/"));');
        lines.push('    const buffer = Buffer.from(asset.data, "base64");');
        lines.push('    if (!fs.existsSync(outputPath)) {');
        lines.push(
          '      try { fs.mkdirSync(path.dirname(outputPath), { recursive: true }); } catch (err) { /* ignore */ }',
        );
        lines.push('      try { fs.writeFileSync(outputPath, buffer); } catch (err) { /* ignore */ }');
        lines.push('    }');
        lines.push('    for (const key of asset.keys || []) {');
        lines.push('      if (typeof key !== "string") continue;');
        lines.push('      let bunfsUrl = null;');
        lines.push('      if (key.startsWith("file:///$bunfs/root/")) {');
        lines.push('        bunfsUrl = key;');
        lines.push('      } else if (key.startsWith("/$bunfs/root/")) {');
        lines.push('        bunfsUrl = `file://${key}`;');
        lines.push('      }');
        lines.push('      if (!bunfsUrl) continue;');
        lines.push('      try {');
        lines.push('        const bunfsPath = new URL(bunfsUrl).pathname;');
        lines.push('        if (!fs.existsSync(bunfsPath)) {');
        lines.push('          fs.mkdirSync(path.dirname(bunfsPath), { recursive: true });');
        lines.push('          fs.writeFileSync(bunfsPath, buffer);');
        lines.push('        }');
        lines.push('      } catch (err) { /* ignore bunfs write failures */ }');
        lines.push('    }');
        lines.push('    registerAll(asset.keys, outputPath);');
        lines.push('  }');
        lines.push('  for (const asset of entries) {');
        lines.push('    const outputPath = path.join(cacheDir, ...asset.relativePath.split("/"));');
        lines.push('    registerAll(asset.keys, outputPath);');
        lines.push('  }');
      } else {
        lines.push('  for (const asset of entries) {');
        lines.push('    const outputPath = path.resolve(runtimeDir, asset.relativePath);');
        lines.push('    registerAll(asset.keys, outputPath);');
        lines.push('  }');
      }

      lines.push('  const current = globalThis[globalKey];');
      lines.push('  const target = current && typeof current === "object" ? current : Object.create(null);');
      lines.push('  for (const key of Object.keys(overrides)) {');
      lines.push('    target[key] = overrides[key];');
      lines.push('  }');
      lines.push('  globalThis[globalKey] = target;');

      lines.push('  const findOverride = key => {');
      lines.push('    if (typeof key !== "string" || key.length === 0) return undefined;');
      lines.push('    const table = globalThis[globalKey];');
      lines.push('    if (!table) return undefined;');
      lines.push('    if (hasOwn(table, key)) return table[key];');
      lines.push('    if (key.startsWith("file://")) {');
      lines.push('      try {');
      lines.push('        const fsPath = fileURLToPath(key);');
      lines.push('        if (hasOwn(table, fsPath)) return table[fsPath];');
      lines.push('      } catch (err) { /* ignore */ }');
      lines.push('    } else if (path.isAbsolute(key)) {');
      lines.push('      try {');
      lines.push('        const asUrl = pathToFileURL(key).href;');
      lines.push('        if (hasOwn(table, asUrl)) return table[asUrl];');
      lines.push('      } catch (err) { /* ignore */ }');
      lines.push('    } else if (key.startsWith("/$bunfs/root/")) {');
      lines.push('      const asUrl = `file://${key}`;');
      lines.push('      if (hasOwn(table, asUrl)) return table[asUrl];');
      lines.push('    }');
      lines.push('    return undefined;');
      lines.push('  };');
      lines.push('  const applyOverride = (specifier, resolved) => {');
      lines.push('    const bySpecifier = findOverride(specifier);');
      lines.push('    if (typeof bySpecifier === "string") return bySpecifier;');
      lines.push('    if (typeof resolved === "string") {');
      lines.push('      const byResolved = findOverride(resolved);');
      lines.push('      if (typeof byResolved === "string") return byResolved;');
      lines.push('    }');
      lines.push('    return resolved;');
      lines.push('  };');
      lines.push('  const installResolvers = () => {');
      lines.push('    if (globalThis.__bundleAssetsResolversInstalled) {');
      lines.push('      return;');
      lines.push('    }');
      lines.push(
        '    if (globalThis.Bun && typeof Bun.resolveSync === "function" && !Bun.resolveSync.__bundleAssetsPatched) {',
      );
      lines.push('      const originalResolveSync = Bun.resolveSync.bind(Bun);');
      lines.push('      const patched = function(specifier, options) {');
      lines.push('        const direct = findOverride(specifier);');
      lines.push('        if (typeof direct === "string") {');
      lines.push('          return direct;');
      lines.push('        }');
      lines.push('        try {');
      lines.push('          const result = originalResolveSync(specifier, options);');
      lines.push('          return applyOverride(specifier, result);');
      lines.push('        } catch (err) {');
      lines.push('          const fallback = findOverride(specifier);');
      lines.push('          if (typeof fallback === "string") {');
      lines.push('            return fallback;');
      lines.push('          }');
      lines.push('          throw err;');
      lines.push('        }');
      lines.push('      };');
      lines.push('      patched.__bundleAssetsPatched = true;');
      lines.push('      Bun.resolveSync = patched;');
      lines.push('    }');
      lines.push(
        '    if (globalThis.Bun && typeof Bun.resolve === "function" && !Bun.resolve.__bundleAssetsPatched) {',
      );
      lines.push('      const originalResolve = Bun.resolve.bind(Bun);');
      lines.push('      const patchedAsync = function(specifier, options) {');
      lines.push('        const direct = findOverride(specifier);');
      lines.push('        if (typeof direct === "string") {');
      lines.push('          return Promise.resolve(direct);');
      lines.push('        }');
      lines.push('        try {');
      lines.push('          const result = originalResolve(specifier, options);');
      lines.push('          if (result && typeof result.then === "function") {');
      lines.push('            return result.then(output => applyOverride(specifier, output)).catch(err => {');
      lines.push('              const fallback = findOverride(specifier);');
      lines.push('              if (typeof fallback === "string") {');
      lines.push('                return fallback;');
      lines.push('              }');
      lines.push('              throw err;');
      lines.push('            });');
      lines.push('          }');
      lines.push('          return applyOverride(specifier, result);');
      lines.push('        } catch (err) {');
      lines.push('          const fallback = findOverride(specifier);');
      lines.push('          if (typeof fallback === "string") {');
      lines.push('            return fallback;');
      lines.push('          }');
      lines.push('          throw err;');
      lines.push('        }');
      lines.push('      };');
      lines.push('      patchedAsync.__bundleAssetsPatched = true;');
      lines.push('      Bun.resolve = patchedAsync;');
      lines.push('    }');
      lines.push('    try {');
      lines.push('      const meta = import.meta;');
      lines.push('      if (meta && typeof meta.resolve === "function" && !meta.resolve.__bundleAssetsPatched) {');
      lines.push('        const originalMetaResolve = meta.resolve.bind(meta);');
      lines.push('        const patchedMetaResolve = function(specifier, parent) {');
      lines.push('          const direct = findOverride(specifier);');
      lines.push('          if (typeof direct === "string") {');
      lines.push('            return direct;');
      lines.push('          }');
      lines.push('          try {');
      lines.push('            const result = originalMetaResolve(specifier, parent);');
      lines.push('            if (result && typeof result.then === "function") {');
      lines.push('              return result.then(output => applyOverride(specifier, output)).catch(err => {');
      lines.push('                const fallback = findOverride(specifier);');
      lines.push('                if (typeof fallback === "string") {');
      lines.push('                  return fallback;');
      lines.push('                }');
      lines.push('                throw err;');
      lines.push('              });');
      lines.push('            }');
      lines.push('            return applyOverride(specifier, result);');
      lines.push('          } catch (err) {');
      lines.push('            const fallback = findOverride(specifier);');
      lines.push('            if (typeof fallback === "string") {');
      lines.push('              return fallback;');
      lines.push('            }');
      lines.push('            throw err;');
      lines.push('          }');
      lines.push('        };');
      lines.push('        patchedMetaResolve.__bundleAssetsPatched = true;');
      lines.push('        try {');
      lines.push('          meta.resolve = patchedMetaResolve;');
      lines.push('        } catch (err) {');
      lines.push('          try {');
      lines.push(
        '            Object.defineProperty(meta, "resolve", { value: patchedMetaResolve, configurable: true });',
      );
      lines.push('          } catch (innerErr) { /* ignore */ }');
      lines.push('        }');
      lines.push('      }');
      lines.push('    } catch (err) { /* ignore */ }');
      lines.push('    globalThis.__bundleAssetsResolversInstalled = true;');
      lines.push('  };');
      lines.push('  installResolvers();');

      if (helperName) {
        lines.push(`  if (typeof globalThis.${helperName} !== 'function') {`);
        lines.push(`    globalThis.${helperName} = (specifier) => {`);
        lines.push('      const map = globalThis[globalKey];');
        lines.push('      if (!map || typeof specifier !== "string") { return null; }');
        lines.push('      const direct = findOverride(specifier);');
        lines.push('      if (typeof direct === "string") { return direct; }');
        lines.push('      return map[specifier] ?? null;');
        lines.push('    };');
        lines.push('  }');
      }

      lines.push('})();');

      const injection = lines.join('\n');
      const entrypointSet = new Set(entrypointAbsPaths);
      const injected = new Set<string>();

      build.onLoad({ filter: /.*/ }, async args => {
        const normalized = path.resolve(args.path);
        if (!entrypointSet.has(normalized) || injected.has(normalized)) {
          return;
        }
        injected.add(normalized);
        const original = await Bun.file(args.path).text();
        return { contents: `${injection}\n${original}` };
      });

      build.onEnd(async () => {
        if (tempOutdir) {
          await rm(tempOutdir, { recursive: true, force: true });
        }
      });
    },
  };
}
