import { childMarker, collectSensitiveStrings, type Marker, Redactor } from "./redact.js";

/**
 * tf_summarize_plan (design-capabilities.md section 7.1). Pure: input detection
 * and rendering of a JSON plan representation (`terraform show -json <plan>`, or
 * HCP's `/plans/:id/json-output`, which is the same format).
 *
 * The summary prints NO values: only addresses, actions, reasons and attribute
 * paths. Paths that pass through a node Terraform marks sensitive are truncated
 * at it (`keepers [sensitive]`), and import IDs are never printed (for
 * random_password / random_string / random_id the import ID IS the secret).
 */

// --- Input detection ---------------------------------------------------------------

export type PlanInput = { kind: "binary" } | { kind: "plan"; doc: PlanDoc } | { kind: "refuse"; message: string };

const ZIP_MAGIC = [0x50, 0x4b, 0x03, 0x04];

export function isZip(bytes: Uint8Array): boolean {
  return ZIP_MAGIC.every((b, i) => bytes[i] === b);
}

export const UI_STREAM_MESSAGE =
  "this is `terraform plan -json` UI-stream output, not a plan representation. Save the plan with " +
  "`terraform plan -out=tfplan` and pass that file.";

export const STATE_MESSAGE = "this is a state file, not a plan. Use tf_show_resource / tf_state_addresses.";

/** Classify JSON text that claims to be a plan. */
export function detectPlanJson(text: string): PlanInput {
  const trimmed = text.replace(/^﻿/, "").trim();
  let doc: unknown;
  try {
    doc = JSON.parse(trimmed);
  } catch (e) {
    const first = trimmed.split(/\r?\n/, 1)[0] ?? "";
    try {
      const line = JSON.parse(first) as Record<string, unknown>;
      if (line && typeof line === "object" && "@level" in line) return { kind: "refuse", message: UI_STREAM_MESSAGE };
    } catch {
      // not JSON lines either
    }
    return {
      kind: "refuse",
      message: `not a Terraform plan: the input is not JSON (${e instanceof Error ? e.message : String(e)}). Pass a saved plan file (terraform plan -out) or its terraform show -json output.`,
    };
  }
  if (!doc || typeof doc !== "object" || Array.isArray(doc)) {
    return { kind: "refuse", message: "not a Terraform plan: expected a JSON object." };
  }
  const o = doc as Record<string, unknown>;
  if ("@level" in o) return { kind: "refuse", message: UI_STREAM_MESSAGE };
  if ("remote_plan_format" in o && "run_id" in o) {
    return {
      kind: "refuse",
      message:
        `this is an HCP Terraform saved-plan bookmark for run ${String(o.run_id)}; get its plan id with the official ` +
        "terraform MCP server's get_run_details, fetch get_plan_json_output(plan_id), and pass that as plan_json " +
        "(both need the official server's terraform toolset and TFE_TOKEN).",
    };
  }
  if ("resource_changes" in o || "planned_values" in o) return { kind: "plan", doc: o as PlanDoc };
  if (("version" in o && "lineage" in o) || "values" in o) return { kind: "refuse", message: STATE_MESSAGE };
  return {
    kind: "refuse",
    message:
      "not a Terraform plan: this JSON has no resource_changes or planned_values (a plan representation from terraform show -json has both).",
  };
}

/** Map a failed `terraform show -json <planfile>` to a message. Returns null when nothing specific matches. */
export function planShowErrorMessage(stderr: string, root: string, file: string): string | null {
  const flat = stderr.replace(/\s+/g, " ");
  if (
    /failed to load plugin schemas/i.test(flat) ||
    /unavailable provider/i.test(flat) ||
    /required plugins are not installed/i.test(flat)
  ) {
    return (
      `could not render the plan here: the providers it was made with are not installed in ${root}. Pass dir as the ` +
      "root that created the plan, or render it there with terraform show -json and pass plan_json."
    );
  }
  if (/failed to read the given file as a state or plan file/i.test(flat)) {
    return `${file} is not a Terraform plan file (terraform could not read it as a plan or state).`;
  }
  return null;
}

