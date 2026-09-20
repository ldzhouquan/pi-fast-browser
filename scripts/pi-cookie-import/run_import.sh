#!/bin/bash
# 手动导入 Chrome cookie 到 PI-Desktop 内置浏览器
# 用法：先完全退出 PI-Desktop，再运行本脚本
set -u
# 脚本所在目录（备份与日志都写在这里）
DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PY="$(command -v python3 || true)"

echo "=============================================="
echo " Chrome Cookie -> PI-Desktop 导入工具"
echo "=============================================="

if [ -z "$PY" ]; then
  echo ""
  echo "❌ 错误：找不到 python3，请先安装 Python 3。"
  exit 1
fi

# 安全检查：PI-Desktop 必须在退出状态，否则浏览器会覆盖写入
if pgrep -x "PI-Desktop" > /dev/null 2>&1; then
  echo ""
  echo "❌ 错误：PI-Desktop 正在运行！"
  echo "   请先完全退出 PI-Desktop（Cmd+Q），再运行本脚本。"
  echo "   （浏览器运行中写 cookie 库会被覆盖，导入无效）"
  exit 1
fi
echo "✅ PI-Desktop 已退出，可以安全导入"

# 确认 Chrome 加密库可用
if ! "$PY" -c "from Cryptodome.Cipher import AES" 2>/dev/null; then
  echo ""
  echo "❌ 错误：缺少 pycryptodomex 加密库。请运行："
  echo "   python3 -m pip install --user --break-system-packages pycryptodomex"
  exit 1
fi

echo "✅ 环境检查通过，开始导入..."
echo ""

# 执行导入（先备份当前库，再清空导入）
PI_DB="$HOME/Library/Application Support/PI-Desktop/Partitions/work-browser/Cookies"
cp "$PI_DB" "$DIR/cookies.before_import.backup" 2>/dev/null && \
   echo "📦 已备份当前 cookie 库到 cookies.before_import.backup"

"$PY" "$DIR/import_cookies.py"
rc=$?

echo ""
if [ $rc -eq 0 ]; then
  echo "✅ 导入完成！现在可以重新打开 PI-Desktop 了。"
  echo "   验证：打开 https://chatgpt.com 应保持登录状态"
else
  echo "❌ 导入失败（exit=$rc），详细输出见上方。"
  echo "   如需恢复：cp \"$DIR/cookies.before_import.backup\" \"$PI_DB\""
fi
echo "=============================================="
