/**
 * Who receives a Meta request and under which conditions, with simulated
 * servers and fictitious data only: answers are bound to a processing class
 * (standard, contributor, or one undocumented model) and to the Meta API key
 * they were given under; local paths and secret-like values are scrubbed.
 */

import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import test from 'node:test';

import { CLOUD_DISCLOSURE_KEY } from '../src/cloudDisclosure.js';
import { redactSecrets, scrubLocalPaths } from '../src/cloudEgress.js';
import { META_CREDENTIAL_KEY, processingClass } from '../src/metaRecipient.js';
import { buildViewHtml } from '../src/viewHtml.js';
import { assistantText, fakeCloud, HostHarness, type PostedState } from './helpers/hostHarness.js';

const KEY_ONE = 'fake-meta-key-RECIPIENT-one-1111';
const KEY_TWO = 'fake-meta-key-RECIPIENT-two-2222';
type Card = { digest: string; contributor: boolean; askToolResults: boolean; messages: Array<{ text: string }> };
const cardOf = (state: PostedState): Card | null => (state.remote as { disclosure: Card | null }).disclosure;
const bodies = (from = 0): string => JSON.stringify(fakeCloud.requests.slice(from).map((request) => request.body));
const catalogOf = (h: HostHarness) => (h.provider as unknown as { cloudCatalog: Array<{ id: string; label: string; contributor: boolean }> }).cloudCatalog;
const chatRequests = () => fakeCloud.requests.filter((request) => request.url.includes('chat/completions')).length;
const ok = () => Response.json({ choices: [{ message: { role: 'assistant', content: 'ok' }, finish_reason: 'stop' }], usage: { prompt_tokens: 5, completion_tokens: 1, total_tokens: 6 } });

async function withHarness(body: (h: HostHarness) => Promise<void>): Promise<void> {
  const h = new HostHarness();
  await h.start({ agentProfile: 'safe-auto', allowCloudEscalation: true });
  h.secretValues.set('rameCode.metaModelApiKey', KEY_ONE);
  fakeCloud.requests.length = 0;
  fakeCloud.handler = ok;
  // The fallback catalog lists standard models only; a live catalog also lists Contributor variants.
  catalogOf(h).push({ id: 'muse-spark-1.3-contributor', label: 'muse-spark-1.3-contributor — Contributor (data may be used)', contributor: true });
  try {
    await body(h);
  } finally {
    fakeCloud.handler = null;
    h.provider.cancelRequest();
    await h.dispose();
  }
}

async function local(h: HostHarness, text: string): Promise<void> {
  h.model.enqueue({ kind: 'json', body: assistantText(`local reply: ${text}`) });
  await h.provider.sendMessage(text, 'chat', 'local');
}

/** Send to `model`; answer a card with `choice` when one appears ('none' leaves it open). */
async function meta(h: HostHarness, text: string, model: string, choice: 'include' | 'withhold' | 'none' = 'include', mode: 'chat' | 'agent' = 'chat', toolResults?: boolean): Promise<Card | null> {
  if (h.provider.selectedCloudModel() !== model) {
    await h.provider.selectCloudModel(model);
    assert.equal(h.provider.selectedCloudModel(), model, `the test could not select ${model}`);
  }
  const before = fakeCloud.requests.length;
  await h.provider.sendMessage(text, mode, 'cloud');
  const card = cardOf(h.last());
  if (card && choice !== 'none') {
    h.send({ type: 'disclosureDecide', digest: card.digest, choice, ...(toolResults === undefined ? {} : { toolResults }) });
    await h.waitFor((state) => fakeCloud.requests.length > before && !state.running, 8000);
  }
  return card;
}

// ----- Processing classes -----

test('processing classes: documented standard models share one, Contributor variants another, anything else is its own', () => {
  for (const id of ['muse-spark-1.1', 'muse-spark-1.2', 'muse-spark-1.3', 'muse-wonder-1.0']) {
    assert.equal(processingClass(id), 'standard', id);
  }
  for (const id of ['muse-spark-1.2-contributor', 'muse-spark-1.3-contributor']) {
    assert.equal(processingClass(id), 'contributor', id);
  }
  assert.equal(processingClass('muse-spark-9.9-preview'), 'model:muse-spark-9.9-preview');
  assert.equal(processingClass('muse-spark-2.0-contributor'), 'model:muse-spark-2.0-contributor', 'an undocumented contributor id is not the documented class');
  assert.notEqual(processingClass('muse-spark-9.9-preview'), processingClass('muse-wonder-9.9'));
});

