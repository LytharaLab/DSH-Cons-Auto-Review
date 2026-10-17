# Third-party notices

This project includes adapted code from [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness/tree/639ed015397290b3745d163aafe02ffee4aa3f84), copyright (c) 2026 DeepSeek, under the MIT License. The full license is reproduced in `LICENSE` and `THIRD_PARTY_LICENSE.txt`.

- `src/upstream-reviewer.js`: request snapshot, source-role handling, native/PTC identity checks, strict streaming decision reader and base policy, adapted from `packages/experimental/auto-review/src/index.ts`. DCAR adds the medium-risk `ask` protocol, exposes helpers and uses its own review routing/lifecycle.
- `src/containment.js`: adapted from `packages/fs/fs-sandbox/src/containment.ts`, retaining canonical path and filesystem identity containment.
- `src/paths.js`: uses the host DSH filesystem resolver and the public `writableRoots()` function from `@deepseek-ai/dsh-sandbox`.
- `src/permission-presets.js`: subclasses the host DSH permission service, adding effect-scoped custom review presets and an absent-provider guard; the upstream base implementation stays in the host's installed package.

The project's npm peer and development dependencies keep their own license terms. No dependency source or `node_modules` is included in the project ZIP or npm package.

DCAR 1.2.1 also follows the working-directory snapshot change in [DeepSeek Harness 687f282e8625c6b8d11ff58211a90524be2e4317](https://github.com/deepseek-ai/deepseek-harness/tree/687f282e8625c6b8d11ff58211a90524be2e4317), under the same MIT License.
