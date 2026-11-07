# 浏览器原生输入验收

实际平台：Windows amd64、Chrome 156.0.8078.49。仅控制浏览器，没有操作桌面、文件管理器或系统输入法面板。

## 真实剪贴板图片与局域网 HTTP

从项目根目录执行 `node scripts/verify-clipboard.mjs`。脚本需要本机 Chrome 和可用的私有 IPv4 接口，使用无界面浏览器的独立剪贴板。测试 Edge 时使用 `node scripts/verify-clipboard.mjs msedge`。仅向 localhost 辅助页面授予剪贴板写权限。

脚本启动真实 Go 程序，使用独立笔记工作区及 Chrome 配置。localhost 辅助页面通过浏览器 API 写入测试像素；被验收的应用页面始终访问主机自身的局域网 IPv4 HTTP 地址，没有向该页面授予异步剪贴板权限。

当前脚本验证：

- 应用页面 isSecureContext 为 false，navigator.clipboard 不可用。
- 真实 Ctrl+V 收到可信 paste 事件，isTrusted 为 true，clipboardData.types 为 Files。
- 浏览器将像素提供为名为 image.png 的 PNG，自动上传一次，直接保存为 YYYYMMDDHHmmss.png 并插入相对引用，无需选择来源。
- 文件选择使用磁盘上原名恰为 image.png 的真实文件，名称及原始字节均保留，只增加一次上传。
- 两份已插入资源都保留在已保存的 Markdown 中。

脚本将事件、文件元数据、环境、上传计数及截图存入忽略的 tests/artifacts/native-clipboard-*。

测试使用浏览器写入的剪贴板像素和主机自身的局域网地址。系统截图工具、从文件管理器复制文件及第二台物理设备需另行实测。

## 粘贴来源与浏览器兼容

- Chrome 和 Edge 通过浏览器调试接口拖入磁盘上的 `image.webp` 和普通附件，再把同一个载荷交给粘贴处理器。两个文件保留原名，图片原始字节保留，两个引用都出现在同一次插入中。这个测试覆盖浏览器提供真实文件条目时的行为。
- Firefox 的测试用页面事件覆盖内存图片条目的回退路径。只有通用名的图片仍可选时间命名，带明确名称的图片和附件保留原名。文件选择也保留原名。
- 自动化测试另用来源不明的粘贴事件验证命名询问和取消上传。

文件管理器直接复制到浏览器的路径仍需按操作系统和浏览器实测。

## 中文组合输入与同段协作

web/tests/p1.spec.ts 新增两类检查：

- 两个隔离浏览器在同一段落分别删除中文首字、插入含 emoji 的文本，正文收敛；本地撤销/重做保留另一成员的输入。关闭成员后，其远端光标装饰及在线状态移除。
- 使用 Chromium 公共 DevTools 输入接口产生“中→中文”的组合输入，同时另一浏览器编辑同段落。两端最终保存相同正文。compositionstart 和 compositionupdate 记录为可信；本次管线的 compositionend 为非可信事件，记录保存在 tests/artifacts/composition-events.json。

第二项是 Chromium 组合管线测试，不是真实 Windows 中文输入法操作。前一项的正文断言排除公开 y-prosemirror 光标装饰中的姓名，没有改写编辑器 DOM。

## 尚未定位的文件占用观察

测试中两次在新页面初始化的 Markdown 原子替换处遇到 Windows Access is denied，程序均按设计非零退出、页面断开，不显示已保存。此前内部页面读取与替换的冲突已单独复现并通过读写协调修复；这两次后续占用的持有者仍未确定，不能声称已找到新的根因。

同段协作测试在系统临时工作区和项目内工作区各连续通过三次，后续完整 42 项回归亦通过。没有因此增加自动重试或忽略错误。仅为诊断，web/start-test-server.mjs 接受测试专用 LANNOTO_TEST_WORKSPACE_PARENT；不设置时仍使用原先的项目内独立测试目录。该变量不是产品配置。
