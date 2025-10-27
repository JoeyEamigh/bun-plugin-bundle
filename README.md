# bun-plugin-bundle

`bun-plugin-bundle` allows you to stuff files and directories into your bun build in a much more ergonomic way than the `with { type: 'file' };` syntax. Assets will appear alongside bundled output or inside compiled executables with no extra wiring.

## Installation

```bash
bun install bun-plugin-bundle
```

## Quick start

```ts
import { bundleAssetsPlugin } from 'bun-plugin-bundle';

await Bun.build({
  entrypoints: ['src/main.ts'],
  outdir: 'dist',
  format: 'esm',
  target: 'bun',
  compile: process.argv.includes('--compile') ? { outfile: 'dist/app' } : false,
  plugins: [
    bundleAssetsPlugin({
      assets: [
        'some-package',
        {
          specifier: './assets/logo.png',
          targetName: 'static/images/logo.png',
          runtimeKeys: ['./assets/logo.png'],
        },
        '@monorepo/package-that-doesnt-like-to-be-bundled',
      ],
    }),
  ],
});
```

- Bundle mode copies files into `dist/...`.
- Compile mode embeds the same files and extracts them at runtime so the binary can read them immediately.
- In both modes `getBundleAsset(specifier)` is installed on `globalThis` (unless you opt out with `helperName: null`).

## Runtime behaviour

- Calls such as `import.meta.resolve('./assets/logo.png')`, `Bun.resolve`, and `Bun.resolveSync` continue to work because the plugin patches the runtime to return the emitted paths.
- `runtimeKeys` lets you register extra specifiers (relative or package-style) so code that never touches the helper still resolves the bundled file.

## Configuration

| Option          | Type                                                                                  | Default                                       | Description                                                                                                                                                                   |
| --------------- | ------------------------------------------------------------------------------------- | --------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `assets`        | `Array<string \| { specifier: string; targetName?: string; runtimeKeys?: string[] }>` | _Required_                                    | Assets to include. `targetName` overrides the emitted path (supports directories). `runtimeKeys` registers additional specifiers that should map to the same file at runtime. |
| `globalKey`     | `string`                                                                              | `__bundleAssets`                              | Property on `globalThis` storing the asset lookup table. Change if you need to avoid a naming clash.                                                                          |
| `helperName`    | `string \| null`                                                                      | `getBundleAsset`                              | Name of the helper installed on `globalThis`. Set to `null` to skip helper creation.                                                                                          |
| `logging`       | `'default' \| 'plain' \| 'quiet'`                                                     | `'default'`                                   | Controls setup logs.                                                                                                                                                          |
| `extractionDir` | `string`                                                                              | `path.join(os.tmpdir(), 'bun-plugin-bundle')` | Absolute directory used when unpacking embedded assets from a compiled binary. The plugin adds a fingerprinted subdirectory per build.                                        |

## How resolution works

- Resolution starts with `import.meta.resolve`. If it fails (for example, when you pass `./node_modules/pkg/file.js`), the plugin checks the current working directory and each entrypoint directory so project-relative paths behave as expected.
- Bundled builds copy assets into the output tree.
- Compiled builds embed assets in the executable and unpack them into the configured extraction directory on first run, reusing the files on subsequent launches.
