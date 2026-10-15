# tree-sitter-hcl.wasm

Vendored HCL grammar for `web-tree-sitter`, used by `src/hcl.ts` (tf_module_interface, tf_upgrade_impact).

- Upstream: https://github.com/tree-sitter-grammars/tree-sitter-hcl (Apache-2.0, see `LICENSE` here)
- Taken from the npm package `@tree-sitter-grammars/tree-sitter-hcl@1.2.0`
  (https://registry.npmjs.org/@tree-sitter-grammars/tree-sitter-hcl/-/tree-sitter-hcl-1.2.0.tgz),
  file `tree-sitter-hcl.wasm`, built from upstream commit `fad991865fee927dd1de5e172fb3f08ac674d914` (the package's `gitHead`).
- sha256: `86bb80cd151bd3ab1e44ed431a9c1874978db31519c62055efb50f028a1d0118`
- Runtime: `web-tree-sitter` 0.27.1 (pinned exactly in package.json).

Why vendored instead of depending on the npm package: the package ships native sources, `binding.gyp` and an
install script (`node-gyp-build`) this server does not need; only the 92 KB WASM is used.

To update: `npm pack @tree-sitter-grammars/tree-sitter-hcl@<v>` in a scratch dir, copy `tree-sitter-hcl.wasm` and
`LICENSE` here, update the version, commit and sha256 above, and run `npm test` (the oracle test in
`src/tests/hcl.test.ts` compares the reader with Terraform's own evaluation of the fixture modules).
