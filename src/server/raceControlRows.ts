/**
 * @file src/server/raceControlRows.ts
 * @module server/raceControlRows
 *
 * The two **overlay-owned** pit rows: requesting a stop, and serving a penalty.
 *
 * ## Why they are rows at all
 * They started as buttons in a panel above the pit list, which made them
 * unreachable from the only input vocabulary that matters. The four bindable
 * controls — row ▲, row ▼, value +, value − — are how the driver drives this
 * widget with both hands on the wheel, and the single moment a driver most needs
 * to serve a penalty is the moment they least want to be finding a mouse. So
 * these join the list the cursor walks (see {@link module:server/pitCursor}),
 * behave exactly like the sim's own rows, and the buttons remain only as the
 * mouse-shaped way to press the same thing.
 *
 * ## Applying on change, and the one hazard in it
 * The sim's rows act when their value changes — select `Repair All` and the
 * repair is booked. These match that, because a row that needed a separate
 * "confirm" would need a fifth button nobody has.
 *
 * The hazard is that {@link SERVE_ROW}'s non-`OFF` options **strip the whole pit
 * stop back to no service**, which is destructive if it happens by accident. Two
 * things contain it: `OFF` is the resting state, so a deliberate move away from
 * it is required; and the cursor CLAMPS rather than wraps on these rows, so
 * running off the end cannot roll round into an action. It is the same risk
 * profile as the sim's own `DAMAGE:` row, which will equally happily book a
 * repair nobody asked for.
 *
 * The third thing that contains it is the way back: scrolling to `OFF` refills
 * fuel and virtual energy. Most of the cleared stop cannot be restored — see the
 * `OFF` branch — but the empty tank can be, and it is the part that would
 * otherwise end the race a lap after the driver changed their mind.
 */

import type { MfdController } from '../telemetry/mfdControl';
import type { KeySender } from './keySender';
import { readLmuKeybinds } from './lmuKeybinds';
import type { VirtualRow } from './pitCursor';

/** The penalty types the SERVE row offers, in the order it cycles them. */
const SERVE_OPTIONS = ['OFF', 'DRIVE-THRU', 'STOP/GO'] as const;
const SERVE_OFF = 0;
const SERVE_DRIVE_THROUGH = 1;
const SERVE_STOP_GO = 2;

/** `NO`/`YES` for the pit request row. */
const REQUEST_OPTIONS = ['NO', 'YES'] as const;

/**
 * What the driver last set each row to.
 *
 * Module-level for the same reason the cursor is: the server runs in-process
 * inside Electron, so a wheel button, an HTTP call from the widget and a click
 * are all looking at one value. Neither row can be read back from the sim —
 * there is no "which penalty am I serving" channel and no way to interrogate the
 * pit-request toggle — so this is the only record of intent there is, and it is
 * presented as intent rather than as a reading.
 */
let serveState: number = SERVE_OFF;
let requestState = 0;

/** Reset both rows — a new session has no penalty and no request outstanding. */
export function resetRaceControlRows(): void {
  serveState = SERVE_OFF;
  requestState = 0;
}

/**
 * Records a stop-and-go armed from somewhere OTHER than this row — the Control
 * Panel's bindable **Serve stop/go** button, or `POST /api/mfd/servestopgo`.
 *
 * Those do exactly what the row's own `STOP/GO` does (strip the service, request
 * the stop) while knowing nothing about it, which left the row saying `OFF` about
 * a stop that had just been stripped bare. That is not a cosmetic disagreement:
 * the row's state is what tells the MFD widget to flash an emptied fuel row, and
 * what puts the fuel back when the driver scrolls to `OFF`. Arming it by the
 * button and cancelling it by the row has to work, so both doors set one state.
 *
 * `requested` is whether the pit request itself landed. When it did not, this
 * lands on `DRIVE-THRU` for the same reason the row's own apply does: the menu is
 * cleared either way, but claiming a stop was booked when it was not is the one
 * lie that would have the driver sail past their box.
 */
export function noteServeArmed(requested: boolean): void {
  serveState = requested ? SERVE_STOP_GO : SERVE_DRIVE_THROUGH;
  if (requested) requestState = 1;
}

