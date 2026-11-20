/**
 * `node --import ./scripts/bake/register.ts` で読み込む。
 * `src/` のモジュールは拡張子なしで互いを import している（Vite・tsc の bundler 解決）ため、
 * Node の ESM でも `.ts` を補って解決できるようにする。
 */
import { register } from 'node:module';

register('./resolveTs.ts', import.meta.url);