// --- Plan JSON shapes (subset) ------------------------------------------------------

type Step = string | number;

interface Change {
  actions?: string[];
  before?: unknown;
  after?: unknown;
  after_unknown?: unknown;
  before_sensitive?: Marker;
  after_sensitive?: Marker;
  replace_paths?: Step[][];
  importing?: Record<string, unknown> | null;
}

export interface ResourceChange {
  address: string;
  module_address?: string;
  mode?: string;
  type?: string;
  name?: string;
  previous_address?: string;
  deposed?: string;
  action_reason?: string;
  change: Change;
}

interface OutputChange {
  actions?: string[];
  after_unknown?: unknown;
  before_sensitive?: unknown;
  after_sensitive?: unknown;
}

export interface PlanDoc {
  format_version?: string;
  terraform_version?: string;
  resource_changes?: ResourceChange[];
  resource_drift?: ResourceChange[];
  output_changes?: Record<string, OutputChange>;
  deferred_changes?: { reason?: string; resource_change?: ResourceChange }[];
  action_invocations?: unknown[];
  applyable?: boolean;
  complete?: boolean;
  errored?: boolean;
}

// --- Rendering ---------------------------------------------------------------------

export interface SummaryOptions {
  maxPerSection: number;
  maxPaths: number;
}

const DELETE_REASONS: Record<string, string> = {
  delete_because_no_resource_config: "not in configuration",
  delete_because_wrong_repetition: "count/for_each added or removed",
  delete_because_count_index: "count index out of range",
  delete_because_each_key: "for_each key no longer present",
  delete_because_no_module: "its module is no longer in configuration",
  delete_because_no_move_target: "moved target not in configuration",
};

const READ_REASONS: Record<string, string> = {
  read_because_config_unknown: "configuration depends on values known after apply",
  read_because_dependency_pending: "depends on a pending change",
  read_because_check_nested: "nested in a check block",
};

const IDENT = /^[A-Za-z_][A-Za-z0-9_-]*$/;

function actionKey(actions: string[] | undefined): string {
  return (actions ?? []).join(",");
}

/** Render an attribute path, truncating at the first node either marker tree marks sensitive. */
function renderPath(steps: Step[], markers: Marker[], redactor: Redactor): string {
  let out = "";
  let ms = markers;
  for (let i = 0; i < steps.length; i++) {
    const step = steps[i]!;
    if (typeof step === "number") out += `[${step}]`;
    else if (redactor.matchesSensitive(step)) out += "[(redacted key)]";
    else if (IDENT.test(step)) out += out ? `.${step}` : step;
    else out += `[${JSON.stringify(step)}]`;
    ms = ms.map((m) => childMarker(m, step));
    if (ms.some((m) => m === true)) return `${out} [sensitive]`;
  }
  return out;
}

const isObj = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);

function deepEqual(a: unknown, b: unknown): boolean {
  if (a === b) return true;
  if (Array.isArray(a) && Array.isArray(b)) return a.length === b.length && a.every((x, i) => deepEqual(x, b[i]));
  if (isObj(a) && isObj(b)) {
    const ka = Object.keys(a);
    const kb = Object.keys(b);
    return ka.length === kb.length && ka.every((k) => Object.hasOwn(b, k) && deepEqual(a[k], b[k]));
  }
  return false;
}

const byCodeUnit = (a: string, b: string) => (a < b ? -1 : a > b ? 1 : 0);

/**
 * Changed leaf paths between `before` and `after`, plus attributes that become
 * unknown (`after_unknown`). Paths under a sensitive marker stop at the marked
 * node; their values are never compared in a way that is printed.
 */
