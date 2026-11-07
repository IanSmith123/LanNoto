# LanNoto 开发文档

[English README](../README.md) · [中文介绍](../readme_zh.md) · [项目设计](../design.md)

## 构建

源码构建需要 Go 1.26.10+、Node.js 和 npm。浏览器自动化使用已安装的 Google Chrome，Word 导出集成测试使用主机上的 Pandoc，实测版本为 3.8.3。

从项目根目录运行以下命令。

```powershell
npm --prefix web ci
npm --prefix web run build
go build -o dist/lannoto.exe ./cmd/lannoto
```

PowerShell 限制 `npm.ps1` 时可用 `npm.cmd`。Linux 和 macOS 将程序输出改为 `dist/lannoto`，发布构建使用 `CGO_ENABLED=0`。

Vite 将生产前端写入 `internal/webassets/dist/`。Go 用 `embed` 将前端及字体打包进二进制。每次生产前端构建生成一个 build ID。协作握手发现构建不一致时会提示浏览器刷新。

## 本地开发循环

前端代码在 `web/src/`，Go 入口在 `cmd/lannoto/`，服务端逻辑在 `internal/`。首次检出或前端依赖变更后运行 `npm --prefix web ci`。修改前端后重新运行 `npm --prefix web run build`，再构建 Go 程序。只改 Go 时可以复用已经生成的前端。

构建完成后，从项目根目录执行以下命令，使用独立的演示工作区启动服务。停止服务后回到项目根目录继续构建和测试。

**Windows（PowerShell）**

```powershell
New-Item -ItemType Directory -Force dist/dev-workspace | Out-Null
Set-Location dist/dev-workspace
..\lannoto.exe --host 127.0.0.1 --port 8080
```

**Linux（Shell）**

```sh
mkdir -p dist/dev-workspace
cd dist/dev-workspace
../lannoto --host 127.0.0.1 --port 8080
```

