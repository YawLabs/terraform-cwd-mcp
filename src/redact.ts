/**
 * Redaction for every value this server prints from plan or state JSON
 * (design-capabilities.md section 5). Pure: no I/O.
 *
 * `terraform show -json` puts sensitive values in clear text; only the
 * `sensitive_values` / `*_sensitive` marker trees say what to hide, and those
 * markers miss real secrets (a value copied into an unmarked attribute, a
 * literal token in a `terraform_data` input). So there are four layers, applied
 * in order:
 *
 * 1. Terraform's markers: a `true` marker replaces the whole subtree.
 * 2. Value matching: a string equal to (or, for >= 8 chars, containing) any
 *    marked string anywhere in the document; a number equal to a marked number
 *    of >= 4 digits.
 * 3. Key names: a string, number or bool under a secret-like key (own or ancestor).
 * 4. Value shape: private keys (PEM, also base64-encoded), JWTs, well-known
 *    token prefixes; URL passwords, inline `password=...` credentials, `Bearer`
 *    tokens, SAS `sig=` and secret-named `{"name","value"}` JSON pairs are
 *    masked in place.
 */

export const SENSITIVE = "(sensitive)";
export const REDACTED_VALUE = "(redacted: contains a sensitive value)";
export const REDACTED_NAME = "(redacted: secret-like name)";
export const REDACTED_SHAPE = "(redacted: secret-like value)";

// --- Layer 3: key names -----------------------------------------------------

const SECRET_TOKENS = new Set([
  "password",
  "passwd",
  "pwd",
  "pass",
  "passphrase",
  "secret",
  "secrets",
  "token",
  "tokens",
  "apikey",
  "privatekey",
  "credential",
  "credentials",
  "creds",
  "auth",
  "authorization",
  "bearer",
  "cookie",
  "session",
  "sas",
  "signature",
  "kubeconfig",
  "pfx",
  "p12",
  "otp",
  "pin",
  "salt",
  "connectionstring",
]);

const SECRET_PAIRS = new Set([
  "private key",
  "api key",
  "access key",
  "secret key",
  "client secret",
  "connection string",
  "master key",
  "account key",
  "shared key",
  "signing key",
  "encryption key",
]);

/** A key whose LAST token is one of these names metadata about a secret, not the secret. */
const METADATA_TOKENS = new Set([
  "arn",
  "arns",
  "id",
  "ids",
  "name",
  "names",
  "type",
  "types",
  "version",
  "versions",
  "length",
  "count",
  "enabled",
  "disabled",
  "required",
  "ttl",
  "algorithm",
  "fingerprint",
  "expiration",
  "expiry",
  "expires",
  "policy",
  "policies",
  "rotation",
  "path",
  "file",
  "filename",
  "url",
  "uri",
  "endpoint",
  "hash",
  "md5",
  "format",
  "mode",
  "status",
  "state",
  "location",
  "region",
  "zone",
  "label",
  "labels",
  "description",
  "prefix",
  "suffix",
  "size",
  "bits",
  "kind",
  "min",
  "max",
  "timeout",
  "duration",
  "period",
  "days",
  "date",
  "time",
  "timestamp",
  "created",
  "updated",
  "source",
  "strategy",
  "ref",
  "reference",
]);

/** Split a key into lowercase tokens on `_`, `-`, `.`, spaces and camelCase boundaries. */
export function tokenizeKey(key: string): string[] {
  return key
    .replace(/([a-z0-9])([A-Z])/g, "$1 $2")
    .replace(/([A-Z]+)([A-Z][a-z])/g, "$1 $2")
    .split(/[^A-Za-z0-9]+/)
    .filter(Boolean)
    .map((t) => t.toLowerCase());
}

/** Run-together words that contain a secret word but name a service, not a secret. */
const NOT_SECRET_TOKENS = new Set(["secretsmanager"]);

function isSecretToken(t: string): boolean {
  if (SECRET_TOKENS.has(t)) return true;
  if (t.length > 4 && t.endsWith("s") && SECRET_TOKENS.has(t.slice(0, -1))) return true;
  if (NOT_SECRET_TOKENS.has(t)) return false;
  // Env-var style names with no separator: PGPASSWORD, ADMINPASSWORD, MYSQLPWD, GITHUBTOKEN.
  if (/password|passwd|secret/.test(t)) return true;
  return /(pwd|token|apikey|privatekey)$/.test(t);
}

function isMetadataToken(t: string): boolean {
  return METADATA_TOKENS.has(t) || /^sha\d*$/.test(t);
}

