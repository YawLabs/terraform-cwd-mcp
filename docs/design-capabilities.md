# Design: plan, module, state and upgrade tools

Status: implemented 2026-10-15 (design verified against real Terraform output on 2026-10-14). Deviations from
the original text are listed in section 11 and marked inline where they change a rule.
Scope: four new tool groups for terraform-cwd-mcp -- `tf_summarize_plan`, `tf_module_interface`,
`tf_state_addresses` + `tf_show_resource`, `tf_upgrade_impact`.

## 0. Positioning (unchanged)

This server answers "what is actually true in THIS working directory": pinned schemas, the saved plan, the
current state, the local and installed modules. HashiCorp's `hashicorp/terraform-mcp-server` answers registry and
HCP questions: usage docs, latest versions, public modules, HCP/TFE runs. The new tools follow the same split:

| Question | Authority |
|---|---|
| Is argument X valid for the version I have pinned? Which args break on upgrade to vN? | this server |
| What does this plan / state / local module actually contain? | this server |
| What is the latest version? What do the docs say? Which public module should I use? | official server |
| An HCP run's plan | official server fetches it (`get_plan_json_output`); this server summarizes it (`plan_json`) |

Tool descriptions and `INSTRUCTIONS` say this in one line each, so an agent with both servers routes correctly.

## 1. Evidence: what was run

Everything below was generated with Terraform v1.15.7 windows_amd64 (scoop) in temp dirs under the session
scratchpad, with `TF_PLUGIN_CACHE_DIR` set. Providers: hashicorp/random 2.3.1 / 3.6.3, tls 2.2.0 / 3.4.0 / 4.0.6,
null 2.1.2 / 3.2.3, local 1.4.0 / 2.5.2, terraform_data (builtin); registry module cloudposse/label/null 0.25.0.

1. A root module with a local module (`modules/naming`), the registry module, a sensitive variable and outputs,
   local backend. `init` + `apply`, then a v2 config producing a plan with: delete, 5 replaces (one
   `create_before_destroy`), in-place update touching a sensitive nested attribute, create, `import` block,
   `moved` block, `removed { lifecycle { destroy = false } }`, drift (a managed file deleted on disk), a sensitive
   output update and a new output. Saved as a binary plan and rendered with `terraform show -json`.
2. The v2 plan applied, then count, for_each, a data source and `terraform_data` with secret-named but unmarked
   inputs added; state rendered with `terraform show -json`.
3. State-access behaviour: concurrent lock, no state, not initialized, providers missing, s3 backend not
   initialized, s3 backend initialized but credentials missing, a non-existent workspace (against a local fake
   S3 endpoint that logged every request).
4. Schema dumps of every provider version above, diffed pairwise with a scratch differ.
5. The upgrade_impact temp-dir flow end to end, including an offline (`HTTPS_PROXY=127.0.0.1:9`) validate.
6. Candidate HCL parsers installed in a scratch dir and run against tricky HCL and the real modules, then
   cross-checked against Terraform's own evaluation (the plan JSON `configuration` section).
7. Throwaway prototypes of every renderer below, run against the fixtures, produced the example outputs in
   section 7 (verbatim except where noted).

Committed fixtures: `src/tests/fixtures/` (inventory in section 9 and `fixtures/README.md`).

## 2. Findings that shaped the design

Each of these was observed, not assumed. File/line references are to Terraform v1.15.7 source.

F1. **Plan and state JSON carry raw secrets.** `terraform show -json` puts sensitive values in clear text: plan
`variables.db_password.value`, `configuration...variables.db_password.default`, `prior_state`, every
`before`/`after`, `output_changes.pw.before`; state `values.outputs.pw.value`, `random_password.result`,
`tls_private_key.private_key_pem`. Only the `*_sensitive` / `sensitive_values` marker trees say what to hide.

F2. **Markers miss real secrets.** `terraform_data.cfg` with `input = { pw = var.db_password }`: state marks
`input.pw` sensitive but `output.pw` (same value) has an empty marker (`"output": {}`). `terraform_data` with
`input = { api_token = "...", db_password = "..." }` from literals has no markers at all. Marker-only redaction
leaks both. This is why redaction is three-layered (section 5).

F3. **Import IDs can be the secret.** For `random_password`/`random_string`/`random_id` the import ID *is* the
value (`importing.id = "p-9hUg"` equals `random_id.imp.b64_url`). The plan summary never prints import IDs.

F4. **`state list`, `state show`, `state pull` and `show` never call `Lock`.** `internal/command/state_list.go:49-59`,
`show.go:400-411`, `state_show.go:106-116`, `state_pull.go:69-80` all do `b.StateMgr(ws)` then
`RefreshState()` (re-read from storage, not a provider refresh). Confirmed empirically: while another
`terraform apply` held the lock, `plan -lock-timeout=0s` failed with "Error acquiring the state lock".

F5. **On Windows the local backend's lock blocks readers.** In that same test, `state list`, `show -json` and
`state show` all failed: "The process cannot access the file because another process has locked a portion of the
file." (`LockFileEx` byte-range lock on `terraform.tfstate`). Not a write and not a lock we take, but it is an
error users will hit; it gets its own message.

F6. **Reading a non-existent workspace WRITES.** `s3` backend `StateMgr()` (`internal/backend/remote-state/s3/
backend_state.go`) locks and `PutObject`s an empty state when the workspace is missing. Reproduced:
`TF_WORKSPACE=ghost terraform state list` against a fake S3 endpoint logged `GET ?list-type=2`, two `HEAD
env:/ghost/...`, then `PUT env:/ghost/a/terraform.tfstate`. `default` is always listed (`wss :=
[]string{backend.DefaultStateName}`), so only a non-default workspace is at risk. `terraform workspace list` only
calls `Workspaces()` (a list) and is safe. Guard in section 4.

F7. **No-state is not uniform.** `terraform state list` with no state: exit 1, "No state file was found!".
`terraform show -json` with no state: exit 0, stdout `{"format_version":"1.0"}` (no `values`).

F8. **Once a lock file exists, every state command needs the providers installed** -- including `state list`
and `state pull` ("Required plugins are not installed"). `show -json` also needs every module installed ("Module
not installed"). So state tools share the existing "initialized root" precondition.

F9. **Backend errors are terse and backend-specific.** Real texts: "Backend initialization required, please run
\"terraform init\"" (backend block never initialized, e.g. after `init -backend=false`), and "No valid credential
sources found" (s3, credentials gone after a successful init). `.terraform/terraform.tfstate` records
`backend.type` (also `config` and `hash`; `config` can hold secrets passed via `-backend-config` -- only `type` is
ever read).

F10. **A binary plan renders only in an initialized root with the same providers.** From another dir: "Failed to
load plugin schemas ... unavailable provider". A non-plan file: "Failed to read the given file as a state or plan
file". `show -json` also accepts a *state* file path, and an HCP saved-plan bookmark (`remote_plan_format`,
`run_id`, `hostname` -- `internal/cloud/cloudplan/saved_plan.go`) would make `show` call HCP. Both are detected
before spawning (section 7.1).

F11. **The plan JSON `configuration` section cannot replace an HCL parser.** For variables it carries
`default`, `description`, `sensitive` -- but no `type`, no `nullable`, no validation blocks, no `ephemeral`; it
also requires a plan (backend + refresh). It is, however, a perfect test oracle for defaults/descriptions.

