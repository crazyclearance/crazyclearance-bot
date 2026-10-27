import express from 'express';
import { verifySignature, parseWebhook } from './meta.js';

/**
 * deps: { cfg, sheet, decide, sender, state, notify }
 */
export function createHandler({ cfg, sheet, decide, sender, state, notify }) {
  return async function handleEvent(ev) {
    const account = cfg.accounts[ev.accountId];
    if (!account) return { skipped: 'account not configured' };

    if (ev.kind === 'staff_reply') {
      state.pauseForHuman(ev.accountId, ev.userId);
      return { skipped: 'staff replied, bot paused for this chat' };
    }
    if (!state.firstTime(ev.id)) return { skipped: 'duplicate webhook' };
    if (ev.kind === 'message' && state.isPaused(ev.accountId, ev.userId)) {
      state.remember(ev.accountId, ev.userId, 'customer', ev.text);
      return { skipped: 'chat is with staff' };
    }

    const channel = ev.kind === 'message' ? 'dm' : 'comment';
    const base = { platform: ev.platform, branch: account.branch, channel, userId: ev.userId, message: ev.text };

    let decision;
    if (!ev.text) {
      decision = { action: ev.hasAttachment ? 'handoff' : 'ignore', used_ids: [], text: '', reason: ev.hasAttachment ? 'photo/video/voice note, needs a person' : 'empty message' };
    } else {
      try {
        const questions = await sheet.get();
        decision = await decide({
          questions, channel, branch: account.branch, platform: ev.platform, message: ev.text,
          history: channel === 'dm' ? state.historyFor(ev.accountId, ev.userId) : [],
        });
      } catch (err) {
        decision = { action: 'handoff', used_ids: [], text: '', reason: `bot error: ${err.message}` };
      }
    }

    const live = cfg.mode === 'live';
    let sent = false, sendError = null;
    try {
      if (decision.action === 'reply') {
        if (live) {
          if (channel === 'dm') await sender.sendDm(account, ev.userId, decision.text);
          else await sender.replyToComment(account, ev.id, decision.text);
          sent = true;
        }
      } else if (decision.action === 'handoff') {
        if (channel === 'dm') {
          if (live && cfg.holdingDm) { await sender.sendDm(account, ev.userId, cfg.holdingDm); sent = true; }
          state.pauseForHuman(ev.accountId, ev.userId); // staff own this chat now
        }
        await notify?.({ ...base, reason: decision.reason, blockedText: decision.blockedText, eventId: ev.id, postId: ev.postId });
      }
    } catch (err) {
      sendError = err.message;
      await notify?.({ ...base, reason: `send failed: ${err.message}`, eventId: ev.id }).catch(() => {});
    }

    if (channel === 'dm') {
      state.remember(ev.accountId, ev.userId, 'customer', ev.text);
      if (sent && decision.action === 'reply') state.remember(ev.accountId, ev.userId, 'shop', decision.text);
    }
    const entry = { ...base, mode: cfg.mode, action: decision.action, reply: decision.text, usedIds: decision.used_ids, reason: decision.reason, blockedText: decision.blockedText, sent, sendError };
    state.record(entry);
    console.log('[event]', JSON.stringify(entry));
    return entry;
  };
}

const esc = s => String(s ?? '').replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));

export function createApp(deps) {
  const { cfg, state } = deps;
  const handleEvent = createHandler(deps);
  const app = express();

  app.get('/health', (_req, res) => res.json({ ok: true, mode: cfg.mode }));

  // Meta calls this once when you add the webhook URL.
  app.get('/webhook', (req, res) => {
    if (req.query['hub.mode'] === 'subscribe' && req.query['hub.verify_token'] === cfg.verifyToken) {
      return res.status(200).send(req.query['hub.challenge']);
    }
    res.sendStatus(403);
  });

  app.post('/webhook', express.raw({ type: '*/*', limit: '1mb' }), (req, res) => {
    if (!verifySignature(req.body, req.get('x-hub-signature-256'), cfg.appSecret)) return res.sendStatus(401);
    res.sendStatus(200); // answer Meta fast; work happens after
    if (cfg.mode === 'off') return;
    let body;
    try { body = JSON.parse(req.body.toString('utf8')); } catch { return; }
    for (const ev of parseWebhook(body, { appId: cfg.appId })) {
      handleEvent(ev).catch(err => console.error('[event] failed', err));
    }
  });

  // Review page: what the bot replied, handed off or blocked. Login: any username + ADMIN_PASSWORD.
  app.get('/admin', (req, res) => {
    const [, b64 = ''] = (req.get('authorization') || '').split(' ');
    const pass = Buffer.from(b64, 'base64').toString().split(':').slice(1).join(':');
    if (!cfg.adminPassword || pass !== cfg.adminPassword) {
      return res.set('WWW-Authenticate', 'Basic realm="bot"').sendStatus(401);
    }
    const rows = state.recent().map(e => `<tr class="${esc(e.action)}"><td>${esc(e.at.slice(0, 16).replace('T', ' '))}</td><td>${esc(e.branch)} ${esc(e.platform)} ${esc(e.channel)}</td><td>${esc(e.message)}</td><td><b>${esc(e.action)}</b>${e.sent ? ' (sent)' : ''}</td><td>${esc(e.reply || e.blockedText)}</td><td>${esc((e.usedIds || []).join(', '))}</td><td>${esc(e.reason)}${e.sendError ? `<br><i>${esc(e.sendError)}</i>` : ''}</td></tr>`).join('');
    res.send(`<!doctype html><meta charset="utf-8"><meta name="viewport" content="width=device-width"><title>Bot log</title>
<style>body{font:14px system-ui;margin:16px}table{border-collapse:collapse;width:100%}td,th{border:1px solid #ccc;padding:6px;vertical-align:top;text-align:left}.handoff{background:#fff6d6}.reply{background:#e8f7ea}.ignore{color:#888}</style>
<h1>Crazy Clearance bot: mode ${esc(cfg.mode)}</h1><p>Last ${state.recent().length} messages since restart. Yellow = needs staff.</p>
<table><tr><th>Time (UTC)</th><th>Where</th><th>Customer</th><th>Action</th><th>Reply</th><th>Answers used</th><th>Reason</th></tr>${rows}</table>`);
  });

  return { app, handleEvent };
}
