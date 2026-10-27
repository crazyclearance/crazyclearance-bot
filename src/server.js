import { loadConfig } from './config.js';
import { createSheetStore } from './sheet.js';
import { createBrain } from './brain.js';
import { createSender } from './meta.js';
import { createState } from './state.js';
import { createApp } from './app.js';

const cfg = loadConfig();
const state = createState({ humanPauseHours: cfg.humanPauseHours });
const sheet = createSheetStore(cfg);

// Handoff alerts: posts to a Slack/Discord/Google Chat style webhook if HANDOFF_WEBHOOK_URL is set.
async function notify(h) {
  if (!cfg.handoffWebhookUrl) return;
  const where = `${h.branch} ${h.platform} ${h.channel === 'dm' ? 'DM' : 'comment'}`;
  const text = `Needs staff: ${where}\nCustomer: "${h.message}"\nWhy: ${h.reason}`;
  await fetch(cfg.handoffWebhookUrl, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ text, content: text }),
  }).catch(err => console.error('[notify] failed', err.message));
}

const { app } = createApp({ cfg, sheet, decide: createBrain(cfg), sender: createSender(cfg), state, notify });

await sheet.get().then(q => console.log(`[sheet] ${q.length} questions, ${q.filter(x => x.usable).length} confirmed`));
app.listen(cfg.port, () => console.log(`[bot] listening on ${cfg.port}, mode=${cfg.mode}, accounts=${Object.keys(cfg.accounts).length}`));
