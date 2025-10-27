import { $ } from 'bun';
import { expect, it } from 'bun:test';
import { mkdir, readFile, rm, stat } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { bundleAssetsPlugin, type AssetInput } from '..';

const resolveAsset = (relativePath: string) => import.meta.resolve(`./assets/${relativePath}`);

const buildEntry = path.join(import.meta.dir, 'app.ts');
const distRoot = path.join(import.meta.dir, 'dist');

type ReadResult = {
  specifier: string;
  mode: string;
  path: string;
  size: number;
  preview: unknown;
};

type ModuleResult = {
  specifier: string;
  mode: string;
  path: string;
  exports: Record<string, unknown>;
};

const isRecord = (value: unknown): value is Record<string, unknown> => typeof value === 'object' && value !== null;

type ResolveResult = {
  specifier: string;
  mode: string;
  resolved: string;
};

const toFsPath = (input: string) => (input.startsWith('file://') ? fileURLToPath(input) : input);

async function cleanDir(dir: string) {
  await rm(dir, { recursive: true, force: true });
  await mkdir(dir, { recursive: true });
}

function assertReadResults(value: unknown): asserts value is ReadResult[] {
  if (!Array.isArray(value)) {
    throw new Error('Expected array of read results');
  }
  for (const item of value) {
    if (!isRecord(item)) {
      throw new Error('Expected object in read results');
    }
    if (typeof item.specifier !== 'string') throw new Error('Invalid specifier');
    if (typeof item.mode !== 'string') throw new Error('Invalid mode');
    if (typeof item.path !== 'string') throw new Error('Invalid path');
    if (typeof item.size !== 'number') throw new Error('Invalid size');
  }
}

function assertModuleResults(value: unknown): asserts value is ModuleResult[] {
  if (!Array.isArray(value)) {
    throw new Error('Expected array of module results');
  }
  for (const item of value) {
    if (!isRecord(item)) {
      throw new Error('Expected object in module results');
    }
    if (typeof item.specifier !== 'string') throw new Error('Invalid specifier');
    if (typeof item.mode !== 'string') throw new Error('Invalid mode');
    if (typeof item.path !== 'string') throw new Error('Invalid path');
    if (!isRecord(item.exports)) {
      throw new Error('Invalid exports');
    }
  }
}

function assertDefined<T>(value: T | undefined, message: string): asserts value is T {
  if (value === undefined) {
    throw new Error(message);
  }
}

function assertResolveResults(value: unknown): asserts value is ResolveResult[] {
  if (!Array.isArray(value)) {
    throw new Error('Expected array of resolve results');
  }
  for (const item of value) {
    if (!isRecord(item)) {
      throw new Error('Expected object in resolve results');
    }
    if (typeof item.specifier !== 'string') throw new Error('Invalid specifier');
    if (typeof item.mode !== 'string') throw new Error('Invalid mode');
    if (typeof item.resolved !== 'string') throw new Error('Invalid resolved path');
  }
}

