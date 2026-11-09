#!/bin/sh
# Replaces electron-builder's default post-install, so it must also create the launcher link.
ln -sf /opt/Libretto/libretto-desktop /usr/bin/libretto-desktop
# Electron's SUID sandbox helper must be root-owned with mode 4755, otherwise the app aborts on start.
chown root:root /opt/Libretto/chrome-sandbox 2>/dev/null || true
chmod 4755 /opt/Libretto/chrome-sandbox 2>/dev/null || true
update-desktop-database /usr/share/applications 2>/dev/null || true
exit 0