export function changedPaths(change: Change, redactor: Redactor): string[] {
  const out: string[] = [];
  const walk = (before: unknown, after: unknown, unknown: unknown, steps: Step[], mb: Marker, ma: Marker) => {
    if (mb === true || ma === true) {
      if (unknown === true || !deepEqual(before, after))
        out.push(renderPath(steps, [change.before_sensitive, change.after_sensitive], redactor));
      return;
    }
    if (unknown === true) {
      out.push(`${renderPath(steps, [], redactor)} (known after apply)`);
      return;
    }
    if (isObj(before) && isObj(after)) {
      const unknownKeys = isObj(unknown) ? Object.keys(unknown) : [];
      const keys = [...new Set([...Object.keys(before), ...Object.keys(after), ...unknownKeys])].sort(byCodeUnit);
      for (const k of keys) {
        walk(before[k], after[k], childMarker(unknown, k), [...steps, k], childMarker(mb, k), childMarker(ma, k));
      }
      return;
    }
    if (Array.isArray(before) && Array.isArray(after)) {
      if (before.length !== after.length) {
        // A length change shifts every later index (sets especially), so per-index
        // paths would name elements that did not change. Report the list once,
        // with a multiset count. Only counts are printed, never elements.
        const unmatched = [...after];
        let removed = 0;
        for (const x of before) {
          const i = unmatched.findIndex((y) => deepEqual(x, y));
          if (i >= 0) unmatched.splice(i, 1);
          else removed++;
        }
        const parts = [
          unmatched.length ? `${unmatched.length} added` : "",
          removed ? `${removed} removed` : "",
          Array.isArray(unknown) && unknown.some((u) => u === true) ? "some known after apply" : "",
        ].filter(Boolean);
        const at = renderPath(steps, [change.before_sensitive, change.after_sensitive], redactor);
        out.push(`${at} (${parts.join(", ") || "reordered"})`);
        return;
      }
      const n = Math.max(before.length, after.length, Array.isArray(unknown) ? unknown.length : 0);
      for (let i = 0; i < n; i++) {
        walk(before[i], after[i], childMarker(unknown, i), [...steps, i], childMarker(mb, i), childMarker(ma, i));
      }
      return;
    }
    // `after` is absent when the attribute is unknown; treat undefined and null alike.
    if (!deepEqual(before ?? null, after ?? null)) out.push(renderPath(steps, [], redactor));
  };
  walk(change.before, change.after, change.after_unknown, [], change.before_sensitive, change.after_sensitive);
  return out;
}

function limitList(items: string[], max: number): string {
  const shown = items.slice(0, max).join(", ");
  return items.length > max ? `${shown}, ... +${items.length - max} more` : shown;
}

function replaceDetail(rc: ResourceChange, redactor: Redactor, maxPaths: number): string {
  switch (rc.action_reason) {
    case "replace_because_tainted":
      return "tainted";
    case "replace_by_request":
      return "-replace requested";
    case "replace_by_triggers":
      return "replace_triggered_by";
    default: {
      const paths = (rc.change.replace_paths ?? []).map((p) =>
        renderPath(p, [rc.change.before_sensitive, rc.change.after_sensitive], redactor),
      );
      return paths.length ? `forced by: ${limitList([...new Set(paths)], maxPaths)}` : "";
    }
  }
}

function deposedNote(rc: ResourceChange): string {
  return rc.deposed ? ` (deposed object ${rc.deposed})` : "";
}

/** Delete paired with a create of the same type in the same module: a rename that may need a moved block. */
function renamePairs(deletes: ResourceChange[], creates: ResourceChange[]): string[] {
  const used = new Set<ResourceChange>();
  const pairs: string[] = [];
  for (const d of deletes) {
    if (d.deposed || d.mode === "data") continue;
    const c = creates.find(
      (x) =>
        !used.has(x) && x.type === d.type && (x.module_address ?? "") === (d.module_address ?? "") && x.mode === d.mode,
    );
    if (c) {
      used.add(c);
      pairs.push(`${d.address} -> ${c.address}`);
    }
  }
  return pairs;
}

