import { childMarker, collectSensitiveStrings, escapeUnsafeChars, type Marker, Redactor } from "./redact.js";

/**
 * tf_summarize_plan (design-capabilities.md section 7.1). Pure: input detection
 * and rendering of a JSON plan representation (`terraform show -json <plan>`, or
 * HCP's `/plans/:id/json-output`, which is the same format).
 *
 * The summary prints NO values: only addresses, actions, reasons and attribute
 * paths. Paths that pass through a node Terraform marks sensitive are truncated
 * at it (`keepers [sensitive]`), and import IDs are never printed (for
 * random_password / random_string / random_id the import ID IS the secret).
 *
 * Plan JSON is unverified caller input: this module checks its shape, not that
 * Terraform produced it. Every string taken from it is escaped before printing.
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

/** Appended to a summary of plan JSON, which nothing ties to a real Terraform run. */
export const UNVERIFIED_PLAN_NOTE =
  "note: summarized from caller-supplied plan JSON, which is not verified against Terraform, the state or the " +
  "configuration. For a result Terraform rendered itself, pass the binary plan from terraform plan -out as plan_file.";

const refuse = (detail: string): PlanInput => ({
  kind: "refuse",
  message: `not a usable Terraform plan: ${detail} Pass a saved plan file (terraform plan -out) or its unmodified terraform show -json output.`,
});

const isStepList = (v: unknown): boolean =>
  Array.isArray(v) &&
  v.every((p) => Array.isArray(p) && p.every((s) => typeof s === "string" || typeof s === "number"));

/** Why one resource change entry is malformed, or null when it can be rendered faithfully. */
function resourceChangeProblem(v: unknown): string | null {
  if (!isObj(v)) return "is not an object";
  if (typeof v.address !== "string" || v.address === "") return "has no address";
  if (!isObj(v.change)) return "has no change object";
  const { actions, replace_paths: paths } = v.change;
  if (!Array.isArray(actions) || actions.length === 0 || !actions.every((a) => typeof a === "string"))
    return "has no valid change.actions list";
  if (paths !== undefined && !isStepList(paths)) return "has invalid change.replace_paths";
  return null;
}

/** True when a `{ resources, child_modules }` tree holds at least one resource. */
function moduleHasResources(m: unknown): boolean {
  if (!isObj(m)) return false;
  if (Array.isArray(m.resources) && m.resources.length > 0) return true;
  return Array.isArray(m.child_modules) && m.child_modules.some(moduleHasResources);
}

/**
 * Terraform omits resource_changes when no resource instance exists before or after
 * the plan: no resources at all, `count = 0`, an empty `for_each`. Such a document
 * is accepted only when the rest of it agrees: a configuration, planned values with
 * no resources, and no prior state or drift naming any. Everything else without the
 * list could be a real plan with its changes removed.
 */
function isConsistentEmptyPlan(o: Record<string, unknown>): boolean {
  if (!isObj(o.configuration) || !isObj(o.planned_values)) return false;
  if (moduleHasResources(o.planned_values.root_module)) return false;
  if (isObj(o.prior_state) && isObj(o.prior_state.values) && moduleHasResources(o.prior_state.values.root_module))
    return false;
  return !(Array.isArray(o.resource_drift) && o.resource_drift.length > 0);
}

/**
 * Refuse a document that cannot be summarized truthfully: a report of "no changes"
 * must come from a real, empty change list or a document that is consistently empty
 * (`isConsistentEmptyPlan`). `renderedByTerraform` is for output of our own
 * `terraform show -json`, where a newer format version is only flagged and a missing
 * resource_changes is taken as Terraform's own statement.
 */
