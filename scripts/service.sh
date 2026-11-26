#!/usr/bin/env bash
# Keeps Muster running on this Mac at http://localhost:5173, always showing the code in
# this folder. Once started it stays up, and is started again if it crashes, until you stop
# it or the Mac restarts; it does not start by itself at login.
#   scripts/service.sh start | stop | restart | status | logs
set -euo pipefail
repo="$(cd "$(dirname "$0")/.." && pwd)"
label="ai.muster.dev"
# Kept outside ~/Library/LaunchAgents on purpose, so nothing starts at login.
plist="$repo/.dev-data/$label.plist"
log="$HOME/Library/Logs/muster-dev.log"
domain="gui/$(id -u)"

case "${1:-status}" in
  start)
    mkdir -p "$(dirname "$plist")" "$(dirname "$log")"
    # A login shell, so the service sees what your terminal sees: the right node and pnpm,
    # and any keys your shell profile sets.
    cat > "$plist" <<PLIST
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key><string>$label</string>
  <key>ProgramArguments</key>
  <array>
    <string>/bin/zsh</string>
    <string>-lic</string>
    <string>cd "$repo" &amp;&amp; exec pnpm dev</string>
  </array>
  <key>RunAtLoad</key><true/>
  <key>KeepAlive</key><true/>
  <key>ThrottleInterval</key><integer>10</integer>
  <key>StandardOutPath</key><string>$log</string>
  <key>StandardErrorPath</key><string>$log</string>
</dict>
</plist>
PLIST
    launchctl bootout "$domain/$label" 2>/dev/null || true
    # A service that was running takes a moment to go; starting before that fails.
    for _ in 1 2 3 4 5 6 7 8 9 10; do
      launchctl print "$domain/$label" >/dev/null 2>&1 || break
      sleep 1
    done
    launchctl bootstrap "$domain" "$plist"
    echo "Muster runs in the background until you stop it or the Mac restarts: http://localhost:5173"
    echo "Log: $log    Stop: pnpm service stop"
    ;;
  stop)
    launchctl bootout "$domain/$label" 2>/dev/null || true
    rm -f "$plist"
    echo "Muster no longer runs in the background."
    ;;
  restart)
    if launchctl print "$domain/$label" >/dev/null 2>&1; then
      launchctl kickstart -k "$domain/$label"
      echo "restarted"
    else
      echo "not started (pnpm service start)"
    fi
    ;;
  status)
    if launchctl print "$domain/$label" >/dev/null 2>&1; then
      state="$(launchctl print "$domain/$label" | awk '/state =/ {print $3; exit}')"
      echo "started, $state"
    else
      echo "not started (pnpm service start)"
    fi
    curl -sf -m 3 -o /dev/null http://localhost:5173/ && echo "http://localhost:5173 answers" || echo "http://localhost:5173 does not answer"
    ;;
  logs)
    [ -f "$log" ] && tail -n "${2:-60}" "$log" || echo "no log yet: $log"
    ;;
  *)
    echo "usage: scripts/service.sh start | stop | restart | status | logs" >&2
    exit 2
    ;;
esac
