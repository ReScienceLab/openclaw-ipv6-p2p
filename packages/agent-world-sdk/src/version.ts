import { createRequire } from "node:module";
const require = createRequire(import.meta.url);
const pkg = require("../package.json");

/**
 * Extract major.minor version from package.json semantic version.
 *
 * Protocol version used in domain separators, HTTP headers, and signature
 * validation. Changes to this value are BREAKING CHANGES that invalidate
 * all existing signatures.
 *
 * Examples:
 *   "0.4.3" → "0.4"
 *   "1.0.0-alpha.2" → "1.0"
 *   "2.1.5-rc.3+build" → "2.1"
 *
 * @throws {Error} If package.json version is not valid semver
 */
function extractMajorMinor(fullVersion: string): string {
  // Validate basic semver format: X.Y.Z or X.Y.Z-prerelease+build
  const semverPattern = /^\d+\.\d+\.\d+/;
  if (!semverPattern.test(fullVersion)) {
    throw new Error(
      `Invalid semver version in package.json: "${fullVersion}". ` +
        `Expected format: X.Y.Z (e.g., "0.4.3", "1.0.0-alpha.2")`
    );
  }

  // Extract major.minor by splitting on '.' and taking first two parts
  const parts = fullVersion.split(".");
  return `${parts[0]}.${parts[1]}`;
}

export const PROTOCOL_VERSION: string = extractMajorMinor(pkg.version);
