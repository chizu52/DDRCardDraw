/** Just the one webpack build-time macro this repo actually uses (see
 * src/obs-sources/local-fonts.ts) -- `require` isn't otherwise a thing
 * in this ESM-authored codebase, so this declares only enough of it for
 * `require.context(...)` to typecheck, rather than pulling in the full
 * @types/webpack-env package (this project's tsconfig deliberately sets
 * "types": [] to avoid auto-including type packages). */
interface WebpackRequireContext {
  keys(): string[];
  (id: string): unknown;
}

interface NodeRequire {
  context(
    directory: string,
    useSubdirectories?: boolean,
    regExp?: RegExp,
  ): WebpackRequireContext;
}

declare const require: NodeRequire;