test('Standard → Contributor asks again, also for what Meta received under the standard class; nothing is sent before', async () => {
  await withHarness(async (h) => {
    await local(h, 'MK-LOCAL-STD local note.');
    await meta(h, 'MK-STANDARD-EXCHANGE question for standard.', 'muse-spark-1.3');
    const before = fakeCloud.requests.length;
    const card = await meta(h, 'To contributor.', 'muse-spark-1.3-contributor', 'none');
    assert.ok(card, 'a new card');
    assert.equal(card.contributor, true);
    assert.equal(fakeCloud.requests.length, before, 'nothing sent before the answer');
    const offered = card.messages.map((entry) => entry.text);
    assert.ok(offered.includes('MK-LOCAL-STD local note.'));
    assert.ok(offered.includes('MK-STANDARD-EXCHANGE question for standard.'), 'the standard exchange is not yet shared under contributor terms');
    h.send({ type: 'disclosureDecide', digest: card.digest, choice: 'withhold' });
    await h.waitFor((state) => fakeCloud.requests.length > before && !state.running, 8000);
    const sent = bodies(before);
    assert.equal(sent.includes('MK-LOCAL-STD') || sent.includes('MK-STANDARD-EXCHANGE'), false);
  });
});

test('Contributor → Standard reuses only a compatible standard answer; standard ↔ standard needs no card', async () => {
  await withHarness(async (h) => {
    await local(h, 'MK-BOTH local note.');
    // Contributor first: nothing for standard exists, so standard asks.
    await meta(h, 'Contributor first.', 'muse-spark-1.3-contributor', 'include');
    const standardCard = await meta(h, 'Now standard.', 'muse-spark-1.3', 'none');
    assert.ok(standardCard, 'no default reuse from contributor to standard');
    h.send({ type: 'disclosureDecide', digest: standardCard.digest, choice: 'include' });
    await h.waitFor((state) => !state.running && cardOf(state) === null, 8000);
    // Standard answered: Spark ↔ Wonder (both standard) reuse it.
    assert.equal(await meta(h, 'Wonder.', 'muse-wonder-1.0', 'none'), null);
    assert.equal(await meta(h, 'Spark again.', 'muse-spark-1.3', 'none'), null);
    // Back to contributor: its own earlier answer still applies (same key), only what is new for it is asked.
    const back = await meta(h, 'Contributor again.', 'muse-spark-1.3-contributor', 'none');
    assert.ok(back === null || back.messages.every((entry) => !entry.text.includes('MK-BOTH')), 'the contributor answer for MK-BOTH holds');
  });
});

test('an undocumented model gets its own class: nothing approved elsewhere is reused, and each such model asks', async () => {
  await withHarness(async (h) => {
    await local(h, 'MK-UNKNOWN local note.');
    await meta(h, 'Standard.', 'muse-spark-1.3', 'include');
    // The catalog only lists compatible ids; an undocumented one is selected through it.
    catalogOf(h).push({ id: 'muse-spark-9.9-preview', label: 'muse-spark-9.9-preview', contributor: false });
    await h.provider.selectCloudModel('muse-spark-9.9-preview');
    assert.equal(h.provider.selectedCloudModel(), 'muse-spark-9.9-preview');
    const before = fakeCloud.requests.length;
    const card = await meta(h, 'Unknown.', 'muse-spark-9.9-preview', 'none');
    assert.ok(card?.messages.some((entry) => entry.text === 'MK-UNKNOWN local note.'));
    assert.equal(fakeCloud.requests.length, before);
  });
});

test('a pending card is void when the processing class changes; tool-results permission is per class', async () => {
  await withHarness(async (h) => {
    await local(h, 'MK-PENDING local note.');
    await h.provider.selectCloudModel('muse-spark-1.3');
    await h.provider.sendMessage('Pending.', 'chat', 'cloud');
    const card = cardOf(h.last()) as Card;
    await h.provider.selectCloudModel('muse-spark-1.3-contributor');
    h.send({ type: 'disclosureDecide', digest: card.digest, choice: 'include' });
    await h.waitFor((state) => /changed since this was shown\. Nothing was sent/.test(state.status));
    assert.equal(fakeCloud.requests.length, 0);
    // Tool results allowed for standard Agent runs do not carry over to contributor.
    await h.writeFile('data.txt', 'MK-TOOL-DATA\n');
    const standard = await meta(h, 'Agent standard.', 'muse-spark-1.3', 'include', 'agent', true);
    assert.equal(standard?.askToolResults, true);
    const contributor = await meta(h, 'Agent contributor.', 'muse-spark-1.3-contributor', 'none', 'agent');
    assert.equal(contributor?.askToolResults, true, 'asked again for the contributor class');
  });
});

