#!/bin/zsh

cd -- "${0:A:h}" || exit 1
URL="http://127.0.0.1:8768"

if /usr/bin/curl -fsS "$URL/api/database/stats" >/dev/null 2>&1; then
  /usr/bin/open "$URL"
  exit 0
fi

( /bin/sleep 1; /usr/bin/open "$URL" ) &
echo "Sand3 Industrial 正在启动。关闭此窗口或按 Control-C 可停止服务。"
exec /usr/bin/env node server.js
