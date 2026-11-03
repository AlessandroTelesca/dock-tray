// SPDX-License-Identifier: GPL-2.0-or-later
// SPDX-FileCopyrightText: 2026 AlessandroTelesca

import Clutter from 'gi://Clutter';
import GLib from 'gi://GLib';
import GObject from 'gi://GObject';
import Meta from 'gi://Meta';
import St from 'gi://St';

import * as Main from 'resource:///org/gnome/shell/ui/main.js';
import {Extension} from 'resource:///org/gnome/shell/extensions/extension.js';
import {ExtensionState} from 'resource:///org/gnome/shell/misc/extensionUtils.js';

const DTD_UUID = 'dash-to-dock@micxgx.gmail.com';

// AppIndicator registers every icon (SNI and legacy XEmbed) as `appindicator-<id>`.
const isTrayRole = role => role.startsWith('appindicator-');

// An inline style without the minimum size Dock Tray gives buttons, which other extensions that rewrite panel
// buttons' styles may have carried along, and with its closing semicolon.
const withoutDockSize = style => {
    const kept = (style ?? '').split(';').map(d => d.trim()).filter(d => d && !/^min-(width|height)\s*:/.test(d));
    return kept.length ? `${kept.join('; ')};` : '';
};

export default class DockTrayExtension extends Extension {
    enable() {
        this._generation = (this._generation ?? 0) + 1;
        this._origins = new Map(); // container -> {parent, index}
        this._layouts = new Map(); // button -> its own layout, restored when it goes back to the panel
        this._menuIds = new Map(); // indicator -> handler id
        this._slots = []; // {dash, box} per dock
        this._watchedParents = new Set(); // panel boxes icons came from
        this._host = null; // the slot holding the real icons

        this._panelBoxes = [Main.panel._leftBox, Main.panel._centerBox, Main.panel._rightBox];
        this._panelBoxIds = this._panelBoxes.map(box =>
            box.connect('child-added', () => this._queueSync()));

        Main.extensionManager.connectObject('extension-state-changed', (_mgr, ext) => {
            if (ext.uuid === DTD_UUID)
                this._bindDockManager().catch(logError);
        }, this);

        this._bindDockManager().catch(logError);
    }

    disable() {
        this._generation++;
        Main.extensionManager.disconnectObject(this);
        this._panelBoxes.forEach((box, i) => box.disconnect(this._panelBoxIds[i]));
        this._panelBoxes = this._panelBoxIds = null;

        if (this._laterId) {
            global.compositor.get_laters().remove(this._laterId);
            this._laterId = 0;
        }
        if (this._moveLaterId) {
            global.compositor.get_laters().remove(this._moveLaterId);
            this._moveLaterId = 0;
        }

        this._unbindDockManager();
        this._origins = this._menuIds = this._layouts = this._slots = this._watchedParents = null;
    }

    // --- Dash to Dock lifecycle --------------------------------------------

    async _bindDockManager() {
        const generation = this._generation;
        const dtd = Main.extensionManager.lookup(DTD_UUID);

        if (dtd?.state !== ExtensionState.ACTIVE) {
            this._unbindDockManager();
            return;
        }

        let DockManager;
        try {
            // Same URI dash-to-dock loaded itself from, so we get its live module instance.
            ({DockManager} = await import(`${dtd.dir.get_uri()}/docking.js`));
        } catch (e) {
            console.error(`[dock-tray] could not load Dash to Dock: ${e}`);
            return;
        }
        if (generation !== this._generation)
            return;

        const manager = DockManager.getDefault();
        if (!manager || manager === this._dockManager)
            return;

        this._unbindDockManager();
        this._dockManager = manager;
        // DockManager is a plain Signals.EventEmitter: no connectObject().
        this._dockManagerIds = [
            manager.connect('toggled', () => this._attachToDock()),
            manager.connect('destroy', () => this._unbindDockManager()),
        ];
        this._attachToDock();
    }

    _unbindDockManager() {
        this._dockManagerIds?.forEach(id => this._dockManager?.disconnect(id));
        this._dockManagerIds = null;
        this._dockManager = null;
        this._detachFromDock();
    }

    // Every dock gets a tray. The real icons live in one of them, the host; the others show clones of them, and the
    // real icons move into a dock's tray as the pointer enters it.
    _attachToDock() {
        this._detachFromDock();

        const docks = this._dockManager?.constructor.allDocks ?? [];
        for (const dock of docks) {
            const dash = dock?.dash;
            const container = dash?._dashContainer;
            if (container)
                this._addSlot(dash, container);
        }
        this._host = this._slots[0] ?? null;
        this._sync();
    }

