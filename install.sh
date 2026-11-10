#!/usr/bin/env bash
# Installs UmbrelOS Touch as a systemd user service on a Linux machine on the
# same network as your Umbrel (NOT on the Umbrel itself). Run from this folder:
#   ./install.sh 192.168.1.50
set -euo pipefail
UMBREL="${1:-}"
DEST="$HOME/.local/share/umbrel-touch"
command -v node >/dev/null || { echo "Node.js 20+ is required: https://nodejs.org"; exit 1; }
[ "$(node -p 'process.versions.node.split(".")[0]')" -ge 20 ] || { echo "Node.js 20+ is required (found $(node -v))"; exit 1; }
echo "Building…"
npm ci --no-audit --no-fund >/dev/null
npm run build >/dev/null
npm test >/dev/null && echo "Tests passed"
mkdir -p "$DEST"
cp -r server dist package.json package-lock.json "$DEST/"
(cd "$DEST" && npm ci --omit=dev --no-audit --no-fund >/dev/null)
mkdir -p "$HOME/.config/systemd/user"
cat > "$HOME/.config/systemd/user/umbrel-touch.service" <<UNIT
[Unit]
Description=UmbrelOS Touch
After=network-online.target

[Service]
ExecStart=$(command -v node) $DEST/server/cli.mjs ${UMBREL:+--umbrel $UMBREL}
Restart=on-failure

[Install]
WantedBy=default.target
UNIT
systemctl --user daemon-reload
systemctl --user enable --now umbrel-touch
loginctl enable-linger "$USER" 2>/dev/null || true
sleep 1
journalctl --user -u umbrel-touch -n 8 --no-pager -o cat || true
echo
echo "Installed. Open one of the addresses above on your phone, then Share › Add to Home Screen."
echo "Uninstall: systemctl --user disable --now umbrel-touch && rm -rf $DEST ~/.config/systemd/user/umbrel-touch.service"
