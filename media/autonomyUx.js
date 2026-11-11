/* Autonomy & Permissions (Settings → Security) and its part of a Mission's
 * authorization card. Everything shown comes from the host
 * (state.remote.autonomy); text is set with textContent only. Every button
 * only asks: the host validates it and shows its own modal confirmation
 * before anything is pre-authorized or Full Access is turned on. Loaded
 * after localServersUx.js: it wraps RAME_REMOTE.init/render so main.js
 * needs no change. */
(function () {
  'use strict';

  var ES = {
    'Autonomy & Permissions': 'Autonomía y permisos',
    'Mode for this workspace on this computer or server': 'Modo para este workspace en este equipo o servidor',
    'Ask always (default): each Meta consultation and each action that needs an authorization shows its card':
      'Preguntar siempre (predeterminado): cada consulta a Meta y cada acción que necesita autorización muestra su tarjeta',
    'Supervised autonomy: some external requests run without repeating the card, only within the permissions you give below':
      'Autonomía supervisada: algunas peticiones externas se hacen sin repetir la tarjeta, solo dentro de los permisos que des abajo',
    'Full Access: RAME works without authorization cards for the parts you choose, until you revoke it (separate from the Agent profile: Workspace full never turns it on)':
      'Acceso total (Full Access): RAME trabaja sin tarjetas de autorización en las partes que elijas, hasta que lo revoques (aparte del perfil del Agente: Workspace full nunca lo activa)',
    'Full Access': 'Acceso total',
    'Workspace files: read, create, change, move and delete (protected files and the acceptance check stay refused)':
      'Ficheros del workspace: leer, crear, cambiar, mover y borrar (los ficheros protegidos y la comprobación de aceptación siguen rechazados)',
    'Allowlisted tests': 'Tests permitidos',
    'Terminal commands (with the isolation level of Terminal commands; privilege elevation still asks)': 'Comandos de terminal (con el nivel de aislamiento de Comandos de terminal; la elevación de privilegios sigue preguntando)',
    'Meta as the main model: Agent sends your requests and the results of its tools (files it reads, test and command output, web pages) to the selected Meta model without the card that asks each time. Only this choice allows it; the parts above authorize local tools only. Billed by Meta.':
      'Meta como modelo principal: el Agente envía tus peticiones y los resultados de sus herramientas (ficheros que lee, salida de tests y comandos, páginas web) al modelo de Meta seleccionado sin la tarjeta que pregunta cada vez. Solo esta opción lo permite; las partes de arriba autorizan solo herramientas locales. Lo factura Meta.',
    'Meta {0} as the main model': 'Meta {0} como modelo principal',
    'Installs without administrator rights (downloads from the package registry)': 'Instalaciones sin permisos de administrador (descargas del registro de paquetes)',
    'Long jobs': 'Trabajos largos',
    'Web searches and page reads (read-only)': 'Búsquedas y lecturas web (solo lectura)',
    'Turn on Full Access…': 'Activar acceso total…',
    'Turn off Full Access': 'Desactivar acceso total',
    "A confirmation lists what RAME may then do, where it runs, what can leave this computer and what may cost money. Never bypassed: your operating system's and providers' permissions, project memory (always a card), the Mission authorization card, the verifier's files and each tool's limits. With its Meta part, Meta is pre-authorized in the same confirmation (the selected model and key, these limits) and revoked with Full Access.":
      'Una confirmación detalla qué podrá hacer RAME, dónde se ejecuta, qué puede salir de este equipo y qué puede costar dinero. Nunca se salta: los permisos de tu sistema operativo y de tus proveedores, la memoria del proyecto (siempre con tarjeta), la tarjeta de autorización de la Misión, los ficheros del verificador ni los límites de cada herramienta. Con su parte de Meta, Meta queda preautorizado en la misma confirmación (el modelo y la clave elegidos, estos límites) y se revoca con el acceso total.',
    'Meta consultations (the advisor model) in Missions': 'Consultas a Meta (el modelo asesor) en Misiones',
    'Consultations per Mission, at most': 'Consultas por Misión, como máximo',
    'No count limit': 'Sin límite de cantidad',
    'Remote tokens for all Missions together, at most': 'Tokens remotos para todas las Misiones juntas, como máximo',
    "No total (each Mission's limits)": 'Sin total (los límites de cada Misión)',
    'Valid for': 'Vigencia',
    'What Meta may receive': 'Qué puede recibir Meta',
    "Only the Mission instructions and the host's notes": 'Solo las instrucciones de la Misión y las notas del host',
    "Also files or fragments chosen on each Mission's card": 'También ficheros o fragmentos elegidos en la tarjeta de cada Misión',
    'Pre-authorize Meta…': 'Preautorizar Meta…',
    'Revoke': 'Revocar',
    "Off by default. A confirmation shows what leaves this computer, to which provider and model, that it may be billed, the limits and how long it lasts. No count limit never means more data or no limits: each consultation keeps its byte and token limits, and each Mission its totals. RAME has no Meta price list, so the budget is in tokens. Each Mission's card still chooses 0 to this limit (0 by default). Never sent automatically: secrets, credentials, the verifier's hidden files, seeds, protected records, web pages. RAME never switches the main model of a Mission.":
      'Desactivado por defecto. Una confirmación muestra qué sale de este equipo, a qué proveedor y modelo, que puede facturarse, los límites y cuánto dura. Sin límite de cantidad nunca significa más datos ni quitar límites: cada consulta mantiene sus límites de bytes y tokens, y cada Misión sus totales. RAME no tiene tarifas de Meta, así que el presupuesto es en tokens. La tarjeta de cada Misión sigue eligiendo de 0 a este límite (0 por defecto). Nunca se envía automáticamente: secretos, credenciales, ficheros ocultos del verificador, semillas, registros protegidos ni páginas web. RAME nunca cambia el modelo principal de una Misión.',
    'Internet': 'Internet',
    'Agent and Chat, every window of this workspace: searches without a card, at most': 'Agente y Chat, todas las ventanas de este workspace: búsquedas sin tarjeta, como máximo',
    'Page reads without a card, at most': 'Lecturas de páginas sin tarjeta, como máximo',
    'Only these domains for page reads (optional; otherwise only pages your searches found)': 'Solo estos dominios para leer páginas (opcional; si no, solo las páginas que encontraron tus búsquedas)',
    'Pre-authorize web searches…': 'Preautorizar búsquedas web…',
    'Autonomous Missions may be given a web budget, valid for': 'Las Misiones autónomas pueden recibir un presupuesto web, con vigencia de',
    'Pre-authorize web for Missions…': 'Preautorizar web para Misiones…',
    'Separate from Meta. Only the query or the address leaves this computer: never a file, a key or private information, and a query that is not plain words shows its card. These tools only read (GET): publishing or changing data is not possible through them and keeps needing its own permission.':
      'Independiente de Meta. Solo sale de este equipo la consulta o la dirección: nunca un fichero, una clave ni información privada, y una consulta que no sea de palabras normales muestra su tarjeta. Estas herramientas solo leen (GET): publicar o modificar datos no es posible con ellas y sigue necesitando su propio permiso.',
    'Revoke all and stop what runs under them': 'Revocar todo y parar lo que se ejecuta con ellas',
    'External requests (history)': 'Peticiones externas (historial)',
    'Recorded before each request leaves: provider, destination, date, reason, what was sent and how it was approved.':
      'Se anota antes de que salga cada petición: proveedor, destino, fecha, motivo, qué se envió y cómo se aprobó.',
    'Files or fragments Meta may receive with each consultation (optional, at most 3; path or path:10-80)':
      'Ficheros o fragmentos que Meta puede recibir con cada consulta (opcional, como máximo 3; ruta o ruta:10-80)',
    'Autonomy & Permissions…': 'Autonomía y permisos…',
    'src/checksum.js, src/util.js:1-80': 'src/checksum.js, src/util.js:1-80',
    '1 hour': '1 hora',
    '8 hours': '8 horas',
    '24 hours': '24 horas',
    '7 days': '7 días',
    '30 days': '30 días',
    'Workspace: {0}.': 'Workspace: {0}.',
    'Operations run on {0}. Permissions given here apply only there: another computer or Remote SSH server has its own.':
      'Las operaciones se ejecutan en {0}. Los permisos que des aquí solo valen allí: otro equipo o servidor Remote SSH tiene los suyos.',
    'Open a project folder to set its Autonomy & Permissions.': 'Abre una carpeta de proyecto para configurar su autonomía y permisos.',
    'Not pre-authorized: each consultation shows its card.': 'Sin preautorizar: cada consulta muestra su tarjeta.',
    'Pre-authorized: Meta {0}, up to {1} per Mission, {2}, until {3}.': 'Preautorizado: Meta {0}, hasta {1} por Misión, {2}, hasta {3}.',
    'Pre-authorized: Meta {0}, no count limit per Mission, {1}, until {2}.': 'Preautorizado: Meta {0}, sin límite de cantidad por Misión, {1}, hasta {2}.',
    ' Tokens: {0} of {1} used.': ' Tokens: {0} de {1} usados.',
    'instructions only': 'solo instrucciones',
    'instructions and chosen files': 'instrucciones y ficheros elegidos',
    'Not in force: {0}.': 'Sin efecto: {0}.',
    'Not pre-authorized: each web search or page read shows its card.': 'Sin preautorizar: cada búsqueda o lectura web muestra su tarjeta.',
    'Every window of this workspace: {0}/{1} searches and {2}/{3} page reads used without a card, until {4}{5}.': 'Todas las ventanas de este workspace: {0}/{1} búsquedas y {2}/{3} lecturas usadas sin tarjeta, hasta {4}{5}.',
    ', only on {0}': ', solo en {0}',
    'Autonomous Missions: no web budget can be given (not pre-authorized).': 'Misiones autónomas: no se puede dar presupuesto web (sin preautorizar).',
    'Autonomous Missions may be given a web budget until {0}.': 'Las Misiones autónomas pueden recibir presupuesto web hasta {0}.',
    'Off: every card appears as the profile and each pre-authorization say.': 'Desactivado: cada tarjeta aparece según el perfil y cada preautorización.',
    'On until {0}: {1} run without their cards.': 'Activado hasta {0}: {1} se ejecutan sin sus tarjetas.',
    ' {0} long job(s) started under it are stopped if you revoke it.': ' {0} trabajo(s) largo(s) iniciados con él se paran si lo revocas.',
    'workspace files': 'ficheros del workspace',
    'tests': 'tests',
    'terminal commands': 'comandos de terminal',
    'installs': 'instalaciones',
    'long jobs': 'trabajos largos',
    'Meta consultations': 'consultas a Meta',
    'Full Access is on until {0}: {1} run without their cards. Choose a lower level to turn it off.': 'Acceso total activo hasta {0}: {1} sin tarjeta. Elige un nivel inferior para apagarlo.',
    'Full Access — on until {0}; choose a lower level to turn it off.': 'Acceso total — activo hasta {0}; elige un nivel inferior para apagarlo.',
    'Full Access — no cards for the parts you choose; asks for confirmation.': 'Acceso total — sin tarjetas para las partes que elijas; pide confirmación.',
    'you turn it off': 'que lo apagues',
    'Until you turn it off': 'Hasta que lo apagues',
    'Full Access parts and duration…': 'Partes y duración del acceso total…',
    'Full Access expired': 'Acceso total caducado',
    'Full Access expired: the permission is back to {0}.': 'El acceso total ha caducado: el permiso vuelve a {0}.',
    'Meta: when the main model cannot finish, consult Meta without cards (Agent, blocked Missions, the acceptance review)': 'Meta: cuando el modelo principal no consiga terminar, consultar a Meta sin tarjetas (Agente, Misiones bloqueadas, revisión de la aceptación)',
    'Consultations per Mission or conversation': 'Consultas por Misión o conversación',
    'Remote tokens in total, at most': 'Tokens remotos en total, como máximo',
    "No total (each consultation's limits)": 'Sin total (los límites de cada consulta)',
    "Instructions, the host's notes and test fragments you choose": 'Instrucciones, notas del host y fragmentos de test que elijas',
    "Only instructions and the host's notes": 'Solo instrucciones y notas del host',
    'Full Access was not turned on: its Meta part needs cloud escalation ON, a saved Meta API key and a selected Meta model. Nothing changed.': 'No se activó el acceso total: su parte de Meta necesita la escalada a la nube activada, una clave de la API de Meta guardada y un modelo de Meta elegido. No ha cambiado nada.',
    'web': 'web',
    'No external request recorded for this workspace yet.': 'Aún no hay peticiones externas anotadas para este workspace.',
    '{0} operation(s) running under a pre-authorization.': '{0} operación(es) en curso bajo una preautorización.',
    'on its card': 'en su tarjeta',
    'pre-authorized': 'preautorizada',
    'Mission grant': 'concesión de la Misión',
    'permission profile': 'perfil de permisos',
    'full-access': 'permitida por el acceso total',
    'Meta without a card: up to {0} consultation(s) per Mission are pre-authorized ({1}, until {2}).': 'Meta sin tarjeta: hasta {0} consulta(s) por Misión preautorizadas ({1}, hasta {2}).',
    'Meta without a card: no count limit per Mission is pre-authorized ({0}, until {1}); each consultation keeps its limits.': 'Meta sin tarjeta: preautorizado sin límite de cantidad por Misión ({0}, hasta {1}); cada consulta mantiene sus límites.',
    'Meta without a card: not pre-authorized for this workspace. If the Mission stops, the consultation card shows the exact text for your approval.':
      'Meta sin tarjeta: sin preautorizar en este workspace. Si la Misión se para, la tarjeta de consulta muestra el texto exacto para que lo apruebes.',
    'Web for an autonomous Mission: pre-authorized for this workspace.': 'Web para una Misión autónoma: preautorizada en este workspace.',
    'Web for an autonomous Mission: not pre-authorized, so its web budget cannot be given.': 'Web para una Misión autónoma: sin preautorizar, así que no se le puede dar presupuesto web.',
    'Full Access is on: the Mission\'s file operations and tests run without cards; this authorization card and project memory still ask.':
      'El acceso total está activado: las operaciones con ficheros y los tests de la Misión se ejecutan sin tarjetas; esta tarjeta de autorización y la memoria del proyecto siguen preguntando.',
    'Selected: no count limit on Meta consultations · {0}. Each consultation keeps its byte and token limits, and this Mission its totals.':
      'Seleccionado: sin límite de cantidad de consultas a Meta · {0}. Cada consulta mantiene sus límites de bytes y tokens, y esta Misión sus totales.',
    'Advice only: the main model keeps every tool. The advisor receives the Mission instructions, the host\'s notes and the files you list below, never secrets or the verifier\'s hidden files, and cannot execute actions.':
      'Solo consejo: el modelo principal conserva todas las herramientas. El asesor recibe las instrucciones de la Misión, las notas del host y los ficheros que indiques abajo, nunca secretos ni ficheros ocultos del verificador, y no puede ejecutar acciones.',
    'Advice only: the main model keeps every tool. The advisor receives no file contents and cannot execute actions.': 'Solo consejo: el modelo principal conserva todas las herramientas. El asesor no recibe contenido de ficheros y no puede ejecutar acciones.',
    'Choose at least one part for Full Access.': 'Elige al menos una parte para el acceso total.',
  };

  var REVOKED = {
    'Every pre-authorization of this workspace': 'Todas las preautorizaciones de este workspace',
    'The Meta pre-authorization': 'La preautorización de Meta',
    'The web pre-authorization for Missions': 'La preautorización web para Misiones',
    'Full Access': 'El acceso total',
    'The web pre-authorization of Agent and Chat': 'La preautorización web del Agente y el Chat',
  };
  var STOPPED_ES = ', y se cancelaron, donde fue posible, las operaciones en curso con ella (lo que ya salió o se ejecutó no puede deshacerse)';

  // Host messages of this module with variable parts.
  var PATTERNS = [
    [/^Meta's advice was kept; Full Access retries the Mission with it \(automatic retry (\d+) of (\d+)\)\.$/, function (m) { return 'Se guardó el consejo de Meta; el acceso total reintenta la Misión con él (reintento automático ' + m[1] + ' de ' + m[2] + ').'; }],
    [/^([\s\S]*?) ?Full Access already retried this Mission (\d+) times with Meta's advice; it waits for you now\.$/, function (m) { return (m[1] ? m[1] + ' ' : '') + 'El acceso total ya reintentó esta Misión ' + m[2] + ' veces con el consejo de Meta; ahora espera tu decisión.'; }],
    [/^Meta consultations in a Mission need a pre-authorization in Settings → Security → Autonomy & Permissions \(([\s\S]*)\)\. Nothing was authorized\.$/, function (m) { return 'Las consultas a Meta en una Misión necesitan una preautorización en Ajustes → Seguridad → Autonomía y permisos (' + m[1] + '). No se autorizó nada.'; }],
    [/^Web access for an autonomous Mission needs a pre-authorization in Settings → Security → Autonomy & Permissions \(([\s\S]*)\)\. Nothing was authorized\.$/, function (m) { return 'El acceso web de una Misión autónoma necesita una preautorización en Ajustes → Seguridad → Autonomía y permisos (' + m[1] + '). No se autorizó nada.'; }],
    [/^Autonomy & Permissions: Ask always for ([\s\S]*?) on ([\s\S]*?)\. Every pre-authorization of this workspace was revoked([\s\S]*); each Meta consultation and each action shows its card again\.$/, function (m) { return 'Autonomía y permisos: preguntar siempre en ' + m[1] + ' (' + m[2] + '). Se revocaron todas las preautorizaciones de este workspace' + (m[3] ? STOPPED_ES : '') + '; cada consulta a Meta y cada acción vuelve a mostrar su tarjeta.'; }],
    [/^Autonomy & Permissions: supervised autonomy for ([\s\S]*?) on ([\s\S]*?)\. Nothing is pre-authorized yet: choose below what RAME may do without a card, and for how long\.$/, function (m) { return 'Autonomía y permisos: autonomía supervisada en ' + m[1] + ' (' + m[2] + '). Aún no hay nada preautorizado: elige abajo qué puede hacer RAME sin tarjeta y durante cuánto tiempo.'; }],
    [/^Full Access was turned off for ([\s\S]*?)([,;][\s\S]*)?\. Supervised autonomy: only the pre-authorizations below apply; everything else shows its card\.$/, function (m) { return 'Se desactivó el acceso total en ' + m[1] + (m[2] ? STOPPED_ES : '') + '. Autonomía supervisada: solo valen las preautorizaciones de abajo; todo lo demás muestra su tarjeta.'; }],
    [/^Pre-authorized for Missions of ([\s\S]*?) on ([\s\S]*?): Meta ([\s\S]*?)\. Each Mission's card still chooses how many \(0 by default\)\.$/, function (m) { return 'Preautorizado para las Misiones de ' + m[1] + ' (' + m[2] + '): Meta ' + m[3] + '. La tarjeta de cada Misión sigue eligiendo cuántas (0 por defecto).'; }],
    [/^Web budgets may be given to autonomous Missions of ([\s\S]*?) until ([\s\S]*?); each Mission's card sets its own budget\.$/, function (m) { return 'Las Misiones autónomas de ' + m[1] + ' pueden recibir presupuesto web hasta ' + m[2] + '; la tarjeta de cada Misión fija el suyo.'; }],
    [/^Web pre-authorized for Agent and Chat in ([\s\S]*?), every window of this workspace on ([\s\S]*?): up to (\d+) search\(es\) and (\d+) page read\(s\) without a card, until ([\s\S]*?)\.$/, function (m) { return 'Web preautorizada para el Agente y el Chat en ' + m[1] + ', todas las ventanas de este workspace en ' + m[2] + ': hasta ' + m[3] + ' búsqueda(s) y ' + m[4] + ' lectura(s) sin tarjeta, hasta ' + m[5] + '.'; }],
    [/^Full Access is on for ([\s\S]*?) on ([\s\S]*?) until ([\s\S]*?): ([\s\S]*?) run without their cards\. Project memory, privilege elevation and the Mission authorization still ask; revoke it at any time\.$/, function (m) { return 'Acceso total activado en ' + m[1] + ' (' + m[2] + ') hasta ' + m[3] + ': ' + m[4] + ' se ejecutan sin sus tarjetas. La memoria del proyecto, la elevación de privilegios y la autorización de la Misión siguen preguntando; puedes revocarlo cuando quieras.'; }],
    [/^([\s\S]*?) was revoked in every window of this workspace on ([\s\S]*?): no new operation runs under it([\s\S]*)\. Anything else shows its card\.$/, function (m) { return (REVOKED[m[1]] || m[1]) + ' quedó revocado en todas las ventanas de este workspace en ' + m[2] + ': no se ejecuta ninguna operación nueva con ello' + (m[3] ? STOPPED_ES : '') + '. Todo lo demás muestra su tarjeta.'; }],
    [/^Full Access was revoked or expired: the run that used it was stopped\. What already ran cannot be undone\.$/, function () { return 'El acceso total se revocó o caducó: se paró la ejecución que lo usaba. Lo que ya se ejecutó no puede deshacerse.'; }],
  ];
  var EXACT_HOST = {
    'Choose supervised autonomy first (or Full Access). Nothing was pre-authorized.': 'Elige primero la autonomía supervisada (o el acceso total). No se preautorizó nada.',
    'Pre-authorizing Meta needs cloud escalation ON, a saved Meta API key and a selected Meta model. Nothing was pre-authorized.': 'Preautorizar Meta necesita el escalado a la nube activado, una clave de API de Meta guardada y un modelo de Meta elegido. No se preautorizó nada.',
    'Meta was not pre-authorized: the confirmation was not accepted. Each consultation still shows its card.': 'Meta no quedó preautorizado: no se aceptó la confirmación. Cada consulta sigue mostrando su tarjeta.',
    'Web for Missions was not pre-authorized: the confirmation was not accepted.': 'La web para Misiones no quedó preautorizada: no se aceptó la confirmación.',
    'Turn on Web access first (Settings → Security → Web access). Nothing was pre-authorized.': 'Activa primero el acceso web (Ajustes → Seguridad → Acceso web). No se preautorizó nada.',
    'Web searches were not pre-authorized: the confirmation was not accepted. Each one still shows its card.': 'Las búsquedas web no quedaron preautorizadas: no se aceptó la confirmación. Cada una sigue mostrando su tarjeta.',
    'Full Access was not turned on: the confirmation was not accepted. Every card still appears as before.': 'El acceso total no se activó: no se aceptó la confirmación. Cada tarjeta sigue apareciendo como antes.',
    'Turn on cloud escalation first.': 'Activa primero el escalado a la nube.',
    'Save a Meta API key first.': 'Guarda primero una clave de API de Meta.',
  };

  if (window.RAME_I18N && typeof window.RAME_I18N.extend === 'function') {
    window.RAME_I18N.extend('es', ES);
    window.RAME_I18N.extend('es', EXACT_HOST);
    if (typeof window.RAME_I18N.extendPatterns === 'function') window.RAME_I18N.extendPatterns('es', PATTERNS);
  }

  var h = null;
  var lastData = null;
  // The Full Access radio only shows its panel: the mode changes only after the host's confirmation.
  var fullChosen = false;
  // The Mission whose card already got Full Access's default count.
  var defaultedFor = '';
  var FULL_PARTS = [['files', 'autonomyFullFiles'], ['tests', 'autonomyFullTests'], ['commands', 'autonomyFullCommands'], ['installs', 'autonomyFullInstalls'], ['jobs', 'autonomyFullJobs'], ['web', 'autonomyFullWeb'], ['meta', 'autonomyFullMeta']];
  var PART_WORDS = { files: 'workspace files', tests: 'tests', commands: 'terminal commands', installs: 'installs', jobs: 'long jobs', web: 'web', meta: 'Meta consultations' };
  var EXTRA_CONSULTS = [['10', '10'], ['100', '100'], ['1000', '1000'], ['-1', 'No count limit']];

  function el(id) {
    return document.getElementById(id);
  }
  // The parts of a Full Access grant in words, "Meta as the main model" included when it was chosen.
  function fullParts(full) {
    var words = FULL_PARTS.filter(function (p) { return full.tools[p[0]]; }).map(function (p) { return t(PART_WORDS[p[0]]); });
    if (full.mainModel) words.push(tf('Meta {0} as the main model', full.mainModel));
    return words.join(', ');
  }
  function t(text) {
    return h ? h.t(text) : text;
  }
  function tf(text) {
    var args = Array.prototype.slice.call(arguments, 1);
    return h ? h.tf.apply(null, [text].concat(args)) : text;
  }
  function th(text) {
    return h && h.tHost ? h.tHost(text) : text;
  }
  function setText(id, text) {
    var node = el(id);
    if (node) node.textContent = text;
  }
  function when(at) {
    // A grant with no expiry (Full Access until the user turns it off): "until you turn it off".
    if (at >= 8640000000000000) return t('you turn it off');
    try {
      return new Date(at).toLocaleString();
    } catch (e) {
      return String(at);
    }
  }
  function post(message) {
    if (h && h.vscode) h.vscode.postMessage(message);
  }
  function on(id, event, handler) {
    var node = el(id);
    if (node) node.addEventListener(event, handler);
  }
  function num(id, fallback, max) {
    var value = parseInt(String((el(id) || {}).value || ''), 10);
    return isNaN(value) ? fallback : Math.max(0, Math.min(max, value));
  }
  function choice(id, allowed, fallback) {
    var value = parseInt(String((el(id) || {}).value || ''), 10);
    return allowed.indexOf(value) >= 0 ? value : fallback;
  }
  var APPROVAL = { card: 'on its card', 'pre-authorized': 'pre-authorized', 'mission-grant': 'Mission grant', profile: 'permission profile', 'full-access': 'Full Access' };

  function metaText(meta) {
    var scope = t(meta.dataScope === 'files' ? 'instructions and chosen files' : 'instructions only');
    var text = meta.maxPerMission === null
      ? tf('Pre-authorized: Meta {0}, no count limit per Mission, {1}, until {2}.', meta.model, scope, when(meta.expiresAt))
      : tf('Pre-authorized: Meta {0}, up to {1} per Mission, {2}, until {3}.', meta.model, meta.maxPerMission, scope, when(meta.expiresAt));
    if (meta.tokenBudget !== null) text += tf(' Tokens: {0} of {1} used.', meta.usedTokens, meta.tokenBudget);
    return text + (meta.problem ? ' ' + tf('Not in force: {0}.', th(meta.problem)) : '');
  }

  function renderSettings(view) {
    var none = !view || view.project === null;
    setText('autonomyProject', none ? t('Open a project folder to set its Autonomy & Permissions.') : tf('Workspace: {0}.', view.project));
    setText('autonomyEnv', view && view.env ? tf('Operations run on {0}. Permissions given here apply only there: another computer or Remote SSH server has its own.', view.env) : '');
    var mode = view ? view.mode : 'ask';
    if (mode === 'full') fullChosen = false;
    var radios = { ask: el('autonomyAsk'), supervised: el('autonomySupervised'), full: el('autonomyFullMode') };
    var shown = fullChosen ? 'full' : mode;
    Object.keys(radios).forEach(function (key) {
      if (radios[key]) {
        radios[key].checked = shown === key;
        radios[key].disabled = none;
      }
    });
    var grants = el('autonomyGrants');
    if (grants) grants.hidden = none || shown === 'ask';
    var fullRow = el('autonomyFullRow');
    if (fullRow) fullRow.hidden = none || shown !== 'full';
    if (!view) return;
    var full = view.full;
    setText('autonomyFullNow', full
      ? tf('On until {0}: {1} run without their cards.', when(full.expiresAt), fullParts(full)) +
        (full.jobs > 0 ? tf(' {0} long job(s) started under it are stopped if you revoke it.', full.jobs) : '') + (full.problem ? ' ' + tf('Not in force: {0}.', th(full.problem)) : '')
      : t('Off: every card appears as the profile and each pre-authorization say.'));
    if (full) {
      FULL_PARTS.forEach(function (p) {
        var box = el(p[1]);
        if (box) box.checked = Boolean(full.tools[p[0]]);
      });
      var mainBox = el('autonomyFullMetaMain');
      if (mainBox) mainBox.checked = Boolean(full.mainModel);
    }
    var revokeFull = el('autonomyFullRevoke');
    if (revokeFull) revokeFull.disabled = !full;
    var meta = view.meta;
    setText('autonomyMetaNow', meta ? metaText(meta) : (view.metaUnavailable ? th(view.metaUnavailable) + ' ' : '') + t('Not pre-authorized: each consultation shows its card.'));
    var grantMeta = el('autonomyMetaGrant');
    if (grantMeta) grantMeta.disabled = none || view.metaUnavailable !== '';
    var revokeMeta = el('autonomyMetaRevoke');
    if (revokeMeta) revokeMeta.disabled = !meta;
    var session = view.sessionWeb;
    setText('autonomySessionNow', session
      ? tf('Every window of this workspace: {0}/{1} searches and {2}/{3} page reads used without a card, until {4}{5}.', session.searches, session.maxSearches, session.fetches, session.maxFetches, when(session.expiresAt), session.domains.length ? tf(', only on {0}', session.domains.join(', ')) : '')
      : t('Not pre-authorized: each web search or page read shows its card.'));
    var revokeWeb = el('autonomyWebRevoke');
    if (revokeWeb) revokeWeb.disabled = !session;
    var missionWeb = view.missionWeb;
    setText('autonomyMissionWebNow', missionWeb
      ? tf('Autonomous Missions may be given a web budget until {0}.', when(missionWeb.expiresAt)) + (missionWeb.problem ? ' ' + tf('Not in force: {0}.', th(missionWeb.problem)) : '')
      : t('Autonomous Missions: no web budget can be given (not pre-authorized).'));
    var revokeMissionWeb = el('autonomyMissionWebRevoke');
    if (revokeMissionWeb) revokeMissionWeb.disabled = !missionWeb;
    var all = el('autonomyRevokeAll');
    if (all) all.disabled = none;
    var list = el('autonomyLog');
    if (list) {
      while (list.firstChild) list.removeChild(list.firstChild);
      if (view.log.length === 0) {
        var empty = document.createElement('li');
        empty.textContent = t('No external request recorded for this workspace yet.');
        list.appendChild(empty);
      }
      view.log.forEach(function (entry) {
        var item = document.createElement('li');
        item.textContent = when(entry.at) + ' · ' + entry.provider + ' → ' + entry.destination + ' · ' + t(APPROVAL[entry.approval] || entry.approval) + ' · ' + entry.reason + ' · ' + entry.data + (entry.bytes !== null ? ' (' + entry.bytes + ' B)' : '') + ' · ' + entry.outcome;
        list.appendChild(item);
      });
    }
    if (view.inflight > 0) setText('autonomyProject', tf('Workspace: {0}.', view.project) + ' ' + tf('{0} operation(s) running under a pre-authorization.', view.inflight));
  }

  /** The card's choices beyond 5 (10, 100, 1000, no count limit), added once. */
  function ensureConsultOptions(select) {
    if (!select || !select.options) return;
    var have = {};
    for (var i = 0; i < select.options.length; i += 1) have[String(select.options[i].value)] = true;
    EXTRA_CONSULTS.forEach(function (entry) {
      if (have[entry[0]]) return;
      var option = document.createElement('option');
      option.value = entry[0];
      option.textContent = t(entry[1]);
      option.disabled = false;
      select.appendChild(option);
    });
  }

  function renderUnlimitedSummary(data) {
    var select = el('missionConsults');
    var summary = el('missionConsultSummary');
    if (select && summary && String(select.value) === '-1') {
      summary.textContent = tf('Selected: no count limit on Meta consultations · {0}. Each consultation keeps its byte and token limits, and this Mission its totals.', data && typeof data.cloudModel === 'string' ? data.cloudModel : 'Meta');
    }
  }

  function renderMission(data, view) {
    var live = data && data.missionLive ? data.missionLive : null;
    var consultRow = el('missionConsultRow');
    var meta = view && view.meta && !view.meta.problem ? view.meta : null;
    var parts = [];
    var scope = meta ? t(meta.dataScope === 'files' ? 'instructions and chosen files' : 'instructions only') : '';
    parts.push(meta
      ? (meta.maxPerMission === null
        ? tf('Meta without a card: no count limit per Mission is pre-authorized ({0}, until {1}); each consultation keeps its limits.', scope, when(meta.expiresAt))
        : tf('Meta without a card: up to {0} consultation(s) per Mission are pre-authorized ({1}, until {2}).', meta.maxPerMission, scope, when(meta.expiresAt)))
      : t('Meta without a card: not pre-authorized for this workspace. If the Mission stops, the consultation card shows the exact text for your approval.'));
    var fullWeb = Boolean(view && view.full && !view.full.problem && view.full.tools.web);
    parts.push((view && view.missionWeb && !view.missionWeb.problem) || fullWeb ? t('Web for an autonomous Mission: pre-authorized for this workspace.') : t('Web for an autonomous Mission: not pre-authorized, so its web budget cannot be given.'));
    if (view && view.full && !view.full.problem) parts.push(t('Full Access is on: the Mission\'s file operations and tests run without cards; this authorization card and project memory still ask.'));
    setText('missionAutonomyNote', parts.join(' '));
    var select = el('missionConsults');
    ensureConsultOptions(select);
    if (select && meta) {
      for (var i = 0; i < select.options.length; i += 1) {
        var value = Number(select.options[i].value);
        select.options[i].disabled = meta.maxPerMission === null ? false : value < 0 || value > meta.maxPerMission;
      }
      var chosen = Number(select.value);
      if (meta.maxPerMission !== null && (chosen < 0 || chosen > meta.maxPerMission)) select.value = '0';
      // Full Access with Meta: each Mission's card starts at the pre-authorized maximum (once per Mission; the user may lower it).
      var missionKey = live && live.missionId ? live.missionId : '';
      if (view.full && !view.full.problem && view.full.tools.meta && missionKey && defaultedFor !== missionKey) {
        defaultedFor = missionKey;
        select.value = meta.maxPerMission === null ? '-1' : String(meta.maxPerMission);
      }
    }
    renderUnlimitedSummary(data);
    var files = el('missionMetaFilesRow');
    var withFiles = Boolean(meta && meta.dataScope === 'files' && consultRow && !consultRow.hidden);
    if (files) files.hidden = !withFiles;
    var summary = el('missionConsultSummary');
    var hint = summary ? summary.nextElementSibling : null;
    if (hint && hint.classList && hint.classList.contains('hint')) {
      hint.textContent = t(withFiles
        ? "Advice only: the main model keeps every tool. The advisor receives the Mission instructions, the host's notes and the files you list below, never secrets or the verifier's hidden files, and cannot execute actions."
        : 'Advice only: the main model keeps every tool. The advisor receives no file contents and cannot execute actions.');
    }
    // The live indicator: this Mission has pre-authorized external access.
    var status = el('missionAutoStatus');
    var indicator = el('missionAccessIndicator');
    if (!indicator && status && status.parentNode) {
      indicator = document.createElement('p');
      indicator.id = 'missionAccessIndicator';
      indicator.className = 'hint';
      indicator.setAttribute('role', 'status');
      status.parentNode.insertBefore(indicator, status.nextSibling);
    }
    if (indicator) {
      var found = null;
      var id = live && live.missionId;
      (view ? view.missions : []).forEach(function (entry) {
        if (entry.missionId === id) found = entry;
      });
      indicator.textContent = found ? th(found.text) : '';
      indicator.hidden = !found;
    }
  }

  /** Settings → Security, at Autonomy & Permissions; with `full`, its Full Access panel (nothing changes before its confirmation). */
  function openAutonomy(full) {
    var open = el('openSettings');
    if (open && typeof open.click === 'function') open.click();
    if (window.RAME_SETTINGS_TABS) window.RAME_SETTINGS_TABS.activate('cardSecurity');
    if (full) {
      fullChosen = true;
      if (lastData) render(lastData);
    }
    var section = el(full ? 'autonomyFullRow' : 'autonomySection') || el('autonomySection');
    if (section && section.scrollIntoView) section.scrollIntoView({ block: 'start' });
    post({ type: 'autonomyRefresh' });
  }

  function closePermissionMenu() {
    var menu = el('permissionMenu');
    if (menu) menu.hidden = true;
    var btn = el('permissionBtn');
    if (btn) btn.setAttribute('aria-expanded', 'false');
  }

  // What this script added to the chat's permission button and menu, created once.
  var chatNodes = {};
  function menuItem(menu, id, handler) {
    var item = chatNodes[id];
    if (!item) {
      item = document.createElement('button');
      item.id = id;
      item.type = 'button';
      item.setAttribute('role', 'menuitem');
      item.addEventListener('click', function () {
        closePermissionMenu();
        handler();
      });
      menu.appendChild(item);
      chatNodes[id] = item;
    }
    return item;
  }

  /** The grant the Full Access panel describes now (its parts, Meta limits and validity), or null without any part. */
  function fullRequest() {
    var tools = {};
    var any = false;
    FULL_PARTS.forEach(function (p) {
      tools[p[0]] = Boolean((el(p[1]) || {}).checked);
      any = any || tools[p[0]];
    });
    var metaMain = Boolean((el('autonomyFullMetaMain') || {}).checked);
    if (!any && !metaMain) return null;
    var request = { type: 'autonomyFull', tools: tools, validityHours: choice('autonomyFullHours', [0, 1, 8, 24, 168, 720], 0) };
    // Only when chosen: no tool part implies it.
    if (metaMain) request.metaMain = true;
    // Its Meta part carries its limits: given in the same confirmation (defaults as in the markup).
    if (tools.meta) {
      request.meta = {
        maxPerMission: choice('autonomyFullMetaMax', [1, 5, 10, 100, 1000, -1], -1),
        dataScope: (el('autonomyFullMetaScope') || {}).value === 'instructions' ? 'instructions' : 'files',
        tokenBudget: choice('autonomyFullMetaBudget', [0, 100000, 1000000, 10000000], 1000000),
      };
    }
    return request;
  }

  // Full Access is the level above Workspace full in the chat's selector.
  var fullActive = false;
  // The expiry the user has already seen the notice for.
  var endedSeen = 0;
  var PROFILE_ITEMS = ['permAsk', 'permSafe', 'permFull'];
  var PROFILE_NAMES = { ask: 'Ask', 'safe-auto': 'Safe auto', 'workspace-full': 'Workspace full' };

  /**
   * The chat's permission menu: Ask → Safe auto → Workspace full → Full Access.
   * Choosing Full Access sends the grant its panel describes; the host asks
   * for its confirmation (parts, validity, environment) and only then turns
   * it on. It never raises the profile underneath (it covers only its own
   * parts): when it ends, the selector shows that profile again. A lower
   * level turns it off.
   */
  function renderChat(view) {
    var btn = el('permissionBtn');
    var menu = el('permissionMenu');
    if (!btn || !menu) return;
    var full = view && view.mode === 'full' && view.full && !view.full.problem ? view.full : null;
    var expired = !full && view && view.full && /^the Full Access expired/.test(view.full.problem || '') && view.full.expiresAt !== endedSeen ? view.full : null;
    fullActive = Boolean(full);
    var chip = chatNodes.autonomyFullChip;
    if (!chip) {
      chip = document.createElement('span');
      chip.id = 'autonomyFullChip';
      chip.className = 'chip';
      btn.appendChild(chip);
      chatNodes.autonomyFullChip = chip;
    }
    chip.textContent = full ? t('Full Access') : t('Full Access expired');
    chip.hidden = !full && !expired;
    // While it is in force the button names Full Access alone, not the profile underneath.
    var profileChip = el('permissionChip');
    if (profileChip) profileChip.hidden = Boolean(full);
    var label = full
      ? t('Agent permission') + ' · ' + tf('Full Access is on until {0}: {1} run without their cards. Choose a lower level to turn it off.', when(full.expiresAt), fullParts(full))
      : expired ? t('Agent permission') + ' · ' + tf('Full Access expired: the permission is back to {0}.', t(PROFILE_NAMES[lastData && lastData.agentProfile] || 'Ask')) : t('Agent permission');
    btn.title = label;
    btn.setAttribute('aria-label', label);
    // Created once: the handler reads the latest state, never this render's.
    var level = menuItem(menu, 'permFullAccess', function () {
      if (fullActive) return;
      var now = lastData && lastData.remote ? lastData.remote.autonomy : null;
      var request = now && now.project ? fullRequest() : null;
      if (request) post(request);
      else openAutonomy(true);
    });
    level.setAttribute('role', 'menuitemradio');
    level.setAttribute('aria-checked', full ? 'true' : 'false');
    level.textContent = full
      ? tf('Full Access — on until {0}; choose a lower level to turn it off.', when(full.expiresAt))
      : t('Full Access — no cards for the parts you choose; asks for confirmation.');
    menuItem(menu, 'permFullAccessParts', function () { openAutonomy(true); }).textContent = t('Full Access parts and duration…');
    // main.js marks the profile after this render: un-mark it while Full Access is the level in force.
    if (full) {
      Promise.resolve().then(function () {
        PROFILE_ITEMS.forEach(function (id) {
          var item = el(id);
          if (item) item.setAttribute('aria-checked', 'false');
        });
      });
    }
  }

  /** A lower level chosen while Full Access is in force turns it off (after main.js has sent the profile). */
  function lowerLevel() {
    if (!fullActive) return;
    fullActive = false;
    setTimeout(function () { post({ type: 'autonomyRevoke', what: 'full' }); }, 0);
  }

  function render(data) {
    lastData = data;
    var view = data && data.remote ? data.remote.autonomy : null;
    renderSettings(view || null);
    renderMission(data, view || null);
    renderChat(view || null);
  }

  function init(helpers) {
    h = helpers;
    // The Mission's Meta files travel just before main.js sends the authorization (capture phase runs first).
    document.addEventListener('click', function (event) {
      var start = el('missionStart');
      if (!start || event.target !== start || !lastData || !lastData.missionLive || !lastData.missionLive.missionId) return;
      var row = el('missionMetaFilesRow');
      var raw = row && !row.hidden ? String((el('missionMetaFiles') || {}).value || '') : '';
      post({ type: 'missionMetaScopeSet', missionId: lastData.missionLive.missionId, files: raw.split(',').map(function (f) { return f.trim(); }).filter(Boolean).slice(0, 8) });
    }, true);
    on('autonomyAsk', 'change', function () {
      fullChosen = false;
      if (el('autonomyAsk').checked) post({ type: 'autonomyMode', mode: 'ask' });
    });
    on('autonomySupervised', 'change', function () {
      fullChosen = false;
      if (el('autonomySupervised').checked) post({ type: 'autonomyMode', mode: 'supervised' });
    });
    on('autonomyFullMode', 'change', function () {
      // Only shows what Full Access would cover; nothing changes before its confirmation.
      fullChosen = Boolean(el('autonomyFullMode').checked);
      if (lastData) render(lastData);
    });
    on('autonomyFullGrant', 'click', function () {
      var request = fullRequest();
      if (!request) {
        setText('autonomyFullNow', t('Choose at least one part for Full Access.'));
        return;
      }
      post(request);
    });
    // The chat's lower levels and the Settings profile list turn Full Access off.
    PROFILE_ITEMS.forEach(function (id) { on(id, 'click', lowerLevel); });
    on('profileSelect', 'change', lowerLevel);
    // Opening the menu acknowledges the expiry notice.
    on('permissionBtn', 'click', function () {
      var view = lastData && lastData.remote ? lastData.remote.autonomy : null;
      if (view && view.full && view.full.problem) {
        endedSeen = view.full.expiresAt;
        renderChat(view);
      }
    });
    on('autonomyFullRevoke', 'click', function () { post({ type: 'autonomyRevoke', what: 'full' }); });
    on('autonomyMetaGrant', 'click', function () {
      post({
        type: 'autonomyMeta',
        maxPerMission: choice('autonomyMetaMax', [1, 2, 3, 4, 5, 10, 100, 1000, -1], 1),
        validityHours: choice('autonomyMetaHours', [1, 8, 24, 168, 720], 8),
        dataScope: (el('autonomyMetaScope') || {}).value === 'files' ? 'files' : 'instructions',
        tokenBudget: choice('autonomyMetaBudget', [0, 100000, 1000000, 10000000], 0),
      });
    });
    on('autonomyMetaRevoke', 'click', function () { post({ type: 'autonomyRevoke', what: 'meta' }); });
    on('autonomyWebGrant', 'click', function () {
      post({
        type: 'autonomySessionWeb',
        maxSearches: num('autonomyWebSearches', 5, 20),
        maxFetches: num('autonomyWebFetches', 10, 40),
        domains: String((el('autonomyWebDomains') || {}).value || '').split(',').map(function (d) { return d.trim(); }).filter(Boolean).slice(0, 20),
        validityHours: choice('autonomyWebHours', [1, 8, 24, 168, 720], 1),
      });
    });
    on('autonomyWebRevoke', 'click', function () { post({ type: 'autonomyRevoke', what: 'sessionWeb' }); });
    on('autonomyMissionWebGrant', 'click', function () { post({ type: 'autonomyMissionWeb', validityHours: choice('autonomyMissionWebHours', [1, 8, 24, 168, 720], 8) }); });
    on('autonomyMissionWebRevoke', 'click', function () { post({ type: 'autonomyRevoke', what: 'missionWeb' }); });
    on('autonomyRevokeAll', 'click', function () { post({ type: 'autonomyRevoke', what: 'all' }); });
    // After remoteUx's own listener (registered first): the summary of "no count limit".
    on('missionConsults', 'change', function () { renderUnlimitedSummary(lastData); });
    // From the authorization card to Settings → Security, at this section.
    on('missionAutonomyOpen', 'click', function () { openAutonomy(false); });
    var security = el('cardSecurity');
    if (security) security.addEventListener('toggle', function () {
      if (security.open) post({ type: 'autonomyRefresh' });
    });
    post({ type: 'autonomyRefresh' });
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