    _addSlot(dash, container) {
        const horizontal = dash._isHorizontal;
        const box = new St.BoxLayout({
            style_class: `dock-tray ${horizontal ? 'horizontal' : 'vertical'}`,
            orientation: horizontal ? Clutter.Orientation.HORIZONTAL : Clutter.Orientation.VERTICAL,
            // Across the dock it spans the dock's thickness, so the buttons can too.
            x_align: horizontal ? Clutter.ActorAlign.CENTER : Clutter.ActorAlign.FILL,
            y_align: horizontal ? Clutter.ActorAlign.FILL : Clutter.ActorAlign.CENTER,
            x_expand: !horizontal,
            y_expand: horizontal,
            reactive: true,
            track_hover: true,
        });
        const slot = {dash, box};
        this._slots.push(slot);

        dash.connectObject('icon-size-changed', () => {
            if (slot === this._host)
                this._sizeButtons();
        }, this);
        // Not from inside the crossing event: Clutter is still picking the actors being moved and destroyed.
        box.connect('notify::hover', () => {
            if (box.hover && slot !== this._host)
                this._queueMove();
        });
        // The dock is being torn down (dash-to-dock rebuilds docks on settings and monitor changes). User handlers
        // run before Clutter destroys the children, so the icons go back to the panel before they die with the dock.
        box.connect('destroy', () => {
            if (!this._slots?.includes(slot))
                return;
            dash.disconnectObject(this);
            this._slots.splice(this._slots.indexOf(slot), 1);
            if (slot !== this._host)
                return;
            if (this._announcedDash === dash) {
                // The dock is going away: nothing to tell it.
                this._menuAnnounced = false;
                this._announcedDash = null;
            }
            // Dash to Dock tears all docks down together and builds them anew, then 'toggled' brings the icons back.
            this._restoreAll();
            this._host = null;
        });

        container.add_child(box);
    }

    _detachFromDock() {
        this._restoreAll();
        const slots = this._slots ?? [];
        this._slots = [];
        this._host = null;
        for (const {dash, box} of slots) {
            dash.disconnectObject(this);
            box.destroy();
        }
    }

    get _trayBox() {
        return this._host?.box ?? null;
    }

    get _dash() {
        return this._host?.dash ?? null;
    }

    _menuOpen() {
        return [...this._menuIds.keys()].some(i => i.menu?.isOpen && this._inDock(i));
    }

    _queueMove() {
        if (this._moveLaterId)
            return;
        this._moveLaterId = global.compositor.get_laters().add(Meta.LaterType.BEFORE_REDRAW, () => {
            this._moveLaterId = 0;
            const hovered = this._slots?.find(s => s.box.hover);
            if (hovered)
                this._moveTo(hovered);
            return false;
        });
    }

    _moveTo(slot) {
        // A menu stays with its icon: don't pull the icons from under an open one.
        if (!this._host || slot === this._host || !this._slots.includes(slot) || this._menuOpen())
            return;
        this._transfer(this._host, slot);
    }

    _transfer(from, to) {
        to.box.destroy_all_children();
        for (const container of from.box.get_children()) {
            from.box.remove_child(container);
            to.box.add_child(container);
        }
        this._host = to;
        for (const container of to.box.get_children()) {
            if (container.child)
                this._fitButton(container.child);
        }
        this._syncClones();
    }

    // Each dock but the host shows a copy of each real icon, in the same order: a button styled and sized as the
    // real one, around a clone of its icon. (A clone of the whole button paints its icon wrong: the effects
    // AppIndicator puts on the icon.)
    _syncClones() {
        const containers = this._trayBox?.get_children() ?? [];
        const horizontal = this._dash?._isHorizontal ?? true;
        for (const slot of this._slots) {
            if (slot === this._host)
                continue;
            slot.box.destroy_all_children();
            for (const container of containers) {
                const button = container.child;
                if (button)
                    slot.box.add_child(this._makeCopy(container, button, horizontal));
            }
        }
    }