/** Presses LMU's own `Pit Request` bind. See mfdRoutes for why it is a key. */
async function pressPitRequest(keys: KeySender): Promise<{ ok: boolean; error?: string }> {
  const binds = readLmuKeybinds();
  if (!binds.path) return { ok: false, error: 'LMU keyboard config not found' };
  const key = binds.pit.pitRequest;
  if (!key) {
    return {
      ok: false,
      error:
        '"Pit Request" is not bound to a KEY in LMU — run scripts/bind-lmu-key.js with the game closed',
    };
  }
  if (!binds.keyboardSchemeActive) {
    return { ok: false, error: 'LMU has its keyboard scheme disabled' };
  }
  const res = await keys.pressScan(key);
  return res.ok ? { ok: true } : { ok: false, error: res.error ?? 'key press failed' };
}

/**
 * Builds the overlay-owned rows against a live controller and key sender.
 *
 * Returned fresh on every call rather than built once, because `current` has to
 * reflect the state as of *this* moment — the cursor asks for the rows and then
 * immediately reads the selected one's value out of them.
 */
export function buildRaceControlRows(
  controller: MfdController,
  keys: KeySender | null,
): VirtualRow[] {
  return [
    {
      name: 'SERVE:',
      options: [...SERVE_OPTIONS],
      current: serveState,
      apply: async (next) => {
        if (next === serveState) return { ok: true, applied: serveState };
        // Moving back to OFF cannot undo a cleared menu — the previous strategy
        // is gone and we never held a copy of it, so the tyres, the damage choice
        // and the driver change stay as the clear left them.
        //
        // Fuel is the exception, and it is the one that would end the race: a
        // driver who armed a penalty, changed their mind, and pitted on the
        // strategy they THINK they still have takes on nothing and stops on the
        // next lap. So the amount going in goes back to a full load — the one
        // unambiguously safe answer — while the driver change stays where it is,
        // because re-booking a swap nobody asked for costs far more than fuel.
        if (next === SERVE_OFF) {
          // Set first, so cancelling holds even if the sim refuses the write. The
          // row reports INTENT, and the intent here is "I am not serving one".
          serveState = SERVE_OFF;
          const filled = await controller.restorePitFuel();
          if (!filled.ok) {
            return {
              ok: false,
              applied: serveState,
              error: `Penalty cleared, but fuel is still at zero — ${filled.error ?? 'could not set it'}`,
            };
          }
          return { ok: true, applied: serveState };
        }
        const cleared = await controller.clearPitService();
        if (!cleared.ok) {
          return { ok: false, applied: serveState, error: cleared.error ?? 'could not clear service' };
        }
        // A stop/go means stopping in your box, so the stop IS requested. A
        // drive-through means driving the lane without stopping, so it must NOT
        // be — requesting one is how a drive-through becomes a drive-through
        // plus a pit stop.
        if (next === SERVE_STOP_GO) {
          if (!keys) {
            return { ok: false, applied: serveState, error: 'key sender unavailable' };
          }
          const pressed = await pressPitRequest(keys);
          if (!pressed.ok) {
            // The menu IS cleared, which is most of the value. Land on
            // DRIVE-THRU rather than claiming a stop was booked when it was not.
            serveState = SERVE_DRIVE_THROUGH;
            return {
              ok: false,
              applied: serveState,
              error: `Service cleared, but the stop was not requested — ${pressed.error}`,
            };
          }
          requestState = 1;
        }
        serveState = next;
        return { ok: true, applied: serveState };
      },
    },
    {
      name: 'PIT REQUEST:',
      options: [...REQUEST_OPTIONS],
      current: requestState,
      apply: async (next) => {
        if (next === requestState) return { ok: true, applied: requestState };
        if (!keys) return { ok: false, applied: requestState, error: 'key sender unavailable' };
        // LMU's pit request is a TOGGLE, so both directions are the same press.
        // What we cannot do is read whether it took: nothing in the API or the
        // shared memory reports the request flag, so this row tracks intent, and
        // the pit phase on the telemetry frame is what actually confirms it.
        const pressed = await pressPitRequest(keys);
        if (!pressed.ok) {
          return { ok: false, applied: requestState, error: pressed.error };
        }
        requestState = next;
        return { ok: true, applied: requestState };
      },
    },
  ];
}
