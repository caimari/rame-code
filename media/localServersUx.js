/* External model servers (Ollama, LM Studio, llama-server) and web access
 * settings. Everything shown comes from the host (state.remote.servers);
 * text is set with textContent only. Loaded after remoteUx.js: it wraps
 * RAME_REMOTE.init/render so main.js needs no change. */
(function () {
  'use strict';

  var ES = {
    'Model servers: Ollama, LM Studio, llama-server': 'Servidores de modelos: Ollama, LM Studio, llama-server',
    'Use a model server you run yourself. RAME connects to it and never starts or stops it. LM Studio and llama-server can serve Muse Glimmer.':
      'Usa un servidor de modelos que ejecutas tú. RAME se conecta a él y nunca lo arranca ni lo para. LM Studio y llama-server pueden servir Muse Glimmer.',
    'Server address': 'Dirección del servidor',
    'Ollama (11434)': 'Ollama (11434)',
    'LM Studio (1234)': 'LM Studio (1234)',
    'Find models': 'Buscar modelos',
    'Model': 'Modelo',
    'This server is another computer of my network: send it my prompts, history and project content':
      'Este servidor es otro ordenador de mi red: enviarle mis peticiones, el historial y el contenido del proyecto',
    'Use this model': 'Usar este modelo',
    'Web access': 'Acceso web',
    'Allow Agent and Chat to search and read public web pages (read-only)': 'Permitir que el Agente y el Chat busquen y lean páginas web públicas (solo lectura)',
    'Search with': 'Buscar con',
    'DuckDuckGo (no key)': 'DuckDuckGo (sin clave)',
    'My SearXNG': 'Mi SearXNG',
    'SearXNG address (JSON format enabled)': 'Dirección de SearXNG (con formato JSON activado)',
    'Save web access': 'Guardar acceso web',
    'Default OFF. Agent and Chat, local model only; a Mission has its own web permission, chosen when you authorize it. Each search or page read is shown and waits for your approval in Chat and, except in Workspace full, in Agent. Local and private addresses are refused, and a query or URL with a key or a file path is not sent. Page text is untrusted data, never instructions.':
      'Desactivado por defecto. Agente y Chat, solo con un modelo local; una Misión tiene su propio permiso web, que eliges al autorizarla. Cada búsqueda o lectura se muestra y espera tu aprobación en Chat y, salvo en Workspace full, en el Agente. Se rechazan las direcciones locales y privadas, y no se envía una consulta o URL con una clave o una ruta de fichero. El texto de las páginas es un dato no confiable, nunca instrucciones.',
    'Find models first.': 'Busca primero los modelos.',
    'Web access for this Mission': 'Acceso web para esta Misión',
    'Allow this Mission to search the web and read pages (read-only)': 'Permitir que esta Misión busque en la web y lea páginas (solo lectura)',
    'Searches, at most': 'Búsquedas, como máximo',
    'Page reads, at most': 'Lecturas de páginas, como máximo',
    'Authorized domains for page reads (optional; for example nodejs.org, docs.python.org)': 'Dominios autorizados para leer páginas (opcional; por ejemplo nodejs.org, docs.python.org)',
    'nodejs.org, docs.python.org': 'nodejs.org, docs.python.org',
    "Default OFF. Local model only. Within this budget an autonomous Mission searches and reads without asking each time; a supervised Mission still asks. Queries leave this computer: plain words only, never code, keys or file paths, and the host counts and records every request. Pages are read only from this Mission's own search results, or only from the domains above if you list some. 15 s and 2 MiB per page. Web access adds no write, terminal, memory or file permission, and web text is never sent to Meta.":
      'Desactivado por defecto. Solo con un modelo local. Dentro de este presupuesto, una Misión autónoma busca y lee sin preguntar cada vez; una Misión supervisada sigue preguntando. Las consultas salen de este ordenador: solo palabras normales, nunca código, claves ni rutas de ficheros, y el host cuenta y registra cada petición. Solo se leen páginas que devolvieron las búsquedas de esta Misión o, si indicas dominios, solo de esos dominios. 15 s y 2 MiB por página. El acceso web no añade permisos de escritura, terminal, memoria ni ficheros, y el texto web nunca se envía a Meta.',
    'Terminal commands': 'Comandos de terminal',
    'Agent works only inside the active workspace. Symlink and path escapes are blocked; .git, .env files, credential and key material, secret stores, auth files, and repository control files are protected. Tests run only from an exact derived allowlist with shell:false; arbitrary commands run only through the optional terminal tool (OFF by default), each shown first; allowlisted package scripts still execute with your OS permissions and may access files, network, or shells. Ask and Safe-auto require approval before they run, while Workspace-full may run them without prompting and is high risk. Cloud work needs your existing escalation consent and never switches providers silently. Tamper resistance is not claimed.':
      'El Agente trabaja solo dentro del workspace activo. Se bloquean las salidas por enlaces simbólicos y rutas; .git, los ficheros .env, credenciales y claves, almacenes de secretos, ficheros de autenticación y de control del repositorio están protegidos. Las pruebas solo se ejecutan desde una lista exacta derivada, con shell:false; los comandos arbitrarios solo pasan por la herramienta opcional de terminal (desactivada por defecto), que muestra cada uno antes; los scripts permitidos siguen ejecutándose con tus permisos del sistema y pueden acceder a ficheros, red o shells. Preguntar y Auto seguro piden aprobación antes de ejecutarlos; Acceso total puede ejecutarlos sin preguntar y es de alto riesgo. El trabajo en la nube necesita tu consentimiento de escalado y nunca cambia de proveedor en silencio. No se afirma resistencia a manipulaciones.',
    'Allow Agent to run terminal commands (bash, sh or PowerShell) in the project folder': 'Permitir que el Agente ejecute comandos de terminal (bash, sh o PowerShell) en la carpeta del proyecto',
    'Save terminal access': 'Guardar acceso a terminal',
    'Default OFF. Only with a local model, and never in Mission runs. You see each command exactly before it runs and approve it, in every profile, Workspace full included. The card warns when a line chains commands, runs a script you cannot see, uses sudo or the network, or installs software, but a command line never shows all its effects. A command runs with your permissions: it can change any file, use the network or install software. There is no sandbox. Time and output are limited. Stop signals the command and its normal process group, but a deliberately detached process may survive.':
      'Desactivado por defecto. Solo con un modelo local y nunca en las ejecuciones de una Misión. Ves cada comando exacto antes de que se ejecute y lo apruebas, en todos los perfiles, también en Workspace full. La tarjeta avisa cuando una línea encadena comandos, ejecuta un script que no ves, usa sudo o la red, o instala programas, pero una línea de comandos nunca muestra todos sus efectos. Un comando se ejecuta con tus permisos: puede cambiar cualquier fichero, usar la red o instalar programas. No hay sandbox. El tiempo y la salida están limitados. Detener señala el comando y su grupo normal de procesos, pero un proceso desacoplado deliberadamente puede sobrevivir.',
    'In use: {0} on {1}.': 'En uso: {0} en {1}.',
    'No external model server in use.': 'No se usa ningún servidor de modelos externo.',
    'tools': 'herramientas',
    'no tools': 'sin herramientas',
    'vision (RAME sends no images yet)': 'visión (RAME aún no envía imágenes)',
    'loaded': 'cargado',
    'context {0}': 'contexto {0}',
    '{0} at {1}: {2} model(s).': '{0} en {1}: {2} modelo(s).',
    'another computer of your network': 'otro ordenador de tu red',
    'Supports tool calls: Chat, Agent and Mission.': 'Admite llamadas a herramientas: Chat, Agente y Misión.',
    'This model does not support tool calls: use it in Chat only.': 'Este modelo no admite llamadas a herramientas: úsalo solo en Chat.',
    'The server does not say whether this model supports tool calls; Agent will stop with a clear message if it cannot call tools.':
      'El servidor no dice si este modelo admite herramientas; el Agente se detendrá con un mensaje claro si no puede llamarlas.',
    'Review': 'Revisar',
    'Mission: autonomous': 'Misión: autónoma',
    'Mission: supervised': 'Misión: supervisada',
    'Mission: not authorized yet': 'Misión: aún sin autorizar',
    "This Mission uses its own authorization (its card), not Agent's permission profile.": 'Esta Misión usa su propia autorización (su tarjeta), no el perfil de permisos del Agente.',
    'Task {0} of {1}: {2}': 'Tarea {0} de {1}: {2}',
    'Authorization needed: the Mission is waiting for you to review and start it.': 'Autorización necesaria: la Misión espera a que la revises e inicies.',
    'Authorization needed — stage 1 of 2: create the project files (no test runs yet).': 'Autorización necesaria — fase 1 de 2: crear los ficheros del proyecto (aún no se ejecutan pruebas).',
    'Authorization needed — stage 2 of 2: run the new tests. Stage 1 is done.': 'Autorización necesaria — fase 2 de 2: ejecutar las pruebas nuevas. La fase 1 ya está hecha.',
    'Authorize stage 1 of 2: create the files': 'Autorizar fase 1 de 2: crear los ficheros',
    'Authorize stage 2 of 2: run the tests and continue': 'Autorizar fase 2 de 2: ejecutar las pruebas y continuar',
    'Compute SHA-256 of the model file': 'Calcular el SHA-256 del fichero del modelo',
    'Cancel': 'Cancelar',
    'Reads the GGUF on this computer in blocks; the hash is kept for this session and stops applying if the file changes. It proves the bytes of that file, not what an external server runs.':
      'Lee el GGUF de este ordenador por bloques; el hash se conserva en esta sesión y deja de valer si el fichero cambia. Prueba los bytes de ese fichero, no lo que ejecuta un servidor externo.',
    'Check server identity': 'Comprobar la identidad del servidor',
    'SHA-256 of {0}: {1}': 'SHA-256 de {0}: {1}',
    'Computing… {0}%': 'Calculando… {0}%',
    'Not valid any more: {0}': 'Ya no es válido: {0}',
    '{0} · {1} · requested {2} · loaded {3} — as the server reports it; not a proof of the weights': '{0} · {1} · solicitado {2} · cargado {3} — según el servidor; no prueba los pesos',
    'not reported': 'no informado',
    'the server did not answer identity requests': 'el servidor no respondió a las consultas de identidad',
    'Local model (Glimmer)': 'Modelo local (Glimmer)',
    'Used by every local run: Chat, Agent and Mission with the local runtime, and the local side of a Mission that consults Meta. Independent of the Meta Model API key and model.':
      'Lo usa toda ejecución local: Chat, Agente y Misión con el runtime local, y la parte local de una Misión que consulta a Meta. Independiente de la clave y el modelo de Meta Model API.',
    'Muse Glimmer on this computer — RAME starts and stops llama-server': 'Muse Glimmer en este ordenador — RAME arranca y para llama-server',
    'Glimmer on a server you run — Ollama, LM Studio or llama-server': 'Glimmer en un servidor que ejecutas tú — Ollama, LM Studio o llama-server',
    'Configure it in Runtime': 'Configurarlo en Runtime',
    'Change in Models': 'Cambiar en Modelos',
    'Use: {0} — {1}': 'Usa: {0} — {1}',
    'llama-server on this computer': 'llama-server en este ordenador',
    '{0} at {1}': '{0} en {1}',
    'no model file set yet: choose it in Runtime': 'aún sin fichero de modelo: elígelo en Runtime',
    'Not in use yet: in Runtime, find the models of your server and press Use this model.': 'Aún no se usa: en Runtime, busca los modelos de tu servidor y pulsa Usar este modelo.',
    'Configuring: Muse Glimmer on this computer (RAME starts llama-server).': 'Configurando: Muse Glimmer en este ordenador (RAME arranca llama-server).',
    'Configuring: Glimmer on a server you run (Ollama, LM Studio or llama-server).': 'Configurando: Glimmer en un servidor que ejecutas tú (Ollama, LM Studio o llama-server).',
    'Switching to llama-server on this computer…': 'Cambiando a llama-server en este ordenador…',
    'Use: {0} ({1}) · {2}': 'Usa: {0} ({1}) · {2}',
    'Meta API': 'Meta API',
    'Glimmer local': 'Glimmer local',
  };

  if (window.RAME_I18N && typeof window.RAME_I18N.extend === 'function') {
    window.RAME_I18N.extend('es', ES);
  }

  var KIND = { ollama: 'Ollama', lmstudio: 'LM Studio', 'llama-server': 'llama-server', 'openai-compatible': 'OpenAI-compatible server' };
  var h = null;
  var shown = null;

  function el(id) {
    return document.getElementById(id);
  }

  function t(text) {
    return h ? h.t(text) : text;
  }

  function tf(text) {
    var args = Array.prototype.slice.call(arguments, 1);
    return h ? h.tf.apply(null, [text].concat(args)) : text;
  }

  function selectedModel() {
    var select = el('serverModel');
    var scan = shown && shown.scan;
    if (!select || !scan) return null;
    for (var i = 0; i < scan.models.length; i += 1) {
      if (scan.models[i].id === select.value) return scan.models[i];
    }
    return null;
  }

  function describeModel(model) {
    var tags = [];
    tags.push(model.tools === true ? t('tools') : model.tools === false ? t('no tools') : '?');
    if (model.vision) tags.push(t('vision (RAME sends no images yet)'));
    if (model.loaded) tags.push(t('loaded'));
    if (model.loadedContext) tags.push(tf('context {0}', model.loadedContext));
    return model.id + ' (' + tags.join(', ') + ')';
  }

  function noteFor(model) {
    if (!model) return '';
    // The note is host text: translate its known sentences, keep the rest as written.
    return h && h.tHost ? h.tHost(model.note) : model.note;
  }

  var lastData = null;

  function render(data) {
    lastData = data;
    var servers = data && data.remote ? data.remote.servers : null;
    if (!servers) return;
    shown = servers;
    var select = el('serverModel');
    var endpoint = el('serverEndpoint');
    var scan = servers.scan;
    if (endpoint && !endpoint.value) endpoint.value = servers.endpoint || (scan ? scan.endpoint : '');
    if (select) {
      var previous = select.value || servers.model;
      while (select.firstChild) select.removeChild(select.firstChild);
      (scan ? scan.models : []).forEach(function (model) {
        var option = document.createElement('option');
        option.value = model.id;
        option.textContent = describeModel(model);
        select.appendChild(option);
      });
      if (previous) select.value = previous;
      if (!select.value && select.options.length > 0) select.selectedIndex = 0;
      select.disabled = !scan || scan.models.length === 0;
    }
    var lanRow = el('serverLanRow');
    if (lanRow) lanRow.hidden = !(scan && scan.scope === 'private');
    var lan = el('serverLan');
    if (lan && servers.lan && servers.scan && servers.endpoint === servers.scan.endpoint) lan.checked = true;
    var use = el('serverUse');
    if (use) use.disabled = !scan || !selectedModel();
    var note = el('serverModelNote');
    if (note) note.textContent = scan ? noteFor(selectedModel()) : servers.scanError ? (h && h.tHost ? h.tHost(servers.scanError) : servers.scanError) : '';
    var current = el('serverCurrent');
    if (current) {
      current.textContent = servers.endpoint
        ? tf('In use: {0} on {1}.', servers.model || '(default)', (KIND[servers.kind] || servers.endpoint) + (servers.kind ? ' — ' + servers.endpoint : '')) + (servers.lan ? ' (' + t('another computer of your network') + ')' : '')
        : t('No external model server in use.');
    }
    var web = servers.web || {};
    var enabled = el('webEnabled');
    var engine = el('webSearchEngine');
    var searx = el('webSearxngUrl');
    if (enabled && document.activeElement !== enabled) enabled.checked = web.enabled === true;
    if (engine && document.activeElement !== engine) engine.value = web.search === 'searxng' ? 'searxng' : 'duckduckgo';
    if (searx && document.activeElement !== searx && !searx.value) searx.value = web.searxngUrl || '';
    if (searx) searx.disabled = engine ? engine.value !== 'searxng' : false;
    var shell = el('shellEnabled');
    if (shell && document.activeElement !== shell) shell.checked = Boolean(servers.shell && servers.shell.enabled);
    renderIdentity(data);
  }

  // The local server's identity and the GGUF hash (from Model evidence's own view of them).
  var IDENTITY_KIND = { 'rame-llama-server': 'llama-server (RAME)', 'llama-server': 'llama-server', ollama: 'Ollama', lmstudio: 'LM Studio', 'openai-compatible': 'OpenAI-compatible server', unknown: 'OpenAI-compatible endpoint' };
  function renderIdentity(data) {
    var view = data && data.modelEvidence && data.modelEvidence.now && data.modelEvidence.now.local ? data.modelEvidence.now.local.identity : null;
    var id = view ? view.identity : null;
    var line = el('serverIdentity');
    if (line) {
      line.textContent = !id ? '' : id.basis === 'declared'
        ? t('the server did not answer identity requests')
        : tf('{0} · {1} · requested {2} · loaded {3} — as the server reports it; not a proof of the weights', IDENTITY_KIND[id.kind] || id.kind, id.endpointLabel, id.requestedModel, id.servedModel || t('not reported'));
    }
    var artifact = view ? view.artifact : { state: 'none' };
    var status = el('artifactHashStatus');
    var cancel = el('artifactHashCancel');
    var start = el('artifactHash');
    if (cancel) cancel.hidden = artifact.state !== 'hashing';
    if (start) start.disabled = artifact.state === 'hashing';
    if (status) {
      status.textContent = artifact.state === 'verified' ? tf('SHA-256 of {0}: {1}', artifact.file, artifact.sha256)
        : artifact.state === 'hashing' ? tf('Computing… {0}%', artifact.percent)
        : artifact.state === 'stale' ? tf('Not valid any more: {0}', artifact.reason)
        : artifact.state === 'failed' ? artifact.reason
        : '';
    }
  }

  function post(message) {
    if (h && h.vscode) h.vscode.postMessage(message);
  }

  function on(id, event, handler) {
    var node = el(id);
    if (node) node.addEventListener(event, handler);
  }

  function init(helpers) {
    h = helpers;
    // The Mission's web choice travels just before main.js sends the authorization (capture phase runs first).
    document.addEventListener('click', function (event) {
      var start = el('missionStart');
      if (!start || event.target !== start || !lastData || !lastData.missionLive || !lastData.missionLive.missionId) return;
      var count = function (id, fallback) {
        var value = parseInt(String((el(id) || {}).value || ''), 10);
        return isNaN(value) ? fallback : Math.max(0, Math.min(100, value));
      };
      post({
        type: 'missionWebSet',
        missionId: lastData.missionLive.missionId,
        enabled: Boolean(el('missionWebEnabled') && el('missionWebEnabled').checked),
        maxSearches: count('missionWebSearches', 5),
        maxFetches: count('missionWebFetches', 10),
        domains: String((el('missionWebDomains') || {}).value || '').split(',').map(function (d) { return d.trim(); }).filter(Boolean).slice(0, 20),
      });
    }, true);

    on('serverPresetOllama', 'click', function () {
      el('serverEndpoint').value = 'http://127.0.0.1:11434';
    });
    on('serverPresetLmStudio', 'click', function () {
      el('serverEndpoint').value = 'http://127.0.0.1:1234';
    });
    on('serverScan', 'click', function () {
      var value = String(el('serverEndpoint').value || '').trim();
      if (value) post({ type: 'localServerScan', endpoint: value });
    });
    on('serverModel', 'change', function () {
      var note = el('serverModelNote');
      if (note) note.textContent = noteFor(selectedModel());
      var use = el('serverUse');
      if (use) use.disabled = !selectedModel();
    });
    on('serverUse', 'click', function () {
      var model = selectedModel();
      var scan = shown && shown.scan;
      if (!model || !scan) {
        var note = el('serverModelNote');
        if (note) note.textContent = t('Find models first.');
        return;
      }
      post({ type: 'localServerUse', endpoint: scan.endpoint, model: model.id, lan: Boolean(el('serverLan') && el('serverLan').checked) });
    });
    on('webSearchEngine', 'change', function () {
      var searx = el('webSearxngUrl');
      if (searx) searx.disabled = el('webSearchEngine').value !== 'searxng';
    });
    on('serverIdentityCheck', 'click', function () {
      post({ type: 'localIdentity', action: 'check' });
    });
    on('artifactHash', 'click', function () {
      post({ type: 'localIdentity', action: 'hash' });
    });
    on('artifactHashCancel', 'click', function () {
      post({ type: 'localIdentity', action: 'cancel-hash' });
    });
    on('shellSave', 'click', function () {
      post({ type: 'shellAccessSet', enabled: Boolean(el('shellEnabled').checked) });
    });
    on('webSave', 'click', function () {
      post({
        type: 'webAccessSet',
        enabled: Boolean(el('webEnabled').checked),
        search: el('webSearchEngine').value === 'searxng' ? 'searxng' : 'duckduckgo',
        searxngUrl: String(el('webSearxngUrl').value || '').trim(),
      });
    });
  }

  var base = window.RAME_REMOTE;
  if (base) {
    window.RAME_REMOTE = Object.assign({}, base, {
      init: function (helpers) {
        base.init(helpers);
        init(helpers);
      },
      render: function (data) {
        base.render(data);
        render(data);
      },
    });
  }
})();

