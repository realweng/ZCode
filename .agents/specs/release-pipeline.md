# 发版打包流水线（tag 触发）

## 行为

- GitHub Actions workflow（`.github/workflows/release-build.yml`）只在 push 匹配 `v*` 的 tag（release-it 产出 `v{version}`）时自动触发；另保留 `workflow_dispatch` 人工调试入口（不改变"自动触发只认 tag"的语义）。
- 三个原生 runner 并行打包：
  - `macos-latest`（arm64）→ `--os mac --arch arm64` → 未签名 DMG + zip
  - `windows-latest` → `--os win --arch x64` → NSIS 安装器 exe（配置中的 Windows 平台一致性断言要求在 win32 原生构建）
  - `ubuntu-latest` → `--os linux --arch x64 --targets deb` → 仅 deb 包
- 三平台全部成功后，release job 下载全部 artifacts 并上传到 tag 对应的 GitHub Release（不存在则创建），附带各产物 sha256 校验文件。

## 状态所有者与边界

- 打包入口唯一：`pnpm bundle:desktop`（`packages/desktop/scripts/bundle.mjs`）。workflow 不直接调用 electron-builder，避免旁路 `prepare:runtime-assets → build → electron-builder → 运行时依赖机械校验 → 体积审计` 链路。
- electron-builder 统一携带 `--publish never`：CI tag 环境下它默认隐式启用 onTag 发布并向配置中的 generic 占位地址（localhost）上传而必然失败；打包与发布解耦，产物上传统一由 release job 挂载 GitHub Release。本地无 CI/tag 环境本就不发布，行为不变。
- `bundle.mjs` 新增 `--targets <a,b,...>`（等价环境变量 `ZCODE_TARGETS`）：值追加到 electron-builder 的目标平台参数之后（如 `--linux deb`）；默认不传保持现状（全量目标）。产物定位与体积审计沿用现有 `artifactExtensionsByOs` 匹配，`--targets deb` 时匹配 `.deb`，行为不变。
- CI 不承载业务状态；产物事实源是各 job 的 `packages/desktop/dist` 与 workflow artifacts。

## 失败语义

- 任一平台 job 失败 → release job 不执行（`needs` 全绿才跑）。
- electron-builder 下载类失败沿用 bundle.mjs 内置的镜像回退与 3 次重试，workflow 层不重复造重试。
- 同一 tag 重复推送由 `concurrency`（按 ref 分组）取消旧运行，避免并发写同一 Release。
- 非 tag 的 push / PR 不触发本 workflow。

## 不做 / 迁移边界

- 不做代码签名与公证：mac 不设置 `ZCODE_ENABLE_MAC_SIGN`（与本地未签名打包一致）；workflow 仅预留 `APPLE_SIGNING_IDENTITY` secrets 透传位。两段式签名+公证流水线不在本仓库范围。
- 不在发版流水线内做 typecheck/lint 门禁（单一职责；PR CI 可后续单独增加）。
- CLI 发行包（tar.gz / install.sh）与 SEA 单文件路径不在本流水线范围。

## 验收场景

1. `pnpm bundle:desktop -- --os linux --arch x64 --targets deb --dry-run` 打印的 electron-builder 命令包含 `--linux deb`。
2. 推送 `v*` tag → 三个 job 均产出对应安装包，Release 页出现 DMG/zip、exe、deb 与 sha256 文件。
3. 普通 commit push 不触发任何 job。
