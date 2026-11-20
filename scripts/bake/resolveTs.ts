/** Node の ESM の解決フック: 拡張子のない相対 import に `.ts`（または `/index.ts`）を補う。 */
interface ResolveContext {
  parentURL?: string;
}
type NextResolve = (specifier: string, context: ResolveContext) => Promise<{ url: string }>;

export async function resolve(
  specifier: string,
  context: ResolveContext,
  nextResolve: NextResolve,
): Promise<{ url: string }> {
  const relative = specifier.startsWith('./') || specifier.startsWith('../');
  if (!relative || /\.[cm]?[jt]s$/.test(specifier)) return nextResolve(specifier, context);
  try {
    return await nextResolve(`${specifier}.ts`, context);
  } catch {
    return nextResolve(`${specifier}/index.ts`, context);
  }
}
