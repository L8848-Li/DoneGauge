# DoneGauge

**给 AI 辅助开发加上可追溯的验收**

把「拒绝重复邮箱」这样的验收条件绑定到具体测试。DoneGauge 在本地运行你批准的检查，保存验收结果及相关的 Git 变更、命令日志和本次运行的 JUnit XML。每项条件是否通过、哪里还需要复核，都能从报告里查到。

[English](README.md) · [三分钟演示](#三分钟-junit-演示) · [接入 DeepSeek Harness](#接入-deepseek-harness) · [配置说明](docs/configuration.md) · [发行与上架进度](docs/release.zh-CN.md)

## 安装

独立命令行工具需要 **Node.js 22+**、npm 和 Git，可在本地运行，无需 API Key。[DSH 适配器](#接入-deepseek-harness)有单独的运行环境要求。

在项目源码目录执行：

```sh
git clone https://github.com/L8848-Li/DoneGauge.git
cd DoneGauge
npm ci --ignore-scripts
npm run build
node dist/src/cli.js --help
```

目前可从源码构建。要在自己的项目中使用，可以先打包，再安装本地安装包：

```sh
# DoneGauge 源码目录
npm pack

# 你的项目目录，替换实际安装包路径
npm install --save-dev /path/to/DoneGauge/donegauge-0.1.0.tgz
npx --no-install donegauge --version
```

## 三分钟 JUnit 演示

构建完成后，在源码目录运行以下命令。脚本会创建临时 Git 项目，按名称运行三条真实的 Node.js 测试。

```sh
node scripts/demo.mjs node-registration --junit --run
```

预期 **3 项 PASS**，对应重复邮箱拒绝、带独立盐值的密码存储和注册后登录。按终端打印的路径打开临时项目里的 `report.md`，可以看到每项匹配的测试名和本次生成的 JUnit XML 路径。去掉 `--run` 可先准备示例并审阅命令。

查看包含四种状态的示例：

```sh
node scripts/demo.mjs node-registration --mixed --run
```

此示例包含真实的登录回归、缺少检查的验收条件和无法启动的审计命令。预期四种状态各一项，退出码为 2。

[更多可运行示例](examples/README.md)包含 Python 购物车，提供标准库 `unittest` 和 pytest/JUnit 两种配置。

## 接入 DeepSeek Harness

DoneGauge 通过 DSH 官方插件接口注册 `donegauge_check`。已验证 **DSH 0.2.2-rc.3 和 0.2.2-rc.4**，需要 Node.js 24.9 或更新版本。可按 [DSH 指南](docs/dsh.md)从源码加载，或安装本地打包产物。[发行指南](docs/release.zh-CN.md)记录市场上架进度。

审阅目标项目的 `donegauge.json` 后，计算该配置的 SHA-256 摘要。

```sh
node /path/to/DoneGauge/dist/src/cli.js config-hash --cwd /path/to/project
```

在本地 DSH patch 中绑定项目 Git 根目录的绝对路径和该摘要，再把下面这句话发给 DSH。

> 请调用 `donegauge_check`，核验本项目配置的验收条件。

工具调用参数为 `{}`。项目和检查命令由本地配置决定。配置变动后需要重新审阅并更新摘要，才能再次运行。在 Desktop 或 Web 展开工具调用组，即可查看四种状态、逐项证据和本地报告入口。真实桌面调用、授权拒绝和取消场景见[验证记录](docs/validation.md#desktop-card-and-cancellation-verification-2026-11-18)。

## 在自己的项目中使用

```sh
npx --no-install donegauge init
```

编辑生成的文件，把验收条件关联到项目已有的测试。`init` 会保留已有配置，执行检查仍需你批准。

```json
{
  "version": 1,
  "task": "注册时拒绝重复邮箱",
  "criteria": [
    {
      "id": "duplicate-email",
      "description": "拒绝重复邮箱",
      "check": {
        "kind": "junit",
        "command": [
          "node",
          "--test",
          "--test-reporter=junit",
          "--test-reporter-destination={evidenceDir}/junit.xml",
          "--test-name-pattern=duplicate email",
          "registration.test.mjs"
        ],
        "junit": {
          "file": "{evidenceDir}/junit.xml",
          "tests": [
            { "name": "duplicate email is rejected", "className": "test" }
          ]
        }
      }
    },
    { "id": "audit", "description": "完成独立安全审查" }
  ]
}
```

```sh
npx --no-install donegauge check
npx --no-install donegauge check --allow-run
npx --no-install donegauge check --allow-run --base main --json
```

第一条命令仅预览，结果为 UNVERIFIED。后两条会以本地用户权限执行已授权的检查。命令由可执行文件和逐项参数组成，执行前请审阅命令和项目代码。只需检查退出码或日志时，可使用[命令检查配置](docs/configuration.md#fields)。

## 阅读报告

混合示例的摘要如下；实际报告还包括运行编号、命令、日志和执行时间：

```text
[PASS] email: Duplicate email is rejected
[FAIL] login: User can log in with the regressed implementation
[UNVERIFIED] audit: Security audit completed (no check configured)
[ERROR] missing-tool: External audit command can execute

Summary: 1 verified, 1 failed, 1 unverified, 1 errors
Final status: REVIEW REQUIRED
```

| 状态       | 含义                                                              |
| ---------- | ----------------------------------------------------------------- |
| PASS       | 本次 JUnit 报告显示指定测试通过，或命令检查满足退出码和输出约定。 |
| FAIL       | 正常完成的检查明确违背预期结果。                                  |
| UNVERIFIED | 没有检查、没有执行，或必要输出可能因截断而丢失。                  |
| ERROR      | 启动失败、超时、中断等执行异常，不能据此证明功能有缺陷。          |

JUnit 的 PASS 还要求本次报告完整、目标测试唯一匹配且实际执行并通过；缺失、跳过、歧义或文件级外壳为 UNVERIFIED。详见 [JUnit 判定规则](docs/configuration.md#junit-checks)。

报告保存在 `.donegauge/runs/<运行编号>/report.md` 和 `report.json`。建议在 `.gitignore` 中加入 `.donegauge/`。此保留目录不作为未跟踪代码变更采集，但其中已跟踪文件仍被检查。

退出码：0 为全部通过且工作区稳定；1 为需要复核；2 为执行或配置异常。`--json` 的标准输出只有 JSON，报告路径写入标准错误。报告保留原始日志，可能包含私有代码或敏感内容；只存本地，不自动上传或脱敏。

## 已知限制

- 检查是否足以证明验收条件，由用户负责。退出码 0 仅证明命令约定满足；建议添加明确输出或测试数量预期，避免把空跑当作充分验证。
- JUnit 支持精确名称和可选类名，每个条件独立命令；尚无自动发现或生成测试、失败到源码定位、重试编排和评分。
- 检查顺序执行；前后 Git 指纹不是原子快照或签名证明。忽略文件及子模块内部未提交内容不被完整追踪。
- 默认每条命令保留 64 KiB 输出，Git 差异展示上限 256 KiB；文件元数据超限会停止采集，不会静默漏掉文件。
- 重命名按删除和新增显示；不自动拉取远程仓库或选择任务基准。
- [GitHub CI](https://github.com/L8848-Li/DoneGauge/actions/workflows/ci.yml) 在 Ubuntu、macOS、Windows 上验证 Node 24 的 CLI，并在 Ubuntu 验证 Node 22 的核心功能。Windows 的批处理与进程树约束见[配置说明](docs/configuration.md#commands-and-authorization)。
- DSH 检查使用宿主用户权限。启用前请了解[执行和授权细节](docs/dsh.md#returned-result-and-execution-permission)。

## 开发与路线图

```sh
python3 -m pip install -r tests/requirements.txt # 建议使用虚拟环境
npm run check
npm run test:package
npm run test:dsh-host  # 可选，需要已安装的兼容 DSH
```

[贡献指南](CONTRIBUTING.md) · [架构](docs/architecture.md) · [实际验证记录](docs/validation.md) · [开放 issues](https://github.com/L8848-Li/DoneGauge/issues)

## 许可证

[MIT](LICENSE)。依赖许可见 [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md)。
