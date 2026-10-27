// ==UserScript==
// @name         Twitch Emote Burst
// @namespace    local.twitch.emote-burst
// @version      1.4.1
// @description  Emote bursts and scheduled Channel Points rewards, with a dashboard, cooldown checks, and cancel controls.
// @match        https://www.twitch.tv/*
// @run-at       document-idle
// @noframes
// @grant        none
// @license      MIT
// ==/UserScript==

/*
 * Install: Tampermonkey > Create a new script > paste this file > Save.
 * Open a channel, click the repeat-arrow button beside chat settings, then Start.
 * Emotes use the normal chat composer. The Rewards tab uses Twitch's private
 * web GraphQL API with the existing Twitch login, only when you use that tab.
 * Login credentials are sent only to https://gql.twitch.tv/gql, never stored
 * by this script. Twitch can change this private API or require verification.
 * No extra chat connections are used.
 *
 * Limits checked 2026-10-16:
 * https://dev.twitch.tv/docs/chat#twitch-chat-rate-limits
 * Regular accounts: 20 messages / 30 seconds, 1 / second / channel.
 * Documented consequence of exceeding limits: messages ignored for 1 hour
 * (with broadcaster/mod/VIP exceptions). This script uses 18 / 30 seconds
 * and a minimum 2-second interval, including observed manual attempts.
 * https://dev.twitch.tv/docs/api/reference#send-chat-message
 * Message maximum: 500 characters. Both alternating blocks are checked.
 *
 * No guarantee of delivery: other devices/extensions are not observable;
 * slow mode, duplicate/unique-chat filters, AutoMod, emote availability,
 * and channel moderation apply separately. It stops on detected rejection.
 * UI selectors can change with Twitch updates. Never retries a submission
 * whose result is uncertain, and never replays missed timer ticks.
 */
