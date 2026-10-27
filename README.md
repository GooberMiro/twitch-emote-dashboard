# Twitch Emote Dashboard

A Tampermonkey userscript for Twitch chat, with emote bursts, recurring emote blocks, and cooldown-aware custom Channel Points redemptions.

## Install

1. Open `twitch-emote-burst.user.js` and copy its contents.
2. In Tampermonkey, choose **Create a new script**, replace the editor contents, and save.
3. Refresh Twitch and open a live channel.
4. Click the repeat-arrow icon beside chat settings to open the dashboard.

When updating, replace the existing script instead of installing a second active copy.

## Emotes

- **Test 1 emote** submits one copy of the selected emote.
- Default burst: four messages, four seconds apart, alternating 18/19 emotes.
- Change the emote, block size, count, or interval, or choose a preset.
- Repeat presets send a block every one, three, or five minutes; custom intervals are available.
- Recurring mode waits one full interval before its first block.
- The progress/Cancel bar appears above Send only while a job is active.

Both block sizes must fit the 500-character limit. The script uses a conservative local budget of 18 attempts per 30 seconds and at least two seconds between sends. Attempts from other devices, extensions, or tabs without this script cannot be counted. Twitch slow mode, duplicate checks, emote eligibility, and moderation still apply; delivery is not guaranteed.

## Channel Points rewards

1. While logged in to Twitch, open **Point rewards**.
2. Click **Load this channel's rewards** and choose a custom reward.
3. Set a count from 1–100 and supply a reward message if required.
4. Review the displayed point cost, then click **Start redeeming**.

The script checks Twitch's cooldown and balance before redeeming, counts confirmed redemption IDs, and stops at the selected count. Closing the dashboard leaves the job running. The small reward progress bar includes **Cancel reward**. Keep the Twitch tab open; closing/reloading the tab or changing channels stops the job. A request already submitted may still complete after cancellation.

Price/detail changes, insufficient points, unavailable rewards, and uncertain requests stop the job. An explicit cooldown rejection is rechecked; an uncertain submission is never blindly retried. Custom rewards are supported; Bits purchases and built-in reward types are not.

## Privacy and compatibility

Emote messages use Twitch's normal chat composer. The Rewards tab uses Twitch's private web GraphQL API with the existing Twitch login. The login token is sent only to `https://gql.twitch.tv/gql`, is kept in memory while needed, and is not saved by this script or sent to a third-party server. Local browser storage holds emote settings, recent send-attempt times, and the last attempted emote message per channel.

Twitch can change its editor or private API, or require additional verification. Query and skipped-action schema checks passed on October 19, 2026. Browser simulations cover the interaction and scheduling behavior, but actual authenticated redemption has not been verified against a live account. No account credentials are included in this repository.

## Tests

Run the pure JavaScript checks with Node.js:

```sh
node test.cjs
```

The browser tests require Playwright and a Chromium-compatible browser. Supply the installed Playwright package path and browser executable:

```sh
node test-browser.cjs <playwright-package-path> <browser-executable>
node test-rewards-browser.cjs <playwright-package-path> <browser-executable>
```

Browser traffic is intercepted and reward responses are simulated. These tests do not post messages to Twitch or spend real points.
