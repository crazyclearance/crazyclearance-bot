import { test } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import { readFileSync } from 'node:fs';
import { parseCsv, rowsToQuestions, createSheetStore } from '../src/sheet.js';
import { checkReply, buildSystemPrompt, createBrain } from '../src/brain.js';
import { verifySignature, parseWebhook } from '../src/meta.js';
import { createState } from '../src/state.js';
import { createHandler, createApp } from '../src/app.js';

const questions = rowsToQuestions(parseCsv(readFileSync('data/common-questions.csv', 'utf8')));
const Q = id => questions.find(q => q.id === id);

test('sheet: reads all 48 questions, 26 usable, yellow rows blocked', () => {
  assert.equal(questions.length, 48);
  assert.equal(questions.filter(q => q.usable).length, 26);
  assert.equal(Q('Q02').usable, true);
  assert.equal(Q('Q21').usable, false); // reserve: conflict
  assert.equal(Q('Q04').usable, false); // Aylesbury days unconfirmed
  assert.equal(Q('Q07').usable, false); // has answer text but not confirmed
});

test('sheet: placeholder in a confirmed row still blocks it', () => {
  const rows = parseCsv('ID,Category,Question,Other ways customers ask,Answer (DM),Answer (public comment),Branch,Status,Notes for staff\nQ99,x,Where?,,At [full address],DM us,All,Confirmed,\n');
  assert.equal(rowsToQuestions(rows)[0].usable, false);
});

test('sheet: keeps last good copy if Google fetch fails', async () => {
  let calls = 0;
  const csv = readFileSync('data/common-questions.csv', 'utf8');
  const fakeFetch = async () => (++calls === 1 ? { ok: true, text: async () => csv } : { ok: false, status: 500 });
  const store = createSheetStore({ sheetId: 'abc', sheetTab: 'Common Questions', sheetCacheSeconds: 0 }, fakeFetch);
  assert.equal((await store.get()).length, 48);
  assert.equal((await store.get()).length, 48); // second fetch fails, cache used
});

test('prompt: approved answers in, unconfirmed listed as handoff', () => {
  const p = buildSystemPrompt(questions);
  assert.match(p, /\[Q02\] When is Tipton open\?/);
  assert.doesNotMatch(p, /\[Q21\]/);
  assert.match(p, /Can you hold \/ reserve it for me\?/);
});

test('guard: good reply passes', () => {
  assert.deepEqual(checkReply({ used_ids: ['Q02'], text: 'Tipton is open Sat & Sun, 10am to 4pm. Postcode DY4 9HG 🙌' }, questions, 'dm'), { ok: true });
});

test('guard: invented price blocked', () => {
  const r = checkReply({ used_ids: ['Q22'], text: "It's £15, pop in!" }, questions, 'dm');
  assert.equal(r.ok, false); assert.match(r.why, /£15/);
});

test('guard: wrong opening time blocked', () => {
  const r = checkReply({ used_ids: ['Q02'], text: 'Tipton is open 9am to 5pm.' }, questions, 'dm');
  assert.equal(r.ok, false);
});

test('guard: invented phone number blocked, real one allowed', () => {
  assert.equal(checkReply({ used_ids: ['Q42'], text: 'Call 07700 900123' }, questions, 'dm').ok, false);
  assert.equal(checkReply({ used_ids: ['Q42'], text: 'Call us on 07932 799244.' }, questions, 'dm').ok, true);
});

test('guard: unconfirmed or unknown answer blocked', () => {
  assert.match(checkReply({ used_ids: ['Q21'], text: 'Yes we can hold it' }, questions, 'dm').why, /not confirmed/);
  assert.match(checkReply({ used_ids: [], text: 'Yes!' }, questions, 'dm').why, /not based/);
  assert.match(checkReply({ used_ids: ['Q999'], text: 'Yes!' }, questions, 'dm').why, /unknown/);
});

