# 发布流程（维护者）

包名：`@lytharalab/dsh-cons-auto-review` · 仓库：`LytharaLab/DSH-Cons-Auto-Review` · 发布目标：<https://registry.npmjs.org>

## 一次性准备

1. 确认自己的 npm 账号对 `@lytharalab` scope 有发布权限：

   ```bash
   npm login --registry=https://registry.npmjs.org/
   npm org ls lytharalab
   ```

2. **首次发布**：由于 scoped 包默认是私有可见性，必须在首次发布时显式指定公开：

   ```bash
   npm publish --access public
   ```

   `package.json` 的 `publishConfig` 已经固定 `registry` 与 `access`，所以即使本机默认 registry 指向镜像也不会发错地方；`prepublishOnly` 会在真正上传前跑一次 `npm run verify`。

   这一次发布不经过 CI，因此**不带 provenance**；从下一个版本起由工作流发布，都会附带来来源证明。已手工发布过的版本不能再由 CI 重复发布（registry 认为版本已存在），标签推送从新版本号开始。

   > npm 已停止签发经典 publish token（2025-11-05 起创建被禁用，存量 token 于 2025-12 前后被吊销）。不要再用 `NPM_TOKEN` 这类长期令牌，改用下面的 Trusted Publishing。

3. **配置 Trusted Publishing（OIDC）**：包必须已经存在于 registry，`npm trust` 才能给它配置信任关系（npm 文档明确写了 "Package must exist"），所以首次发布只能手工完成。之后用 CLI 配置，比网页点选更不容易写错：

   ```bash
   npm trust github @lytharalab/dsh-cons-auto-review \
     --repo LytharaLab/DSH-Cons-Auto-Review \
     --file publish.yml \
     --allow-publish -y
   ```

   也可在网页上配置：包的 Settings → **Trusted Publisher**，填 Organization or user = `LytharaLab`、Repository = `DSH-Cons-Auto-Review`、Workflow filename = `publish.yml`、Environment 留空。

   这几项必须与 `.github/workflows/publish.yml` 完全一致：npm 只在发布那一刻校验，不匹配时只会给出 `404` 或 `ENEEDAUTH`，看不出是哪一项错了。配置完成后就不需要任何 secret。可用 `npm trust list @lytharalab/dsh-cons-auto-review` 核对，用 `npm trust revoke --id <id>` 撤销。

   > `npm trust` 要求 npm ≥ 11.15.0、账号开启 2FA，且不支持带 bypass 2FA 的 Granular Access Token——请用交互式 `npm login` 登录，不要贴 token。OIDC 发布本身需要 npm ≥ 11.5.1（随 Node ≥ 22.14.0 提供）；工作流固定用 Node 24，满足要求。另外不要在发布步骤里设置空的 `NODE_AUTH_TOKEN`——它会让 npm 退回 token 认证而不再走 OIDC。

## 每次发版

1. 更新 `package.json` 的 `version`，在 `CHANGELOG.md` 顶部补一条对应版本说明。
2. 本地验证并按需刷新离线产物：

   ```bash
   npm ci --legacy-peer-deps
   npm run verify
   npm pack --ignore-scripts
   ```

3. 提交并打标签，标签名与版本一致（`v` 前缀可省略检查，但必须与 `package.json` 的版本号一致）：

   ```bash
   git commit -am "1.1.1"
   git tag v1.1.1
   git push origin main --tags
   ```

4. `.github/workflows/publish.yml` 会校验 tag 与版本号一致、跑一遍 `npm run verify`、以 Trusted Publishing 发布（附带 provenance），最后用生成式说明创建 GitHub Release。

## 工作流的几个约定

- 打标签（`v*`）触发真正的发布；手动 `workflow_dispatch` 只会跑校验与 `npm publish --dry-run`，不会真的上传。
- 只有 `publish.yml` 会执行 `npm publish`。npm 的 trusted publisher 绑定的是 workflow 文件名，出现第二个能发布的 workflow 会互相干扰。
- 发布步骤使用 `--access public --provenance`；`actions/setup-node` 故意**不设置** `registry-url`，避免生成依赖 `NODE_AUTH_TOKEN` 的 `.npmrc`，发布目标由 `publishConfig.registry` 决定。
- `.github/workflows/ci.yml` 在每次推送与 PR 上跑 Node 22/24 × DSH `0.1.7-rc.2` / `0.2.0-rc.2` 矩阵，另外单独校验 npm 包内容：必需文件齐全、`tests/`、`test-results/`、`.github/` 不得进入发布包。

## 发布包内容

`package.json` 的 `files` 字段决定 npm 包内容：`src`、`locale`、`cordis.patch.yml`、`icon.svg`、`docs`、`examples`、`README.md`、`CHANGELOG.md`、`LICENSE` 与第三方声明。测试、测试记录和 `.github` 只留在 Git 仓库里。用 `npm pack --dry-run` 可以先确认。

## 离线产物

需要给别人 `.tgz` 时：

```bash
npm pack --ignore-scripts
sha256sum lytharalab-dsh-cons-auto-review-<version>.tgz
```

把结果写进 `SHA256SUMS`（该文件同时记录仓库内所有文件的校验和，可用下面的命令整体刷新）：

```bash
node --input-type=module -e "
import { readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
const skip = new Set(['node_modules', '.git']);
const files = [];
(function walk(prefix) {
  for (const e of readdirSync(prefix || '.', { withFileTypes: true })) {
    if (skip.has(e.name)) continue;
    const p = prefix ? prefix + '/' + e.name : e.name;
    if (e.isDirectory()) walk(p); else files.push(p);
  }
})('');
files.sort();
writeFileSync('SHA256SUMS', files.filter((f) => f !== 'SHA256SUMS')
  .map((f) => createHash('sha256').update(readFileSync(f)).digest('hex') + '  ' + f)
  .join('\n') + '\n');
"
```

`.gitignore` 已忽略 `*.tgz`，不要把压缩包提交进仓库；需要长期提供时挂到 GitHub Release 上。

## 改名带来的 profile 侧改动

包名从 `dsh-cons-auto-review` 改为 scoped 名后，已安装的 profile 需要同步：`package.json` 的依赖键与 `dsh.profile.bundles` 由 `dsh plugin --profile desktop add` 自动重写；若 profile 的 `cordis.patch.yml` 中存在带 `name` 的 `id: dcar` 覆盖或禁用行，必须手动改成新包名——否则该行会被 `patch: name mismatch ... skipping` 跳过，插件在插件管理器里也会变成只读。旧 `compatibility.json` 中按「包名@版本」记录的豁免项同样会失效，需要重新确认。
