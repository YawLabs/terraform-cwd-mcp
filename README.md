# @yawlabs/terraform-cwd-mcp

[![Add to Yaw MCP](https://yaw.sh/yaw-mcp-button.svg)](https://yaw.sh/mcp/install?name=Terraform%20CWD&command=npx&args=-y%2C%40yawlabs%2Fterraform-cwd-mcp&description=Terraform%20working-dir%20truth%3A%20pinned%20provider%20schemas%2C%20plans%2C%20state%2C%20modules%2C%20upgrade%20impact&source=https%3A%2F%2Fgithub.com%2FYawLabs%2Fterraform-cwd-mcp)

One click adds this to your local Yaw MCP config so it's available in every Yaw Terminal session. Tested with Yaw MCP 1.1.13 or newer. Or install manually below.

**What is actually true in THIS Terraform working directory: the exact provider schemas pinned in your `.terraform.lock.hcl` (so coding agents stop writing arguments that do not exist, were removed, or are read-only), plus your saved plans, your state (redacted), your local and installed modules, and what a provider upgrade would break.** It complements HashiCorp's [terraform-mcp-server](https://github.com/hashicorp/terraform-mcp-server) rather than replacing it: that server answers from the Terraform Registry docs, which describe the *latest* provider release; this one answers from `terraform providers schema -json` in your root module, which describes the version you actually *locked*. Run both.

[![npm version](https://img.shields.io/npm/v/@yawlabs/terraform-cwd-mcp)](https://www.npmjs.com/package/@yawlabs/terraform-cwd-mcp)
[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](https://opensource.org/licenses/MIT)

Built and maintained by [Yaw Labs](https://yaw.sh).

## Why this one?

Your lock file says `hashicorp/aws 5.31.0`; the registry docs (and the model's training data) say whatever came later or earlier. Agents then write arguments that were added after your pin, removed before it, or are `computed`-only and cannot be set at all. `terraform validate` catches it -- after the code is written. This server lets the agent check *before* it writes.

- **Pinned, not latest** -- the source of truth is `terraform providers schema -json` run in your root module, with versions read from `.terraform.lock.hcl`.
- **Never writes your root, never inits it** -- it never runs `terraform init` in your directory, so your lock file and `.terraform/` stay as they are. An uninitialized directory gets an actionable error telling you what to run. It is not free of side effects: it runs `terraform`, which starts provider plugins, and writes caches (see [Security model](#security-model)). The one download is the opt-in `tf_upgrade_impact`, in a temp dir.
- **Cached per lock file** -- dumps are cached in memory and on disk, keyed on the root path plus the lock file's bytes, so a provider upgrade invalidates the cache automatically. The AWS provider's schema is tens of MB; you pay for that dump once per lock-file change, not per question.
- **Small answers** -- `tf_get_schema` renders one type as a compact indented outline with `required` / `optional` / `optional+computed` / `computed (read-only)`, `[deprecated]`, `[sensitive]` and `[write_only]` flags, instead of handing the model raw JSON.
- **Cross-platform** -- macOS, Linux and Windows. Terraform is spawned directly (no shell) and its output is streamed, so there is no buffer ceiling.

## Tools

| Tool | What it does |
|---|---|
| `tf_list_providers` | Providers in the root module with their **pinned** versions and resource / data / ephemeral counts. Call this first. |
| `tf_search_types` | Find type names containing a substring (`s3_bucket`), per kind. |
| `tf_get_schema` | Every argument and nested block of one type at the pinned version, with mode and flags. Use before writing or editing a block. |
| `tf_check_arguments` | Validate dotted paths (`["bucket", "versioning.enabled"]`) and get `ok`, `ok (block)` (either with `[deprecated]`), `READ-ONLY (computed)`, `'<x>' is an attribute, not a block` or `UNKNOWN` per path. |
| `tf_summarize_plan` | Summarize a saved plan (`plan_file` inside `dir`: binary from `terraform plan -out`, or plan JSON) or plan JSON text (`plan_json`, e.g. an HCP run's plan fetched by the official server). Plan JSON is unverified input: its shape is checked and the summary says so. Deletes and replaces first, with the attribute that forces each replace; then updates (changed paths), creates, imports, moves, forgets, drift, deferred changes and outputs; Terraform's own `Plan:` counts; a destroy warning naming renames that need a `moved` block. Prints **no values**. |
| `tf_module_interface` | Variables (exact type expression, required/optional, default, `[sensitive]` / `[not nullable]` / `[ephemeral]`, validation count), outputs and module calls of the root, a local module path, or an installed module by address (`module.network`, incl. downloaded registry/git modules). Flags module calls that are not installed or stale. No subprocess. |
| `tf_state_addresses` | Resource instance addresses in the current state (`terraform state list`), with a substring filter and `id` lookup. |
| `tf_show_resource` | One instance's attribute values from state (`terraform show -json`), with best-effort redaction of sensitive values and a footer saying what was hidden and why. |
| `tf_upgrade_impact` | **Off unless you set `TERRAFORM_CWD_MCP_ALLOW_UPGRADE=1`.** What breaks if a pinned provider moves to an exact version: the arguments, nested blocks, attribute reads and `provider` block arguments your configuration (root + installed modules) uses that are removed, read-only, retyped, newly required or deprecated in the target; version constraints that block it; confirmed by `terraform validate` on a temp copy. |

Every tool takes an optional `dir` (the root module), which must be inside the server's directory or `TERRAFORM_CWD_MCP_ALLOWED_DIRS`; `kind` is `resource` (default), `data` or `ephemeral`.

**Division of authority with HashiCorp's official server.** This server wins on argument validity for the version you pinned and on what this directory's plan, state and modules contain. The [official server](https://github.com/hashicorp/terraform-mcp-server) wins on usage docs, latest versions, public registry modules and HCP/TFE runs. For an HCP run's plan, get its plan id there (`get_run_details`), fetch the plan with `get_plan_json_output(plan_id)` and pass the JSON to `tf_summarize_plan` as `plan_json` (those tools need the official server's `terraform` toolset and `TFE_TOKEN`).

### What it writes, runs and reaches

- **Never written:** your root module, its `.terraform/`, its lock file and its state. `terraform init` is never run in it.
- **Written:** the schema cache, and for `tf_upgrade_impact` the plugin cache and temp dirs.
- **Schema tools** (`tf_list_providers`, `tf_search_types`, `tf_get_schema`, `tf_check_arguments`) run `terraform providers schema -json` on a cache miss, which starts every installed provider plugin. A root with a configured backend is dumped from a temp dir holding its lock file and a link to its providers, so the backend is not contacted; that dump also lists Terraform's builtin provider.
- **State tools** (`tf_state_addresses`, `tf_show_resource`) run `terraform state list` / `terraform show -json`, which never lock and never refresh. With a remote backend, `terraform state list` and `terraform state pull` read S3/GCS/HCP, and `terraform show` renders the pulled copy from a private temp file. Those backend commands get no credential or proxy variables unless you set `TERRAFORM_CWD_MCP_ALLOW_BACKEND_CREDENTIALS=1`; credentials Terraform finds on its own (`~/.aws`, gcloud application-default login, `terraform login`) keep working without it. `tf_state_addresses` also runs `terraform state pull` to check the listing, and `terraform show` when an address has a string instance key, to find keys that must be hidden; if `show` cannot run, every string key is hidden. Selecting a non-default workspace that does not exist would make Terraform *create* it (the s3 backend writes an empty state), so the server checks `terraform workspace list` first and refuses.
- **`tf_upgrade_impact`** (opt-in) downloads the target provider version with `terraform init` in a throwaway temp dir into a plugin cache (`TERRAFORM_CWD_MCP_PLUGIN_CACHE`, else your `TF_PLUGIN_CACHE_DIR`, else `<cache>/plugins`), then runs `terraform validate` on a temp copy of your configuration whose `.terraform/providers` entries are links to the packages you already have. State and `*.tfvars` are never copied. Calls are serialized (the plugin cache is not safe for concurrent installs).
- **Redaction** (`tf_show_resource`, and instance keys in `tf_state_addresses`) is best effort: Terraform's sensitive markers, plus any string, map key or instance key equal to (or containing) a marked value anywhere in state, plus values under secret-like keys (`password`, `api_token`, `client_secret`, `aws_sk`, `DB_CRED`, ... but not `password_length` or `secret_arn`), plus secret-shaped strings, map keys and instance keys (private keys, JWTs, AWS access key IDs, GitHub/GitLab/Slack/npm tokens; URL passwords are masked in place). There is deliberately no "show sensitive" switch. An unmarked secret with an ordinary name and no known shape is printed, as are unmarked derived values Terraform itself shows (e.g. `content_md5` of a sensitive file). Do not treat the output as safe to publish.
- Every terraform child gets `CHECKPOINT_DISABLE=1`, so no version check phones home.

### Security model

Terraform provider plugins are programs, and they are found through files in the working directory. Anyone who can write `.terraform/` or the lock file, including a coding agent, can decide what runs. This server limits what that code receives; it does not sandbox it.

- **Directory boundary.** `dir`, module paths and manifest entries must resolve (links included) inside the server's directory (`TERRAFORM_CWD_MCP_DIR`, else its working directory) or `TERRAFORM_CWD_MCP_ALLOWED_DIRS`. `plan_file` must be inside `dir`.
- **Credential variables are withheld.** Every command that can start a plugin gets an allowlisted environment: OS and locale variables, `TF_CLI_CONFIG_FILE`, `TF_PLUGIN_CACHE_DIR`, `TF_DATA_DIR`, `TF_WORKSPACE`, plus anything in `TERRAFORM_CWD_MCP_PASS_ENV`. `AWS_*`, `TF_VAR_*`, `TF_TOKEN_*` and the rest are removed.
- **Backend credentials are opt-in.** Backend configuration lives in the directory and can run a command (an S3 profile's `credential_process`, a kubernetes `exec`), so by default `terraform state list`, `state pull` and `workspace list` get the same allowlisted environment. With `TERRAFORM_CWD_MCP_ALLOW_BACKEND_CREDENTIALS=1` they also get proxy settings and the variables of the backend type named in `.terraform/terraform.tfstate` (`s3`: `AWS_*`; `gcs`: `GOOGLE_*`, `GCLOUD_*`, `CLOUDSDK_*`; `azurerm`: `ARM_*`, `AZURE_*`, managed-identity and GitHub OIDC variables; `remote`/`cloud`: `TF_TOKEN_*`, `TF_CLOUD_*`, `TFE_*`; `http`: `TF_HTTP_*`; `consul`: `CONSUL_*`; `cos`: `TENCENTCLOUD_*`; `oss`: `ALICLOUD_*`, `ALIBABA_CLOUD_*`; `kubernetes`: `KUBE_*`, `KUBECONFIG`; `pg`: `PG*`). Never the rest of the environment. Other types get none; name what they need in `TERRAFORM_CWD_MCP_PASS_ENV`.
- **`terraform init` for `tf_upgrade_impact`** gets proxy settings and `TF_TOKEN_*`, which Terraform sends only to the matching host.
- **The binary is not looked up in `dir`.** On Windows the server sets `NoDefaultCurrentDirectoryInExePath`, and empty or relative `PATH` entries are removed from what terraform children get.
- **`tf_upgrade_impact` is opt-in** because it fetches and runs whichever provider the lock file names.

What this does **not** protect against:

- A plugin runs as your user. It can read anything you can, including `~/.aws/credentials`, `~/.terraform.d/credentials.tfrc.json`, the file `TF_CLI_CONFIG_FILE` names and the temporary copy of pulled state, and it can use the network.
- With `TERRAFORM_CWD_MCP_ALLOW_BACKEND_CREDENTIALS=1`, whoever can edit the directory controls what those variables reach: the backend configuration can send them to another endpoint or run a command that reads them, and editing `.terraform/terraform.tfstate` chooses which backend type's variables are passed. Set it only for directories whose contents you trust. Without it, such a command still runs, as your user, and can read your files like a plugin can.
- Keeping provider code out of the directory is your job: the boundary limits *where* the server looks, not what is planted inside it.
- Plan JSON can be forged. A summary of `plan_json` or a JSON file says what the document claims; only a binary plan is rendered by Terraform. The shape checks refuse the forgeries this server has seen (any instance address in `planned_values` or `prior_state` that the change, drift and deferred lists do not account for -- which catches a missing, emptied or decoy-replaced `resource_changes`, a managed delete relabelled as a data source is flagged as caller-supplied, a delete parked in `deferred_changes` is warned about) -- a new shape of forgery can always be found.
- An agent with a shell and the credential can bypass every control here. These controls cover what reaches an agent through this server.

Example `tf_summarize_plan` output (real plan, abridged):

```
plan (terraform 1.15.7, format 1.2): applyable, complete
totals: 1 delete, 5 replace, 1 update, 1 create, 0 read, 1 import, 1 move, 1 forget, 0 unchanged (terraform: 1 to import, 6 to add, 1 to change, 6 to destroy)
DELETE (1)
  - null_resource.gone (not in configuration)
REPLACE (5)
  -/+ local_sensitive_file.sf delete-then-create; forced by: content [sensitive]
  +/- random_string.cbd create-before-destroy; forced by: keepers
  ...
UPDATE (1)
  ~ terraform_data.cfg: input.version, output (known after apply)
WARNING: 6 object(s) will be destroyed (1 delete, 5 replace). 1 moved block(s) applied; none covers these.
```

Example `tf_upgrade_impact` output (real validate run):

```
upgrade hashicorp/random 2.3.1 -> 3.6.3 (major) for /work/infra
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

Example `tf_get_schema` output:

```
resource random_password (registry.terraform.io/hashicorp/random 3.9.1)
  bcrypt_hash: string computed (read-only) [sensitive] - A bcrypt hash of the generated random password. ...
  keepers: ["map","string"] optional - Arbitrary map of values that, when changed, will trigger recreation of resource. ...
  length: number required - The length of the password desired. ...
  number: bool optional+computed [deprecated] - Include numeric characters in the result. ...
  result: string computed (read-only) [sensitive] - The generated random password.
```

## Quick start

**1. Initialize the root module once** (you, not the server):

```bash
terraform init -backend=false
```

`-backend=false` is enough: the schema only needs the providers, not state.

**2. Add the server.** Claude Code, from the root module:

```bash
# macOS / Linux / WSL
claude mcp add terraform-cwd -- npx -y @yawlabs/terraform-cwd-mcp@latest

# Windows
claude mcp add terraform-cwd -- cmd /c npx -y @yawlabs/terraform-cwd-mcp@latest
```

Or add it to `.mcp.json` in the root module (or anywhere, and set `TERRAFORM_CWD_MCP_DIR`):

macOS / Linux / WSL:

```json
{
  "mcpServers": {
    "terraform-cwd": {
      "command": "npx",
      "args": ["-y", "@yawlabs/terraform-cwd-mcp@latest"]
    }
  }
}
```

Windows:

```json
{
  "mcpServers": {
    "terraform-cwd": {
      "command": "cmd",
      "args": ["/c", "npx", "-y", "@yawlabs/terraform-cwd-mcp@latest"]
    }
  }
}
```

> **Why the extra step on Windows?** Since Node 20, `child_process.spawn` cannot directly execute `.cmd` files (that's what `npx` is on Windows). Wrapping with `cmd /c` is the standard workaround.

**3. Restart your MCP client** and ask, for example: *"Add a versioned S3 bucket -- check the arguments against our pinned AWS provider first."*

## Tell your agent to use it

Agents use the server reliably when the project tells them to. Paste this into the root module's `CLAUDE.md` (or `AGENTS.md`):

```markdown
## Terraform provider schemas

This repo pins provider versions in `.terraform.lock.hcl`; registry docs and your
training data describe other versions. Use the terraform-cwd MCP server:

- Call `tf_list_providers` once per session to see the pinned versions.
- Before writing or editing any `resource`, `data` or `ephemeral` block, call
  `tf_get_schema` for that type.
- Call `tf_check_arguments` with every argument path you set (dotted for nested
  blocks, e.g. `versioning.enabled`). Never use an argument it reports as
  `UNKNOWN` or `READ-ONLY (computed)`; replace a `[deprecated]` one if the
  schema offers an alternative.
- Before calling a module, read its inputs with `tf_module_interface`.
- After `terraform plan -out=tfplan`, review it with `tf_summarize_plan`
  (plan_file: tfplan) and call out every DELETE and REPLACE.
- Before bumping a provider version, run `tf_upgrade_impact` (if the server has it enabled).
```

## Pairs well with

### HashiCorp's terraform-mcp-server

[hashicorp/terraform-mcp-server](https://github.com/hashicorp/terraform-mcp-server) answers registry and HCP questions; this server answers what is true in your working directory. Run both -- they do not overlap, and when they disagree the table says who wins:

| Question | Authority |
|---|---|
| Is argument X valid for the provider version I have pinned? | terraform-cwd-mcp |
| Which arguments I use break if I upgrade to vN? | terraform-cwd-mcp (`tf_upgrade_impact`) |
| What does this saved plan, this state, or this local / installed module contain? | terraform-cwd-mcp |
| How is resource X meant to be used? What do the docs and examples say? | terraform-mcp-server |
| What is the latest provider or module version? | terraform-mcp-server |
| Which public registry module should I use? | terraform-mcp-server |
| HCP Terraform / TFE workspaces and runs | terraform-mcp-server |
| An HCP run's plan | terraform-mcp-server fetches it (`get_run_details` -> plan id -> `get_plan_json_output(plan_id)`); `tf_summarize_plan` summarizes it (`plan_json`) |

The official server starts with only its `registry` toolset. The HCP / TFE rows need it started with `--toolsets=registry,terraform` (or `all`) and `TFE_TOKEN`. Its docs search tool is `search_provider_docs` from v1.3.1 on (`search_providers` before; a BREAKING rename), which matters if you allowlist tools by name.

### Yaw Mode skills

[Yaw Terminal](https://yaw.sh)'s Yaw Mode ships four skills that drive both servers, degrade gracefully when either is missing, and stop at `terraform plan` (they never apply or destroy):

- `/yaw-tf` -- everyday write / edit / fix: check every argument against the pinned schema, then fmt, validate, plan and summarize; hands off to the three below.
- `/yaw-tf-refactor` -- renames, module moves and imports with `moved` / `import` / `removed` blocks, done only when the plan shows zero destroys and replaces.
- `/yaw-tf-plan-review` -- go / no-go punch list for a local saved plan or an HCP run: destroys first, then checkov / trivy and IAM, network and encryption hot spots.
- `/yaw-tf-upgrade` -- provider bumps: latest version, `tf_upgrade_impact` (when enabled) against the arguments you actually use, the upgrade guide, then edits, re-pin, validate and plan.

## Configuration

All optional.

| Env var | Default | Purpose |
|---|---|---|
| `TERRAFORM_CWD_MCP_DIR` | the server's working directory | Root module used when a tool call passes no `dir`; also the directory tools are confined to. |
| `TERRAFORM_CWD_MCP_ALLOWED_DIRS` | (none) | More directories tools may use, separated like `PATH` (`:`, or `;` on Windows). |
| `TERRAFORM_CWD_MCP_ALLOW_UPGRADE` | (off) | `1` enables `tf_upgrade_impact`, which downloads and runs the provider named through the lock file. |
| `TERRAFORM_CWD_MCP_ALLOW_BACKEND_CREDENTIALS` | (off) | `1` passes a remote backend's own credential variables and proxy settings to `terraform state list`, `state pull` and `workspace list`. Backend configuration can run a command that sees them: see the security model. |
| `TERRAFORM_CWD_MCP_PASS_ENV` | (none) | Comma-separated variable names to pass to terraform children that are otherwise scrubbed, e.g. what a version-manager wrapper needs. Do not list credentials: provider plugins can read them. |
| `TERRAFORM_CWD_MCP_CACHE` | `~/.cache/terraform-cwd-mcp` | Where schema dumps are cached (`<key>.json`). Safe to delete at any time. |
| `TERRAFORM_CWD_MCP_BINARY` | `terraform` | Binary to run, e.g. a full path, or `tofu` for OpenTofu (same `providers schema -json` output). |
| `TERRAFORM_CWD_MCP_TIMEOUT_MS` | `300000` | Kill any terraform command (schema dump, state read, target init, validate) after this long. |
| `TERRAFORM_CWD_MCP_PLUGIN_CACHE` | `TF_PLUGIN_CACHE_DIR`, else `<cache>/plugins` | Where `tf_upgrade_impact` keeps downloaded provider packages. |

**Runtime (oam or Node):**

The `terraform-cwd-mcp` command prefers [oam](https://oamjs.org) when it finds a
usable one and otherwise runs on Node. It never serves on an oam older than 0.21.1.

| Env var | Default | Purpose |
|---|---|---|
| `TERRAFORM_CWD_MCP_RUNTIME` | `auto` | `auto`: the newest oam at 0.21.1 or newer, else Node. `oam`: oam or exit with an error. `node`: always Node -- the escape hatch when a problem only shows up under oam. |
| `OAM_BIN` | (unset) | Path to the oam binary to use. Otherwise the launcher checks `OAM_INSTALL_DIR`, the installed locations (`~/.oam/bin`, and `%LOCALAPPDATA%\oam\bin` on Windows) and `PATH`, and takes the newest. |

An outdated oam is fixed with `oam self-update`. Under Yaw MCP, which runs servers
on oam by default, `yaw-mcp set <namespace> runtime=node` switches this server to
Node. There is no `--permission` sandbox option: the server spawns `terraform`, which
starts provider plugins, so there is nothing narrow to grant.

## Requirements

- Node.js 20+
- Terraform (or OpenTofu) on `PATH`, recent enough to have `terraform providers schema -json` (0.12+; ephemeral resources need 1.10+)
- An initialized root module (`.terraform/` and `.terraform.lock.hcl` present) for every tool except `tf_module_interface` on the root or a local path, and `tf_summarize_plan` with plan JSON
- State tools: the backend initialized (`terraform init`, not `-backend=false`), and credentials Terraform can find without environment variables, or those variables in the server's environment plus `TERRAFORM_CWD_MCP_ALLOW_BACKEND_CREDENTIALS=1`
- `tf_upgrade_impact`: `TERRAFORM_CWD_MCP_ALLOW_UPGRADE=1`, and registry access the first time a target version is requested (later runs for that version are offline)
- `.terraform/` at `<dir>/.terraform`: `TF_DATA_DIR` is not honoured

## Contributing

```bash
git clone https://github.com/YawLabs/terraform-cwd-mcp.git
cd terraform-cwd-mcp
npm install
npm run lint       # Biome check
npm run lint:fix   # Auto-fix
npm run build      # tsup bundle + declarations
npm test           # Vitest (the integration test runs only when terraform is on PATH)
npm run typecheck  # oam check . when oam is installed, else tsc --noEmit
npm run check:oam-floor  # the oam floor agrees across the repo and matches the latest oam release
```

See [CONTRIBUTING.md](CONTRIBUTING.md) for the full workflow, including release process.

## License

MIT

[![Follow @YawLabs on X](https://img.shields.io/badge/follow-%40YawLabs-000000?logo=x&logoColor=white)](https://x.com/YawLabs)
