rF2 Shared Memory Map Plugin
============================

rFactor2SharedMemoryMapPlugin64.dll  v3.7.15.1
Copyright (c) The Iron Wolf (TheIronWolfModding)

This plugin is third-party free software, distributed here UNMODIFIED as a
separate work alongside the Apex AIO System, under the GNU General Public
License v3.0 (see LICENSE.gpl-3.0.txt in this folder).

Source code: https://github.com/TheIronWolfModding/rF2SharedMemoryMapPlugin

What it is for
--------------
Le Mans Ultimate publishes no live telemetry (shared memory) unless this
plugin is installed in the game. The Apex AIO System copies it into
  <Le Mans Ultimate>\Plugins\
and enables it in CustomPluginVariables.JSON automatically on startup, the
same way CrewChief does. The app is a pure consumer of the memory-mapped
buffers the plugin publishes; it does not link against or modify the plugin.

If a copy of the plugin is already present in the game folder it is left
untouched, whatever its version.
