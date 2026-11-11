/* External model servers (Ollama, LM Studio, llama-server) and web access
 * settings. Everything shown comes from the host (state.remote.servers);
 * text is set with textContent only. Loaded after remoteUx.js: it wraps
 * RAME_REMOTE.init/render so main.js needs no change. */
(function () {
  'use strict';

  var ES = {
    'Reload in LM Studio with more context': 'Recargar en LM Studio con más contexto',
    'Reload in LM Studio with a {0}-token context': 'Recargar en LM Studio con {0} tokens de contexto',
    'The request does not fit the local model\'s context': 'La petición no cabe en el contexto del modelo local',
    'The model is loaded with too little context for this thread. Nothing was cut. Reload it with more context using the button below, or start a new thread, then send again.':
      'El modelo está cargado con muy poco contexto para este hilo. No se recortó nada. Recárgalo con más contexto con el botón de abajo, o empieza un hilo nuevo, y vuelve a enviar.',
    'The model is loaded with too little context for this thread. Nothing was cut. Load it with a larger context in its server, or start a new thread, then send again.':
      'El modelo está cargado con muy poco contexto para este hilo. No se recortó nada. Cárgalo con más contexto en su servidor, o empieza un hilo nuevo, y vuelve a enviar.',
    'Waiting for your confirmation…': 'Esperando tu confirmación…',
    '{0} (in use — the server does not list it now)': '{0} (en uso — el servidor ya no lo lista)',
    '{0} (in use — Find models lists the others)': '{0} (en uso — «Buscar modelos» lista los demás)',
    'The local server has no model ready': 'El servidor local no tiene ningún modelo listo',
    'The server answered, but it has no model loaded for this request. Load the model in the server (in LM Studio: Developer → Load model, or lms load), or choose a model it lists in the runtime settings, then send again. A server setup problem is not a reason to run the request with Spark.':
      'El servidor respondió, pero no tiene ningún modelo cargado para esta petición. Carga el modelo en el servidor (en LM Studio: Developer → Load model, o lms load), o elige un modelo de los que lista en los ajustes del runtime, y vuelve a enviar. Un problema de configuración del servidor no es motivo para ejecutar la petición con Spark.',
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
    'Default OFF. Agent and Chat, with the main model (local or Meta: with Meta, the pages it reads go to Meta as tool results, never into an advisor\'s consultation); a Mission has its own web permission, chosen when you authorize it. Each search or page read is shown and waits for your approval in Chat and in Agent, whatever the profile, unless Autonomy & Permissions below pre-authorizes it. Local and private addresses are refused, and a query or URL with a key or a file path is not sent. Page text is untrusted data, never instructions.':
      'Desactivado por defecto. Agente y Chat, con el modelo principal (local o Meta: con Meta, las páginas que lee llegan a Meta como resultados de herramientas, nunca a una consulta del asesor); una Misión tiene su propio permiso web, que eliges al autorizarla. Cada búsqueda o lectura se muestra y espera tu aprobación en Chat y en el Agente, sea cual sea el perfil, salvo que Autonomía y permisos (más abajo) lo autorice de antemano. Se rechazan las direcciones locales y privadas, y no se envía una consulta o URL con una clave o una ruta de fichero. El texto de las páginas es un dato no confiable, nunca instrucciones.',
    'Find models first.': 'Busca primero los modelos.',
    'Web access for this Mission': 'Acceso web para esta Misión',
    'Allow this Mission to search the web and read pages (read-only)': 'Permitir que esta Misión busque en la web y lea páginas (solo lectura)',
    'Searches, at most': 'Búsquedas, como máximo',
    'Test isolation': 'Aislamiento de los tests',
    'not recorded': 'no registrado',
    'no isolation: the command runs with your permissions': 'sin aislamiento: el comando se ejecuta con tus permisos',
    'isolated: writes only in the project, temporary and package-cache folders; network allowed': 'aislado: escribe solo en las carpetas del proyecto, temporal y de cachés de paquetes; con red',
    'isolated and closed: writes only in the project, temporary and package-cache folders; no network': 'aislado y cerrado: escribe solo en las carpetas del proyecto, temporal y de cachés de paquetes; sin red',
    'protected verifier: exact project reads, no ambient files, no TCP': 'verificador protegido: lecturas exactas del proyecto, sin ficheros del entorno, sin TCP',
    'Page reads, at most': 'Lecturas de páginas, como máximo',
    'Authorized domains for page reads (optional; for example nodejs.org, docs.python.org)': 'Dominios autorizados para leer páginas (opcional; por ejemplo nodejs.org, docs.python.org)',
    'nodejs.org, docs.python.org': 'nodejs.org, docs.python.org',
    'Default OFF. Within this budget an autonomous Mission searches and reads without asking each time; a supervised Mission still asks. Queries leave this computer: plain words only, never code, keys or file paths, and the host counts and records every request. Pages are read only from this Mission\'s own search results, or only from the domains above if you list some. 15 s and 2 MiB per page. Web access adds no write, terminal, memory or file permission. Web text is never put in a consultation of the advisor; with Meta as the Mission\'s main model, the pages it reads go to Meta as tool results.':
      'Desactivado por defecto. Dentro de este presupuesto, una Misión autónoma busca y lee sin preguntar cada vez; una Misión supervisada sigue preguntando. Las consultas salen de este ordenador: solo palabras normales, nunca código, claves ni rutas de ficheros, y el host cuenta y registra cada petición. Solo se leen páginas que devolvieron las búsquedas de esta Misión o, si indicas dominios, solo de esos dominios. 15 s y 2 MiB por página. El acceso web no añade permisos de escritura, terminal, memoria ni ficheros. El texto web nunca entra en una consulta del asesor; con Meta como modelo principal de la Misión, las páginas que lee llegan a Meta como resultados de herramientas.',
    'Terminal commands': 'Comandos de terminal',
    'Agent works only inside the active workspace. Symlink and path escapes are blocked; .git, .env files, credential and key material, secret stores, auth files, and repository control files are protected. Tests run only from an exact derived allowlist with shell:false; arbitrary commands run only through the optional terminal tool (OFF by default), each shown first; allowlisted package scripts still execute with your OS permissions and may access files, network, or shells. Ask and Safe-auto require approval before they run, while Workspace-full may run them without prompting and is high risk. Cloud work needs your existing escalation consent and never switches providers silently. Tamper resistance is not claimed.':
      'El Agente trabaja solo dentro del workspace activo. Se bloquean las salidas por enlaces simbólicos y rutas; .git, los ficheros .env, credenciales y claves, almacenes de secretos, ficheros de autenticación y de control del repositorio están protegidos. Las pruebas solo se ejecutan desde una lista exacta derivada, con shell:false; los comandos arbitrarios solo pasan por la herramienta opcional de terminal (desactivada por defecto), que muestra cada uno antes; los scripts permitidos siguen ejecutándose con tus permisos del sistema y pueden acceder a ficheros, red o shells. Preguntar y Auto seguro piden aprobación antes de ejecutarlos; Acceso total puede ejecutarlos sin preguntar y es de alto riesgo. El trabajo en la nube necesita tu consentimiento de escalado y nunca cambia de proveedor en silencio. No se afirma resistencia a manipulaciones.',
    'Allow Agent to run terminal commands (bash, sh or PowerShell) in the project folder': 'Permitir que el Agente ejecute comandos de terminal (bash, sh o PowerShell) en la carpeta del proyecto',
    'Save terminal access': 'Guardar acceso a terminal',
    'What a command may do (isolation, the same in every autonomy mode)': 'Qué puede hacer un comando (aislamiento, igual en cualquier modo de autonomía)',
    'What local processes may do (isolation, the same in every autonomy mode)': 'Qué pueden hacer los procesos locales (aislamiento, igual en cualquier modo de autonomía)',
    'Project (default): write only in the project, temporary and package-cache folders; network allowed': 'Proyecto (predeterminado): escribir solo en las carpetas del proyecto, temporal y de cachés de paquetes; con red',
    'Closed: like Project, and no network': 'Cerrado: como Proyecto, y sin red',
    'Total: no isolation, a command runs with your permissions': 'Total: sin aislamiento, un comando se ejecuta con tus permisos',
    'Total: no isolation, local processes run with your permissions': 'Total: sin aislamiento, los procesos locales se ejecutan con tus permisos',
    'Default OFF. For the main model, local or Meta (with Meta, a command\'s output goes to Meta), and never in Mission runs. You see each command exactly before it runs and approve it, in every profile, Workspace full included, unless Full Access includes commands. The isolation level also protects allowlisted tests, non-container long jobs and non-administrator installs. Project and Closed fail closed when Linux Landlock cannot be applied; Closed also blocks TCP. Administrator installs remain explicit and open in a VS Code terminal without Landlock. Container jobs keep their own container isolation. Files you can read stay readable, DNS is not blocked, and programs already running keep their rights. Total runs with your permissions. Stop signals the normal process group, but a deliberately detached process may survive.':
      'Desactivado por defecto. Para el modelo principal, local o Meta (con Meta, la salida del comando llega a Meta), y nunca en ejecuciones de Misión. Cada comando se muestra exactamente y se aprueba salvo que Acceso total incluya comandos. El nivel de aislamiento también protege tests permitidos, trabajos largos sin contenedor e instalaciones no administrativas. Proyecto y Cerrado fallan de forma cerrada si no se puede aplicar Landlock; Cerrado bloquea además TCP. Las instalaciones administrativas siguen siendo explícitas y se abren en un terminal de VS Code sin Landlock. Los trabajos en contenedor conservan su propio aislamiento. Los ficheros legibles siguen siéndolo, DNS no se bloquea y los procesos ya iniciados conservan sus permisos. Total se ejecuta con tus permisos. Detener señala el grupo normal de procesos, pero uno desacoplado deliberadamente puede sobrevivir.',
    'Checking whether commands can be isolated on this system…': 'Comprobando si se pueden aislar los comandos en este sistema…',
    'Isolation available on this system (Linux Landlock).': 'Aislamiento disponible en este sistema (Landlock de Linux).',
    'Isolation is not available here: {0}. With Project or Closed, commands are not run; choose Total to run them without isolation.': 'El aislamiento no está disponible aquí: {0}. Con Proyecto o Cerrado los comandos no se ejecutan; elige Total para ejecutarlos sin aislamiento.',
    'Isolation is not available here: {0}. With Project or Closed, protected local processes are not run; choose Total to run them without isolation.': 'El aislamiento no está disponible aquí: {0}. Con Proyecto o Cerrado los procesos locales protegidos no se ejecutan; elige Total para ejecutarlos sin aislamiento.',
    'Total: commands run without isolation, with your permissions.': 'Total: los comandos se ejecutan sin aislamiento, con tus permisos.',
    'Total: local processes run without isolation, with your permissions.': 'Total: los procesos locales se ejecutan sin aislamiento, con tus permisos.',
    'Default OFF. For the main model, local or Meta (with Meta, a command\'s output goes to Meta), and never in Mission runs. You see each command exactly before it runs and approve it, in every profile, Workspace full included, unless Full Access includes commands. The card warns when a line chains commands, runs a script you cannot see, uses sudo or the network, or installs software, but a command line never shows all its effects. Isolation (Linux, Landlock): Project and Closed stop writes outside the project, temporary and package-cache folders, and sudo cannot gain rights; Closed also blocks TCP. Files you can read stay readable (as in Codex\'s sandbox), DNS is not blocked, and programs already running keep their rights. Where the isolation cannot be applied (Windows, macOS, no Landlock or no python3) a command is not run unless you choose Total. With Total a command runs with your permissions: it can change any file, use the network or install software. Time and output are limited. Stop signals the command and its normal process group, but a deliberately detached process may survive.':
      'Desactivado por defecto. Para el modelo principal, local o Meta (con Meta, la salida de un comando llega a Meta), y nunca en las ejecuciones de una Misión. Ves cada comando exacto antes de que se ejecute y lo apruebas, en todos los perfiles, también en Workspace full, salvo que el acceso total incluya los comandos. La tarjeta avisa cuando una línea encadena comandos, ejecuta un script que no ves, usa sudo o la red, o instala programas, pero una línea de comandos nunca muestra todos sus efectos. Aislamiento (Linux, Landlock): Proyecto y Cerrado impiden escribir fuera de las carpetas del proyecto, temporal y de cachés de paquetes, y sudo no puede ganar permisos; Cerrado además bloquea TCP. Los ficheros que puedes leer siguen siendo legibles (como en el sandbox de Codex), el DNS no se bloquea y los programas que ya se están ejecutando conservan sus permisos. Donde no se puede aplicar el aislamiento (Windows, macOS, sin Landlock o sin python3) un comando no se ejecuta salvo que elijas Total. Con Total un comando se ejecuta con tus permisos: puede cambiar cualquier fichero, usar la red o instalar programas. El tiempo y la salida están limitados. Detener señala el comando y su grupo normal de procesos, pero un proceso desacoplado deliberadamente puede sobrevivir.',
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
      var models = scan ? scan.models : [];
      // The saved model is always shown, even before "Find models" and when the server no longer lists it
      // (an LM Studio name that existed only while the model was loaded).
      var saved = servers.model && (!scan || scan.endpoint === servers.endpoint) ? servers.model : '';
      var savedListed = models.some(function (model) { return model.id === saved; });
      if (saved && !savedListed) {
        var kept = document.createElement('option');
        kept.value = saved;
        kept.textContent = tf(scan ? '{0} (in use — the server does not list it now)' : '{0} (in use — Find models lists the others)', saved);
        select.appendChild(kept);
      }
      models.forEach(function (model) {
        var option = document.createElement('option');
        option.value = model.id;
        option.textContent = describeModel(model);
        select.appendChild(option);
      });
      if (previous) select.value = previous;
      if (!select.value && select.options.length > 0) select.selectedIndex = 0;
      select.disabled = models.length === 0;
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
    var level = el('shellIsolation');
    var isolation = servers.shell && servers.shell.isolation ? servers.shell.isolation : 'project';
    if (level && document.activeElement !== level) level.value = isolation;
    var levelNote = el('shellIsolationStatus');
    if (levelNote) {
      var problem = servers.shell ? servers.shell.problem : null;
      levelNote.textContent = isolation === 'total'
        ? t('Total: local processes run without isolation, with your permissions.')
        : problem === null || problem === undefined
          ? t('Checking whether commands can be isolated on this system…')
          : problem === ''
            ? t('Isolation available on this system (Linux Landlock).')
            : tf('Isolation is not available here: {0}. With Project or Closed, protected local processes are not run; choose Total to run them without isolation.', problem);
    }
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
      var level = el('shellIsolation');
      post({ type: 'shellAccessSet', enabled: Boolean(el('shellEnabled').checked), isolation: level && ['project', 'closed', 'total'].indexOf(level.value) >= 0 ? level.value : 'project' });
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
    var reload = el('localIssueReload');
    if (reload) {
      reload.addEventListener('click', function () {
        // The host asks for a modal confirmation before LM Studio is touched.
        if (h && h.vscode && h.markPending(reload, t('Waiting for your confirmation…'))) h.vscode.postMessage({ type: 'localIssueReload' });
      });
    }
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
    renderSetupIssue(data);
    renderReload(data);
    // main.js draws the Mission card, the permission chip and the controls after this: adjust them once it has.
    Promise.resolve().then(function () {
      renderAuthorization(data);
      renderTaskNumber(data);
      renderMissionPermission(data);
    });
  }

  // The local server answered that it has no model ready (remoteUx drew the card just before):
  // say what to do in that server. Its delegation reason is empty, so no Spark button shows.
  function renderSetupIssue(data) {
    var issue = data && data.remote && data.remote.localIssue ? data.remote.localIssue : null;
    if (!issue || issue.kind !== 'setup') return;
    setText(el('local-issue-heading'), t('The local server has no model ready'));
    setText(el('localIssueHint'), t('The server answered, but it has no model loaded for this request. Load the model in the server (in LM Studio: Developer → Load model, or lms load), or choose a model it lists in the runtime settings, then send again. A server setup problem is not a reason to run the request with Spark.'));
  }

  // LM Studio refused for lack of context: offer to reload the model with the context the host proposes.
  function renderReload(data) {
    var issue = data && data.remote && data.remote.localIssue ? data.remote.localIssue : null;
    var button = el('localIssueReload');
    if (!button) return;
    var tokens = issue && typeof issue.reload === 'number' ? issue.reload : 0;
    button.hidden = tokens === 0;
    if (tokens > 0) setText(button, tf('Reload in LM Studio with a {0}-token context', tokens));
    // A context refusal: the server answered, but the model never worked on the request.
    if (issue && issue.context === true) {
      setText(el('local-issue-heading'), t('The request does not fit the local model\'s context'));
      setText(el('localIssueHint'), t(tokens > 0
        ? 'The model is loaded with too little context for this thread. Nothing was cut. Reload it with more context using the button below, or start a new thread, then send again.'
        : 'The model is loaded with too little context for this thread. Nothing was cut. Load it with a larger context in its server, or start a new thread, then send again.'));
    }
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
