/**
 * @file src/server/pluginInstaller.ts
 * @module server/pluginInstaller
 *
 * Ships the **rF2 Shared Memory Map Plugin** into Le Mans Ultimate, so the
 * shared memory the overlays read actually exists.
 *
 * ## Why the app must do this
 * Without `rFactor2SharedMemoryMapPlugin64.dll` the game publishes **nothing**:
 * no `$rFactor2SMMP_*$` buffers, so no delta, no radar, no track map — the
 * provider silently falls back to demo data and the user sees fraud inputs.
 * That is exactly the tester failure mode on record (an empty `car` column in
 * the lap log). Asking every user to find a forum DLL and hand-edit a JSON is
 * not a product; CrewChief ships and installs the same plugin for the same
 * reason, and so do we.
 *
 * ## Where LMU wants it (verified on a live install, 2026-08-18)
 * - The DLL goes in `<LMU>\Plugins\` — the game ROOT, not rF2's `Bin64\Plugins`.
 * - It is switched on by an entry in `CustomPluginVariables.JSON`, keyed by the
 *   DLL filename, whose enable flag is spelled `" Enabled"` — **the leading
 *   space is real** and LMU will not match the key without it.
 * - Two copies of that file exist on a live install: `UserData\player\` (the
 *   engine's own location) and `Plugins\` (written by other tools). We always
 *   write the first, and keep the second in step only when it already exists.
 *
 * ## The rules about writing
 * - **Never touched when already right.** A present DLL is left alone even if
 *   it differs from the bundled one — the user may deliberately run a newer
 *   build, and any version publishes the buffers we read.
 * - **Never written while LMU runs.** The game reads its plugin list at launch
 *   and rewrites config on exit, so a write now is either ignored or unwritten.
 *   Callers get `blocked-running` and retry after the game closes.
 * - Every config write leaves a `.apex-backup` sibling first.
 *
 * ## Licensing
 * The DLL is TheIronWolf's rF2SharedMemoryMapPlugin (GPLv3), distributed
 * unmodified as a separate work alongside this app — see
 * `build/plugin/README.txt` for attribution and source.
 */

import { copyFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { candidateLmuRoots } from './lmuKeybinds';
import { isLmuRunning } from './lmuBinder';

/** The plugin's filename — also its key in `CustomPluginVariables.JSON`. */
export const PLUGIN_DLL = 'rFactor2SharedMemoryMapPlugin64.dll';

/**
 * Where the bundled DLL lives. Packaged builds carry it as an electron-builder
 * `extraResources` entry (`<resources>/plugin/`); a dev checkout has it in
 * `build/plugin/`. Null when neither exists (a build that forgot to bundle it).
 */
export function bundledPluginPath(): string | null {
  const candidates: string[] = [];
  const res = (process as NodeJS.Process & { resourcesPath?: string }).resourcesPath;
  if (res) candidates.push(join(res, 'plugin', PLUGIN_DLL));
  candidates.push(join(__dirname, '..', '..', 'build', 'plugin', PLUGIN_DLL));
  for (const c of candidates) {
    if (existsSync(c)) return c;
  }
  return null;
}

/** The LMU install root, proven by its exe — or null when the game is absent. */
export function findLmuRoot(): string | null {
  for (const root of candidateLmuRoots()) {
    if (existsSync(join(root, 'Le Mans Ultimate.exe'))) return root;
  }
  return null;
}

/** What one `CustomPluginVariables.JSON` says about our plugin. */
interface ConfigState {
  exists: boolean;
  enabled: boolean;
}

function readConfigState(path: string): ConfigState {
  if (!existsSync(path)) return { exists: false, enabled: false };
  try {
    const parsed = JSON.parse(readFileSync(path, 'utf8')) as Record<
      string,
      Record<string, unknown>
    >;
    const entry = parsed && typeof parsed === 'object' ? parsed[PLUGIN_DLL] : undefined;
    return { exists: true, enabled: !!entry && entry[' Enabled'] === 1 };
  } catch {
    // Unreadable counts as "not enabled" — the write path replaces it cleanly.
    return { exists: true, enabled: false };
  }
}

/**
 * Sets `" Enabled": 1` for the plugin in one config file, preserving every
 * other plugin's entry and any extra keys on our own (a user-tuned
 * `UnsubscribedBuffersMask` survives). Creates the file — and its folder, on an
 * install that has never been run — when absent.
 */
function enableInConfig(path: string): void {
  let parsed: Record<string, Record<string, unknown>> = {};
  if (existsSync(path)) {
    try {
      const raw = JSON.parse(readFileSync(path, 'utf8')) as unknown;
      if (raw && typeof raw === 'object' && !Array.isArray(raw)) {
        parsed = raw as Record<string, Record<string, unknown>>;
      }
    } catch {
      /* corrupt — rebuilt below, original kept in the backup */
    }
    try {
      copyFileSync(path, path + '.apex-backup');
    } catch {
      /* backup is best-effort */
    }
  } else {
    mkdirSync(dirname(path), { recursive: true });
  }
  parsed[PLUGIN_DLL] = { ...(parsed[PLUGIN_DLL] ?? {}), ' Enabled': 1 };
  writeFileSync(path, JSON.stringify(parsed, null, 2) + '\n', 'utf8');
}

/** What one ensure pass found and did. */
export interface PluginInstallResult {
  status:
    | 'installed' // DLL copied in (and enabled) — telemetry from LMU's next launch
    | 'enabled' // DLL was there, only the config needed switching on
    | 'up-to-date' // nothing to do, nothing touched
    | 'blocked-running' // work needed, but LMU is up — call again after it closes
    | 'no-lmu' // no install found on this machine
    | 'no-source' // this build has no bundled DLL to copy
    | 'error';
  lmuRoot: string | null;
  /** Where the DLL is (or would be) in the game folder. */
  dllPath: string | null;
  copied: boolean;
  /** Config files whose entry was switched on this pass. */
  enabledIn: string[];
  error?: string;
}

/**
 * Makes the plugin present and enabled, doing only what is missing.
 * `opts` exist for the tests: a fake root/source and a forced running flag.
 */
export function ensureSharedMemoryPlugin(
  opts: { root?: string | null; source?: string | null; running?: boolean } = {},
): PluginInstallResult {
  const lmuRoot = opts.root !== undefined ? opts.root : findLmuRoot();
  const base = { lmuRoot, dllPath: null as string | null, copied: false, enabledIn: [] as string[] };
  if (!lmuRoot) return { status: 'no-lmu', ...base };

  const dest = join(lmuRoot, 'Plugins', PLUGIN_DLL);
  base.dllPath = dest;
  const primary = join(lmuRoot, 'UserData', 'player', 'CustomPluginVariables.JSON');
  const secondary = join(lmuRoot, 'Plugins', 'CustomPluginVariables.JSON');

  const needCopy = !existsSync(dest);
  const needEnable: string[] = [];
  if (!readConfigState(primary).enabled) needEnable.push(primary);
  const secondaryState = readConfigState(secondary);
  if (secondaryState.exists && !secondaryState.enabled) needEnable.push(secondary);

  if (!needCopy && needEnable.length === 0) return { status: 'up-to-date', ...base };

  const source = opts.source !== undefined ? opts.source : bundledPluginPath();
  if (needCopy && (!source || !existsSync(source))) return { status: 'no-source', ...base };

  const running = opts.running !== undefined ? opts.running : isLmuRunning();
  if (running) return { status: 'blocked-running', ...base };

  try {
    if (needCopy) {
      mkdirSync(join(lmuRoot, 'Plugins'), { recursive: true });
      copyFileSync(source as string, dest);
      base.copied = true;
    }
    for (const p of needEnable) {
      enableInConfig(p);
      base.enabledIn.push(p);
    }
  } catch (err) {
    return { status: 'error', ...base, error: (err as Error).message };
  }
  return { status: base.copied ? 'installed' : 'enabled', ...base };
}

/**
 * The startup wiring: try now, and when the only obstacle is the running game,
 * keep trying quietly until it closes — the common flow is "launch the sim,
 * then the overlay", and without the retry that flow never gets the plugin.
 * Every terminal outcome logs one line, so a support question ("no telemetry")
 * is answerable from the log. Returns a cancel function for shutdown.
 */
export function ensureSharedMemoryPluginOnStartup(
  log: (line: string) => void = console.log,
  retryMs = 60_000,
): () => void {
  let warnedRunning = false;
  const attempt = (): boolean => {
    let r: PluginInstallResult;
    try {
      r = ensureSharedMemoryPlugin();
    } catch (err) {
      log(`[plugin] install check failed: ${(err as Error).message}`);
      return true;
    }
    switch (r.status) {
      case 'installed':
        log(
          `[plugin] installed ${PLUGIN_DLL} into ${r.lmuRoot} and enabled it — ` +
            'LMU publishes telemetry from its next launch',
        );
        return true;
      case 'enabled':
        log(`[plugin] enabled ${PLUGIN_DLL} in ${r.enabledIn.join(', ')}`);
        return true;
      case 'up-to-date':
        log('[plugin] shared-memory plugin present and enabled');
        return true;
      case 'no-lmu':
        log('[plugin] no Le Mans Ultimate install found — shared-memory plugin not installed');
        return true;
      case 'no-source':
        log('[plugin] this build has no bundled shared-memory plugin — cannot install it');
        return true;
      case 'error':
        log(`[plugin] could not install the shared-memory plugin: ${r.error}`);
        return true;
      case 'blocked-running':
        if (!warnedRunning) {
          log('[plugin] LMU is running — the shared-memory plugin will be installed when it closes');
          warnedRunning = true;
        }
        return false;
    }
  };

  if (attempt()) return () => {};
  const timer = setInterval(() => {
    if (attempt()) clearInterval(timer);
  }, retryMs);
  timer.unref?.();
  return () => clearInterval(timer);
}
