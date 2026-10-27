// Usage: node test-browser.cjs <playwright package path> <browser executable>
// All browser traffic is intercepted; no messages are posted to Twitch.
const { chromium } = require(process.argv[2] || 'playwright');
const assert = require('node:assert/strict');
const path = require('node:path');
const script = path.join(__dirname, 'twitch-emote-burst.user.js');
const fixture = `<!doctype html><html><head><style>
body{background:#0e0e10;color:#eee;font:14px system-ui;margin:0}aside{position:fixed;right:0;top:0;bottom:0;width:350px;border-left:1px solid #444;padding:16px;display:flex;flex-direction:column}h2{font-size:16px}.feed{flex:1}.chat-input{background:#18181b;padding:10px}textarea{box-sizing:border-box;width:100%;height:60px;background:#303036;color:white;border:1px solid #666;padding:8px}footer{display:flex;align-items:center;justify-content:space-between;margin-top:8px}button{background:#303036;color:white;border:0;padding:7px;border-radius:4px}
</style></head><body><h2 style="padding:30px">Offline chat fixture</h2><aside><h2>STREAM CHAT</h2><div class="feed" id="feed"></div><div class="chat-input"><textarea data-a-target="chat-input" placeholder="Send a message"></textarea><footer><div style="display:flex;align-items:center"><button data-a-target="chat-settings" aria-label="Chat settings">⚙</button></div><button data-a-target="chat-send-button">Chat</button></footer></div></aside><script>
window.submissions=[];window.submissionTimes=[];
document.querySelector('[data-a-target="chat-send-button"]').onclick=()=>{
const input=document.querySelector('textarea');submissions.push(input.value);submissionTimes.push(performance.now());input.value='';input.dispatchEvent(new Event('input',{bubbles:true}));
};
</script></body></html>`;