it('bundles assets for standard builds', async () => {
  const textRuntimeKey = './assets/sample.txt';
  const binaryRuntimeKey = './assets/data.bin';
  const assets: AssetInput[] = [
    {
      specifier: resolveAsset('sample.txt'),
      targetName: 'static/text/sample.txt',
      runtimeKeys: [textRuntimeKey],
    },
    {
      specifier: resolveAsset('data.bin'),
      targetName: 'static/bin/data.bin',
      runtimeKeys: [binaryRuntimeKey],
    },
  ];

  const outdir = path.join(distRoot, 'bundle');
  await cleanDir(outdir);

  const result = await Bun.build({
    entrypoints: [buildEntry],
    outdir,
    target: 'bun',
    format: 'esm',
    naming: '[name].js',
    plugins: [bundleAssetsPlugin({ assets })],
  });

  expect(result.success).toBe(true);

  for (const expected of ['static/text/sample.txt', 'static/bin/data.bin']) {
    const emittedPath = path.join(outdir, expected);
    const emittedStat = await stat(emittedPath);
    expect(emittedStat.isFile()).toBe(true);
  }

  const plan = [
    { specifier: textRuntimeKey, mode: 'read' as const },
    { specifier: binaryRuntimeKey, mode: 'read' as const },
  ];

  const run = await $`bun ${path.join(outdir, 'app.js')}`.env({ BUNDLE_PLAN: JSON.stringify(plan) }).throws(false);

  expect(run.exitCode).toBe(0);
  const parsedUnknown = JSON.parse(run.stdout.toString()) as unknown;
  assertReadResults(parsedUnknown);
  const parsed = parsedUnknown;
  expect(parsed).toHaveLength(2);
  const textEntry = parsed.find(item => item.specifier === textRuntimeKey);
  const binaryEntry = parsed.find(item => item.specifier === binaryRuntimeKey);
  assertDefined(textEntry, 'Missing text asset result');
  assertDefined(binaryEntry, 'Missing binary asset result');
  expect(textEntry.preview).toBe('hello bundled world');
  expect(binaryEntry.size).toBe(5);
  expect(textEntry.path.endsWith('static/text/sample.txt')).toBe(true);

  const resolvePlan = [{ specifier: textRuntimeKey, mode: 'resolve' as const }];
  const resolveRun = await $`bun ${path.join(outdir, 'app.js')}`
    .env({ BUNDLE_PLAN: JSON.stringify(resolvePlan) })
    .throws(false);

  expect(resolveRun.exitCode).toBe(0);
  const resolveResultsUnknown = JSON.parse(resolveRun.stdout.toString()) as unknown;
  assertResolveResults(resolveResultsUnknown);
  const resolveEntry = resolveResultsUnknown[0];
  assertDefined(resolveEntry, 'Missing resolve result');
  expect(resolveEntry.mode).toBe('resolve');
  const resolvedFsPath = toFsPath(resolveEntry.resolved);
  const resolvedStat = await stat(resolvedFsPath);
  expect(resolvedStat.isFile()).toBe(true);

  const textPath = path.join(outdir, 'static/text/sample.txt');
  const textContent = await readFile(textPath, 'utf8');
  expect(textContent.trim()).toBe('hello bundled world');
});

it('exposes assets when compiling executables', async () => {
  const textRuntimeKey = './assets/sample.txt';
  const binaryRuntimeKey = './assets/data.bin';
  const assets: AssetInput[] = [
    {
      specifier: resolveAsset('sample.txt'),
      targetName: 'embedded/text/sample.txt',
      runtimeKeys: [textRuntimeKey],
    },
    {
      specifier: resolveAsset('data.bin'),
      targetName: 'embedded/bin/data.bin',
      runtimeKeys: [binaryRuntimeKey],
    },
  ];

  const outdir = path.join(distRoot, 'compile');
  await cleanDir(outdir);

  const outfile = path.join(outdir, 'app');
  const extractionRoot = path.join(outdir, 'runtime-assets');

  const result = await Bun.build({
    entrypoints: [buildEntry],
    target: 'bun',
    format: 'esm',
    compile: { outfile },
    plugins: [bundleAssetsPlugin({ assets, extractionDir: extractionRoot })],
  });

  expect(result.success).toBe(true);

  const plan = [
    { specifier: textRuntimeKey, mode: 'read' as const },
    { specifier: binaryRuntimeKey, mode: 'read' as const },
  ];

  const run = await $`${outfile}`.env({ BUNDLE_PLAN: JSON.stringify(plan) }).throws(false);

  expect(run.exitCode).toBe(0);
  const parsedUnknown = JSON.parse(run.stdout.toString()) as unknown;
  assertReadResults(parsedUnknown);
  const parsed = parsedUnknown;
  expect(parsed).toHaveLength(2);
  const textEntry = parsed.find(item => item.specifier === textRuntimeKey);
  const binaryEntry = parsed.find(item => item.specifier === binaryRuntimeKey);
  assertDefined(textEntry, 'Missing text asset result (compile)');
  assertDefined(binaryEntry, 'Missing binary asset result (compile)');
  expect(textEntry.preview).toBe('hello bundled world');
  expect(binaryEntry.size).toBe(5);
  expect(textEntry.path.endsWith('embedded/text/sample.txt')).toBe(true);
  expect(textEntry.path.startsWith(extractionRoot)).toBe(true);
  expect(binaryEntry.path.startsWith(extractionRoot)).toBe(true);

  const resolveCompilePlan = [{ specifier: textRuntimeKey, mode: 'resolve' as const }];
  const resolveCompileRun = await $`${outfile}`.env({ BUNDLE_PLAN: JSON.stringify(resolveCompilePlan) }).throws(false);

  expect(resolveCompileRun.exitCode).toBe(0);
  const resolveCompileUnknown = JSON.parse(resolveCompileRun.stdout.toString()) as unknown;
  assertResolveResults(resolveCompileUnknown);
  const resolveCompileEntry = resolveCompileUnknown[0];
  assertDefined(resolveCompileEntry, 'Missing resolve result (compile)');
  expect(resolveCompileEntry.mode).toBe('resolve');
  const resolveCompileFsPath = toFsPath(resolveCompileEntry.resolved);
  const resolveCompileStat = await stat(resolveCompileFsPath);
  expect(resolveCompileStat.isFile()).toBe(true);
  expect(resolveCompileFsPath.startsWith(extractionRoot)).toBe(true);
  expect(resolveCompileFsPath.endsWith(path.join('embedded', 'text', 'sample.txt'))).toBe(true);

  const runtimePaths = parsed.map(item => item.path);
  for (const assetPath of runtimePaths) {
    const assetStat = await stat(assetPath);
    expect(assetStat.isFile()).toBe(true);
  }
});

