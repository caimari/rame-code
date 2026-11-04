// RAME Code acceptance trace: registers the ESM resolve hook (Node >= 20.6).
// Without module.register, ESM loads are not traced and the host knows it
// from the "start" entry written by acceptance-trace.cjs.
import * as nodeModule from 'node:module';

if (process.env.RAME_TRACE_FILE && process.env.RAME_TRACE_ROOT && typeof nodeModule.register === 'function') {
  nodeModule.register('./acceptance-trace-hooks.mjs', import.meta.url);
}
