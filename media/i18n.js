/* RAME Code interface translations. English is the source language. Model
 * prompts, approval digests and host records stay English. Unknown text is
 * shown unchanged; captured pattern values are kept verbatim. */
(function () {
  'use strict';

  var ES = {
    // Header, threads, conversation
    'RAME Code actions': 'Acciones de RAME Code',
    'New thread': 'Nuevo hilo',
    'Refresh history': 'Actualizar historial',
    'Open Settings': 'Abrir ajustes',
    'Working…': 'Trabajando…',
    'Running…': 'Ejecutando…',
    'Thread list': 'Lista de hilos',
    'Threads': 'Hilos',
    'Back to thread list': 'Volver a la lista de hilos',
    'Conversation': 'Conversación',
    'Checking…': 'Comprobando…',
    'Scope / boundaries': 'Alcance / límites',
    'No thread yet. Start a new Agent thread below.': 'Aún no hay hilo. Empieza uno nuevo del Agente abajo.',
    'Activity': 'Actividad',
    'Result': 'Resultado',
    'Cloud escalation': 'Escalado a la nube',
    'Dismiss': 'Descartar',
    'Pending approval — review exact action': 'Aprobación pendiente — revisa la acción exacta',
    'Approve action': 'Aprobar acción',
    'Reject': 'Rechazar',
    'Run details': 'Detalles de la ejecución',
    'Starting…': 'Iniciando…',
    'Action log': 'Registro de acciones',
    'Message': 'Mensaje',
    'Describe the software goal.': 'Describe el objetivo de software.',
    'Workspace-full is high risk: patches and allowlisted tests run without prompts.':
      'Acceso total es de alto riesgo: los parches y las pruebas permitidas se ejecutan sin preguntar.',
    'Composer controls': 'Controles del mensaje',
    'Add context (coming later)': 'Añadir contexto (próximamente)',
    'Agent permission': 'Permiso del Agente',
    'Ask': 'Preguntar',
    'Safe auto': 'Auto seguro',
    'Workspace full': 'Acceso total',
    'Open Settings to change runtime': 'Abre Ajustes para cambiar el motor',
    'Runtime: open Settings to change': 'Motor: abre Ajustes para cambiarlo',
    'Runtime: Meta Model API — Cloud': 'Motor: Meta Model API — Nube',
    'Mode': 'Modo',
    'Agent': 'Agente',
    'Mission': 'Misión',
    'Chat': 'Chat',
    'Send message': 'Enviar mensaje',
    'Stop current run': 'Detener la ejecución actual',
    'Ask — every tool action needs approval.': 'Preguntar — cada acción de herramienta necesita tu aprobación.',
    'Safe auto — reads run automatically; writes and tests need approval.':
      'Auto seguro — las lecturas van solas; escrituras y pruebas necesitan aprobación.',
    'Workspace full — high risk: reads, patches, and allowlisted tests run without prompts.':
      'Acceso total — alto riesgo: lecturas, parches y pruebas permitidas se ejecutan sin preguntar.',
    'Permission profile': 'Perfil de permisos',
    'Shield': 'Escudo',
    'Permission': 'Permiso',
    'Agent permission profile': 'Perfil de permisos del Agente',
    'Ask (safest)': 'Preguntar (lo más seguro)',
    'Security / boundaries': 'Seguridad / límites',
    'Agent works only inside the active workspace. Symlink and path escapes are blocked; .git, .env files, credential and key material, secret stores, auth files, and repository control files are protected. Tests run only from an exact derived allowlist with shell:false and no arbitrary shell tool; allowlisted package scripts still execute with your OS permissions and may access files, network, or shells. Ask and Safe-auto require approval before they run, while Workspace-full may run them without prompting and is high risk. Cloud work needs your existing escalation consent and never switches providers silently. Tamper resistance is not claimed.':
      'El Agente trabaja solo dentro del workspace activo. Se bloquean las salidas por enlaces simbólicos y rutas; .git, los ficheros .env, credenciales y claves, almacenes de secretos, ficheros de autenticación y de control del repositorio están protegidos. Las pruebas solo se ejecutan desde una lista exacta derivada, con shell:false y sin herramienta de shell arbitraria; los scripts permitidos siguen ejecutándose con tus permisos del sistema y pueden acceder a ficheros, red o shells. Preguntar y Auto seguro piden aprobación antes de ejecutarlos; Acceso total puede ejecutarlos sin preguntar y es de alto riesgo. El trabajo en la nube necesita tu consentimiento de escalado y nunca cambia de proveedor en silencio. No se afirma resistencia a manipulaciones.',
    'Workspace-full is high risk: patches and allowlisted tests run without prompts. First Agent coding validation must target a disposable copy or test fixture, not the live RAME Code repository.':
      'Acceso total es de alto riesgo: los parches y las pruebas permitidas se ejecutan sin preguntar. La primera validación del Agente debe hacerse sobre una copia desechable o un fixture de pruebas, no sobre el repositorio real de RAME Code.',

    // Settings
    'Settings': 'Ajustes',
    'Settings actions': 'Acciones de ajustes',
    'Back to Chat': 'Volver al chat',
    '← Back': '← Volver',
    'Models': 'Modelos',
    'Interface': 'Interfaz',
    'Language': 'Idioma',
    'Interface language. Requests to models stay in English.': 'Idioma de la interfaz. Las peticiones a los modelos siguen en inglés.',
    'Runtime': 'Motor',
    'Meta Model API — Cloud': 'Meta Model API — Nube',
    'Muse Glimmer — Local': 'Muse Glimmer — Local',
    'One provider only. Change it here; the Chat screen shows a read-only status.':
      'Un solo proveedor. Se cambia aquí; la pantalla de chat solo muestra el estado.',
    'Generation': 'Generación',
    'Reasoning effort': 'Esfuerzo de razonamiento',
    'Model default': 'Por defecto del modelo',
    'Minimal': 'Mínimo',
    'Low': 'Bajo',
    'Medium': 'Medio',
    'High': 'Alto',
    'XHigh': 'Muy alto',
    'Max': 'Máximo',
    'Local maximum (empty = automatic)': 'Máximo local (vacío = automático)',
    'Meta maximum (empty = automatic)': 'Máximo de Meta (vacío = automático)',
    'Automatic': 'Automático',
    'Save maximums': 'Guardar máximos',
    "Reasoning effort, output budget, context window, and the Agent's 12-step budget are separate settings. The output budget covers reasoning plus the visible reply and is lowered to fit the free context; your input is never cut to make room. Changes apply from the next request; a request already in progress keeps its settings.":
      'El esfuerzo de razonamiento, el presupuesto de salida, la ventana de contexto y el límite de 12 pasos del Agente son ajustes distintos. El presupuesto de salida cubre el razonamiento y la respuesta visible y se reduce para caber en el contexto libre; tu entrada nunca se recorta para hacer sitio. Los cambios se aplican desde la siguiente petición; una petición en curso conserva sus ajustes.',

    // Project memory
    'Project memory': 'Memoria del proyecto',
    'Used automatically by Agent and Mission.': 'Se usa automáticamente en Agente y Misión.',
    'Approved decisions for the working folder are added automatically. Nothing needs to be selected here.': 'Las decisiones aprobadas de la carpeta de trabajo se añaden automáticamente. No necesitas seleccionar nada aquí.',
    'View another open folder': 'Ver otra carpeta abierta',
    'Choose a folder…': 'Elige una carpeta…',
    'This only changes this Settings view; it never changes a thread or merges memories.': 'Esto solo cambia esta vista de Ajustes; nunca cambia un hilo ni mezcla memorias.',
    'No folder selected for this Settings view.': 'Ninguna carpeta seleccionada para esta vista de Ajustes.',
    'Memory shown for: {0}': 'Memoria mostrada de: {0}',
    'Pending memory change — review the exact change': 'Cambio de memoria pendiente — revisa el cambio exacto',
    'Approve this change': 'Aprobar este cambio',
    'Decisions in force': 'Decisiones vigentes',
    'Verified files': 'Archivos verificados',
    'History': 'Historial',
    'Advanced: add a decision manually': 'Avanzado: añadir una decisión manualmente',
    'Key': 'Clave',
    'Type': 'Tipo',
    'Value type': 'Tipo de valor',
    'Number': 'Número',
    'True / false': 'Verdadero / falso',
    'Text': 'Texto',
    'Value': 'Valor',
    'Review change': 'Revisar cambio',
    'Preparing…': 'Preparando…',
    'Saving…': 'Guardando…',
    'Rejecting…': 'Rechazando…',
    'Approving…': 'Aprobando…',
    'Loading…': 'Cargando…',
    'Enter a key and a value first.': 'Escribe primero una clave y un valor.',
    'Only a change you approve here or in an Agent approval card is saved. Each change is a new version; earlier versions stay in the history. Repository files, tool output, and model text never change memory.':
      'Solo se guarda un cambio que apruebes aquí o en una tarjeta de aprobación del Agente. Cada cambio es una versión nueva; las anteriores quedan en el historial. Los ficheros del repositorio, la salida de herramientas y el texto del modelo nunca cambian la memoria.',
    'No decisions yet.': 'Aún no hay decisiones.',
    'No verified files yet.': 'Aún no hay archivos verificados.',
    'you': 'ti',
    'Meta cloud model': 'el modelo de Meta en la nube',
    'local model': 'el modelo local',
    'current': 'al día',
    'STALE': 'DESFASADO',
    'changed since verified': 'cambiado desde la verificación',
    'missing': 'no existe',
    'decision removed': 'decisión eliminada',
    'not checked': 'sin comprobar',
    'Entered in Settings.': 'Introducido en Ajustes.',

    // Mission
    'No Mission for this project. Create one with a Mission plan.': 'No hay Misión para este proyecto. Crea una con un plan de Misión.',
    'Mission tasks': 'Tareas de la Misión',
    'Evidence': 'Evidencias',
    'Run task': 'Ejecutar tarea',
    'active': 'activa',
    'waiting for your approval': 'esperando tu aprobación',
    'interrupted': 'interrumpida',
    'completed': 'completada',
    'failed': 'fallida',
    'done': 'hecha',
    'pending': 'pendiente',

    // Cloud
    'Cloud': 'Nube',
    'Meta Model API key': 'Clave de Meta Model API',
    'Enter a separate Meta Model API key': 'Introduce una clave propia de Meta Model API',
    'Save key': 'Guardar clave',
    'Clear key': 'Borrar clave',
    'Test connection': 'Probar conexión',
    'Testing…': 'Comprobando…',
    'Muse Code subscription credentials are not reused. Sent to the extension host only when you click Save key. Stored only in VS Code SecretStorage; this view only ever learns whether a key exists.':
      'No se reutilizan las credenciales de la suscripción de Muse Code. La clave solo se envía al host de la extensión cuando pulsas Guardar clave. Se guarda solo en SecretStorage de VS Code; esta vista solo sabe si existe una clave.',
    'Available compatible Meta models': 'Modelos de Meta compatibles disponibles',
    'Cloud model': 'Modelo en la nube',
    'Refresh available models': 'Actualizar modelos disponibles',
    'Loading models…': 'Cargando modelos…',
    'Fallback catalog. Save a key or refresh to load live models.': 'Catálogo de reserva. Guarda una clave o actualiza para cargar los modelos reales.',
    'Only muse-spark and muse-wonder chat models are shown, newest-first as returned. Contributor variants are labeled Contributor (data may be used) and are never selected silently.':
      'Solo se muestran los modelos de chat muse-spark y muse-wonder, del más nuevo al más antiguo. Las variantes Contributor se marcan como Contributor (los datos pueden usarse) y nunca se eligen en silencio.',

    // Local runtime
    'Local runtime': 'Motor local',
    'Local runtime is stopped.': 'El motor local está parado.',
    'Local runtime is starting…': 'El motor local está arrancando…',
    'Local runtime is stopping…': 'El motor local se está deteniendo…',
    'llama-server executable path': 'Ruta del ejecutable llama-server',
    'Model path (GGUF)': 'Ruta del modelo (GGUF)',
    'Multimodal projector path (optional)': 'Ruta del proyector multimodal (opcional)',
    'DFlash / draft-model path (optional)': 'Ruta de DFlash / modelo borrador (opcional)',
    'Model / display ID': 'ID del modelo / nombre visible',
    'Context size': 'Tamaño de contexto',
    'Port (loopback only)': 'Puerto (solo loopback)',
    'Idle timeout (minutes, 0 disables)': 'Apagado por inactividad (minutos, 0 lo desactiva)',
    'External loopback endpoint (optional, not owned)': 'Endpoint loopback externo (opcional, no gestionado)',
    'Use detected settings': 'Usar ajustes detectados',
    'Save': 'Guardar',
    'Start Muse Glimmer': 'Iniciar Muse Glimmer',
    'Starting': 'Arrancando',
    'Running': 'En marcha',
    'Stop': 'Detener',
    'Stopping': 'Deteniendo',
    'Stopping…': 'Deteniendo…',
    'Use external endpoint': 'Usar endpoint externo',
    'Clear external endpoint': 'Quitar endpoint externo',
    "Bound to 127.0.0.1 and launched without a shell. Closing a terminal does not stop it. Timeout 0 keeps it running while VS Code stays open; reloading or closing VS Code stops RAME Code's server.":
      'Escucha solo en 127.0.0.1 y se inicia sin shell. Cerrar una terminal no lo detiene. El valor 0 lo mantiene activo mientras VS Code siga abierto; recargar o cerrar VS Code detiene el servidor de RAME Code.',
    'Escalation': 'Escalado',
    'Allow cloud escalation': 'Permitir escalado a la nube',
    'Default OFF. There is no silent fallback: when local work fails, the Chat screen offers a visible choice and only your explicit approval sends the current request to Meta.':
      'Desactivado por defecto. No hay alternativa silenciosa: si falla el trabajo local, el chat te ofrece una opción visible y solo tu aprobación explícita envía la petición actual a Meta.',
    'Privacy / Security': 'Privacidad / seguridad',
    'The API key stays in VS Code SecretStorage and this view receives only true/false. Agent and Chat send recent active-thread history and may recover a bounded set of relevant older excerpts. Other threads are never sent. When moving from local to Meta, extra older excerpts and host records stay local. Mission planning sends only your new message. Agent may read and change active-workspace files and run allowlisted tests only under the selected permission profile and policy boundary. Meta Billing/Usage is authoritative for cost; token counts below are observed usage, and any dollar figure is an estimate.':
      'La clave queda en SecretStorage y esta vista solo recibe verdadero/falso. Agente y Chat envían el historial reciente del hilo activo y pueden recuperar extractos antiguos relevantes y acotados. Nunca se envían otros hilos. Al pasar de local a Meta, los extractos y registros antiguos adicionales permanecen locales. La planificación de Misión solo envía el mensaje nuevo. El Agente actúa en el workspace con el perfil y la política elegidos. Meta Billing/Usage es la referencia del coste; los tokens son uso observado y cualquier cifra en dólares es estimada.',
    'Diagnostics': 'Diagnóstico',
    'No diagnostics.': 'Sin diagnóstico.',

    // Turns, cards, connection
    'You': 'Tú',
    'Assistant': 'Asistente',
    'Plan': 'Plan',
    'Assumptions': 'Supuestos',
    'Steps': 'Pasos',
    'Risks': 'Riesgos',
    'Cancelled': 'Cancelado',
    'Action cancelled': 'Acción cancelada',
    'Run stopped': 'Ejecución detenida',
    'Open Settings to start the local model': 'Abre Ajustes para iniciar el modelo local',
    'Unsupported turn.': 'Turno no admitido.',
    'Request failed.': 'La petición falló.',
    'No threads yet.': 'Aún no hay hilos.',
    'Untitled': 'Sin título',
    'Delete thread': 'Borrar hilo',
    'Delete this thread?': '¿Borrar este hilo?',
    'Delete': 'Borrar',
    'Deleting…': 'Borrando…',
    'Cancel': 'Cancelar',
    'Host record, verified by RAME Code': 'Registro del host, verificado por RAME Code',
    'Host record — verified by RAME Code, not written by the model': 'Registro del host — verificado por RAME Code, no escrito por el modelo',
    'Not connected — API key required': 'Sin conexión — hace falta una clave de API',
    'Key stored — live connection not yet verified': 'Clave guardada — conexión aún sin verificar',
    'Connection verified — Meta API responded in this session': 'Conexión verificada — Meta API respondió en esta sesión',
    'Plan ready': 'Plan listo',
    'Connected — verified': 'Conectado — verificado',
    'Error': 'Error',
    'Waiting for your approval': 'Esperando tu aprobación',
    'Completed': 'Completado',
    'the run stopped.': 'la ejecución se detuvo.',
    'no workspace open': 'ningún workspace abierto',
    'unknown': 'desconocido',
    'Last call': 'Última llamada',
    'Cloud total': 'Total nube',
    'Local total': 'Total local',
    ' (Meta Billing/Usage is authoritative; no balance is shown.)': ' (Meta Billing/Usage es la referencia; no se muestra saldo.)',
    'Ask (safest) — every tool action needs your approval.': 'Preguntar (lo más seguro) — cada acción de herramienta necesita tu aprobación.',
    'Workspace full (high risk) — reads, patches, and allowlisted tests run without prompts.':
      'Acceso total (alto riesgo) — lecturas, parches y pruebas permitidas se ejecutan sin preguntar.',
    'The local model is not running. Start Muse Glimmer, choose Meta Model API, or configure an external OpenAI-compatible loopback server.':
      'El modelo local no está en marcha. Inicia Muse Glimmer, elige Meta Model API o configura un servidor loopback externo compatible con OpenAI.',
    'human': 'aprobada por ti',
    'profile-auto': 'automática por perfil',
    'rejected': 'rechazada',
    'policy': 'bloqueada por la política',

    // Templates of the view: {0}, {1}… are filled with values as they are.
    'Updated {0}': 'Actualizado {0}',
    'Success criterion: {0}': 'Criterio de éxito: {0}',
    'Open thread {0}': 'Abrir hilo {0}',
    'Delete thread {0}': 'Borrar hilo {0}',
    'Confirm deletion of {0}': 'Confirmar el borrado de {0}',
    'Confirm delete {0}': 'Confirmar el borrado de {0}',
    'Cancel delete {0}': 'Cancelar el borrado de {0}',
    '{0}: in {1} / out {2} / cached {3} / total {4}': '{0}: entrada {1} / salida {2} / caché {3} / total {4}',
    'Meta Model API — Cloud ({0})': 'Meta Model API — Nube ({0})',
    'Runtime: {0}': 'Motor: {0}',
    'Tool: {0}': 'Herramienta: {0}',
    'Targets: {0}': 'Objetivos: {0}',
    'Exact action: {0}': 'Acción exacta: {0}',
    'Provider: {0} | Workspace: {1} | Thread: {2} | Digest: {3} — approval is one-use and hash-bound; the host verifies before running.':
      'Proveedor: {0} | Workspace: {1} | Hilo: {2} | Digest: {3} — la aprobación es de un solo uso y va ligada al hash; el host la verifica antes de ejecutar.',
    'Pending approval: {0}': 'Aprobación pendiente: {0}',
    'Targets: {0} | Digest: {1}': 'Objetivos: {0} | Digest: {1}',
    'Live catalog: {0} compatible model(s).': 'Catálogo real: {0} modelo(s) compatible(s).',
    'Fallback catalog: {0} compatible model(s).': 'Catálogo de reserva: {0} modelo(s) compatible(s).',
    'Save a key or refresh to load live models.': 'Guarda una clave o actualiza para cargar los modelos reales.',
    'Local runtime: running — {0}': 'Motor local: en marcha — {0}',
    'Local runtime: starting — {0}': 'Motor local: arrancando — {0}',
    'Local runtime: external endpoint — {0}': 'Motor local: endpoint externo — {0}',
    '{0} · {1} · context {2} per request.': '{0} · {1} · contexto por petición: {2}.',
    'Sent as {0}. Model default sends no level (default: {1}). Reasoning cannot be turned off for this model.':
      'Se envía como {0}. «Por defecto del modelo» no envía ningún nivel (por defecto: {1}). En este modelo el razonamiento no se puede desactivar.',
    'No verified reasoning control for this model ({0}), so only Model default is offered.':
      'No hay control de razonamiento verificado para este modelo ({0}), así que solo se ofrece «Por defecto del modelo».',
    'Your saved level {0} does not apply here; Model default is used.': 'Tu nivel guardado ({0}) no se aplica aquí; se usa «Por defecto del modelo».',
    'Automatic: {0} for {1}, lowered to fit the free context. A manual maximum replaces it for that provider only.':
      'Automático: {0} para {1}, reducido para caber en el contexto libre. Un máximo manual lo sustituye solo para ese proveedor.',
    'Project: {0}': 'Proyecto: {0}',
    '{0} = {1} — v{2}, approved {3}, proposed by {4}': '{0} = {1} — v{2}, aprobada el {3}, propuesta por {4}',
    '{0} — stored history failed validation; not used and not changeable.': '{0} — el historial guardado no pasó la validación; no se usa ni se puede cambiar.',
    'v{0} = {1} — {2}, proposed by {3}': 'v{0} = {1} — {2}, propuesta por {3}',
    '(removed)': '(eliminada)',
    '{0} — {1}. {2} task(s) left; {3} of {4} runs used.': '{0} — {1}. Quedan {2} tarea(s); {3} de {4} ejecuciones usadas.',
    'in progress': 'en curso',
    '({0} run(s))': '({0} ejecución(es))',
    '(now v{0})': '(ahora v{0})',
    'Decisions used: {0}.': 'Decisiones usadas: {0}.',
    'Decisions used: none.': 'Decisiones usadas: ninguna.',
    'Resume task: {0}': 'Reanudar tarea: {0}',
    'Run task: {0}': 'Ejecutar tarea: {0}',

    // Conversation and modes
    'Chat only': 'Chat puro',
    'Recommended: talks naturally and uses tools when they are needed.': 'Recomendado: conversa con naturalidad y usa herramientas cuando hacen falta.',
    'Conversation only, with no tools and no file access.': 'Solo conversación, sin herramientas ni acceso a archivos.',
    'Multi-task work with a plan that can be resumed.': 'Trabajo en varias tareas con un plan que se puede reanudar.',
    'Mode changed to {0} for this message. The permission profile did not change.': 'Modo cambiado a {0} para este mensaje. El perfil de permisos no ha cambiado.',
    'Read-only activity verified by RAME Code ({0})': 'Lecturas verificadas por RAME Code ({0})',

    // Autonomous Mission (R9)
    'paused': 'pausada',
    'cancelled': 'cancelada',
    'blocked': 'bloqueada',
    'Permission for this Mission': 'Permiso para esta Misión',
    'Supervised: every write and test asks': 'Supervisada: cada escritura y prueba pregunta',
    'Autonomous workspace: edits and allowlisted tests run without asking': 'Workspace autónomo: ediciones y pruebas permitidas sin preguntar',
    'Authorize and start': 'Autorizar e iniciar',
    'Acceptance check': 'Comprobación de aceptación',
    'None': 'Ninguna',
    'With an acceptance check, RAME Code blocks its own tools from changing node_modules. node_modules is not hashed: test scripts, other processes, or you can still change the dependencies.':
      'Con una comprobación de aceptación, RAME bloquea a sus propias herramientas para que no modifiquen node_modules. node_modules no se verifica por hash: los scripts de prueba, otros procesos o tú mismo podéis seguir cambiando las dependencias.',
    'Acceptance check: {0} (frozen: {1})': 'Comprobación de aceptación: {0} (congelada: {1})',
    'No acceptance check: completion means the project and agent tests passed': 'Sin comprobación de aceptación: completada significa que pasaron las pruebas del proyecto y del agente',
    'I trust this project (required for autonomous workspace)': 'Confío en este proyecto (necesario para el workspace autónomo)',
    'Not a sandbox: test scripts run with your user permissions and can reach other files, the network, or other processes. RAME Code only checks the paths its own tools use. Use autonomous workspace only for a project you trust.':
      'No es un sandbox: los scripts de prueba se ejecutan con tus permisos de usuario y pueden llegar a otros archivos, a la red o a otros procesos. RAME Code solo comprueba las rutas que usan sus propias herramientas. Usa el workspace autónomo solo en proyectos de confianza.',
    'The permission covers only this Mission, this project, and the local model. Autonomous workspace never leaves the project through RAME\'s tools, never touches .git, .env, keys, or credentials, runs no shell, runs only the allowlisted tests of the current package.json (a changed package.json asks again), and still asks before deleting, moving, or changing project memory.':
      'El permiso cubre solo esta Misión, este proyecto y el modelo local. El workspace autónomo nunca sale del proyecto mediante las herramientas de RAME, nunca toca .git, .env, claves ni credenciales, no ejecuta shell, solo ejecuta las pruebas permitidas del package.json actual (si cambia, vuelve a preguntar) y sigue preguntando antes de borrar, mover o cambiar la memoria del proyecto.',
    'Autonomous workspace is only for a project you mark as trusted: its test scripts run with your permissions and RAME Code is not an operating-system sandbox.':
      'El workspace autónomo es solo para proyectos que marques como de confianza: sus scripts de prueba se ejecutan con tus permisos y RAME Code no es un sandbox del sistema operativo.',
    'Pause': 'Pausar',
    'Resume': 'Reanudar',
    'Cancel Mission': 'Cancelar Misión',
    'RAME Code chains bounded internal runs (12 model steps each) by itself and saves a checkpoint after each. A task is done only when an allowlisted test passes after its last change; several runs in a row without verifiable progress stop the Mission as blocked. A reload never repeats an action whose result is unknown.':
      'RAME Code encadena por sí solo ejecuciones internas acotadas (12 pasos del modelo cada una) y guarda un punto de control tras cada una. Una tarea solo termina cuando una prueba permitida pasa después de su último cambio; varias ejecuciones seguidas sin progreso verificable detienen la Misión como bloqueada. Una recarga nunca repite una acción de resultado desconocido.',
    'Permission: {0}': 'Permiso: {0}',
    'autonomous workspace': 'workspace autónomo',
    'supervised': 'supervisada',
    'Model: {0}': 'Modelo: {0}',
    'Internal run {0}': 'Ejecución interna {0}',
    'Step {0}/{1}': 'Paso {0}/{1}',
    'Elapsed {0}': 'Tiempo {0}',
    'Last progress: {0}': 'Último progreso: {0}',
    'Last test: {0}': 'Última prueba: {0}',
    'Meta consultations: {0}/{1} ({2})': 'Consultas a Meta: {0}/{1} ({2})',
    'Meta consultations: none': 'Consultas a Meta: ninguna',
    'Internal Mission run {0}': 'Ejecución interna de la Misión {0}',
    'This Mission is running in another VS Code window.': 'Esta Misión se está ejecutando en otra ventana de VS Code.',
    'Authorize the Mission before running it.': 'Autoriza la Misión antes de ejecutarla.',
    'Paused by you. Nothing runs until you resume it.': 'Pausada por ti. No se ejecuta nada hasta que la reanudes.',
    'Cancelled by you. It will not run again.': 'Cancelada por ti. No volverá a ejecutarse.',
    'Pausing the Mission…': 'Pausando la Misión…',
    'Cancelling the Mission…': 'Cancelando la Misión…',

    // Mission card, Settings cards, About
    'The Agent changed files without running the test; asking it to run the test now…': 'El Agente cambió ficheros sin ejecutar la prueba; se le pide que la ejecute ahora…',
    'Tests: RAME Code currently runs only the package.json scripts of a Node/npm project (test, check, compile, lint, typecheck). In a project without them, the Agent can still edit, but a Mission cannot verify its tasks and will not complete.': 'Pruebas: por ahora RAME Code solo ejecuta los scripts de package.json de un proyecto Node/npm (test, check, compile, lint, typecheck). En un proyecto sin ellos, el Agente puede editar, pero una Misión no puede verificar sus tareas y no se completará.',
    'Working with the local runtime…': 'Trabajando con el motor local…',
    'Mission blocked': 'Misión bloqueada',
    'Review': 'Revisar',
    'Retry with guidance': 'Reintentar con indicaciones',
    'Mission record': 'Registro de la Misión',
    'Guidance for the next runs': 'Indicaciones para las próximas ejecuciones',
    'For example: change only the return line of checkUserStatement, then run npm:test.': 'Por ejemplo: cambia solo la línea de retorno de checkUserStatement y después ejecuta npm:test.',
    'Retry': 'Reintentar',
    'Internal runs': 'Ejecuciones internas',
    'Tests not run': 'Pruebas no ejecutadas',
    'Write what the Agent should do differently.': 'Escribe qué debe hacer el Agente de otra forma.',
    'Retrying…': 'Reintentando…',
    'Only a blocked Mission can be retried with guidance.': 'Solo se puede reintentar con indicaciones una Misión bloqueada.',
    'The Agent stopped without a change or a test; asking it to act with the steps left…': 'El Agente se detuvo sin cambios ni pruebas; se le pide que actúe con los pasos que quedan…',
    'Public version': 'Versión pública',
    'Author': 'Autor',
    'Repository': 'Repositorio',
    'Verification level': 'Nivel de verificación',
    'Standard Mission': 'Misión estándar',
    'The project\'s normal tests decide when each task is done.': 'Las pruebas normales del proyecto deciden cuándo está terminada cada tarea.',
    'Verified Mission': 'Misión verificada',
    'Files that define it': 'Ficheros que la definen',
    'Filter files': 'Filtrar ficheros',
    'acceptance/': 'acceptance/',
    'Acceptance files': 'Ficheros de aceptación',
    'Advanced verification': 'Verificación avanzada',
    'Final report': 'Informe final',
    'No sandbox: test scripts ran with your user permissions and could reach other files, the network, or other processes.': 'Sin sandbox: los scripts de prueba se ejecutaron con tus permisos de usuario y podían llegar a otros archivos, a la red o a otros procesos.',
    'Settings sections': 'Secciones de Ajustes',
    'General': 'General',
    'Security': 'Seguridad',
    'Advanced': 'Avanzado',
    'About': 'Acerca de',
    'Maximum output tokens': 'Máximo de tokens de salida',
    'Version': 'Versión',
    'A candidate is a build for testing. A release is a clean build of the tagged public version.': 'Una candidata es una compilación para pruebas. Una versión publicada es una compilación limpia de la versión pública etiquetada.',
    'Open the Mission thread': 'Abrir el hilo de la Misión',
    'Authorize, follow, pause, or cancel a Mission from its card in the Mission thread.': 'Autoriza, sigue, pausa o cancela una Misión desde su tarjeta en el hilo de la Misión.',
    'Meta consultations allowed for the next Mission you authorize (0 = none)': 'Consultas a Meta permitidas para la próxima Misión que autorices (0 = ninguna)',
    'Planning': 'Planificando',
    'Plan ready — awaiting authorization': 'Plan listo — esperando autorización',
    'Authorizing': 'Autorizando',
    'Paused': 'Pausada',
    'Blocked': 'Bloqueada',
    'Completed — acceptance passed': 'Completada — aceptación superada',
    'Completed — project tests passed': 'Completada — pruebas del proyecto superadas',
    'Interrupted': 'Interrumpida',
    'Failed': 'Fallida',
    'No Mission plan was created; see the reply': 'No se creó ningún plan de Misión; mira la respuesta',
    'Authorizing…': 'Autorizando…',
    'Mission started': 'Misión iniciada',
    'RAME Code did not confirm the start. Check the Mission state before trying again.': 'RAME Code no confirmó el inicio. Comprueba el estado de la Misión antes de volver a intentarlo.',
    'Pausing…': 'Pausando…',
    'Resuming…': 'Reanudando…',
    'Choose the acceptance check and at least one of its files, or choose Standard Mission.': 'Elige la comprobación de aceptación y al menos uno de sus ficheros, o elige Misión estándar.',
    'Goal': 'Objetivo',
    'Current task': 'Tarea actual',
    '{0} ({1} of {2} done)': '{0} ({1} de {2} hechas)',
    '{0} of {1} done': '{0} de {1} hechas',
    'Internal run': 'Ejecución interna',
    'none yet': 'ninguna todavía',
    'Step': 'Paso',
    'Time': 'Tiempo',
    'Last progress': 'Último progreso',
    'Last test': 'Última prueba',
    'Acceptance': 'Aceptación',
    'Why': 'Motivo',
    'Standard Mission: no acceptance check': 'Misión estándar: sin comprobación de aceptación',
    '{0}: passed — {1}': '{0}: superada — {1}',
    '{0}: failed — {1}': '{0}: fallida — {1}',
    '{0}: its files changed — the Mission is blocked': '{0}: sus ficheros cambiaron — la Misión está bloqueada',
    '{0}: not run yet (runs before the Mission can end)': '{0}: aún no ejecutada (se ejecuta antes de que la Misión pueda terminar)',
    'Choose a test script': 'Elige un script de prueba',
    'No test files were found in this project.': 'No se encontraron ficheros de prueba en este proyecto.',
    'No file matches the filter.': 'Ningún fichero coincide con el filtro.',
    'Choose at least one file of the acceptance check.': 'Elige al menos un fichero de la comprobación de aceptación.',
    'Checked by hash when you authorize: {0}. RAME Code\'s tools will not modify node_modules (not hashed).': 'Se verificarán por hash al autorizar: {0}. Las herramientas de RAME Code no modificarán node_modules (no se verifica por hash).',
    'Allowlisted test scripts: {0}': 'Scripts de prueba permitidos: {0}',
    'none': 'ninguno',
    'package.json sha256: {0}': 'sha256 de package.json: {0}',
    'Environment files hashed in a Verified Mission: {0}': 'Ficheros de entorno verificados por hash en una Misión verificada: {0}',
    'Acceptance command: {0}': 'Comando de aceptación: {0}',
    'Frozen {0} sha256: {1}': 'sha256 congelado de {0}: {1}',
    'Tasks done': 'Tareas terminadas',
    'Files changed': 'Archivos modificados',
    'Tests and exit codes': 'Pruebas y códigos de salida',
    'Frozen acceptance': 'Aceptación congelada',
    'none (Standard Mission)': 'ninguna (Misión estándar)',
    'Internal runs and time': 'Ejecuciones internas y tiempo',
    '{0} run(s), {1} min': '{0} ejecución(es), {1} min',
    'Models and providers': 'Modelos y proveedores',
    'Meta consultations': 'Consultas a Meta',
    'Build revision': 'Revisión de compilación',
    'Channel': 'Canal',
    'release': 'versión publicada',
    'candidate': 'candidata',
    'Language: {0}': 'Idioma: {0}',
    'running': 'en marcha',
    'external endpoint': 'endpoint externo',
    'stopped': 'parado',
    'key saved': 'clave guardada',
    'no key': 'sin clave',
    'No Mission': 'Sin Misión',
    '{0} · {1} decision(s) in force': '{0} · {1} decisión(es) en vigor',
    'Permission: {0} · Cloud escalation {1}': 'Permiso: {0} · Escalada a la nube {1}',
    'on': 'activada',
    'off': 'desactivada',
    'Output limits and diagnostics': 'Límites de salida y diagnóstico',
    'v{0} · {1}': 'v{0} · {1}',
    'Mission started.': 'Misión iniciada.',
    'Authorizing the Mission…': 'Autorizando la Misión…',

    // Cascade
    'Send this text to Meta': 'Enviar este texto a Meta',
    'Sending…': 'Enviando…',
    'Dismissing…': 'Descartando…',
    'Why: the local run stopped because {0}.': 'Motivo: la ejecución local se detuvo porque {0}.',
    'Model: Meta {0} | {1} characters | Digest: {2} — one use.': 'Modelo: Meta {0} | {1} caracteres | Digest: {2} — un solo uso.',
    'Consultation dismissed. Nothing was sent to Meta.': 'Consulta descartada. No se envió nada a Meta.',
    'That consultation approval is no longer valid. Nothing was sent.': 'Esa aprobación de consulta ya no es válida. No se envió nada.',
    'The project folder of this run is no longer open.': 'La carpeta del proyecto de esta ejecución ya no está abierta.',
    'Cascade finished: the local verification run passed its test.': 'Cascada terminada: la ejecución local de verificación pasó su prueba.',
    'Cascade finished without a passing local test.': 'Cascada terminada sin una prueba local superada.',
    'Cascade stopped before the local verification run.': 'Cascada detenida antes de la ejecución local de verificación.',
    'Cascade not used.': 'Cascada no usada.',
    'Asking Meta for advice needs cloud escalation ON in Settings; nothing was sent.': 'Pedir consejo a Meta requiere activar el escalado a la nube en Ajustes; no se envió nada.',

    // Host messages (exact)
    'Ready.': 'Listo.',
    'New Agent thread started. Type a message below.': 'Nuevo hilo del Agente. Escribe un mensaje abajo.',
    'That thread is no longer stored.': 'Ese hilo ya no está guardado.',
    'Stop the current run before deleting its thread.': 'Detén la ejecución actual antes de borrar su hilo.',
    'Thread deleted.': 'Hilo borrado.',
    'Showing thread list.': 'Mostrando la lista de hilos.',
    'Unknown mode. Choose Chat, Mission, or Agent.': 'Modo desconocido. Elige Chat, Misión o Agente.',
    'Unknown runtime. Choose a runtime in Settings.': 'Motor desconocido. Elige un motor en Ajustes.',
    'Type a message first.': 'Escribe primero un mensaje.',
    'The message is invalid.': 'El mensaje no es válido.',
    'No Meta Model API key is stored. Save one in Settings or choose a local runtime.':
      'No hay clave de Meta Model API guardada. Guarda una en Ajustes o elige un motor local.',
    'Choose the workspace folder for this Agent run…': 'Elige la carpeta del workspace para esta ejecución del Agente…',
    'No API key stored. Save a Meta Model API key to begin.': 'No hay clave de API guardada. Guarda una clave de Meta Model API para empezar.',
    'Plan ready.': 'Plan listo.',
    'Reply ready.': 'Respuesta lista.',
    'Agent reply ready.': 'Respuesta del Agente lista.',
    'The local model did not submit a valid Mission plan.': 'El modelo local no entregó un plan de Misión válido.',
    'The local model did not return a strict plan; its reply is shown as prose.':
      'El modelo local no devolvió un plan estricto; su respuesta se muestra como texto.',
    'Reasoning was not changed: the selection no longer matches the current runtime.':
      'No se cambió el razonamiento: la selección ya no coincide con el motor actual.',
    'Reasoning was not changed.': 'No se cambió el razonamiento.',
    'The current run keeps its settings.': 'La ejecución en curso conserva sus ajustes.',
    'Unknown permission profile. Kept Ask (safest).': 'Perfil de permisos desconocido. Se mantiene Preguntar (lo más seguro).',
    'No Agent action is waiting for approval.': 'Ninguna acción del Agente espera aprobación.',
    'That approval is no longer valid.': 'Esa aprobación ya no es válida.',
    'Agent action rejected.': 'Acción del Agente rechazada.',
    'Agent action rejected. Nothing ran.': 'Acción del Agente rechazada. No se ejecutó nada.',
    'A precondition changed; asking the Agent to re-read and re-propose…': 'Cambió una precondición; se pide al Agente que vuelva a leer y proponer…',
    'Action rejected by user. No changes were made.': 'Acción rechazada por ti. No se hizo ningún cambio.',
    'The workspace changed; the Agent run stopped.': 'El workspace cambió; la ejecución del Agente se detuvo.',
    'A request is already running. Cancel it before starting a Mission task.': 'Ya hay una petición en marcha. Cancélala antes de iniciar una tarea de la Misión.',
    'That Mission does not belong to the open project.': 'Esa Misión no pertenece al proyecto abierto.',
    'The Mission changed; review it again before continuing.': 'La Misión cambió; revísala de nuevo antes de seguir.',
    'The Mission thread no longer exists.': 'El hilo de la Misión ya no existe.',
    'The Mission’s project folder is no longer open.': 'La carpeta del proyecto de la Misión ya no está abierta.',
    'That folder is not open in this window.': 'Esa carpeta no está abierta en esta ventana.',
    'Approve or reject the pending memory change first.': 'Primero aprueba o rechaza el cambio de memoria pendiente.',
    'A Mission task is running. Wait for it to finish before changing the project.': 'Hay una tarea de la Misión en marcha. Espera a que termine antes de cambiar de proyecto.',
    'Several folders are open. Choose the project above to manage its memory.': 'Hay varias carpetas abiertas. Elige arriba el proyecto para gestionar su memoria.',
    'Open a folder to manage its project memory.': 'Abre una carpeta para gestionar la memoria de su proyecto.',
    'The project folder could not be resolved.': 'No se pudo resolver la carpeta del proyecto.',
    'Review the exact memory change below, then approve or reject it.': 'Revisa abajo el cambio exacto de memoria y apruébalo o recházalo.',
    'That memory approval is no longer valid.': 'Esa aprobación de memoria ya no es válida.',
    'Memory change rejected. Nothing was written.': 'Cambio de memoria rechazado. No se guardó nada.',
    'Artifact recorded.': 'Archivo registrado.',
    'Project memory could not be read; RAME Code will not overwrite it.': 'No se pudo leer la memoria del proyecto; RAME Code no la sobrescribirá.',
    'Request cancelled.': 'Petición cancelada.',
    'Local work failed. Escalation is waiting for approval.': 'Falló el trabajo local. El escalado espera tu aprobación.',
    'Escalation is waiting for approval.': 'El escalado espera tu aprobación.',
    'Cloud escalation is OFF, so nothing was sent.': 'El escalado a la nube está desactivado, así que no se envió nada.',
    'No escalation is waiting for approval.': 'Ningún escalado espera aprobación.',
    'A request is already running. Cancel it or wait before sending to Meta. Nothing was sent.':
      'Ya hay una petición en marcha. Cancélala o espera antes de enviar a Meta. No se envió nada.',
    'Cloud escalation is OFF. Nothing was sent.': 'El escalado a la nube está desactivado. No se envió nada.',
    'That thread is no longer stored. Nothing was sent.': 'Ese hilo ya no está guardado. No se envió nada.',
    'Escalation dismissed. Nothing was sent to Meta.': 'Escalado descartado. No se envió nada a Meta.',
    'No request is running.': 'No hay ninguna petición en marcha.',
    'The API key is invalid.': 'La clave de API no es válida.',
    'API key stored. Refreshing available models…': 'Clave de API guardada. Actualizando los modelos disponibles…',
    'Meta connection not tested: save an API key first.': 'Conexión con Meta no comprobada: guarda primero una clave de API.',
    'Meta connection verified. Live model catalog loaded.': 'Conexión con Meta verificada. Catálogo real de modelos cargado.',
    'Meta connection test failed. Check the key, balance, network, and Meta service status.': 'Falló la prueba de conexión con Meta. Revisa la clave, el saldo, la red y el estado del servicio de Meta.',
    'API key cleared. Save a key to run cloud requests.': 'Clave de API borrada. Guarda una clave para usar la nube.',
    'Unknown mode.': 'Modo desconocido.',
    'Settings saved.': 'Ajustes guardados.',
    'Refreshing available models…': 'Actualizando los modelos disponibles…',
    'Local settings are invalid.': 'Los ajustes locales no son válidos.',
    'Local settings saved.': 'Ajustes locales guardados.',
    'The external endpoint must stay on loopback.': 'El endpoint externo debe quedarse en loopback.',
    'External endpoint cleared.': 'Endpoint externo quitado.',
    'The local runtime is already starting or running.': 'El motor local ya está arrancando o en marcha.',
    'The local runtime is stopping. Try again in a moment.': 'El motor local se está deteniendo. Inténtalo de nuevo en un momento.',
    'Could not start the local runtime executable.': 'No se pudo iniciar el ejecutable del motor local.',
    'The local runtime stopped.': 'El motor local se detuvo.',
    'Stopping the local runtime…': 'Deteniendo el motor local…',
    'Local runtime stopped.': 'Motor local detenido.',
    'Ignoring an invalid view request.': 'Se ignora una petición no válida de la vista.',
    'Mission created. Start the first task when you are ready.': 'Misión creada. Inicia la primera tarea cuando quieras.',
    'RAME Code was reloaded while this task was running; nothing is repeated automatically.':
      'RAME Code se recargó mientras esta tarea se ejecutaba; no se repite nada automáticamente.',
    'Review what ran, then resume the task.': 'Revisa lo que se ejecutó y después reanuda la tarea.',
    'Check the workspace before resuming.': 'Revisa el workspace antes de reanudar.',
    'The file was not checked.': 'El archivo no se comprobó.',
    'The file no longer exists.': 'El archivo ya no existe.',
    'The file changed after it was verified.': 'El archivo cambió después de verificarlo.',
    'Project memory is being changed in another VS Code window; try again in a moment.':
      'La memoria del proyecto se está cambiando en otra ventana de VS Code; inténtalo de nuevo en un momento.',
    'Project memory could not be read, so RAME Code will not write to it.': 'No se pudo leer la memoria del proyecto, así que RAME Code no escribirá en ella.',
    'Stored Missions could not be read, so RAME Code will not write to them.': 'No se pudieron leer las Misiones guardadas, así que RAME Code no escribirá en ellas.',
    'That Mission no longer exists or could not be read.': 'Esa Misión ya no existe o no se pudo leer.',
    'The Mission changed in another window; review it again before continuing.': 'La Misión cambió en otra ventana; revísala de nuevo antes de seguir.',
    'This Mission has no current task.': 'Esta Misión no tiene tarea actual.',
    'This Mission is completed.': 'Esta Misión está completada.',
    'This Mission failed; create a new Mission to continue.': 'Esta Misión falló; crea una nueva para continuar.',
    'This Mission is waiting for an approval in its current run.': 'Esta Misión espera una aprobación en su ejecución actual.',
    'The Mission is not running.': 'La Misión no está en marcha.',
    'The decision key must be lowercase dotted words, for example shipping.free_threshold_eur.':
      'La clave debe ser de palabras en minúscula separadas por puntos, por ejemplo shipping.free_threshold_eur.',
    'expectedVersion must be a whole number of 0 or more.': 'expectedVersion debe ser un número entero de 0 o más.',
    'The proposal provenance is invalid.': 'El origen de la propuesta no es válido.',
    'The artifact path is invalid.': 'La ruta del archivo no es válida.',
    'The artifact evidence is invalid.': 'La evidencia del archivo no es válida.',
    'Only a passing test can verify an artifact.': 'Solo una prueba superada puede verificar un archivo.',
    'That authorization was already used.': 'Esa autorización ya se usó.',
    'That authorization does not match a pending proposal.': 'Esa autorización no corresponde a ninguna propuesta pendiente.',
    'Only a host approval can authorize a memory change.': 'Solo una aprobación del host puede autorizar un cambio de memoria.',
    'The authorization does not match the exact proposal.': 'La autorización no coincide con la propuesta exacta.',
    'The authorization belongs to another project, thread, or provider.': 'La autorización pertenece a otro proyecto, hilo o proveedor.',
    'The proposal expired before it was approved; propose it again.': 'La propuesta caducó antes de aprobarse; vuelve a proponerla.',
    'Chat sends the active thread’s recent history, a bounded host-selected set of relevant older excerpts, and your new message. Other threads are never sent. Older local excerpts are withheld when switching to Meta.':
      'El chat envía el historial reciente del hilo activo, extractos antiguos relevantes y acotados elegidos por el host, y tu mensaje nuevo. Los demás hilos nunca se envían. Los extractos locales antiguos no se envían al cambiar a Meta.',
    'Mission sends only your new message to Meta Model API. Earlier thread content is never sent as context.':
      'Misión envía solo tu mensaje nuevo a Meta Model API. El contenido anterior del hilo nunca se envía como contexto.',
  };

  function q(text) {
    return '«' + text + '»';
  }

  var ES_TYPE = { number: 'número', boolean: 'verdadero/falso', string: 'texto' };
  var ES_WHO = {
    'you (Settings)': 'ti (Ajustes)',
    'the Meta cloud model': 'el modelo de Meta en la nube',
    'the local model': 'el modelo local',
  };
  // A JSON scalar as the host prints it: the parse of a card is unambiguous.
  var JSON_VALUE = '(not set|true|false|-?\\d+(?:\\.\\d+)?(?:[eE][+-]?\\d+)?|"(?:[^"\\\\]|\\\\.)*")';
  var KEY = '([a-z0-9_]+(?:\\.[a-z0-9_]+)*)';
  var WHO = '(you \\(Settings\\)|the Meta cloud model|the local model)';
  var REASON = '(?: Reason given: ("(?:[^"\\\\]|\\\\.)*"))?';
  var QUOTE = '(?: Your words: ("(?:[^"\\\\]|\\\\.)*")\\.)?';

  function value(text) {
    return text === 'not set' ? 'sin valor' : text;
  }

  // Only the host's own Settings reason is translated; any other reason is
  // the proposer's text and stays verbatim.
  function reason(text) {
    return text === '"Entered in Settings."' ? '"Introducido en Ajustes."' : text;
  }

  var ES_PATTERNS = [
    [/^Opened “([\s\S]*)”\.$/, function (m) { return 'Abierto ' + q(m[1]) + '.'; }],
    [/^Reasoning (\S+) is not available for (\S+)\.$/, function (m, tr) { return 'El razonamiento ' + tr(m[1]) + ' no está disponible para ' + m[2] + '.'; }],
    [/^Reasoning set to ([\s\S]+?) for (\S+); the current run keeps its settings\.$/, function (m, tr) { return 'Razonamiento: ' + tr(m[1]) + ' para ' + m[2] + '; la ejecución en curso conserva sus ajustes.'; }],
    [/^Reasoning set to ([\s\S]+?) for (\S+)\.$/, function (m, tr) { return 'Razonamiento: ' + tr(m[1]) + ' para ' + m[2] + '.'; }],
    [/^(Local|Meta) maximum not saved, so nothing changed: ([\s\S]*)$/, function (m, tr) { return 'No se guardó el máximo ' + (m[1] === 'Local' ? 'local' : 'de Meta') + ', así que no cambió nada: ' + tr(m[2]); }],
    [/^Maximum output: Local (automatic|\d+ tokens), Meta (automatic|\d+ tokens)\.$/, function (m) {
      var w = function (v) { return v === 'automatic' ? 'automático' : v; };
      return 'Salida máxima: local ' + w(m[1]) + ', Meta ' + w(m[2]) + '.';
    }],
    [/^You can ask Meta (\S+) for advice with the exact text shown, or dismiss\.$/, function (m) { return 'Puedes pedir consejo a Meta ' + m[1] + ' con el texto exacto mostrado, o descartarlo.'; }],
    [/^Asking Meta (\S+) for advice with the approved text only…$/, function (m) { return 'Pidiendo consejo a Meta ' + m[1] + ' solo con el texto aprobado…'; }],
    [/^The Meta advice could not be used \(([\s\S]*)\)\. Nothing else was sent and nothing changed\.$/, function (m) { return 'No se pudo usar el consejo de Meta (' + m[1] + '). No se envió nada más y nada cambió.'; }],
    [/^Agent stopped at its step budget \((\d+) model steps\) without a final report\.$/, function (m) { return 'El Agente se detuvo en su límite de pasos (' + m[1] + ' pasos del modelo) sin informe final.'; }],
    [/^Waiting for your approval: (\S+)\.$/, function (m) { return 'Esperando tu aprobación: ' + m[1] + '.'; }],
    [/^Retrying an empty Agent response \((\d)\/2\)…$/, function (m) { return 'Reintentando una respuesta vacía del Agente (' + m[1] + '/2)…'; }],
    [/^Correcting a blocked (\S+) proposal…$/, function (m) { return 'Corrigiendo una propuesta bloqueada de ' + m[1] + '…'; }],
    [/^The (\S+) proposal was not prepared; returning the reason to the Agent…$/, function (m) { return 'La propuesta de ' + m[1] + ' no se preparó; se devuelve el motivo al Agente…'; }],
    [/^Correcting malformed tool call \((\d)\/2\): waiting for the ([\s\S]+) \(120 s maximum\)…$/, function (m) { return 'Corrigiendo una llamada de herramienta mal formada (' + m[1] + '/2): esperando al ' + m[2] + ' (120 s como máximo)…'; }],
    [/^The ([\s\S]+) reply was cut off at its (\d+)-token limit; asking for a shorter step \((\d)\/2\)…$/, function (m) { return 'La respuesta del ' + m[1] + ' se cortó en su límite de ' + m[2] + ' tokens; se pide un paso más corto (' + m[3] + '/2)…'; }],
    [/^Request failed \(([\s\S]*)\)\.$/, function (m) { return 'La petición falló (' + m[1] + ').'; }],
    [/^Local work failed \(([\s\S]*)\)\. Cloud escalation is OFF, so nothing was sent\.$/, function (m) { return 'Falló el trabajo local (' + m[1] + '). El escalado a la nube está desactivado, así que no se envió nada.'; }],
    [/^Local model is not reachable at (\S+)\. Start it in Settings\.$/, function (m) { return 'No se puede conectar con el modelo local en ' + m[1] + '. Inícialo en Ajustes.'; }],
    [/^That model is unavailable\. Using (\S+)\.$/, function (m) { return 'Ese modelo no está disponible. Se usa ' + m[1] + '.'; }],
    [/^The stored model was unavailable; using (\S+)\.$/, function (m) { return 'El modelo guardado no estaba disponible; se usa ' + m[1] + '.'; }],
    [/^Cloud model selected: ([\s\S]+)\.$/, function (m) { return 'Modelo en la nube elegido: ' + m[1] + '.'; }],
    [/^External endpoint selected: (\S+)\. RAME does not own its lifecycle\.$/, function (m) { return 'Endpoint externo elegido: ' + m[1] + '. RAME no gestiona su ciclo de vida.'; }],
    [/^External endpoint selected: (\S+) \(not owned\)\.$/, function (m) { return 'Endpoint externo elegido: ' + m[1] + ' (no gestionado).'; }],
    [/^Starting the local runtime on (\S+)…$/, function (m) { return 'Arrancando el motor local en ' + m[1] + '…'; }],
    [/^The local runtime did not become healthy within (\d+)s\.$/, function (m) { return 'El motor local no estuvo listo en ' + m[1] + ' s.'; }],
    [/^Local runtime running on (\S+)\.$/, function (m) { return 'Motor local en marcha en ' + m[1] + '.'; }],
    [/^Local runtime is running on (\S+) \(owned by RAME Code\)\.$/, function (m) { return 'El motor local está en marcha en ' + m[1] + ' (gestionado por RAME Code).'; }],
    [/^Local runtime is running on (\S+) \(external, not owned\)\.$/, function (m) { return 'El motor local está en marcha en ' + m[1] + ' (externo, no gestionado).'; }],
    [/^Project memory: ([\s\S]+)\.$/, function (m) { return 'Memoria del proyecto: ' + m[1] + '.'; }],
    [/^The value is not a valid (number|boolean|string)\.$/, function (m) { return 'El valor no es un ' + ES_TYPE[m[1]] + ' válido.'; }],
    [/^Not proposed: ([\s\S]*)$/, function (m, tr) { return 'No propuesto: ' + tr(m[1]); }],
    [/^Not written: ([\s\S]*)$/, function (m, tr) { return 'No guardado: ' + tr(m[1]); }],
    [new RegExp('^Saved ' + KEY + ' v(\\d+) = ' + JSON_VALUE + '\\.$'), function (m) { return 'Guardado: ' + m[1] + ' v' + m[2] + ' = ' + m[3] + '.'; }],
    [new RegExp('^' + KEY + ' changed since this proposal was shown, so nothing was written; propose it again from the current version\\.$'), function (m) {
      return m[1] + ' cambió después de mostrar esta propuesta, así que no se guardó nada; vuelve a proponerla desde la versión actual.';
    }],
    [new RegExp('^' + KEY + ' is at version (\\d+), not (\\d+)\\. The proposal was based on an outdated version and was not prepared\\.$'), function (m) {
      return m[1] + ' está en la versión ' + m[2] + ', no en la ' + m[3] + '. La propuesta partía de una versión antigua y no se preparó.';
    }],
    [new RegExp('^' + KEY + ' is already ' + JSON_VALUE + ' at version (\\d+)\\.$'), function (m) { return m[1] + ' ya vale ' + m[2] + ' en la versión ' + m[3] + '.'; }],
    [new RegExp('^' + KEY + ' changed to version (\\d+) after this proposal was prepared for version (\\d+)\\. Nothing was written\\.$'), function (m) {
      return m[1] + ' pasó a la versión ' + m[2] + ' después de preparar esta propuesta para la versión ' + m[3] + '. No se guardó nada.';
    }],
    [new RegExp('^' + KEY + ' has no value in force to delete\\.$'), function (m) { return m[1] + ' no tiene ningún valor vigente que borrar.'; }],
    [new RegExp('^The stored history of ' + KEY + ' failed validation; it is kept as is and cannot be changed\\.$'), function (m) {
      return 'El historial guardado de ' + m[1] + ' no pasó la validación; se conserva tal cual y no se puede cambiar.';
    }],
    [new RegExp('^' + KEY + ' has no authorized value in this project\\.$'), function (m) { return m[1] + ' no tiene ningún valor autorizado en este proyecto.'; }],
    [new RegExp('^' + KEY + ' is at version (\\d+), not (\\d+); verify the file against the version in force\\.$'), function (m) {
      return m[1] + ' está en la versión ' + m[2] + ', no en la ' + m[3] + '; verifica el archivo con la versión vigente.';
    }],
    [new RegExp('^' + KEY + ' is no longer at version (\\d+); the artifact was not bound\\.$'), function (m) { return m[1] + ' ya no está en la versión ' + m[2] + '; el archivo no se vinculó.'; }],
    [/^The value must be a number, true\/false, or text of 1 to (\d+) characters\.$/, function (m) { return 'El valor debe ser un número, verdadero/falso o un texto de 1 a ' + m[1] + ' caracteres.'; }],
    [/^This project already has (\d+) decisions\.$/, function (m) { return 'Este proyecto ya tiene ' + m[1] + ' decisiones.'; }],
    [/^This Mission used all (\d+) task runs of its budget\.$/, function (m) { return 'Esta Misión gastó las ' + m[1] + ' ejecuciones de tarea de su presupuesto.'; }],
    [new RegExp('^Verified against ' + KEY + ' v(\\d+) by (\\S+)\\.$'), function (m) { return 'Verificado con ' + m[1] + ' v' + m[2] + ' mediante ' + m[3] + '.'; }],
    [new RegExp('^The history of ' + KEY + ' failed validation\\.$'), function (m) { return 'El historial de ' + m[1] + ' no pasó la validación.'; }],
    [new RegExp('^' + KEY + ' has no value in force any more\\.$'), function (m) { return m[1] + ' ya no tiene ningún valor vigente.'; }],
    [new RegExp('^Verified against v(\\d+), but ' + KEY + ' is now v(\\d+)\\.$'), function (m) { return 'Verificado con la v' + m[1] + ', pero ' + m[2] + ' está ahora en la v' + m[3] + '.'; }],
    [/^Running task "([\s\S]*)" \(run (\d+); (\d+) of (\d+) Mission runs used\)\.$/, function (m) {
      return 'Ejecutando la tarea ' + q(m[1]) + ' (ejecución ' + m[2] + '; ' + m[3] + ' de ' + m[4] + ' ejecuciones de la Misión usadas).';
    }],
    [/^Task "([\s\S]*)" completed\. Next: "([\s\S]*)"\. Start it when you are ready\.$/, function (m) {
      return 'Tarea ' + q(m[1]) + ' completada. Siguiente: ' + q(m[2]) + '. Iníciala cuando quieras.';
    }],
    [/^All (\d+) tasks completed\.$/, function (m) { return 'Las ' + m[1] + ' tareas están completadas.'; }],
    [/^The task run ended without completing: ([\s\S]*)$/, function (m, tr) { return 'La ejecución de la tarea terminó sin completarse: ' + tr(m[1]); }],
    [/^The plan was not saved as a Mission: ([\s\S]*)$/, function (m, tr) { return 'El plan no se guardó como Misión: ' + tr(m[1]); }],
    [/^Saved as a Mission with (\d+) task\(s\); review it and authorize it in the Mission card of this thread\.$/, function (m) {
      return 'Guardado como Misión con ' + m[1] + ' tarea(s); revísala y autorízala en la tarjeta de Misión de este hilo.';
    }],
    [/^Working with (\S+)…$/, function (m) { return 'Trabajando con ' + m[1] + '…'; }],
    [/^A repeated (\S+) returned nothing new; telling the Agent…$/, function (m) { return 'Un ' + m[1] + ' repetido no aportó nada nuevo; se le indica al Agente…'; }],
    [/^Blocked: (\d+) internal runs in a row without verifiable progress, or the run ceiling was reached \(last: ([\s\S]*)\)\.$/, function (m) {
      return 'Bloqueada: ' + m[1] + ' ejecuciones internas seguidas sin progreso verificable, o se alcanzó el techo de ejecuciones (última: ' + m[2] + ').';
    }],
    [/^Mission (blocked|paused|cancelled|interrupted|waiting approval|completed) — status note, not a final report\.$/, function (m) {
      var names = { blocked: 'bloqueada', paused: 'pausada', cancelled: 'cancelada', interrupted: 'interrumpida', 'waiting approval': 'esperando aprobación', completed: 'completada' };
      return 'Misión ' + names[m[1]] + ' — nota de estado, no es un informe final.';
    }],
    [/^Uncertain: ([\s\S]+) started but its result was not recorded\.$/, function (m) { return 'Incierto: ' + m[1] + ' empezó pero su resultado no se registró.'; }],
    [/^Agent runs a bounded tool loop with the selected provider only \(local Glimmer or Meta (\S+), never switched silently\)\. It inspects and changes only the active workspace under the selected permission profile\. There is no arbitrary shell or terminal emulation tool, but allowlisted test scripts run with your OS permissions and may access files, network including arbitrary internet, or shells; there is no OS sandbox for them\. No computer-wide control or memory safety beyond what is implemented is claimed\.$/, function (m) {
      return 'El Agente ejecuta un bucle acotado de herramientas solo con el proveedor elegido (Glimmer local o Meta ' + m[1] + ', nunca cambiado en silencio). Solo inspecciona y cambia el workspace activo bajo el perfil de permisos elegido. No hay herramienta de shell ni de terminal arbitraria, pero los scripts de prueba permitidos se ejecutan con tus permisos del sistema y pueden acceder a ficheros, a la red (incluido internet) o a shells; no hay sandbox del sistema para ellos. No se afirma ningún control del equipo ni seguridad de memoria más allá de lo implementado.';
    }],
    [new RegExp('^Set ' + KEY + ' from ' + JSON_VALUE + ' \\(v(\\d+)\\) to ' + JSON_VALUE + ' \\(v(\\d+)\\)\\. Project: ([^\\n]+?)\\. Proposed by ' + WHO + '\\.' + QUOTE + REASON + '$'), function (m) {
      return 'Cambiar ' + m[1] + ' de ' + value(m[2]) + ' (v' + m[3] + ') a ' + m[4] + ' (v' + m[5] + '). Proyecto: ' + m[6] + '. Propuesto por ' + ES_WHO[m[7]] + '.' +
        (m[8] ? ' Tus palabras: ' + m[8] + '.' : '') +
        (m[9] ? ' Motivo indicado: ' + reason(m[9]) : '');
    }],
    [new RegExp('^Remove ' + KEY + ' \\(now ' + JSON_VALUE + ', v(\\d+)\\)\\. Project: ([^\\n]+?)\\. Proposed by ' + WHO + '\\.' + QUOTE + REASON + '$'), function (m) {
      return 'Eliminar ' + m[1] + ' (ahora ' + value(m[2]) + ', v' + m[3] + '). Proyecto: ' + m[4] + '. Propuesto por ' + ES_WHO[m[5]] + '.' +
        (m[6] ? ' Tus palabras: ' + m[6] + '.' : '') +
        (m[7] ? ' Motivo indicado: ' + reason(m[7]) : '');
    }],
  ];

  var TABLES = { es: { text: ES, patterns: ES_PATTERNS } };

  function lookup(language, text) {
    var table = TABLES[language];
    if (!table || typeof text !== 'string') {
      return null;
    }
    return Object.prototype.hasOwnProperty.call(table.text, text) ? table.text[text] : null;
  }

  /** Interface text: the exact English text, else unchanged. */
  function translate(language, text) {
    var found = lookup(language, text);
    return found === null ? text : found;
  }

  function translateHostOne(language, text, depth) {
    var found = lookup(language, text);
    if (found !== null) {
      return found;
    }
    var patterns = TABLES[language] ? TABLES[language].patterns : [];
    for (var i = 0; i < patterns.length; i++) {
      var match = patterns[i][0].exec(text);
      if (match) {
        return patterns[i][1](match, function (inner) {
          return depth < 4 ? translateHost(language, inner, depth + 1) : inner;
        });
      }
    }
    return null;
  }

  /**
   * Host messages: the exact text, a known pattern, else sentence by
   * sentence. Whatever is not recognized stays as the host wrote it.
   */
  function translateHost(language, text, depth) {
    if (!TABLES[language] || typeof text !== 'string' || text.length === 0) {
      return text;
    }
    var level = depth || 0;
    var whole = translateHostOne(language, text, level);
    if (whole !== null) {
      return whole;
    }
    var parts = text.split(/(?<=[.…])\s+(?=[A-Z(“"])/);
    if (parts.length < 2) {
      return text;
    }
    return parts
      .map(function (part) {
        var one = translateHostOne(language, part, level);
        return one === null ? part : one;
      })
      .join(' ');
  }

  window.RAME_I18N = {
    has: function (language) {
      return Object.prototype.hasOwnProperty.call(TABLES, language);
    },
    translate: translate,
    translateHost: translateHost,
    // Feature modules add their own interface strings; existing ones win.
    extend: function (language, entries) {
      var table = TABLES[language];
      Object.keys(entries || {}).forEach(function (k) {
        if (table && !Object.prototype.hasOwnProperty.call(table.text, k)) table.text[k] = entries[k];
      });
    },
    // For tests: the English keys of a table.
    keys: function (language) {
      return TABLES[language] ? Object.keys(TABLES[language].text) : [];
    },
  };
})();
