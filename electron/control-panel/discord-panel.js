/**
 * discord-panel.js — Settings ▸ Discord: communities and the channels they post to.
 * -----------------------------------------------------------------------------
 * The renderer half of docs/DISCORD-NOTIFICATIONS.md. electron/discord-cloud.js
 * owns every call; this file owns what the driver sees and nothing else.
 *
 * Three things shape the markup here:
 *
 *   1. **The webhook URL is write-only.** It is typed once, sent once, and from
 *      then on the server hands back `.../webhooks/123/........`. So the editor
 *      has no "current value" to show for it: an empty webhook box on an
 *      existing channel means "keep the one you have", and the placeholder says
 *      so. Anything else would mean caching a secret in a renderer.
 *
 *   2. **Rows are per community and per channel**, so they are built here
 *      rather than living in index.html. Only the containers are contracted
 *      (scripts/test-panel-parity.js) — everything inside is reached through
 *      the container, never by a literal id, which is also what keeps the
 *      parity scanner honest about what is really wired.
 *
 *   3. **Two audiences on one screen.** Most drivers only ever join: a code
 *      from their league's Discord, a choice of what to share, done. Running a
 *      community is the rarer job, so the admin controls (the join code, the
 *      channels, the roster) only appear for an owner or admin and stay folded
 *      until asked for.
 */

'use strict';

