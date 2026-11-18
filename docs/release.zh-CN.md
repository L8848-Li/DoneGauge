# DoneGauge 发布到 dsh-market

首发建议用 **v0.1.0 公开预览版**。发布预构建的 GitHub Release 安装包，
再向市场的数据目录提交收录 PR。安装包包含编译后的 CLI 和 DSH 插件，
用户可以在关闭安装脚本的情况下安装。npm 发布可以后续单独安排。

当前进度见 [验证记录](validation.md)。公开 Release 和目录收录由维护者确认后提交。

## 发布前

1. 在 `main` 确定待发布提交。[GitHub CI](https://github.com/L8848-Li/DoneGauge/actions/workflows/ci.yml) 提供 Ubuntu、macOS、Windows 和 Node.js 22 的检查记录。开发阶段可以直接推送 `main`，发行工作流会单独检查自己打包的提交。
2. 按下方命令从待发布提交构建一次，用同一个 `.tgz` 验证 CLI 和 DSH 宿主。核对 [DSH 兼容版本和配置方式](dsh.md)。
3. 按 [#2](https://github.com/L8848-Li/DoneGauge/issues/2) 在隔离的 Desktop 或 Web profile 中走一遍真实对话。用 JUnit 示例验证工具调用和报告落盘，用混合示例确认四种状态能如实展示。再检查配置摘要过期、权限拒绝和用户取消，记录宿主版本、profile 和结果。

```sh
# 在 DoneGauge 仓库根目录，使用仓库要求的 Node.js 和已安装的兼容 DSH
python3 -m venv .donegauge/release-venv
. .donegauge/release-venv/bin/activate
python -m pip install -r tests/requirements.txt
npm ci --ignore-scripts
npm run check

mkdir -p .donegauge/release
npm pack --pack-destination .donegauge/release
npm run test:package -- .donegauge/release/donegauge-0.1.0.tgz
npm run test:dsh-host -- .donegauge/release/donegauge-0.1.0.tgz
(
  cd .donegauge/release
  shasum -a 256 donegauge-0.1.0.tgz > donegauge-0.1.0.tgz.sha256
)
```

从 PATH 使用 DSH CLI 时，在 `npm run test:dsh-host` 前设置 `DONEGAUGE_DSH_EXECUTABLE=dsh` 和 `DONEGAUGE_DSH_CLI_ENTRY=''`。macOS 默认用本机 DeepSeek Harness 应用内置的 CLI。

## 发布与收录

1. 在 [DoneGauge 仓库](https://github.com/L8848-Li/DoneGauge) 增加 `dsh-plugin` topic，目录以它识别插件仓库。
2. 在 Actions 的 [Draft GitHub release](https://github.com/L8848-Li/DoneGauge/actions/workflows/release.yml) 手动从 `main` 触发。流程验证该次提交、生成版本对应的 `.tgz` 和 SHA-256、实际安装同一包，并创建明确指向该提交的预发布草稿。维护者确认附件后可发布草稿。在发布说明中链接 [DSH 配置指南](dsh.md)，写明需要绑定项目并审阅检查命令。
3. 向 [awesome-dsh-plugin](https://github.com/awesome-dsh-plugin/awesome-dsh-plugin) 提交 PR，添加 `data/plugins/L8848-Li__DoneGauge.yml`。使用上一步发布的固定版本资产链接。 [市场投稿说明](https://github.com/dsh-market/dsh-market#submit-your-plugin) · [目录贡献指南](https://github.com/awesome-dsh-plugin/awesome-dsh-plugin/blob/main/contributing.md)
4. 目录 PR 合入后，在 dsh-market 搜索 DoneGauge，确认条目显示正确的描述和安装源。再从市场装入测试 profile，配置项目并验证报告。

```yaml
url: https://github.com/L8848-Li/DoneGauge
name: L8848-Li/DoneGauge
category: workflow
description:
  en: 'Verify AI coding tasks with local commands and named JUnit tests, and save evidence for each acceptance criterion.'
  zh: '用本地命令和指定的 JUnit 测试验收 AI 编程任务，在本地报告中查看每条验收条件的证据。'
tarball: https://github.com/L8848-Li/DoneGauge/releases/download/v0.1.0/donegauge-0.1.0.tgz
```

## 从 GitHub Release 下载和校验

预览版公开后，以下命令在你的项目目录下载并安装对应版本。维护者也可在公开前用已登录的 `gh` 验证草稿附件。

```sh
gh release download v0.1.0 --repo L8848-Li/DoneGauge \
  --pattern donegauge-0.1.0.tgz --pattern donegauge-0.1.0.tgz.sha256
shasum -a 256 -c donegauge-0.1.0.tgz.sha256
npm install --save-dev ./donegauge-0.1.0.tgz
npx --no-install donegauge --version
```

## npm 发行

当前公共包名计划为 `donegauge`。公开注册表查询返回 404，维护者需先用自己的 npm 账户确认包名并完成首次发行，之后在包设置中添加仅允许暂存的 GitHub Trusted Publisher。填写账号 `L8848-Li`、仓库 `DoneGauge`、工作流 `npm-release.yml`。参考 [npm 可信发布说明](https://docs.npmjs.com/trusted-publishers/)。

后续发行从手动运行 [Stage or verify npm release](https://github.com/L8848-Li/DoneGauge/actions/workflows/npm-release.yml) 开始。输入已公开的 GitHub Release 版本并选择 `stage`。流程校验相同版本的 Release 附件，通过 OIDC 提交暂存，维护者在 npm 用 2FA 审批。公开后用 `verify` 安装该版本并核对名称、仓库、许可证、真实 Node/Python 验收及报告。验证成功后更新 README 公共安装入口。

## 维护者待办

- 开发阶段允许直接推送 `main`。进入需要 PR 审查的阶段时，按 [#4](https://github.com/L8848-Li/DoneGauge/issues/4) 配置必需检查和分支保护。
- [#6](https://github.com/L8848-Li/DoneGauge/issues/6) 记录 npm 账户确认、公开发行与安装验证。GitHub Release 是当前预览版的分发入口。
