/**
 * electron/actions.js — the named-action registry.
 * -----------------------------------------------------------------------------
 * One table of things the operator can trigger, so every input source binds to
 * the same vocabulary: a keyboard key or Stream Deck button (via globalShortcut),
 * a wheel button (via the DirectInput reader), or a click on the MFD widget.
 * Nothing else in the app should know how an action is invoked, and the input
 * layers should not know what an action does.
 *
 * ## Two kinds of action
 *   - `pulse` — fires once (toggle the overlay, request a pit stop).
 *   - `delta` — takes a direction, ±1 (brake bias, TC, opacity). Encoders map
 *     onto these naturally: one detent = one call with the sign of the turn.
 *
 * ## Where the work happens
 * The telemetry server runs **in-process** in Electron main, so actions call the
 * compiled modules directly rather than looping back through HTTP. Pit strategy
 * goes over LMU's REST API (needs neither window focus nor a visible MFD);
 * driving aids go through keystroke injection, using the scancodes read out of
 * LMU's own `keyboard.json` (see server/lmuKeybinds) and guarded so a key can
 * only ever land in the sim.
 *
 * Everything degrades: if `dist/` is not built, or koffi is missing, or LMU is
 * not installed, the affected actions simply do not register and the rest work.
 */

'use strict';

const path = require('node:path');

/** Requires a compiled module from dist/, or null when unavailable. */
function tryRequire(rel) {
  try {
    return require(path.join(__dirname, '..', 'dist', rel));
  } catch (err) {
    return null;
  }
}

/**
 * Builds the action table.
 *
 * @param {object} deps Wiring supplied by main.js. Every one is optional; an
 *   action whose dependency is missing is left out of the registry rather than
 *   registered as something that throws when triggered.
 * @param {() => object} deps.loadSettings
 * @param {(partial: object) => void} deps.applySettings  persist + push a change
 * @param {() => void} [deps.cycleIngame]
 * @param {() => void} [deps.toggleIngameInteract]
 * @param {() => void} [deps.resetLayout]
 * @param {(widgetId: string) => void} [deps.cycleWidgetMode]
 * @returns {{ list: () => object[], get: (id: string) => object|undefined,
 *            run: (id: string, dir?: number) => Promise<object> }}
 */