(async () => {
  const browser = await chromium.launch({ headless: true, executablePath: process.argv[3] });
  try {
    const context = await browser.newContext({ viewport: { width: 1100, height: 850 } });
    const page = await context.newPage();
    const errors = [];
    page.on('pageerror', error => errors.push(error.message));
    await context.route('**/*', route => route.fulfill({ contentType: 'text/html', body: fixture }));
    await page.clock.install();
    async function reset() {
      await page.goto('https://www.twitch.tv/testchannel');
      await page.evaluate(() => localStorage.clear());
      await page.addScriptTag({ path: script });
      await page.locator('#tm-emote-burst').locator('#toggle').click();
    }
    const ui = id => page.locator(id === 'toggle' ? '#tm-emote-burst' : '#tm-emote-dashboard').locator('#' + id);
    async function start() {
      await ui('start').click();
      // Web Locks are granted outside the virtual timer queue.
      await new Promise(resolve => setTimeout(resolve, 60));
    }
    await reset();
    assert.equal(await ui('emote').inputValue(), 'manguwIly');
    assert.equal(await ui('times').inputValue(), '4');
    assert.equal(await ui('delay').inputValue(), '4');
    assert.equal(await page.locator('#tm-emote-launcher').count(), 0);
    assert.equal(await page.locator('#tm-emote-countdown').isVisible(), false);
    assert.equal(await page.evaluate(() => document.getElementById('tm-emote-burst').nextElementSibling.dataset.aTarget), 'chat-settings');
    await page.screenshot({ path: path.join(__dirname, 'preview.png') });
    await start();
    await page.clock.runFor(18000);
    const messages = await page.evaluate(() => submissions);
    assert.deepEqual(messages.map(s => s.split(' ').length), [18, 19, 18, 19]);
    assert.ok(messages.every(s => s.length <= 500));
    const timings = await page.evaluate(() => submissionTimes);
    for (let i = 1; i < timings.length; i++) assert.ok(timings[i] - timings[i - 1] >= 4000 && timings[i] - timings[i - 1] < 4200);
    assert.match(await ui('status').textContent(), /Done/);

    await reset();
    await ui('preset').selectOption('2,7');
    assert.equal(await ui('delay').inputValue(), '2');
    assert.equal(await ui('times').inputValue(), '7');
    await start();
    await page.clock.runFor(1000);
    await ui('stop').click();
    await page.clock.runFor(20000);
    assert.equal(await page.evaluate(() => submissions.length), 1);

    await reset();
    await page.locator('textarea').fill('Keep my draft');
    if (!await ui('menu').isVisible()) await ui('toggle').click();
    await start();
    await page.clock.runFor(1000);
    assert.equal(await page.evaluate(() => submissions.length), 0);
    assert.equal(await page.locator('textarea').inputValue(), 'Keep my draft');

    await reset();
    await start();
    await page.clock.runFor(1000);
    await page.evaluate(() => { const notice = document.createElement('div'); notice.className = 'chat-line__status'; notice.textContent = 'Your message was not sent because you are sending messages too quickly.'; document.getElementById('feed').append(notice); });
    await page.clock.runFor(20000);
    assert.equal(await page.evaluate(() => submissions.length), 1);
    assert.match(await ui('status').textContent(), /restriction or rejection/);

    await reset();
    await start();
    await page.clock.runFor(1000);
    await page.evaluate(() => history.pushState({}, '', '/differentchannel'));
    await page.clock.runFor(20000);
    assert.equal(await page.evaluate(() => submissions.length), 1);
    assert.match(await ui('status').textContent(), /channel changed/);

    // Slate-style contenteditable input, using the browser's editing API.
    await reset();
    await page.evaluate(() => {
      const old = document.querySelector('textarea');
      const input = document.createElement('div');
      input.contentEditable = 'true';
      input.dataset.aTarget = 'chat-input';
      input.setAttribute('role', 'textbox');
      input.style.cssText = 'min-height:60px;border:1px solid #666';
      old.replaceWith(input);
      document.querySelector('[data-a-target="chat-send-button"]').onclick = () => { submissions.push(input.textContent); input.textContent = ''; };
    });
    await ui('times').fill('1');
    await start();
    await page.clock.runFor(1000);
    assert.equal(await page.evaluate(() => submissions[0]), Array(18).fill('manguwIly').join(' '));

    // Another tab cannot acquire the run lock while the first burst is active.
    await reset();
    await start();
    await page.clock.runFor(1000);
    const other = await page.context().newPage();
    await other.goto('https://www.twitch.tv/testchannel');
    await other.addScriptTag({ path: script });
    await other.locator('#tm-emote-burst').locator('#toggle').click();
    await other.locator('#tm-emote-dashboard').locator('#start').click();
    await new Promise(resolve => setTimeout(resolve, 100));
    assert.match(await other.locator('#tm-emote-dashboard').locator('#status').textContent(), /Another tab/);
    assert.equal(await other.evaluate(() => submissions.length), 0);
    await other.close();
    await ui('stop').click();
    await page.clock.runFor(1000);

    // Recurring mode waits before the first block, ignores the burst count,
    // and exposes a countdown/cancel control independently of the menu.
    await reset();
    await ui('preset').selectOption('repeat:60');
    assert.equal(await ui('mode').inputValue(), 'repeat');
    assert.equal(await ui('delay').inputValue(), '60');
    assert.equal(await ui('times').isDisabled(), true);
    await start();
    assert.equal(await ui('test').isDisabled(), true, 'test cannot interrupt an active schedule');
    await ui('close').click();
    const countdown = page.locator('#tm-emote-countdown').locator('#next');
    const cancel = page.locator('#tm-emote-countdown').locator('#cancel');
    await page.clock.runFor(1000);
    assert.match(await countdown.textContent(), /Next block 00:59/);
    const bar = await page.locator('#tm-emote-countdown').boundingBox();
    const sendButton = await page.locator('[data-a-target="chat-send-button"]').boundingBox();
    assert.ok(bar.y + bar.height < sendButton.y, 'countdown sits above Send');
    await page.screenshot({ path: path.join(__dirname, 'repeat-preview.png') });
    await page.clock.runFor(58000);
    assert.equal(await page.evaluate(() => submissions.length), 0, 'first block must wait a full minute');
    await page.clock.runFor(2000);
    assert.equal(await page.evaluate(() => submissions.length), 1);
    await page.clock.runFor(60000);
    assert.equal(await page.evaluate(() => submissions.length), 2);
    const recurringTimes = await page.evaluate(() => submissionTimes);
    assert.ok(recurringTimes[1] - recurringTimes[0] >= 60000);
    assert.match(await countdown.textContent(), /Next block 00:59/);
    await cancel.click();
    await page.clock.runFor(180000);
    assert.equal(await page.evaluate(() => submissions.length), 2);
    assert.equal(await page.locator('#tm-emote-countdown').isVisible(), false);

    // Resuming a suspended tab must not replay every missed minute.
    await reset();
    await ui('preset').selectOption('repeat:60');
    await start();
    await page.clock.runFor(1000);
    await page.clock.fastForward(300000);
    await page.clock.runFor(1000);
    assert.equal(await page.evaluate(() => submissions.length), 1, 'skip missed intervals instead of catching up');
    await ui('close').click();
    await page.locator('#tm-emote-countdown').locator('#cancel').click();
    await page.clock.runFor(1000);

    // Regression: transformed, clipped chat ancestors cannot hide the panel.
    await reset();
    await ui('close').click();
    await page.evaluate(() => { document.querySelector('.chat-input').style.cssText = 'transform:translateZ(0);overflow:hidden;contain:paint'; });
    await ui('toggle').click();
    assert.equal(await ui('menu').isVisible(), true);
    assert.equal(await page.evaluate(() => document.getElementById('tm-emote-dashboard').parentElement === document.body), true);
    const emoteRect = await ui('emote').boundingBox();
    const hit = await page.evaluate(({ x, y }) => document.elementFromPoint(x, y)?.id, { x: emoteRect.x + 10, y: emoteRect.y + 10 });
    assert.equal(hit, 'tm-emote-dashboard', 'dashboard is in front of clipped chat');
    await ui('emote').fill('LUL');
    assert.equal(await ui('emote').inputValue(), 'LUL');
    await page.screenshot({ path: path.join(__dirname, 'dashboard-preview.png') });

    // Test always sends exactly one emote, even with Repeat mode selected.
    await ui('preset').selectOption('repeat:60');
    await ui('test').click();
    await new Promise(resolve => setTimeout(resolve, 60));
    await page.clock.runFor(1000);
    assert.deepEqual(await page.evaluate(() => submissions), ['LUL']);
    assert.equal(await page.evaluate(() => JSON.parse(localStorage.getItem('tm-twitch-emote-burst-v1:attempts')).length), 1, 'test shares rate budget');
    assert.match(await ui('status').textContent(), /Test submitted/);
    assert.equal(await ui('dashboard-sent').textContent(), '1');
    assert.equal(await ui('dashboard-state').textContent(), 'Idle');
    assert.equal(await ui('times').isDisabled(), true, 'Repeat controls remain selected');
    assert.equal(await page.locator('#tm-emote-countdown').isVisible(), false);
    await page.clock.runFor(180000);
    assert.equal(await page.evaluate(() => submissions.length), 1, 'Test never starts a repeating schedule');
    await page.screenshot({ path: path.join(__dirname, 'dashboard-preview.png') });

    await page.setViewportSize({ width: 390, height: 680 });
    const menuRect = await ui('menu').boundingBox();
    assert.ok(menuRect.x >= 0 && menuRect.x + menuRect.width <= 390);
    assert.ok(menuRect.y >= 0 && menuRect.y + menuRect.height <= 680);
    assert.deepEqual(errors, []);
    await reset();
    await page.locator('textarea').fill('Keep this draft');
    await ui('test').click();
    await new Promise(resolve => setTimeout(resolve, 60));
    await page.clock.runFor(1000);
    assert.equal(await page.evaluate(() => submissions.length), 0, 'test preserves drafts');
    assert.equal(await page.locator('textarea').inputValue(), 'Keep this draft');

    // Cold first interaction: the editor remounts on focus, React enables Send
    // late, and the submitted draft clears after a slow UI update.
    await page.setViewportSize({ width: 1100, height: 850 });
    await reset();
    await page.evaluate(() => {
      const hidden = document.createElement('div');
      hidden.className = 'chat-input';
      hidden.style.display = 'none';
      hidden.innerHTML = '<textarea data-a-target="chat-input">Hidden stale draft</textarea><button data-a-target="chat-send-button" disabled>Hidden</button>';
      document.body.prepend(hidden);
      const button = document.querySelector('aside [data-a-target="chat-send-button"]');
      button.disabled = true;
      document.querySelector('aside textarea').addEventListener('focus', event => {
        event.target.replaceWith(event.target.cloneNode(true));
      }, { once: true });
      document.addEventListener('input', event => {
        if (event.target.matches('aside textarea')) setTimeout(() => { button.disabled = false; }, 750);
      });
      button.onclick = () => {
        const input = document.querySelector('aside textarea');
        submissions.push(input.value);
        setTimeout(() => { input.value = ''; }, 900);
      };
    });
    await ui('test').click();
    await new Promise(resolve => setTimeout(resolve, 60));
    assert.equal(await ui('test').textContent(), 'Testing…');
    await page.clock.runFor(500);
    assert.equal(await page.evaluate(() => submissions.length), 0);
    assert.equal(await ui('test').isDisabled(), true);
    await ui('test').evaluate(button => button.click());
    await page.clock.runFor(2000);
    assert.deepEqual(await page.evaluate(() => submissions), ['manguwIly']);
    assert.match(await ui('status').textContent(), /Test submitted/);
    assert.equal(await ui('test').textContent(), 'Test 1 emote');

    // If a clicked submission never clears, preserve it and never retry.
    await reset();
    await page.evaluate(() => {
      document.querySelector('[data-a-target="chat-send-button"]').onclick = () => submissions.push(document.querySelector('textarea').value);
    });
    await ui('test').click();
    await new Promise(resolve => setTimeout(resolve, 60));
    await page.clock.runFor(5000);
    assert.equal(await page.evaluate(() => submissions.length), 1);
    assert.match(await ui('status').textContent(), /Submission is uncertain/);
    assert.equal(await page.locator('textarea').inputValue(), 'manguwIly');
    assert.deepEqual(errors, []);
    console.log('Browser checks passed: existing bursts/repeat, one-click cold editor remount, delayed Send readiness, delayed draft clearing, hidden editor exclusion, repeat-click protection, and no retries or deletion after uncertain submission. No Twitch requests were made.');
  } finally { await browser.close(); }
})().catch(error => { console.error(error); process.exitCode = 1; });
