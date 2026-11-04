# Guía de usuario de RAME Code

[Web oficial](https://ramecode.com/) · [English version](USER_GUIDE.md) · [README en español](../README.es.md) · [Cómo verificar RAME](VERIFICATION.es.md)

> Guía práctica para la release preview experimental RAME Code v0.2.0. Utiliza proyectos desechables; esta versión no es una frontera de seguridad para producción.

RAME Code es un asistente de programación local-first integrado en VS Code. Puede conversar sobre un proyecto, inspeccionar y modificar archivos, ejecutar pruebas compatibles, conservar decisiones aprobadas del proyecto y desarrollar objetivos más largos mediante una Misión.

Su regla central es sencilla: **el modelo propone; el host de RAME Code controla los permisos y registra lo que ocurrió realmente**. La respuesta de un modelo no demuestra que un archivo haya cambiado o que una prueba haya pasado.

## Empieza aquí

1. Instala el VSIX siguiendo las [instrucciones del README](../README.es.md#instalación).
2. Abre una carpeta con la que estés dispuesto a hacer pruebas. Mientras RAME Code sea una preview, utiliza un proyecto desechable.
3. Abre RAME Code desde el icono **R** de la barra de actividad.
4. Abre **Ajustes** y elige un motor en **Modelos**:
   - **Muse Glimmer — Local** para inferencia local mediante `llama-server`.
   - **Meta Model API — Nube** para un modelo cloud compatible de Meta y tu propia clave API.
5. Empieza con **Agente** y el perfil de permisos **Preguntar** o **Auto seguro**.

No empieces con código confidencial ni datos personales reales. RAME Code 0.2.0 es una candidata de validación, no una frontera de seguridad preparada para producción.

## Qué puede hacer RAME Code y qué no

### Puede

- Conversar sin herramientas en **Chat puro**.
- Inspeccionar una carpeta seleccionada del workspace y proponer cambios en **Agente**.
- Ejecutar scripts compatibles de `package.json`, como `npm:test` o `npm:check`, cuando la política lo permita.
- Organizar trabajos largos como una **Misión** persistente.
- Pedir autorización antes de acciones relevantes y separar los hechos observados por el host del texto del modelo.
- Conservar decisiones del proyecto aprobadas por el usuario entre hilos y recargas de VS Code en la misma instalación.
- Trabajar localmente con Muse Glimmer sin enviar la petición a Meta Model API.
- Utilizar opcionalmente un modelo de Meta después de mostrar la autorización cloud correspondiente.

### No puede prometer

- Que unas pruebas en verde demuestren que todo el producto es correcto.
- Un sandbox del sistema operativo. Los scripts de prueba se ejecutan con los permisos de tu usuario de VS Code.
- Control sin restricciones del terminal o del ordenador.
- Memoria perfecta ni recuperación de cualquier paráfrasis antigua.
- Verificación funcional completa para todos los lenguajes y plataformas. La verificación autónoma actual utiliza scripts Node/npm compatibles.
- Que un ejecutable, instalador o plugin generado funcione en su sistema de destino si no se ha probado allí.
- Preparación para producción, registros inalterables o protección completa de datos sensibles.

## Glimmer local y modelos cloud de Meta

### Muse Glimmer — Local

RAME Code puede iniciar un `llama-server` compatible enlazado a `127.0.0.1` o usar un endpoint OpenAI-compatible de loopback. Los archivos del modelo permanecen en tu equipo. Una petición local no se envía a Meta Model API.

«Local» no significa aislado: los archivos y pruebas autorizadas siguen usando los permisos de VS Code. Un endpoint externo aparece como **identidad no verificada**, porque RAME no puede demostrar qué pesos sirve.

RAME no necesita Ollama para su recorrido local administrado: inicia directamente el ejecutable `llama-server` que hayas configurado y carga el GGUF de Glimmer desde disco.

### Servidores de modelos: Ollama, LM Studio, llama-server

RAME también puede usar un servidor de modelos que ejecutas tú. Abre **Settings › Runtime › Servidores de modelos**, elige **Ollama (11434)** o **LM Studio (1234)** (o escribe otra dirección) y pulsa **Buscar modelos**. RAME solo lee metadatos: distingue Ollama, LM Studio y llama-server, lista sus modelos de chat y muestra de cada uno si admite llamadas a herramientas, si tiene visión y con qué contexto está cargado. Elige uno y pulsa **Usar este modelo**: Chat, Agente y Misión enviarán ese identificador de modelo a ese servidor. RAME nunca arranca, para ni instala el servidor.

- Un modelo que, según el servidor, no puede llamar herramientas solo sirve para Chat; Agente y Misión se detienen con ese motivo.
- El Agente necesita unos 16.384 tokens de contexto. Ollama carga los modelos con su propio contexto (a menudo 4.096) salvo que se arranque con `OLLAMA_CONTEXT_LENGTH`; en LM Studio, carga el modelo con un contexto mayor.
- Un servidor en otro ordenador de tu red privada solo se usa después de que marques que se le enviarán las peticiones, el historial y el contenido del proyecto. Escríbelo como dirección privada numérica (10.x, 172.16–31.x, 192.168.x): se rechazan los nombres de equipo salvo `localhost`, porque un nombre podría apuntar a una dirección pública. Una dirección pública se rechaza siempre. RAME nunca sigue una redirección de un servidor de modelos. El `http` de tu red no va cifrado.
- Muse Glimmer: no hemos encontrado ni probado un modelo Glimmer para Ollama en Linux o Windows (otro proyecto menciona una versión MLX solo para Apple silicon). LM Studio y llama-server sirven el GGUF de Glimmer, y es lo que se ha probado.
- «visión» en la lista de modelos significa que el modelo puede leer imágenes. RAME todavía no envía imágenes a los modelos: esa capacidad no se usa.

### Meta Model API — Nube

Una petición cloud sale de tu equipo y puede consumir créditos de Meta API. La clave se almacena en VS Code SecretStorage. RAME muestra controles de divulgación y autorización antes de enviar a Meta contexto local que necesite consentimiento.

Cuando está seleccionado **Meta Model API — Nube**, pulsar **Enviar** autoriza el mensaje nuevo que acabas de escribir; RAME no añade una segunda confirmación para ese mensaje por sí solo. Si la petición llevaría además historial elegible generado mientras trabajabas en local, decisiones autorizadas del proyecto o resultados de herramientas de Agent, RAME muestra primero **Review what would be sent to Meta** para que decidas si ese contexto adicional puede salir del equipo.

- **Send with this context** autoriza el contexto adicional mostrado en la tarjeta.
- **Send without it** mantiene en local el contexto nuevo ofrecido, aunque todavía pueden enviarse el mensaje nuevo, las respuestas anteriores de Meta y el material ya autorizado bajo las mismas condiciones.
- **Cancel** no envía ninguna petición.
- **Stop sharing with Meta** retira las decisiones de divulgación del hilo para peticiones futuras. No puede recuperar información que Meta ya haya recibido y, si hay una petición activa, primero hay que detenerla.

Las decisiones sobre mensajes y decisiones del proyecto quedan ligadas al hilo, la clase de tratamiento de Meta y la revisión actual de la clave API, y persisten al reiniciar VS Code. El permiso para enviar resultados de herramientas de Agent queda limitado además a la sesión actual de VS Code. Cambiar a una clase Contributor/no documentada o guardar o borrar una clave exige decidir de nuevo. Por eso un mensaje posterior a Meta puede continuar sin otra tarjeta si no incorpora contexto local nuevo que requiera revisión. **Shared with Meta** describe el estado de divulgación registrado para el hilo; para comprobar una inferencia completada, consulta su entrada individual en **Model evidence**, donde figuran el proveedor, el modelo, la respuesta observada y el uso de tokens comunicado.

Existen dos vías cloud distintas:

- **Asesoramiento:** Spark aconseja; Glimmer conserva el control de las herramientas.
- **Delegada:** Spark propone herramientas para una petición de Agente; RAME sigue aplicando el perfil de permisos existente.

RAME nunca cambia de proveedor silenciosamente. Una Misión nunca convierte un permiso de asesoramiento en ejecución delegada.

## Elige el modo adecuado

| Modo | Adecuado para | Acceso a archivos y herramientas | Interacción habitual |
| --- | --- | --- | --- |
| **Chat puro** | Preguntas, ideas y explicaciones sin tocar el proyecto | Ninguno | Conversación natural |
| **Agente** | Inspección interactiva, cambios pequeños, depuración y pruebas | Disponible según el perfil elegido | Revisas el trabajo a medida que avanza |
| **Misión** | Un objetivo amplio que necesita varias ejecuciones, puntos de control y criterios de finalización | Regido por un permiso específico de la Misión | Autorizas el objetivo y después lo supervisas, pausas o reanudas |

En términos sencillos, **Agente** es programar junto a Glimmer paso a paso; **Misión** es encargarle un resultado amplio con límites y comprobaciones. Misión puede continuar entre ejecuciones sin que escribas «continúa», pero no trabaja indefinidamente: se pausa o bloquea cuando necesita autorización, detecta un resultado incierto o no observa progreso verificable.

### Chat puro

Usa **Chat puro** cuando no quieras que el modelo lea archivos ni ejecute herramientas. Puede razonar con el texto y con contexto acotado y autorizado, pero no puede inspeccionar el workspace.

### Agente

**Agente** es el modo recomendado por defecto. Puede conversar con normalidad y utilizar herramientas cuando hagan falta. Las lecturas, escrituras y pruebas siguen el perfil de permisos seleccionado. Las acciones importantes aparecen en **Actividad** y, cuando se usan herramientas, la respuesta final incluye un registro escrito por el host.

**En qué carpeta trabaja el Agente.** Con una carpeta abierta, el Agente usa esa. Un hilo conserva la carpeta a la que quedó vinculado; si esa carpeta se cerró, RAME te pregunta y nunca mueve el hilo a otra carpeta por su cuenta. Un hilo nuevo de Agente con ninguna carpeta abierta, o con varias, empieza **sin proyecto** (la insignia de la cabecera dice *Sin carpeta de proyecto — solo web*): el modelo local puede responder, usar `web_search` y `web_fetch` si el acceso web está activado (cada llamada en su tarjeta, como en el Agente) y pedir una carpeta con `request_project_folder`. Eso abre el selector de carpetas de VS Code: eliges una carpeta o cancelas, y las herramientas del proyecto (ficheros, pruebas, terminal, memoria del proyecto) se aplican desde tu siguiente mensaje. Sin proyecto no hay herramientas de ficheros, pruebas, terminal, memoria ni historial, ni decisiones del proyecto en el contexto; las aprobaciones hechas sin proyecto no quedan ligadas a ninguna carpeta y nunca pasan a otra. Las Misiones, y el Agente con Meta, siempre necesitan una carpeta elegida por ti.

Ejemplos:

```text
Explícame cómo funciona src/calculator.js. No modifiques nada.
```

```text
Corrige la prueba que falla en calculator, modifica solo src/calculator.js,
ejecuta npm:test e informa del resultado real.
```

### Acceso web en Agent, Chat y Mission

**Acceso web (opcional, desactivado por defecto).** En **Settings › Escalada › Acceso web** puedes permitir que el Agente busque en la web (`web_search`, con DuckDuckGo o tu propio SearXNG) y lea páginas públicas (`web_fetch`), solo lectura. El mismo interruptor da la web al **Chat**. Funciona solo con un modelo local; una Misión tiene su propio permiso web (más abajo). Cada llamada se muestra y espera tu aprobación en Chat y, salvo en Workspace full, en el Agente. Se rechazan las direcciones locales y privadas (también después del DNS y en cada redirección), no se envía una consulta o URL que contenga una clave o una ruta de fichero, y las páginas tienen un límite de 2 MiB y 15 s. El texto de las páginas llega al modelo marcado como dato no confiable, nunca como instrucciones, y no puede escribir en la memoria del proyecto.

**Estado de validación.** El acceso web en el Agente se ha validado en una ejecución real (LM Studio en la red privada, DuckDuckGo y nodejs.org). El acceso web en el **Chat** y en las **Misiones** es experimental en esta candidata: está implementado y cubierto por pruebas solo contra servidores simulados, y todavía no se ha validado contra la web real.

| | Chat | Agente | Misión |
|---|---|---|---|
| Herramientas web | solo `web_search` y `web_fetch` (ninguna de ficheros, pruebas, terminal ni memoria) | `web_search` y `web_fetch` además de las del workspace | `web_search` y `web_fetch` dentro del presupuesto web de la Misión |
| Se activa en | **Settings › Acceso web** | **Settings › Acceso web** | el bloque **Acceso web para esta Misión** al autorizarla |
| Pregunta antes de cada llamada | siempre | sí, salvo en Workspace full | supervisada: sí; autónoma: no, dentro del presupuesto |
| Qué puede leer | cualquier página pública que apruebes | cualquier página pública que apruebes | solo URLs que devolvieron sus propias búsquedas, o solo los dominios que indiques |
| Consultas | sin claves ni rutas de ficheros | sin claves ni rutas de ficheros | solo palabras normales: tampoco código, saltos de línea ni citas largas, como máximo 200 caracteres |

En una Misión, cada búsqueda y lectura se cuenta en el punto de control de la Misión *antes* de enviarse, así que una recarga nunca le da más de lo que concediste; cuando se agota el presupuesto, la Misión sigue sin web o informa del bloqueo. El acceso web nunca añade permisos de escritura, terminal, memoria ni ficheros, el texto web se marca como dato no confiable y nunca se convierte en instrucción, no puede cambiar una comprobación de aceptación congelada, una autorización ni un presupuesto, y las búsquedas y páginas se excluyen de todo lo que se envía a Meta (también de las consultas Advisory). En Chat, el hilo guarda la respuesta y un registro del host de cada búsqueda y página con su fuente, no el texto de las páginas.

```text
Busca en la documentación actual cómo crear un instalador de Windows con
electron-builder, cita las páginas que uses y no cambies ningún archivo.
```

**Comandos de terminal (opcional, desactivado por defecto).** En **Settings › Escalada › Comandos de terminal** puedes permitir que el Agente ejecute una línea de órdenes en la carpeta del proyecto (`run_command`: bash o sh, PowerShell en Windows), por ejemplo para instalar una dependencia, compilar, ejecutar un script o usar git. Es la herramienta más potente y la menos acotada: el comando se ejecuta con tus permisos y puede cambiar cualquier fichero, usar la red o instalar programas; no hay sandbox. Por eso solo funciona con un modelo local y nunca en las ejecuciones de una Misión, ves cada comando completo antes de que se ejecute y lo apruebas en todos los perfiles (también en Workspace full; la tarjeta avisa además cuando una línea encadena comandos, ejecuta un script que no ves, usa sudo o la red, o instala programas, pero una línea de comandos nunca muestra todos sus efectos), y tiene un límite de tiempo (120 s por defecto, como máximo 600 s) y una salida acotada. **Detener** señala el comando y su grupo normal de procesos, pero un proceso desacoplado deliberadamente puede sobrevivir. Se rechazan unos pocos comandos que solo pueden destruir (borrar la raíz o la carpeta personal, formatear un disco, una fork bomb, apagar el equipo). Las demás herramientas siguen siendo la opción más segura: `run_tests` solo ejecuta scripts de `package.json` derivados de forma exacta y sin shell, y las herramientas de ficheros comprueban cada ruta.

> **Advertencia sobre Workspace full y la terminal.** Workspace full deja que los parches y las pruebas permitidas se ejecuten sin preguntar, pero nunca lo hace con los comandos de terminal: cada `run_command` sigue esperando tu aprobación. Ningún cambio de perfil ni de modelo autoriza un comando en silencio: activar la terminal es un ajuste aparte y solo se aplica con un modelo local. Una sola línea de comandos puede cambiar archivos fuera del proyecto, instalar programas o conectarse a Internet. Los comandos encadenados (`&&`, `;`, tuberías), `$(...)`, los scripts (`./setup.sh`, `npm run …`, `python tool.py`) y los instaladores pueden hacer mucho más de lo que muestra la línea: la tarjeta avisa de ellos, pero lee la línea y aprueba solo lo que entiendas.

#### Cuando Meta Cloud está seleccionado en Agent

El runtime seleccionado, no los indicadores verdes de conexión, decide qué modelo recibe la petición. Si está seleccionado **Meta Model API — Cloud (`muse-spark-1.3`)**, Spark continúa dirigiendo Agent aunque la cabecera también indique que Glimmer local está conectado. RAME muestra entonces **Review what would be sent to Meta** antes de que salga contexto local elegible. La casilla adicional controla si Meta puede recibir también los resultados de las herramientas que Spark pida ejecutar a RAME —contenido de archivos, búsquedas y salida de pruebas— para ese hilo, clase de tratamiento, revisión de credencial y sesión de VS Code; los valores reconocibles como secretos se censuran mediante patrones, que no pueden detectar todos los datos sensibles.

- **Casilla marcada:** permite que esos resultados censurados lleguen a Meta bajo las condiciones mostradas.
- **Casilla desmarcada:** las herramientas todavía pueden ejecutarse según el perfil local, pero sus resultados se sustituyen antes de la siguiente petición a Meta.
- **Send with this context:** envía el contexto nuevo mostrado y el material autorizado anteriormente bajo las mismas condiciones.
- **Send without it:** mantiene en local el contexto nuevo ofrecido; Meta todavía puede recibir la petición actual, sus respuestas anteriores y material autorizado previamente bajo las mismas condiciones.
- **Cancel:** no envía la petición.

`web_search`, `web_fetch` y `run_command` son herramientas exclusivas de modelos locales y no se ofrecen a Spark. Para probar web o terminal, cancela la divulgación cloud, selecciona un runtime local de Glimmer/Ollama/LM Studio, confirma que la inferencia local responde, activa explícitamente la herramienta y repite la petición de Agent. Una revisión futura de la interfaz debería explicar esta incompatibilidad entre modelo y herramienta antes de abrir una tarjeta de divulgación cloud que no corresponde a la intención del usuario.

El 4 de noviembre de 2026, la validación humana registró tres inferencias reales de Chat puro con `muse-spark-1.3`; RAME registró el consentimiento, proveedor, modelo, respuestas observadas y uso de tokens. Esto valida únicamente la conexión directa de Chat con Meta. La matriz completa de divulgación y fallos sigue cubierta por el grabador Meta simulado, y los resultados de herramientas de Agent cloud, Delegated, planificación de Mission y Advisory todavía requieren validación independiente con el proveedor real.

### Misión

Usa **Misión** cuando el resultado necesite más de una respuesta del modelo: crear una aplicación pequeña, terminar tareas relacionadas, repetir pruebas tras los cambios o continuar después de una recarga.

Las Misiones trabajan mediante ejecuciones internas acotadas. RAME guarda puntos de control y puede iniciar la siguiente ejecución sin obligarte a escribir «continúa». Siguen existiendo límites de seguridad: varias ejecuciones sin progreso observado por el host terminan como **bloqueada**, en lugar de ejecutarse indefinidamente.

## Misión paso a paso

### 1. Describe el resultado

Selecciona **Misión** y explica el objetivo, las restricciones y una forma objetiva de comprobarlo:

```text
Corrige la función add de src/calculator.js. No modifiques package.json ni test/.
Ejecuta npm:test. El trabajo solo está terminado cuando npm:check también pase
después del último cambio.
```

RAME pide al modelo seleccionado un plan acotado. Antes de programar más trabajo, el planificador utiliza los puntos de control de la Misión y las evidencias observadas por el host para evitar repetir tareas cuyos criterios ya estén satisfechos. Esto reduce ejecuciones internas redundantes; no permite que el modelo declare terminado el trabajo ni sustituye las comprobaciones obligatorias del host. Ese plan todavía no concede permiso para modificar nada.

### 2. Elige Misión estándar o Misión verificada

- **Misión estándar:** las pruebas normales compatibles del proyecto determinan cuándo termina cada tarea.
- **Misión verificada:** además eliges un comando de aceptación y los archivos que lo definen. RAME calcula sus hashes y ejecuta el comando antes de completar la Misión.

Una Misión verificada aporta una meta más fuerte que comprueba el propio host, pero solo será tan buena como la prueba de aceptación elegida.

### 3. Elige el permiso

- **Supervisada: cada escritura y prueba pregunta:** RAME presenta tarjetas de autorización a medida que avanza.
- **Workspace autónomo: ediciones y pruebas permitidas sin preguntar:** las ediciones y pruebas incluidas pueden ejecutarse bajo una única autorización de Misión.

Agente y Misión utilizan decisiones de permisos independientes:

| | Agente | Misión |
| --- | --- | --- |
| De dónde procede el permiso | Selector **Ask / Safe auto / Workspace full** | Tarjeta de autorización de esa Misión concreta |
| Trabajo autónomo | **Workspace full**, dentro de la política de Agente | **Workspace autónomo**, dentro del permiso de la Misión |
| Escrituras y pruebas | Las gobierna el perfil de Agente seleccionado | Las gobiernan el alcance y las pruebas autorizadas para la Misión |
| Fuera del alcance autorizado | Se rechaza o se muestra para aprobación | Se rechaza, se pausa o exige una nueva autorización de Misión |

Cambiar el selector de Agente no amplía, reduce ni sustituye un permiso de Misión ya concedido. Una Misión puede utilizar internamente el motor de ejecución de Agente, pero eso no la convierte en una petición de Agente: su autoridad sigue procediendo de la tarjeta de Misión mostrada antes de comenzar. La interfaz identifica esas ejecuciones internas como trabajo de Misión y mantiene visible el permiso de la Misión, en lugar de presentar el selector de Agente como su autoridad. Durante una Misión, considera como fuente de verdad el permiso que muestran su estado y sus evidencias.

El workspace autónomo exige marcar **Confío en este proyecto**. La confianza se limita a esa Misión, carpeta, proveedor local y modelo. No es un sandbox del sistema operativo. Los scripts de prueba pueden acceder a archivos, red u otros procesos con tus permisos de usuario.

RAME sigue protegiendo determinadas rutas y vuelve a preguntar por operaciones fuera del permiso, como borrar, mover archivos o modificar la memoria del proyecto. Si cambia `package.json`, también deja de ser válido el entorno de pruebas autorizado anteriormente.

En un proyecto ya preparado, esta autorización permite dejar que la Misión continúe dentro de ese alcance sin aprobar cada escritura y prueba por separado. No es una autorización universal para el ordenador, otras carpetas, otros modelos o cualquier comando. En una carpeta vacía siguen existiendo dos autorizaciones: la primera puede crear el andamiaje, los scripts del paquete y las pruebas propuestas; la segunda permite revisar esas nuevas órdenes de verificación y autorizar la implementación y las comprobaciones. Después de esa segunda autorización, el trabajo permitido dentro del alcance continúa sin pedir aprobación para cada escritura o prueba ordinaria.

### 4. Configura, si quieres, un presupuesto de asesoramiento Meta

Una Misión local puede autorizar desde el principio entre **0 y 5 consultas** de asesoramiento a Meta. También puedes limitar los bytes por petición, los bytes totales enviados, los tokens máximos de cada respuesta y el presupuesto remoto total. Los límites quedan fijados en el permiso de la Misión; RAME no los aumenta por iniciativa propia.

El asesoramiento Meta es opcional e independiente de los permisos de archivos y pruebas. Cada nueva autorización de Misión empieza sin heredar permisos web ni Meta; debes elegir deliberadamente el presupuesto en esa tarjeta. Con cero consultas, la Misión permanece por completo en el modelo local configurado. Con un valor superior a cero, RAME solo puede consultar al modelo Meta seleccionado dentro de los límites de destinatario, datos y presupuesto que muestra la autorización.

Por ejemplo:

| Elemento | Ejemplo autorizado |
| --- | --- |
| Modelo principal | Muse Glimmer local |
| Consultas a Meta | Hasta 3 |
| Control de herramientas | Glimmer bajo el permiso de la Misión |
| Datos y coste | Límites de bytes y tokens elegidos al autorizar |

El asesoramiento solo se solicita para un bloqueo reproducible identificado por una comprobación que falla. La revisión identifica el material acotado que puede salir del equipo; Meta recibe únicamente esa consulta autorizada, no el control del workspace. Spark no recibe herramientas, no puede escribir archivos ni declarar recuperado el bloqueo. Glimmer conserva el control de las operaciones, aplica cualquier corrección autorizada y el host debe repetir el verificador original bajo las mismas condiciones registradas antes de continuar normalmente. Una consulta cancelada antes de enviarse no consume el contador; una enviada sí cuenta aunque falle. Al agotarse cualquier límite, RAME mantiene el bloqueo, no reintenta automáticamente ni convierte silenciosamente la Misión en una ejecución cloud.

### 5. Comprende la aceptación

Una **comprobación de aceptación** es un script permitido de `package.json`, como `npm:check`. Los archivos seleccionados definen qué comprueba. Al autorizar una Misión verificada, RAME congela sus hashes.

Después de congelarlos:

- Las herramientas de RAME no pueden reescribir silenciosamente esos archivos.
- Si cambia un archivo congelado, la Misión se bloquea.
- El host ejecuta el comando de aceptación antes de completar la Misión.
- Un modelo no puede sustituir un resultado fallido por una afirmación escrita de éxito.

Una comprobación en verde solo demuestra lo que esa comprobación cubre. Una prueba débil puede omitir comportamientos rotos, problemas de uso, incompatibilidades o fallos de seguridad.

**También se protege lo que usa la comprobación.** Antes de autorizar, RAME ejecuta la comprobación una vez y observa qué procesos ejecuta y qué archivos carga y lee. Los auxiliares, los datos y los archivos de prueba que ejecuta la orden se congelan con ella, y las carpetas de pruebas que ejecuta o lista quedan selladas: ahí no se puede añadir nada. RAME registra además todos los demás archivos del proyecto. Si algo más de lo que usa fuera a quedar modificable, por ejemplo el código bajo prueba, un diálogo lo lista y te pide confirmación. Cancela si un archivo listado forma parte en realidad de la prueba, como unos valores esperados, y añádelo a los archivos de aceptación. Si RAME no puede saber de qué depende la comprobación, no ofrece una comprobación protegida; usa entonces una Misión estándar.

**Protegida o reforzada.** Una comprobación protegida se decide por su código de salida. El código bajo prueba se ejecuta en el mismo proceso y podría terminarla antes de tiempo, así que, para una evidencia más sólida, añade un archivo `*.rame-cases.json` a los archivos de aceptación:

```json
{ "rameCases": 1, "module": "src/calculator.js",
  "cases": [ { "call": "add", "args": [19, 23], "expect": 42 } ] }
```

RAME llama entonces a esas funciones en un proceso aparte y compara él mismo los resultados; los valores esperados nunca se envían a ese proceso y las herramientas de RAME no se los muestran al agente. Una salida prematura o un falso mensaje de «todo aprobado» no pueden superarla. El informe de la Misión indica qué nivel se alcanzó y con qué versión de Node se ejecutó la comprobación. Los valores no son secretos: el código que se ejecuta con tus permisos todavía puede leer el archivo, así que haz casos variados.

**No verificable.** Después de cada ejecución de la comprobación, RAME compara el proyecto con lo que registró al autorizar. Si cambió un archivo que usa la comprobación (en Linux y macOS, aunque se restaurara antes del final), apareció un archivo en una carpeta sellada, cambió un archivo de datos o un documento que ya existía, o RAME vio a la comprobación usar algo fuera del alcance que aprobaste, la Misión se detiene como **no verificable**: no cuenta como aprobado y tu aceptación queda tal como la autorizaste. Si solo cambió otro código, RAME te muestra los archivos y te pregunta (una revisión de alcance); apruébalos solo si son código bajo prueba, no pruebas ni valores esperados. Consulta [Cómo verificarlo](VERIFICATION.es.md).

### 6. Autoriza y sigue el progreso

Revisa el objetivo, el nivel de verificación, el permiso y el posible permiso de asesoramiento de Meta. Pulsa **Autorizar e iniciar** solo cuando coincidan con tu intención.

Durante la Misión puedes consultar:

- **Actividad:** propuestas de herramientas y acciones del host.
- **Registro del host:** hechos breves escritos por RAME y no por el modelo.
- **Detalles de la ejecución → Evidencia del modelo — registrada por RAME Code:** qué proveedor respondió, cómo se trató una herramienta y qué comprobaciones posteriores se observaron.
- **Misión → Evidencias:** puntos de control, pruebas y estado de la aceptación.

«Comprobado después» indica orden temporal, no demuestra que una acción causara el resultado.

### 7. Pausa, reanuda o recupera tras una recarga

El estado y los puntos de control de la Misión persisten. Cerrar o recargar VS Code no repite automáticamente una acción cuyo resultado sea desconocido. Abre de nuevo el hilo y pulsa **Reanudar** cuando proceda. Revisa el workspace si RAME informa de una acción interrumpida o incierta.

**Cancelar Misión** es definitivo. **Pausar** detiene el trabajo hasta que lo reanudes.

### 8. Misión completada o bloqueada

RAME solo completa una Misión cuando sus condiciones observadas por el host pasan después del último cambio relevante. Una Misión verificada debe superar además su aceptación congelada.

Si varias ejecuciones no producen progreso verificable, la Misión queda **bloqueada**. Lee el bloqueo y las evidencias; después utiliza **Reintentar con indicaciones**, inicia un nuevo flujo autorizado de verificación o cancela. No des por buena sin más la última explicación del modelo.

## Empezar en una carpeta vacía

RAME Code v0.2.0 incorpora una Misión de arranque con dos autorizaciones:

1. La primera autorización puede crear el proyecto inicial, `package.json`, scripts y pruebas.
2. No permite ejecutar esas nuevas pruebas ni completar la Misión.
3. RAME revoca ese permiso y se detiene en **Scaffold ready**.
4. Tú inspeccionas los scripts y pruebas generados.
5. Una segunda autorización elige Misión estándar o verificada y, en una verificada, congela los archivos de aceptación seleccionados.

Mientras una Misión espera una autorización, el aviso bajo el campo de mensaje dice qué fase es (fase 1 de 2: crear los ficheros; fase 2 de 2: ejecutar las pruebas) y **Revisar** te lleva a ella. Cada tarjeta de autorización nueva se abre con el acceso web y las consultas a Meta desactivados. Una Misión sigue su propia autorización, nunca el selector de permisos del Agente: Supervisada pregunta antes de cada escritura y prueba; Workspace autónomo ejecuta las escrituras y pruebas de su permiso y pregunta por todo lo demás.

**Limitación conocida (versión posterior).** Tras la segunda autorización, Muse Glimmer sigue ejecutando las pruebas aprobadas mediante algunos pasos del modelo; el host todavía no las ejecuta directamente en cuanto apruebas. Un plan antiguo con un paso aparte de «ejecutar las pruebas e informar» cuesta un run interno más.
6. Solo entonces puede continuar la implementación y verificación.

Así se evita que un modelo cree una prueba fácil y la utilice silenciosamente como autoridad final.

### Revisión opcional experimental con Spark

La candidata de trabajo contiene una revisión independiente opcional de la aceptación en **Scaffold ready**. Tiene cobertura automatizada con Meta API simulada, pero todavía no ha completado la validación con Meta real y toda la interfaz humana. Trátala como experimental hasta que se registre esa validación.

RAME muestra primero el requisito exacto y acotado y los fragmentos seleccionados. Una autorización separada y de un solo uso los envía a un modelo Meta **Estándar** documentado. Spark no recibe herramientas y no puede modificar, aprobar, congelar ni completar nada. Sus observaciones son consejos no confiables; puedes considerarlas o descartarlas antes de la segunda autorización local.

Una cancelación, respuesta malformada, fallo de API o presupuesto agotado mantiene disponible el recorrido local y no provoca reintentos automáticos.

## Ejemplo práctico: reproductor WAV para Windows

Objetivo:

> Crear un reproductor WAV para Windows con interfaz gráfica, archivo ejecutable e instalador.

### Con Agente

Agente es útil para explorar o construir una parte cada vez:

1. Pídele que inspeccione el proyecto vacío o existente.
2. Elige tú el lenguaje y toolkit de interfaz.
3. Aprueba la creación de los archivos fuente.
4. Pide pruebas unitarias y ejecútalas.
5. Solicita la configuración de empaquetado.
6. Revisa cada artefacto y pruébalo en Windows.

Es un recorrido interactivo y ofrece control cercano, pero debes dirigir la secuencia.

### Con Misión

Normalmente, Misión es más apropiada para el resultado completo:

```text
Crea un reproductor WAV pequeño para Windows con reproducir, pausar, detener y
seleccionar archivo. Mantén comprobables la lógica de audio y la interfaz. Añade
pruebas automatizadas compatibles y configuración de empaquetado. No afirmes que
el ejecutable o instalador funciona si no se ha construido y probado realmente
en un entorno Windows compatible.
```

Usa una Misión verificada solo cuando ya exista un comando de aceptación compatible que sea significativo o cuando el punto de control de arranque te permita revisar uno.

Las pruebas estáticas pueden comprobar estructura y parte de la lógica, pero no demuestran que la reproducción de audio, el `.exe`, los permisos del instalador, los accesos directos o la desinstalación funcionen en un Windows real. Hay que construir y probar en Windows con las herramientas necesarias.

## Más ejemplos

### Ampliar RAME Code con integración nativa de Ollama

RAME puede trabajar sobre su propio repositorio igual que sobre otro proyecto si lo abres expresamente como carpeta de VS Code. No necesita ninguna capacidad especial para escribir y probar una nueva integración. Para explorar el cambio de forma interactiva, usa Agente; para coordinar proveedor, ajustes, selección de modelos, compatibilidad anterior y pruebas, suele ser más adecuado Misión.

Un encargo prudente sería:

```text
Añade integración nativa opcional con Ollama sin romper el recorrido administrado
de Muse Glimmer mediante llama-server. Permite detectar un endpoint loopback,
enumerar y seleccionar modelos de forma explícita y añade pruebas que distingan
un runtime administrado por RAME de un endpoint externo que RAME nunca debe detener.
Conserva llama-server como opción y no descargues ni ejecutes nada fuera del alcance
autorizado.
```

RAME puede modificar fuentes y ejecutar las comprobaciones permitidas. Eso no significa que deba reemplazar silenciosamente la extensión que está ejecutando la propia Misión. Después hay que construir una candidata, instalarla deliberadamente, comprobarla en otra sesión o perfil de VS Code y conservar una vía manual de regreso a la versión anterior.

### Crear una barra de tareas y un menú Inicio alternativos para Windows

RAME puede intentar desarrollar una aplicación con estética de Windows 10 que funcione sobre Windows 11. Es más seguro tratarla como una aplicación de escritorio alternativa que como una sustitución de componentes internos de Windows.

Por su amplitud, conviene dividirla en varias Misiones: prototipo visual y navegación; lanzamiento y búsqueda de aplicaciones; integración con ventanas y bandeja; empaquetado, inicio de sesión y desinstalación. Cada fase debe conservar una forma comprobable de volver al escritorio normal.

Las pruebas estáticas realizadas en otro sistema no demuestran que la barra, el menú Inicio, el foco, las ventanas, el instalador o la restauración funcionen realmente. La validación final debe ejecutarse en Windows, preferiblemente primero en una máquina virtual o cuenta de prueba, sin reemplazar ni eliminar el shell del sistema.

### Corregir un error existente

Usa **Agente** para un cambio acotado:

```text
Reproduce primero la prueba que falla. Corrige únicamente el analizador de fechas,
ejecuta npm:test e informa de los archivos cambiados y del código de salida real.
```

Usa **Misión** si afecta a varios componentes o necesita verificaciones repetidas.

### Crear un plugin de WordPress

Agente puede crear archivos PHP, JavaScript y CSS dentro de la carpeta seleccionada. Misión puede organizar el trabajo si el proyecto expone scripts npm compatibles para comprobaciones estáticas o pruebas.

RAME 0.2.0 no proporciona un verificador completo del runtime de PHP o WordPress. Un script npm que inspeccione PHP solo demuestra lo que ese script comprueba; no acredita instalación, hooks, base de datos o compatibilidad con un WordPress real.

### Crear una aplicación desde una carpeta vacía

Usa una Misión de arranque. Deja que la primera autorización cree el andamiaje, espera a **Scaffold ready** y examina los scripts y pruebas antes de la segunda autorización.

### Continuar después de reiniciar VS Code

Abre el hilo guardado, inspecciona su estado y evidencias y pulsa **Reanudar** si se ofrece. RAME continúa a partir de puntos de control del host; no reproduce todas las conversaciones ni repite automáticamente una acción incierta.

### Utilizar memoria persistente

Indica a Agente una regla duradera:

```text
En este proyecto, las versiones compatibles de Node empiezan en Node 22.
```

Si el modelo la identifica como duradera, RAME presenta una tarjeta de aprobación. Solo tu aprobación la guarda. Las futuras ejecuciones de Agente y Misión para esa raíz reciben automáticamente la decisión vigente. El repositorio y las respuestas del modelo no cambian por sí solos la memoria.

La tarjeta **Memoria del proyecto** sirve principalmente para inspeccionar. En una ventana con varias raíces, **Carpeta** elige qué memoria estás viendo; no mezcla memorias ni concede acceso.

### Utilizar el asesoramiento opcional de Meta Spark

Activa el escalado cloud en **Seguridad**, configura un modelo Meta Estándar y revisa la autorización exacta. Elige el número máximo de consultas y, si necesitas límites más estrictos, abre los límites avanzados de bytes y tokens. El asesoramiento ofrece a Glimmer una segunda opinión, pero mantiene las herramientas bajo Glimmer y las comprobaciones de permisos de RAME. Ninguna respuesta de Spark completa por sí sola una Misión ni recupera el bloqueo que motivó la consulta; debe pasar el verificador original.

## Seguridad y privacidad en lenguaje sencillo

### ¿Por qué pide permisos RAME?

Leer, escribir, ejecutar pruebas y enviar información a un modelo cloud tienen consecuencias distintas. RAME los mantiene separados para que un modelo no consiga más autoridad simplemente pidiéndola en su texto.

Las aprobaciones suelen quedar vinculadas a la acción, proyecto, hilo, proveedor y estado relevante de los archivos. Si cambian esas condiciones, una aprobación antigua no debería reutilizarse.

### Modelos Estándar y Contributor

RAME trata por separado las clases documentadas por Meta Estándar y Contributor. Según las condiciones de Meta, las variantes Contributor pueden utilizar los datos enviados de forma distinta. El consentimiento para un modelo Estándar no se reutiliza automáticamente para uno Contributor. Los modelos no documentados forman su propia clase conservadora.

Lee siempre las condiciones vigentes de Meta antes de compartir datos.

### ¿Qué puede salir del ordenador?

- Las peticiones realizadas directamente con **Meta Model API — Nube**.
- El contexto que apruebes en una tarjeta de divulgación cloud.
- El contenido seleccionado en un asesoramiento o revisión independiente autorizados.
- Los resultados de herramientas solo cuando la divulgación correspondiente de Agente los permita.

RAME no envía automáticamente todo el repositorio. Aplica límites y censura basada en patrones, pero no puede reconocer todos los secretos o datos privados. No utilices credenciales reales, datos personales ni código confidencial en las pruebas actuales.

### ¿Quién controla cada cosa?

- **Glimmer o Spark:** propone texto, código, herramientas o consejos.
- **Tú:** eliges permisos, divulgación cloud y decisiones duraderas.
- **Host de RAME:** valida acciones, ejecuta operaciones permitidas, congela la aceptación y registra resultados observados.

Estos controles reducen el riesgo, pero no convierten VS Code, las dependencias o los scripts en sandboxes de código no confiable.

## Preguntas frecuentes

### ¿Puede Agente crear un proyecto completo?

Puede crear muchos archivos de forma interactiva, según los permisos y herramientas disponibles. Un objetivo amplio con varias etapas suele gestionarse mejor con Misión.

### ¿Puede RAME modificar su propio código?

Sí, si abres deliberadamente el repositorio de RAME como proyecto. Agente puede realizar cambios interactivos y Misión puede coordinar una ampliación con pruebas. La extensión que dirige el trabajo sigue siendo la versión instalada en ese momento: construir e instalar una candidata nueva es un paso posterior que debes realizar y validar de forma deliberada, idealmente en otro perfil o sesión de VS Code.

### ¿Cuándo debería utilizar Misión?

Cuando el trabajo necesite varias tareas relacionadas, continuación autónoma, puntos de control o una condición explícita de finalización. Usa Agente para cambios pequeños o muy interactivos.

### ¿Funciona Misión en una carpeta vacía?

Sí, en v0.2.0 mediante el flujo con dos autorizaciones. Revisa los scripts y pruebas en **Scaffold ready** antes de continuar.

### ¿Tengo que crear yo las pruebas?

No. El modelo puede proponerlas, pero tú decides si representan el requisito real. Las pruebas independientes aportadas por ti ofrecen evidencias más fuertes.

### ¿Puede RAME declararse terminado sin comprobar nada?

Una Misión exige comprobaciones observadas por el host según su nivel. Una Misión verificada debe superar además su aceptación congelada. Las comprobaciones pueden ser incompletas: «superada» no significa «perfecta».

### ¿Puede funcionar sin conexión a Meta?

Sí. Muse Glimmer puede funcionar localmente mediante `llama-server`; el escalado cloud es opcional y está desactivado por defecto. Necesitas el modelo, un servidor compatible y hardware suficiente.

### ¿Qué ocurre si rechazo un permiso?

La acción no se ejecuta. El modelo puede escoger otra vía segura, pedir una aclaración o detenerse. Rechazar una acción no concede una alternativa más amplia.

### ¿Qué sucede si cierro VS Code?

Los hilos, la memoria y el estado de la Misión persisten localmente. Una recarga no repite automáticamente trabajo incierto. Abre de nuevo el hilo, inspecciona el estado y reanuda cuando proceda.

### ¿Puede construir un instalador de Windows?

Puede escribir código y configuración de empaquetado y quizá ejecutar herramientas compatibles. Para afirmar que funciona hay que construirlo y probarlo en Windows bajo las condiciones previstas.

### ¿Qué hago si una Misión se bloquea?

Lee el bloqueo, Actividad, registro del host y evidencias. Comprueba que el verificador siga existiendo y que los archivos congelados no hayan cambiado. Después reintenta con indicaciones, crea un nuevo flujo autorizado o cancela. No debilites las pruebas solo para obtener verde.

### ¿Es Evidencia del modelo un registro de auditoría inalterable?

No. Es un registro local y acotado escrito por el host de RAME. Ayuda a distinguir afirmaciones, acciones y comprobaciones posteriores, pero no demuestra criptográficamente la identidad del modelo ni constituye una auditoría externa inmutable.

## Antes de confiar en un resultado

- Comprueba la carpeta y proveedor seleccionados.
- Lee todos los permisos solicitados.
- Confirma si se enviará algo a Meta.
- Inspecciona los archivos modificados, no solo el resumen.
- Lee el **Registro del host** y **Evidencia del modelo**.
- Confirma el comando de prueba exacto y su código de salida.
- Prueba los artefactos de plataforma en su plataforma de destino.
- Conserva copias de seguridad y control de versiones.

Para detalles técnicos, consulta [ARCHITECTURE.md](../ARCHITECTURE.md). Para los cambios y limitaciones de cada versión, consulta el [Changelog](../CHANGELOG.md).