打开 `http://127.0.0.1:8080`，用启动日志中的密码登录。修改完成后运行 [测试](#测试)，提交源代码和相应的锁文件。演示笔记和运行状态保留在 Git 忽略的 `dist/dev-workspace/`。

## 发布打包

生产前端构建完成后运行打包脚本。

```powershell
node scripts/release.mjs
```

脚本使用系统 `tar`，生成 Windows amd64/arm64/386、Linux amd64/arm64/386/ARMv7 和 macOS amd64/arm64 的压缩包。每个包只含可执行文件和 `README.md`，构建标识及第三方许可并入 README。`SHA256SUMS` 与压缩包一起保存在 `dist/releases/`。交叉编译和实机验证的范围见[验收核对](../tests/ACCEPTANCE.md)。

### GitHub Actions 发布

先将工作流推到默认分支，再从包含它的提交创建版本标签。在 GitHub 的 Releases 页面点 **Publish release** 后，工作流会检出该标签对应的提交，测试并构建 9 个压缩包，将它们和 `SHA256SUMS` 附到对应的 Release。工作流还会推送 Linux amd64、arm64、386 和 ARMv7 多架构镜像，标签分别为 `<版本>`（含 Pandoc）和 `<版本>-slim`。GitHub 标记为 Latest 的正式 Release 会更新 `latest` 和 `latest-slim`，预发布只推送版本标签。[发布工作流](https://github.com/IanSmith123/LanNoto/blob/main/.github/workflows/release.yml)

- **Action 变量和 Secrets**。无需手工配置。工作流使用 GitHub 自动注入的 `GITHUB_TOKEN`。上传附件的任务声明 `contents: write`，推送镜像的任务声明 `packages: write`。
- **仓库设置**。启用 GitHub Actions，并允许工作流使用文件中列出的 Actions。此流程在发布后上传附件，因此仓库须允许修改已发布 Release 的附件。如果启用了 Release immutability，需要关闭它才能使用这条发布流程。[GitHub 不可变 Release 说明](https://docs.github.com/en/code-security/concepts/supply-chain-security/immutable-releases)
- **GHCR 设置**。首次推送后，如需匿名拉取，在包设置中把可见性设为 Public。如果复用已有的同名包，在包设置的 **Manage Actions access** 中给当前仓库写入权限。[GitHub Container Registry 说明](https://docs.github.com/en/packages/working-with-a-github-packages-registry/working-with-the-container-registry)

两种 Docker 镜像都在 `/workspace` 运行，以 UID/GID `10001:10001` 启动。普通 `docker build .` 构建含 Pandoc 的版本，使用 `docker build --target slim .` 构建基于 Alpine 的精简版。使用命名数据卷时可直接按 README 启动。若绑定主机目录，需给容器用户写入权限。修改 `go.mod` 的 Go 版本时，同步更新 Dockerfile 的 Go 构建镜像。

## 代码与数据布局

| 路径 | 职责 |
| --- | --- |
| `cmd/lannoto` | 启动参数、工作区锁、HTTP 服务和关闭流程 |
| `internal/server` | 密码会话、同源校验、文件、协作、历史和导出接口 |
| `internal/room` | 每个笔记的协作房间、修订确认和 Markdown 投影 |
| `internal/storage` | 工作区文件、快照、原子替换、路径变更和历史版本 |
| `internal/bundle`、`internal/exporter` | ZIP 与 Pandoc Word 导出 |
| `web/src` | 编辑器、协作客户端、目录树、历史和打印界面 |

运行目录决定数据位置。工作区锁和自动密码在每次启动时建立，自动密码仅在监听成功后写入一次启动日志。浏览器登录会话保存在服务端内存，有效期 8 小时。

```text
工作区/
  note/                  Markdown 文件、子文件夹和 static/ 资源
  .lannoto/
    workspace.lock       工作区锁
    state/               协作恢复快照
    history/             正文历史版本
    paths.json           移动、改名与状态索引
    tmp/                 导出临时文件
```

笔记 URL 使用 `note/` 内完整相对路径的 URL 编码。例如 `/note/项目%2F计划.md` 表示 `note/项目/计划.md`。应用内改名和移动会保留状态和历史，拒绝覆盖同名项目。移动意图先持久化，重启时按磁盘新旧路径确定恢复结果。外部更名后刷新列表，并打开新路径。

源码、设计、锁文件和测试夹具纳入 Git。笔记、运行状态、安装依赖、构建结果及测试运行记录由 `.gitignore` 排除。

## 编辑、同步与恢复

Markdown 是协作和保存的唯一正文。源码使用 CodeMirror，视觉编辑和预览使用 Milkdown/Crepe 的公开接口。视觉编辑通过投影与原文交换增量，源码和视觉视图共享同一份 Yjs 文档。远端选区使用相对位置，额外空白行通过 remark 投影为空段落。

服务端先持久化完整协作快照，再确认更新并独立追踪 Markdown 投影修订。只有本地待确认更新为空、当前修订已实际写入 Markdown，才显示「已保存」。原子替换前校验磁盘摘要。进程中断后可从已确认的快照完成投影。当前格式只接受 Markdown 协作快照。

已打开的笔记断线时可继续本地编辑，未确认更新保存在当前页内存中。客户端以 1–10 秒递增间隔重连，成功后合并远端修改并重发未确认更新。关闭或刷新页面前应等同步完成。刷新文件列表保留当前编辑器和协作连接。

历史版本使用独立的压缩快照。Ctrl+S 或 Cmd+S 保存并留档，大区块变更停止编辑约 2 秒后留档，普通变更按约 60 秒间隔留档。大区块阈值为单次变化至少 500 字符，或涉及至少 200 字符的 Markdown 区块。相邻同正文去重。恢复前保存当前版本，校验修订后再广播恢复结果。

## 导出与预览

- **Markdown 和 ZIP。** 单篇无本地资源时下载原始 Markdown，有直接引用的本地资源时打包。工作区 ZIP 包含 `note/` 目录。ZIP 最多 10000 项、512 MiB 输入，限时 60 秒。完整备份需同时保留 `note/` 和 `.lannoto/`。
- **Word。** Pandoc 只在 Word 导出时查找，可用 `--pandoc` 指定路径。导出读取已保存的修订。Mermaid 先在浏览器中渲染为浅色 PNG，导出用临时副本引用图表，结束后清理。每次最多 32 幅图，每幅最多 2 MiB 或 1600 万像素，总计最多 8 MiB 或 3200 万像素。
- **PDF。** 打印预览使用独立的只读快照，提前生成离屏图表和公式。正常 A4 四边 25.4 mm，窄边距 A4 四边 12.7 mm，连续长页宽 210 mm、高度上限 5000 mm。点击「打印」调用浏览器原生打印窗口。分页和书签由浏览器及打印目标处理。
- **Mermaid。** 本地打包渲染器。单幅图限制 50000 个 UTF-16 字符和 500 条边，支持所见即所得和预览，也用于打印和 Word。图表外部资源和链接会被拒绝。

## 测试

构建生产程序后运行以下测试命令。

```powershell
go test ./...
npm --prefix web test
```

测试在独立工作区启动真实服务，测试产物写入 `tests/artifacts/`。开发机的实际笔记目录不作为测试夹具。Linux 和 macOS 的程序输出名为 `dist/lannoto`。

故障测试使用 `lannoto_fault_test` 标签构建专用程序。发布脚本会拒绝含故障控制的二进制。协作测试使用正式应用入口。

需要验证 Chromium 浏览器在局域网 HTTP 页面的原生图片粘贴时，运行 `node scripts/verify-clipboard.mjs`，验证 Edge 时加上 `msedge` 参数。脚本将测试图片写入无界面浏览器的独立剪贴板。具体输入范围和证据见下表。

| 验证范围 | 记录 |
| --- | --- |
| 协作及上传导出 | [P1](../tests/P1.md)、[P2](../tests/P2.md) |
| 输入限制及保存故障 | [输入边界](../tests/BOUNDARIES.md)、[持久化故障](../tests/PERSISTENCE_FAULTS.md) |
| 实际 PDF 和原生剪贴板 | [打印验收](../tests/PRINT.md)、[原生输入](../tests/NATIVE_INPUT.md) |
| 实测平台、剩余验收和源码检查 | [验收核对](../tests/ACCEPTANCE.md)、[源码检查](../tests/SOURCE_REVIEW.md) |

排查 Windows 文件替换失败时查看服务日志中的占用诊断。用户主动输入的原始 HTML 可留在笔记中，Word 导出使用标准 Markdown。源码更新前先完成同步并备份工作区。

第三方组件与许可证见 [THIRD_PARTY_NOTICES.md](../THIRD_PARTY_NOTICES.md) 和 [licenses/THIRD_PARTY.txt](../licenses/THIRD_PARTY.txt)。
