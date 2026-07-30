#!/usr/bin/env bash
# Build CPStreak.app — the menu bar streak readout.
#
# Produces a real .app bundle (not a bare binary) because macOS only lets
# bundled apps be added to Login Items and remember their preferences.
# Ad-hoc signed: enough to run locally, no developer account needed.
set -euo pipefail
cd "$(dirname "$0")"

APP="CPStreak.app"
BIN="$APP/Contents/MacOS/CPStreak"

rm -rf "$APP"
mkdir -p "$APP/Contents/MacOS" "$APP/Contents/Resources"

cat > "$APP/Contents/Info.plist" <<'PLIST'
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN"
  "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>CFBundleName</key><string>CP Streak</string>
  <key>CFBundleDisplayName</key><string>CP Streak</string>
  <key>CFBundleIdentifier</key><string>local.cptrainer.streak</string>
  <key>CFBundleVersion</key><string>1.0</string>
  <key>CFBundleShortVersionString</key><string>1.0</string>
  <key>CFBundleExecutable</key><string>CPStreak</string>
  <key>CFBundlePackageType</key><string>APPL</string>
  <key>LSMinimumSystemVersion</key><string>13.0</string>
  <!-- Menu bar only: no Dock icon, no app switcher entry. -->
  <key>LSUIElement</key><true/>
  <!-- Talks to the local dev server over plain HTTP. -->
  <key>NSAppTransportSecurity</key>
  <dict>
    <key>NSAllowsLocalNetworking</key><true/>
  </dict>
</dict>
</plist>
PLIST

echo "Compiling…"
swiftc -O \
  -framework AppKit \
  -o "$BIN" \
  Sources/main.swift

codesign --force --sign - "$APP" >/dev/null 2>&1 || \
  echo "note: ad-hoc codesign skipped (app still runs)"

echo "Built $(pwd)/$APP"
echo
echo "Run it:      open $APP"
echo "Autostart:   System Settings > General > Login Items > + > $(pwd)/$APP"
echo "Custom port: defaults write local.cptrainer.streak baseURL http://localhost:3001"
