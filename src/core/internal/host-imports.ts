export type HostImportResolver = (source: string, importer: string) => Promise<string | undefined>;

export const hostImportResolvers = new WeakMap<object, HostImportResolver>();
