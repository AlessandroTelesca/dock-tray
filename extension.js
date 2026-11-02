import Clutter from 'gi://Clutter';
import Meta from 'gi://Meta';
import St from 'gi://St';

import * as Main from 'resource:///org/gnome/shell/ui/main.js';
import {Extension} from 'resource:///org/gnome/shell/extensions/extension.js';
import {ExtensionState} from 'resource:///org/gnome/shell/misc/extensionUtils.js';

const DTD_UUID = 'dash-to-dock@micxgx.gmail.com';

// AppIndicator registers every icon (SNI and legacy XEmbed) as `appindicator-<id>`.
const isTrayRole = role => role.startsWith('appindicator-');

export default class DockTrayExtension extends Extension {
    enable() {
        this._generation = (this._generation ?? 0) + 1;
        this._origins = new Map(); // container -> {parent, index}
        this._menuIds = new Map(); // indicator -> handler id

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

        this._unbindDockManager();
        this._origins = this._menuIds = null;
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

    _attachToDock() {
        this._detachFromDock();

        const dock = this._dockManager?.mainDock;
        const dash = dock?.dash;
        const container = dash?._dashContainer;
        if (!container)
            return;

        const horizontal = dash._isHorizontal;
        this._dash = dash;
        this._trayBox = new St.BoxLayout({
            style_class: `dock-tray ${horizontal ? 'horizontal' : 'vertical'}`,
            orientation: horizontal ? Clutter.Orientation.HORIZONTAL : Clutter.Orientation.VERTICAL,
            x_align: Clutter.ActorAlign.CENTER,
            y_align: Clutter.ActorAlign.CENTER,
            x_expand: false,
            y_expand: false,
        });
        // The dock is being torn down (dash-to-dock rebuilds docks on settings and
        // monitor changes). User handlers run before Clutter destroys the children,
        // so hand the icons back to the panel before they die with the dock.
        this._trayBox.connect('destroy', () => {
            if (this._trayBox)
                this._restoreAll();
            this._trayBox = null;
            this._dash = null;
        });

        container.add_child(this._trayBox);
        this._sync();
    }

    _detachFromDock() {
        if (!this._trayBox)
            return;
        this._restoreAll();
        const box = this._trayBox;
        this._trayBox = null;
        this._dash = null;
        box.destroy();
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

        for (const [role, indicator] of Object.entries(Main.panel.statusArea)) {
            if (!indicator || !isTrayRole(role))
                continue;

            const container = indicator.container;
            const parent = container.get_parent();
            if (parent === this._trayBox)
                continue;

            if (parent) {
                this._origins.set(container, {
                    parent,
                    index: parent.get_children().indexOf(container),
                });
                parent.remove_child(container);
            }
            this._trayBox.add_child(container);
            this._trackMenu(indicator);

            container.connectObject('destroy', () => this._origins?.delete(container), this);
        }
    }

    _trackMenu(indicator) {
        if (this._menuIds.has(indicator) || !indicator.menu)
            return;

        const id = indicator.menu.connect('open-state-changed', (menu, open) => {
            if (!this._dash || this._trayBox?.contains(indicator.container) !== true)
                return;
            if (open) {
                // Menus were added to uiGroup before the dock existed; keep them on top.
                Main.uiGroup.set_child_above_sibling(menu.actor, null);
                this._dash.emit('menu-opened'); // keeps an autohiding dock revealed
            } else {
                this._dash.emit('menu-closed');
            }
        });
        this._menuIds.set(indicator, id);
        indicator.connectObject('destroy', () => this._menuIds?.delete(indicator), this);
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
                const id = this._menuIds.get(indicator);
                if (id)
                    indicator.menu?.disconnect(id);
                this._menuIds.delete(indicator);
            }
        }
        this._origins.clear();
    }
}