it('dynamically imports bundled javascript modules', async () => {
  const esmRuntimeKey = './assets/esm-module.js';
  const cjsRuntimeKey = 'fake-pkg';
  const assets: AssetInput[] = [
    {
      specifier: resolveAsset('esm-module.js'),
      targetName: 'modules/esm/esm-module.js',
      runtimeKeys: [esmRuntimeKey],
    },
    {
      specifier: './node_modules/fake-pkg/index.cjs',
      targetName: 'modules/cjs/index.cjs',
      runtimeKeys: [cjsRuntimeKey],
    },
  ];

  const outdir = path.join(distRoot, 'modules');
  await cleanDir(outdir);

  const result = await Bun.build({
    entrypoints: [buildEntry],
    outdir,
    target: 'bun',
    format: 'esm',
    naming: '[name].js',
    plugins: [bundleAssetsPlugin({ assets })],
  });

  expect(result.success).toBe(true);
  const plan = [
    { specifier: esmRuntimeKey, mode: 'import' as const },
    { specifier: cjsRuntimeKey, mode: 'require' as const },
  ];

  const run = await $`bun ${path.join(outdir, 'app.js')}`.env({ BUNDLE_PLAN: JSON.stringify(plan) }).throws(false);

  expect(run.exitCode).toBe(0);
  const moduleResultsUnknown = JSON.parse(run.stdout.toString()) as unknown;
  assertModuleResults(moduleResultsUnknown);
  const parsed = moduleResultsUnknown;
  expect(parsed).toHaveLength(2);

  const esmEntry = parsed.find(entry => entry.specifier === esmRuntimeKey);
  const cjsEntry = parsed.find(entry => entry.specifier === cjsRuntimeKey);
  assertDefined(esmEntry, 'Missing esm module result');
  assertDefined(cjsEntry, 'Missing cjs module result');
  expect(esmEntry.mode).toBe('import');
  expect(esmEntry.exports).toMatchObject({ default: 'hello module', answer: 42 });
  expect(esmEntry.path.endsWith('modules/esm/esm-module.js')).toBe(true);
  expect(cjsEntry.mode).toBe('require');
  expect(cjsEntry.exports).toMatchObject({ framework: 'bun', features: ['fast', 'fun'] });
  expect(cjsEntry.path.endsWith('modules/cjs/index.cjs')).toBe(true);

  const resolveModulePlan = [
    { specifier: esmRuntimeKey, mode: 'resolve' as const },
    { specifier: cjsRuntimeKey, mode: 'resolve' as const },
  ];

  const resolveModuleRun = await $`bun ${path.join(outdir, 'app.js')}`
    .env({ BUNDLE_PLAN: JSON.stringify(resolveModulePlan) })
    .throws(false);

  expect(resolveModuleRun.exitCode).toBe(0);
  const resolveModuleUnknown = JSON.parse(resolveModuleRun.stdout.toString()) as unknown;
  assertResolveResults(resolveModuleUnknown);
  expect(resolveModuleUnknown).toHaveLength(2);
  for (const entry of resolveModuleUnknown) {
    const fsPath = toFsPath(entry.resolved);
    const fileStat = await stat(fsPath);
    expect(fileStat.isFile()).toBe(true);
  }
});

