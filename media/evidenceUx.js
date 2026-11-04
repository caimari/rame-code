/* Model evidence inside Run details: what is configured, what runs, what
 * answered, and the host facts each answer links to. Everything shown comes
 * from the host (modelEvidence.ts); text is set with textContent only. */
(function () {
  'use strict';

  var ES = {
    'Model evidence — recorded by RAME Code': 'Evidencia del modelo — registrada por RAME Code',
    'Configured: {0} · context {1} · mmproj {2} · DFlash draft {3}': 'Configurado: {0} · contexto {1} · mmproj {2} · borrador DFlash {3}',
    'Configured: external endpoint · requested model id {0}': 'Configurado: endpoint externo · id de modelo solicitado {0}',
    'Configured: no local model': 'Configurado: ningún modelo local',
    'yes': 'sí',
    'no': 'no',
    'Running: llama-server launched by RAME · loopback · {0} · {1}': 'En ejecución: llama-server lanzado por RAME · loopback · {0} · {1}',
    'context {0} confirmed by /props': 'contexto {0} confirmado por /props',
    'context not confirmed': 'contexto sin confirmar',
    'Muse Glimmer template confirmed by /props': 'plantilla Muse Glimmer confirmada por /props',
    'template not confirmed': 'plantilla sin confirmar',
    'Running: OpenAI-compatible loopback endpoint — server/model identity not verified': 'En ejecución: endpoint loopback compatible con OpenAI — identidad del servidor/modelo no verificada',
    'Running: no': 'En ejecución: no',
    'Verified response: response observed in this session': 'Respuesta verificada: respuesta observada en esta sesión',
    'Verified response: none in this session': 'Respuesta verificada: ninguna en esta sesión',
    'Meta Model API: {0} · key {1} · response observed in this session: {2}': 'Meta Model API: {0} · clave {1} · respuesta observada en esta sesión: {2}',
    'stored': 'guardada',
    'not stored': 'no guardada',
    'The file name is what RAME passed to llama-server with -m; the weights are not verified cryptographically.':
      'El nombre de fichero es el que RAME pasó a llama-server con -m; los pesos no se verifican criptográficamente.',
    'Mission: {0}': 'Misión: {0}',
    'active': 'activa',
    'waiting for approval': 'esperando aprobación',
    'interrupted': 'interrumpida',
    'failed': 'fallida',
    'cancelled': 'cancelada',
    'Command passed: {0} exit=0': 'Comando superado: {0} exit=0',
    'Last command failed: {0} exit={1}': 'Último comando fallido: {0} exit={1}',
    'No command run recorded': 'No consta ningún comando ejecutado',
    'No frozen acceptance check': 'Sin comprobación de aceptación congelada',
    'Frozen acceptance passed: {0}': 'Aceptación congelada superada: {0}',
    'Frozen acceptance failed: {0}': 'Aceptación congelada fallida: {0}',
    'Frozen acceptance not run yet: {0}': 'Aceptación congelada aún sin ejecutar: {0}',
    'Frozen acceptance can no longer be trusted': 'La aceptación congelada ya no es fiable',
    'Mission completed by host': 'Misión completada por el host',
    'Mission not completed by host': 'Misión no completada por el host',
    'A passing command alone does not mean the goal was met.': 'Un comando superado no significa por sí solo que se cumpliera el objetivo.',
    'Inference #{0}': 'Inferencia n.º {0}',
    'Agent': 'Agent',
    'Chat': 'Chat',
    'Mission': 'Mission',
    'internal run {0}': 'ejecución interna {0}',
    'step {0}': 'paso {0}',
    'Provider: local llama-server': 'Proveedor: llama-server local',
    'Provider: OpenAI-compatible loopback endpoint': 'Proveedor: endpoint loopback compatible con OpenAI',
    'Provider: local (not running)': 'Proveedor: local (no en ejecución)',
    'Provider: Meta Model API': 'Proveedor: Meta Model API',
    'Configured model: {0}': 'Modelo configurado: {0}',
    'Requested model id: {0}': 'Id de modelo solicitado: {0}',
    'Model: {0}': 'Modelo: {0}',
    'Identity: {0}': 'Identidad: {0}',
    'RAME-launched process': 'proceso lanzado por RAME',
    'server/model identity not verified': 'identidad del servidor/modelo no verificada',
    'not running': 'no en ejecución',
    'response observed': 'respuesta observada',
    'running · no response observed': 'en ejecución · sin respuesta observada',
    'configured only · no response': 'solo configurado · sin respuesta',
    'Authority: Advisory — Glimmer retained tool control': 'Autoridad: Advisory — Glimmer conservó el control de las herramientas',
    'Authority: Delegated — Spark proposed tools; RAME applied the existing permission profile': 'Autoridad: Delegated — Spark propuso herramientas; RAME aplicó el perfil de permisos existente',
    'Authority: Meta selected as the runtime': 'Autoridad: Meta elegida como runtime',
    'Response observed: {0}': 'Respuesta observada: {0}',
    'Observed usage: {0} input · {1} output tokens': 'Uso observado: {0} tokens de entrada · {1} de salida',
    'Observed usage: not reported': 'Uso observado: no informado',
    'finish: {0}': 'fin: {0}',
    'Response: text': 'Respuesta: texto',
    'Response: text — the reply kept in the conversation': 'Respuesta: texto — la respuesta que queda en la conversación',
    'Response: proposed {0}': 'Respuesta: propuso {0}',
    'Response observed, refused by the host: {0}; nothing ran': 'Respuesta observada, rechazada por el host: {0}; no se ejecutó nada',
    'No response: {0}': 'Sin respuesta: {0}',
    'cut off at the output limit': 'cortada en el límite de salida',
    'malformed tool call': 'llamada a herramienta mal formada',
    'invalid tool arguments': 'argumentos de herramienta no válidos',
    'Tool call {0}: {1}': 'Llamada {0}: {1}',
    'No host action recorded': 'No consta ninguna acción del host',
    'approved by you': 'aprobada por ti',
    'allowed by the permission profile': 'permitida por el perfil de permisos',
    'allowed by the Mission grant': 'permitida por la autorización de la misión',
    'Host action: {0} and applied · digest {1}': 'Acción del host: {0} y aplicada · digest {1}',
    'Host action: {0} and ran · {1} exit={2} · digest {3}': 'Acción del host: {0} y ejecutada · {1} exit={2} · digest {3}',
    'Host action: {0}, but it did not run': 'Acción del host: {0}, pero no se ejecutó',
    'Host action: blocked by host policy; nothing ran': 'Acción del host: bloqueada por la política del host; no se ejecutó nada',
    'Host action: not proposed — the host refused to prepare it; nothing ran': 'Acción del host: no propuesta — el host se negó a prepararla; no se ejecutó nada',
    'Host action: rejected by you; nothing ran': 'Acción del host: rechazada por ti; no se ejecutó nada',
    'Host action: approval invalidated before running; nothing ran': 'Acción del host: aprobación invalidada antes de ejecutarse; no se ejecutó nada',
    'Checked afterwards in this run: {0} exit={1} (inference #{2})': 'Comprobado después en esta ejecución: {0} exit={1} (inferencia n.º {2})',
    'No linked verification recorded': 'No consta ninguna verificación enlazada',
    '{0} inference(s) recorded in this thread; decisive ones first.': '{0} inferencia(s) registradas en este hilo; primero las decisivas.',
    'No inference recorded in this thread yet.': 'Aún no consta ninguna inferencia en este hilo.',
    'Exploratory inferences ({0})': 'Inferencias exploratorias ({0})',
    '{0} older exploratory inference(s) not shown.': '{0} inferencia(s) exploratorias anteriores no se muestran.',
    'Some stored evidence was unreadable and was discarded; nothing was rebuilt or rerun.':
      'Parte de la evidencia guardada no se podía leer y se descartó; no se reconstruyó ni se volvió a ejecutar nada.',
    'Recovered context — recorded by RAME Code ({0})': 'Contexto recuperado — registrado por RAME Code ({0})',
    'No earlier context was recovered in this thread.': 'En este hilo no se ha recuperado contexto anterior.',
    'References only: each sha256 is of the exact stored text an excerpt was read from; the excerpts stay in the conversation.':
      'Solo referencias: cada sha256 es del texto guardado exacto del que se leyó un extracto; los extractos siguen en la conversación.',
    'Automatic recovery': 'Recuperación automática',
    'search_history requested by the model': 'search_history pedido por el modelo',
    'Mission plan': 'Plan de Mission',
    'Mission run': 'Ejecución de Mission',
    'internal run {0}': 'ejecución interna {0}',
    'Turn {0} · {1} · {2} · {3} · sha256 {4}': 'Turno {0} · {1} · {2} · {3} · sha256 {4}',
    'No matching excerpt.': 'Ningún extracto coincidente.',
    '{0} local message(s) not shared with Meta': '{0} mensaje(s) locales no compartidos con Meta',
    'user': 'usuario',
    'assistant': 'asistente',
    'plan': 'plan',
  };
  if (window.RAME_I18N && typeof window.RAME_I18N.extend === 'function') {
    window.RAME_I18N.extend('es', ES);
  }

  var FAILURE = { 'cut-off': 'cut off at the output limit', 'malformed-tool-call': 'malformed tool call', 'invalid-arguments': 'invalid tool arguments' };
  var STATUS = { active: 'active', waiting_approval: 'waiting for approval', interrupted: 'interrupted', completed: 'completed', failed: 'failed', paused: 'paused', cancelled: 'cancelled', blocked: 'blocked' };
  var APPROVAL = { human: 'approved by you', profile: 'allowed by the permission profile', 'mission-grant': 'allowed by the Mission grant' };

  function num(value, language) {
    return Number(value).toLocaleString(language === 'es' ? 'es-ES' : 'en-US');
  }

  function short(digest) {
    return digest ? digest.slice(0, 12) + '…' : '—';
  }

  /** The "now" lines: configured, running, verified response, Meta. */
  function nowLines(now, t, tf) {
    var out = [];
    var c = now.local.configured;
    if (c && c.kind === 'owned') {
      out.push(tf('Configured: {0} · context {1} · mmproj {2} · DFlash draft {3}', c.model, c.context === null ? '—' : c.context, t(c.projector ? 'yes' : 'no'), t(c.draft ? 'yes' : 'no')));
    } else if (c) {
      out.push(tf('Configured: external endpoint · requested model id {0}', c.model));
    } else {
      out.push(t('Configured: no local model'));
    }
    var r = now.local.running;
    if (r && r.kind === 'rame-launched') {
      out.push(tf('Running: llama-server launched by RAME · loopback · {0} · {1}',
        r.contextConfirmed === null ? t('context not confirmed') : tf('context {0} confirmed by /props', r.contextConfirmed),
        t(r.template === 'muse-glimmer' ? 'Muse Glimmer template confirmed by /props' : 'template not confirmed')));
    } else if (r) {
      out.push(t('Running: OpenAI-compatible loopback endpoint — server/model identity not verified'));
    } else {
      out.push(t('Running: no'));
    }
    out.push(t(now.local.observed ? 'Verified response: response observed in this session' : 'Verified response: none in this session'));
    out.push(tf('Meta Model API: {0} · key {1} · response observed in this session: {2}', now.cloud.model, t(now.cloud.keyStored ? 'stored' : 'not stored'), t(now.cloud.observed ? 'yes' : 'no')));
    out.push(t('The file name is what RAME passed to llama-server with -m; the weights are not verified cryptographically.'));
    return out;
  }

  function missionLines(m, t, tf) {
    var out = [tf('Mission: {0}', STATUS[m.status] ? t(STATUS[m.status]) : m.status)];
    var last = m.lastCommand;
    out.push(last === null ? t('No command run recorded') : last.exitCode === 0 ? tf('Command passed: {0} exit=0', last.commandId) : tf('Last command failed: {0} exit={1}', last.commandId, last.exitCode === null ? '?' : last.exitCode));
    var cmd = m.acceptanceCommand || '—';
    out.push(m.acceptance === 'none' ? t('No frozen acceptance check')
      : m.acceptance === 'passed' ? tf('Frozen acceptance passed: {0}', cmd)
      : m.acceptance === 'failed' ? tf('Frozen acceptance failed: {0}', cmd)
      : m.acceptance === 'tampered' ? t('Frozen acceptance can no longer be trusted')
      : tf('Frozen acceptance not run yet: {0}', cmd));
    out.push(t(m.completedByHost ? 'Mission completed by host' : 'Mission not completed by host'));
    out.push(t('A passing command alone does not mean the goal was met.'));
    return out;
  }

  function actionLines(call, seqOf, t, tf) {
    var a = call.action;
    var out = [];
    if (a === null) {
      out.push(t('No host action recorded'));
      return out;
    }
    var approval = a.approval ? t(APPROVAL[a.approval]) : '—';
    if (a.result === 'applied' && a.commandId !== null) {
      out.push(tf('Host action: {0} and ran · {1} exit={2} · digest {3}', approval, a.commandId, a.exitCode === null ? '?' : a.exitCode, short(a.digest)));
    } else if (a.result === 'applied') {
      out.push(tf('Host action: {0} and applied · digest {1}', approval, short(a.digest)));
    } else if (a.result === 'did-not-run') {
      out.push(tf('Host action: {0}, but it did not run', approval));
    } else {
      out.push(t({
        'blocked-by-policy': 'Host action: blocked by host policy; nothing ran',
        'not-proposed': 'Host action: not proposed — the host refused to prepare it; nothing ran',
        'rejected-by-user': 'Host action: rejected by you; nothing ran',
        'approval-invalidated': 'Host action: approval invalidated before running; nothing ran',
      }[a.result]));
    }
    if (a.write && a.result === 'applied') {
      var v = call.verification;
      out.push(v ? tf('Checked afterwards in this run: {0} exit={1} (inference #{2})', v.commandId, v.exitCode === null ? '?' : v.exitCode, seqOf(v.inferenceId)) : t('No linked verification recorded'));
    }
    return out;
  }

  /** One inference as lines: heading first, then indented facts. */
  function inferenceLines(e, language, t, tf) {
    var head = [tf('Inference #{0}', e.seq), t(e.mode === 'mission' ? 'Mission' : e.mode === 'chat' ? 'Chat' : 'Agent')];
    if (e.mission && e.mission.run !== null) {
      head.push(tf('internal run {0}', e.mission.run));
    }
    if (e.mission && e.mission.step !== null) {
      head.push(tf('step {0}', e.mission.step));
    }
    var out = [head.join(' · ')];
    var rt = e.runtime;
    var answered = e.identity === 'response-observed';
    if (e.provider === 'cloud') {
      out.push(t('Provider: Meta Model API'), tf('Model: {0}', rt.model));
      out.push(t(e.authority === 'advisory' ? 'Authority: Advisory — Glimmer retained tool control'
        : e.authority === 'delegated' ? 'Authority: Delegated — Spark proposed tools; RAME applied the existing permission profile'
        : 'Authority: Meta selected as the runtime'));
      out.push(tf('Response observed: {0}', t(answered ? 'yes' : 'no')));
    } else {
      out.push(t(rt.kind === 'rame-launched' ? 'Provider: local llama-server' : rt.kind === 'external-endpoint' ? 'Provider: OpenAI-compatible loopback endpoint' : 'Provider: local (not running)'));
      out.push(tf(rt.kind === 'external-endpoint' ? 'Requested model id: {0}' : 'Configured model: {0}', rt.model));
      var who = t(rt.kind === 'rame-launched' ? 'RAME-launched process' : rt.kind === 'external-endpoint' ? 'server/model identity not verified' : 'not running');
      var level = t(answered ? 'response observed' : e.identity === 'running' ? 'running · no response observed' : 'configured only · no response');
      out.push(tf('Identity: {0}', who + ' · ' + level));
    }
    var usage = e.usage ? tf('Observed usage: {0} input · {1} output tokens', num(e.usage.input, language), num(e.usage.output, language)) : t('Observed usage: not reported');
    out.push(e.finish ? usage + ' · ' + tf('finish: {0}', e.finish) : usage);
    if (e.response === 'tool-calls') {
      out.push(tf('Response: proposed {0}', e.toolCalls.map(function (c) { return c.tool; }).join(', ')));
    } else if (e.response === 'text') {
      out.push(t(e.final ? 'Response: text — the reply kept in the conversation' : 'Response: text'));
    } else if (e.response === 'invalid') {
      out.push(tf('Response observed, refused by the host: {0}; nothing ran', t(FAILURE[e.failure] || e.failure)));
    } else {
      out.push(tf('No response: {0}', e.failure));
    }
    return out;
  }

  /** Plain data for the view and for tests: every line already translated. */
  function format(ev, language, t, tf) {
    var all = ev.decisive.concat(ev.other);
    var seqOf = function (id) {
      var found = all.filter(function (e) { return e.inferenceId === id; })[0];
      return found ? found.seq : id.replace(/^inf-/, '');
    };
    var entry = function (e) {
      var lines = inferenceLines(e, language, t, tf);
      var calls = e.toolCalls.map(function (c) {
        return [tf('Tool call {0}: {1}', c.n, c.tool)].concat(actionLines(c, seqOf, t, tf));
      });
      return { lines: lines, calls: calls };
    };
    return {
      now: nowLines(ev.now, t, tf),
      mission: ev.mission ? missionLines(ev.mission, t, tf) : [],
      count: ev.total > 0 ? tf('{0} inference(s) recorded in this thread; decisive ones first.', ev.total) : t('No inference recorded in this thread yet.'),
      decisive: ev.decisive.slice().reverse().map(entry),
      other: ev.other.slice().reverse().map(entry),
      otherSummary: tf('Exploratory inferences ({0})', ev.other.length + ev.otherHidden),
      hidden: ev.otherHidden > 0 ? tf('{0} older exploratory inference(s) not shown.', ev.otherHidden) : '',
      discarded: ev.discarded ? t('Some stored evidence was unreadable and was discarded; nothing was rebuilt or rerun.') : '',
    };
  }

  function paragraphs(node, lines, cls) {
    lines.forEach(function (text) {
      var p = document.createElement('p');
      p.textContent = text;
      if (cls) {
        p.className = cls;
      }
      node.appendChild(p);
    });
  }

  function fill(list, entries) {
    while (list.firstChild) {
      list.removeChild(list.firstChild);
    }
    entries.forEach(function (item) {
      var li = document.createElement('li');
      paragraphs(li, item.lines.slice(0, 1), 'evidence-head');
      paragraphs(li, item.lines.slice(1), 'evidence-fact');
      item.calls.forEach(function (call) {
        paragraphs(li, call.slice(0, 1), 'evidence-call');
        paragraphs(li, call.slice(1), 'evidence-link');
      });
      list.appendChild(li);
    });
  }

  function render(data, helpers) {
    var box = document.getElementById('modelEvidence');
    if (!box || !data.modelEvidence) {
      return;
    }
    var view = format(data.modelEvidence, data.language, helpers.t, helpers.tf);
    ['modelEvidenceNow', 'modelEvidenceMission', 'modelEvidenceNote'].forEach(function (id) {
      var node = document.getElementById(id);
      while (node.firstChild) {
        node.removeChild(node.firstChild);
      }
    });
    paragraphs(document.getElementById('modelEvidenceNow'), view.now, 'evidence-fact');
    paragraphs(document.getElementById('modelEvidenceMission'), view.mission, 'evidence-fact');
    paragraphs(document.getElementById('modelEvidenceNote'), [view.count, view.hidden, view.discarded].filter(Boolean), 'hint');
    fill(document.getElementById('modelEvidenceList'), view.decisive);
    fill(document.getElementById('modelEvidenceOtherList'), view.other);
    var other = document.getElementById('modelEvidenceOther');
    other.hidden = view.other.length === 0;
    document.getElementById('modelEvidenceOtherSummary').textContent = view.otherSummary;
  }

  /** The same translation the main script uses: the Spanish table when the host's language is "es". */
  function helpersFor(language) {
    var t = function (text) {
      return language === 'es' && window.RAME_I18N ? window.RAME_I18N.translate('es', text) : text;
    };
    var tf = function (template) {
      var args = Array.prototype.slice.call(arguments, 1);
      return t(template).replace(/\{(\d+)\}/g, function (whole, index) {
        return Number(index) < args.length ? String(args[Number(index)]) : whole;
      });
    };
    return { t: t, tf: tf };
  }

  // Rendered from the host's state message itself, so the legacy main script is unchanged.
  if (typeof window.addEventListener === 'function') {
    window.addEventListener('message', function (event) {
      var data = event.data;
      if (data && typeof data === 'object' && data.type === 'state' && data.modelEvidence) {
        render(data, helpersFor(data.language === 'es' ? 'es' : 'en'));
      }
    });
  }

  var TRIGGER = { automatic: 'Automatic recovery', search_history: 'search_history requested by the model' };
  var MODE = { chat: 'Chat', agent: 'Agent', 'mission-plan': 'Mission plan', 'mission-run': 'Mission run' };

  /** The recovered-context log as lines: references and hashes only, never the excerpts. */
  function formatLog(log, t, tf) {
    var events = (log && log.events ? log.events : []).slice().reverse().map(function (e) {
      var head = [t(TRIGGER[e.trigger]), t(MODE[e.mode]), (e.provider === 'cloud' ? 'Meta ' : '') + e.model, new Date(e.at).toLocaleString()];
      if (e.mission && e.mission.run !== null) {
        head.push(tf('internal run {0}', e.mission.run));
      }
      var lines = e.sources.map(function (s) {
        return tf('Turn {0} · {1} · {2} · {3} · sha256 {4}', s.turn + 1, t(s.role), new Date(s.at).toLocaleString(), s.match, s.sha256.slice(0, 16) + '…');
      });
      if (lines.length === 0) {
        lines.push(t('No matching excerpt.'));
      }
      if (e.withheldLocal > 0) {
        lines.push(tf('{0} local message(s) not shared with Meta', e.withheldLocal));
      }
      return { head: head.join(' · '), lines: lines };
    });
    return {
      summary: tf('Recovered context — recorded by RAME Code ({0})', log && log.total ? log.total : 0),
      note: events.length > 0 ? t('References only: each sha256 is of the exact stored text an excerpt was read from; the excerpts stay in the conversation.') : t('No earlier context was recovered in this thread.'),
      events: events,
    };
  }

  function renderLog(data, helpers) {
    var list = document.getElementById('recoveryLogList');
    if (!list) {
      return;
    }
    var view = formatLog(data.continuityLog, helpers.t, helpers.tf);
    document.getElementById('recoveryLogSummary').textContent = view.summary;
    document.getElementById('recoveryLogNote').textContent = view.note;
    while (list.firstChild) {
      list.removeChild(list.firstChild);
    }
    view.events.forEach(function (event) {
      var li = document.createElement('li');
      paragraphs(li, [event.head], 'evidence-head');
      paragraphs(li, event.lines, 'evidence-link');
      list.appendChild(li);
    });
  }

  if (typeof window.addEventListener === 'function') {
    window.addEventListener('message', function (event) {
      var data = event.data;
      if (data && typeof data === 'object' && data.type === 'state' && data.continuityLog) {
        renderLog(data, helpersFor(data.language === 'es' ? 'es' : 'en'));
      }
    });
  }

  window.RAME_EVIDENCE = { render: render, format: format, formatLog: formatLog, helpersFor: helpersFor };
})();
