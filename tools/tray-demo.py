#!/usr/bin/python3
# SPDX-License-Identifier: GPL-2.0-or-later
# SPDX-FileCopyrightText: 2026 AlessandroTelesca
# Three fake tray apps for testing dock-tray@alessandrot.
import gi
gi.require_version('Gtk', '3.0')
gi.require_version('AyatanaAppIndicator3', '0.1')
from gi.repository import Gtk, AyatanaAppIndicator3 as AI

keep = []
for ident, icon, label in [('demo-net', 'network-wireless-symbolic', 'Network'),
                           ('demo-chat', 'mail-unread-symbolic', 'Chat'),
                           ('demo-sync', 'emblem-synchronizing-symbolic', 'Sync')]:
    ind = AI.Indicator.new(ident, icon, AI.IndicatorCategory.APPLICATION_STATUS)
    ind.set_status(AI.IndicatorStatus.ACTIVE)
    menu = Gtk.Menu()
    for text in (f'{label}: Status', f'{label}: Settings…'):
        menu.append(Gtk.MenuItem(label=text))
    menu.append(Gtk.SeparatorMenuItem())
    quit_item = Gtk.MenuItem(label='Quit demo')
    quit_item.connect('activate', Gtk.main_quit)
    menu.append(quit_item)
    menu.show_all()
    ind.set_menu(menu)
    keep.append(ind)
Gtk.main()
