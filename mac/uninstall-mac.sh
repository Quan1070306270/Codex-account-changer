#!/bin/bash
set -euo pipefail

SUPPORT_DIR="$HOME/Library/Application Support/GPTAccountSwitcher"
PLIST_PATH="$HOME/Library/LaunchAgents/com.gpt-account-switcher.agent.plist"
DOMAIN_TARGET="gui/$(id -u)"

/bin/launchctl bootout "$DOMAIN_TARGET/com.gpt-account-switcher.agent" >/dev/null 2>&1 || true
rm -f "$PLIST_PATH"

echo "切换器已停止。账号备份仍保留在：$SUPPORT_DIR/backups"
echo "如不再需要，可手动删除整个 $SUPPORT_DIR 目录。"
