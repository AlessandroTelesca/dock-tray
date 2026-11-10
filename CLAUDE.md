# Dock Tray

GNOME Shell extension `dock-tray@alessandrot`. See README.md for what it does.

## Install

```sh
gnome-extensions pack --force --extra-source=tools . && gnome-extensions install --force dock-tray@alessandrot.shell-extension.zip
```

## Reload in the running session (`gext-reload`)

The user doesn't log out to try a change. After installing, load the installed version into the running shell:

```sh
gext-reload dock-tray@alessandrot
```

- About the script:
  - `gext-reload` is the user's own script, at `~/.local/bin/gext-reload`. Its source is in `~/GIT/gext-reload`.
  - It copies the *installed* extension to `$XDG_RUNTIME_DIR/gext-reload/<timestamp>/gnome-shell/extensions/<uuid>`. The shell caches code by
    path, so a new path loads fresh code.
  - In the copy it renames every `GObject.registerClass` class and `GTypeName`, so they don't clash with the
    registered ones.
  - The helper extension `gext-reload@alessandrot` then swaps the running extension for the copy over D-Bus.
  - Without the helper, it prints a Looking Glass line for the user to run instead (Super+R, `lg`, paste into the
    Evaluator).
- It loads what is installed, not this checkout, so always install first.
- Check:
  - `gnome-extensions info dock-tray@alessandrot` shows State: ACTIVE.
  - `journalctl --user -b --since -1min -g "JS ERROR|dock-tray"` shows no errors.
- Risks:
  - A reload runs the code in the live session. Anything `disable()` doesn't undo is left behind, such as patched
    functions or signal handlers.
  - A Clutter layout error aborts the shell, which logs the user out.
  - To recover:
    - Find the cause: `journalctl -b -g "Clutter-ERROR|ClutterBoxLayout|JS ERROR"`.
    - Then `gnome-extensions disable dock-tray@alessandrot` and `gsettings set org.gnome.shell disable-user-extensions false`.
- The copy is gone after logout, and the next login loads the installed version.
- The user's full notes: `~/Dokumente/Obsidian/LinuxDocs/Customizations/15-Load-New-GNOME-Extension-Without-Relogin.md`.
