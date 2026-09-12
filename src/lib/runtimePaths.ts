import fs from "node:fs";
import path from "node:path";

const PACKAGE_NAME = "rheinagent-file-upload";

/**
 * Resolves the product root from a module directory instead of assuming a
 * fixed source-tree depth. Source modules live below `src/lib/`, compiled
 * modules below `dist/src/lib/`; a hard-coded `../..` therefore points at
 * different directories before and after `tsc`.
 */
export function findProductRoot(startDir: string): string {
  let current = path.resolve(startDir);

  while (true) {
    const packagePath = path.join(current, "package.json");
    try {
      const raw = fs.readFileSync(packagePath, "utf-8");
      const pkg = JSON.parse(raw) as { name?: unknown };
      if (pkg.name === PACKAGE_NAME) return current;
    } catch (err) {
      const code = (err as NodeJS.ErrnoException).code;
      if (code !== "ENOENT" && code !== "ENOTDIR") throw err;
    }

    const parent = path.dirname(current);
    if (parent === current) break;
    current = parent;
  }

  throw new Error(`could not locate ${PACKAGE_NAME} package root from ${startDir}`);
}

export const PRODUCT_ROOT = findProductRoot(import.meta.dirname);

/**
 * Optional explicit persistent-data location. Relative overrides are resolved
 * against the product root (not process.cwd()) so Windows services, systemd,
 * Docker and ad-hoc launches all behave identically.
 */
export function resolveDataDir(
  configured: string | undefined = process.env.RHEINAGENT_FILE_UPLOAD_DATA_DIR,
  productRoot: string = PRODUCT_ROOT,
): string {
  const value = configured?.trim();
  if (!value) return path.join(productRoot, "data");
  return path.isAbsolute(value) ? path.normalize(value) : path.resolve(productRoot, value);
}

export const DATA_DIR = resolveDataDir();

export function readProductVersion(productRoot: string = PRODUCT_ROOT): string {
  const raw = fs.readFileSync(path.join(productRoot, "package.json"), "utf-8");
  const pkg = JSON.parse(raw) as { version?: unknown };
  if (typeof pkg.version !== "string" || pkg.version.length === 0) {
    throw new Error("package.json does not contain a valid version");
  }
  return pkg.version;
}