(() => {
  'use strict';
  const MAX_LENGTH = 500;
  const WINDOW_MS = 30000;
  const BUDGET = 18;
  const MIN_GAP_MS = 2000;
  const DEFAULTS = { emote: 'manguwIly', block: 18, times: 4, delay: 4, mode: 'burst' };
  const PREFIX = 'tm-twitch-emote-burst-v1:';

  function settings(raw) {
    const emote = String(raw.emote || '').trim();
    const block = Number(raw.block), times = Number(raw.times), delay = Number(raw.delay);
    const mode = raw.mode ?? 'burst';
    if (!['burst', 'repeat'].includes(mode)) throw new Error('Choose Burst or Repeat mode.');
    if (!emote || /\s/.test(emote) || emote.startsWith('/')) throw new Error('Enter one emote name, without spaces or a slash.');
    if (!Number.isInteger(block) || block < 1) throw new Error('Emotes per message must be a whole number above zero.');
    if (!Number.isInteger(times) || times < 1 || times > 100) throw new Error('Choose 1–100 messages per burst.');
    if (!Number.isFinite(delay) || delay < 2 || delay > 3600) throw new Error('Choose an interval from 2 to 3,600 seconds.');
    const max = Math.floor((MAX_LENGTH + 1) / (emote.length + 1));
    if (block + 1 > max) throw new Error(`Use at most ${Math.max(0, max - 1)} emotes per message; the alternate adds one and both must fit 500 characters.`);
    return { emote, block, times, delay, mode };
  }

  function countdown(ms) {
    const seconds = Math.max(0, Math.ceil(ms / 1000));
    return `${String(Math.floor(seconds / 60)).padStart(2, '0')}:${String(seconds % 60).padStart(2, '0')}`;
  }

  function cooldownDelay(value, now = Date.now()) {
    if (value == null) return 0;
    const end = Date.parse(value);
    if (!Number.isFinite(end)) throw new Error('Twitch returned an invalid reward cooldown.');
    return end > now ? end - now + 1000 : 0;
  }

  function makeMessage(config, index, last = '') {
    let count = config.block + index % 2;
    let text = Array(count).fill(config.emote).join(' ');
    if (text === last) {
      count = count === config.block ? config.block + 1 : config.block;
      text = Array(count).fill(config.emote).join(' ');
    }
    if (text.length > MAX_LENGTH) throw new Error('Message is over 500 characters.');
    return text;
  }

  function recent(history, now) {
    return history.filter(n => Number.isFinite(n) && n > now - WINDOW_MS && n <= now + WINDOW_MS).sort((a, b) => a - b);
  }

  function waitForBudget(history, now) {
    const entries = recent(history, now);
    return Math.max(0,
      entries.length ? entries.at(-1) + MIN_GAP_MS - now : 0,
      entries.length >= BUDGET ? entries[entries.length - BUDGET] + WINDOW_MS + 100 - now : 0);
  }

  function channelKey(url) {
    const parts = new URL(url).pathname.split('/').filter(Boolean);
    if (parts[0] === 'popout' && parts[2] === 'chat') return parts[1].toLowerCase();
    if (parts[0] === 'moderator' && parts[1]) return parts[1].toLowerCase();
    if (parts.length === 1 && !['directory', 'downloads', 'inventory', 'subscriptions', 'settings', 'search', 'wallet', 'turbo'].includes(parts[0])) return parts[0].toLowerCase();
    // VODs and clips may have a read-only replay composer; don't post there.
    return null;
  }

  if (typeof module !== 'undefined' && module.exports) {
    module.exports = { settings, makeMessage, recent, waitForBudget, channelKey, countdown, cooldownDelay, DEFAULTS };
    return;
  }
  if (document.getElementById('tm-emote-dashboard')) return;

  let run = null;
  let ownSubmission = false;
  let lastSubmitted = 0;
  let rewardRun = null;
  let rewardSnapshot = null;
  let currentChannel = channelKey(location.href);
  const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
  function load(key, fallback) {
    const raw = localStorage.getItem(PREFIX + key);
    if (!raw) return fallback;
    try { return JSON.parse(raw); } catch { return fallback; }
  }
  function store(key, value) { localStorage.setItem(PREFIX + key, JSON.stringify(value)); }
  function ledger() {
    const entries = load('attempts', []);
    return recent(Array.isArray(entries) ? entries : [], Date.now());
  }
  function recordAttempt() {
    const entries = ledger();
    entries.push(Date.now());
    store('attempts', entries);
  }

  const host = document.createElement('span');
  host.id = 'tm-emote-burst';
  host.style.cssText = 'display:inline-flex;align-items:center;vertical-align:middle';
  const shadow = host.attachShadow({ mode: 'open' });
  shadow.innerHTML = `<style>
    :host{font:13px/1.45 Inter,system-ui,sans-serif;color:#efeff1}
    *{box-sizing:border-box}button,input,select{font:inherit}
    button{cursor:pointer}button:disabled,input:disabled,select:disabled{opacity:.5;cursor:default}
    #toggle{display:flex;align-items:center;justify-content:center;width:30px;height:30px;padding:5px;border:0;border-radius:4px;background:transparent;color:inherit}
    #toggle:hover,#toggle[aria-expanded=true]{background:#ffffff26}#toggle.running{color:#bf94ff;background:#9146ff33}
    #menu{position:fixed;z-index:2147483647;width:316px;max-width:calc(100vw - 16px);max-height:calc(100vh - 24px);overflow:auto;padding:16px;background:#18181b;border:1px solid #53535f;border-radius:9px;box-shadow:0 7px 28px #0009;color:#efeff1;text-align:left}
    [hidden]{display:none!important}.heading{display:flex;align-items:center;justify-content:space-between;margin-bottom:12px}.heading strong{font-size:16px}
    #close{border:0;color:#ddd;background:transparent;font-size:21px;padding:0 5px}
    label{display:block;margin:10px 0 4px}input,select{display:block;width:100%;border:1px solid #676774;border-radius:4px;padding:7px 9px;color:#efeff1;background:#0e0e10}
    .row{display:grid;grid-template-columns:1fr 1fr;gap:12px}.muted{color:#adadb8;font-size:12px;margin:8px 0}
    #preview{white-space:normal;overflow-wrap:anywhere;background:#0e0e10;border-radius:5px;padding:9px;max-height:90px;overflow:auto;font-size:12px}
    #status{margin:10px 0;color:#dedee3;overflow-wrap:anywhere}.buttons{display:flex;gap:8px}
    .buttons button{flex:1;border:0;padding:8px;border-radius:4px;font-weight:600;color:white;background:#9146ff}#stop{background:#46464e}#test{background:#49345e}
    details{margin-top:10px;font-size:12px;color:#adadb8}a{color:#bf94ff}
  </style>
  <button id="toggle" aria-label="Emote burst" aria-expanded="false" title="Emote burst — timed chat messages">
    <svg viewBox="0 0 24 24" width="22" height="22" fill="none" stroke="currentColor" stroke-width="2" aria-hidden="true"><path d="M4 8h13l-3-3m6 11H7l3 3M20 8v3M4 16v-3"/><path d="m10 10 5 3-5 3z" fill="currentColor" stroke="none"/></svg>
  </button>
  <section id="menu" aria-label="Emote burst settings" hidden>
    <div class="heading"><div><div class="eyebrow">TWITCH CHAT</div><strong>Emote dashboard</strong></div><button id="close" aria-label="Close dashboard">×</button></div>
    <div class="tabs" role="tablist"><button id="tab-emotes" role="tab" aria-selected="true">Emotes</button><button id="tab-rewards" role="tab" aria-selected="false">Point rewards</button></div>
    <div id="emote-panel" role="tabpanel">
    <div class="stats"><div><span>STATUS</span><b id="dashboard-state">Idle</b></div><div><span>NEXT BLOCK</span><b id="dashboard-next">—</b></div><div><span>SUBMITTED</span><b id="dashboard-sent">0</b></div></div>
    <label for="emote">Emote</label><input id="emote" list="emotes" maxlength="200" autocomplete="off" spellcheck="false"><datalist id="emotes"></datalist>
    <label for="mode">Mode</label><select id="mode"><option value="burst">Burst · stop after a message count</option><option value="repeat">Repeat · one block until cancelled</option></select>
    <label for="preset">Preset</label><select id="preset"><option value="4,4">Default · 4 seconds × 4 messages</option><option value="2,7">Quick · 2 seconds × 7 messages</option><option value="6,4">Relaxed · 6 seconds × 4 messages</option><option value="10,3">Slow · 10 seconds × 3 messages</option><option value="repeat:60">Repeat · every minute</option><option value="repeat:180">Repeat · every 3 minutes</option><option value="repeat:300">Repeat · every 5 minutes</option><option value="custom">Custom</option></select>
    <label for="block">Emotes per message</label><input id="block" type="number" min="1" step="1">
    <div class="row"><div><label for="times">Messages</label><input id="times" type="number" min="1" max="100" step="1"></div><div><label for="delay">Interval (seconds)</label><input id="delay" type="number" min="2" max="3600" step="0.5"></div></div>
    <p class="muted" id="length"></p><div id="preview"></div>
    <p class="muted" id="schedule-note"></p>
    <p id="status" role="status" aria-live="polite">Ready.</p>
    <div class="buttons"><button id="test" title="Send exactly one copy of the selected emote">Test 1 emote</button><button id="start">Start burst</button><button id="stop" disabled>Stop</button></div>
    <details><summary>Limits & delivery</summary><p>500 characters per message. Minimum interval: 2 seconds. Local budget: 18 attempts per 30 seconds across tabs running this script, including observed manual sends. Other extensions, devices, or messages sent before installation cannot be counted.</p><p>Twitch documents 20 messages per 30 seconds and one per second per channel for ordinary accounts. Exceeding these limits can mean messages are ignored for 1 hour. Slow mode, unique-chat mode and moderation can impose more restrictions. Alternating blocks does not guarantee acceptance.</p><p>Stops on detected rejection or a changed channel. Counts submissions, not server-confirmed delivery. Emote suggestions come from visible chat; an emote may require a subscription. Clear your chat draft before starting.</p><a href="https://dev.twitch.tv/docs/chat#twitch-chat-rate-limits" target="_blank" rel="noopener noreferrer">Twitch rate limits</a></details>
    </div>
    <div id="reward-panel" role="tabpanel" hidden>
      <p class="muted">Redeem a custom Channel Points reward when its cooldown ends. Stops after your chosen number of confirmed redemptions.</p>
      <button id="reward-load" class="secondary">Load this channel's rewards</button>
      <label for="reward-pick">Reward</label><select id="reward-pick" disabled><option value="">Load rewards first</option></select>
      <label for="reward-times">Times to redeem</label><input id="reward-times" type="number" min="1" max="100" step="1" value="4">
      <label for="reward-text">Reward message (if required)</label><input id="reward-text" maxlength="500" placeholder="Text to submit with every redemption">
      <p class="muted" id="reward-cost">Uses your Channel Points, not Bits.</p>
      <div class="stats"><div><span>NEXT CHECK</span><b id="reward-next">—</b></div><div><span>REDEEMED</span><b id="reward-done">0 / 0</b></div><div><span>POINTS</span><b id="reward-balance">—</b></div></div>
      <p id="reward-status" role="status" aria-live="polite">Load rewards while logged in to Twitch.</p>
      <div class="buttons"><button id="reward-start" disabled>Start redeeming</button><button id="reward-cancel" disabled>Cancel</button></div>
      <p class="muted">You can close this dashboard; redemption keeps running. A small progress/Cancel bar stays above Send. Keep the Twitch tab open. Cooldowns are rechecked before spending points. A failed or uncertain submission stops the job; it is never blindly retried. Channel changes cancel it. A request already submitted may still complete after Cancel.</p>
    </div>
  </section>`;
  // Keep the dashboard OUTSIDE Twitch's chat toolbar. Toolbar ancestors may
  // have transform/overflow/contain styles that clip a fixed-position child.
  // The browser's popover top layer also escapes page stacking contexts.
  const dashboardHost = document.createElement('div');
  dashboardHost.id = 'tm-emote-dashboard';
  dashboardHost.style.cssText = 'display:none;position:fixed;inset:72px 16px auto auto;margin:0;padding:0;border:0;background:transparent;width:360px;max-width:calc(100vw - 32px);z-index:2147483647;color-scheme:dark';
  if (typeof dashboardHost.showPopover === 'function') dashboardHost.setAttribute('popover', 'manual');
  const dashboard = dashboardHost.attachShadow({ mode: 'open' });
  dashboard.append(shadow.querySelector('style').cloneNode(true), shadow.getElementById('menu'));
  const dashboardStyle = document.createElement('style');
  dashboardStyle.textContent = `
    #menu{position:static;width:100%;max-width:none;max-height:calc(100dvh - 104px);padding:18px;border-radius:14px;background:linear-gradient(155deg,#24202f,#18181b 45%);box-shadow:0 14px 45px #0009}
    .heading{margin-bottom:16px}.heading strong{font-size:19px;letter-spacing:-.4px}.eyebrow{color:#bf94ff;font-size:10px;font-weight:700;letter-spacing:1.8px;margin-bottom:3px}
    .stats{display:grid;grid-template-columns:1fr 1fr 1fr;gap:8px;margin:0 0 16px}
    .stats div{padding:10px 8px;border:1px solid #ffffff15;border-radius:8px;background:#ffffff06;min-width:0}
    .stats span{display:block;font-size:9px;letter-spacing:.8px;color:#adadb8}.stats b{display:block;margin-top:4px;font-size:16px;font-variant-numeric:tabular-nums}
    #dashboard-state{color:#c5a3ff}label{color:#d2cddd;font-size:12px}input,select{border-color:#4d465d;padding:8px 9px}
    .tabs{display:flex;gap:6px;margin-bottom:14px}.tabs button,.secondary{font:inherit;color:#eee;background:#302a3b;border:1px solid #51455f;border-radius:5px;padding:7px 10px;cursor:pointer}.tabs button{flex:1}.tabs button[aria-selected=true]{background:#6933a3;border-color:#a970ff}#reward-status{overflow-wrap:anywhere}#reward-cancel{background:#46464e}
    input:focus,select:focus{outline:2px solid #a970ff;outline-offset:1px}.buttons{position:sticky;bottom:-18px;padding:10px 0;background:#18181b}.buttons button{padding:10px}#preview{max-height:62px}
  `;
  dashboard.append(dashboardStyle);
  document.body.append(dashboardHost);
  const ui = id => shadow.getElementById(id) || dashboard.getElementById(id);
  const status = message => { ui('status').textContent = message; };
  for (const name of ['emotes', 'rewards']) ui(`tab-${name}`).onclick = () => {
    ui('emote-panel').hidden = name !== 'emotes';
    ui('reward-panel').hidden = name !== 'rewards';
    ui('tab-emotes').setAttribute('aria-selected', String(name === 'emotes'));
    ui('tab-rewards').setAttribute('aria-selected', String(name === 'rewards'));
  };
  // Separate from the settings popover so it stays visible when that is closed.
  // Anchor to the Send button without moving Twitch's React-managed controls.
  const timerHost = document.createElement('div');
  timerHost.id = 'tm-emote-countdown';
  timerHost.style.cssText = 'display:none;position:fixed;z-index:2147483646';
  const timer = timerHost.attachShadow({ mode: 'open' });
  timer.innerHTML = `<style>
    :host{font:12px/1.4 Inter,system-ui,sans-serif;color:#efeff1}
    .bar{display:flex;align-items:center;gap:9px;padding:5px 7px;background:#18181b;border:1px solid #9146ff;border-radius:5px;box-shadow:0 2px 8px #0006;white-space:nowrap}
    .stack{display:flex;flex-direction:column;align-items:flex-end;gap:4px}[hidden]{display:none!important}
    button{font:inherit;cursor:pointer;background:#3b254f;color:#efeff1;border:0;border-radius:3px;padding:2px 6px}button:hover{background:#663399}
    #next{font-variant-numeric:tabular-nums}
  </style><div class="stack"><div class="bar" id="emote-row" hidden><span id="next" role="timer">Next block 01:00</span><button id="cancel">Cancel</button></div><div class="bar" id="reward-row" hidden><span id="reward-progress" role="timer"></span><button id="reward-mini-cancel">Cancel reward</button></div></div>`;
  document.body.append(timerHost);
  timer.getElementById('cancel').onclick = () => stop('Cancelled.');
  timer.getElementById('reward-mini-cancel').onclick = cancelRewards;
  function updateTimer() {
    ui('reward-next').textContent = rewardRun?.nextAt ? countdown(rewardRun.nextAt - performance.now()) : '—';
    ui('dashboard-state').textContent = run ? run.cancelled ? 'Stopping' : run.test ? 'Test' : run.config.mode === 'repeat' ? 'Repeating' : 'Burst' : 'Idle';
    ui('dashboard-next').textContent = run ? countdown((run.displayUntil ?? run.nextAt) - performance.now()) : '—';
    ui('dashboard-sent').textContent = String(run?.sent ?? lastSubmitted);
    const showEmotes = !!run && !run.test;
    timer.getElementById('emote-row').hidden = !showEmotes;
    timer.getElementById('reward-row').hidden = !rewardRun;
    if (rewardRun) {
      timer.getElementById('reward-progress').textContent = rewardRun.cancelled ? 'Rewards stopping…'
        : `Rewards ${rewardRun.done}/${rewardRun.target} · ${rewardRun.nextAt ? `check ${countdown(rewardRun.nextAt - performance.now())}` : 'working…'}`;
      timer.getElementById('reward-progress').title = rewardRun.selected.title;
    }
    const { button } = parts();
    if ((!showEmotes && !rewardRun) || !button?.isConnected) { timerHost.style.display = 'none'; return; }
    if (showEmotes) {
      const complete = run.config.mode === 'burst' && run.sent >= run.config.times;
      timer.getElementById('next').textContent = run.cancelled ? 'Cancelling…'
        : complete ? 'Finishing…' : `Next block ${countdown((run.displayUntil ?? run.nextAt) - performance.now())}`;
    }
    timerHost.style.display = 'block';
    const box = button.getBoundingClientRect();
    if (box.width === 0 || box.height === 0) { timerHost.style.display = 'none'; return; }
    timerHost.style.left = `${Math.max(8, Math.min(innerWidth - timerHost.offsetWidth - 8, box.right - timerHost.offsetWidth))}px`;
    timerHost.style.top = `${Math.max(8, box.top - timerHost.offsetHeight - 6)}px`;
  }
  let saved;
  try { saved = settings(load('settings', DEFAULTS)); } catch { saved = DEFAULTS; }
  for (const key of ['emote', 'block', 'times', 'delay', 'mode']) ui(key).value = saved[key];

  function config() {
    return settings(Object.fromEntries(['emote', 'block', 'times', 'delay', 'mode'].map(key => [key, ui(key).value])));
  }
  function preview() {
    try {
      const c = config();
      const text = makeMessage(c, 0);
      ui('preview').textContent = text;
      ui('length').textContent = `${c.block} ↔ ${c.block + 1} emotes · ${text.length} / ${makeMessage(c, 1).length} characters (max 500)`;
      ui('schedule-note').textContent = c.mode === 'repeat'
        ? 'One block per interval, until cancelled. First block waits one full interval. Keep this tab open; sleeping or suspended tabs may send late. Missed intervals are skipped.'
        : 'Alternates the block size by one (18 → 19 by default). First message starts immediately when the local rate budget allows.';
      ui('times').disabled = !!run || c.mode === 'repeat';
      ui('start').textContent = c.mode === 'repeat' ? 'Start repeating' : 'Start burst';
      if (!run) status('Ready.');
    } catch (error) {
      ui('preview').textContent = '';
      ui('length').textContent = error.message;
    }
  }
  function syncPreset() {
    if (ui('mode').value === 'repeat') {
      const delay = Number(ui('delay').value);
      ui('preset').value = [60, 180, 300].includes(delay) ? `repeat:${delay}` : 'custom';
      return;
    }
    const value = `${Number(ui('delay').value)},${Number(ui('times').value)}`;
    ui('preset').value = ['4,4', '2,7', '6,4', '10,3'].includes(value) ? value : 'custom';
  }
  for (const key of ['emote', 'block', 'times', 'delay']) ui(key).addEventListener('input', () => { syncPreset(); preview(); });
  ui('preset').onchange = () => {
    if (ui('preset').value === 'custom') return;
    if (ui('preset').value.startsWith('repeat:')) {
      ui('mode').value = 'repeat';
      ui('delay').value = ui('preset').value.split(':')[1];
      preview();
      return;
    }
    ui('mode').value = 'burst';
    const [delay, times] = ui('preset').value.split(',');
    ui('delay').value = delay;
    ui('times').value = times;
    preview();
  };
  ui('mode').onchange = () => {
    ui('delay').value = ui('mode').value === 'repeat' ? 60 : DEFAULTS.delay;
    syncPreset();
    preview();
  };
  syncPreset();
  preview();

  function suggestEmotes() {
    const names = new Set(['manguwIly', ui('emote').value, 'Kappa', 'LUL', 'HeyGuys']);
    for (const img of document.querySelectorAll('img.chat-image, img[data-a-target="emote-name"]')) {
      if (img.alt && !/\s/.test(img.alt) && img.alt.length < 100) names.add(img.alt);
      if (names.size >= 250) break;
    }
    ui('emotes').replaceChildren(...[...names].filter(Boolean).map(name => {
      const option = document.createElement('option');
      option.value = name;
      return option;
    }));
  }
  function closeMenu() {
    // Closing the view never cancels either job. Their state belongs to the
    // page-level runners; only Cancel, a channel change, or page unload stops it.
    if (dashboardHost.hasAttribute('popover') && dashboardHost.matches(':popover-open')) dashboardHost.hidePopover();
    ui('menu').hidden = true;
    dashboardHost.style.display = 'none';
    ui('toggle').setAttribute('aria-expanded', 'false');
  }
  function openMenu() {
    ui('menu').hidden = false;
    dashboardHost.style.display = 'block';
    // Fixed positioning on body is a fallback for browsers without popovers.
    try { if (dashboardHost.hasAttribute('popover') && !dashboardHost.matches(':popover-open')) dashboardHost.showPopover(); } catch { dashboardHost.removeAttribute('popover'); }
    ui('toggle').setAttribute('aria-expanded', 'true');
    suggestEmotes();
    updateTimer();
  }
  function toggleMenu(event) {
    event.preventDefault();
    event.stopPropagation();
    if (ui('menu').hidden) openMenu(); else closeMenu();
  }
  ui('toggle').addEventListener('click', toggleMenu);
  ui('close').addEventListener('click', closeMenu);
  document.addEventListener('keydown', event => { if (event.key === 'Escape') closeMenu(); });
  window.addEventListener('resize', updateTimer);
  window.addEventListener('scroll', updateTimer, true);

  function attach() {
    const gear = document.querySelector('[data-a-target="chat-settings"], [data-a-target="chat-settings-button"]');
    if (!gear) return;
    const button = gear.matches('button') ? gear : gear.querySelector('button');
    const anchor = button || gear;
    if (anchor.parentElement && (host.parentElement !== anchor.parentElement || host.nextSibling !== anchor)) anchor.before(host);
  }
  function parts() {
    const input = [...document.querySelectorAll('[data-a-target="chat-input"][contenteditable="true"], [data-a-target="chat-input"] [contenteditable="true"], textarea[data-a-target="chat-input"], textarea[data-test-selector="chat-input"]')].find(visible);
    const scope = input?.closest('.chat-input') || document;
    const button = [...scope.querySelectorAll('[data-a-target="chat-send-button"], [data-test-selector="chat-send-button"]')].find(visible);
    return { input, button };
  }
  function visible(node) { return node.isConnected && node.getClientRects().length > 0 && getComputedStyle(node).visibility !== 'hidden'; }
  function read(input) { return input ? ('value' in input ? input.value : input.textContent).trim() : ''; }
  function available(input) { return input && input.isConnected && !input.disabled && input.getAttribute('aria-disabled') !== 'true' && input.getAttribute('contenteditable') !== 'false'; }
  function write(input, text) {
    input.focus({ preventScroll: true });
    if ('value' in input) {
      const setter = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')?.set;
      if (!setter) throw new Error('Unsupported chat input.');
      setter.call(input, text);
      input.dispatchEvent(new Event('input', { bubbles: true }));
    } else {
      // Let Twitch's Slate/React editor process a normal editing operation.
      const selection = getSelection();
      const range = document.createRange();
      range.selectNodeContents(input);
      selection.removeAllRanges();
      selection.addRange(range);
      const inserted = document.execCommand('insertText', false, text);
      if (!inserted && read(input) !== text) throw new Error('Twitch did not accept text insertion. Nothing was sent.');
    }
  }
  function check(task) {
    if (task.cancelled) throw new Error(task.reason || 'Stopped.');
    if (channelKey(location.href) !== task.channel) throw new Error('Stopped: channel changed.');
    if (!dashboardHost.isConnected) throw new Error('Stopped: chat controls disappeared.');
  }
  async function wait(ms, task, label) {
    const until = performance.now() + ms;
    task.displayUntil = until;
    while (performance.now() < until) {
      check(task);
      const progress = task.config.mode === 'repeat' ? `${task.sent} submitted` : `${task.sent}/${task.config.times} submitted`;
      status(`${label} · ${Math.ceil((until - performance.now()) / 1000)}s · ${progress}`);
      updateTimer();
      await sleep(Math.min(200, Math.max(0, until - performance.now())));
    }
    task.displayUntil = null;
    check(task);
  }
  function stop(reason = 'Stopped.') {
    if (!run) return;
    run.cancelled = true;
    run.reason = reason;
    updateTimer();
  }
  ui('stop').onclick = () => stop();

  async function ready(task, probe, message, timeout = 4000) {
    const deadline = performance.now() + timeout;
    while (true) {
      check(task);
      const value = probe();
      if (value) return value;
      if (performance.now() >= deadline) throw new Error(message);
      status(task.sent ? 'Waiting for Twitch to finish submitting…' : 'Preparing chat — waiting for the editor…');
      await sleep(50);
    }
  }

  async function send(task, text) {
    check(task);
    let input = await ready(task, () => {
      const candidate = parts().input;
      return available(candidate) && candidate;
    }, 'Chat is unavailable or restricted. Nothing was sent.');
    if (read(input)) throw new Error('Stopped: your chat draft is not empty.');
    // Focusing can mount or replace Twitch's editor on the first interaction.
    // Let that settle before selecting text, then reacquire the live composer.
    input.focus({ preventScroll: true });
    await sleep(100);
    input = await ready(task, () => {
      const candidate = parts().input;
      return available(candidate) && candidate;
    }, 'Twitch is still loading chat. Nothing was sent.');
    if (read(input)) throw new Error('Stopped: your chat draft is not empty.');
    task.draft = { input, text, submitted: false };
    write(input, text);
    const prepared = () => {
      const current = parts();
      return available(current.input) && read(current.input) === text && current.button
        && !current.button.disabled && current.button.getAttribute('aria-disabled') !== 'true' && current;
    };
    // React/Slate may enable Send later than the actual text insertion.
    // Wait for that state rather than requiring a second user click.
    await ready(task, prepared, 'Twitch did not enable Send for this draft. Nothing was sent; check chat restrictions.');
    let budget;
    while ((budget = waitForBudget(ledger(), Date.now())) > 0) {
      await wait(budget, task, 'Waiting for local rate budget');
    }
    if (task.nextAt != null) {
      const remaining = task.nextAt - performance.now();
      if (remaining > 0) await wait(remaining, task, 'Next message');
    }
    check(task);
    const current = await ready(task, prepared, 'Stopped: chat changed while waiting. Nothing was sent.');
    input = current.input;
    const button = current.button;
    task.draft.input = input;
    // Reserve before clicking, and count attempts even when delivery is unknown.
    recordAttempt();
    store(`last:${task.channel}`, text);
    task.lastAttemptAt = performance.now();
    task.nextAt = task.lastAttemptAt + task.config.delay * 1000;
    // Once click is attempted, do not reinsert, retry, or erase this draft.
    task.draft.submitted = true;
    ownSubmission = true;
    try { button.click(); } finally { ownSubmission = false; }
    task.sent++;
    lastSubmitted = task.sent;
    updateTimer();
    await ready(task, () => {
      const currentInput = parts().input;
      return available(currentInput) && !read(currentInput);
    }, 'Twitch did not clear the chat input. Submission is uncertain; it will not be retried.', 3000);
    task.draft = null;
    status(task.config.mode === 'repeat' ? `${task.sent} blocks submitted.` : `${task.sent}/${task.config.times} submitted.`);
  }

  async function startRun(test = false) {
    if (run) return;
    let c;
    try {
      c = test ? settings({ ...DEFAULTS, emote: ui('emote').value, block: 1, times: 1, delay: 2, mode: 'burst' }) : config();
      if (!test) store('settings', c);
    } catch (error) { status(error.message); return; }
    const channel = channelKey(location.href);
    if (!channel) { status('Open a live channel chat or its popout first.'); return; }
    if (!navigator.locks) { status('This browser does not support the cross-tab lock needed to run a burst.'); return; }
    const task = { config: c, test, channel, sent: 0, cancelled: false, reason: '', draft: null,
      nextAt: performance.now() + (c.mode === 'repeat' ? c.delay * 1000 : 0), displayUntil: null };
    run = task;
    lastSubmitted = 0;
    for (const key of ['start', 'test', 'emote', 'preset', 'block', 'times', 'delay', 'mode']) ui(key).disabled = true;
    ui('stop').disabled = false;
    ui('test').textContent = test ? 'Testing…' : 'Test 1 emote';
    status(test ? 'Preparing one test emote…' : 'Preparing chat…');
    ui('toggle').classList.add('running');
    updateTimer();
    try {
      await navigator.locks.request(PREFIX + 'run', { ifAvailable: true }, async lock => {
        if (!lock) throw new Error('Another tab is already running an emote burst.');
        for (let i = 0; c.mode === 'repeat' || i < c.times; i++) {
          if (i || c.mode === 'repeat') await wait(Math.max(0, task.nextAt - performance.now() - 150), task, 'Next message');
          // No catch-up loop: every interval starts after the previous send.
          let budget;
          while ((budget = waitForBudget(ledger(), Date.now())) > 0) await wait(budget, task, 'Waiting for local rate budget');
          check(task);
          const text = test ? c.emote : makeMessage(c, i, load(`last:${channel}`, ''));
          await send(task, text);
        }
        check(task);
        status(test ? 'Test submitted — check chat to confirm the emote appears.' : `Done — ${task.sent} messages submitted. Twitch may still apply moderation filters.`);
      });
    } catch (error) {
      status(`${error.message} (${task.sent}${c.mode === 'burst' ? `/${c.times}` : ''} submitted)`);
    } finally {
      // Remove only our untouched, unsent draft. Never remove user-edited text.
      if (task.draft && !task.draft.submitted && read(task.draft.input) === task.draft.text && task.draft.input.isConnected) {
        try { write(task.draft.input, ''); } catch { /* Leave the draft for the user. */ }
      }
      run = null;
      for (const key of ['start', 'test', 'emote', 'preset', 'block', 'times', 'delay', 'mode']) ui(key).disabled = false;
      ui('times').disabled = ui('mode').value === 'repeat';
      ui('stop').disabled = true;
      ui('test').textContent = 'Test 1 emote';
      ui('toggle').classList.remove('running');
      updateTimer();
    }
  }
  ui('start').onclick = () => startRun(false);
  ui('test').onclick = () => startRun(true);

  // Custom Channel Points rewards. These private web API shapes may change;
  // fail on schema/auth errors instead of falling back to guessing UI clicks.
  const REWARD_QUERY = `query EmoteDashboardRewards($login: String!) {
    currentUser { id }
    user(login: $login) {
      id
      channel { self { communityPoints { balance } } communityPointsSettings { customRewards {
        id title prompt cost isEnabled isPaused isInStock isUserInputRequired cooldownExpiresAt
      } } }
    }
  }`;
  const REDEEM_MUTATION = `mutation EmoteDashboardRedeem($input: RedeemCommunityPointsCustomRewardInput!) {
    redeemCommunityPointsCustomReward(input: $input) { error { code } redemption { id } }
  }`;
  const rewardStatus = text => { ui('reward-status').textContent = text; };
  function loginToken() {
    const raw = document.cookie.split(';').map(s => s.trim()).find(s => s.startsWith('auth-token='));
    if (!raw) throw new Error('Log in to Twitch before loading rewards.');
    return decodeURIComponent(raw.slice('auth-token='.length));
  }
  function checkReward(task) {
    if (task.cancelled) throw new Error('Cancelled.');
    if (channelKey(location.href) !== task.channel) throw new Error('Stopped: channel changed. Load rewards again.');
    if (loginToken() !== task.token) throw new Error('Stopped: Twitch login changed. Load rewards again.');
  }
  async function rewardAPI(query, variables, task, mutation = false) {
    checkReward(task);
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 20000);
    try {
      const reply = await fetch('https://gql.twitch.tv/gql', {
        method: 'POST', credentials: 'omit', signal: controller.signal,
        headers: { 'Client-ID': 'kimne78kx3ncx6brgo4mv6wki5h1ko', 'Content-Type': 'text/plain;charset=UTF-8', Authorization: `OAuth ${task.token}` },
        body: JSON.stringify({ query, variables })
      });
      if (!reply.ok) throw new Error(`Twitch returned HTTP ${reply.status}.`);
      const json = await reply.json();
      if (json.errors?.length) throw new Error(json.errors.map(e => e.message).join('; '));
      if (!json.data) throw new Error('Twitch returned no reward data.');
      const serverDate = Date.parse(reply.headers.get('Date'));
      return { data: json.data, now: Number.isFinite(serverDate) ? serverDate : Date.now() };
    } catch (error) {
      throw new Error(mutation
        ? `Redemption result is uncertain; stopped without retrying. ${error.message}`
        : `Could not read rewards. ${error.message}`);
    } finally { clearTimeout(timeout); }
  }
  async function readRewards(task) {
    const response = await rewardAPI(REWARD_QUERY, { login: task.channel }, task);
    checkReward(task);
    const channel = response.data.user;
    const rewards = channel?.channel?.communityPointsSettings?.customRewards;
    const balance = channel?.channel?.self?.communityPoints?.balance;
    if (!response.data.currentUser?.id || !channel?.id || !Array.isArray(rewards) || !Number.isSafeInteger(balance) || balance < 0) {
      throw new Error('Twitch did not return a valid reward list and point balance. Its web API may have changed.');
    }
    return { channel: task.channel, channelID: channel.id, userID: response.data.currentUser.id, rewards, balance, now: response.now };
  }
  function rewardControls(busy) {
    for (const id of ['reward-load', 'reward-pick', 'reward-times', 'reward-text', 'reward-start']) ui(id).disabled = busy;
    if (!busy) ui('reward-pick').disabled = ui('reward-start').disabled = !rewardSnapshot;
    ui('reward-cancel').disabled = !busy || !rewardRun;
  }
  function showRewardCost() {
    const reward = rewardSnapshot?.rewards.find(r => r.id === ui('reward-pick').value);
    const count = Number(ui('reward-times').value);
    ui('reward-cost').textContent = reward
      ? `${reward.title} · ${reward.cost.toLocaleString()} points each · up to ${(reward.cost * (Number.isInteger(count) && count > 0 ? count : 0)).toLocaleString()} points total. ${reward.isUserInputRequired ? 'A reward message is required.' : ''}`
      : 'Choose a reward. Only Channel Points are used.';
  }
  ui('reward-pick').onchange = showRewardCost;
  ui('reward-times').oninput = showRewardCost;
  ui('reward-load').onclick = async () => {
    if (rewardRun) return;
    rewardControls(true);
    rewardStatus('Loading this channel’s custom rewards…');
    try {
      const channel = channelKey(location.href);
      if (!channel) throw new Error('Open a live channel first.');
      const task = { channel, token: loginToken(), cancelled: false };
      const snapshot = await readRewards(task);
      rewardSnapshot = snapshot;
      ui('reward-pick').replaceChildren();
      const placeholder = document.createElement('option');
      placeholder.value = '';
      placeholder.textContent = 'Choose a reward';
      ui('reward-pick').append(placeholder);
      for (const reward of snapshot.rewards) {
        if (!Number.isSafeInteger(reward.cost) || reward.cost < 0 || !reward.id || !reward.title) continue;
        const option = document.createElement('option');
        option.value = reward.id;
        option.textContent = `${reward.title} · ${reward.cost.toLocaleString()} points${!reward.isEnabled || reward.isPaused ? ' (unavailable)' : ''}`;
        ui('reward-pick').append(option);
      }
      ui('reward-balance').textContent = snapshot.balance.toLocaleString();
      rewardStatus(`${snapshot.rewards.length} rewards loaded for ${channel}. Choose one and set a redemption count.`);
      showRewardCost();
    } catch (error) {
      rewardSnapshot = null;
      rewardStatus(error.message);
    } finally { rewardControls(false); }
  };
  async function rewardWait(task, ms, label) {
    task.nextAt = performance.now() + ms;
    while (performance.now() < task.nextAt) {
      checkReward(task);
      rewardStatus(`${label} · ${countdown(task.nextAt - performance.now())} · ${task.done}/${task.target} confirmed`);
      await sleep(Math.min(250, Math.max(0, task.nextAt - performance.now())));
    }
    task.nextAt = null;
    checkReward(task);
  }
  function cancelRewards() {
    if (!rewardRun) return;
    rewardRun.cancelled = true;
    rewardStatus('Cancelling… A redemption already submitted may still complete.');
  }
  ui('reward-cancel').onclick = cancelRewards;
  ui('reward-start').onclick = async () => {
    if (rewardRun) return;
    let task;
    try {
      const selected = rewardSnapshot?.rewards.find(r => r.id === ui('reward-pick').value);
      const target = Number(ui('reward-times').value);
      if (!selected) throw new Error('Load rewards and choose one first.');
      if (!Number.isInteger(target) || target < 1 || target > 100) throw new Error('Choose 1–100 redemptions.');
      if (rewardSnapshot.channel !== channelKey(location.href)) throw new Error('Channel changed. Load rewards again.');
      if (selected.isUserInputRequired && !ui('reward-text').value.trim()) throw new Error('This reward requires a message.');
      if (!navigator.locks) throw new Error('This browser does not support the reward job’s cross-tab lock.');
      task = { channel: rewardSnapshot.channel, token: loginToken(), userID: rewardSnapshot.userID,
        channelID: rewardSnapshot.channelID, selected: { ...selected }, text: ui('reward-text').value,
        target, done: 0, cancelled: false, nextAt: null, seen: new Set() };
      rewardRun = task;
      rewardControls(true);
      ui('reward-done').textContent = `0 / ${target}`;
      updateTimer();
      await navigator.locks.request(PREFIX + 'reward-run', { ifAvailable: true }, async lock => {
        if (!lock) throw new Error('Another tab is already redeeming rewards.');
        while (task.done < task.target) {
          checkReward(task);
          const snapshot = await readRewards(task);
          if (snapshot.userID !== task.userID || snapshot.channelID !== task.channelID) throw new Error('Account or channel changed; stopped.');
          const reward = snapshot.rewards.find(r => r.id === task.selected.id);
          if (!reward || !reward.isEnabled || reward.isPaused) throw new Error('Reward was removed, disabled, or paused; stopped.');
          if (reward.cost !== task.selected.cost || reward.title !== task.selected.title || reward.prompt !== task.selected.prompt) throw new Error('Reward details or price changed. Load it again before spending more points.');
          if (reward.isUserInputRequired && !task.text.trim()) throw new Error('Reward now requires a message; stopped.');
          ui('reward-balance').textContent = snapshot.balance.toLocaleString();
          if (snapshot.balance < reward.cost) throw new Error('Not enough Channel Points; stopped.');
          const cooldown = cooldownDelay(reward.cooldownExpiresAt, snapshot.now);
          if (cooldown > 0) {
            await rewardWait(task, Math.min(cooldown, 10000), 'Waiting for cooldown; rechecking in');
            continue;
          }
          if (!reward.isInStock) throw new Error('Reward is out of stock or its stream limit was reached; stopped.');
          checkReward(task);
          rewardStatus(`Redeeming ${reward.title}… ${task.done}/${task.target} confirmed`);
          const response = await rewardAPI(REDEEM_MUTATION, { input: {
            channelID: task.channelID, rewardID: reward.id, cost: reward.cost, title: reward.title,
            prompt: reward.prompt ?? null, textInput: task.text || null,
            transactionID: crypto.randomUUID().replace(/-/g, '')
          } }, task, true);
          const payload = response.data.redeemCommunityPointsCustomReward;
          if (payload?.error) {
            // This is an explicit server rejection, not an uncertain request.
            // Someone else may have redeemed between our query and submission.
            if (payload.error.code === 'GLOBAL_COOLDOWN') { await rewardWait(task, 5000, 'Cooldown changed; rechecking in'); continue; }
            throw new Error(`Twitch rejected the redemption: ${payload.error.code}. Stopped.`);
          }
          const id = payload?.redemption?.id;
          if (!id || task.seen.has(id)) throw new Error('No unique redemption confirmation returned. Stopped without retrying.');
          task.seen.add(id);
          task.done++;
          ui('reward-done').textContent = `${task.done} / ${task.target}`;
          ui('reward-balance').textContent = (snapshot.balance - reward.cost).toLocaleString();
          if (task.done < task.target) await rewardWait(task, 5000, 'Checking the next cooldown in');
        }
        rewardStatus(`Done — ${task.done}/${task.target} redemptions confirmed.`);
      });
    } catch (error) { rewardStatus(`${error.message}${task ? ` (${task.done}/${task.target} confirmed)` : ''}`); }
    finally {
      if (rewardRun === task) rewardRun = null;
      rewardControls(false);
      ui('reward-next').textContent = '—';
      updateTimer();
    }
  };

  // Count manual attempts in tabs running this script. Manual typing takes
  // priority over the burst; we never overwrite a draft to continue sending.
  document.addEventListener('keydown', event => {
    const { input } = parts();
    if (!input || !event.composedPath().includes(input) || !event.isTrusted) return;
    if (run) stop('Stopped: you started using chat.');
    if (event.key === 'Enter' && !event.shiftKey && !event.isComposing && read(input)) {
      try { recordAttempt(); store(`last:${channelKey(location.href)}`, read(input)); } catch { stop('Stopped: local rate storage is unavailable.'); }
    }
  }, true);
  document.addEventListener('click', event => {
    if (ownSubmission) return;
    const button = event.target.closest?.('[data-a-target="chat-send-button"], [data-test-selector="chat-send-button"]');
    const { input } = parts();
    if (!button || !read(input)) return;
    if (run) stop('Stopped: you used chat manually.');
    try { recordAttempt(); store(`last:${channelKey(location.href)}`, read(input)); } catch { stop('Stopped: local rate storage is unavailable.'); }
  }, true);
  document.addEventListener('beforeinput', event => {
    if (run && event.isTrusted && event.inputType !== 'insertText' && event.composedPath().includes(parts().input)) stop('Stopped: chat input changed.');
  }, true);

  const rejection = /not sent|sending (?:messages )?too (?:quickly|fast)|identical to|duplicate|slow.mode|timed? ?out|banned|followers.only|subscribers.only|unique.chat|automod|held for|must wait|wait \d+|unable to send|message.{0,20}(?:blocked|rejected)/i;
  const noticeSelector = '.chat-line__status, .chat-input__notice, .chat-input__error, [data-a-target="chat-notice"], [data-test-selector="chat-notice"], [role="alert"]';
  const observer = new MutationObserver(records => {
    if (!run) return;
    for (const record of records) {
      const candidates = [];
      if (record.target.nodeType === 1 && record.target.matches?.(noticeSelector)) candidates.push(record.target);
      if (record.target.parentElement?.closest(noticeSelector)) candidates.push(record.target.parentElement.closest(noticeSelector));
      for (const node of record.addedNodes) {
        if (node.nodeType !== 1 || node === host) continue;
        if (node.matches(noticeSelector)) candidates.push(node);
        candidates.push(...node.querySelectorAll(noticeSelector));
      }
      if (candidates.some(node => rejection.test(node.textContent))) {
        stop('Stopped: Twitch displayed a chat restriction or rejection. Check the chat notice before starting again.');
        break;
      }
    }
  });
  observer.observe(document.body, { childList: true, characterData: true, subtree: true });
  setInterval(updateTimer, 200);
  setInterval(() => {
    const channel = channelKey(location.href);
    if (channel !== currentChannel) {
      stop('Stopped: channel changed.'); cancelRewards(); rewardSnapshot = null;
      ui('reward-pick').disabled = ui('reward-start').disabled = true;
      currentChannel = channel; closeMenu();
    }
    attach();
  }, 750);
  window.addEventListener('pagehide', () => { stop('Stopped: page closed.'); cancelRewards(); });
  attach();
})();