/** True when a key names a secret (`db_password`, `apiKey`, `client_secret`) and not metadata about one (`password_length`). */
export function isSecretKey(key: string): boolean {
  const tokens = tokenizeKey(key);
  if (tokens.length === 0) return false;
  if (isMetadataToken(tokens[tokens.length - 1]!)) return false;
  for (let i = 0; i < tokens.length; i++) {
    if (isSecretToken(tokens[i]!)) return true;
    if (i + 1 < tokens.length && SECRET_PAIRS.has(`${tokens[i]} ${tokens[i + 1]}`)) return true;
  }
  return false;
}

/**
 * For a `{ name, value }` / `{ key, value }` list entry (helm_release `set`,
 * kubernetes `env`, ECS `environment`): the secret-like `name`/`key` string that
 * should count as the key of the `value` sibling, else null.
 */
export function pairedSecretName(obj: Record<string, unknown>): string | null {
  if (!Object.hasOwn(obj, "value")) return null;
  for (const k of ["name", "key"]) {
    const n = Object.hasOwn(obj, k) ? obj[k] : undefined;
    if (typeof n === "string" && isSecretKey(n)) return n;
  }
  return null;
}

// --- Layer 4: value shape ---------------------------------------------------

const SHAPES: RegExp[] = [
  /-----BEGIN [A-Z0-9 ]*PRIVATE KEY( BLOCK)?-----/,
  /\beyJ[A-Za-z0-9_-]{5,}\.eyJ[A-Za-z0-9_-]{5,}\.[A-Za-z0-9_-]{5,}/, // JWT (header.payload.signature)
  /\b(ghp|gho|ghu|ghs|ghr)_[A-Za-z0-9]{20,}/,
  /\bgithub_pat_[A-Za-z0-9_]{20,}/,
  /\bglpat-[A-Za-z0-9_-]{20,}/,
  /\bxox[abposr]-[A-Za-z0-9-]{10,}/,
  /\bnpm_[A-Za-z0-9]{36}\b/,
  /\bsk-[A-Za-z0-9_-]{20,}/,
  /\bAIza[0-9A-Za-z_-]{35}/,
  /\bhv[sbr]\.[A-Za-z0-9_-]{20,}/, // Vault service / batch / recovery tokens
  /\b[A-Za-z0-9]{10,}\.atlasv1\.[A-Za-z0-9_-]{20,}/, // HCP Terraform / TFE API tokens
  /\b[rs]k_(live|test)_[A-Za-z0-9]{10,}/, // Stripe secret and restricted keys (pk_ is publishable)
  // base64 of "-----BEGIN ... PRIVATE KEY" (kubeconfig client-key-data): the three alignments of "PRIVATE KEY".
  /LS0tLS1CRUdJTi[A-Za-z0-9+/=]{0,40}(UFJJVkFURSBLRVk|BSSVZBVEUgS0VZ|UklWQVRFIEtFW)/,
];

const URL_USERINFO = /\b([a-z][a-z0-9+.-]*:\/\/)([^\s:@/]+):([^\s@/]+)@/gi;

export function hasSecretShape(s: string): boolean {
  return SHAPES.some((re) => re.test(s));
}

/** Replace the password in `scheme://user:pass@host` with `(redacted)`. Returns null when there is none. */
export function maskUrlPasswords(s: string): string | null {
  URL_USERINFO.lastIndex = 0;
  if (!URL_USERINFO.test(s)) return null;
  URL_USERINFO.lastIndex = 0;
  return s.replace(URL_USERINFO, "$1$2:(redacted)@");
}

/**
 * `Password=x;`, `--password=x`, `"token": "x"`, `AccountKey=x` inside a longer
 * string (connection strings, command lines, embedded JSON). The key may carry a
 * prefix joined by `_` / `-` (`aws_secret_access_key=`, `DB_PASS=`), and the
 * strong words also a run-together one (`PGPASSWORD=`, `MYSQLPWD=`). `pass` only
 * counts as a whole token, so `bypass=` and `compass=` are left alone.
 */
const INLINE_CREDENTIAL =
  /\b((?:[a-z0-9]+[_-])*(?:[a-z0-9]*(?:password|passwd|pwd|secret)|token|pass|authorization|api[_-]?key|access[_-]?key|secret[_-]?key|account[_-]?key|shared[_-]?access[_-]?key|client[_-]?secret)["']?\s*[=:]\s*)((?:(?:bearer|basic)\s+)?(?:"[^"]*"|'[^']*'|[^;\s&"',]+))/gi;

/**
 * `Bearer <token>` / `Basic <creds>` (an Authorization header inside a string).
 * The credential must hold a digit, `+` `/` `=`, or an uppercase letter past its
 * first, or be 20+ chars, so prose ("basic monitoring", "Bearer authentication") stays.
 */
