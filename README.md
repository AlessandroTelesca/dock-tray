# Dock Tray

Moves tray icons from the top bar into [Dash to Dock](https://extensions.gnome.org/extension/307/dash-to-dock/), so they stay reachable while the top bar is hidden (e.g. with Hide Top Bar). Needs [AppIndicator and KStatusNotifierItem Support](https://extensions.gnome.org/extension/615/appindicator-support/), which puts the icons in the top bar in the first place; this extension only moves them.

- Every AppIndicator icon (StatusNotifierItem and legacy XEmbed) goes into the dock, after the app icons, laid out along the dock's orientation, close together.
- With Dash to Dock on all monitors, every dock shows the icons. The real ones sit in one dock and the others show copies; they move into a dock's tray as the pointer enters it, so menus open on that monitor. They don't move while one of their menus is open.
- Dash to Dock rebuilds its docks on settings and monitor changes: the icons go back to the top bar just before, and into the new dock right after. Disabling either extension returns them to the top bar.
- While an icon's menu is open the dock stays revealed, and the menu is raised above it.
- Look: `stylesheet.css` (`.dock-tray`, `.dock-tray .panel-button`). Icon size comes from AppIndicator's own *Icon size* setting.

Limits: it relies on Dash to Dock internals (`DockManager`, `DockDash._dashContainer`), so a Dash to Dock update can break it.

Install:

```sh
gnome-extensions pack --force --extra-source=tools . && gnome-extensions install --force dock-tray@alessandrot.shell-extension.zip
```

then log out and in, and `gnome-extensions enable dock-tray@alessandrot`.

`tools/tray-demo.py` shows three test tray icons with menus (needs `libayatana-appindicator-gtk3`).

GNOME Shell 50.

License: GPL-2.0-or-later, see `LICENSE`.