window.apexDiscord = (function () {
  const $ = (sel) => document.querySelector(sel);

  let state = { signedIn: false, communities: [], personal: [], loaded: false, kinds: [] };
  /** Which channel editor is open, as `${scope}:${id}` — 'new' for an unsaved one. */
  let editing = null;
  let openRoster = null;

  /* ---------------------------------------------------------------- helpers */

  const esc = (s) =>
    String(s ?? '').replace(/[&<>"']/g, (c) =>
      ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);

  function say(text, bad) {
    const el = $('#discord-status');
    if (!el) return;
    el.textContent = text || '';
    el.dataset.bad = bad ? 'true' : 'false';
  }

  /** Every mutation goes through here so one refusal cannot be mistaken for
   *  another, and so the button that caused it is the one that unlocks. */
  async function run(btn, fn, okText) {
    if (btn) btn.disabled = true;
    say('');
    try {
      const res = await fn();
      if (!res || res.ok === false) {
        say((res && res.error) || 'That did not work.', true);
        return null;
      }
      if (okText) say(okText, false);
      return res;
    } catch (err) {
      say(String((err && err.message) || err), true);
      return null;
    } finally {
      if (btn) btn.disabled = false;
    }
  }

  /* ---------------------------------------------------------------- render */

  function render() {
    const signedOut = $('#discord-signedout');
    if (signedOut) signedOut.hidden = !!state.signedIn;

    const list = $('#discord-communities');
    const empty = $('#discord-communities-empty');
    if (list) list.innerHTML = state.communities.map(communityRow).join('');
    if (empty) empty.hidden = !state.loaded || state.communities.length > 0;

    const personal = $('#discord-personal');
    if (personal) {
      personal.innerHTML = state.personal.length
        ? state.personal.map((c) => channelRow(c, 'personal')).join('')
        : '<p class="weekempty">No channel of your own yet.</p>';
      if (editing === 'personal:new') personal.insertAdjacentHTML('beforeend', editor(null, null));
    }
  }

  function communityRow(c) {
    const admin = !!c.can_admin;
    const channels = Array.isArray(c.channels) ? c.channels : [];
    return `
      <div class="discord-row" data-community="${esc(c.id)}">
        <div class="discord-row__head">
          <strong>${esc(c.name)}</strong>
          <span class="chip" data-tone="cyan">${esc(c.role)}</span>
          <span class="field__hint">${Number(c.members) || 1} member${
            Number(c.members) === 1 ? '' : 's'
          }</span>
        </div>

        <label class="field">
          <span class="field__label">What this community may post about me</span>
          <select class="field__input" data-share="${esc(c.id)}">
            <option value="all"${c.share === 'all' ? ' selected' : ''}>Everything</option>
            <option value="records"${c.share === 'records' ? ' selected' : ''}>Records only</option>
            <option value="none"${c.share === 'none' ? ' selected' : ''}>Nothing</option>
          </select>
        </label>

        ${
          admin && c.join_code
            ? `<div class="discord-code">
                 <span class="field__label">Join code</span>
                 <code>${esc(c.join_code)}</code>
                 <button class="btn btn--ghost btn--sm" data-copy="${esc(c.join_code)}">Copy</button>
                 <button class="btn btn--ghost btn--sm" data-rotate="${esc(c.id)}">New code</button>
                 <span class="field__hint">
                   Paste it in your Discord. Anyone with it can publish to this
                   community — make a new one if it gets out.
                 </span>
               </div>`
            : ''
        }

        ${
          admin
            ? `<div class="discord-channels">
                 ${channels.map((ch) => channelRow(ch, c.id)).join('')}
                 ${editing === `${c.id}:new` ? editor(null, c.id) : ''}
                 <div class="lmu-bind__actions">
                   <button class="btn btn--ghost btn--sm" data-addchannel="${esc(c.id)}">
                     Add a channel
                   </button>
                   <button class="btn btn--ghost btn--sm" data-roster="${esc(c.id)}">
                     ${openRoster === c.id ? 'Hide members' : 'Members'}
                   </button>
                 </div>
                 <div class="discord-roster" data-rosterfor="${esc(c.id)}"></div>
               </div>`
            : ''
        }

        ${
          c.role === 'owner'
            ? ''
            : `<div class="lmu-bind__actions">
                 <button class="btn btn--ghost btn--sm" data-leave="${esc(c.id)}">Leave</button>
               </div>`
        }
      </div>`;
  }

  function channelRow(ch, scope) {
    const key = `${scope}:${ch.id}`;
    if (editing === key) return editor(ch, scope === 'personal' ? null : scope);
    const trouble = ch.paused
      ? `<span class="chip" data-tone="muted">Paused</span>`
      : ch.failures > 0
        ? `<span class="chip" data-tone="purple">${Number(ch.failures)} failed</span>`
        : '';
    return `
      <div class="discord-channel" data-channel="${esc(ch.id)}">
        <div class="discord-channel__head">
          <strong>${esc(ch.label || 'Channel')}</strong>${trouble}
        </div>
        <code class="discord-channel__url">${esc(ch.webhook)}</code>
        <span class="field__hint">
          ${esc((ch.kinds || []).map(kindLabel).join(', ') || 'Nothing selected')}${
            ch.watch_boards ? ' · plus records set by anyone on boards you race' : ''
          }
        </span>
        ${ch.last_error ? `<span class="field__hint" data-bad="true">${esc(ch.last_error)}</span>` : ''}
        <div class="lmu-bind__actions">
          <button class="btn btn--ghost btn--sm" data-edit="${esc(key)}">Edit</button>
          <button class="btn btn--ghost btn--sm" data-delete="${esc(ch.id)}">Remove</button>
        </div>
      </div>`;
  }

  function kindLabel(id) {
    return (state.kinds.find((k) => k.id === id) || { label: id }).label;
  }

  /**
   * The editor. `ch` null means a new channel — which is the only time the
   * webhook box is compulsory, because an existing channel already has one
   * stored that this screen is not allowed to read.
   */
  function editor(ch, communityId) {
    // Matches save_discord_target's own defaults: a channel of your own starts
    // with "records improved" on, a community's starts without it. Beating your
    // own record is news to you and to nobody else.
    const kinds =
      (ch && ch.kinds) ||
      (communityId
        ? ['record_taken', 'record_set', 'session_result']
        : ['record_taken', 'record_set', 'session_result', 'record_extended']);
    const checks = state.kinds
      .map(
        (k) => `
        <label class="field field--toggle">
          <input type="checkbox" data-kind="${esc(k.id)}"${kinds.includes(k.id) ? ' checked' : ''} />
          <span class="field__label">${esc(k.label)}</span>
          <span class="field__hint">${esc(k.hint)}</span>
        </label>`,
      )
      .join('');

    return `
      <div class="discord-editor" data-editor="1"
           data-id="${esc((ch && ch.id) || '')}" data-community="${esc(communityId || '')}">
        <label class="field">
          <span class="field__label">Name</span>
          <input class="field__input" data-field="label" type="text" maxlength="60"
                 value="${esc((ch && ch.label) || '')}" placeholder="Records" />
          <span class="field__hint">
            Only for telling your channels apart in this list. Written without
            a leading hash on purpose: scripts/test-panel-parity.js reads a
            hash followed by a word, in any file it scans, as an id lookup —
            and then fails the build because no such element exists.
          </span>
        </label>

        <label class="field">
          <span class="field__label">Webhook URL</span>
          <input class="field__input field__input--wide" data-field="webhook" type="text"
                 autocomplete="off" spellcheck="false"
                 placeholder="${ch ? 'Leave blank to keep the one already saved' : 'https://discord.com/api/webhooks/…'}" />
          <span class="field__hint">
            Discord ▸ Channel settings ▸ Integrations ▸ Webhooks ▸ Copy Webhook URL.
            It is stored encrypted and never shown again.
          </span>
        </label>

        ${checks}

        ${
          communityId
            ? `<label class="field field--toggle">
                 <input type="checkbox" data-field="watch_boards"${
                   !ch || ch.watch_boards ? ' checked' : ''
                 } />
                 <span class="field__label">Records set by anyone, on boards you race</span>
                 <span class="field__hint">
                   How a rival taking one of your members' records reaches this
                   channel. Being beaten always gets posted; strangers setting
                   records elsewhere are capped per day.
                 </span>
               </label>

               <label class="field">
                 <span class="field__label">Ignore boards with fewer than this many drivers</span>
                 <input class="field__input" data-field="min_entries" type="number"
                        min="0" max="100" step="1"
                        value="${Number((ch && ch.min_board_entries) ?? 3)}" />
                 <span class="field__hint">
                   A record on an empty board is a lap nobody has raced yet.
                 </span>
               </label>

               <label class="field">
                 <span class="field__label">Most stranger records per day</span>
                 <input class="field__input" data-field="daily_cap" type="number"
                        min="0" max="500" step="1"
                        value="${Number((ch && ch.daily_cap) ?? 20)}" />
               </label>`
            : ''
        }

        ${
          ch
            ? `<label class="field field--toggle">
                 <input type="checkbox" data-field="paused"${ch.paused ? ' checked' : ''} />
                 <span class="field__label">Paused</span>
                 <span class="field__hint">Nothing is posted while this is on.</span>
               </label>`
            : ''
        }

        <div class="lmu-bind__actions">
          <button class="btn btn--accent btn--sm" data-save="1">Save</button>
          <button class="btn btn--ghost btn--sm" data-test="1">Send a test message</button>
          <button class="btn btn--ghost btn--sm" data-cancel="1">Cancel</button>
        </div>
      </div>`;
  }

  /* ---------------------------------------------------------------- actions */

  function readEditor(box) {
    const val = (name) => box.querySelector(`[data-field="${name}"]`);
    const num = (name) => {
      const el = val(name);
      const n = el ? Number(el.value) : NaN;
      return Number.isFinite(n) ? n : null;
    };
    return {
      id: box.dataset.id || null,
      communityId: box.dataset.community || null,
      label: val('label') ? val('label').value : '',
      webhook: val('webhook') ? val('webhook').value.trim() : '',
      kinds: Array.from(box.querySelectorAll('[data-kind]'))
        .filter((el) => el.checked)
        .map((el) => el.dataset.kind),
      watchBoards: val('watch_boards') ? val('watch_boards').checked : undefined,
      minEntries: num('min_entries'),
      dailyCap: num('daily_cap'),
      paused: val('paused') ? val('paused').checked : undefined,
    };
  }

  async function onClick(evt) {
    const t = evt.target.closest('button');
    if (!t) return;
    const box = t.closest('[data-editor]');

    if (t.dataset.copy !== undefined) {
      try {
        await navigator.clipboard.writeText(t.dataset.copy);
        say('Join code copied.');
      } catch {
        say('Could not reach the clipboard.', true);
      }
      return;
    }

    if (t.dataset.rotate) {
      // Destructive in a way that is easy to click by accident: every member
      // who has not joined yet is holding the old code.
      if (!window.confirm('Make a new join code? The old one stops working immediately.')) return;
      await run(t, () => window.apex.discordRotateCode(t.dataset.rotate), 'New code issued.');
      return;
    }

    if (t.dataset.leave) {
      if (!window.confirm('Leave this community? Your records stop being posted there.')) return;
      await run(t, () => window.apex.discordLeaveCommunity(t.dataset.leave), 'Left.');
      return;
    }

    if (t.dataset.addchannel !== undefined && t.dataset.addchannel) {
      editing = `${t.dataset.addchannel}:new`;
      render();
      return;
    }

    if (t.dataset.edit) {
      editing = t.dataset.edit;
      render();
      return;
    }

    if (t.dataset.delete) {
      if (!window.confirm('Remove this channel? Nothing more will be posted to it.')) return;
      await run(t, () => window.apex.discordDeleteChannel(t.dataset.delete), 'Channel removed.');
      return;
    }

    if (t.dataset.roster) {
      const id = t.dataset.roster;
      const holder = document.querySelector(`[data-rosterfor="${CSS.escape(id)}"]`);
      if (openRoster === id) {
        openRoster = null;
        if (holder) holder.innerHTML = '';
        render();
        return;
      }
      const res = await run(t, () => window.apex.discordRoster(id));
      if (!res || !holder) return;
      openRoster = id;
      holder.innerHTML = res.members
        .map(
          (m) => `
          <div class="discord-member">
            <span>${esc(m.name)}</span>
            <span class="field__hint">${esc(m.role)} · shares ${esc(m.share)}</span>
            ${
              m.role === 'owner'
                ? ''
                : `<button class="btn btn--ghost btn--sm" data-kick="${esc(id)}"
                           data-user="${esc(m.user_id)}">Remove</button>`
            }
          </div>`,
        )
        .join('');
      return;
    }

    if (t.dataset.kick) {
      if (!window.confirm('Remove this driver from the community?')) return;
      await run(t, () => window.apex.discordRemoveMember(t.dataset.kick, t.dataset.user), 'Removed.');
      openRoster = null;
      return;
    }

    if (!box) return;

    if (t.dataset.cancel) {
      editing = null;
      render();
      return;
    }

    if (t.dataset.test) {
      const url = box.querySelector('[data-field="webhook"]').value.trim();
      if (!url) {
        say('Paste the webhook URL first — a saved one cannot be read back to test it.', true);
        return;
      }
      await run(t, () => window.apex.discordTestWebhook(url), 'Sent — check the channel.');
      return;
    }

    if (t.dataset.save) {
      const res = await run(t, () => window.apex.discordSaveChannel(readEditor(box)), 'Saved.');
      if (res) {
        editing = null;
        render();
      }
    }
  }

  async function onChange(evt) {
    const sel = evt.target.closest('[data-share]');
    if (!sel) return;
    await run(sel, () => window.apex.discordSetShare(sel.dataset.share, sel.value), 'Saved.');
  }

  /* ---------------------------------------------------------------- wiring */

  function bind() {
    for (const id of ['#discord-communities', '#discord-personal']) {
      const el = $(id);
      if (!el) continue;
      el.addEventListener('click', (e) => void onClick(e));
      el.addEventListener('change', (e) => void onChange(e));
    }

    $('#discord-join')?.addEventListener('click', async (e) => {
      const input = $('#discord-join-code');
      const res = await run(e.currentTarget, () => window.apex.discordJoinCommunity(input.value));
      if (res) {
        input.value = '';
        say(`Joined ${res.name || 'the community'}.`);
      }
    });

    $('#discord-create')?.addEventListener('click', async (e) => {
      const input = $('#discord-create-name');
      const res = await run(e.currentTarget, () => window.apex.discordCreateCommunity(input.value));
      if (res) {
        input.value = '';
        say(`Created. Share the join code ${res.code || ''} in your Discord.`);
      }
    });

    $('#discord-add-personal')?.addEventListener('click', () => {
      editing = 'personal:new';
      render();
    });

    $('#discord-refresh')?.addEventListener('click', (e) =>
      void run(e.currentTarget, () => window.apex.discordRefresh()));

    window.apex.onDiscordState((next) => {
      state = next || state;
      render();
    });
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', bind, { once: true });
  } else {
    bind();
  }

  return {
    /** Called by the settings router when the Discord pane is opened. */
    async shown() {
      const next = await window.apex.discordRefresh();
      if (next) state = next;
      render();
    },
  };
})();
