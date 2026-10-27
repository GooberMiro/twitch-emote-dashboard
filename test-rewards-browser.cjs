// Uses simulated Twitch responses only. Never logs in or spends real points.
const { chromium } = require(process.argv[2] || 'playwright');
const assert = require('node:assert/strict');
const path = require('node:path');
const fixture = '<!doctype html><body style="background:#111;color:white"><div class="chat-input" style="position:fixed;bottom:20px;right:20px"><textarea data-a-target="chat-input"></textarea><button data-a-target="chat-settings">Gear</button><button data-a-target="chat-send-button">Chat</button></div></body>';
(async () => {
  const browser = await chromium.launch({ headless: true, executablePath: process.argv[3] });
  try {
    const context = await browser.newContext({ viewport: { width: 1100, height: 850 } });
    await context.route('**/*', route => route.fulfill({ contentType: 'text/html', body: fixture }));
    await context.addCookies([{ name: 'auth-token', value: 'fixture-token-only', domain: 'www.twitch.tv', path: '/', secure: true }]);
    const page = await context.newPage();
    const errors = [];
    page.on('pageerror', e => errors.push(e.message));
    await page.clock.install();
    async function reset(options = {}, tab = page) {
      await tab.goto('https://www.twitch.tv/testchannel');
      await tab.evaluate(options => {
        window.rewardCalls = [];
        window.rewardTest = { balance: 1000, cost: 100, confirmed: 0, until: Date.now() + 6000, ...options };
        window.fetch = async (url, request) => {
          if (url !== 'https://gql.twitch.tv/gql' || request.headers.Authorization !== 'OAuth fixture-token-only') throw new Error('Unexpected request');
          const body = JSON.parse(request.body);
          const mutation = body.query.includes('mutation ');
          const state = window.rewardTest;
          rewardCalls.push({ mutation, time: performance.now(), input: body.variables.input });
          let data;
          if (mutation) {
            if (state.failMutation) throw new Error('Simulated lost response');
            if (state.race) { state.race = false; state.until = Date.now() + 5000; }
            const error = Date.now() < state.until ? { code: 'GLOBAL_COOLDOWN' } : null;
            if (error) data = { redeemCommunityPointsCustomReward: { error, redemption: null } };
            else {
              if (state.balance < state.cost) throw new Error('Mock overspend');
              state.balance -= state.cost;
              state.confirmed++;
              state.until = Date.now() + 6000;
              data = { redeemCommunityPointsCustomReward: { error: null, redemption: { id: 'redemption-' + state.confirmed } } };
            }
          } else data = { currentUser: { id: 'viewer-1' }, user: { id: 'channel-1', channel: {
            self: { communityPoints: { balance: state.balance } }, communityPointsSettings: { customRewards: [{
              id: 'reward-1', title: 'Stretch', prompt: 'Take a stretch', cost: state.cost, isEnabled: true, isPaused: false,
              isInStock: true, isUserInputRequired: !!state.requiresText, cooldownExpiresAt: new Date(state.until).toISOString()
            }] }
          } } };
          return new Response(JSON.stringify({ data }), { headers: { Date: new Date().toUTCString(), 'Content-Type': 'application/json' } });
        };
      }, options);
      await tab.addScriptTag({ path: path.join(__dirname, 'twitch-emote-burst.user.js') });
      await tab.locator('#tm-emote-burst').locator('#toggle').click();
      const root = tab.locator('#tm-emote-dashboard');
      await root.locator('#tab-rewards').click();
      await root.locator('#reward-load').click();
      await root.locator('#reward-pick').selectOption('reward-1');
    }
    const ui = id => page.locator('#tm-emote-dashboard').locator('#reward-' + id);
    async function start() {
      await ui('start').click();
      await new Promise(resolve => setTimeout(resolve, 60));
    }
    const mutationCount = () => page.evaluate(() => rewardCalls.filter(c => c.mutation).length);

    await reset();
    await ui('times').fill('3');
    await start();
    await page.locator('#tm-emote-dashboard').locator('#close').click();
    assert.equal(await page.locator('#tm-emote-dashboard').isVisible(), false);
    await page.clock.runFor(5000);
    assert.equal(await mutationCount(), 0, 'never redeem during initial cooldown');
    assert.match(await ui('status').textContent(), /cooldown/);
    const mini = page.locator('#tm-emote-countdown');
    assert.equal(await mini.locator('#reward-row').isVisible(), true);
    assert.match(await mini.locator('#reward-progress').textContent(), /Rewards 0\/3/);
    await page.screenshot({ path: path.join(__dirname, 'rewards-minimized-preview.png') });
    await page.clock.runFor(26000);
    assert.equal(await mutationCount(), 3);
    assert.equal(await page.evaluate(() => rewardTest.confirmed), 3);
    assert.equal(await ui('done').textContent(), '3 / 3');
    assert.match(await ui('status').textContent(), /Done/);
    assert.equal(await page.evaluate(() => rewardTest.balance), 700);
    const attempts = await page.evaluate(() => rewardCalls.filter(c => c.mutation));
    assert.equal(new Set(attempts.map(c => c.input.transactionID)).size, 3);
    assert.ok(attempts.slice(1).every((c, i) => c.time - attempts[i].time >= 6000));
    assert.equal(await page.locator('#tm-emote-dashboard').isVisible(), false, 'job never needs to reopen dashboard');
    assert.equal(await mini.isVisible(), false, 'bar disappears after completion');
    await page.locator('#tm-emote-burst').locator('#toggle').click();
    await page.screenshot({ path: path.join(__dirname, 'rewards-preview.png') });

    await reset();
    await start();
    await page.clock.runFor(8500);
    assert.equal(await mutationCount(), 1);
    await page.locator('#tm-emote-dashboard').locator('#close').click();
    await mini.locator('#reward-mini-cancel').click();
    await page.clock.runFor(30000);
    assert.equal(await mutationCount(), 1);
    assert.match(await ui('status').textContent(), /Cancelled/);
    assert.equal(await mini.isVisible(), false);

    await reset({ balance: 50 });
    await start();
    await page.clock.runFor(500);
    assert.equal(await mutationCount(), 0);
    assert.match(await ui('status').textContent(), /Not enough/);

    await reset();
    await page.evaluate(() => { rewardTest.cost = 200; });
    await start();
    await page.clock.runFor(500);
    assert.equal(await mutationCount(), 0);
    assert.match(await ui('status').textContent(), /price changed/);

    await reset({ until: 0, failMutation: true });
    await start();
    await page.clock.runFor(30000);
    assert.equal(await mutationCount(), 1, 'uncertain mutations must never retry');
    assert.match(await ui('status').textContent(), /uncertain/);
    assert.equal(await ui('done').textContent(), '0 / 4');

    await reset({ until: 0, race: true });
    await ui('times').fill('2');
    await start();
    await page.clock.runFor(25000);
    assert.equal(await mutationCount(), 3, 'one explicit cooldown rejection, then two successes');
    assert.equal(await ui('done').textContent(), '2 / 2');

    await reset({ requiresText: true });
    await start();
    await page.clock.runFor(500);
    assert.equal(await mutationCount(), 0);
    assert.match(await ui('status').textContent(), /requires a message/);
    await ui('text').fill('Hello from the fixture');
    await ui('times').fill('1');
    await start();
    await page.clock.runFor(10000);
    assert.equal(await page.evaluate(() => rewardCalls.find(c => c.mutation).input.textInput), 'Hello from the fixture');

    await reset();
    await start();
    await page.clock.runFor(1000);
    await page.evaluate(() => history.pushState({}, '', '/otherchannel'));
    await page.clock.runFor(20000);
    assert.equal(await mutationCount(), 0, 'channel change must stop pending redemption');
    assert.equal(await ui('start').isDisabled(), true, 'requires loading the new channel');

    await reset();
    await start();
    await page.clock.runFor(1000);
    const other = await context.newPage();
    await reset({ until: 0 }, other);
    await other.locator('#tm-emote-dashboard').locator('#reward-start').click();
    await new Promise(resolve => setTimeout(resolve, 100));
    assert.match(await other.locator('#tm-emote-dashboard').locator('#reward-status').textContent(), /Another tab/);
    assert.equal(await other.evaluate(() => rewardCalls.filter(c => c.mutation).length), 0);
    await other.close();
    await ui('cancel').click();
    await page.clock.runFor(1000);
    assert.deepEqual(errors, []);
    console.log('Reward checks passed: full job with dashboard closed, minimized progress/Cancel bar, completion cleanup, cooldowns, exact count, cost/balance checks, uncertainty stop, cooldown race, text input, channel change, and cross-tab lock. No real points were spent.');
  } finally { await browser.close(); }
})().catch(error => { console.error(error); process.exitCode = 1; });
