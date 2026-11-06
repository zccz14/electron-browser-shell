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
cp -R src examples package.json "$APP/Contents/Resources/app/"

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

# A browser shell needs these, or the OS kills the app the moment a site asks
# for the camera/mic, and WebAuthn cannot use Bluetooth for cross-device
# passkeys ("Cannot use Bluetooth because the responsible app ... does not have
# Bluetooth metadata in its Info.plist").
add_plist_string () { /usr/libexec/PlistBuddy -c "Add :$1 string $2" "$PLIST" 2>/dev/null || true; }
add_plist_string NSCameraUsageDescription "Sites opened in Browser Shell can use the camera when you allow it."
add_plist_string NSMicrophoneUsageDescription "Sites opened in Browser Shell can use the microphone when you allow it."
add_plist_string NSBluetoothAlwaysUsageDescription "Used for WebAuthn security keys and cross-device passkeys."
add_plist_string NSBluetoothPeripheralUsageDescription "Used for WebAuthn security keys and cross-device passkeys."

codesign --force --deep --sign - "$APP"

echo "built: $APP"
echo "run:   open \"$APP\""
echo "zip:   ditto -c -k --keepParent \"$APP\" \"dist/Browser-Shell-${VERSION}-${ARCH}-mac.zip\""
