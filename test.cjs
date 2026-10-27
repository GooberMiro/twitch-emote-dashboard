const assert = require('node:assert/strict');
const h = require('./twitch-emote-burst.user.js');

const c = h.settings(h.DEFAULTS);
assert.equal(c.emote, 'manguwIly');
assert.equal(c.times, 4);
assert.equal(c.delay, 4);
assert.equal(h.settings({ ...c, mode: undefined }).mode, 'burst', 'existing saved settings migrate');
assert.equal(h.settings({ ...c, mode: 'repeat', delay: 60 }).mode, 'repeat');
assert.throws(() => h.settings({ ...c, mode: 'unknown' }), /Burst or Repeat/);
assert.equal(h.countdown(60000), '01:00');
assert.equal(h.countdown(59001), '01:00');
assert.equal(h.countdown(59999), '01:00');
assert.equal(h.countdown(59000), '00:59');
assert.equal(h.countdown(-5), '00:00');
assert.equal(h.cooldownDelay(null, 1000), 0);
assert.equal(h.cooldownDelay(new Date(2000).toISOString(), 1000), 2000);
assert.equal(h.cooldownDelay(new Date(1000).toISOString(), 2000), 0);
assert.throws(() => h.cooldownDelay('invalid'), /invalid reward cooldown/);
assert.equal(h.makeMessage(c, 0).split(' ').length, 18);
assert.equal(h.makeMessage(c, 1).split(' ').length, 19);
assert.equal(h.makeMessage(c, 2), h.makeMessage(c, 0));
assert.notEqual(h.makeMessage(c, 0, h.makeMessage(c, 0)), h.makeMessage(c, 0));
assert.ok(h.makeMessage(c, 0).length <= 500);
assert.ok(h.makeMessage(c, 1).length <= 500);
assert.throws(() => h.settings({ ...c, emote: '/ban' }), /one emote/);
assert.throws(() => h.settings({ ...c, emote: 'two emotes' }), /one emote/);
assert.throws(() => h.settings({ ...c, delay: 1 }), /interval/);
assert.throws(() => h.settings({ ...c, times: 0 }), /1–100/);
assert.throws(() => h.settings({ ...c, times: 101 }), /1–100/);
assert.throws(() => h.settings({ ...c, block: 1.5 }), /whole number/);
assert.throws(() => h.settings({ ...c, block: 50 }), /at most 49/);
assert.equal(h.makeMessage(h.settings({ ...c, block: 49 }), 1).length, 499);
assert.throws(() => h.settings({ ...c, emote: '😀'.repeat(200) }), /at most 0/);

const now = 100000;
assert.equal(h.waitForBudget([], now), 0);
assert.equal(h.waitForBudget([now - 1000], now), 1000);
assert.equal(h.waitForBudget([now - 2000], now), 0);
assert.equal(h.waitForBudget(Array(18).fill(now - 5000), now), 25100);
assert.equal(h.waitForBudget(Array(25).fill(now - 30001), now), 0);
assert.equal(h.waitForBudget([NaN, 'bad', now - 30001], now), 0);
assert.ok(h.waitForBudget([now + 1000], now) > 0, 'clock rollback must not create an immediate burst');

// Simulate fast preset + manual sends filling the rolling window. The
// schedule may stretch but must never exceed our conservative send budget.
let time = now;
let attempts = Array.from({ length: 17 }, (_, i) => now - 17000 + i * 500);
let lastSent = null;
for (let i = 0; i < 100; i++) {
  time += h.waitForBudget(attempts, time);
  assert.equal(h.waitForBudget(attempts, time), 0);
  if (lastSent !== null) assert.ok(time - lastSent >= 2000);
  attempts.push(time);
  assert.ok(h.recent(attempts, time).length <= 18);
  lastSent = time;
  time += 2000;
}
assert.equal(h.channelKey('https://www.twitch.tv/mang0'), 'mang0');
assert.equal(h.channelKey('https://www.twitch.tv/popout/Mang0/chat?popout='), 'mang0');
assert.equal(h.channelKey('https://www.twitch.tv/moderator/mang0'), 'mang0');
assert.equal(h.channelKey('https://www.twitch.tv/videos/123'), null);
assert.equal(h.channelKey('https://www.twitch.tv/directory'), null);
console.log('Passed: default/preset settings, alternating blocks, 500-character boundaries, rate-budget simulation, and channel routing.');