const AUTH_SCHEME =
  /\b((?:[Bb]earer|BEARER|[Bb]asic|BASIC)\s+)((?=[A-Za-z0-9._~+/-]*[0-9+/=]|[A-Za-z0-9._~+/-]+[A-Z])[A-Za-z0-9._~+/-]{8,}=*|[A-Za-z0-9._~+/-]{20,}=*)/g;

/** The `sig=` of an Azure SAS URL / token (`?sv=...&sig=...`). */
const SAS_SIG = /([?&;]sig=)([^&\s"';]+)/gi;

/**
 * `{"name":"DB_PASSWORD","value":"x"}` in JSON held as a string (ECS
 * `container_definitions` environment): the value is masked when the name is
 * secret-like (`isSecretKey`). Either key order.
 */
const NAME_VALUE_JSON =
  /("(?:name|key)"\s*:\s*"((?:[^"\\]|\\.)*)"\s*,\s*"value"\s*:\s*)"(?:[^"\\]|\\.)*"|("value"\s*:\s*)"(?:[^"\\]|\\.)*"(\s*,\s*"(?:name|key)"\s*:\s*"((?:[^"\\]|\\.)*)")/g;

/** Mask inline `key=value` credentials. Returns null when there is none. */
export function maskInlineCredentials(s: string): string | null {
  let out = s.replace(AUTH_SCHEME, "$1(redacted)");
  out = out.replace(INLINE_CREDENTIAL, (_m, key: string, value: string) => {
    const q = value[0] === '"' || value[0] === "'" ? value[0] : "";
    return `${key}${q}(redacted)${q}`;
  });
  out = out.replace(SAS_SIG, "$1(redacted)");
  out = out.replace(
    NAME_VALUE_JSON,
    (m, pre?: string, name?: string, preV?: string, post?: string, nameAfter?: string) => {
      if (pre !== undefined) return isSecretKey(name!) ? `${pre}"(redacted)"` : m;
      return isSecretKey(nameAfter!) ? `${preV}"(redacted)"${post}` : m;
    },
  );
  return out === s ? null : out;
}

/** Both in-place masks (URL passwords, inline credentials). Returns null when neither applied. */
export function maskInlineSecrets(s: string): string | null {
  const url = maskUrlPasswords(s);
  const inline = maskInlineCredentials(url ?? s);
  return inline ?? url;
}

// --- Marker trees and the document-wide sensitive set ------------------------

export type Marker = unknown;

const isPlainObject = (v: unknown): v is Record<string, unknown> =>
  typeof v === "object" && v !== null && !Array.isArray(v);

/** The marker for child `key` of `marker` (a marker is `true`, an object, an array, or absent). */
export function childMarker(marker: Marker, key: string | number): Marker {
  if (marker === true) return true;
  if (Array.isArray(marker)) return typeof key === "number" ? marker[key] : undefined;
  if (isPlainObject(marker)) return Object.hasOwn(marker, String(key)) ? marker[String(key)] : undefined;
  return undefined;
}

/**
 * Collect every string of `value` (any depth), plus numbers of >= 4 digits as
 * their decimal text (a sensitive number copied into an unmarked attribute).
 * Bools are not collected: matching every `true` in the document is noise.
 */
function collectStrings(value: unknown, out: Set<string>): void {
  if (typeof value === "string") {
    if (value.length >= 4) out.add(value);
  } else if (typeof value === "number") {
    const text = String(value);
    if (text.length >= 4) out.add(text);
  } else if (Array.isArray(value)) {
    for (const v of value) collectStrings(v, out);
  } else if (isPlainObject(value)) {
    for (const v of Object.values(value)) collectStrings(v, out);
  }
}

/** Collect the strings of `value` that sit under a `true` marker. */
export function collectMarkedStrings(value: unknown, marker: Marker, out: Set<string>): void {
  if (marker === true) {
    collectStrings(value, out);
    return;
  }
  if (Array.isArray(value)) {
    for (const [i, v] of value.entries()) collectMarkedStrings(v, childMarker(marker, i), out);
  } else if (isPlainObject(value)) {
    for (const [k, v] of Object.entries(value)) collectMarkedStrings(v, childMarker(marker, k), out);
  }
}

/**
 * Every string >= 4 chars under any marker anywhere in a state or plan document,
 * plus the values of outputs marked sensitive. Scope is the whole document so a
 * secret copied into another resource's unmarked attribute is still caught.
 */
export function collectSensitiveStrings(doc: unknown): Set<string> {
  const out = new Set<string>();
  const visitModule = (m: unknown) => {
    if (!isPlainObject(m)) return;
    for (const r of Array.isArray(m.resources) ? m.resources : []) {
      if (isPlainObject(r)) collectMarkedStrings(r.values, r.sensitive_values, out);
    }
    for (const c of Array.isArray(m.child_modules) ? m.child_modules : []) visitModule(c);
  };
  const visitOutputs = (outputs: unknown) => {
    if (!isPlainObject(outputs)) return;
    for (const o of Object.values(outputs)) {
      if (isPlainObject(o) && o.sensitive === true) collectStrings(o.value, out);
    }
  };
  if (!isPlainObject(doc)) return out;
  // Rendered state (`terraform show -json` without a plan).
  if (isPlainObject(doc.values)) {
    visitModule(doc.values.root_module);
    visitOutputs(doc.values.outputs);
  }
  // Plan representation.
  for (const key of ["planned_values"] as const) {
    if (isPlainObject(doc[key])) {
      visitModule((doc[key] as Record<string, unknown>).root_module);
      visitOutputs((doc[key] as Record<string, unknown>).outputs);
    }
  }
  if (isPlainObject(doc.prior_state) && isPlainObject(doc.prior_state.values)) {
    visitModule(doc.prior_state.values.root_module);
    visitOutputs(doc.prior_state.values.outputs);
  }
  for (const list of [doc.resource_changes, doc.resource_drift]) {
    for (const rc of Array.isArray(list) ? list : []) {
      if (!isPlainObject(rc) || !isPlainObject(rc.change)) continue;
      collectMarkedStrings(rc.change.before, rc.change.before_sensitive, out);
      collectMarkedStrings(rc.change.after, rc.change.after_sensitive, out);
    }
  }
  if (isPlainObject(doc.output_changes)) {
    for (const oc of Object.values(doc.output_changes)) {
      if (!isPlainObject(oc)) continue;
      collectMarkedStrings(oc.before, oc.before_sensitive, out);
      collectMarkedStrings(oc.after, oc.after_sensitive, out);
    }
  }
  if (isPlainObject(doc.variables) && isPlainObject(doc.configuration)) {
    // Plan `variables` carries raw values; the configuration says which are sensitive.
    const rootVars = (doc.configuration as { root_module?: { variables?: Record<string, { sensitive?: boolean }> } })
      .root_module?.variables;
    for (const [name, v] of Object.entries(doc.variables)) {
      if (rootVars?.[name]?.sensitive && isPlainObject(v)) collectStrings(v.value, out);
    }
  }
  return out;
}

// --- Applying the layers ------------------------------------------------------

export interface RedactionCounts {
  marked: number;
  name: number;
  value: number;
  shape: number;
}

export function emptyCounts(): RedactionCounts {
  return { marked: 0, name: 0, value: 0, shape: 0 };
}

export class Redactor {
  readonly counts: RedactionCounts = emptyCounts();
  private readonly long: string[];

  constructor(private readonly sensitive: Set<string>) {
    this.long = [...sensitive].filter((s) => s.length >= 8);
  }

  /** Does `s` equal a marked string, or contain one of >= 8 chars? (layer 2) */
  matchesSensitive(s: string): boolean {
    if (this.sensitive.has(s)) return true;
    return this.long.some((x) => s.includes(x));
  }

  /**
   * Layers 2-4 for one string leaf. `keys` is the key path from the resource
   * root (object keys only), used for the name heuristic. Returns the text to
   * print in place of the value, or null to print the (possibly masked) value.
   */
  redactString(s: string, keys: string[]): { replaced: string } | { value: string } {
    if (this.matchesSensitive(s)) {
      this.counts.value++;
      return { replaced: REDACTED_VALUE };
    }
    if (keys.some(isSecretKey)) {
      this.counts.name++;
      return { replaced: REDACTED_NAME };
    }
    if (hasSecretShape(s)) {
      this.counts.shape++;
      return { replaced: REDACTED_SHAPE };
    }
    const masked = maskInlineSecrets(s);
    if (masked !== null) {
      this.counts.shape++;
      return { value: masked };
    }
    return { value: s };
  }

  /**
   * Layers 2-3 for a number or bool leaf: an exact match against a marked
   * number, or a secret-like key. Returns the replacement, or null to print it.
   */
  redactScalar(v: number | boolean, keys: string[]): string | null {
    if (typeof v === "number" && this.sensitive.has(String(v))) {
      this.counts.value++;
      return REDACTED_VALUE;
    }
    if (keys.some(isSecretKey)) {
      this.counts.name++;
      return REDACTED_NAME;
    }
    return null;
  }

  /** The footer line, or "" when nothing was redacted. */
  footer(): string {
    const c = this.counts;
    if (c.marked + c.name + c.value + c.shape === 0) return "";
    const shape = c.shape ? `, ${c.shape} by shape` : "";
    return `redacted: ${c.marked} marked sensitive by Terraform, ${c.name} by name, ${c.value} by value${shape}`;
  }
}