function createActions(deps = {}) {
  const keySenderMod = tryRequire('server/keySender.js');
  const keybindsMod = tryRequire('server/lmuKeybinds.js');
  const mfdMod = tryRequire('telemetry/mfdControl.js');
  const cursorMod = tryRequire('server/pitCursor.js');
  // The overlay-owned SERVE/PIT REQUEST rows. Required so the stop-and-go button
  // below can tell the SERVE row what it just did — the server runs in-process
  // here, so this is the same module state the MFD widget polls.
  const raceRowsMod = tryRequire('server/raceControlRows.js');

  /** One KeySender for the process; it holds no per-press state. */
  const keys = keySenderMod ? new keySenderMod.KeySender({ verbose: false }) : null;

  /**
   * LMU's binds, re-read on demand rather than cached: LMU rewrites
   * keyboard.json when it exits, so a cached map goes stale the moment the
   * driver rebinds anything.
   */
  const readBinds = () => (keybindsMod ? keybindsMod.readLmuKeybinds() : null);

  let mfdController = null;
  function controller() {
    if (!mfdMod) return null;
    if (!mfdController) {
      const settings = deps.loadSettings ? deps.loadSettings() : {};
      mfdController = new mfdMod.MfdController({
        lmuApiPort: settings.lmuApiPort || 6397,
        verbose: false,
      });
    }
    return mfdController;
  }

  /** @type {Map<string, object>} */
  const registry = new Map();

  function define(action) {
    registry.set(action.id, action);
  }

  /* ---------------------------------------------------------------- */
  /*  Race engineer                                                     */
  /* ---------------------------------------------------------------- */

  if (deps.engineerAsk) {
    define({
      id: 'engineer.ask',
      // "push-to-talk" in the label because that is what the driver is looking
      // for in the bindings list — the action name alone reads as a chat thing.
      label: 'Ask the race engineer (push-to-talk)',
      group: 'Engineer',
      kind: 'pulse',
      run: async () => deps.engineerAsk(),
    });
  }

  // On-demand callouts: one press, one line, no microphone. The catalog lives
  // next to the phrase list in engineer.js so a new bindable intent cannot
  // drift from the recognizer. A missing speak hook leaves the rows out
  // rather than registering buttons that throw.
  if (deps.engineerSpeak) {
    let callouts = [];
    try {
      callouts = require('./engineer').ENGINEER_CALLOUTS || [];
    } catch {
      callouts = [];
    }
    for (const c of callouts) {
      if (!c || !c.intent || !c.label) continue;
      define({
        id: `engineer.call.${c.intent}`,
        label: c.label,
        group: 'Engineer',
        kind: 'pulse',
        run: async () => deps.engineerSpeak(c.intent),
      });
    }
  }

  /* ---------------------------------------------------------------- */
  /*  Overlay actions — no game involvement, always available          */
  /* ---------------------------------------------------------------- */

  if (deps.cycleIngame) {
    define({
      id: 'overlay.toggle',
      // One key, three states: Show → Off → Edit layout → Show. Named for what
      // it does rather than left as "Show / hide" — someone rebinding this needs
      // to know edit mode is on the same key before they land in it mid-session.
      label: 'Show / hide / edit overlay',
      group: 'Overlay',
      kind: 'pulse',
      run: async () => {
        deps.cycleIngame();
        return { ok: true };
      },
    });
  }

  if (deps.toggleIngameInteract) {
    define({
      id: 'overlay.interact',
      label: 'Toggle interact mode',
      group: 'Overlay',
      kind: 'pulse',
      run: async () => {
        deps.toggleIngameInteract();
        return { ok: true };
      },
    });
  }

  if (deps.resetLayout) {
    define({
      id: 'overlay.resetLayout',
      label: 'Reset widget layout',
      group: 'Overlay',
      kind: 'pulse',
      run: async () => {
        deps.resetLayout();
        return { ok: true };
      },
    });
  }

  if (deps.loadSettings && deps.applySettings) {
    define({
      id: 'overlay.background',
      label: 'Widget background opacity',
      group: 'Overlay',
      kind: 'delta',
      /** One detent = 5%, so a full encoder sweep covers the range sensibly. */
      run: async (dir) => {
        const current = deps.loadSettings().panelOpacity;
        const next = Math.max(0, Math.min(100, current + (dir < 0 ? -5 : 5)));
        if (next !== current) deps.applySettings({ panelOpacity: next });
        return { ok: true, value: next };
      },
    });
  }

  if (deps.rescanWheels) {
    define({
      id: 'wheel.rescan',
      // What the Scan button on the bindings page does, bindable. On the wheel
      // that actually lost its connection this can never fire — its presses no
      // longer arrive — so it earns its keep on a keyboard key, a Stream Deck,
      // or a second device (button box), and as an instant "kick it" that beats
      // waiting out the automatic watchdog.
      label: 'Reconnect wheel (rescan devices)',
      group: 'Wheel',
      kind: 'pulse',
      run: async () => {
        const names = await deps.rescanWheels();
        if (!names.length) {
          return { ok: false, error: 'no controllers found — check USB and base power' };
        }
        return { ok: true, notice: `Wheel reconnected — ${names.join(', ')}` };
      },
    });
  }

  if (deps.cycleWidgetMode) {
    define({
      id: 'widget.tyres.mode',
      label: 'Tyre readout (temp / surface / tread / map)',
      group: 'Widgets',
      kind: 'pulse',
      run: async () => {
        deps.cycleWidgetMode('tyres');
        return { ok: true };
      },
    });
  }

  /* ---------------------------------------------------------------- */
  /*  Driving aids — deliberately NOT bindable actions                 */
  /* ---------------------------------------------------------------- */

  /*
   * There used to be one delta action per aid (`aid.tc`, `aid.abs`, …), each
   * pressing LMU's own key. They are gone, and their absence is the fix for a
   * real bug rather than a tidy-up.
   *
   * Two bindings on one button. A driver binds a wheel encoder to `pit.valueInc`
   * — the ± of the four MFD controls — and, at some earlier point, the same
   * button to `aid.tc`. Nothing stops that: the two live in different groups and
   * a wheel button is not consumed, so both fire on every press. The result is
   * traction control creeping up and down whenever a pit value is changed, from
   * a control the driver has long since stopped thinking about. It looked for
   * all the world like the overlay misreading TC.
   *
   * They are also redundant now. The MFD cursor walks the aid rows along with
   * everything else (see server/pitCursor), so ▲ ▼ + − reach every aid without
   * a binding of their own — which is the whole point of having four buttons
   * instead of twenty.
   */

  /* ---------------------------------------------------------------- */
  /*  Pit strategy — REST, independent of focus and of the MFD page    */
  /* ---------------------------------------------------------------- */

  if (mfdMod) {
    define({
      id: 'pit.fuelRatio',
      label: 'Fuel ratio',
      group: 'Pit strategy',
      kind: 'delta',
      run: async (dir) => {
        const c = controller();
        if (!c) return { ok: false, error: 'pit control unavailable' };
        return c.setPitRow({ name: 'FUEL RATIO:' }, { delta: dir < 0 ? -1 : 1 });
      },
    });

    define({
      id: 'pit.virtualEnergy',
      label: 'Virtual energy',
      group: 'Pit strategy',
      kind: 'delta',
      run: async (dir) => {
        const c = controller();
        if (!c) return { ok: false, error: 'pit control unavailable' };
        return c.setPitRow({ name: 'VIRTUAL ENERGY:' }, { delta: dir < 0 ? -1 : 1 });
      },
    });

    // The whole tyre decision on one control: a step here moves all four
    // corners together, so "put the wets on" is one button rather than four
    // rows of scrolling. See MfdController.setTyreCompound.
    define({
      id: 'pit.tyreCompound',
      label: 'Tyre compound (all four)',
      group: 'Pit strategy',
      kind: 'delta',
      run: async (dir) => {
        const c = controller();
        if (!c) return { ok: false, error: 'pit control unavailable' };
        return c.setTyreCompound({ delta: dir < 0 ? -1 : 1 });
      },
    });

    // Serving a stop-and-go, in the only two steps that can be automated:
    // strip the stop back to no service, then ask for the stop.
    define({
      id: 'pit.clearService',
      label: 'Clear pit service (stop/go)',
      group: 'Pit strategy',
      kind: 'pulse',
      run: async () => {
        const c = controller();
        if (!c) return { ok: false, error: 'pit control unavailable' };
        return c.clearPitService();
      },
    });
  }

  /* ---------------------------------------------------------------- */
  /*  Pit request — a keystroke, because LMU exposes no REST route     */
  /* ---------------------------------------------------------------- */

  if (keys && keys.available) {
    define({
      id: 'pit.request',
      label: 'Request pit stop',
      group: 'Pit strategy',
      kind: 'pulse',
      /**
       * Re-reads the binds each press, like the aid actions: LMU rewrites
       * keyboard.json on exit, so a cached key goes stale after a rebind. Fails
       * with the fix rather than a shrug when "Pit Request" is only on a wheel
       * button, which is where most drivers have it.
       */
      run: async () => {
        const fresh = readBinds();
        const key = fresh && fresh.pit && fresh.pit.pitRequest;
        const canPress = !!key && fresh.keyboardSchemeActive;

        if (canPress) {
          const pressed = await keys.pressScan(key);
          if (pressed.ok && raceRowsMod && raceRowsMod.notePitRequestPressed) {
            // Flip the PIT REQUEST row's intent so the MFD widget shows the
            // press. No notice: the racecontrol widget shows PIT REQUESTED /
            // CANCELLED from the sim's own flag, which is the confirmation —
            // a pop-up on top of it would say everything twice.
            raceRowsMod.notePitRequestPressed();
          }
          return pressed;
        }

        // No key to press — but that is not yet a failure. The same physical
        // button is very often ALSO bound inside LMU, in which case the game
        // just booked the stop itself and this action merely rode along. The
        // PIT REQUEST row reads the sim now, so wait a beat and look: if the
        // sim's flag moved, the driver got exactly what they pressed for, and
        // a red error over a working button is a false alarm that teaches
        // them to ignore real ones.
        if (
          raceRowsMod &&
          raceRowsMod.isPitRequestLive &&
          raceRowsMod.isPitRequestLive() &&
          raceRowsMod.getPitRequestState
        ) {
          const before = raceRowsMod.getPitRequestState();
          await new Promise((r) => setTimeout(r, 900));
          const after = raceRowsMod.getPitRequestState();
          // Confirmed by the sim — and the racecontrol widget is already
          // showing PIT REQUESTED / CANCELLED from the same flag, so there is
          // nothing left for a pop-up to add.
          if (after !== before) return { ok: true };
        }

        return {
          ok: false,
          error: key
            ? 'LMU has its keyboard scheme disabled'
            : '"Pit Request" is not bound to a KEY in LMU — bind it under ' +
              'Controls → Keyboard (a wheel button cannot be pressed from here).',
        };
      },
    });

    // The two halves as one button, in the order they have to happen: clearing
    // the menu AFTER requesting would leave a stop already booked with service
    // on it, which is the exact mistake this exists to prevent.
    if (mfdMod) {
      define({
        id: 'pit.serveStopGo',
        label: 'Serve stop/go (clear service + request pit)',
        group: 'Pit strategy',
        kind: 'pulse',
        run: async () => {
          const c = controller();
          if (!c) return { ok: false, error: 'pit control unavailable' };
          const cleared = await c.clearPitService();
          if (!cleared.ok) return cleared;
          // The service is stripped from here on, whatever the key does next, so
          // the SERVE row has to know: it is what flashes an emptied fuel row on
          // the MFD widget, and what refills it if the driver changes their mind
          // and scrolls that row back to OFF.
          const armed = (requested) => {
            if (raceRowsMod && raceRowsMod.noteServeArmed) raceRowsMod.noteServeArmed(requested);
          };
          const fresh = readBinds();
          const key = fresh && fresh.pit && fresh.pit.pitRequest;
          if (!key) {
            // The menu IS clear, which is most of the value — say so rather
            // than reporting a flat failure the driver would act on twice.
            armed(false);
            return {
              ok: false,
              error:
                'Service cleared, but "Pit Request" is not bound to a key in LMU — ' +
                'request the stop yourself.',
              cleared: cleared.cleared,
            };
          }
          const pressed = await keys.pressScan(key);
          armed(pressed.ok === true);
          return pressed.ok
            ? {
                ...pressed,
                cleared: cleared.cleared,
                notice: 'Stop/go armed — service cleared, stop requested',
              }
            : pressed;
        },
      });
    }
  }

  /* ---------------------------------------------------------------- */
  /*  Pit menu cursor — the whole menu from four buttons               */
  /* ---------------------------------------------------------------- */

  // The named pit actions above each own one row, which does not scale: the menu
  // runs to ~20 rows and nobody is binding twenty pairs of buttons. These four
  // are the in-game MFD's own idiom instead — scroll to FL TIRE, press +, get a
  // new medium — except that they go over REST, so the sim's MFD never has to be
  // on screen and the sim does not even have to be the focused window.
  //
  // Four PULSE actions rather than two `delta` ones on purpose: a delta action
  // gets both directions from a wheel encoder but only ONE global hotkey (see
  // applyBindings in main.js), and these must be bindable from a keyboard or a
  // Stream Deck too — which is most of the point of having them.
  if (mfdMod && cursorMod) {
    const cursorAction = (id, label, run) =>
      define({ id, label, group: 'Pit strategy', kind: 'pulse', run });

    const withController = (fn) => async () => {
      const c = controller();
      if (!c) return { ok: false, error: 'pit control unavailable' };
      return fn(c);
    };

    cursorAction(
      'pit.rowUp',
      'Pit menu ▲ (previous row)',
      withController((c) => cursorMod.moveCursorLive(-1, c)),
    );
    cursorAction(
      'pit.rowDown',
      'Pit menu ▼ (next row)',
      withController((c) => cursorMod.moveCursorLive(1, c)),
    );
    cursorAction(
      'pit.valueInc',
      'Pit menu + (raise selected value)',
      withController((c) => cursorMod.stepSelected(1, c)),
    );
    cursorAction(
      'pit.valueDec',
      'Pit menu − (lower selected value)',
      withController((c) => cursorMod.stepSelected(-1, c)),
    );
  }

  return {
    /** Every registered action, as plain data for the bindings UI. */
    list: () =>
      [...registry.values()].map((a) => ({
        id: a.id,
        label: a.label,
        group: a.group,
        kind: a.kind,
      })),

    get: (id) => registry.get(id),

    /**
     * Runs an action by id. `dir` is the ±1 for `delta` actions and ignored by
     * `pulse` ones. Never throws — a failing action returns `{ok:false,error}`
     * so a bad binding cannot take down the input loop.
     */
    run: async (id, dir = 1) => {
      const action = registry.get(id);
      if (!action) return { ok: false, error: `unknown action: ${id}` };
      try {
        return (await action.run(dir)) || { ok: true };
      } catch (err) {
        return { ok: false, error: err && err.message ? err.message : String(err) };
      }
    },
  };
}

module.exports = { createActions };