// ----- The Meta API key -----

test('saving another key or clearing it voids every earlier answer and tool permission, also after a restart', async () => {
  await withHarness(async (h) => {
    await local(h, 'MK-KEY-ONE local note.');
    await meta(h, 'With key one.', 'muse-spark-1.3', 'include', 'agent', true);
    const threadId = h.last().activeThreadId as string;
    await h.provider.saveKey(KEY_TWO);
    let before = fakeCloud.requests.length;
    let card = await meta(h, 'With key two.', 'muse-spark-1.3', 'none', 'agent');
    assert.ok(card?.messages.some((entry) => entry.text === 'MK-KEY-ONE local note.'), 'the approval under key one does not apply to key two');
    assert.equal(card?.askToolResults, true, 'the tool permission was voided too');
    assert.equal(fakeCloud.requests.length, before);
    h.send({ type: 'disclosureDecide', digest: (card as Card).digest, choice: 'include', toolResults: false });
    await h.waitFor((state) => !state.running && fakeCloud.requests.length > before, 8000);
    // A restart keeps the revision: answers under key two still apply, nothing older does.
    const revision = h.memento.get(META_CREDENTIAL_KEY);
    h.createProvider();
    h.send({ type: 'openThread', threadId });
    await h.waitFor((state) => state.activeThreadId === threadId);
    assert.equal(h.memento.get(META_CREDENTIAL_KEY), revision);
    assert.equal(await meta(h, 'After restart, chat.', 'muse-spark-1.3', 'none'), null, 'key two answers persist');
    // Clearing the key voids them as well, and a restart does not bring them back.
    await h.provider.clearKey();
    h.secretValues.set('rameCode.metaModelApiKey', KEY_TWO);
    h.createProvider();
    h.send({ type: 'openThread', threadId });
    await h.waitFor((state) => state.activeThreadId === threadId);
    before = fakeCloud.requests.length;
    card = await meta(h, 'After clear.', 'muse-spark-1.3', 'none');
    assert.ok(card, 'asked again after the key was cleared, even with the same key back');
    assert.equal(fakeCloud.requests.length, before);
    // Nothing derived from a key is stored or shown.
    const stored = JSON.stringify([...h.memento.entries()]) + JSON.stringify(h.posted);
    for (const secret of [KEY_ONE, KEY_TWO, createHash('sha256').update(KEY_ONE).digest('hex'), createHash('sha256').update(KEY_TWO).digest('hex')]) {
      assert.equal(stored.includes(secret), false);
    }
    assert.match(String(h.memento.get(META_CREDENTIAL_KEY)), /^[0-9a-f]{32}$/);
    assert.equal((h.memento.get(CLOUD_DISCLOSURE_KEY) as { version: number }).version, 4);
  });
});

test('a key saved while a Meta Agent run is going stops it before anything more is sent', async () => {
  await withHarness(async (h) => {
    await h.writeFile('a.txt', 'alpha');
    let calls = 0;
    let saved = false;
    fakeCloud.handler = () => {
      calls += 1;
      if (calls === 1 && !saved) {
        saved = true;
        void h.provider.saveKey(KEY_TWO);
      }
      return Response.json({ choices: [{ message: { role: 'assistant', content: null, tool_calls: [{ id: `l${calls}`, type: 'function', function: { name: 'list_files', arguments: JSON.stringify({ dir: '', limit: 5 }) } }] }, finish_reason: 'tool_calls' }], usage: { prompt_tokens: 5, completion_tokens: 5, total_tokens: 10 } });
    };
    await meta(h, 'List files repeatedly.', 'muse-spark-1.3', 'include', 'agent', true);
    await h.waitFor((state) => !state.running, 8000);
    assert.equal(chatRequests(), 1, 'no model step after the key changed (saving a key also refreshes /models)');
    assert.match(h.last().status, /the Meta API key changed while it was running/);
  });
});

// ----- Local paths -----

