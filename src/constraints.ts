/**
 * Terraform provider version constraints, evaluated the way `terraform init`
 * does (apparentlymart/go-versions, as wrapped by `getproviders.ParseVersionConstraints`):
 *
 * - operators `=`, `!=`, `>`, `>=`, `<`, `<=`, `~>`; a bare version means `=`;
 *   comma-separated clauses are ANDed;
 * - `~> 1.2` allows >= 1.2.0, < 2.0.0; `~> 1.2.3` allows >= 1.2.3, < 1.3.0;
 *   `~> 1` allows >= 1.0.0, < 2.0.0;
 * - a prerelease version satisfies only a clause naming that exact prerelease
 *   (`= 1.2.0-beta1` or bare `1.2.0-beta1`), never a range.
 *
 * Pure: no I/O.
 */

export interface Version {
  major: number;
  minor: number;
  patch: number;
  pre: string;
}

const VERSION_RE = /^v?(\d+)(?:\.(\d+))?(?:\.(\d+))?(?:-([0-9A-Za-z.-]+))?(?:\+[0-9A-Za-z.-]+)?$/;

/** Exact version as `tf_upgrade_impact` accepts it: three numeric parts, optional prerelease. */
export const EXACT_VERSION_RE = /^\d+\.\d+\.\d+(-[0-9A-Za-z.-]+)?$/;

/** Parse `1`, `1.2`, `1.2.3`, `1.2.3-beta1` (missing parts are 0). Returns null on anything else. */
export function parseVersion(s: string): Version | null {
  const m = VERSION_RE.exec(s.trim());
  if (!m) return null;
  return { major: Number(m[1]), minor: Number(m[2] ?? 0), patch: Number(m[3] ?? 0), pre: m[4] ?? "" };
}

function comparePre(a: string, b: string): number {
  if (a === b) return 0;
  if (!a) return 1; // a release sorts after any prerelease
  if (!b) return -1;
  const pa = a.split(".");
  const pb = b.split(".");
  for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
    const x = pa[i];
    const y = pb[i];
    if (x === undefined) return -1;
    if (y === undefined) return 1;
    const nx = /^\d+$/.test(x);
    const ny = /^\d+$/.test(y);
    if (nx && ny) {
      const d = Number(x) - Number(y);
      if (d !== 0) return d < 0 ? -1 : 1;
    } else if (nx !== ny) {
      return nx ? -1 : 1;
    } else if (x !== y) {
      return x < y ? -1 : 1;
    }
  }
  return 0;
}

export function compareVersions(a: Version, b: Version): number {
  for (const k of ["major", "minor", "patch"] as const) {
    if (a[k] !== b[k]) return a[k] < b[k] ? -1 : 1;
  }
  return comparePre(a.pre, b.pre);
}

export function formatVersion(v: Version): string {
  return `${v.major}.${v.minor}.${v.patch}${v.pre ? `-${v.pre}` : ""}`;
}

interface Clause {
  op: "=" | "!=" | ">" | ">=" | "<" | "<=" | "~>";
  version: Version;
  /** Number of numeric parts written (for `~>`). */
  parts: number;
}

export class ConstraintSyntaxError extends Error {}

export function parseConstraint(text: string): Clause[] {
  const clauses: Clause[] = [];
  for (const raw of text.split(",")) {
    const part = raw.trim();
    if (!part) throw new ConstraintSyntaxError(`empty clause in version constraint "${text}"`);
    const m = /^(~>|>=|<=|!=|=|>|<)?\s*(.+)$/.exec(part);
    const op = (m?.[1] ?? "=") as Clause["op"];
    const vtext = (m?.[2] ?? "").trim();
    const version = parseVersion(vtext);
    if (!version) throw new ConstraintSyntaxError(`invalid version "${vtext}" in constraint "${text}"`);
    const parts = vtext.replace(/^v/, "").split(/[-+]/)[0]!.split(".").length;
    clauses.push({ op, version, parts });
  }
  return clauses;
}

function clauseAllows(c: Clause, v: Version): boolean {
  if (v.pre) {
    // A prerelease only ever matches an exact clause naming it.
    return c.op === "=" && compareVersions(c.version, v) === 0;
  }
  const cmp = compareVersions(v, c.version);
  switch (c.op) {
    case "=":
      return cmp === 0;
    case "!=":
      return cmp !== 0;
    case ">":
      return cmp > 0;
    case ">=":
      return cmp >= 0;
    case "<":
      return cmp < 0;
    case "<=":
      return cmp <= 0;
    case "~>": {
      if (cmp < 0) return false;
      // ~> 1 and ~> 1.2 bump the major; ~> 1.2.3 bumps the minor.
      if (c.parts >= 3) return v.major === c.version.major && v.minor === c.version.minor;
      return v.major === c.version.major;
    }
  }
}

/** Does `version` satisfy every clause of `constraint`? Throws ConstraintSyntaxError on bad syntax. */
export function satisfies(version: string | Version, constraint: string): boolean {
  const v = typeof version === "string" ? parseVersion(version) : version;
  if (!v) throw new ConstraintSyntaxError(`invalid version "${String(version)}"`);
  return parseConstraint(constraint).every((c) => clauseAllows(c, v));
}

/** True when the constraint is a single exact version (bare or `=`), i.e. a pin. */
export function isExactPin(constraint: string): boolean {
  try {
    const cs = parseConstraint(constraint);
    return cs.length === 1 && cs[0]!.op === "=" && cs[0]!.parts === 3;
  } catch {
    return false;
  }
}

/** `major` / `minor` / `patch` / `prerelease` distance between two versions. */
export function bumpKind(from: Version, to: Version): "major" | "minor" | "patch" | "prerelease" {
  if (from.major !== to.major) return "major";
  if (from.minor !== to.minor) return "minor";
  if (from.patch !== to.patch) return "patch";
  return "prerelease";
}