    _makeCopy(container, button, horizontal) {
        const {FILL, CENTER} = Clutter.ActorAlign;
        const icons = new St.BoxLayout({
            style_class: button._box?.style_class ?? 'panel-status-indicators-box',
            x_align: CENTER,
            y_align: CENTER,
        });
        const copy = new St.Bin({
            style_class: button.style_class,
            style: button.get_style(),
            child: icons,
            x_align: horizontal ? CENTER : FILL,
            y_align: horizontal ? FILL : CENTER,
            x_expand: !horizontal,
            y_expand: horizontal,
        });

        const icon = button.icon ?? button._icon;
        if (icon) {
            icons.add_child(new Clutter.Clone({source: icon}));
            // AppIndicator replaces an icon actor now and then: copy the new one.
            icon.connectObject('destroy', () => {
                this._clonesDirty = true;
                this._queueSync();
            }, copy);
        }

        // A hidden icon leaves no gap in the other trays either.
        const update = () => {
            copy.visible = container.visible && button.visible;
        };
        container.connectObject('notify::visible', update, copy);
        button.connectObject('notify::visible', update, copy);
        button.bind_property('opacity', copy, 'opacity', GObject.BindingFlags.SYNC_CREATE);
        update();

        // The real button pads itself from the panel theme (-natural-hpadding): take its length along the dock.
        const length = horizontal ? 'width' : 'height';
        const syncLength = () => {
            if (container[length] > 0)
                copy[`natural_${length}`] = container[length];
        };
        container.connectObject(`notify::${length}`, syncLength, copy);
        syncLength();
        return copy;
    }

    // --- Moving icons ------------------------------------------------------

    _queueSync() {
        if (this._laterId || !this._trayBox)
            return;
        // Defer: child-added fires from inside Panel._addToPanelBox.
        this._laterId = global.compositor.get_laters().add(Meta.LaterType.BEFORE_REDRAW, () => {
            this._laterId = 0;
            this._sync();
            return false;
        });
    }

    _sync() {
        if (!this._trayBox)
            return;

        let changed = false;
        for (const [role, indicator] of Object.entries(Main.panel.statusArea)) {
            if (!indicator || !isTrayRole(role))
                continue;

            const container = indicator.container;
            const parent = container.get_parent();
            if (parent === this._trayBox)
                continue;

            if (parent) {
                // Panel boxes can go before the icons return (other extensions rebuild the top bar).
                if (!this._watchedParents.has(parent)) {
                    this._watchedParents.add(parent);
                    parent.connectObject('destroy', () => {
                        this._watchedParents?.delete(parent);
                        for (const origin of this._origins?.values() ?? []) {
                            if (origin.parent === parent)
                                origin.parent = null;
                        }
                    }, this);
                }
                this._origins.set(container, {
                    parent,
                    index: parent.get_children().indexOf(container),
                });
                parent.remove_child(container);
            }
            this._trayBox.add_child(container);
            this._fitButton(indicator);
            this._trackMenu(indicator);

            container.connectObject('destroy', () => {
                this._origins?.delete(container);
                this._clonesDirty = true;
                this._queueSync();
            }, this);
            changed = true;
        }
        if (changed || this._clonesDirty)
            this._syncClones();
        this._clonesDirty = false;
    }

    // A button takes the pointer over a whole slot of the dock, as an app icon does: across the dock's thickness and
    // at least the dock's icon size along it. Its icon and highlight stay their size, centred in it.
    _fitButton(button) {
        if (!this._layouts.has(button)) {
            const box = button._box ?? null;
            this._layouts.set(button, {
                xAlign: button.x_align, yAlign: button.y_align, xExpand: button.x_expand, yExpand: button.y_expand,
                style: withoutDockSize(button.get_style()) || null,
                box, boxXAlign: box?.x_align, boxYAlign: box?.y_align,
            });
        }
        const horizontal = this._dash?._isHorizontal ?? true;
        const {FILL, CENTER} = Clutter.ActorAlign;
        button.x_align = horizontal ? CENTER : FILL;
        button.y_align = horizontal ? FILL : CENTER;
        button.x_expand = !horizontal;
        button.y_expand = horizontal;
        const box = this._layouts.get(button).box;
        if (box) {
            box.x_align = CENTER;
            box.y_align = CENTER;
        }
        this._sizeButton(button);
    }

    _sizeButton(button) {
        const layout = this._layouts.get(button);
        const size = this._dash?.iconSize;
        if (!layout || !size)
            return;
        const horizontal = this._dash._isHorizontal ?? true;
        // Its own inline style: other extensions set some on panel buttons.
        const own = layout.style ? `${layout.style} ` : '';
        button.set_style(`${own}${horizontal ? 'min-width' : 'min-height'}: ${size}px;`);
    }

