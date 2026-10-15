# Test fixtures

All JSON here is real Terraform 1.15.7 output (windows_amd64), generated 2026-10-14 in temp dirs. Values Terraform
marks sensitive (and every identical string) were replaced with `FIXTURE-SECRET-NN` sentinels so no real key material
or password is committed; structure, markers and every non-sensitive value are untouched. Tests assert that no tool
output ever contains `FIXTURE-SECRET` or `FIXTURE-plain` (the latter are deliberately unmarked secrets that only the
key-name heuristic catches).

- `schema.json`, `tfroot/` -- existing schema-tool fixtures (random 3.9.1 + tls 4.4.1).
- `plan/plan.json` -- `terraform show -json` of a saved plan: delete, 5 replaces (one create_before_destroy), update
  with a sensitive nested attr, create, import (no-op), moved (no-op), removed/forget, drift (file deleted outside
  Terraform), sensitive output update, new output. `plan/plan-ui-stream.jsonl` is `terraform plan -json` (UI stream,
  NOT a plan representation) for the wrong-input test.
- `state/state.json` -- `terraform show -json` state: count + for_each instances, data source, module resource,
  terraform_data whose `output.pw` repeats a sensitive value WITHOUT a marker, and `terraform_data.with_token` whose
  secret-named keys carry no marker. `state/no-state.json` is the no-state output. `state/stderr/` has real errors.
- `modroot/` -- root module for tf_module_interface: local module `modules/naming`, registry module
  `cloudposse/label/null` 0.25.0 (Apache-2.0, LICENSE kept) under `dot-terraform/modules/` (rename to `.terraform`
  when copying to a temp dir; `.terraform/` is gitignored). The label module's files are CRLF exactly as git
  checked them out on Windows -- kept byte-for-byte via .gitattributes `-text`.
- `upgrade/` -- tf_upgrade_impact: `uproot/` pins tls 3.4.0 + random 2.3.1 (local name `rnd`), `schema-pinned.json` is
  its dump, `schema-tls-4.0.6.json` / `schema-random-3.6.3.json` are target dumps, `validate-*.json` are real
  `terraform validate -json` results for the baseline and each target.
- `upgrade/schema-kubernetes-1.13.4-provider.json` / `schema-kubernetes-2.0.0-provider.json` -- the `provider` block
  only, cut from real `terraform providers schema -json` dumps of hashicorp/kubernetes 1.13.4 and 2.0.0 (resource
  schemas dropped for size); 2.0.0 removed `load_config_file` from the provider block.