test('guard: public comment rules', () => {
  assert.equal(checkReply({ used_ids: ['Q32'], text: 'Please send your order number here' }, questions, 'comment').ok, false);
  assert.equal(checkReply({ used_ids: ['Q47'], text: "I'm the shop's assistant" }, questions, 'comment').ok, false); // Q47 has no public answer
  assert.equal(checkReply({ used_ids: ['Q13'], text: 'x'.repeat(300) }, questions, 'comment').ok, false);
  assert.equal(checkReply({ used_ids: ['Q13'], text: 'Gone is gone 🔥🔥' }, questions, 'comment').ok, false);
});

test('brain: blocked model reply becomes handoff', async () => {
  const fakeClient = { messages: { create: async () => ({ content: [{ type: 'tool_use', input: { action: 'reply', used_ids: ['Q22'], text: 'That one is £9.99', reason: 'price' } }] }) } };
  const decide = createBrain({ model: 'x' }, fakeClient);
  const d = await decide({ questions, channel: 'dm', branch: 'Tipton', platform: 'instagram', message: 'how much?' });
  assert.equal(d.action, 'handoff');
  assert.match(d.reason, /Blocked by safety check/);
});

test('meta: signature check', () => {
  const body = Buffer.from('{"a":1}');
  const sig = 'sha256=' + crypto.createHmac('sha256', 'secret').update(body).digest('hex');
  assert.equal(verifySignature(body, sig, 'secret'), true);
  assert.equal(verifySignature(body, sig, 'wrong'), false);
  assert.equal(verifySignature(body, undefined, 'secret'), false);
});

test('meta: parses IG DM, FB comment, echoes', () => {
  const ig = parseWebhook({ object: 'instagram', entry: [{ id: 'IG1', messaging: [
    { sender: { id: 'U1' }, recipient: { id: 'IG1' }, message: { mid: 'm1', text: 'open sunday?' } },
    { sender: { id: 'IG1' }, recipient: { id: 'U1' }, message: { mid: 'm2', text: 'hi', is_echo: true, app_id: 'APP' } },
    { sender: { id: 'IG1' }, recipient: { id: 'U2' }, message: { mid: 'm3', text: 'hi', is_echo: true } },
  ] }] }, { appId: 'APP' });
  assert.deepEqual(ig.map(e => e.kind), ['message', 'staff_reply']);
  assert.equal(ig[1].userId, 'U2');

  const fb = parseWebhook({ object: 'page', entry: [{ id: 'P1', changes: [
    { field: 'feed', value: { item: 'comment', verb: 'add', comment_id: 'c1', post_id: 'p', message: 'price?', from: { id: 'U9' } } },
    { field: 'feed', value: { item: 'comment', verb: 'add', comment_id: 'c2', message: 'our reply', from: { id: 'P1' } } },
    { field: 'feed', value: { item: 'reaction', verb: 'add' } },
  ] }] });
  assert.equal(fb.length, 1);
  assert.equal(fb[0].id, 'c1');
});

function harness(decision, mode = 'live') {
  const sent = [], notes = [];
  const cfg = { mode, holdingDm: 'Team will reply soon', accounts: { IG1: { platform: 'instagram', branch: 'Tipton', token: 't' } } };
  const deps = {
    cfg, state: createState(),
    sheet: { get: async () => questions },
    decide: async () => decision,
    sender: { sendDm: async (_a, u, t) => sent.push(['dm', u, t]), replyToComment: async (_a, c, t) => sent.push(['comment', c, t]) },
    notify: async n => notes.push(n),
  };
  return { handle: createHandler(deps), sent, notes, deps };
}

test('flow: confirmed reply is sent once, duplicate webhook ignored', async () => {
  const h = harness({ action: 'reply', used_ids: ['Q02'], text: 'Sat & Sun, 10am to 4pm', reason: '' });
  const ev = { kind: 'message', platform: 'instagram', accountId: 'IG1', userId: 'U1', id: 'm1', text: 'open sunday?' };
  await h.handle(ev); await h.handle(ev);
  assert.deepEqual(h.sent, [['dm', 'U1', 'Sat & Sun, 10am to 4pm']]);
});