function validatePlanDoc(o: Record<string, unknown>, renderedByTerraform: boolean): PlanInput {
  if (!renderedByTerraform) {
    const v = o.format_version;
    if (typeof v !== "string") return refuse("it has no format_version.");
    if (!/^1(\.\d+)*$/.test(v)) {
      return refuse(
        `format_version ${escapeUnsafeChars(JSON.stringify(v).slice(0, 40))} is not a supported 1.x version.`,
      );
    }
    if (!("resource_changes" in o) && !isConsistentEmptyPlan(o)) {
      return refuse(
        "it has no resource_changes, and it is not a consistently empty plan (Terraform omits the list only when " +
          "no resource instance exists, and then still writes configuration and planned_values with no resources).",
      );
    }
  }
  for (const key of ["resource_changes", "resource_drift"]) {
    const list = o[key];
    if (list === undefined) continue;
    if (!Array.isArray(list)) return refuse(`${key} is not an array.`);
    for (const [i, rc] of list.entries()) {
      const problem = resourceChangeProblem(rc);
      if (problem) return refuse(`${key}[${i}] ${problem}.`);
    }
  }
  if (o.output_changes !== undefined) {
    if (!isObj(o.output_changes)) return refuse("output_changes is not an object.");
    for (const oc of Object.values(o.output_changes)) {
      if (!isObj(oc) || !Array.isArray(oc.actions)) return refuse("output_changes has an entry without actions.");
    }
  }
  if (o.deferred_changes !== undefined) {
    if (!Array.isArray(o.deferred_changes)) return refuse("deferred_changes is not an array.");
    for (const [i, d] of o.deferred_changes.entries()) {
      if (!isObj(d)) return refuse(`deferred_changes[${i}] is not an object.`);
      if (d.resource_change !== undefined) {
        const problem = resourceChangeProblem(d.resource_change);
        if (problem) return refuse(`deferred_changes[${i}].resource_change ${problem}.`);
      }
    }
  }
  if (o.action_invocations !== undefined && !Array.isArray(o.action_invocations)) {
    return refuse("action_invocations is not an array.");
  }
  // `resource_changes: []` says what an absent list says, so it needs the same
  // corroboration the absent key gets above. A forger who writes [] instead of deleting
  // the key used to skip that check (it only runs when the key is MISSING) and get a
  // clean "no changes" while planned_values still named the resource it deleted. Checked
  // last so a structurally broken document still reports its own first problem.
  if (
    !renderedByTerraform &&
    Array.isArray(o.resource_changes) &&
    o.resource_changes.length === 0 &&
    !isConsistentEmptyPlan(o)
  ) {
    return refuse(
      "it has an empty resource_changes list while planned_values, prior_state or resource_drift still names a " +
        "resource, which Terraform never produces (it drops the whole list only when the plan is genuinely " +
        "empty).",
    );
  }
  return { kind: "plan", doc: o as PlanDoc };
}

/** Classify JSON text that claims to be a plan. */
export function detectPlanJson(text: string, opts: { renderedByTerraform?: boolean } = {}): PlanInput {
  const trimmed = text.replace(/^﻿/, "").trim();
  let doc: unknown;
  try {
    doc = JSON.parse(trimmed);
  } catch {
    const first = trimmed.split(/\r?\n/, 1)[0] ?? "";
    try {
      const line = JSON.parse(first) as Record<string, unknown>;
      if (line && typeof line === "object" && "@level" in line) return { kind: "refuse", message: UI_STREAM_MESSAGE };
    } catch {
      // not JSON lines either
    }
    return {
      kind: "refuse",
      // No parser detail: it quotes the input, which may be any file the caller named.
      message:
        "not a Terraform plan: the input is not JSON. Pass a saved plan file (terraform plan -out) or its terraform show -json output.",
    };
  }
  if (!doc || typeof doc !== "object" || Array.isArray(doc)) {
    return { kind: "refuse", message: "not a Terraform plan: expected a JSON object." };
  }
  const o = doc as Record<string, unknown>;
  if ("@level" in o) return { kind: "refuse", message: UI_STREAM_MESSAGE };
  if ("remote_plan_format" in o && "run_id" in o) {
    const run = typeof o.run_id === "string" && /^run-[A-Za-z0-9]+$/.test(o.run_id) ? ` for run ${o.run_id}` : "";
    return {
      kind: "refuse",
      message:
        `this is an HCP Terraform saved-plan bookmark${run}; get its plan id with the official ` +
        "terraform MCP server's get_run_details, fetch get_plan_json_output(plan_id), and pass that as plan_json " +
        "(both need the official server's terraform toolset and TFE_TOKEN).",
    };
  }
  if ("resource_changes" in o || "planned_values" in o) return validatePlanDoc(o, opts.renderedByTerraform === true);
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
  /** Set by the tool when the JSON came from the caller rather than from our own
   *  `terraform show -json`. Unlike the JSON's strings, its ACTIONS are trusted
   *  implicitly: the counts and the destroy WARNING read `resource_changes` only,
   *  so a forger could park the deletion elsewhere (deferred_changes, or `mode:
   *  "data"` on a managed address, which the renderer prints as "nothing is
   *  destroyed"). With this set the summary says what it did not count. */
  unverified?: boolean;
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

/** A data source address (`data.x.y`, also inside modules). */
const DATA_ADDRESS = /^(?:module\.[^.[]+(?:\[[^\]]*\])?\.)*data\./;

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
    else if (redactor.hidesKey(step)) out += "[(redacted key)]";
    else if (IDENT.test(step)) out += out ? `.${step}` : step;
    else out += `[${escapeUnsafeChars(JSON.stringify(step))}]`;
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
  return rc.deposed ? ` (deposed object ${escapeUnsafeChars(String(rc.deposed))})` : "";
}