export function summarizePlan(doc: PlanDoc, opts: SummaryOptions): string {
  const redactor = new Redactor(collectSensitiveStrings(doc));
  const sections: Record<string, string[]> = {
    DELETE: [],
    REPLACE: [],
    UPDATE: [],
    CREATE: [],
    READ: [],
    IMPORT: [],
    MOVED: [],
    FORGET: [],
  };
  let unchanged = 0;
  let tfImport = 0;
  let tfAdd = 0;
  let tfChange = 0;
  let tfDestroy = 0;
  const deletes: ResourceChange[] = [];
  const creates: ResourceChange[] = [];
  let destroyDeletes = 0;
  let destroyReplaces = 0;

  for (const rc of doc.resource_changes ?? []) {
    const key = actionKey(rc.change.actions);
    const importing = rc.change.importing != null;
    const moved = rc.previous_address !== undefined && rc.previous_address !== rc.address;
    // Terraform does not render deleted data sources (they are just dropped from state).
    if (key === "delete" && rc.mode === "data") continue;
    if (importing) tfImport++;
    const then = key === "no-op" ? "" : ` (then ${key.replace(",", "-then-")})`;
    if (importing) sections.IMPORT!.push(`  ${rc.address}${then}`);
    if (moved) sections.MOVED!.push(`  ${rc.previous_address} -> ${rc.address}${then}`);
    switch (key) {
      case "delete": {
        const reason = rc.action_reason ? (DELETE_REASONS[rc.action_reason] ?? rc.action_reason) : "";
        sections.DELETE!.push(`  - ${rc.address}${deposedNote(rc)}${reason ? ` (${reason})` : ""}`);
        deletes.push(rc);
        tfDestroy++;
        destroyDeletes++;
        break;
      }
      case "delete,create":
      case "create,delete": {
        const cbd = key === "create,delete";
        const detail = replaceDetail(rc, redactor, opts.maxPaths);
        sections.REPLACE!.push(
          `  ${cbd ? "+/-" : "-/+"} ${rc.address}${deposedNote(rc)} ${cbd ? "create-before-destroy" : "delete-then-create"}${detail ? `; ${detail}` : ""}`,
        );
        tfAdd++;
        tfDestroy++;
        destroyReplaces++;
        break;
      }
      case "update": {
        const paths = changedPaths(rc.change, redactor);
        sections.UPDATE!.push(
          `  ~ ${rc.address}${deposedNote(rc)}${paths.length ? `: ${limitList(paths, opts.maxPaths)}` : ""}`,
        );
        tfChange++;
        break;
      }
      case "create":
        sections.CREATE!.push(`  + ${rc.address}`);
        creates.push(rc);
        tfAdd++;
        break;
      case "read": {
        const reason = rc.action_reason ? (READ_REASONS[rc.action_reason] ?? rc.action_reason) : "";
        sections.READ!.push(`  <= ${rc.address}${reason ? ` (${reason})` : ""}`);
        break;
      }
      case "forget":
        sections.FORGET!.push(`  . ${rc.address}${deposedNote(rc)} (removed from state, object NOT destroyed)`);
        break;
      case "create,forget":
        sections.FORGET!.push(
          `  +. ${rc.address} (new object created; the previous object is removed from state, NOT destroyed)`,
        );
        break;
      case "no-op":
        if (!importing && !moved) unchanged++;
        break;
      default:
        sections.UPDATE!.push(`  ? ${rc.address} (unrecognized actions: ${key})`);
    }
  }

  const flags: string[] = [];
  if (doc.errored) flags.push("ERRORED (planning failed; the changes below are partial)");
  if (doc.applyable !== undefined) flags.push(doc.applyable ? "applyable" : "NOT applyable");
  if (doc.complete !== undefined)
    flags.push(doc.complete ? "complete" : "INCOMPLETE (another plan and apply is needed after this one)");
  const major = String(doc.format_version ?? "").split(".")[0];
  if (doc.format_version !== undefined && major !== "1") {
    flags.push(`[unknown format_version ${doc.format_version}: the summary may be incomplete]`);
  }
  const lines: string[] = [
    `plan (terraform ${doc.terraform_version ?? "?"}, format ${doc.format_version ?? "?"})${flags.length ? `: ${flags.join(", ")}` : ""}`,
  ];

  const n = (k: string) => sections[k]!.length;
  const actions = doc.action_invocations?.length ? `; ${doc.action_invocations.length} actions to invoke` : "";
  lines.push(
    `totals: ${n("DELETE")} delete, ${n("REPLACE")} replace, ${n("UPDATE")} update, ${n("CREATE")} create, ${n("READ")} read, ` +
      `${n("IMPORT")} import, ${n("MOVED")} move, ${n("FORGET")} forget, ${unchanged} unchanged ` +
      `(terraform: ${tfImport ? `${tfImport} to import, ` : ""}${tfAdd} to add, ${tfChange} to change, ${tfDestroy} to destroy${actions})`,
  );

  const pushSection = (title: string, items: string[]) => {
    if (items.length === 0) return;
    lines.push(`${title} (${items.length})`);
    lines.push(...items.slice(0, opts.maxPerSection));
    if (items.length > opts.maxPerSection) lines.push(`  ... ${items.length - opts.maxPerSection} more`);
  };
  for (const k of Object.keys(sections)) pushSection(k, sections[k]!);

  const drift = (doc.resource_drift ?? []).map((rc) => {
    const key = actionKey(rc.change.actions);
    if (key === "delete") return `  ${rc.address}: deleted outside Terraform`;
    if (key === "update") {
      const paths = changedPaths(rc.change, redactor);
      return `  ${rc.address}: changed outside Terraform${paths.length ? `: ${limitList(paths, opts.maxPaths)}` : ""}`;
    }
    return `  ${rc.address}: ${key} outside Terraform`;
  });
  pushSection("DRIFT (detected during refresh)", drift);

  const deferred = (doc.deferred_changes ?? []).map((d) => {
    const rc = d.resource_change;
    return `  ${rc?.address ?? "?"}: ${actionKey(rc?.change?.actions) || "change"} deferred (${d.reason ?? "unknown reason"})`;
  });
  pushSection("DEFERRED", deferred);

  const symbols: Record<string, string> = { create: "+", update: "~", delete: "-" };
  const outputs = Object.entries(doc.output_changes ?? {})
    .filter(([, oc]) => actionKey(oc.actions) !== "no-op")
    .sort(([a], [b]) => byCodeUnit(a, b))
    .map(([name, oc]) => {
      const key = actionKey(oc.actions);
      const sens = oc.before_sensitive === true || oc.after_sensitive === true ? " [sensitive]" : "";
      const unknown = oc.after_unknown === true ? " (known after apply)" : "";
      return `  ${symbols[key] ?? key} ${name}${sens}${unknown}`;
    });
  pushSection("OUTPUTS", outputs);

  if (lines.length === 2) lines.push("no changes");

  const destroyed = destroyDeletes + destroyReplaces;
  if (destroyed > 0) {
    const movedCount = n("MOVED");
    let warn = `WARNING: ${destroyed} object(s) will be destroyed (${destroyDeletes} delete, ${destroyReplaces} replace).`;
    warn +=
      movedCount > 0 ? ` ${movedCount} moved block(s) applied; none covers these.` : " No moved blocks in this plan.";
    lines.push(warn);
    const pairs = renamePairs(deletes, creates);
    if (pairs.length) lines.push(`Possible renames needing a moved block: ${pairs.join(", ")}`);
  }
  return lines.join("\n");
}