it('dynamically imports modules from compiled executables', async () => {
  const esmRuntimeKey = './assets/esm-module.js';
  const cjsRuntimeKey = 'fake-pkg';
  const assets: AssetInput[] = [
    {
      specifier: resolveAsset('esm-module.js'),
      targetName: 'modules/esm/esm-module.js',
      runtimeKeys: [esmRuntimeKey],
    },
    {
      specifier: './node_modules/fake-pkg/index.cjs',
      targetName: 'modules/cjs/index.cjs',
      runtimeKeys: [cjsRuntimeKey],
    },
  ];

  const outdir = path.join(distRoot, 'modules-compile');
  await cleanDir(outdir);

  const outfile = path.join(outdir, 'app');

  const result = await Bun.build({
    entrypoints: [buildEntry],
    target: 'bun',
    format: 'esm',
    compile: { outfile },
    plugins: [bundleAssetsPlugin({ assets })],
  });

  expect(result.success).toBe(true);
  const plan = [
    { specifier: esmRuntimeKey, mode: 'import' as const },
    { specifier: cjsRuntimeKey, mode: 'require' as const },
  ];

  const run = await $`${outfile}`.env({ BUNDLE_PLAN: JSON.stringify(plan) }).throws(false);

  expect(run.exitCode).toBe(0);
  const moduleResultsUnknown = JSON.parse(run.stdout.toString()) as unknown;
  assertModuleResults(moduleResultsUnknown);
  const parsed = moduleResultsUnknown;
  expect(parsed).toHaveLength(2);

  const esmEntry = parsed.find(entry => entry.specifier === esmRuntimeKey);
  const cjsEntry = parsed.find(entry => entry.specifier === cjsRuntimeKey);
  assertDefined(esmEntry, 'Missing esm module result (compile)');
  assertDefined(cjsEntry, 'Missing cjs module result (compile)');
  expect(esmEntry.mode).toBe('import');
  expect(esmEntry.exports).toMatchObject({ default: 'hello module', answer: 42 });
  expect(cjsEntry.mode).toBe('require');
  expect(cjsEntry.exports).toMatchObject({ framework: 'bun', features: ['fast', 'fun'] });
  expect(esmEntry.path.endsWith('modules/esm/esm-module.js')).toBe(true);
  expect(cjsEntry.path.endsWith('modules/cjs/index.cjs')).toBe(true);

  const runtimePaths = parsed.map(item => item.path);
  for (const assetPath of runtimePaths) {
    const assetStat = await stat(assetPath);
    expect(assetStat.isFile()).toBe(true);
  }

  const resolveModulePlan = [
    { specifier: esmRuntimeKey, mode: 'resolve' as const },
    { specifier: cjsRuntimeKey, mode: 'resolve' as const },
  ];

  const resolveModuleRun = await $`${outfile}`.env({ BUNDLE_PLAN: JSON.stringify(resolveModulePlan) }).throws(false);

  expect(resolveModuleRun.exitCode).toBe(0);
  const resolveModuleUnknown = JSON.parse(resolveModuleRun.stdout.toString()) as unknown;
  assertResolveResults(resolveModuleUnknown);
  expect(resolveModuleUnknown).toHaveLength(2);
  for (const entry of resolveModuleUnknown) {
    const fsPath = toFsPath(entry.resolved);
    const fileStat = await stat(fsPath);
    expect(fileStat.isFile()).toBe(true);
  }
});
