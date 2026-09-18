# Codex Windows 视频主题（独立安全版）

这个目录是独立版，只包含我写的脚本和本地主题资源，不依赖 GitHub 仓库、npm、Rust、第三方包或原仓库的 macOS 安装脚本。主题资源位于 `tools\theme`。

## 脚本行为

- `start-codex-with-theme.ps1` 只启动你明确指定的 `ChatGPT.exe`，不会结束已有进程，也不会改文件。
- `codex-video-theme.mjs` 只读取本目录下的 `theme.json`、PNG 和 WebM。
- 只连接 `127.0.0.1` 的 CDP 端口，并且只接受 `app://` 的 Codex 页面。
- 不访问互联网，不读取密码、Cookie、Token、对话内容或剪贴板。
- 不修改 Codex 安装目录、`app.asar`、注册表或签名。
- 视频结束后，页面保留上色图片作为背景。

## 启动

请先关闭当前 Codex，然后在此目录运行：

```powershell
powershell.exe -NoProfile -ExecutionPolicy Bypass -File ".\start-codex-with-theme.ps1" -CodexExe "C:\Program Files\WindowsApps\OpenAI.Codex_xxx\app\ChatGPT.exe"
```

停止适配器按 `Ctrl+C`。之后正常启动 Codex 即可恢复。

`SHA256SUMS.txt` 是当前文件校验值。运行前可以用 PowerShell 的 `Get-FileHash` 对照检查。

## 一键启动和关闭

双击 `Start-Codex-Theme.cmd` 会启动 Codex、主题适配器和生命周期监控。启动窗口保持打开时，Codex 可以正常使用。

可以按 `Ctrl+C`、关闭启动脚本窗口，或双击 `Stop-Codex-Theme.cmd`。这些方式都会关闭本次由脚本启动的 Codex。

直接点击原来的 Codex 快捷方式不会自动加载主题。

## 发布与隐私

仓库发布时不会包含运行状态文件 `.codex-theme-session.json`、日志、账号信息或本机绝对路径。该状态文件只在本机运行期间临时生成，打包和上传时会排除。

项目只包含本地脚本和主题素材；上传前应检查文本内容、压缩包清单以及媒体元数据。

