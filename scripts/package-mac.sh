#!/usr/bin/env bash
# Build a double-clickable macOS .app from the Electron already in node_modules,
# without electron-builder: copy Electron.app, drop the app in Resources/app,
# rename the executable, fix Info.plist, ad-hoc sign.
#
#   ./scripts/package-mac.sh            # -> dist/Browser Shell.app
set -euo pipefail

cd "$(dirname "$0")/.."
NAME="Browser Shell"
BUNDLE_ID="com.zccz14.browsershell"
VERSION="$(node -p "require('./package.json').version")"
ARCH="$(uname -m)"          # arm64 / x64
SRC="node_modules/electron/dist/Electron.app"
APP="dist/${NAME}.app"

[ -d "$SRC" ] || { echo "Electron is not installed. Run: npm install"; exit 1; }

rm -rf "$APP"
mkdir -p dist
cp -R "$SRC" "$APP"

rm -rf "$APP/Contents/Resources/default_app.asar"
mkdir -p "$APP/Contents/Resources/app"
cp -R src package.json "$APP/Contents/Resources/app/"

mv "$APP/Contents/MacOS/Electron" "$APP/Contents/MacOS/${NAME}"

PLIST="$APP/Contents/Info.plist"
set_plist () { /usr/libexec/PlistBuddy -c "Set :$1 $2" "$PLIST" 2>/dev/null \
            || /usr/libexec/PlistBuddy -c "Add :$1 string $2" "$PLIST"; }
set_plist CFBundleExecutable "$NAME"
set_plist CFBundleIdentifier "$BUNDLE_ID"
set_plist CFBundleName "$NAME"
set_plist CFBundleDisplayName "$NAME"
set_plist CFBundleShortVersionString "$VERSION"
set_plist CFBundleVersion "$VERSION"

codesign --force --deep --sign - "$APP"

echo "built: $APP"
echo "run:   open \"$APP\""
echo "zip:   ditto -c -k --keepParent \"$APP\" \"dist/Browser-Shell-${VERSION}-${ARCH}-mac.zip\""