/** Delete paired with a create of the same type in the same module: a rename that may need a moved block. */
function renamePairs(deletes: ResourceChange[], creates: ResourceChange[], redactor: Redactor): string[] {
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
      pairs.push(`${redactor.address(d.address)} -> ${redactor.address(c.address)}`);
    }
  }
  return pairs;
}

export function summarizePlan(doc: PlanDoc, opts: SummaryOptions): string {
  const redactor = new Redactor(collectSensitiveStrings(doc));
  const addr = (a: string) => redactor.address(a);
  const txt = (v: unknown) => escapeUnsafeChars(String(v));
  const sections: Record<string, string[]> = {
    DELETE: [],
    REPLACE: [],
    UPDATE: [],
    CREATE: [],
    READ: [],
    IMPORT: [],
    MOVED: [],
    FORGET: [],
    "DATA SOURCE REMOVED": [],
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
    const address = addr(rc.address);
    // A data source is only dropped from state, and Terraform does not count it. It is still listed, and the
    // address must agree with the mode: `mode: "data"` on a managed address is an ordinary delete below.
    if (key === "delete" && rc.mode === "data" && DATA_ADDRESS.test(rc.address)) {
      sections["DATA SOURCE REMOVED"]!.push(`  - ${address} (dropped from state, nothing is destroyed)`);
      continue;
    }
    if (importing) tfImport++;
    const then = key === "no-op" ? "" : ` (then ${txt(key.replace(",", "-then-"))})`;
    if (importing) sections.IMPORT!.push(`  ${address}${then}`);
    if (moved) sections.MOVED!.push(`  ${addr(String(rc.previous_address))} -> ${address}${then}`);
    switch (key) {
      case "delete": {
        const reason = rc.action_reason ? (DELETE_REASONS[rc.action_reason] ?? txt(rc.action_reason)) : "";
        sections.DELETE!.push(`  - ${address}${deposedNote(rc)}${reason ? ` (${reason})` : ""}`);
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
          `  ${cbd ? "+/-" : "-/+"} ${address}${deposedNote(rc)} ${cbd ? "create-before-destroy" : "delete-then-create"}${detail ? `; ${detail}` : ""}`,
        );
        tfAdd++;
        tfDestroy++;
        destroyReplaces++;
        break;
      }
      case "update": {
        const paths = changedPaths(rc.change, redactor);
        sections.UPDATE!.push(
          `  ~ ${address}${deposedNote(rc)}${paths.length ? `: ${limitList(paths, opts.maxPaths)}` : ""}`,
        );
        tfChange++;
        break;
      }
      case "create":
        sections.CREATE!.push(`  + ${address}`);
        creates.push(rc);
        tfAdd++;
        break;
      case "read": {
        const reason = rc.action_reason ? (READ_REASONS[rc.action_reason] ?? txt(rc.action_reason)) : "";
        sections.READ!.push(`  <= ${address}${reason ? ` (${reason})` : ""}`);
        break;
      }
      case "forget":
        sections.FORGET!.push(`  . ${address}${deposedNote(rc)} (removed from state, object NOT destroyed)`);
        break;
      case "create,forget":
        sections.FORGET!.push(
          `  +. ${address} (new object created; the previous object is removed from state, NOT destroyed)`,
        );
        break;
      case "no-op":
        if (!importing && !moved) unchanged++;
        break;
      default:
        sections.UPDATE!.push(`  ? ${address} (unrecognized actions: ${txt(key)})`);
    }
  }

  const flags: string[] = [];
  if (doc.errored) flags.push("ERRORED (planning failed; the changes below are partial)");
  if (doc.applyable !== undefined) flags.push(doc.applyable ? "applyable" : "NOT applyable");
  if (doc.complete !== undefined)
    flags.push(doc.complete ? "complete" : "INCOMPLETE (another plan and apply is needed after this one)");
  const major = String(doc.format_version ?? "").split(".")[0];
  if (doc.format_version !== undefined && major !== "1") {
    flags.push(`[unknown format_version ${txt(doc.format_version)}: the summary may be incomplete]`);
  }
  const lines: string[] = [
    `plan (terraform ${txt(doc.terraform_version ?? "?")}, format ${txt(doc.format_version ?? "?")})${flags.length ? `: ${flags.join(", ")}` : ""}`,
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
  for (const k of Object.keys(sections)) {
    pushSection(k, sections[k]!);
    // Caller-supplied JSON can set mode and address together, so "it was only a data
    // source" is the forger's claim, not the document's. Say where the classification
    // came from instead of letting it look like a verdict. Emitted outside the section
    // so it does not inflate the entry count.
    if (k === "DATA SOURCE REMOVED" && sections[k]!.length > 0 && opts.unverified) {
      lines.push(
        "  (caller-supplied JSON: mode and address are both the caller's, so a managed deletion can be " +
          "presented this way -- check against a plan Terraform rendered)",
      );
    }
  }

  const drift = (doc.resource_drift ?? []).map((rc) => {
    const key = actionKey(rc.change.actions);
    const address = addr(rc.address);
    if (key === "delete") return `  ${address}: deleted outside Terraform`;
    if (key === "update") {
      const paths = changedPaths(rc.change, redactor);
      return `  ${address}: changed outside Terraform${paths.length ? `: ${limitList(paths, opts.maxPaths)}` : ""}`;
    }
    return `  ${address}: ${txt(key)} outside Terraform`;
  });
  pushSection("DRIFT (detected during refresh)", drift);

  const deferredDocs = doc.deferred_changes ?? [];
  const deferred = deferredDocs.map((d) => {
    const rc = d.resource_change;
    return `  ${rc ? addr(rc.address) : "?"}: ${txt(actionKey(rc?.change?.actions) || "change")} deferred (${txt(d.reason ?? "unknown reason")})`;
  });
  pushSection("DEFERRED", deferred);
  // Deferred changes are not in resource_changes, so they are in no count below and in
  // no WARNING either -- Terraform defers what it cannot plan yet, and a forger can put
  // the deletion it wants hidden right here. The deferred line names the action; make
  // the SUMMARY line name it too when the JSON is the caller's.
  const deferredDeletes = deferredDocs.filter((d) =>
    (d.resource_change ? actionKey(d.resource_change.change.actions) : "").includes("delete"),
  ).length;
  if (opts.unverified && deferredDeletes > 0) {
    lines.push(
      `WARNING: ${deferredDeletes} deferred change(s) in caller-supplied JSON contain a delete, and DEFERRED entries ` +
        "are not part of the totals or the destroy count above.",
    );
  }

  const symbols: Record<string, string> = { create: "+", update: "~", delete: "-" };
  const outputs = Object.entries(doc.output_changes ?? {})
    .filter(([, oc]) => actionKey(oc.actions) !== "no-op")
    .sort(([a], [b]) => byCodeUnit(a, b))
    .map(([name, oc]) => {
      const key = actionKey(oc.actions);
      const sens = oc.before_sensitive === true || oc.after_sensitive === true ? " [sensitive]" : "";
      const unknown = oc.after_unknown === true ? " (known after apply)" : "";
      return `  ${symbols[key] ?? txt(key)} ${addr(name)}${sens}${unknown}`;
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
    const pairs = renamePairs(deletes, creates, redactor);
    if (pairs.length) lines.push(`Possible renames needing a moved block: ${pairs.join(", ")}`);
  }
  return lines.join("\n");
}
