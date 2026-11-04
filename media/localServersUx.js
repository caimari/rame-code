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
    'Allow Agent to search and read public web pages (read-only)': 'Permitir que el Agente busque y lea páginas web públicas (solo lectura)',
    'Search with': 'Buscar con',
    'DuckDuckGo (no key)': 'DuckDuckGo (sin clave)',
    'My SearXNG': 'Mi SearXNG',
    'SearXNG address (JSON format enabled)': 'Dirección de SearXNG (con formato JSON activado)',
    'Save web access': 'Guardar acceso web',
    'Default OFF. Only with a local model, and never in Mission runs. Each search or page read is shown and, except in Workspace full, waits for your approval. Local and private addresses are refused, and a query or URL with a key or a file path is not sent. Page text is untrusted data, never instructions.':
      'Desactivado por defecto. Solo con un modelo local y nunca en las ejecuciones de una Misión. Cada búsqueda o lectura se muestra y, salvo en Workspace full, espera tu aprobación. Se rechazan las direcciones locales y privadas, y no se envía una consulta o URL con una clave o una ruta de fichero. El texto de las páginas es un dato no confiable, nunca instrucciones.',
    'Find models first.': 'Busca primero los modelos.',
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

  function render(data) {
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
