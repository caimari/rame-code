/* Advisory and delegated Meta cards, and the Mission's remote-advice line.
 * Everything shown comes from the host; text is set with textContent only.
 * Approvals echo the exact digest the host showed. */
(function () {
  'use strict';

  var ES = {
    'Run this request with Spark — Spark directs the agent': 'Ejecutar esta petición con Spark — Spark dirige al agente',
    'Run this request with Spark': 'Ejecutar esta petición con Spark',
    'Run this request with Glimmer': 'Ejecutar esta petición con Glimmer',
    'Ask Spark for advice — Glimmer remains in control': 'Pedir consejo a Spark — Glimmer conserva el control',
    'Only this exact text is sent, once. Spark gets no tools and cannot change anything; Glimmer keeps proposing every action, which still needs your approval and must pass the tests. File contents are sent only if you include them below.':
      'Solo se envía este texto exacto, una vez. Spark no recibe herramientas y no puede cambiar nada; Glimmer sigue proponiendo cada acción, que sigue necesitando tu aprobación y debe pasar las pruebas. El contenido de ficheros solo se envía si lo incluyes abajo.',
    'Include exact file contents (optional)': 'Incluir el contenido exacto de ficheros (opcional)',
    'Files this run read': 'Ficheros que leyó esta ejecución',
    'Use the selected files': 'Usar los ficheros seleccionados',
    'Remote advice and causal recovery': 'Consejo remoto y recuperación causal',
    "Advice only: Glimmer keeps the tools. Sent only for a failing allowed test, with your request, the failing check and its exit code, the host's content-free record, and project decisions; never file contents, and never a delegated run.":
      'Solo consejo: Glimmer conserva las herramientas. Solo se envía ante una prueba permitida que falla, con tu petición, la comprobación que falla y su código de salida, el registro del host sin contenido y las decisiones del proyecto; nunca contenido de ficheros ni una ejecución delegada.',
    'Mode': 'Modo',
    'Advisory: Spark advises, Glimmer acts': 'Consejo: Spark aconseja, Glimmer actúa',
    'Delegated: Spark directs this one request': 'Delegado: Spark dirige solo esta petición',
    'Working model': 'Modelo que trabaja',
    'Consulted model': 'Modelo consultado',
    'Model': 'Modelo',
    'Tools': 'Herramientas',
    'Glimmer ({0}) proposes every action and RAME Code checks it; Spark gets no tools.': 'Glimmer ({0}) propone cada acción y RAME Code la comprueba; Spark no recibe herramientas.',
    'Spark proposes the tools; RAME Code checks each one with your {0} profile. No extra permissions.': 'Spark propone las herramientas; RAME Code comprueba cada una con tu perfil {0}. Sin permisos adicionales.',
    'Project': 'Proyecto',
    'Failing check': 'Comprobación que falla',
    'Data sent': 'Datos que se envían',
    'Data that may be sent': 'Datos que pueden enviarse',
    'Files authorized': 'Ficheros autorizados',
    'none': 'ninguno',
    'Attempts': 'Intentos',
    'none yet': 'ninguno todavía',
    '{0}; the last one failed: {1}': '{0}; el último falló: {1}',
    'Scope and budget': 'Alcance y presupuesto',
    'Permission profile': 'Perfil de permisos',
    'Approving sends it once': 'Aprobar lo envía una vez',
    'Sending…': 'Enviando…',
    'Dismissing…': 'Descartando…',
    'Starting…': 'Iniciando…',
    'Applying…': 'Aplicando…',
    'Why: the local run stopped because {0}.': 'Motivo: la ejecución local se detuvo porque {0}.',
    'Model: Meta {0} | {1} characters | Digest: {2} — one use.': 'Modelo: Meta {0} | {1} caracteres | Digest: {2} — un solo uso.',
    'The delegated run with Spark stopped: {0}. It was not retried and did not switch to Glimmer; {1} action(s) confirmed by RAME Code are kept.':
      'La ejecución delegada con Spark se detuvo: {0}. No se reintentó ni pasó a Glimmer; se conservan {1} acción(es) confirmadas por RAME Code.',
    'Muse Glimmer did not answer': 'Muse Glimmer no respondió',
    'The local request failed': 'La petición local falló',
    'Start Muse Glimmer': 'Iniciar Muse Glimmer',
    'Open runtime settings': 'Abrir ajustes del runtime',
    'The local server is not running or not reachable. Start it, or check its executable, model, and port in the runtime settings. A stopped server is not a reason to ask Spark for advice.':
      'El servidor local no está en marcha o no responde. Inícialo, o revisa su ejecutable, modelo y puerto en los ajustes del runtime. Un servidor detenido no es motivo para pedir consejo a Spark.',
    'Glimmer answered but the request could not complete. Check the runtime settings, or try again.':
      'Glimmer respondió pero la petición no pudo completarse. Revisa los ajustes del runtime o inténtalo de nuevo.',
    'Not available: cloud escalation is OFF in Settings.': 'No disponible: la escalada a la nube está desactivada en Ajustes.',
    'Not available: no Meta Model API key is stored.': 'No disponible: no hay ninguna clave de Meta Model API guardada.',
    'Not available: only an Agent request can be run with Spark.': 'No disponible: solo una petición de Agent puede ejecutarse con Spark.',
    'Nothing was sent or saved. To run it with Spark, choose Meta Model API in the runtime selector and send it again.':
      'No se envió ni se guardó nada. Para ejecutarla con Spark, elige Meta Model API en el selector de runtime y envíala de nuevo.',
    'Glimmer local · {0}': 'Glimmer local · {0}',
    'Meta API · {0}': 'Meta API · {0}',
    'connected': 'conectado',
    'configured': 'configurado',
    'stopped': 'parado',
    'not configured': 'sin configurar',
    'running': 'en marcha',
    'starting': 'iniciando',
    'Connected: it answered in this session. Configured: saved, not verified yet.': 'Conectado: respondió en esta sesión. Configurado: guardado, aún sin verificar.',
    'Remote advice': 'Consejo remoto',
    'Consultations remaining': 'Consultas restantes',
    'Bytes sent': 'Bytes enviados',
    '{0} of {1} · {2} remaining · at most {3} per request': '{0} de {1} · quedan {2} · como máximo {3} por petición',
    'Remote token budget': 'Presupuesto remoto de tokens',
    '{0} of {1} · {2} remaining · at most {3} output tokens per answer': '{0} de {1} · quedan {2} · como máximo {3} tokens de salida por respuesta',
    'Advisory limits (empty = default)': 'Límites del consejo (vacío = valor por defecto)',
    'Bytes per request, at most': 'Bytes por petición, como máximo',
    'Total bytes sent, at most': 'Bytes enviados en total, como máximo',
    'Output tokens per answer, at most': 'Tokens de salida por respuesta, como máximo',
    'Remote token budget (input + output), at most': 'Presupuesto remoto de tokens (entrada + salida), como máximo',
    'RAME Code refuses, before sending, any consultation that would exceed a limit, and never raises a limit by itself. Tokens are checked against an upper bound: the request bytes plus the output cap.':
      'RAME Code rechaza, antes de enviarla, cualquier consulta que superaría un límite, y nunca amplía un límite por sí mismo. Los tokens se comprueban contra una cota superior: los bytes de la petición más el tope de salida.',
    '{0} · {1} of {2} consultation(s) sent · {3} valid answer(s)': '{0} · {1} de {2} consulta(s) enviadas · {3} respuesta(s) válidas',
    'Blocker': 'Bloqueo',
    '{0} [{1}] since internal run {2} ({3})': '{0} [{1}] desde la ejecución interna {2} ({3})',
    'Causal state': 'Estado causal',
    'Last result': 'Último resultado',
    'Data classes allowed': 'Clases de datos permitidas',
    'Ask': 'Preguntar',
    'Safe auto': 'Auto seguro',
    'Workspace full': 'Workspace completo',
    // Category, state, and data-class words from the host.
    'authentication failed': 'falló la autenticación',
    'credit, balance, or quota exhausted': 'crédito, saldo o cuota agotados',
    'rate limited': 'límite de peticiones',
    'network error': 'error de red',
    'timed out': 'tiempo agotado',
    'cancelled': 'cancelada',
    'invalid or incomplete response': 'respuesta no válida o incompleta',
    'Meta returned an error': 'Meta devolvió un error',
    'unknown error': 'error desconocido',
    'open': 'abierto',
    'conditions-changed': 'condiciones cambiadas',
    'unrecoverable': 'irrecuperable',
    'normal: no consultation is waiting for its recovery': 'normal: ninguna consulta espera su recuperación',
    'restricted: advice was requested; only a passing host run of the original verifier restores it': 'restringido: se pidió consejo; solo una ejecución del host del verificador original que pase lo restablece',
    'unrecoverable: the original verifier can no longer run': 'irrecuperable: el verificador original ya no puede ejecutarse',
    'your request': 'tu petición',
    'why the local run stopped': 'por qué se detuvo la ejecución local',
    "the host's content-free record of the run": 'el registro del host sin contenido',
    'the failing check and its exit code': 'la comprobación que falla y su código de salida',
    'project decisions in force': 'las decisiones del proyecto en vigor',
    "this thread's recent messages": 'los mensajes recientes de este hilo',
    'the output of each tool it runs, including the contents of files it reads': 'la salida de cada herramienta que ejecute, incluido el contenido de los ficheros que lea',
    'this one request, up to 12 model steps': 'solo esta petición, hasta 12 pasos del modelo',
    'this one request, one reply': 'solo esta petición, una respuesta',
    // Host statuses, sentence by sentence.
    'Nothing was retried and nothing changed.': 'No se reintentó nada y no cambió nada.',
    'Continue with Glimmer, or approve the same text again to retry once.': 'Sigue con Glimmer, o aprueba el mismo texto otra vez para reintentar una vez.',
    'It was not retried and did not switch to Glimmer.': 'No se reintentó ni pasó a Glimmer.',
    'You can run this request with Glimmer.': 'Puedes ejecutar esta petición con Glimmer.',
    'That approval does not match a waiting delegated run. Nothing was sent.': 'Esa aprobación no corresponde a ninguna ejecución delegada en espera. No se envió nada.',
    'The model, permission profile, or project changed since this was offered. Nothing was sent; ask again.': 'El modelo, el perfil de permisos o el proyecto cambiaron desde que se ofreció. No se envió nada; vuelve a pedirlo.',
    'There is no failed delegated run to continue. Nothing ran.': 'No hay ninguna ejecución delegada fallida que continuar. No se ejecutó nada.',
    'A request is already running. Nothing ran.': 'Ya hay una petición en curso. No se ejecutó nada.',
    'Nothing was sent yet.': 'Todavía no se ha enviado nada.',
    'Review the exact text again: no file contents are included.': 'Revisa otra vez el texto exacto: no incluye contenido de ficheros.',
    'Review what would be sent to Meta': 'Revisa lo que se enviaría a Meta',
    'Meta {0} would receive these {1} message(s) from local sessions of this thread ({2} characters), exactly as shown, together with your new request. Older local messages are never sent.':
      'Meta {0} recibiría estos {1} mensaje(s) de sesiones locales de este hilo ({2} caracteres), exactamente como se muestran, junto con tu nueva petición. Los mensajes locales más antiguos nunca se envían.',
    "It would also receive this project's authorized decisions:": 'También recibiría las decisiones autorizadas de este proyecto:',
    'Meta {0} would receive this project\'s authorized decisions with your new request:': 'Meta {0} recibiría las decisiones autorizadas de este proyecto junto con tu nueva petición:',
    'Without it, Meta receives only your request, its own earlier replies and any messages you approved earlier, and what you keep local is not offered again. Tool results reach Meta only if you allow them.':
      'Sin él, Meta recibe solo tu petición, sus propias respuestas anteriores y los mensajes que aprobaste antes, y lo que mantengas en local no se vuelve a ofrecer. Los resultados de herramientas solo llegan a Meta si lo permites.',
    'Turn {0} · {1} · {2}': 'Turno {0} · {1} · {2}',
    'Agent sends earlier messages longer than 4,000 characters shortened: they are shown here exactly as sent, with the shortening marked.':
      'Agent envía recortados los mensajes anteriores de más de 4.000 caracteres: aquí se muestran exactamente como se envían, con el recorte señalado.',
    'you': 'tú',
    'reply': 'respuesta',
    'plan': 'plan',
    'Host record': 'Registro del host',
    'Send with this context': 'Enviar con este contexto',
    'Also let Meta receive tool results (file contents, searches, test output) in this thread until VS Code restarts. Values that look like secrets are redacted.':
      'Permitir también que Meta reciba resultados de herramientas (contenido de archivos, búsquedas, salida de pruebas) en este hilo hasta que reinicies VS Code. Los valores con aspecto de secreto se censuran.',
    'Stop sharing with Meta': 'Dejar de compartir con Meta',
    "This is a Contributor model: under Meta's terms it may use what you send. Approvals given for standard models do not apply to it.":
      'Es un modelo Contributor: según las condiciones de Meta puede usar lo que envíes. Las aprobaciones dadas para modelos estándar no se aplican a él.',
    'RAME Code stopped this request before sending more: the Meta API key changed while it was running, and its approvals belonged to the previous key. Nothing more was sent.':
      'RAME Code detuvo esta petición antes de enviar más: la clave de la API de Meta cambió mientras se ejecutaba y sus aprobaciones eran de la clave anterior. No se envió nada más.',
    'Also sent again, approved earlier: {0} message(s)': 'También se reenvían, aprobados antes: {0} mensaje(s)',
    'Meta {0} would receive {1} local message(s) of this thread you approved earlier, listed below, together with your new request.':
      'Meta {0} recibiría {1} mensaje(s) locales de este hilo que aprobaste antes, listados abajo, junto con tu nueva petición.',
    'Meta {0} would receive the output of the tools it runs in this Agent request only if you allow it below.':
      'Meta {0} solo recibiría la salida de las herramientas que ejecute en esta petición de Agent si lo permites abajo.',
    'Shared with Meta in this thread: {0} local message(s) · project decisions: {1} · tool results this session: {2}': 'Compartido con Meta en este hilo: {0} mensaje(s) locales · decisiones del proyecto: {1} · resultados de herramientas en esta sesión: {2}',
    'shared': 'compartidas',
    'withheld': 'retenidas',
    'not asked': 'sin preguntar',
    'allowed': 'permitidos',
    'not allowed': 'no permitidos',
    'Stopped sharing this thread with Meta: nothing more from its local sessions, its project decisions, or tool results is sent until you approve it again. What Meta already received cannot be recalled.':
      'Se dejó de compartir este hilo con Meta: no se envía nada más de sus sesiones locales, sus decisiones del proyecto ni resultados de herramientas hasta que lo vuelvas a aprobar. Lo que Meta ya recibió no se puede recuperar.',
    'A request is running. Stop it first; nothing was changed.': 'Hay una petición en curso. Detenla primero; no se cambió nada.',
    'Open a thread first.': 'Abre primero un hilo.',
    'Send without it': 'Enviar sin él',
    'Cancel': 'Cancelar',
    'Review what this request would send to Meta from your local sessions. Nothing was sent yet.': 'Revisa lo que esta petición enviaría a Meta desde tus sesiones locales. Todavía no se ha enviado nada.',
    'That review is no longer valid. Nothing was sent to Meta.': 'Esa revisión ya no es válida. No se envió nada a Meta.',
    'A request is already running. Nothing was sent to Meta.': 'Ya hay una petición en curso. No se envió nada a Meta.',
    'Cancelled. Nothing was sent to Meta.': 'Cancelado. No se envió nada a Meta.',
    'The thread, the project decisions, or the Meta model changed since this was shown. Nothing was sent; send the request again to review it.':
      'El hilo, las decisiones del proyecto o el modelo de Meta cambiaron desde que se mostró. No se envió nada; vuelve a enviar la petición para revisarlo.',
    'Meta Advisory': 'Asesoramiento de Meta',
    'Maximum consultations for this Mission': 'Máximo de consultas para esta Misión',
    'Maximum Meta consultations': 'Máximo de consultas a Meta',
    '0 — off': '0 — desactivado',
    'Advice only: Glimmer keeps every tool. Meta receives no file contents and cannot execute actions.': 'Solo consejo: Glimmer conserva todas las herramientas. Meta no recibe contenido de archivos ni puede ejecutar acciones.',
    'Advisory limits': 'Límites del asesoramiento',
    'Bytes per request, at most (empty = 12000)': 'Bytes máximos por petición (vacío = 12000)',
    'Total bytes sent, at most (empty = 12000 × consultations)': 'Bytes totales máximos enviados (vacío = 12000 × consultas)',
    'Output tokens per answer, at most (empty = 2048)': 'Tokens de salida máximos por respuesta (vacío = 2048)',
    'Remote token budget, at most (empty = 14048 × consultations)': 'Presupuesto remoto máximo de tokens (vacío = 14048 × consultas)',
    'RAME refuses before sending anything that would exceed these limits and never raises them itself.': 'RAME rechaza antes de enviar cualquier consulta que supere estos límites y nunca los amplía por sí solo.',
    'Selected: up to {0} Meta consultation(s) · {1} · {2}. Default limits: 12000 request bytes, 2048 output tokens per answer.': 'Seleccionado: hasta {0} consulta(s) a Meta · {1} · {2}. Límites predeterminados: 12000 bytes de petición y 2048 tokens de salida por respuesta.',
    'Unavailable: enable cloud escalation in Security.': 'No disponible: activa el escalado a la nube en Seguridad.',
    'Bootstrap Mission: this folder has no usable test setup yet. This authorization may create the project and tests, but cannot run them or complete the Mission. RAME Code will stop and ask you to review a second authorization.':
      'Misión de arranque: esta carpeta todavía no tiene pruebas utilizables. Esta autorización puede crear el proyecto y las pruebas, pero no puede ejecutarlas ni completar la Misión. RAME Code se detendrá y te pedirá revisar una segunda autorización.',
    'Scaffold ready: review the new package test command and test files below. Nothing will run until you authorize this verification stage.':
      'Estructura preparada: revisa abajo el nuevo comando de pruebas y sus archivos. No se ejecutará nada hasta que autorices esta fase de verificación.',
    'Unavailable: save a Meta API key in Models.': 'No disponible: guarda una clave de Meta API en Modelos.',
    'Standard': 'Estándar',
    'Contributor': 'Contributor',
  };

  var CATEGORY = {
    authentication: 'authentication failed',
    credit: 'credit, balance, or quota exhausted',
    'rate-limit': 'rate limited',
    network: 'network error',
    timeout: 'timed out',
    cancelled: 'cancelled',
    'invalid-response': 'invalid or incomplete response',
    'remote-error': 'Meta returned an error',
    unknown: 'unknown error',
  };
  var CAUSAL = {
    normal: 'normal: no consultation is waiting for its recovery',
    restricted: 'restricted: advice was requested; only a passing host run of the original verifier restores it',
    unrecoverable: 'unrecoverable: the original verifier can no longer run',
  };
  var PROFILES = { ask: 'Ask', 'safe-auto': 'Safe auto', 'workspace-full': 'Workspace full' };

  if (window.RAME_I18N && typeof window.RAME_I18N.extend === 'function') {
    window.RAME_I18N.extend('es', ES);
  }

  var h = null;
  var consultShown = null;
  var delegationShown = null;
  var chosen = {};
  var drawnFiles = '';
  var lastState = null;

  function el(id) {
    return document.getElementById(id);
  }

  function setText(node, value) {
    if (node) {
      node.textContent = value;
    }
  }

  function clear(node) {
    while (node && node.firstChild) {
      node.removeChild(node.firstChild);
    }
  }

  function fact(list, label, value) {
    if (!list || value === '' || value === null || value === undefined) {
      return;
    }
    var term = document.createElement('dt');
    term.textContent = label;
    var detail = document.createElement('dd');
    detail.textContent = String(value);
    list.appendChild(term);
    list.appendChild(detail);
  }

  function words(list) {
    return (list || []).map(function (item) {
      return h.t(item);
    }).join('; ');
  }

  function renderConsult(data) {
    var consult = data.consult && typeof data.consult.digest === 'string' ? data.consult : null;
    var extra = data.remote && data.remote.consult ? data.remote.consult : null;
    consultShown = consult;
    var box = el('consultBox');
    if (box) {
      box.hidden = consult === null;
    }
    setText(el('consultReason'), consult ? h.tf('Why: the local run stopped because {0}.', consult.reason) : '');
    // The payload is shown exactly as it would be sent, never translated.
    setText(el('consultPayload'), consult ? consult.payload : '');
    setText(el('consultMeta'), consult ? h.tf('Model: Meta {0} | {1} characters | Digest: {2} — one use.', consult.model, consult.payload.length, consult.digest.slice(0, 16)) : '');
    var facts = el('consultFacts');
    clear(facts);
    var result = el('consultResult');
    if (consult === null || extra === null) {
      if (result) {
        result.hidden = true;
      }
      return;
    }
    fact(facts, h.t('Mode'), h.t('Advisory: Spark advises, Glimmer acts'));
    fact(facts, h.t('Working model'), extra.localModel);
    fact(facts, h.t('Consulted model'), 'Meta ' + extra.model);
    fact(facts, h.t('Tools'), h.tf('Glimmer ({0}) proposes every action and RAME Code checks it; Spark gets no tools.', extra.localModel));
    fact(facts, h.t('Project'), extra.project);
    fact(facts, h.t('Failing check'), extra.verifier);
    fact(facts, h.t('Data sent'), words(extra.dataClasses));
    fact(facts, h.t('Files authorized'), extra.authorizedFiles.length > 0 ? extra.authorizedFiles.join(', ') : h.t('none'));
    fact(facts, h.t('Attempts'), extra.attempts === 0 ? h.t('none yet') : extra.lastFailure ? h.tf('{0}; the last one failed: {1}', extra.attempts, h.t(CATEGORY[extra.lastFailure])) : String(extra.attempts));
    if (result) {
      result.hidden = !extra.lastFailure;
      result.textContent = extra.lastFailure ? h.tf('{0}; the last one failed: {1}', extra.attempts, h.t(CATEGORY[extra.lastFailure])) : '';
    }
    var list = el('consultFiles');
    var key = extra.fileCandidates.join('\n') + '\u0000' + extra.authorizedFiles.join('\n');
    if (list && key !== drawnFiles && !list.contains(document.activeElement)) {
      drawnFiles = key;
      chosen = {};
      extra.authorizedFiles.forEach(function (file) {
        chosen[file] = true;
      });
      clear(list);
      extra.fileCandidates.forEach(function (file) {
        var label = document.createElement('label');
        var box = document.createElement('input');
        box.type = 'checkbox';
        box.checked = chosen[file] === true;
        box.addEventListener('change', function () {
          chosen[file] = box.checked;
        });
        label.appendChild(box);
        label.appendChild(document.createTextNode(' ' + file));
        list.appendChild(label);
      });
      var holder = el('consultFilesBox');
      if (holder) {
        holder.hidden = extra.fileCandidates.length === 0;
      }
    }
  }

  function renderDelegation(data) {
    var offer = data.remote && data.remote.delegation ? data.remote.delegation : null;
    var failure = data.remote && data.remote.delegationFailure ? data.remote.delegationFailure : null;
    var pending = Boolean(data.escalation && data.escalation.pending);
    delegationShown = pending ? offer : null;
    var box = el('escalationBox');
    if (box) {
      box.hidden = !(pending || failure);
    }
    setText(el('escalationReason'), pending ? h.tHost(data.escalation.reason || '') : '');
    var actions = el('escalationActions');
    if (actions) {
      actions.hidden = !pending;
    }
    var facts = el('escalationFacts');
    clear(facts);
    if (offer && pending) {
      fact(facts, h.t('Mode'), h.t('Delegated: Spark directs this one request'));
      fact(facts, h.t('Model'), 'Meta ' + offer.model);
      fact(facts, h.t('Tools'), h.tf('Spark proposes the tools; RAME Code checks each one with your {0} profile. No extra permissions.', h.t(PROFILES[offer.profile] || offer.profile)));
      fact(facts, h.t('Project'), offer.project || '');
      fact(facts, h.t('Scope and budget'), h.t(offer.budget));
      fact(facts, h.t('Data that may be sent'), words(offer.dataClasses));
    }
    var note = el('delegationFailure');
    if (note) {
      note.hidden = !failure;
      note.textContent = failure ? h.tf('The delegated run with Spark stopped: {0}. It was not retried and did not switch to Glimmer; {1} action(s) confirmed by RAME Code are kept.', h.t(CATEGORY[failure.category]), failure.confirmedActions) : '';
    }
    var local = el('delegationRunLocal');
    if (local) {
      local.hidden = !failure || failure.category === 'cancelled';
    }
  }

  var DELEGATION_WHY = {
    off: 'Not available: cloud escalation is OFF in Settings.',
    'no-key': 'Not available: no Meta Model API key is stored.',
    'not-agent': 'Not available: only an Agent request can be run with Spark.',
    'not-sent': 'Nothing was sent or saved. To run it with Spark, choose Meta Model API in the runtime selector and send it again.',
  };

  // A failed local request: local actions first. Delegation is offered by the
  // escalation card; here it is only shown disabled with its reason, and not
  // at all for a RAME Code internal run (a Mission or a verification run).
  function renderLocalIssue(data) {
    var issue = data.remote && data.remote.localIssue ? data.remote.localIssue : null;
    var box = el('localIssueBox');
    if (box) {
      box.hidden = issue === null;
    }
    if (issue === null) {
      return;
    }
    setText(el('local-issue-heading'), h.t(issue.kind === 'unreachable' ? 'Muse Glimmer did not answer' : 'The local request failed'));
    setText(
      el('localIssueHint'),
      h.t(
        issue.kind === 'unreachable'
          ? 'The local server is not running or not reachable. Start it, or check its executable, model, and port in the runtime settings. A stopped server is not a reason to ask Spark for advice.'
          : 'Glimmer answered but the request could not complete. Check the runtime settings, or try again.',
      ),
    );
    var start = el('localIssueStart');
    if (start) {
      start.hidden = !issue.canStart;
    }
    var why = DELEGATION_WHY[issue.delegation] || '';
    var delegate = el('localIssueDelegate');
    if (delegate) {
      // Nothing was stored to delegate: only the explanation is shown.
      delegate.hidden = why === '' || issue.delegation === 'not-sent';
      delegate.disabled = true;
      delegate.setAttribute('aria-describedby', 'localIssueDelegateWhy');
    }
    var note = el('localIssueDelegateWhy');
    if (note) {
      note.hidden = why === '';
      note.textContent = why ? h.t(why) : '';
    }
  }

  var disclosureShown = null;
  var ROLE = { user: 'you', assistant: 'reply', plan: 'plan' };

  function appendOffered(list, entry) {
    var item = document.createElement('li');
    var head = document.createElement('p');
    head.className = 'hint';
    head.textContent = h.tf('Turn {0} · {1} · {2}', entry.turn + 1, h.t(ROLE[entry.role] || entry.role), new Date(entry.at).toLocaleString());
    var body = document.createElement('pre');
    body.textContent = entry.text;
    item.appendChild(head);
    item.appendChild(body);
    if (entry.hostRecord.length > 0) {
      var record = document.createElement('pre');
      record.textContent = h.t('Host record') + ':\n' + entry.hostRecord.join('\n');
      item.appendChild(record);
    }
    list.appendChild(item);
  }

  // The Meta disclosure card: exactly what the request would add, as text only.
  function renderDisclosure(data) {
    var shown = data.remote && data.remote.disclosure ? data.remote.disclosure : null;
    disclosureShown = shown;
    var box = el('disclosureBox');
    if (box) {
      box.hidden = shown === null;
    }
    var list = el('disclosureMessages');
    var decisions = el('disclosureDecisions');
    var earlierList = el('disclosureEarlierMessages');
    clear(list);
    clear(decisions);
    clear(earlierList);
    if (shown === null) {
      return;
    }
    var hint = shown.messages.length > 0
      ? h.tf('Meta {0} would receive these {1} message(s) from local sessions of this thread ({2} characters), exactly as shown, together with your new request. Older local messages are never sent.', shown.model, shown.messages.length + shown.earlier.length, shown.chars)
      : shown.decisions.length > 0
        ? h.tf('Meta {0} would receive this project\'s authorized decisions with your new request:', shown.model)
        : shown.earlier.length > 0
          ? h.tf('Meta {0} would receive {1} local message(s) of this thread you approved earlier, listed below, together with your new request.', shown.model, shown.earlier.length)
          : h.tf('Meta {0} would receive the output of the tools it runs in this Agent request only if you allow it below.', shown.model);
    if (shown.mode === 'agent' && shown.messages.concat(shown.earlier).some(function (entry) { return entry.text.indexOf('…[RAME Code shortened this earlier message:') !== -1; })) {
      hint += ' ' + h.t('Agent sends earlier messages longer than 4,000 characters shortened: they are shown here exactly as sent, with the shortening marked.');
    }
    setText(el('disclosureHint'), hint);
    var earlierBox = el('disclosureEarlier');
    if (earlierBox) {
      earlierBox.hidden = shown.earlier.length === 0;
    }
    setText(el('disclosureEarlierSummary'), h.tf('Also sent again, approved earlier: {0} message(s)', shown.earlier.length));
    shown.earlier.forEach(function (entry) {
      appendOffered(earlierList, entry);
    });
    shown.messages.forEach(function (entry) {
      appendOffered(list, entry);
    });
    var decisionsNote = el('disclosureDecisionsNote');
    if (decisionsNote) {
      decisionsNote.hidden = shown.decisions.length === 0 || shown.messages.length === 0;
      decisionsNote.textContent = h.t("It would also receive this project's authorized decisions:");
    }
    shown.decisions.forEach(function (entry) {
      fact(decisions, entry.key + ' · v' + entry.version, JSON.stringify(entry.value));
    });
    var contributorNote = el('disclosureContributor');
    if (contributorNote) {
      contributorNote.hidden = !shown.contributor;
    }
    var toolsRow = el('disclosureToolsRow');
    if (toolsRow) {
      toolsRow.hidden = !shown.askToolResults;
    }
    var tools = el('disclosureTools');
    if (tools && tools.getAttribute('data-digest') !== shown.digest) {
      // A new card starts unchecked: the user opts in each time it is asked.
      tools.checked = false;
      tools.setAttribute('data-digest', shown.digest);
    }
    setText(el('disclosureWithholdHint'), h.t('Without it, Meta receives only your request, its own earlier replies and any messages you approved earlier, and what you keep local is not offered again. Tool results reach Meta only if you allow them.'));
  }

  // What the open thread shares with Meta now, and the way to stop it.
  function renderSharing(data) {
    var sharing = data.remote && data.remote.sharing ? data.remote.sharing : null;
    var line = el('disclosureSharing');
    if (line) {
      line.hidden = sharing === null;
    }
    if (sharing === null) {
      return;
    }
    setText(
      el('disclosureSharingText'),
      h.tf(
        'Shared with Meta in this thread: {0} local message(s) · project decisions: {1} · tool results this session: {2}',
        sharing.messages,
        h.t(sharing.decisions === null ? 'not asked' : sharing.decisions),
        h.t(sharing.toolResults === null ? 'not asked' : sharing.toolResults ? 'allowed' : 'not allowed'),
      ),
    );
  }

  function renderMissionRemote(live) {
    var list = el('missionRemote');
    clear(list);
    var remote = live && live.remote ? live.remote : null;
    if (list) {
      list.hidden = remote === null;
    }
    if (remote === null) {
      return;
    }
    if (remote.model) {
      fact(list, h.t('Remote advice'), h.tf('{0} · {1} of {2} consultation(s) sent · {3} valid answer(s)', 'Meta ' + remote.model, remote.attempts, remote.maxConsultations, remote.validResponses));
      fact(list, h.t('Consultations remaining'), String(Math.max(0, remote.maxConsultations - remote.attempts)));
      var limits = remote.limits;
      if (limits) {
        fact(list, h.t('Bytes sent'), h.tf('{0} of {1} · {2} remaining · at most {3} per request', limits.sentBytes, limits.maxTotalBytes, Math.max(0, limits.maxTotalBytes - limits.sentBytes), limits.maxRequestBytes));
        fact(list, h.t('Remote token budget'), h.tf('{0} of {1} · {2} remaining · at most {3} output tokens per answer', limits.usedTokens, limits.maxTotalTokens, Math.max(0, limits.maxTotalTokens - limits.usedTokens), limits.maxOutputTokens));
      }
      fact(list, h.t('Data classes allowed'), words(remote.dataClasses));
    }
    if (remote.blocker) {
      fact(list, h.t('Blocker'), h.tf('{0} [{1}] since internal run {2} ({3})', remote.blocker.commandId, remote.blocker.id, remote.blocker.sinceRun, h.t(remote.blocker.state)));
    }
    fact(list, h.t('Causal state'), h.t(CAUSAL[remote.causalState] || CAUSAL.normal));
    fact(list, h.t('Last result'), remote.lastResult ? h.tHost(remote.lastResult) : '');
  }

  var RUNTIME_WORDS = { 'not-configured': 'not configured' };

  // Both runtimes, the selected one in bold; never "connected" from a stored key alone.
  function renderRuntime(data) {
    var runtime = data.remote && data.remote.runtime ? data.remote.runtime : null;
    var local = el('runtimeBadgeLocal');
    var cloud = el('runtimeBadgeCloud');
    if (!runtime || !local || !cloud) {
      return;
    }
    local.textContent = h.tf('Glimmer local · {0}', h.t(RUNTIME_WORDS[runtime.local] || runtime.local));
    cloud.textContent = h.tf('Meta API · {0}', h.t(RUNTIME_WORDS[runtime.cloud] || runtime.cloud));
    local.setAttribute('data-state', runtime.local);
    cloud.setAttribute('data-state', runtime.cloud);
    local.setAttribute('data-selected', String(runtime.selected === 'local'));
    cloud.setAttribute('data-selected', String(runtime.selected === 'cloud'));
    var badge = el('runtimeBadge');
    if (badge) {
      badge.setAttribute('title', h.t('Connected: it answered in this session. Configured: saved, not verified yet.'));
    }
  }

  function renderMissionGrant(data) {
    lastState = data;
    var row = el('missionConsultRow');
    var count = el('missionConsults');
    var summary = el('missionConsultSummary');
    if (!row || !count || !summary) {
      return;
    }
    var available = data.allowCloudEscalation === true && data.hasKey === true;
    count.disabled = !available;
    var value = Number(count.value) || 0;
    var model = typeof data.cloudModel === 'string' ? data.cloudModel : 'muse-spark-1.3';
    var modelClass = /contrib/i.test(model) ? h.t('Contributor') : h.t('Standard');
    summary.textContent = available
      ? h.tf('Selected: up to {0} Meta consultation(s) · {1} · {2}. Default limits: 12000 request bytes, 2048 output tokens per answer.', value, model, modelClass)
      : h.t(data.allowCloudEscalation === true ? 'Unavailable: save a Meta API key in Models.' : 'Unavailable: enable cloud escalation in Security.');

    var live = data.missionLive && data.missionLive.threadId === data.activeThreadId ? data.missionLive : null;
    var setup = live && live.setup ? live.setup : null;
    var bootstrap = Boolean(setup && setup.bootstrap);
    var awaiting = Boolean(setup && setup.awaitingVerification);
    var note = el('missionBootstrapNote');
    var standard = el('missionLevelStandard');
    var verified = el('missionLevelVerified');
    var verifiedRow = el('missionVerifiedRow');
    if (verified) {
      verified.disabled = bootstrap;
    }
    if (bootstrap && standard) {
      standard.checked = true;
    }
    if (bootstrap && verified) {
      verified.checked = false;
    }
    if (bootstrap && verifiedRow) {
      verifiedRow.hidden = true;
    }
    if (note) {
      note.hidden = !(bootstrap || awaiting);
      note.textContent = bootstrap
        ? h.t('Bootstrap Mission: this folder has no usable test setup yet. This authorization may create the project and tests, but cannot run them or complete the Mission. RAME Code will stop and ask you to review a second authorization.')
        : awaiting
          ? h.t('Scaffold ready: review the new package test command and test files below. Nothing will run until you authorize this verification stage.')
          : '';
    }
  }

  function render(data) {
    if (h === null) {
      return;
    }
    renderRuntime(data);
    renderMissionGrant(data);
    renderConsult(data);
    renderDelegation(data);
    renderLocalIssue(data);
    renderDisclosure(data);
    renderSharing(data);
    renderMissionRemote(data.missionLive && data.missionLive.threadId === data.activeThreadId ? data.missionLive : null);
  }

  function on(id, handler) {
    var node = el(id);
    if (node) {
      node.addEventListener('click', function () {
        handler(node);
      });
    }
  }

  function init(helpers) {
    h = helpers;
    var consultations = el('missionConsults');
    if (consultations) {
      consultations.addEventListener('change', function () {
        if (lastState) {
          renderMissionGrant(lastState);
        }
      });
    }
    on('localIssueStart', function (btn) {
      if (h.markPending(btn, h.t('Starting…'))) {
        h.vscode.postMessage({ type: 'localIssueStart' });
      }
    });
    on('localIssueSettings', function () {
      if (typeof window.RAME_OPEN_SETTINGS_CARD === 'function') {
        window.RAME_OPEN_SETTINGS_CARD('cardRuntime');
      } else {
        h.vscode.postMessage({ type: 'navigate', screen: 'settings' });
      }
    });
    on('consultApprove', function (btn) {
      if (consultShown && h.markPending(btn, h.t('Sending…'))) {
        var dismiss = el('consultDismiss');
        if (dismiss && h.hold) {
          h.hold(dismiss);
        }
        h.vscode.postMessage({ type: 'consultApprove', digest: consultShown.digest });
      }
    });
    on('consultDismiss', function (btn) {
      if (consultShown && h.markPending(btn, h.t('Dismissing…'))) {
        h.vscode.postMessage({ type: 'consultDismiss' });
      }
    });
    on('consultIncludeFiles', function (btn) {
      var files = Object.keys(chosen).filter(function (file) {
        return chosen[file] === true;
      }).slice(0, 3);
      if (consultShown && h.markPending(btn, h.t('Applying…'))) {
        h.vscode.postMessage({ type: 'consultIncludeFiles', digest: consultShown.digest, files: files });
      }
    });
    on('escalateApprove', function (btn) {
      if (delegationShown && h.markPending(btn, h.t('Sending…'))) {
        h.vscode.postMessage({ type: 'escalateApprove', digest: delegationShown.digest });
      }
    });
    on('escalateDismiss', function () {
      h.vscode.postMessage({ type: 'escalateDismiss' });
    });
    ['include', 'withhold', 'cancel'].forEach(function (choice) {
      on('disclosure' + choice.charAt(0).toUpperCase() + choice.slice(1), function (btn) {
        if (disclosureShown && h.markPending(btn, h.t(choice === 'cancel' ? 'Dismissing…' : 'Sending…'))) {
          var tools = el('disclosureTools');
          var message = { type: 'disclosureDecide', digest: disclosureShown.digest, choice: choice };
          if (disclosureShown.askToolResults && choice !== 'cancel') {
            message.toolResults = !!(tools && tools.checked);
          }
          h.vscode.postMessage(message);
        }
      });
    });
    on('disclosureStop', function (btn) {
      if (h.markPending(btn, h.t('Applying…'))) {
        h.vscode.postMessage({ type: 'disclosureStop' });
      }
    });
    on('delegationRunLocal', function (btn) {
      if (h.markPending(btn, h.t('Starting…'))) {
        h.vscode.postMessage({ type: 'delegationRunLocal' });
      }
    });
  }

  var LIMIT_INPUTS = {
    maxRequestBytes: 'missionLimitRequestBytes',
    maxTotalBytes: 'missionLimitTotalBytes',
    maxOutputTokens: 'missionLimitOutputTokens',
    maxTotalTokens: 'missionLimitTotalTokens',
  };

  // The grant form's limits: an empty field keeps the host's default; the host checks the ranges.
  function advisoryLimits() {
    var chosen = {};
    Object.keys(LIMIT_INPUTS).forEach(function (key) {
      var input = el(LIMIT_INPUTS[key]);
      var raw = input ? String(input.value).trim() : '';
      var value = Number(raw);
      chosen[key] = raw !== '' && Number.isInteger(value) && value >= 0 && value <= 1000000 ? value : null;
    });
    return chosen;
  }

  window.RAME_REMOTE = { init: init, render: render, advisoryLimits: advisoryLimits, CATEGORY: CATEGORY, CAUSAL: CAUSAL };
})();
