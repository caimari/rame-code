import assert from 'node:assert/strict';
import test from 'node:test';

import {
  buildLlamaServerArgs,
  initialLocalRuntimeStatus,
  isLoopbackUrl,
  LOCAL_RUNTIME_SUGGESTIONS,
  loopbackEndpoint,
  nextLocalRuntimeStatus,
  sanitizeDiagnostics,
  STARTUP_TIMEOUT_MS,
  validateLocalSettings,
} from '../src/localRuntime.js';

const VALID = {
  executablePath: '/workspace/src/llama.cpp-oficial/build/bin/llama-server',
  modelPath: '/disco4tb/catalogo-llm/meta/model.gguf',
  projectorPath: '',
  draftModelPath: '',
  modelId: 'local-glimmer',
  contextSize: 32768,
  port: 8775,
  idleTimeoutSec: 600,
};

test('suggestions carry the detected machine paths and loopback port', () => {
  assert.equal(
    LOCAL_RUNTIME_SUGGESTIONS.executablePath,
    '/workspace/src/llama.cpp-oficial/build/bin/llama-server',
  );
  assert.match(LOCAL_RUNTIME_SUGGESTIONS.modelPath, /Muse-Glimmer-30B/);
  assert.match(LOCAL_RUNTIME_SUGGESTIONS.projectorPath, /mmproj/);
  assert.match(LOCAL_RUNTIME_SUGGESTIONS.draftModelPath, /dflash/);
  assert.equal(LOCAL_RUNTIME_SUGGESTIONS.port, 8775);
  assert.equal(LOCAL_RUNTIME_SUGGESTIONS.contextSize, 32768);
  assert.equal(STARTUP_TIMEOUT_MS, 180000);
});

test('builds a direct-spawn argument array bound to 127.0.0.1', () => {
  const args = buildLlamaServerArgs(VALID);
  assert.deepEqual(args, [
    '--host',
    '127.0.0.1',
    '--port',
    '8775',
    '-m',
    '/disco4tb/catalogo-llm/meta/model.gguf',
    '-c',
    '32768',
  ]);
  // No shell concatenation: every element is a separate argument.
  assert.ok(
    args.every((entry) => !/[;&|`$]/.test(entry)),
  );
  assert.equal(loopbackEndpoint(8775), 'http://127.0.0.1:8775');

  const withOptional = buildLlamaServerArgs({
    ...VALID,
    projectorPath: '/models/mmproj.gguf',
    draftModelPath: '/models/draft.gguf',
  });
  assert.deepEqual(withOptional.slice(-4), [
    '--mmproj',
    '/models/mmproj.gguf',
    '--model-draft',
    '/models/draft.gguf',
  ]);
});

test('validates paths and numeric ranges strictly', () => {
  // POSIX fixtures; the win32 rules are covered in windows-support.test.ts.
  assert.equal(validateLocalSettings(VALID, 'linux').ok, true);
  assert.equal(
    validateLocalSettings({ ...VALID, executablePath: 'relative/bin' }, 'linux').error,
    'The llama-server executable path must be an absolute path.',
  );
  assert.equal(validateLocalSettings({ ...VALID, modelPath: '' }, 'linux').ok, false);
  assert.equal(
    validateLocalSettings({ ...VALID, projectorPath: 'relative.mmproj' }, 'linux').ok,
    false,
  );
  assert.equal(validateLocalSettings({ ...VALID, contextSize: 512 }, 'linux').ok, false);
  assert.equal(
    validateLocalSettings({ ...VALID, contextSize: 999999 }, 'linux').ok,
    false,
  );
  assert.equal(validateLocalSettings({ ...VALID, port: 0 }, 'linux').ok, false);
  assert.equal(validateLocalSettings({ ...VALID, port: 70000 }, 'linux').ok, false);
  assert.equal(
    validateLocalSettings({ ...VALID, idleTimeoutSec: -1 }, 'linux').ok,
    false,
  );
  assert.equal(validateLocalSettings(null, 'linux').ok, false);
  assert.equal(validateLocalSettings({ ...VALID, modelId: '  ' }, 'linux').ok, false);
});

test('loopback enforcement keeps the server off the network', () => {
  assert.equal(isLoopbackUrl('http://127.0.0.1:8775'), true);
  assert.equal(isLoopbackUrl('http://localhost:8080/v1'), true);
  assert.equal(
    isLoopbackUrl('http://127.0.0.1:8775/v1/chat/completions'),
    true,
  );
  assert.equal(isLoopbackUrl('http://0.0.0.0:8775'), false);
  assert.equal(isLoopbackUrl('http://192.168.1.10:8775'), false);
  assert.equal(isLoopbackUrl('https://example.com:443'), false);
  assert.equal(isLoopbackUrl('not-a-url'), false);
  assert.equal(isLoopbackUrl('ftp://127.0.0.1:21'), false);
});

test('lifecycle transitions track ownership; external endpoints are never owned', () => {
  let status = initialLocalRuntimeStatus();
  assert.equal(status.lifecycle, 'stopped');
  assert.equal(status.owned, false);

  status = nextLocalRuntimeStatus(status, {
    kind: 'start-requested',
    endpoint: 'http://127.0.0.1:8775',
  });
  assert.equal(status.lifecycle, 'starting');
  assert.equal(status.owned, true);

  // A second start while starting changes nothing.
  assert.deepEqual(
    nextLocalRuntimeStatus(status, {
      kind: 'start-requested',
      endpoint: 'http://127.0.0.1:8776',
    }),
    status,
  );

  status = nextLocalRuntimeStatus(status, {
    kind: 'started',
    endpoint: 'http://127.0.0.1:8775',
  });
  assert.equal(status.lifecycle, 'running');

  status = nextLocalRuntimeStatus(status, { kind: 'stop-requested' });
  assert.equal(status.lifecycle, 'stopping');
  // Ownership survives until the child actually exits.
  assert.equal(status.owned, true);

  status = nextLocalRuntimeStatus(status, { kind: 'stopped' });
  assert.deepEqual(status, initialLocalRuntimeStatus());

  // Health failure releases ownership so nothing is killed later.
  const failed = nextLocalRuntimeStatus(
    nextLocalRuntimeStatus(initialLocalRuntimeStatus(), {
      kind: 'start-requested',
      endpoint: 'http://127.0.0.1:8775',
    }),
    { kind: 'health-failed' },
  );
  assert.equal(failed.lifecycle, 'stopped');
  assert.equal(failed.owned, false);

  // Selecting an external server never marks it owned.
  const external = nextLocalRuntimeStatus(initialLocalRuntimeStatus(), {
    kind: 'external-selected',
    endpoint: 'http://127.0.0.1:9999',
  });
  assert.equal(external.owned, false);
  assert.equal(external.endpoint, 'http://127.0.0.1:9999');
});

test('diagnostics are bounded, sanitized, and tail-only', () => {
  assert.equal(sanitizeDiagnostics([]), '');
  const lines = Array.from({ length: 10 }, (_, index) => `line-${index}`);
  const sanitized = sanitizeDiagnostics(lines);
  assert.doesNotMatch(sanitized, /line-0/);
  assert.match(sanitized, /line-9/);
  assert.ok(sanitized.length <= 2000);
  // Control characters are stripped; visible text survives.
  const withControl = sanitizeDiagnostics(['ab\u0000cd\u0007ef']);
  assert.equal(withControl, 'abcdef');
  const long = sanitizeDiagnostics([`z${'y'.repeat(5000)}`]);
  assert.ok(long.length <= 2000);
});
