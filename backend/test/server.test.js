const { test } = require('node:test');
const assert = require('node:assert/strict');
const { createApp } = require('../server');

async function serve(t, options = {}) {
  const server = createApp(options).listen(0, '127.0.0.1');
  await new Promise(resolve => server.once('listening', resolve));
  t.after(() => new Promise(resolve => { server.close(resolve); server.closeAllConnections(); }));
  return `http://127.0.0.1:${server.address().port}`;
}

function upload(body = 'sample', type = 'image/png', field = 'file') {
  const form = new FormData();
  form.append(field, new Blob([body], { type }), 'sample.png');
  return { method: 'POST', body: form };
}

const result = { text: 'hello', confidence: 91, pages: 1, page_results: [{ page: 1, text: 'hello', engine: 'tesseract' }] };

test('forwards a document and preserves OCR metadata', async t => {
  const url = await serve(t, { fetchImpl: async (url, options) => {
    assert.equal(url, 'http://127.0.0.1:8001/process');
    assert.equal(await options.body.get('file').text(), 'sample');
    return Response.json(result);
  } });
  const response = await fetch(`${url}/api/upload`, upload());
  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), { success: true, data: result, filename: 'sample.png' });
});

test('rejects empty, missing, oversized, unexpected, and unsupported files', async t => {
  const url = await serve(t, { maxFileSize: 8, fetchImpl: () => { throw new Error('Must not call OCR'); } });
  for (const [request, status] of [[upload(''), 400], [{ method: 'POST' }, 400], [upload('123456789'), 413], [upload('a', 'image/png', 'other'), 400], [upload('a', 'text/html'), 415]]) {
    const response = await fetch(`${url}/api/upload`, request);
    assert.equal(response.status, status);
    assert.equal(typeof (await response.json()).error, 'string');
  }
});

test('preserves safe OCR errors and converts internal errors', async t => {
  for (const status of [413, 415, 422, 429, 503, 504, 500]) {
    const url = await serve(t, { fetchImpl: async () => Response.json({ detail: 'Document could not be read.' }, { status }) });
    const response = await fetch(`${url}/api/upload`, upload());
    assert.equal(response.status, status === 500 ? 502 : status);
  }
});

test('reports a deadline and releases the concurrency slot', async t => {
  let calls = 0;
  const url = await serve(t, { timeoutMs: 20, maxConcurrent: 1, fetchImpl: async (_url, { signal }) => {
    if (++calls > 1) return Response.json(result);
    return new Promise((_resolve, reject) => signal.addEventListener('abort', () => reject(new Error('Aborted'))));
  } });
  assert.equal((await fetch(`${url}/api/upload`, upload())).status, 504);
  assert.equal((await fetch(`${url}/api/upload`, upload())).status, 200);
});

test('bounds concurrent uploads', async t => {
  let finish, started;
  const ready = new Promise(resolve => { started = resolve; });
  const url = await serve(t, { maxConcurrent: 1, fetchImpl: () => {
    started();
    return new Promise(resolve => { finish = () => resolve(Response.json(result)); });
  } });
  const first = fetch(`${url}/api/upload`, upload());
  await ready;
  const second = await fetch(`${url}/api/upload`, upload());
  assert.equal(second.status, 429);
  finish();
  assert.equal((await first).status, 200);
});

test('health exposes the stricter upload limit and unavailable status', async t => {
  const url = await serve(t, { maxFileSize: 100, fetchImpl: async () => Response.json({ status: 'ready', max_upload_bytes: 50 }) });
  assert.equal((await (await fetch(`${url}/api/health`)).json()).max_upload_bytes, 50);
  const down = await serve(t, { fetchImpl: async () => { throw new Error('Internal secret'); } });
  const response = await fetch(`${down}/api/health`);
  assert.equal(response.status, 503);
  assert.doesNotMatch(JSON.stringify(await response.json()), /secret/);
});

test('rejects malformed upstream success payloads', async t => {
  const url = await serve(t, { fetchImpl: async () => Response.json({ text: 'hello' }) });
  assert.equal((await fetch(`${url}/api/upload`, upload())).status, 502);
});
