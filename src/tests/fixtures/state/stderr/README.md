Real stderr captured from Terraform 1.15.7 (windows_amd64) with `-no-color`, 2026-10-14.

- `state-locked-windows.txt` / `show-locked-windows.txt`: `terraform state list` / `terraform show -json` while another
  `terraform apply` held the local-backend lock (Windows byte-range lock blocks readers).
- `state-list-no-state.txt`: `terraform state list` in an initialized root with no state (exit 1). `terraform show -json`
  in the same root prints `{"format_version":"1.0"}` and exits 0 (see `../no-state.json`).
- `s3-no-credentials.txt`: `terraform state list` against an initialized s3 backend with no AWS credentials.
- `backend-init-required.txt`: `terraform state list` after `terraform init -backend=false` with an s3 backend block.
- `s3-missing-workspace-write-attempt.txt`: `TF_WORKSPACE=ghost terraform state list` against a (fake) s3 endpoint: the
  backend issued HEAD then PUT for `env:/ghost/...` -- reading a missing workspace makes Terraform try to CREATE it.
- `http-401-requires-auth.txt` / `http-403-invalid-auth.txt`: `terraform state list` against an initialized `http`
  backend whose endpoint answers 401 / 403 (2026-10-15). Terraform prints no status number. The endpoint saw only
  `GET /state` (no LOCK, UNLOCK or POST) from `state list` and `show -json`.
