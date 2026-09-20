# Chrome Cookie → PI-Desktop 导入工具

把本机 Chrome 的登录 Cookie 解密后导入 PI-Desktop 内置浏览器（work-panel browser）的 Cookie 库，让 Jev Browser Use（Jev）任务能以已登录状态访问需要登录的站点（如 chatgpt.com、Google 等）。

> ⚠️ **仅限 macOS**。Cookie 属于敏感凭据：本目录下的 `cookies.before_import.backup` 和 `import.log` 已被 `.gitignore` 排除，**永远不要把真实 Cookie 提交到仓库**。

## 原理

- 从 macOS Keychain 读取 `Chrome Safe Storage`（运行时获取，不落盘），PBKDF2 派生 AES-128-CBC 密钥，解密 Chrome Cookies DB 中的 `encrypted_value`（v10 格式，兼容 v24+ 的 32 字节完整性前缀）。
- 以明文 value + 清空 encrypted_value 的形式 upsert 进 PI-Desktop 的 work-browser Cookies DB（与 PI-Desktop 自身浏览器使用的格式一致）。
- 导入前自动备份当前 Cookie 库到 `cookies.before_import.backup`。

## 用法

一次性安装依赖（pycryptodomex）：

```bash
python3 -m pip install --user --break-system-packages pycryptodomex
```

**方式一：手动导入**（先 Cmd+Q 完全退出 PI-Desktop）：

```bash
./run_import.sh
```

**方式二：后台等待导入**（先启动脚本，再退出 PI-Desktop，脚本会在检测到退出后自动执行）：

```bash
./run_import_when_closed.sh &
```

导入完成后重新打开 PI-Desktop，打开 https://chatgpt.com 验证登录态保持。

## 恢复备份

```bash
cp cookies.before_import.backup \
  "$HOME/Library/Application Support/PI-Desktop/Partitions/work-browser/Cookies"
```

## 文件

| 文件 | 说明 |
| --- | --- |
| `run_import.sh` | 手动导入入口（环境检查 + 备份 + 执行） |
| `run_import_when_closed.sh` | 后台 watcher，等 PI-Desktop 退出后自动导入 |
| `import_cookies.py` | 核心：解密 Chrome Cookie 并写入 PI-Desktop Cookie 库 |
| `cookies.before_import.backup` | 运行时生成的备份（不入库） |
| `import.log` | watcher 模式的运行日志（不入库） |
