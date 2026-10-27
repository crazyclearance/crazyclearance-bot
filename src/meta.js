import crypto from 'node:crypto';

// Meta signs each webhook with the App Secret. Reject anything that doesn't match.
export function verifySignature(rawBody, header, appSecret) {
  if (!header || !header.startsWith('sha256=')) return false;
  const expected = crypto.createHmac('sha256', appSecret).update(rawBody).digest('hex');
  const given = header.slice(7);
  if (given.length !== expected.length) return false;
  return crypto.timingSafeEqual(Buffer.from(given, 'hex'), Buffer.from(expected, 'hex'));
}

/**
 * Turn a Meta webhook body into simple events:
 *  {kind:'message', platform, accountId, userId, text, id, hasAttachment}
 *  {kind:'comment', platform, accountId, userId, text, id, postId}
 *  {kind:'staff_reply', platform, accountId, userId}   (a human replied from the inbox)
 */
export function parseWebhook(body, { appId } = {}) {
  const events = [];
  const platform = body.object === 'instagram' ? 'instagram' : body.object === 'page' ? 'facebook' : null;
  if (!platform) return events;

  for (const entry of body.entry || []) {
    const accountId = String(entry.id);

    for (const m of entry.messaging || []) {
      const msg = m.message;
      if (!msg) continue; // reads, deliveries, reactions etc.
      if (msg.is_echo) {
        // Our own sends carry our app_id. Anything else is a person replying from Meta Business Suite / inbox app.
        const fromOurApp = appId && String(msg.app_id || '') === String(appId);
        if (!fromOurApp) events.push({ kind: 'staff_reply', platform, accountId, userId: String(m.recipient?.id) });
        continue;
      }
      if (msg.is_deleted || msg.is_unsupported) continue;
      events.push({
        kind: 'message', platform, accountId,
        userId: String(m.sender?.id), id: msg.mid,
        text: (msg.text || '').trim(),
        hasAttachment: Array.isArray(msg.attachments) && msg.attachments.length > 0,
      });
    }

    for (const ch of entry.changes || []) {
      const v = ch.value || {};
      if (platform === 'facebook' && ch.field === 'feed' && v.item === 'comment' && v.verb === 'add') {
        const fromId = String(v.from?.id || '');
        if (fromId === accountId) continue; // the page itself commenting
        events.push({ kind: 'comment', platform, accountId, userId: fromId, id: v.comment_id, postId: v.post_id, text: (v.message || '').trim() });
      }
      if (platform === 'instagram' && ch.field === 'comments') {
        const fromId = String(v.from?.id || '');
        if (fromId === accountId) continue;
        events.push({ kind: 'comment', platform, accountId, userId: fromId, id: v.id, postId: v.media?.id, text: (v.text || '').trim() });
      }
    }
  }
  return events;
}

export function createSender(cfg, fetchImpl = fetch) {
  const base = `https://graph.facebook.com/${cfg.graphVersion}`;
  async function post(path, token, payload) {
    const res = await fetchImpl(`${base}/${path}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
      body: JSON.stringify(payload),
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(`Graph API ${path} failed: ${res.status} ${JSON.stringify(data.error || data)}`);
    return data;
  }
  return {
    // Works for Facebook Messenger and Instagram DMs (page token, user's page/IG-scoped ID).
    sendDm(account, userId, text) {
      return post('me/messages', account.token, { recipient: { id: userId }, messaging_type: 'RESPONSE', message: { text } });
    },
    replyToComment(account, commentId, text) {
      return account.platform === 'instagram'
        ? post(`${commentId}/replies`, account.token, { message: text })
        : post(`${commentId}/comments`, account.token, { message: text });
    },
  };
}