    _sizeButtons() {
        for (const container of this._trayBox?.get_children() ?? []) {
            if (container.child)
                this._sizeButton(container.child);
        }
        this._syncClones();
    }

    _unfitButton(button) {
        const layout = this._layouts.get(button);
        if (!layout)
            return;
        button.x_align = layout.xAlign;
        button.y_align = layout.yAlign;
        button.x_expand = layout.xExpand;
        button.y_expand = layout.yExpand;
        button.set_style(layout.style);
        if (layout.box) {
            layout.box.x_align = layout.boxXAlign;
            layout.box.y_align = layout.boxYAlign;
        }
        this._layouts.delete(button);
    }

    _inDock(indicator) {
        return !!this._dash && this._trayBox?.contains(indicator.container) === true;
    }

    _trackMenu(indicator) {
        const menu = indicator.menu;
        if (this._menuIds.has(indicator) || !menu)
            return;

        // The menu manager grabs the pointer as the menu opens, before any open-state-changed handler of ours runs.
        // The dock then sees the pointer leave and starts hiding, which telling it about the menu afterwards does not
        // stop. So it is told before the menu opens, as Dash to Dock does for its app icons' menus.
        const ownOpen = Object.hasOwn(menu, 'open') ? menu.open : undefined;
        const open = menu.open;
        menu.open = (...args) => {
            if (!menu.isOpen && this._inDock(indicator))
                this._announceMenu();
            const result = open.apply(menu, args);
            if (!menu.isOpen)
                this._queueMenuClosed();
            return result;
        };

        const id = menu.connect('open-state-changed', (_menu, isOpen) => {
            if (!this._inDock(indicator))
                return;
            if (isOpen) {
                // Menus were added to uiGroup before the dock existed; keep them on top.
                Main.uiGroup.set_child_above_sibling(menu.actor, null);
                this._announceMenu();
            } else {
                this._queueMenuClosed();
            }
        });
        this._menuIds.set(indicator, {menu, id, ownOpen});
        indicator.connectObject('destroy', () => this._menuIds?.delete(indicator), this);
    }

    _untrackMenu(indicator) {
        const entry = this._menuIds.get(indicator);
        if (!entry)
            return;
        entry.menu.disconnect(entry.id);
        if (entry.ownOpen)
            entry.menu.open = entry.ownOpen;
        else
            delete entry.menu.open;
        this._menuIds.delete(indicator);
    }

    // Keeps an autohiding dock revealed while a tray menu is open.
    _announceMenu() {
        if (this._closeIdleId) {
            GLib.source_remove(this._closeIdleId);
            this._closeIdleId = 0;
        }
        if (this._menuAnnounced || !this._dash)
            return;
        this._menuAnnounced = true;
        this._announcedDash = this._dash;
        this._announcedDash.emit('menu-opened');
    }

    // Lets the dock hide again once no tray menu is open. Waits a moment: moving onto another tray icon while a menu
    // is open closes that menu and opens the icon's, and the dock must not start hiding in between.
    _queueMenuClosed() {
        if (this._closeIdleId || !this._menuAnnounced)
            return;
        this._closeIdleId = GLib.idle_add(GLib.PRIORITY_DEFAULT_IDLE, () => {
            this._closeIdleId = 0;
            if (!this._menuOpen()) {
                this._endMenu();
                // The pointer may have gone to another dock's tray while the menu held it.
                this._queueMove();
            }
            return GLib.SOURCE_REMOVE;
        });
    }

    _endMenu() {
        if (this._closeIdleId) {
            GLib.source_remove(this._closeIdleId);
            this._closeIdleId = 0;
        }
        if (!this._menuAnnounced)
            return;
        this._menuAnnounced = false;
        this._announcedDash?.emit('menu-closed');
        this._announcedDash = null;
    }

    _restoreAll() {
        if (!this._trayBox)
            return;

        for (const container of this._trayBox.get_children()) {
            const indicator = container.child;
            const origin = this._origins.get(container);
            const parent = origin?.parent ?? Main.panel._rightBox;

            this._trayBox.remove_child(container);
            const n = parent.get_n_children();
            parent.insert_child_at_index(container, Math.min(origin?.index ?? 0, n));

            container.disconnectObject(this);
            if (indicator) {
                indicator.disconnectObject(this);
                this._untrackMenu(indicator);
                this._unfitButton(indicator);
            }
        }
        this._origins.clear();
        this._watchedParents.forEach(parent => parent.disconnectObject(this));
        this._watchedParents.clear();
        this._endMenu();
    }
}