test('flow: handoff sends holding DM, alerts staff, then bot stays quiet in that chat', async () => {
  const h = harness({ action: 'handoff', used_ids: [], text: '', reason: 'reserve not confirmed' });
  await h.handle({ kind: 'message', platform: 'instagram', accountId: 'IG1', userId: 'U1', id: 'm1', text: 'can you hold it?' });
  await h.handle({ kind: 'message', platform: 'instagram', accountId: 'IG1', userId: 'U1', id: 'm2', text: 'hello??' });
  assert.equal(h.sent.length, 1);
  assert.equal(h.notes.length, 1);
});

test('flow: staff reply pauses bot for that chat', async () => {
  const h = harness({ action: 'reply', used_ids: ['Q02'], text: 'Sat & Sun', reason: '' });
  await h.handle({ kind: 'staff_reply', platform: 'instagram', accountId: 'IG1', userId: 'U1' });
  const r = await h.handle({ kind: 'message', platform: 'instagram', accountId: 'IG1', userId: 'U1', id: 'm9', text: 'thanks' });
  assert.match(r.skipped, /staff/);
  assert.equal(h.sent.length, 0);
});

test('flow: comment handoff is NOT replied to publicly', async () => {
  const h = harness({ action: 'handoff', used_ids: [], text: '', reason: 'complaint' });
  await h.handle({ kind: 'comment', platform: 'instagram', accountId: 'IG1', userId: 'U5', id: 'c1', text: 'terrible service' });
  assert.equal(h.sent.length, 0);
  assert.equal(h.notes.length, 1);
});

test('flow: shadow mode never sends', async () => {
  const h = harness({ action: 'reply', used_ids: ['Q02'], text: 'Sat & Sun', reason: '' }, 'shadow');
  const r = await h.handle({ kind: 'message', platform: 'instagram', accountId: 'IG1', userId: 'U1', id: 'm1', text: 'open?' });
  assert.equal(h.sent.length, 0);
  assert.equal(r.action, 'reply');
});

test('flow: photo-only DM goes to staff; unknown account ignored', async () => {
  const h = harness({ action: 'reply', used_ids: ['Q02'], text: 'x', reason: '' });
  const r = await h.handle({ kind: 'message', platform: 'instagram', accountId: 'IG1', userId: 'U1', id: 'm1', text: '', hasAttachment: true });
  assert.equal(r.action, 'handoff');
  const r2 = await h.handle({ kind: 'message', platform: 'instagram', accountId: 'NOPE', userId: 'U1', id: 'm2', text: 'hi' });
  assert.match(r2.skipped, /not configured/);
});

test('http: webhook verify + signed POST', async () => {
  const h = harness({ action: 'ignore', used_ids: [], text: '', reason: '' });
  const cfg = { ...h.deps.cfg, verifyToken: 'vt', appSecret: 'sec', appId: 'APP', adminPassword: 'pw' };
  const { app } = createApp({ ...h.deps, cfg });
  const srv = app.listen(0); const port = srv.address().port;
  try {
    const v = await fetch(`http://localhost:${port}/webhook?hub.mode=subscribe&hub.verify_token=vt&hub.challenge=123`);
    assert.equal(await v.text(), '123');
    const body = JSON.stringify({ object: 'instagram', entry: [] });
    const bad = await fetch(`http://localhost:${port}/webhook`, { method: 'POST', body, headers: { 'x-hub-signature-256': 'sha256=00' } });
    assert.equal(bad.status, 401);
    const sig = 'sha256=' + crypto.createHmac('sha256', 'sec').update(body).digest('hex');
    const ok = await fetch(`http://localhost:${port}/webhook`, { method: 'POST', body, headers: { 'x-hub-signature-256': sig, 'content-type': 'application/json' } });
    assert.equal(ok.status, 200);
    assert.equal((await fetch(`http://localhost:${port}/admin`)).status, 401);
    const adm = await fetch(`http://localhost:${port}/admin`, { headers: { authorization: 'Basic ' + Buffer.from('x:pw').toString('base64') } });
    assert.equal(adm.status, 200);
  } finally { srv.close(); }
});
