import { createRequire } from 'node:module';
import { readFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';

const requireFn = createRequire(import.meta.url);

declare global {
  // eslint-disable-next-line no-var
  var getBundleAsset: ((specifier: string) => string | null) | undefined;
}

const helper = globalThis.getBundleAsset;
if (typeof helper !== 'function') {
  throw new Error('bundle helper not available');
}

type Action = {
  specifier: string;
  mode?: 'read' | 'import' | 'require' | 'resolve';
};

const plan: Action[] = (() => {
  const rawPlan = Bun.env.BUNDLE_PLAN;
  if (rawPlan) {
    return JSON.parse(rawPlan) as Action[];
  }
  const specs = Bun.env.BUNDLE_SPECS ? (JSON.parse(Bun.env.BUNDLE_SPECS) as string[]) : [];
  return specs.map(specifier => ({ specifier, mode: 'read' }));
})();

const results = await Promise.all(
  plan.map(async ({ specifier, mode = 'read' }) => {
    if (mode === 'resolve') {
      const resolvedPath = await Promise.resolve(import.meta.resolve(specifier));
      return { specifier, mode, resolved: resolvedPath };
    }

    const assetPath = helper?.(specifier);
    if (!assetPath) {
      throw new Error(`missing asset mapping for ${specifier}`);
    }

    if (mode === 'import') {
      const imported = await import(pathToFileURL(assetPath).href);
      const exportsSnapshot: Record<string, unknown> = {};
      for (const key of Object.keys(imported)) {
        exportsSnapshot[key] = imported[key as keyof typeof imported];
      }
      if ('default' in imported) {
        exportsSnapshot.default = imported.default;
      }
      return { specifier, mode, path: assetPath, exports: exportsSnapshot };
    }

    if (mode === 'require') {
      const required = requireFn(assetPath);
      const snapshot: Record<string, unknown> = {};
      if (required && typeof required === 'object') {
        for (const key of Object.keys(required)) {
          snapshot[key] = required[key as keyof typeof required];
        }
      } else {
        snapshot.default = required;
      }
      return { specifier, mode, path: assetPath, exports: snapshot };
    }

    const buffer = readFileSync(assetPath);
    const preview = assetPath.endsWith('.txt') ? buffer.toString('utf8').trim() : Array.from(buffer.slice(0, 4));
    return {
      specifier,
      mode,
      path: assetPath,
      size: buffer.length,
      preview,
    };
  }),
);

console.log(JSON.stringify(results));