F12. **`terraform validate` evaluates `file()` on literal paths** ("Invalid value for "path" parameter: no file
exists at "./banner.txt""), so a temp copy must include non-`.tf` files. It does NOT check provider version
constraints against the lock file (a module constraint `< 4.0` with 4.0.6 locked validated fine), and it writes
nothing (mtime/size snapshot of the whole root identical before/after).

F13. **Every terraform command phones home** unless `CHECKPOINT_DISABLE` is set (`main.go:251` `go
runCheckpoint(...)`; `terraform version -json` returned `"terraform_outdated": true`). The existing runner does
not set it, which quietly contradicts `openWorldHint: false` on the four existing tools. Fix: add
`CHECKPOINT_DISABLE=1` to the shared spawn env (one line, ships with this work).

F14. **Implied local mirrors are not a usable shortcut.** A `terraform.d/plugins/.../hashicorp/random` junction to
the user's installed provider was ignored by `init` (it tried the registry and failed offline). Rejected.
Junctioning installed provider *packages* straight into a temp `.terraform/providers/` and skipping `init` works
(section 6).

F15. **The HCP plan JSON is the same format.** The official server's `get_plan_json_output` returns go-tfe
`Plans.ReadJSONOutput` = `/plans/:id/json-output`, the same JSON plan representation as `terraform show -json`
(format_version 1.2 today). It reaches the agent as text, hence the `plan_json` input.

## 3. Decision (a): HCL parsing

Needed by `tf_module_interface` (variables, outputs, module calls with exact type expressions, defaults,
heredoc descriptions) and `tf_upgrade_impact` (which arguments and nested blocks each resource/data block sets,
including `dynamic` blocks, which `provider` it uses, `required_providers` constraints, and attribute reads like
`random_id.i.b64`).

### Options evaluated

| Option | Maintenance (checked 2026-10-14) | Correctness on our cases | Verdict |
|---|---|---|---|
| `@cdktf/hcl2json` 0.21.0 (Go `hcl2json` compiled to WASM, MPL-2.0) | **Frozen**: `hashicorp/terraform-cdk` archived (last push 2025-12-10); npm last publish 2025-06-04 | Values exact (uses HashiCorp's own parser): heredoc `"line1\n  line2\n"`. But every expression becomes a `"${...}"` string, indistinguishable from a literal `$${...}` (printed `"$${x}"`); attributes and blocks are both arrays-of-objects in some cases (`x = [{...}]` vs `x {}`), no line numbers, type expressions keep raw comments (`"${map(object({\n ... # comment with } brace\n}))}"`). 1.8 MB gzipped WASM, ~130-200 ms Go runtime start per parse. | Rejected: archived, lossy structure |
| `hcl2-parser`, `@evops/hcl-terraform-parser`, `hcl2-json-parser`, `js-hcl-parser`, `hcl-parser` | Last publishes 2022-2023, single maintainers, 1.5-6 MB GopherJS/WASM blobs | Not evaluated further | Rejected: unmaintained |
| `tree-sitter-hcl` grammar (`@tree-sitter-grammars/tree-sitter-hcl`, Apache-2.0) via `web-tree-sitter` (MIT, zero deps) | Grammar repo active (pushed 2026-09-17); `web-tree-sitter` 0.27.1 published 2026-10-08. npm grammar package last published 2025-06 (1.2.0) | Full CST with exact node kinds (`attribute` vs `block`, `function_call`, `heredoc_template`, `comment`), byte ranges and line numbers. Parsed with `hasError=false`: provider-defined functions (`provider::terraform::encode_tfvars`), `for` expressions with `...`, splats, ternaries, `%{ if }` directives, heredocs, unicode escapes, `check`/`validation` blocks, `ephemeral = true`, and every file of the real cloudposse module. 21-78 ms per file incl. init. Grammar WASM 92 KB, runtime WASM 205 KB. Tested with `web-tree-sitter` 0.25.10 and 0.27.1. | **Chosen** |
| terraform-native: plan JSON `configuration` | n/a | Missing `type`, `nullable`, validations, `ephemeral`; needs a plan (F11) | Test oracle only |
| terraform-native: `terraform-config-inspect` | Active (pushed 2026-09-28) but a Go binary, not installed, not on npm | Would need shipping per-platform binaries | Rejected |
| Hand-written parser | n/a | Heredocs, nested templates with braces in strings, comments containing `}`, `%{}` directives: a long tail of bugs | Rejected |

### Quirks found in tree-sitter-hcl (and how the design handles them)

- **Heredoc text is trimmed.** For `<<-EOT\n    line1\n      line2\n    EOT` the `template_literal` child is
  `"line1\n      line2"` (first-line indent and trailing newline lost). HCL's value is `"line1\n  line2\n"`.
  So heredoc values are computed from the `heredoc_template` node's raw source span: drop the opener line and the
  closing-marker line, for `<<-` strip the minimum leading whitespace of non-blank lines, keep a `\n` after every
  line, un-escape `$${` / `%%{`. If the body contains a live `${`/`%{` it is an expression, not a literal.
- **Whitespace around interpolations is dropped** (`"pre ${var.x} post"` yields literals `"pre"`, `"post"`). Never
  reconstruct templates from children: a quoted string with any `template_interpolation`/`template_directive` is
  reported as its raw source text, marked as an expression.
- **Quoted-string escapes are not processed** (`template_literal` is the source text verbatim, e.g. `a\"b $${x}` keeps its backslash). The evaluator
  un-escapes `\n \r \t \" \\ \uNNNN \UNNNNNNNN`, `$${` -> `${`, `%%{` -> `%{`.
- **Negative numbers are an `operation/unary_operation`**, handled explicitly.
- **Type expressions must be rendered from the CST**, not by collapsing the source text. The naive collapse of
  `map(object({\n value = string\n optional = optional(bool, false)\n}))` produced
  `map(object({value = string optional = optional(bool, false)}))` -- the newline separator vanished. Render
  recursively: `function_call` -> `name(arg, arg)`, `object` -> `{k = T, k = T}`, `tuple` -> `[T, T]`,
  `variable_expr` -> identifier, comments skipped, so the example renders
  `map(object({value = string, optional = optional(bool, false)}))`. `optional(T, default)`'s default is rendered
  by the literal evaluator, or its normalized source text when it is an expression.

### Verification: oracle test against Terraform's own evaluation

A scratch reader built on these rules was compared with the plan JSON `configuration` section (Terraform's
evaluation of the same files) for the root, the local module and the CRLF registry module: 49 variables and
outputs, comparing has-default (absent vs explicit `null`), canonical default value, exact description
(including `\r\n` inside heredocs from the git-on-Windows checkout) and `sensitive`. Result: **0 mismatches**.
This becomes a permanent unit test (section 8).

### Packaging

- Dependency: `web-tree-sitter` pinned exactly (MIT, no transitive deps). Do NOT depend on the grammar's npm
  package: it ships native sources, `binding.gyp` and an install script (`node-gyp-build`) we do not need.
- Vendor `tree-sitter-hcl.wasm` at `vendor/tree-sitter-hcl/tree-sitter-hcl.wasm` with its `LICENSE` (Apache-2.0)
  and a `SOURCE.md` naming the upstream commit and the sha256 (from npm 1.2.0:
  `86bb80cd151bd3ab1e44ed431a9c1874978db31519c62055efb50f028a1d0118`). Add `vendor/` to package.json `files`.
  Load by `new URL("../vendor/...", import.meta.url)`; the parser is created lazily once per process.
- On `tree.rootNode.hasError`: still report what parsed, plus a line `parse error: <file>:<line>` per error
  node (first 5), and tell the agent `terraform validate` is the authority. Never guess.

### File set and merge rules (what Terraform loads)

- Only the module directory's top level (no recursion), `*.tf` and `*.tf.json`, sorted by name, skipping
  editor/hidden files (`.*`, `#*#`, `~` suffix) as Terraform's config loader does.
- `override.tf`, `*_override.tf` (and `.tf.json` forms) are applied after primaries with Terraform's merge
  semantics for `variable`/`output`/`module`: attribute-wise replacement of the same-named block.
- `.tf.json`: parse with `JSON.parse`; `variable.<name>.type` is a string holding a type expression (rendered
  as-is); `default` is a JSON value. For usage collection, whether a JSON key is an attribute or a block is decided
  by the pinned schema.

## 4. Decision (b): state access that never locks or refreshes

Commands, all with `-no-color`, args arrays, `shell: false`, `cwd` = resolved root,
`env + { TF_IN_AUTOMATION=1, TF_INPUT=0, CHECKPOINT_DISABLE=1 }`:

| Tool | Command | Why this one |
|---|---|---|
| `tf_state_addresses` | `terraform state list [-id=<id>]` | Cheapest, newline-separated addresses incl. data sources and module paths; no schema rendering |
| `tf_show_resource` | `terraform show -json` | Stable public JSON (format_version 1.0) with `sensitive_values` per resource; `state show` is human-formatted and masks only marked values; `state pull` is the internal v4 format (not a compatibility contract) |

None of them calls `Lock` (F4). None refreshes: `RefreshState` re-reads the stored snapshot; no provider
`ReadResource` happens (that is `plan`/`apply -refresh-only`, never run). `-lock=false` is not needed and not
accepted by these subcommands.

Before every state command:

1. `assertLocalPath`, `assertInitialized` (existing).
2. **Workspace guard (F6).** Selected workspace = `TF_WORKSPACE` env, else trimmed contents of
   `.terraform/environment`, else `default`. If not `default`: run `terraform workspace list -no-color`, parse
   names (strip the `* ` marker). If absent, refuse without running the state command:
   `workspace 'ghost' (from TF_WORKSPACE) does not exist in the backend. Reading it would make Terraform create
   it (it writes an empty state), so this server will not. Select an existing workspace: <list>.`
3. Backend type for messages: `.terraform/terraform.tfstate` `backend.type` if present, else `local` (read the
   file, take only that field, never echo `config`).

Error mapping (stderr matched case-insensitively, first match wins, original Terraform text appended after
`terraform said:` and capped at 2 KiB):

| stderr contains | Message |
|---|---|
| `No state file was found` / `show -json` stdout without `values` | not an error: normal text `No state in workspace '<ws>' (backend <type>): nothing has been applied yet.` |
| `another process has locked a portion of the file` | `The state file is locked by another Terraform process (an apply or plan is running). On Windows the local backend's lock blocks readers too. Retry when it finishes.` |
| `Backend initialization required` | `The <type> backend is configured but not initialized here (e.g. after init -backend=false). Run terraform init in <root>; this server never does.` |
| `No valid credential sources`, `could not find default credentials`, `Required token could not be found`, `401`, `403`, `AccessDenied`, `ExpiredToken` | `Could not read state from the <type> backend: credentials are missing or expired. The server inherits credentials from the environment its MCP client started it with; export them there (or set a profile) and restart the client.` |
| `Required plugins are not installed`, `Module not installed` | `<root> is only partly initialized (providers or modules missing). Run terraform init there.` |
| anything else | `terraform <cmd> failed (exit N) reading the <type> backend:` + Terraform's text |

Timeout: `TERRAFORM_CWD_MCP_TIMEOUT_MS` (default 300 s) applies; a remote backend that hangs is killed with
`terraform <cmd> did not finish within N ms (backend <type>); the backend may be unreachable.`

Caching: none. State changes outside the server; a stale answer is worse than a slow one. `show -json` reads the
whole state per call; documented cost for very large states.

## 5. Decision (c): redaction algorithm

Applies to every value this server prints from plan or state. Plan summaries print no values at all (only
attribute paths), so layers 2-4 matter for `tf_show_resource`; layer 1 also governs which *paths* the plan
summary may print.

**Layer 1 -- Terraform's markers (authoritative).** Walk `values` in parallel with `sensitive_values`
(state) or `before_sensitive`/`after_sensitive` (plan). A marker `true` at any node replaces that node,
whole subtree included, with `(sensitive)` and stops descent (so map keys under a sensitive map are not printed
either). Paths that pass through a marked node are truncated at it: `replace_paths [["keepers","x"]]` under a
sensitive `keepers` prints `keepers [sensitive]`.

**Layer 2 -- value matching (catches F2's `output.pw`).** Before rendering, collect every string >= 4 chars
under any marker anywhere in the document (all resources in all modules, plus outputs with `sensitive: true`).
A printed string that equals one of them, or contains one of length >= 8, becomes
`(redacted: contains a sensitive value)`. Scope is the whole document so a secret copied into another resource's
unmarked attribute is caught too.

**Layer 3 -- key-name heuristic (catches F2's literal tokens).** A string value whose own key or any ancestor
key is secret-like becomes `(redacted: secret-like name)`. Keys are tokenized (`_`, `-`, `.`, camelCase). Secret
if a token is one of `password passwd pwd pass passphrase secret secrets token tokens apikey privatekey
credential credentials creds auth authorization bearer cookie session sas signature kubeconfig pfx p12 otp pin
salt connectionstring`, or adjacent tokens form `private key`, `api key`, `access key`, `secret key`, `client
secret`, `connection string`, `master key`, `account key`, `shared key`, `signing key`, `encryption key`. Not
secret if the last token is a metadata word (`arn id name type version length count enabled ttl algorithm
fingerprint expiration policy rotation path file url endpoint hash md5 sha* format mode status ...`), so
`password_length`, `secret_arn`, `token_ttl`, `key_algorithm`, `public_key_fingerprint_md5` stay visible.
Numbers and booleans are never redacted by name. (`pem` alone was dropped from the list after the prototype
redacted `public_key_pem`; private PEMs are caught by layer 1 and layer 4.)

**Layer 4 -- value shape.** Redact strings matching: `-----BEGIN ... PRIVATE KEY-----`, JWTs, GitHub
(`ghp_`/`gho_`/`ghu_`/`ghs_`/`ghr_`/`github_pat_`), GitLab `glpat-`, Slack `xox?-`, npm `npm_`, `sk-...`, Google
`AIza...`. URLs with userinfo keep scheme/user/host and replace the password: `postgres://app:(redacted)@db`.

Rules that hold everywhere:

- Variable defaults in `tf_module_interface`: a `sensitive = true` variable or a secret-like name prints
  `default=(sensitive)`; the plan's `variables` section and `configuration` defaults are never read for output.
- Output values are never printed by any tool (names, sensitivity and action only).
- Import IDs are never printed (F3).
- Metadata words must never include a suffix that names the secret itself: `password_wo` (write-only arguments,
  Terraform 1.11+) is the password, so `wo` is NOT a metadata word (`password_wo_version` stays visible because its
  last token is `version`). Same for `header` (`authorization_header`).
- A footer states what was redacted and why: `redacted: 3 marked sensitive by Terraform, 1 by name, 1 by value`,
  so an agent knows a value exists and why it cannot see it. There is deliberately no "show sensitive" parameter.
- Accepted residual risk: unmarked derived values Terraform itself shows (e.g. `content_md5` of a sensitive file)
  are printed; hashes of low-entropy secrets are guessable. Documented, not redacted.

Verified on the fixture state: 15 resources rendered, zero occurrences of any `FIXTURE-SECRET-*` or
`FIXTURE-plain-*` string; `terraform_data.cfg` `output.pw` caught by layer 2, `terraform_data.with_token` by
layer 3.

## 6. Decision (d): tf_upgrade_impact temp-dir strategy

Goal: compare the pinned schema with the target version's schema for the types the configuration uses, and
confirm with a real `terraform validate`, without touching the user's directory and without downloading every
other provider again.

### Steps

1. **Resolve and check inputs.** `provider` accepts `hashicorp/tls` or `registry.terraform.io/hashicorp/tls`
   (normalized to the full address); must be in the root's lock file, else `hashicorp/foo is not used by this
   configuration (not in .terraform.lock.hcl). tf_list_providers shows the pinned providers.` `version` must be an
   exact version (`^\d+\.\d+\.\d+(-[0-9A-Za-z.-]+)?$`); a constraint gets `version must be an exact version like
   4.0.6, not a constraint`. Equal to pinned: answer `hashicorp/tls is already pinned at 4.0.6.` Lower than pinned
   is allowed and labelled `downgrade`.
2. **Pinned schema**: existing `SchemaStore.load(dir)`.
3. **Target schema** (cached): disk key `target-<sha256(full address + version + platform)[0:16]>.json` in the
   existing cache dir, plus `<key>.lock.hcl` holding the target's lock-file entry. On a miss: `mkdtemp`
   (`tfcwd-target-*`), write `main.tf` with only `terraform { required_providers { <type> = { source, version =
   "<exact>" } } }`, run `terraform init -backend=false -input=false -no-color` with
   `TF_PLUGIN_CACHE_DIR=<plugin cache>`, then `terraform providers schema -json`, store both files atomically
   (tmp + rename, like the existing cache), delete the temp dir. Only the target provider is downloaded; it lands
   in the plugin cache for step 5. Measured: 2.6-3.7 s per small provider cold, instant warm.
   Plugin cache: `TERRAFORM_CWD_MCP_PLUGIN_CACHE`, else the user's `TF_PLUGIN_CACHE_DIR` if set (it is a shared
   cache by design), else `<cacheDir>/plugins`.
4. **Usage** (tree-sitter, section 3) over the root and every module in `.terraform/modules/modules.json`
   (local and downloaded -- a registry module's resources break on upgrade too, as `module.certs` shows). For
   each `resource`/`data`/`ephemeral` block: the provider (meta-argument `provider = x.alias`, else the type
   prefix), resolved to a source through that module's `required_providers` (else `hashicorp/<local>`), the
   argument paths it sets (attributes, nested blocks, `dynamic "x" { content {...} }` as block `x`; meta-arguments
   `count for_each provider depends_on lifecycle provisioner connection` skipped), and attribute reads
   `<type>.<name>[idx|*].<attr>` / `data.<type>.<name>.<attr>` anywhere in the module. Also each module's version
   constraint for the provider (`required_providers` entry and legacy `provider "x" { version = ... }`).
5. **Constraint check** with our evaluator of Terraform's provider constraint syntax (`=`, `!=`, `>`, `>=`, `<`,
   `<=`, `~>`, bare version = exact, comma = AND; a prerelease satisfies only a constraint naming that exact
   prerelease). Root pin that excludes the target: informational (`root pins 3.4.0: change it to allow 4.0.6`).
   A module constraint that excludes it: `BLOCKED: module.x requires hashicorp/tls >= 3.0, < 4.0 (path:line);
   terraform init -upgrade would fail until that module allows 4.0.6.` Validate still runs (it ignores
   constraints, F12) because the schema answer is still useful.
6. **Validate confirmation** (`validate: true`, default):
   - `mkdtemp` (`tfcwd-upgrade-*`). Copy the root dir and every local module dir recursively, mirroring their
     paths relative to their common ancestor (handles `source = "../shared"`); copy `.terraform/modules/` (incl.
     `modules.json`). Exclude everywhere: `.terraform/` (except the modules subtree), `.git/`, `*.tfstate`,
     `*.tfstate.*`, `terraform.tfstate.d/`, `*.tfvars`, `*.tfvars.json`, `*.tfplan`, `crash.log`,
     `node_modules/`; symlinks copied as links, not followed. State and tfvars are never copied (secrets; validate
     needs neither). Non-`.tf` files ARE copied (F12). Caps: 100 MB / 20,000 files, else skip validate with a
     reason.
   - Providers WITHOUT `init`: create `.terraform/providers/<host>/<ns>/<type>/<version>/<os_arch>` as a
     directory junction (Windows) / symlink (POSIX) to `realpath` of the user's installed package for every
     provider, and for the target to the plugin-cache package from step 3. `<os_arch>` from `terraform version
     -json` `.platform` (with `CHECKPOINT_DISABLE=1`). Lock file = the user's, with the target's entry replaced by
     the cached `<key>.lock.hcl` entry.
   - Baseline: write the lock with the PINNED entry and link the pinned package, `terraform validate -json
     -no-color`. Target: swap lock entry + link, write `zz_tfcwd_upgrade_override.tf` pinning `version =
     "<target>"` under the SAME local name the root uses (e.g. `rnd`), validate again. Diff diagnostics by
     `(severity, summary, filename with / separators, start line, address)`: report new errors, new warnings and
     resolved ones. Both runs are offline -- verified with `HTTPS_PROXY=http://127.0.0.1:9`.
   - Cleanup: `fs.rmSync(tmp, { recursive: true, force: true, maxRetries: 5 })` in `finally`. Verified: Node's
     `rmSync` does not follow junctions or symlinks (`lstat().isSymbolicLink()` is true for a junction; target
     tree intact after removal), and a temp tree holding only links deletes in ~25 ms (no fresh provider `.exe`
     files to fight Defender over). On startup, sweep `tfcwd-upgrade-*` / `tfcwd-target-*` older than 1 h the
     same way.
   - Never run `terraform init` in the validate dir: if a provider package had to be (re)installed, Terraform's
     installer removing an existing package dir behind a junction is exactly the hazard to avoid.
7. **Render** (section 7.4). Usage findings come first, validate diff second, constraint verdict, then a one-line
   verdict.

### Concurrency, timeouts, annotations

- Upgrade calls are serialized in-process (a promise chain): Terraform documents the plugin cache as not safe for
  concurrent installs. Two server processes sharing a cache can still race; documented.
- Each subprocess uses `TERRAFORM_CWD_MCP_TIMEOUT_MS`; total wall time is not separately capped.
- Annotations: `readOnlyHint: true` (the user's directory and state are untouched; temp dirs and caches only),
  `destructiveHint: false`, `idempotentHint: true`, **`openWorldHint: true`** (downloads from the provider
  registry on a cache miss). The description says so.

### Failure modes and messages

| Failure | Real Terraform text (abridged) | Our message |
|---|---|---|
| Version does not exist | `no available releases match the given constraints 9.9.9` | `hashicorp/tls 9.9.9 does not exist in the registry. The official terraform MCP server's provider lookup lists valid versions.` |
| Provider does not exist | `provider registry registry.terraform.io does not have a provider named .../zzznotreal` | `registry.terraform.io has no provider hashicorp/zzznotreal.` |
| Offline / proxy | `could not connect to registry.terraform.io: failed to request discovery document` | `could not reach the provider registry to download hashicorp/tls 4.0.6 (offline or proxy). Nothing in <root> was changed.` |
| No build for this platform | `does not have a package available for your current platform` | `hashicorp/x 1.2.3 has no build for <platform>.` |
| User package missing | (our own check) | `<root>/.terraform/providers has no package for hashicorp/random 2.3.1; run terraform init there. Validate skipped.` |
| Copy cap exceeded | (our own check) | `configuration is larger than 100 MB / 20000 files; validate skipped, schema comparison only.` |
| Junction/symlink creation fails (POSIX permissions, exotic FS) | (our own check) | `could not link provider packages into a temp dir (<code>); validate skipped, schema comparison only.` |
| Validate itself fails to run | stderr | `terraform validate failed to run: <text>`; schema comparison still reported |

Validate failures never fail the tool: the schema comparison is the primary answer, validate is confirmation.

## 7. Tool specifications

Shared conventions (match `src/format.ts` / `src/tools.ts`): plain text, first line is a header, items indented
two spaces, flags in `[brackets]`, sorted by code unit, renderers are pure functions in `format.ts`, handlers in
`tools.ts` wrapped in `guard()` so thrown errors become `isError` results prefixed `Error: `. Answers that are
facts ("no state", "not in state", "no match") are normal text, not errors. (Implemented: the renderers live in
their own pure modules -- `plan.ts`, `state.ts`/`redact.ts`, `module.ts`, `upgrade.ts` -- rather than `format.ts`,
which keeps the four schema tools' renderers.) Every tool takes `dir` with the
existing `dirParam` semantics.

### 7.1 tf_summarize_plan

```ts
{
  plan_file: z.string().optional()
    .describe("Saved plan (binary from `terraform plan -out`, rendered here with `terraform show -json` in `dir`) or a plan JSON file"),
  plan_json: z.string().max(50_000_000).optional()
    .describe("Plan JSON text, e.g. from the official terraform MCP server's get_plan_json_output"),
  dir: dirParam,   // only used for binary plans: must be the initialized root that produced the plan
  max_per_section: z.number().int().min(1).max(1000).optional().default(50),
  max_paths: z.number().int().min(1).max(100).optional().default(8)
    .describe("Changed attribute paths listed per updated resource"),
}
```

Exactly one of `plan_file` / `plan_json` (checked in the handler, plain-text answer otherwise:
`pass exactly one of plan_file or plan_json`). Annotations: READ_ONLY (`openWorldHint: false`; HCP bookmarks are
refused, so `show` never calls out).

Input detection (before any spawn, on the first bytes / parsed JSON):
- `PK\x03\x04` -> binary plan: `assertInitialized(dir)`, `terraform show -json -no-color <abs path>`, cwd = root.
- JSON with `resource_changes` or `planned_values` -> plan representation. Warn (header flag) when
  `format_version` major != 1.
- JSON with `remote_plan_format` + `run_id` -> refuse: `this is an HCP Terraform saved-plan bookmark for run
  <run_id>; fetch its JSON with the official server (get_plan_json_output) and pass it as plan_json.`
- JSON with `version` + `lineage` (raw state) or `values` without `planned_values` (rendered state) -> refuse:
  `this is a state file, not a plan. Use tf_show_resource / tf_state_addresses.`
- First line parses with `@level` -> refuse: `this is \`terraform plan -json\` UI-stream output, not a plan
  representation. Save the plan with \`terraform plan -out=tfplan\` and pass that file.`
- `show` errors map as in section 4 plus F10: `could not render the plan here: the providers it was made with are
  not installed in <root>. Pass dir as the root that created the plan, or render it there with terraform show -json
  and pass plan_json.`

Classification of `resource_changes[].change.actions` (strings from `jsonplan/plan.go actionString`):
`delete` -> DELETE (with `action_reason` mapped: `delete_because_no_resource_config` "not in configuration",
`..._wrong_repetition` "count/for_each added or removed", `..._count_index`, `..._each_key`, `..._no_module`,
`..._no_move_target`); `delete,create` -> REPLACE delete-then-create, `create,delete` -> REPLACE
create-before-destroy, with `replace_paths` for `replace_because_cannot_update`, else "tainted", "-replace
requested", "replace_triggered_by"; `update` -> UPDATE with changed leaf paths from `before` vs `after` plus
`after_unknown` ("(known after apply)"); `create`; `read` (data sources read during apply, with
`read_because_*`); `forget` / `create,forget` -> FORGET; `no-op` with `importing` -> IMPORT, with
`previous_address` -> MOVED, else counted unchanged. Import/move on a non-no-op change is listed in IMPORT/MOVED
with `(then <action>)` as well as in its action section. `deposed` keys are shown. `resource_drift` -> DRIFT,
`deferred_changes` -> DEFERRED (`reason`), `errored`/`applyable`/`complete` -> header flags, `output_changes` ->
OUTPUTS (names, action, `[sensitive]`, never values).

Totals line ends with Terraform's own counting, so it can be checked against the CLI ("Plan: 1 to import, 6 to
add, 1 to change, 6 to destroy." -- add = creates + replaces, destroy = deletes + replaces). Implemented exactly as
`internal/command/jsonformat/plan.go` counts: `forget` and `create,forget` are not in "to add"/"to destroy", a
deleted data source is neither rendered nor counted, imports count whatever their action, and `action_invocations`
add "; N actions to invoke". The parenthetical drops Terraform's trailing period.

Warning rule: if deletes + replaces > 0, append `WARNING: N object(s) will be destroyed (D delete, R replace).`
plus either `K moved block(s) applied; none covers these.` or `No moved blocks in this plan.`, plus
`Possible renames needing a moved block: a -> b` for each delete paired with a create of the same type in the same
module.

Real output, fixture `plan/plan.json` (prototype; final will print the terraform parenthetical exactly as
Terraform, i.e. without the forget count):

```
plan (terraform 1.15.7, format 1.2): applyable, complete
totals: 1 delete, 5 replace, 1 update, 1 create, 0 read, 1 import, 1 move, 1 forget, 0 unchanged (terraform: 1 to import, 6 to add, 1 to change, 6 to destroy)
DELETE (1)
  - null_resource.gone (not in configuration)
REPLACE (5)
  -/+ local_sensitive_file.sf delete-then-create; forced by: content [sensitive]
  -/+ random_password.db delete-then-create; forced by: length
  +/- random_string.cbd create-before-destroy; forced by: keepers
  -/+ tls_private_key.k delete-then-create; forced by: ecdsa_curve
  -/+ module.naming.random_pet.this delete-then-create; forced by: prefix
UPDATE (1)
  ~ terraform_data.cfg: input.version, output (known after apply)
CREATE (1)
  + local_file.drift
IMPORT (1)
  random_id.imp
MOVED (1)
  random_pet.a -> random_pet.renamed
FORGET (1)
  . random_id.keep (removed from state, object NOT destroyed)
DRIFT (detected during refresh) (1)
  local_file.drift: deleted outside Terraform
OUTPUTS (2)
  + new_out
  ~ pw [sensitive] (known after apply)
WARNING: 6 object(s) will be destroyed (1 delete, 5 replace). 1 moved block(s) applied; none covers these.
```

Cross-checked against the CLI's own text for the same plan ("Plan: 1 to import, 6 to add, 1 to change, 6 to
destroy.", `random_string.cbd` shown as `+/-`, the others `-/+`, `random_id.keep` "will no longer be managed").

### 7.2 tf_module_interface

```ts
{
  module: z.string().optional()
    .describe("Module to describe: omitted = the root; a module address like 'module.network' or 'module.a.module.b' (resolved through .terraform/modules/modules.json, so downloaded registry/git modules work); or a directory path relative to dir"),
  dir: dirParam,  // root module; need not be initialized for the root or local paths
  description_chars: z.number().int().min(0).optional().default(160),
}
```

Annotations: READ_ONLY, `openWorldHint: false`. No subprocess at all.

Resolution: address -> manifest key (`module.a.module.b` -> `a.b`), `Dir` relative to root. Path -> resolved
against root, `assertLocalPath`. Errors: `module.x is not in .terraform/modules/modules.json (not installed, or
not called from <root>). Run terraform init, or pass a directory path.`; `<path> contains no .tf or .tf.json
files.` Module calls of the described module are resolved by manifest key (`<own key>.<call name>`); if the
manifest is missing or lacks the key: `-> NOT INSTALLED (run terraform init)`; if the manifest `Source` differs
from the config `source` (normalized: registry sources gain `registry.terraform.io/`): `-> STALE: installed from
<x>, config says <y>; run terraform init`.

Variable line: `name: <type> <required|optional>[flags] [default=...] - <description>`. Type is the CST
rendering, or `any (no type)` when omitted. Required = no `default` attribute (an explicit `default = null` is
optional, matching Terraform and the oracle). Flags: `[sensitive]`, `[not nullable]`, `[ephemeral]`,
`[N validation(s)]`. Defaults: literal JSON (truncated to 80 chars), `expr(<normalized source>)` for expressions,
`(sensitive)` per section 5. Outputs: `name [sensitive] [ephemeral] - description`.

Real output, fixture `modroot/` (prototype; the `tags` type shows the corrected CST rendering, see section 3):

```
module (root): 1 variables, 4 outputs, 2 module calls
variables:
  db_password: string optional [sensitive] default=(sensitive)
outputs:
  label_id
  new_out
  pet
  pw [sensitive]
module calls:
  label: source=cloudposse/label/null version=0.25.0 -> .terraform/modules/label (installed 0.25.0)
  naming: source=./modules/naming -> modules/naming
```

```
module modules/naming (module.naming): 5 variables, 2 outputs, 0 module calls
variables:
  length: number optional default=2 - Pet name length. Multi-line heredoc description.
  prefix: string required [2 validations] - Name prefix.
  secret_seed: string optional [sensitive] default=(sensitive)
  tags: map(object({value = string, optional = optional(bool, false)})) optional [not nullable] default={}
  untyped: any (no type) required
outputs:
  name - Generated name.
  seed [sensitive]
```

`module.label` (CRLF registry module) renders all 18 variables, e.g.
`context: any optional [2 validations] default={"enabled":true,"namespace":null,...` and
`label_key_case: string optional [1 validation] default=null - Controls the letter case of the ...`. Descriptions
collapse `\r?\n` and runs of whitespace to one space (the existing `oneLine` only replaces `\n`; it gets the same
fix so CRLF descriptions from the schema tools render cleanly too).

### 7.3 tf_state_addresses and tf_show_resource

```ts
// tf_state_addresses
{
  filter: z.string().optional().describe("Case-sensitive substring of the address, e.g. 'module.network' or 'aws_instance.'"),
  id: z.string().optional().describe("Only the instance whose id attribute equals this (terraform state list -id)"),
  dir: dirParam,
  limit: z.number().int().min(1).max(10000).optional().default(200),
}
// tf_show_resource
{
  address: z.string().describe('Exact resource instance address from tf_state_addresses, e.g. aws_instance.web[0] or module.db.aws_db_instance.this["primary"]'),
  dir: dirParam,
  include_null: z.boolean().optional().default(false),
  max_value_chars: z.number().int().min(0).optional().default(200).describe("Truncate each value; 0 = no limit"),
}
```

Annotations for both: `readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true` --
with a remote backend they read S3/GCS/HCP. Descriptions say "read-only: never locks, never refreshes,
sensitive values are redacted".

Filtering is done in-process on `state list` output (Terraform's address argument rejects globs: `random_p*`
failed with "Invalid character"). Output: header `N addresses in workspace '<ws>' (backend <type>)`, then one
address per line, then `... M more, narrow the filter` like `tf_search_types`. Empty: `no addresses match
'<filter>'` / the no-state text.

`tf_show_resource`: exact match on the JSON `address`, searching child modules. Not found: if it is a prefix of
instance addresses (`random_integer.n` -> `[0]`, `[1]`), list them: `random_integer.n has 2 instances; pass one:
random_integer.n[0], random_integer.n[1]`; else `<address> is not in state. Use tf_state_addresses to list
addresses.` Values are flattened to dotted paths (`input.pw`, `allowed_uses[0]`, `tags["Name"]`), nulls hidden
unless asked, empty containers shown as `{}` / `[]`.

Real output, fixture `state/state.json` (prototype):

```
terraform_data.cfg (terraform_data, terraform.io/builtin/terraform, schema v0)
  id = "d085f8d4-9c26-759a-8d47-dad5b7cf50f2"
  input.pw = (sensitive)
  input.version = "2"
  output.pw = (redacted: contains a sensitive value)
  output.version = "2"
redacted: 1 marked sensitive by Terraform, 0 by name, 1 by value
```

```
terraform_data.with_token (terraform_data, terraform.io/builtin/terraform, schema v0)
  id = "442caadd-37d2-988f-71f2-b4496c7a435d"
  input.api_token = (redacted: secret-like name)
  input.db_password = (redacted: secret-like name)
  input.note = "not a secret"
  output.api_token = (redacted: secret-like name)
  output.db_password = (redacted: secret-like name)
  output.note = "not a secret"
redacted: 0 marked sensitive by Terraform, 4 by name, 0 by value
```

```
tls_private_key.k (tls_private_key, hashicorp/tls, schema v1)
  algorithm = "ECDSA"
  ecdsa_curve = "P384"
  id = "5bc2a7be7201f56f4f43df5c7885f9ba6db0f9f2"
  private_key_openssh = (sensitive)
  private_key_pem = (sensitive)
  private_key_pem_pkcs8 = (sensitive)
  public_key_fingerprint_md5 = "83:74:49:ec:b2:9c:a5:d4:ad:a1:7b:4c:0d:05:77:42"
  public_key_fingerprint_sha256 = "SHA256:4V3vzFUXTgQ8UHeU2KlqjfC5RGAgSG2xRcBXxPEjxCw"
  public_key_openssh = "ecdsa-sha2-nistp384 AAAAE2VjZHNhLXNoYTItbmlzdHAzODQAAAAIbmlzdHAzODQAAABhBBUpGtPsDZZaTfHC0I20P5wZaoj+bPCkvb3ZJP2NpCYvnAMtKcYw9u4HuoyGaDoIjYk3BWinnh/wX6qGsHowfsNgob4ZjErW3kGZepunETAgEMre+AR+WaOALrjSbix... (205 chars)
  public_key_pem = "-----BEGIN PUBLIC KEY-----\nMHYwEAYHKoZIzj0CAQYFK4EEACIDYgAEFSka0+wNllpN8cLQjbQ/nBlqiP5s8KS9\nvdkk/Y2kJi+cAy0pxjD27ge6jIZoOgiNiTcFaKeeH/BfqoawejB+w2ChvhmMStbe\nQZl6m6cRMCAQyt74BH5Zo4AuuNJuLGOh\n-----... (215 chars)
  rsa_bits = 2048
redacted: 3 marked sensitive by Terraform, 0 by name, 0 by value
```

The prototype truncated the JSON-quoted string (losing the closing quote). The implementation truncates the raw
value to `max_value_chars`, then quotes it and appends ` ... (+N chars)`.

### 7.4 tf_upgrade_impact

```ts
{
  provider: z.string().describe("Provider address as pinned, e.g. hashicorp/aws or registry.terraform.io/hashicorp/aws"),
  version: z.string().describe("Exact target version, e.g. 6.0.0 (not a constraint)"),
  dir: dirParam,
  validate: z.boolean().optional().default(true)
    .describe("Confirm with terraform validate on a temp copy (offline once the target is downloaded)"),
  include_unused: z.boolean().optional().default(false)
    .describe("Also list target-version changes to types/arguments this configuration does not use"),
}
```

Annotations: `readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true`.
Description: "Downloads the target provider from the registry into a cache (temp dirs only; never touches dir)."

Findings per used argument (pinned schema vs target; the exact rule set the prototype implemented):
`REMOVED in target`; `now READ-ONLY (computed) in target` (settable -> computed-only; Terraform rejects it at
validate); `TYPE CHANGED <old> -> <new>` (for a nested attribute only the nesting mode is compared: each inner key
the configuration sets is checked as its own path, so comparing the whole nested type reported every inner removal
twice -- found while testing; also `now a nested block` / `now an attribute` when the kind flips); `DEPRECATED in target`; block `REMOVED` / `min_items` raised;
`NEWLY REQUIRED in target, not set` for required attributes / `min_items > 0` blocks the block does not set;
`TYPE REMOVED` / `type DEPRECATED` for used types; for reads: `reads x.y.z: REMOVED` / `DEPRECATED`. Attribute
vs nested attribute vs block is resolved against each schema the same way `tf_check_arguments` walks paths.

Real findings and real validate results for the fixture `upgrade/uproot/` (pinned tls 3.4.0 + random 2.3.1).
Schema diff and validate agreed exactly for both targets. Format as specified (lines assembled from the prototype
findings and the fixture validate JSON):

```
upgrade hashicorp/tls 3.4.0 -> 4.0.6 (major) for <root>
constraints: root pins 3.4.0 (change it to allow 4.0.6); module.certs ">= 3.0" ok
used types: resource tls_private_key, tls_self_signed_cert, tls_cert_request; data tls_public_key
affected arguments (2):
  tls_self_signed_cert.ca.key_algorithm (main.tf:6): now READ-ONLY (computed) in 4.0.6
  module.certs.tls_cert_request.r.key_algorithm (modules/certs/main.tf:11): now READ-ONLY (computed) in 4.0.6
validate on a temp copy, 4.0.6 vs 3.4.0: 2 new errors, 0 new warnings, 2 warnings resolved
  error main.tf:6 tls_self_signed_cert.ca: Invalid Configuration for Read-Only Attribute - Cannot set value for this attribute as the provider has marked it as read-only. Remove the configuration line setting the value.
  error modules/certs/main.tf:11 module.certs.tls_cert_request.r: Invalid Configuration for Read-Only Attribute - Cannot set value ...
verdict: BREAKING (2 errors after upgrade)
```

```
upgrade hashicorp/random 2.3.1 -> 3.6.3 (major) for <root>
constraints: root pins 2.3.1 as local name rnd (change it to allow 3.6.3)
used types: resource random_password, random_id
affected arguments (2):
  random_password.p.number (main.tf:18): DEPRECATED in 3.6.3
  reads random_id.i.b64 (main.tf:36): REMOVED in 3.6.3
validate on a temp copy, 3.6.3 vs 2.3.1: 1 new error, 1 new warning, 1 warning resolved
  error main.tf:36: Unsupported attribute - This object has no argument, nested block, or exported attribute named "b64".
  warning main.tf:18 random_password.p: Attribute Deprecated - **NOTE**: This is deprecated, use `numeric` instead.
verdict: BREAKING (1 error after upgrade)
```

Verdicts: `BREAKING` (new validate errors, or REMOVED/READ-ONLY/NEWLY REQUIRED/TYPE CHANGED findings when
validate was skipped), `BLOCKED` (module constraint), `DEPRECATIONS ONLY`, `NO IMPACT on used types`. Implemented
precedence: BLOCKED wins and appends `; also BREAKING (...)` when that applies; when validate ran with no new errors
but the schema comparison found a breaking change, the verdict is still BREAKING with "terraform validate reported
no new errors" (the two never disagreed on the fixtures). A block-count finding (`min_items raised`, `max_items
lowered`, the latter added) is reported once per block type, not per occurrence. When
validate was skipped the verdict says `(schema comparison only: <reason>)`.

Real pairs for reference (scratch differ, all four version pairs dumped): tls 3.4.0 -> 4.0.6 makes
`key_algorithm` (tls_cert_request, tls_self_signed_cert) and `ca_key_algorithm` (tls_locally_signed_cert)
computed-only; tls 2.2.0 -> 3.4.0 changes the type of `data.tls_certificate.certificates` (adds `cert_pem` to the
object) and deprecates those `key_algorithm`s; random 2.3.1 -> 3.6.3 removes `random_id.b64`, deprecates
`random_password.number` / `random_string.number`, adds `random_bytes`; null 2.1.2 -> 3.2.3 deprecates the
`null_data_source` type; SDKv2 legacy `id` flips from optional+computed to computed in every 2.x -> 3.x pair
(flagged only if a config sets `id`). No small HashiCorp provider pair has a removed resource type or a newly
required argument; those rules are covered by hand-built dumps in unit tests, like the existing
deprecated-type tests.

## 8. Test plan

Unit (pure renderers in `format.ts`, plus new pure modules `hcl.ts`, `redact.ts`, `constraints.ts`), no
terraform needed:

- `summarizePlan` on `plan/plan.json`: exact expected text (snapshot of section 7.1 output); assert no
  `FIXTURE-SECRET`, no `p-9hUg` import ID, no output values. Hand-built plans for: `read` with `read_because_*`,
  `deferred_changes`, `errored: true` / `applyable: false`, `deposed`, `create,forget`, replace with
  `replace_by_triggers` / tainted / by request, `replace_paths` through a sensitive map (path truncated),
  rename pair warning, per-section truncation, `max_paths`.
- Input detection: binary signature, plan JSON, `plan-ui-stream.jsonl`, raw state, rendered state
  (`state/state.json`), HCP bookmark JSON, both/neither of `plan_file` / `plan_json`.
- Redaction: fixture state, every resource rendered, zero sentinel strings; layer-by-layer cases (marker subtree,
  value equality and containment, key tokenization incl. camelCase and the benign-suffix list --
  `password_length`, `secret_arn`, `token_ttl`, `public_key_pem` visible), value shapes (PEM, JWT, GitHub/GitLab/
  Slack/npm tokens), URL userinfo; numbers/bools never name-redacted; footer counts.
- HCL reader: the **oracle test** (fixture `modroot/` vs `plan/plan.json` `configuration`: has-default, canonical
  default, exact description incl. CRLF heredocs, sensitive -- 49 items, 0 mismatches today); type rendering from
  CST (newline-separated object attrs, comments with braces, `optional(T, default)`, nested `tuple`/`set`);
  escapes; heredoc `<<` vs `<<-`, blank lines, tabs; interpolated strings reported as `expr(...)`; parse-error
  reporting; `.tf.json`; override merge; ignored files.
- Module interface rendering: root, local path, `module.naming` and `module.label` by address, missing manifest,
  stale manifest source, unknown address, empty dir.
- Usage collection: `dynamic` blocks, meta-arguments skipped, `provider = rnd` local-name resolution, legacy
  provider-block constraints, reads through `[0]` and `[*]`.
- Upgrade findings on `upgrade/schema-pinned.json` vs the two target dumps: exactly the findings in 7.4.
  Hand-built dumps for TYPE REMOVED, NEWLY REQUIRED attr/block, block removed, nested-attribute paths.
- Validate diagnostics diff on `validate-baseline.json` vs `validate-*.json` (backslash filenames normalized).
- Constraint evaluator: table of Terraform constraint cases (`~> 1.2`, `~> 1.2.3`, `~> 1`, `>= 3.0, < 4.0`,
  `!= 4.0.1`, bare `4.0.6`, prereleases).
- State error mapping: each file in `state/stderr/` maps to its message; `no-state.json` -> no-state text;
  workspace guard decision (env vs `.terraform/environment` vs default; present/absent in a `workspace list`
  output).

Server (`server.test.ts`, InMemoryTransport): every new tool end to end with injected runners (the store/runner
injection pattern already used), annotations asserted, `isError` only for real failures.

Integration (real terraform, skipped when absent or offline, like `integration.test.ts`; plugin cache via
`TF_PLUGIN_CACHE_DIR` under a temp root to keep it fast):

- Build a small root in a temp dir (random + terraform_data, local backend), `init`, `apply`, change config, `plan
  -out`; run `tf_summarize_plan` on the binary plan and on its `show -json`; assert equal output and no sensitive
  value from the live state appears.
- `tf_state_addresses` / `tf_show_resource` on that root; then hold the lock with a pending `terraform apply`
  (stdin kept open) and assert the Windows lock message on win32 (and success on POSIX, where the lock is
  advisory -- verify before asserting).
- Workspace guard: `TF_WORKSPACE=ghost` against the local backend -> refused before any state command runs (assert
  no `terraform.tfstate.d/ghost` appears).
- `tf_upgrade_impact` on a temp copy of `upgrade/uproot/` (after `init` there): tls 4.0.6 and random 3.6.3 give the
  section 7.4 findings and validate diffs; the user dir's mtime/size snapshot is unchanged; the temp dirs are gone;
  the plugin cache still holds the packages (junction cleanup did not follow links). A second call is offline
  (`HTTPS_PROXY=http://127.0.0.1:9`) and still validates.
- Constraint oracle: for a few constraint strings, compare the evaluator's verdict with `terraform init` success in
  a temp dir (cached provider).

Pre-commit gates unchanged: `npm run lint:fix`, `npx tsc --noEmit`, `npm test`, `npm run build`,
`npm run check:compliance` (grade A -- new tools need titles/annotations/descriptions that pass it).

## 9. Fixtures committed with this doc

`src/tests/fixtures/README.md` documents each file. Secrets are replaced by `FIXTURE-SECRET-NN` sentinels
(16 distinct values, consistently across plan and state so value matching still has something to match); real
private keys would also trip GitHub secret scanning. Binary plans are not committed (they embed secrets and need
providers); integration tests create them live.

- `plan/plan.json`, `plan/plan-ui-stream.jsonl`
- `state/state.json`, `state/no-state.json`, `state/stderr/*.txt` (+ README with provenance)
- `modroot/` (root + `modules/naming` + `dot-terraform/modules/{modules.json,label/*.tf,LICENSE}`); the label
  module stays CRLF via a `.gitattributes` `-text` rule added for `src/tests/fixtures/modroot/dot-terraform/**`
  (the repo default `* text=auto eol=lf` would normalize it and break the oracle).
- `upgrade/uproot/` (pinned config + lock + `banner.txt` for the `file()` case + `dot-terraform/modules/
  modules.json`), `upgrade/schema-pinned.json`, `upgrade/schema-tls-4.0.6.json`,
  `upgrade/schema-random-3.6.3.json`, `upgrade/validate-{baseline,tls-4.0.6,random-3.6.3}.json`.

Test helpers copy `modroot/` / `uproot/` to a temp dir and rename `dot-terraform` to `.terraform` (the repo
ignores `.terraform/`).

## 10. Implementation notes and follow-ups

- Generalize `createTerraformRunner` into `runTerraform(args, { cwd, env, timeoutMs })` returning
  `{ code, stdout, stderr }`; the schema runner and all new commands use it, so the `.cmd`/`.bat` refusal, ENOENT
  mapping, stderr cap and timeout behaviour stay in one place. Add `CHECKPOINT_DISABLE=1` (F13).
- New env: `TERRAFORM_CWD_MCP_PLUGIN_CACHE`. Document in CLAUDE.md's env table, README, and `INSTRUCTIONS`
  (one sentence per new tool, plus the authority split).
- `TF_DATA_DIR` is not honoured by the existing tools (they look for `<root>/.terraform`); the new tools follow suit
  and the limitation is documented rather than half-supported.
- Raise `server.json`/README tool lists from 4 to 9 tools.
- `check:compliance` (grade A today) already warns `security-oversized-input` (a 1 MB string was accepted).
  Give every new string parameter a `maxLength` (paths 4096, addresses 1024, filters 512); `plan_json` keeps a
  deliberately large cap (50 MB) because HCP plan JSON is big, and is the one documented exception.
- Decide whether `tf_upgrade_impact` should default `validate` to false on very large provider sets; the data so
  far (validate offline in ~1-2 s for small configs) says keep it on.

## 11. Implementation notes (2026-10-15)

Design flaws found while implementing, fixed in code and in the sections above:

- **Nested-attribute type comparison** (7.4): comparing the full nested type signature produced a spurious
  `TYPE CHANGED nested:single -> nested:single` next to the real `REMOVED` finding for the inner key. Only the nesting
  mode is compared now; inner keys are separate paths.
- **Update paths missed new unknown attributes** (7.1): an attribute present only in `after_unknown` (absent from
  both `before` and `after`) was not listed. The walk now unions the keys of all three trees.
- **Secret-name metadata list** (5): `wo` and `header` would have hidden real secrets (`password_wo`,
  `authorization_header`) behind the "metadata suffix" exception; both are excluded from the list.
- **Block-count findings** were emitted once per block occurrence; now once per block type.

Other deviations, all deliberate:

- The startup sweep of stale `tfcwd-upgrade-*` / `tfcwd-target-*` dirs runs in `startServer()` (background), not in
  `createTerraformCwdServer()`, so library users and tests do not scan `%TEMP%`.
- The target-init temp dir is deleted in the background (it holds a provider binary that just ran, which Windows can
  hold onto); the validate dir (links + copies only) is deleted synchronously in `finally`.
- `validate: false` renders no validate line and the verdict says `(schema comparison only: validate not
  requested)`.
- `include_unused` lists at most 200 lines and skips SDKv2's legacy `id` flip (optional+computed -> computed),
  which would otherwise appear for every type in every 2.x -> 3.x pair.
- Existing string parameters (`query`, `type_name`, `kind`, `arguments[]`, `dir`) also got `maxLength`.
- A binary plan whose `terraform show` fails for an unrecognized reason reports `terraform show -json failed (exit
  N) rendering <file> in <root>` plus Terraform's text, rather than the state-command wording.
- `tf_summarize_plan` input refusals (UI stream, state, HCP bookmark, not JSON, both/neither inputs) are plain text;
  a missing file or a failed `terraform show` is an error result.