/* Which Glimmer the local runtime uses, the "Use: <model>" header, and a
 * visible answer for every settings button. Wraps RAME_REMOTE like the block
 * above; main.js needs no change.
 *   - Settings → Models chooses the local source: RAME's own llama-server, or
 *     a server the user runs (Ollama, LM Studio, llama-server). It is apart
 *     from the Meta Model API. Settings → Runtime then shows only the
 *     settings of that source. Choosing "this computer" clears the external
 *     server at once; choosing "a server you run" takes effect when a model
 *     is chosen there with "Use this model".
 *   - A clicked button shows a spinner until the host answers with a new
 *     state, then a check mark (or "!" when the host reports a problem), so a
 *     click never looks like nothing happened. */
(function () {
  'use strict';

  // Spanish entries are in the table at the top of this file.

  var KIND = { ollama: 'Ollama', lmstudio: 'LM Studio', 'llama-server': 'llama-server', 'openai-compatible': 'OpenAI-compatible server' };
  var STATE_WORDS = { 'not-configured': 'not configured' };
  var h = null;
  var chosen = null;
  var last = null;

  function el(id) {
    return document.getElementById(id);
  }
  function t(text) {
    return h ? h.t(text) : text;
  }
  function tf(text) {
    var args = Array.prototype.slice.call(arguments, 1);
    return h ? h.tf.apply(null, [text].concat(args)) : text;
  }
  function setText(node, text) {
    if (node && node.textContent !== text) node.textContent = text;
  }
  function baseName(path) {
    var parts = String(path || '').split(/[\\/]/);
    return parts[parts.length - 1] || '';
  }

  /** The local source in use now: an external server when one is saved, else RAME's llama-server. */
  function inUse(data) {
    var servers = data && data.remote && data.remote.servers;
    var endpoint = (servers && servers.endpoint) || (data && data.externalLocalEndpoint) || '';
    return endpoint ? 'server' : 'managed';
  }

  /** "muse-glimmer — LM Studio at http://…", or the managed model file. */
  function describeLocal(data) {
    var servers = (data && data.remote && data.remote.servers) || {};
    if (inUse(data) === 'server') {
      var where = KIND[servers.kind] ? tf('{0} at {1}', KIND[servers.kind], servers.endpoint || data.externalLocalEndpoint) : (servers.endpoint || data.externalLocalEndpoint);
      return { model: servers.model || (data.localSettings && data.localSettings.modelId) || 'local-glimmer', where: where };
    }
    var file = baseName(data && data.localSettings && data.localSettings.modelPath);
    return { model: file || t('no model file set yet: choose it in Runtime'), where: t('llama-server on this computer'), missing: !file };
  }

  function renderChoice(data) {
    var current = inUse(data);
    if (chosen === null) chosen = current;
    var managed = el('localSourceManaged');
    var server = el('localSourceServer');
    if (managed) managed.checked = chosen === 'managed';
    if (server) server.checked = chosen === 'server';
    var local = describeLocal(data);
    var now = chosen === 'server' && current !== 'server'
      ? t('Not in use yet: in Runtime, find the models of your server and press Use this model.')
      : local.missing ? tf('Use: {0} — {1}', local.where, local.model) : tf('Use: {0} — {1}', local.model, local.where);
    setText(el('localSourceNow'), now);
    setText(el('localSourceBannerText'), chosen === 'server'
      ? t('Configuring: Glimmer on a server you run (Ollama, LM Studio or llama-server).')
      : t('Configuring: Muse Glimmer on this computer (RAME starts llama-server).'));
    // Runtime shows only what configures the chosen source.
    var managedSection = el('localSection');
    var serversSection = el('localServersSection');
    if (managedSection) managedSection.hidden = chosen === 'server';
    if (serversSection) serversSection.hidden = chosen !== 'server';
  }

  /** Header: the selected runtime says what it uses, e.g. "Use: muse-glimmer (LM Studio …) · connected". */
  function renderHeader(data) {
    var runtime = data && data.remote && data.remote.runtime;
    if (!runtime) return;
    if (runtime.selected === 'local') {
      var local = describeLocal(data);
      if (!local.missing) {
        setText(el('runtimeBadgeLocal'), tf('Use: {0} ({1}) · {2}', local.model, local.where, t(STATE_WORDS[runtime.local] || runtime.local)));
      }
    } else if (data.cloudModel) {
      setText(el('runtimeBadgeCloud'), tf('Use: {0} ({1}) · {2}', data.cloudModel, t('Meta API'), t(STATE_WORDS[runtime.cloud] || runtime.cloud)));
    }
  }

  // ----- A visible answer for every settings button -----
  var busy = [];
  var PROBLEM = /\b(?:could not|cannot|can't|invalid|refused|failed|error|not saved|not reachable|unreachable|denied)\b/i;

  function inScope(button) {
    if (!button || button.tagName !== 'BUTTON' || button.disabled) return false;
    if (button.hasAttribute('data-card') || button.classList.contains('icon-btn')) return false;
    return Boolean(button.closest && button.closest('#settingsScreen, #missionCard'));
  }

  function flash(button, ok) {
    button.classList.remove('is-done', 'is-failed');
    button.classList.add(ok ? 'is-done' : 'is-failed');
    setTimeout(function () {
      button.classList.remove('is-done', 'is-failed');
    }, 1600);
  }

  function settle(status) {
    var ok = !PROBLEM.test(String(status || ''));
    var now = Date.now();
    busy.slice().forEach(function (entry) {
      // Keep the spinner long enough to be seen.
      var wait = Math.max(0, 400 - (now - entry.at));
      setTimeout(function () {
        entry.button.classList.remove('is-working');
        entry.button.removeAttribute('aria-busy');
        flash(entry.button, ok);
      }, wait);
    });
    busy = [];
  }

  function onClick(event) {
    var button = event.target && event.target.closest ? event.target.closest('button') : null;
    if (!inScope(button)) return;
    // Buttons that only fill a field here answer at once.
    if (button.id === 'serverPresetOllama' || button.id === 'serverPresetLmStudio' || button.id === 'localSourceConfigure' || button.id === 'localSourceChange') {
      flash(button, true);
      return;
    }
    // main.js already shows its own spinner on some buttons.
    if (button.classList.contains('is-pending')) return;
    button.classList.add('is-working');
    button.setAttribute('aria-busy', 'true');
    var entry = { button: button, at: Date.now() };
    busy.push(entry);
    // Nothing came back (for example an empty field): stop the spinner.
    setTimeout(function () {
      var index = busy.indexOf(entry);
      if (index !== -1) {
        busy.splice(index, 1);
        button.classList.remove('is-working');
        button.removeAttribute('aria-busy');
      }
    }, 10000);
  }

  function openCard(id) {
    if (window.RAME_SETTINGS_TABS && typeof window.RAME_SETTINGS_TABS.activate === 'function') window.RAME_SETTINGS_TABS.activate(id);
  }

  function init(helpers) {
    h = helpers;
    document.addEventListener('click', onClick);
    var pick = function (value) {
      return function () {
        var previous = chosen;
        chosen = value;
        if (value === 'managed' && last && inUse(last) === 'server') {
          // Leaving the external server takes effect now.
          setText(el('localSourceNow'), t('Switching to llama-server on this computer…'));
          if (h && h.vscode) h.vscode.postMessage({ type: 'clearExternalEndpoint' });
        }
        if (last && previous !== value) renderChoice(last);
      };
    };
    var managed = el('localSourceManaged');
    var server = el('localSourceServer');
    if (managed) managed.addEventListener('change', pick('managed'));
    if (server) server.addEventListener('change', pick('server'));
    var configure = el('localSourceConfigure');
    if (configure) configure.addEventListener('click', function () { openCard('cardRuntime'); });
    var change = el('localSourceChange');
    if (change) change.addEventListener('click', function () { openCard('cardModels'); });
    var review = el('authorizationPendingReview');
    if (review) review.addEventListener('click', function () {
      var start = el('missionStart');
      if (start && typeof start.scrollIntoView === 'function') start.scrollIntoView({ block: 'center' });
      if (start && typeof start.focus === 'function') start.focus();
    });
  }

  // A Mission authorization waiting for the user: named for its stage, announced by the message box, and brought into view once.
  var shownAuthorization = '';
  function renderAuthorization(data) {
    var live = data && data.missionLive && data.missionLive.threadId === data.activeThreadId ? data.missionLive : null;
    var setupEl = el('missionSetup');
    var pending = Boolean(live && live.missionId && setupEl && !setupEl.hidden);
    var setup = live && live.setup ? live.setup : null;
    var stage = setup && setup.awaitingVerification ? 2 : setup && setup.bootstrap ? 1 : 0;
    var start = el('missionStart');
    if (pending && start && !start.classList.contains('is-pending') && stage > 0) {
      setText(start, t(stage === 2 ? 'Authorize stage 2 of 2: run the tests and continue' : 'Authorize stage 1 of 2: create the files'));
    }
    var banner = el('authorizationPending');
    if (banner) banner.hidden = !pending;
    setText(el('authorizationPendingText'), !pending ? '' : t(stage === 2
      ? 'Authorization needed — stage 2 of 2: run the new tests. Stage 1 is done.'
      : stage === 1 ? 'Authorization needed — stage 1 of 2: create the project files (no test runs yet).' : 'Authorization needed: the Mission is waiting for you to review and start it.'));
    var key = pending ? String(live.missionId) + ':' + stage : '';
    if (key !== '' && key !== shownAuthorization) {
      // Every new authorization starts with web access and Meta advice OFF: nothing carries over from an earlier card.
      var webBox = el('missionWebEnabled');
      if (webBox) webBox.checked = false;
      var consults = el('missionConsults');
      if (consults) consults.value = '0';
    }
    if (key !== '' && key !== shownAuthorization && setupEl) {
      if (start && typeof start.scrollIntoView === 'function') start.scrollIntoView({ block: 'nearest' });
      if (setupEl.classList) {
        setupEl.classList.add('needs-authorization');
        setTimeout(function () { setupEl.classList.remove('needs-authorization'); }, 2400);
      }
    }
    shownAuthorization = key;
  }

  function render(data) {
    last = data;
    if (busy.length > 0) settle(data && data.status);
    renderChoice(data);
    renderHeader(data);
    // main.js draws the Mission card, the permission chip and the controls after this: adjust them once it has.
    Promise.resolve().then(function () {
      renderAuthorization(data);
      renderTaskNumber(data);
      renderMissionPermission(data);
    });
  }

  // In a Mission thread the Agent selector does not govern: it shows the Mission's own permission and cannot be changed there.
  function renderMissionPermission(data) {
    var live = data && data.missionLive && data.missionLive.threadId === data.activeThreadId ? data.missionLive : null;
    var button = el('permissionBtn');
    var chip = el('permissionChip');
    if (!button || !chip) return;
    if (!live) {
      if (button.getAttribute && button.getAttribute('data-mission') === 'true') {
        button.disabled = false;
        button.setAttribute('data-mission', 'false');
      }
      return;
    }
    setText(chip, t(live.grant === 'autonomous-workspace' ? 'Mission: autonomous' : live.grant === 'supervised' ? 'Mission: supervised' : 'Mission: not authorized yet'));
    button.disabled = true;
    if (button.setAttribute) {
      button.setAttribute('data-mission', 'true');
      button.setAttribute('title', t("This Mission uses its own authorization (its card), not Agent's permission profile."));
    }
  }

  // "Task 2 of 2: …" instead of "… (1 of 2 done)": which step of the plan runs now.
  function renderTaskNumber(data) {
    var live = data && data.missionLive && data.missionLive.threadId === data.activeThreadId ? data.missionLive : null;
    var facts = el('missionFacts');
    if (!live || !live.currentTask || !facts || typeof facts.querySelectorAll !== 'function') return;
    var terms = facts.querySelectorAll('dt');
    for (var i = 0; i < terms.length; i += 1) {
      if (terms[i].textContent === t('Current task') && terms[i].nextElementSibling) {
        setText(terms[i].nextElementSibling, tf('Task {0} of {1}: {2}', Math.min(live.tasksDone + 1, live.tasksTotal), live.tasksTotal, live.currentTask));
      }
    }
  }

  var base = window.RAME_REMOTE;
  if (base) {
    window.RAME_REMOTE = Object.assign({}, base, {
      init: function (helpers) {
        base.init(helpers);
        init(helpers);
      },
      render: function (data) {
        base.render(data);
        render(data);
      },
    });
  }
  window.RAME_LOCAL_SOURCE = { inUse: inUse, describeLocal: describeLocal };
})();