test('Windows paths are scrubbed whatever the case or separator, UNC included, and similar paths are left alone', () => {
  const paths: Array<readonly [string, string]> = [
    ['C:\\Users\\Ana\\Projects\\shop', '<project folder>'],
    ['\\\\fileserver\\share\\team', '<project folder>'],
    ['C:\\Users\\Ana', '~'],
  ];
  const cases: Array<[string, string]> = [
    ['open C:\\Users\\Ana\\Projects\\shop\\src\\a.ts', 'open <project folder>\\src\\a.ts'],
    ['open c:/users/ana/projects/SHOP/src/a.ts', 'open <project folder>/src/a.ts'],
    ['json "C:\\\\Users\\\\Ana\\\\Projects\\\\shop\\\\a"', 'json "<project folder>\\\\a"'],
    ['unc \\\\FileServer\\Share\\Team\\docs', 'unc <project folder>\\docs'],
    ['unc //fileserver/share/team/docs', 'unc <project folder>/docs'],
    ['home C:\\USERS\\ANA\\.ssh\\config', 'home ~\\.ssh\\config'],
    ['similar C:\\Users\\Anabel\\notes', 'similar C:\\Users\\Anabel\\notes'],
    ['similar C:\\Users\\Ana\\Projects\\shopping\\x', 'similar ~\\Projects\\shopping\\x'],
    ['other D:\\Users\\Ana\\x', 'other D:\\Users\\Ana\\x'],
  ];
  for (const [input, expected] of cases) {
    assert.equal(scrubLocalPaths(input, paths), expected, input);
  }
  // POSIX paths stay case-sensitive and bounded.
  const posix: Array<readonly [string, string]> = [['/home/ana/shop', '<project folder>'], ['/home/ana', '~']];
  assert.equal(scrubLocalPaths('a /home/ana/shop/x b /home/anabel/y c /mnt/home/ana/z d /HOME/ANA/q', posix), 'a <project folder>/x b /home/anabel/y c /mnt/home/ana/z d /HOME/ANA/q');
});

// ----- Secret-like values -----

test('secret-like values: URL credentials and auth names are redacted, markers stay well formed; it is not infallible', () => {
  const cases: Array<[string, RegExp, string]> = [
    ['DATABASE_URL=postgres://app:MK-DB-PASS-123@db.local:5432/x', /postgres:\/\/app:\[redacted by RAME Code: [^\]]+\]@db\.local/, 'MK-DB-PASS-123'],
    ['custom-auth=MK-CUSTOM-AUTH-VALUE-99', /custom-auth=\[redacted by RAME Code: secret value\]/, 'MK-CUSTOM-AUTH-VALUE-99'],
    ['API_KEY=sk-ABCDEFGHIJKLMNOPQRSTUV', /^API_KEY=\[redacted by RAME Code: [^\]]+\]$/, 'sk-ABCDEFGHIJKLMNOPQRSTUV'],
    ['token: Bearer abcdefghijklmnopqrstuvwxyz012345', /^token: \[redacted by RAME Code: [^\]]+\]$/, 'abcdefghijklmnopqrstuvwxyz012345'],
    ['session_cookie: MK-SESSION-COOKIE-77', /session_cookie: \[redacted by RAME Code: secret value\]/, 'MK-SESSION-COOKIE-77'],
  ];
  for (const [input, shape, secret] of cases) {
    const result = redactSecrets(input);
    assert.match(result.text, shape, input);
    assert.equal(result.text.includes(secret), false, input);
    assert.equal((result.text.match(/\[redacted by RAME Code:/g) ?? []).length, (result.text.match(/\]/g) ?? []).length - (input.match(/\]/g) ?? []).length, `well formed: ${result.text}`);
  }
  assert.equal(redactSecrets('plain text, nothing secret here').text, 'plain text, nothing secret here');
  // A bare value with no telling name or shape is not recognised: the limitation is documented, not hidden.
  assert.equal(redactSecrets('the code is MK-BARE-VALUE-4242').text, 'the code is MK-BARE-VALUE-4242');
});

test('the card shows a Contributor note in both languages', () => {
  const html = buildViewHtml({ cspSource: 'c', scriptUri: 'main.js', styleUri: 'main.css', nonce: 'n', i18nUri: 'i18n.js', remoteUxUri: 'remoteUx.js' });
  assert.match(html, /<p id="disclosureContributor" class="hint" hidden>This is a Contributor model: under Meta's terms it may use what you send\./);
});
