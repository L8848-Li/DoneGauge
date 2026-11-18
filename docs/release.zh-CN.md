# DoneGauge 发布到 dsh-market

首发建议用 **v0.1.0 公开预览版**。发布预构建的 GitHub Release 安装包，
再向市场的数据目录提交收录 PR。安装包包含编译后的 CLI 和 DSH 插件，
用户可以在关闭安装脚本的情况下安装。npm 发布可以后续单独安排。

当前进度见 [验证记录](validation.md)。公开 Release 和目录收录由维护者确认后提交。

## 发布前

1. 将 [JUnit 结果检查器 #1](https://github.com/L8848-Li/DoneGauge/issues/1) 和发布准备改动合入 `main`，确认最终提交的 [GitHub CI](https://github.com/L8848-Li/DoneGauge/actions/workflows/ci.yml) 通过，包括 Ubuntu、macOS 和 Node.js 22 兼容性检查。
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
2. 从已验证的 `main` 提交创建 `v0.1.0` GitHub Release 草稿，上传 `donegauge-0.1.0.tgz` 及 `donegauge-0.1.0.tgz.sha256`，核对下载包的校验值。在发布说明中链接 [DSH 配置指南](dsh.md)，写明需要绑定项目并审阅检查命令。检查完后发布为公开预览版。
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

## Issue 优先级

| 阶段     | 事项                                                                                                                                                                                                         |
| -------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| 预览前   | [#1 JUnit 验收证据](https://github.com/L8848-Li/DoneGauge/issues/1)、[#2 真实 DSH 对话验证](https://github.com/L8848-Li/DoneGauge/issues/2)、[#5 发布安装包](https://github.com/L8848-Li/DoneGauge/issues/5) |
| 补齐保障 | [#4 合并保护](https://github.com/L8848-Li/DoneGauge/issues/4)、[#7 增加示例断言覆盖](https://github.com/L8848-Li/DoneGauge/issues/7)                                                                         |
| 后续发布 | [#3 Windows 支持](https://github.com/L8848-Li/DoneGauge/issues/3)、[#6 npm 发布](https://github.com/L8848-Li/DoneGauge/issues/6)                                                                             |
