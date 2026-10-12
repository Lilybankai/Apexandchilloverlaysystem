/**
 * relay-source.js — Settings ▸ Application ▸ Relay source.
 * -----------------------------------------------------------------------------
 * Whose relayed tyres, damage and fuel the overlays may show while a teammate
 * drives our car (Linear THE-34):
 *   • Auto — the default: whichever teammate passes the gate in
 *            src/telemetry/teammateRelay.ts (same session, our car, the driver
 *            LMU has in it);
 *   • a teammate by name — only them, and STILL only when they pass the same
 *            gate, so a pinned teammate lapping a practice server shows
 *            nothing and the status line says so;
 *   • Off  — never.
 *
 * A thin renderer over the roster push main already sends (`team:cloud`):
 * the active team's members fill the list, `relaySource` is the stored pick,
 * `relaySourceEffective` is that pick resolved against the roster (a pin on
 * somebody who left the team reads Auto), and `relayStatus` is the gate's
 * latest word. Writes go through updateSettings({ relaySource }).
 *
 * scripts/test-relay-source-panel.js runs this file in a vm against a stub
 * DOM — a throw part-way through render() blanks the control without a sound.
 */

(function () {
  'use strict';

  const api = window.apex;
  if (!api || !api.teamCloudState || !api.updateSettings) return;

  const select = document.querySelector('#relay-source');
  const statusEl = document.querySelector('#relay-source-status');
  if (!select) return;

  /** Teammates the picker offers: the active team's roster, minus me. */
  function teammates(cloud) {
    if (!cloud || !Array.isArray(cloud.teams)) return [];
    const team = cloud.teams.find((t) => t && t.id === cloud.activeTeamId);
    const members = team && Array.isArray(team.members) ? team.members : [];
    return members.filter((m) => m && m.user_id && m.user_id !== cloud.selfUserId);
  }

  function option(value, label) {
    const o = document.createElement('option');
    o.value = value;
    o.textContent = label;
    return o;
  }

  function render(cloud) {
    const mates = teammates(cloud);
    const effective = (cloud && cloud.relaySourceEffective) || { mode: 'auto' };
    const value =
      effective.mode === 'off' ? 'off' : effective.mode === 'pin' && effective.pinUserId ? effective.pinUserId : 'auto';
    // Rebuilt only when the list changed, so an open dropdown is not yanked
    // shut by a status push once a second.
    const want = ['auto', ...mates.map((m) => `${m.user_id}:${m.name || ''}`), 'off'].join('|');
    if (select.dataset.options !== want) {
      select.replaceChildren(
        option('auto', 'Auto — the teammate in your car'),
        ...mates.map((m) => option(m.user_id, `${m.name || 'Teammate'} only`)),
        option('off', 'Off'),
      );
      select.dataset.options = want;
    }
    if (document.activeElement !== select) select.value = value;
    select.disabled = !(cloud && cloud.signedIn);

    if (statusEl) {
      const st = cloud && cloud.relayStatus;
      const pinnedGone =
        cloud &&
        typeof cloud.relaySource === 'string' &&
        cloud.relaySource !== 'auto' &&
        cloud.relaySource !== 'off' &&
        effective.mode === 'auto';
      const text = !cloud || !cloud.signedIn
        ? 'Sign in and join a team to use the relay.'
        : pinnedGone
          ? 'The pinned teammate is no longer on this team — using Auto.'
          : st && st.text
            ? st.text
            : '';
      statusEl.textContent = text;
      statusEl.dataset.state = (st && st.state) || 'idle';
    }
  }

  select.addEventListener('change', async () => {
    const v = select.value;
    try {
      await api.updateSettings({ relaySource: v });
    } catch {
      /* main re-pushes the truth either way */
    }
  });

  api.teamCloudState().then(render).catch(() => {});
  if (api.onTeamCloud) api.onTeamCloud(render);
})();
