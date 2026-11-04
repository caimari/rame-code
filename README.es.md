# RAME Code

**Un agente de programación local con memoria gobernada y Missions verificables.**

**Programación con IA local. Decisiones bajo tu control. Resultados verificados por el host.**

> ¿Y si tu agente de programación funcionara localmente, recordara solo las decisiones que autorizas y no pudiera declarar terminada una tarea comprobada sin superar tus verificaciones autorizadas?

[Instalación](#instalar-manualmente-el-vsix) · [Guía de usuario](docs/USER_GUIDE.es.md) · [**Para el jurado**](docs/JUDGES.es.md) · [Evidencias](evidence/README.md) · [Verificación](docs/VERIFICATION.es.md) · [Última release](https://github.com/caimari/rame-code/releases/latest) · [Web](https://ramecode.com/) · [English](README.md)

RAME Code es un proyecto independiente de código abierto iniciado desde cero durante el [Meta Global AI Developer Hackathon 2026](https://cerebralvalley.ai/e/meta-ai-developer-hackathon/details). Funciona como extensión de VS Code y admite tanto Muse Glimmer local como modelos en la nube mediante Meta Model API.

La versión `0.1.0` es la última release publicada. Esta rama está centrada en el candidato preview `0.2.0`, mucho más amplio y documentado a continuación. Es adecuado para una evaluación controlada en proyectos desechables, pero todavía no constituye una frontera de seguridad para producción.

## Comprende RAME en 20 segundos

| Capacidad | Qué hace RAME |
| --- | --- |
| Agente propio en VS Code | Chat, Agent y Mission funcionan dentro de una extensión gráfica con herramientas, permisos, memoria y host de ejecución propios de RAME. No es solo una interfaz para otro agente. |
| Muse Glimmer local | RAME puede iniciar y detener su propio `llama-server` en loopback; Ollama no es obligatorio. Los pesos permanecen en la infraestructura elegida por el usuario. |
| Memoria gobernada | Solo el usuario autoriza una decisión duradera. Conserva versiones y procedencia, y el texto recordado nunca concede autoridad sobre herramientas. |
| Invalidación causal | Cuando cambia una decisión aprobada, los artefactos verificados ligados a la versión anterior pueden quedar **STALE** hasta volver a comprobarse. |
| Missions verificables | En las Missions con aceptación autorizada, el host ejecuta las comprobaciones congeladas y decide la finalización; la afirmación del modelo no es una prueba. |
| Autoridad y divulgación exactas | Las aprobaciones de un solo uso ligan la acción y sus precondiciones. Antes de enviar contexto local elegible a Meta, RAME muestra el material acotado y las condiciones del destinatario. |

Por ejemplo, si la decisión aprobada «usar Node.js 20» cambia a «usar Node.js 24», un instalador verificado con la decisión anterior puede quedar marcado como **STALE**. RAME conserva el historial; no presenta silenciosamente la evidencia antigua como vigente.

Empieza por [la tabla de afirmaciones y evidencias](docs/JUDGES.es.md). Enlaza una Mission supervisada con Glimmer local, la batería simulada reproducible, los comandos exactos de reproducción y los límites de cada afirmación. Una comprobación verde solo demuestra aquello que realmente cubre.

## La preview 0.2.0

Para el hackathon, el desarrollo ha priorizado deliberadamente la funcionalidad real, la autoridad explícita y las evidencias reproducibles por encima del acabado visual. La interfaz y el logotipo actuales son provisionales. Las siguientes releases mejorarán la arquitectura de información, la accesibilidad, la incorporación de nuevos usuarios y la identidad visual después de completar la validación independiente y humana del comportamiento esencial.

Frente a la primera base pública, el candidato 0.2.0 incorpora memoria gobernada del proyecto, Missions reanudables y verificadas por el host, mayor integridad de la aceptación, evidencia del modelo, conexión con Ollama y LM Studio, acceso web opcional de solo lectura y una terminal experimental para Agent local. La lista completa y auditable está en el [Changelog](CHANGELOG.md#020---unreleased).

## La base 0.1.0

La primera release conserva lo construido durante los primeros días del proyecto. Estableció:

- una extensión de VS Code con modos Chat, Agent y Mission;
- inferencia local de texto mediante un `llama-server` gestionado y acceso opcional a Meta Model API;
- herramientas acotadas para el workspace, perfiles de permisos y autorizaciones exactas de un solo uso;
- hilos persistentes, cancelación y registros de acciones escritos por el host.

Es una base histórica de investigación, no la mejor descripción del candidato actual. Sus capacidades, trabajo de seguridad y limitaciones completos permanecen en el [Changelog de 0.1.0](CHANGELOG.md#010---2026-11-02).

## Trabajo importante todavía pendiente

- **Visión en RAME:** Muse Glimmer y su `mmproj` pueden trabajar con imágenes, pero la extensión todavía no adjunta imágenes ni envía peticiones multimodales a Glimmer local ni a los modelos cloud de Meta.
- **Validación con Meta:** la integración de Meta Model API existe, pero las rutas nuevas de privacidad, Mission y relevo del candidato todavía necesitan una validación final, expresamente autorizada y con datos ficticios contra la API real.
- **Retorno causal entre modelos:** la escalada automática y el regreso al modelo local gobernado por un verificador siguen siendo investigación, no una capacidad publicada.
- **Revisión de terminal:** `run_command` no dispone de sandbox del sistema operativo y debe superar su auditoría de seguridad y validación humana separadas antes de distribuirse públicamente.
- **Distribución:** todavía no se ha publicado ninguna release 0.2. El candidato se está validando como VSIX instalable en un perfil aislado de VS Code; la publicación en el Marketplace llegará después.
- **Plataformas e interfaz:** falta la validación en Windows real. La interfaz y el logotipo actuales son prototipos funcionales que se rediseñarán y pulirán en releases posteriores.
- **Frontera de seguridad:** no se afirma que la ejecución local, las autorizaciones o las evidencias sean resistentes a cualquier manipulación; los comandos y scripts aprobados se ejecutan con los permisos del usuario de VS Code.

El contenido del repositorio, las salidas de herramientas y las respuestas del modelo se consideran datos no confiables. Un modelo no puede concederse autoridad adicional. Consulta la [guía de usuario](docs/USER_GUIDE.es.md) para utilizarlo con seguridad y el [Changelog](CHANGELOG.md#known-limitations) para conocer los límites detallados.

## Instalar manualmente el VSIX

Descarga `rame-code-0.1.0.vsix` desde la [release v0.1.0](https://github.com/caimari/rame-code/releases/tag/v0.1.0).

### Desde la interfaz de VS Code

1. Abre **Extensiones** (`Ctrl+Shift+X`).
2. Abre el menú `...` del panel de Extensiones.
3. Selecciona **Install from VSIX...** o **Instalar desde VSIX...**.
4. Selecciona `rame-code-0.1.0.vsix`.
5. Ejecuta **Developer: Reload Window** si VS Code solicita una recarga.
6. Pulsa el icono **R** de la barra de actividad.

Si utilizas Remote SSH, instala la extensión en el workspace remoto cuando VS Code muestre ese destino.

### Desde un terminal

```bash
code --install-extension rame-code-0.1.0.vsix
```

Si el comando `code` no existe en el servidor remoto, utiliza **Instalar desde VSIX...** en la ventana conectada de VS Code.

## Configurar un modelo

Abre RAME Code y pulsa el engranaje.

### Meta Model API

1. Selecciona **Meta Model API — Cloud**.
2. Crea una clave en el [panel de Meta Model API](https://dev.meta.ai/).
3. Pega la clave independiente en RAME Code y pulsa **Save key**.
4. Actualiza el catálogo y elige un modelo compatible.

La clave solo llega al host de la extensión al pulsar **Save key**. Se guarda en VS Code SecretStorage; la vista únicamente recibe si existe o no. El uso de la API puede consumir créditos o generar cargos en la cuenta de Meta del usuario.

### Muse Glimmer local

RAME Code puede arrancar directamente `llama-server`; Ollama no es obligatorio.

1. Selecciona **Muse Glimmer — Local**.
2. Configura el ejecutable de `llama-server` y el GGUF de Muse Glimmer.
3. Opcionalmente configura el proyector multimodal o el modelo borrador DFlash para el servidor local.
4. Pulsa **Save** y después **Start Muse Glimmer**.

El servidor administrado escucha únicamente en `127.0.0.1`. RAME Code solo detiene el proceso que él mismo inició.

**Servidores de modelos (candidato 0.2.0).** RAME también puede conectarse a un servidor que ejecutas tú: Ollama, LM Studio, otro `llama-server` o cualquier servidor compatible con OpenAI. **Buscar modelos** los distingue, lista sus modelos de chat con información de herramientas, visión y contexto, y un modelo que según el servidor no puede llamar herramientas queda limitado a Chat. Un servidor en otro ordenador de tu red privada (una IP privada numérica) solo se usa después de que confirmes que se le enviará el trabajo local; se rechazan las direcciones públicas y los nombres de equipo, y nunca se siguen redirecciones. La «visión» de la lista es una capacidad del modelo; RAME todavía no envía imágenes. Probado de verdad con Muse Glimmer 30B en LM Studio (RTX 3090 Ti, por la red privada) y con Ollama 0.32.5.

**Acceso web para el Agente (candidato 0.2.0, desactivado por defecto).** `web_search` y `web_fetch`, solo lectura, solo con un modelo local y nunca en las ejecuciones de una Misión; cada llamada se muestra para aprobarla salvo en Workspace full, las direcciones privadas se rechazan después del DNS y en cada redirección, y no se envían consultas con claves o rutas.

**Comandos de terminal para el Agente (candidato 0.2.0, desactivado por defecto).** `run_command` ejecuta una línea de órdenes en la carpeta del proyecto con tus permisos (sin sandbox), solo con un modelo local y nunca en las ejecuciones de una Misión; cada comando se muestra completo y se aprueba en todos los perfiles, también en Workspace full, con límite de tiempo y salida acotada. **Detener** señala el comando y su grupo normal de procesos, pero un proceso desacoplado deliberadamente puede sobrevivir. Consulta la [guía de uso](docs/USER_GUIDE.es.md).

En la extensión pública `v0.1.0`, el funcionamiento local significa que RAME Code envía peticiones de texto a un `llama-server` ejecutado en la propia máquina del usuario. Los modelos se leen desde rutas de disco configuradas por el usuario y no se incluyen en la extensión ni en este repositorio. La alternativa en la nube envía las peticiones a Meta Model API mediante la clave API del propio usuario.

### Stack local Meta Muse probado

El sistema de desarrollo se ha probado con los siguientes archivos suministrados de forma independiente:

| Componente | Archivo probado | Tamaño aproximado en disco |
| --- | --- | ---: |
| Modelo de texto | Muse Glimmer 30B Q4_K_M GGUF | 15,61 GiB |
| Proyector de visión | Muse Glimmer 30B Q4_K_M `mmproj` GGUF | 1,30 GiB |
| Aceleración de texto opcional | Muse Glimmer 30B Q4_K_M DFlash GGUF | 1,52 GiB |

La máquina de desarrollo de RAME Code está equipada con una NVIDIA RTX 5090 y ejecuta Muse Glimmer localmente mediante `llama-server`. El conjunto completo probado ocupa aproximadamente 18,43 GiB en disco. En esta máquina, cargar modelo, proyector y DFlash utilizó aproximadamente 21,3 GiB de VRAM; el consumo real depende de la compilación, el contexto y la descarga de capas a la GPU.

Se necesita una compilación reciente de `llama.cpp` compatible con Muse Glimmer. Un `llama-server` antiguo cualquiera podría no reconocer el modelo o su proyector. Un arranque independiente mínimo con soporte visual sería:

```bash
llama-server \
  -m /ruta/a/Muse-Glimmer-30B-Q4_K_M.gguf \
  --mmproj /ruta/a/mmproj-Muse-Glimmer-30B-Q4_K_M.gguf \
  -ngl 99 \
  -c 32768 \
  --jinja
```

**La visión no está activa en la experiencia de usuario de RAME Code `v0.1.0`.** El runtime local puede configurarse para cargar el `mmproj` suministrado por separado, y ese runtime se ha validado independientemente con imágenes y OCR, pero RAME Code todavía no permite adjuntar imágenes ni envía mensajes multimodales. Hasta implementar y verificar esa integración, RAME Code utiliza este stack local únicamente para peticiones de texto de Agent, Mission y Chat.

## Perfiles de permisos

| Perfil | Comportamiento |
| --- | --- |
| **Ask** | Cada herramienta espera autorización. Es el valor predeterminado. |
| **Safe auto** | Las lecturas validadas se ejecutan automáticamente; escrituras y pruebas requieren autorización. |
| **Workspace full** | Las acciones permitidas pueden ejecutarse sin preguntar. Las políticas continúan activas, pero es un modo de riesgo elevado. |

El agente queda ligado a una carpeta de workspace seleccionada explícitamente. La terminal opcional `run_command` es una capacidad separada de alto riesgo: está desactivada por defecto, solo se ofrece al Agent local, queda fuera de Mission y siempre exige aprobar el comando completo. Las pruebas mediante `run_tests` siguen limitadas a órdenes derivadas de una allowlist y se ejecutan con `shell: false`, aunque el script del proyecto podría ejecutar código arbitrario.

## Misiones de arranque y verificadas (candidato 0.2.0, sin publicar)

Una Mission puede comenzar en una carpeta vacía. Su primera autorización explícita de arranque puede crear la estructura del proyecto, los scripts del paquete y las pruebas, pero no puede ejecutar esas pruebas ni completar la Mission. RAME revoca entonces ese permiso y se detiene en **Estructura preparada**. El usuario revisa el nuevo comando permitido y los archivos de prueba en una segunda autorización; solo esa segunda autorización puede congelar la aceptación y permitir que continúe la Mission.

En ese punto puede prepararse una **revisión independiente opcional de aceptación** con un modelo Meta Estándar documentado. Prepararla no envía nada: RAME muestra primero el texto exacto y acotado, incluido el requisito original y hasta tres fragmentos de pruebas elegidos entre los candidatos de aceptación ofrecidos. Enviarla requiere una autorización independiente de un solo uso, ligada a la Mission, carpeta, modelo, clase de tratamiento, revisión de la credencial, contenido y límites de bytes/tokens. Spark no recibe herramientas y no puede editar archivos, conceder permisos, elegir o congelar la aceptación ni completar la Mission. Su resultado estructurado es un consejo no confiable que el usuario puede considerar o descartar antes de tomar la decisión local definitiva. Cancelar, superar el presupuesto, recibir una salida mal formada o sufrir un fallo de API deja disponible el flujo local en dos etapas y nunca provoca un reintento automático. En este candidato, esta vía solo se ha verificado con una API de Meta simulada.

## Integridad de la aceptación (candidato 0.2.0, sin publicar)

Una Mission se verifica en uno de tres niveles, y el nivel queda escrito en sus notas del host y en su informe final:

- **Convencional (Mission estándar).** Una prueba permitida del proyecto pasa después del último cambio.
- **Protegido (Mission verificada).** El host ejecuta él mismo la comprobación de aceptación congelada por el usuario, la observa hasta el final y exige que salga con 0. Antes de autorizar, RAME la ejecuta una vez bajo su propia traza y la analiza para encontrar los procesos que ejecuta y los módulos y ficheros que usa, y guarda ese alcance en la autorización junto con una huella de cada fichero del proyecto. Se congelan los auxiliares, los datos y los ficheros de prueba que ejecuta la orden, y se sellan las carpetas de pruebas que ejecuta o lista. Lo que vaya a quedar modificable se muestra en un diálogo modal para que lo confirmes. Una comprobación cuyas dependencias no se pueden determinar no se protege: RAME ofrece la verificación convencional como alternativa. Se rechazan las escrituras que cambiarían un fichero congelado, una carpeta sellada o cómo los resuelve Node. Después de cada ejecución del host, RAME compara todo el proyecto con su propio registro (el SHA-256 de los bytes de cada fichero): un cambio fuera del alcance autorizado nunca cuenta como aprobado. En Linux y macOS, los tiempos de cambio del núcleo muestran además un fichero cambiado y restaurado durante la ejecución; en Windows solo se afirma el estado al inicio y al final, y el informe lo dice.
- **Reforzado.** Una comprobación protegida más un fichero `*.rame-cases.json` congelado. El ejecutor de casos de RAME llama al código bajo prueba en un proceso aparte y el host compara él mismo cada resultado; los valores esperados no se envían a ese proceso y quedan ocultos para las herramientas del agente. Un `process.exit(0)` prematuro o una salida falsificada no pueden aprobar. Esto no hace secretos los valores esperados: no hay sandbox, y el código que se ejecuta con tus permisos puede encontrar el fichero en disco. En el nivel protegido, una comprobación es tan fiable como su código de salida: el código bajo prueba que se ejecuta en su mismo proceso puede terminarla antes de tiempo.

Cuando RAME no puede demostrar que se cumplieron las condiciones autorizadas, el resultado es **no verificable**: nunca es un aprobado, la Mission se bloquea con el motivo y la aceptación autorizada no cambia.

Estas garantías se ponen a prueba con una batería de sabotaje **SIMULATED** (`npm run demo:sabotage`): 44 intentos de completar una Mission sin hacer el trabajo, incluidas las reproducciones de auditorías independientes. 3 todavía funcionan y se documentan como límites:

- una comprobación débil superada con constantes;
- un auxiliar que el usuario confirmó como modificable;
- `process.exit(0)` en el nivel protegido.

La traza de RAME se ejecuta junto al código bajo prueba y se puede falsificar, así que solo es una ayuda para descubrir; lo que decide es lo que comprueba el propio host (los hashes y la huella del proyecto). Separar procesos no es un sandbox. Si VS Code se cierra o se recarga durante una Mission, la ventana antigua no inicia ni escribe nada más. Consulta [Cómo verificarlo](docs/VERIFICATION.es.md). Los resultados se etiquetan como **REAL**, **SIMULATED** o **RECORDED**, y una simulación nunca se presenta como una ejecución real con Glimmer o con Meta.

## Evidencia del modelo (candidato 0.2.0, sin publicar)

> RAME doesn't just show what an AI agent did. It shows which model proposed it, what the host allowed, and what independent checks actually passed.

En el candidato 0.2.0, **Detalles de la ejecución → Evidencia del modelo — registrada por RAME Code** muestra, para el hilo abierto, hechos que escribe el host y nunca el modelo. La sección empieza plegada. Primero aparecen las inferencias que propusieron un cambio o una prueba, produjeron la respuesta final, implicaron a Meta o están enlazadas a una comprobación. Las lecturas exploratorias quedan un nivel más abajo y acotadas.

Se distinguen tres niveles:

| Nivel | Qué significa | Qué no significa |
| --- | --- | --- |
| **Configurado** | Los ajustes indican un fichero de modelo (solo su nombre), el contexto y si se pasan un `mmproj` y un borrador DFlash. | Que algo esté en ejecución o haya respondido. |
| **En ejecución** | RAME lanzó `llama-server` con esos argumentos y posee el proceso, o un endpoint respondió a su comprobación. `/props` puede confirmar el contexto y la plantilla de Muse Glimmer. | Que los pesos sean exactamente esos. No se verifica nada criptográficamente. |
| **Respuesta observada** | Ese proveedor respondió a una inferencia real en la ejecución registrada, con los tokens, el motivo de fin y el tipo de respuesta (texto o llamadas a herramientas) que informó. | Nada más allá de esa respuesta. Una clave guardada o un endpoint guardado nunca cuentan. |

Un endpoint externo compatible con OpenAI aparece con la **identidad no verificada**, incluso después de responder. RAME no supone que sea llama.cpp.

Cuando el host puede enlazarlos con sus propios identificadores, cada inferencia queda enlazada a las llamadas a herramientas que propuso. Cada llamada queda enlazada a la decisión de aprobación o de política, a la acción del host (con su digest de Activity) y a la primera comprobación que el host ejecutó tras un cambio en la misma ejecución. Si no hay enlace, la vista lo dice: «No consta ninguna acción del host» o «No consta ninguna verificación enlazada». Una comprobación posterior indica orden, no causa.

En una Mission se muestran por separado tres estados:

- **Comando superado** (por ejemplo `npm:check exit=0`): un comando terminó con 0. Eso solo no significa que se cumpliera el objetivo.
- **Aceptación congelada superada**: la comprobación de aceptación congelada del usuario, ejecutada por el host, pasó. Una Mission estándar indica «Sin comprobación de aceptación congelada».
- **Misión completada por el host**: solo aparece cuando la propia lógica de la Mission la completó.

Cuando participa Meta Model API, el registro muestra el modelo, su autoridad, si se observó respuesta y el uso. **Advisory** significa que Glimmer conservó el control de las herramientas. **Delegated** significa que Spark propuso herramientas y RAME aplicó el perfil de permisos existente. Un fallo de Meta se registra como una categoría saneada, nunca como respuesta observada. La tarjeta de consentimiento sigue siendo el lugar donde revisar lo autorizado; el payload no se copia a la evidencia.

El registro no guarda prompts, mensajes, razonamiento, argumentos de herramientas, contenido de ficheros, respuestas, rutas absolutas ni credenciales. Está versionado, se valida al cargarse, está acotado por hilo y sobrevive a las recargas. Lo que no se puede leer se descarta entero, y restaurarlo nunca repite una acción. Es un registro local de conveniencia, no un registro de auditoría a prueba de manipulaciones.

## Memoria del proyecto, hilos guardados y contexto del modelo

Son tres capas diferentes:

- **La memoria del proyecto** contiene únicamente decisiones duraderas aprobadas por el usuario, su historial de versiones y, opcionalmente, vínculos con archivos verificados. No es una transcripción y no se rellena porque un fichero del repositorio o una respuesta del modelo mencione un valor. RAME la guarda fuera del repositorio, en el almacenamiento global de la extensión de VS Code, con un ámbito independiente derivado de la ruta canónica de cada raíz del workspace. Sobrevive a los hilos y a las recargas de VS Code en esa instalación, pero no se sincroniza con otra máquina o perfil. Mover o renombrar la raíz le da una identidad nueva.
- **Los hilos guardados** conservan la conversación para la interfaz y la recuperación. Guardar un hilo no significa que todos sus turnos antiguos vuelvan a enviarse al modelo.
- **El contexto del modelo** es la petición acotada que se construye para una inferencia. Es temporal y no es memoria persistente.

El selector **Carpeta** de Memoria del proyecto es un visor para ventanas de VS Code con varias raíces: elige de qué carpeta abierta muestran los Ajustes las decisiones, el historial y el estado de los archivos vinculados. No concede acceso, no mezcla memorias ni obliga a que ejecuciones del Agent en otras carpetas usen esa memoria. Con una sola carpeta abierta, RAME la selecciona automáticamente. Con varias raíces, cada hilo del Agent queda ligado a la raíz elegida para esa ejecución y recibe automáticamente la memoria autorizada de esa raíz. Un hilo de Chat también se vincula al proyecto cuando no hay ambigüedad (la única carpeta abierta, o la elegida aquí); nunca pregunta, y vincularse le da las decisiones autorizadas del proyecto, no herramientas ni acceso a archivos. Una raíz nueva empieza con memoria vacía hasta que se aprueba su primera decisión duradera. Una subcarpeta comparte la memoria de la raíz que la contiene, salvo que se abra o añada como raíz de workspace independiente.

Los límites actuales de continuidad son explícitos:

- Agent y Chat seleccionan turnos recientes completos según el presupuesto de contexto del modelo activo, hasta 120 turnos y 120.000 caracteres. Una ventana desconocida usa un límite conservador de 12.000 caracteres. Veinte mensajes ya no son la frontera principal de continuidad.
- RAME construye además un punto de control operativo compacto desde el hilo persistido: versiones vigentes de la memoria autorizada, referencias exactas, ficheros y acciones registrados por el host, pruebas y errores o bloqueos. La prosa del modelo nunca se convierte en un hecho del host. El punto se vuelve a derivar tras una recarga, por lo que se mantiene actualizado sin crear una segunda memoria competidora.
- En Agent y Chat, RAME puede recuperar hasta seis extractos antiguos exactos y ocho hechos anteriores del host. La recuperación es local y léxica: normalización Unicode y de acentos, morfología ligera inglesa/española, entidades y rutas exactas y un conjunto pequeño y deliberado de conceptos generales entre idiomas. Agent y Mission también pueden formular hasta tres preguntas breves en una llamada acotada a `search_history` (como máximo dos veces por ejecución). El host busca en el hilo persistido y devuelve extractos exactos; un Agent cloud no recibe extractos antiguos locales protegidos. El paquete automático adicional sigue acotado entre 4.000 y 24.000 caracteres.
- Un plan local de Mission recibe el mismo paquete de continuidad acotado que Chat, más las decisiones autorizadas del proyecto; un plan con Meta recibe solo la petición. Las ejecuciones internas autónomas continúan mediante puntos de control y evidencias acotados escritos por el host, en vez de reproducir todas las conversaciones internas anteriores, y cada ejecución recupera además hasta seis extractos exactos de la conversación del propio usuario, buscados por el objetivo de la Mission, su tarea actual y la última petición del usuario. Los extractos nunca proceden de las ejecuciones internas escritas por el host ni cambian la autorización de la Mission.

La recuperación es extractiva: el modelo recibe el extracto exacto guardado con su número de turno, fecha y tipo de coincidencia, nunca un recuerdo generado. Cada recuperación (automática en Chat, Agent, un plan o una ejecución de Mission, y cada llamada a `search_history`) queda registrada en **Detalles de la ejecución → Evidencia del modelo → Contexto recuperado — registrado por RAME Code**, aparte del registro del host y de las evidencias de Mission: las posiciones de los turnos, roles, fechas, tipos de coincidencia y el sha256 del texto guardado exacto del que salió cada extracto, más un hash de la consulta y cuántos mensajes locales no se compartieron con Meta. No guarda extractos, consultas ni respuestas; cualquiera puede recalcular los hashes a partir del hilo guardado. Los extractos se etiquetan como conversación no fiable; los hechos anteriores del host, como observaciones pasadas posiblemente obsoletas que deben comprobarse. Ninguno se convierte en decisión. Las decisiones aprobadas siguen siendo la única autoridad persistente y su versión vigente prevalece sobre cualquier conversación antigua. La recuperación léxica todavía puede perder paráfrasis fuera de su normalización, morfología y pequeño mapa de conceptos.

En el árbol fuente se conservan un cliente experimental de embeddings locales y un puente de ordenación semántica para trabajo futuro, pero en v0.2.0 están desactivados y no tienen ningún llamador en tiempo de ejecución. No añaden dependencias, descargas, servicios de fondo, ajustes ni cambios al servidor Glimmer distribuido. La recuperación semántica opcional queda aplazada a una versión posterior.

Cambiar de motor o de modelo en la nube afecta a la petición siguiente, no al hilo guardado. RAME registra qué proveedor y modelo produjo cada respuesta nueva del asistente. En la petición siguiente avisa al modelo elegido si hubo relevo, incluye el paquete de continuidad acotado y aclara que los permisos y la autoridad no pasan de un modelo a otro; hacia Meta, un modelo local solo se nombra como «a local model». Chat Completions de Meta no conserva estado entre peticiones, por lo que RAME selecciona y reenvía cada elemento que quiere que vea un modelo. Una Mission autorizada sigue ligada a su proveedor y modelo y nunca migra silenciosamente. Las respuestas antiguas guardadas antes de registrar la procedencia no reciben un origen supuesto y reciben el tratamiento local conservador.

**Divulgación a Meta.** Antes de que una petición de Chat, Agent o Delegated a Meta lleve mensajes que Meta no haya recibido en las mismas condiciones, o las decisiones autorizadas del proyecto, RAME muestra **Revisa lo que se enviaría a Meta**. La tarjeta lista todos los mensajes locales que llevaría la petición: los nuevos elegibles y, como **también se reenvían**, los aprobados antes; juntos no superan 20 mensajes y 12.000 caracteres, con sus registros del host, de modo que las aprobaciones no se acumulan. **Enviar con este contexto** envía exactamente eso; **Enviar sin él** envía la petición, las respuestas anteriores de Meta en las mismas condiciones y los mensajes aprobados antes, mantiene en local lo ofrecido y no lo vuelve a ofrecer; **Cancelar** no envía nada. Cada respuesta queda ligada al destinatario (Meta Model API), a todos los campos mostrados de cada mensaje (rol, fecha, texto y registro del host), a la clase de tratamiento —los modelos estándar documentados de Meta comparten una, sus variantes Contributor documentadas (según las condiciones de Meta pueden usar lo que reciben) comparten otra, y cualquier otro id de modelo es su propia clase— y a la clave de la API de Meta con la que se dio (una revisión opaca que cambia cada vez que se guarda o se borra una clave; no se guarda ni la clave ni un hash de ella). Cambiar entre modelos estándar reutiliza las respuestas; una variante Contributor, un modelo no documentado o una clave nueva o borrada vuelven a preguntar, también por los intercambios que Meta recibió en otras condiciones. Una tarjeta pendiente queda anulada si cambian el modelo, su clase, la clave, el hilo o las decisiones. Las decisiones del proyecto aprobadas llegan a Meta exactamente como se mostraron (clave, valor y versión): nunca propuestas pendientes, archivos verificados ni procedencia. En modo Agent la tarjeta pregunta además, una vez por hilo, clase de tratamiento, clave y sesión de VS Code, si Meta puede recibir resultados de herramientas (contenido de archivos, búsquedas, salida de pruebas); sin esa respuesta las herramientas se ejecutan en local pero su salida se sustituye antes de enviarla. La tarjeta de aprobación de una ejecución delegada cubre la salida de sus herramientas. **Dejar de compartir con Meta**, bajo la conversación, retira todas las respuestas del hilo; no puede recuperar lo que Meta ya recibió. Un registro de divulgación ilegible cuenta como nada compartido.

**Qué significa en la práctica la tarjeta de Agent.** La casilla marcada de resultados de herramientas permite que Meta reciba sus resultados censurados por patrones durante las condiciones mostradas de hilo y sesión; desmarcarla mantiene esos resultados fuera de Meta aunque RAME ejecute las herramientas localmente. **Enviar sin él** solo retiene el contexto nuevo ofrecido: el material autorizado anteriormente todavía puede reutilizarse bajo los mismos vínculos de destinatario, clase de tratamiento, credencial y contenido. El runtime seleccionado decide quién controla Agent: si está seleccionado Meta Cloud, Spark sigue siendo el modelo aunque Glimmer también figure como conectado. Las herramientas locales `web_search`, `web_fetch` y `run_command` no se ofrecen a Spark; cancela y elige un runtime local que responda para utilizarlas. Son controles técnicos de privacidad desde el diseño relacionados con transparencia y minimización, no una prueba de cumplimiento del RGPD ni una base jurídica para el tratamiento.

Antes de que salga cualquier petición a Meta, RAME comprueba la petición que realmente construyó: detiene la que llevaría un mensaje local no aprobado en sus condiciones, o cuya clave de API cambió durante la ejecución; sustituye las rutas absolutas de las carpetas de proyecto abiertas y de la carpeta personal (en Windows sin distinguir mayúsculas, con `\`, `/` o formato UNC, sin tocar rutas parecidas); y censura en los resultados de herramientas que envía los valores con aspecto de secreto (claves, tokens, claves privadas, JWT, credenciales en URL, asignaciones del estilo `*_PASSWORD=` o `*-auth=`). La censura y la sustitución de rutas se basan en patrones: reducen, pero no pueden excluir, el contenido sensible del material que permitas recibir a Meta, y las rutas absolutas distintas de esas carpetas se envían tal como aparecen. La comprobación reconoce textos locales de 24 caracteres o más; los mensajes locales más cortos quedan fuera por cómo se construye cada petición —solo la parte aprobada del hilo, sin búsqueda en el historial para Meta, solo decisiones aprobadas, nunca las notas propias de RAME—, lo que las pruebas automáticas verifican en cada vía (Chat, Agent y sus herramientas, Delegated, plan de Mission), no por detección. Es un control técnico de divulgación, no un consentimiento jurídico conforme a la normativa de protección de datos.

**Limitaciones de privacidad del candidato:** la inspección exhaustiva de peticiones y la cobertura de fallos siguen utilizando una API de Meta simulada que registra cada petición completa. El 4 de noviembre de 2026, el build candidato `e383ea4.src.48ae3cd77018` completó además dos inferencias reales de Chat puro con `muse-spark-1.3`, con consentimiento y Model evidence registrados por RAME; eso valida únicamente la conexión directa de Chat, no los resultados de herramientas de Agent cloud, Delegated, planificación de Mission ni Advisory. Las clases de tratamiento proceden de los ids de modelo documentados que figuran en el código y deben revisarse cuando cambien el catálogo o las condiciones de Meta. En Agent, los mensajes anteriores de más de 4.000 caracteres se envían recortados, y la tarjeta los muestra exactamente como se envían, con el recorte señalado; las entradas de plan que lista la tarjeta no forman parte del historial de Agent, de modo que Agent puede enviar menos de lo que muestra la tarjeta, nunca más. No utilices datos personales, confidenciales ni sensibles reales con Meta durante la validación del candidato.

## Privacy by Design — Privacidad desde el diseño

RAME Code se diseña alrededor de una **autonomía gobernada con controles de privacidad**, en vez de tratar cada elemento recordado como permiso para divulgarlo o actuar sobre él. Es una orientación técnica del diseño, no una afirmación de que RAME Code o una implantación concreta cumplan el RGPD.

Entre los mecanismos confirmados en el candidato v0.2.0 están:

- inferencia local de texto mediante un servidor limitado a loopback, sin enviar esa petición a un proveedor cloud;
- separación entre memoria del proyecto, recuperación de conversación, permisos de herramientas y evidencias del host;
- decisiones del proyecto versionadas y aprobadas por el usuario, donde una conversación antigua no prevalece sobre la versión autorizada vigente;
- revisión local→Meta que lista todos los mensajes locales que lleva una petición (nuevos y aprobados antes) dentro de un único límite, con opciones de incluir, retener, cancelar y dejar de compartir;
- respuestas ligadas a la clase de tratamiento de Meta (estándar, Contributor o un modelo no documentado) y a la revisión de la clave de API, con la tarjeta pendiente anulada si cambia cualquiera de ellas;
- una comprobación final de cada petición construida para Meta, que detiene contenido local no divulgado y sustituye las rutas locales del proyecto y de la carpeta personal;
- consentimiento por sesión para los resultados de herramientas de Agent hacia Meta, con censura basada en patrones de los valores con aspecto de secreto;
- registros de divulgación ligados al contenido mediante SHA-256 como referencia de integridad (no es cifrado ni prueba que el dispositivo subyacente no esté comprometido);
- registros acotados de recuperación que conservan referencias y hashes en vez de duplicar los extractos recuperados;
- extractos históricos etiquetados como contexto no fiable, nunca como instrucciones o permisos vigentes; y
- autorizaciones y límites separados para Advisory de Mission y ejecución Delegated de Agent.

Limitaciones que siguen existiendo: las dos validaciones reales con Meta cubren solo Chat; la matriz completa de divulgación y fallos sigue verificada contra el grabador simulado. La censura de secretos y la sustitución de rutas se basan en patrones y no pueden excluir todo valor sensible; una vez permitidos los resultados de herramientas de Agent para una sesión, su contenido futuro (ya censurado) no puede previsualizarse antes de la ejecución; y las clases de tratamiento dependen de los ids de modelo documentados que figuran en el código. No utilices datos personales, confidenciales ni sensibles reales con Meta durante la validación del candidato.

### Relación con principios del RGPD

La tabla describe cómo mecanismos técnicos verificados pueden ayudar al trabajo de cumplimiento de quien implanta RAME. No establece una base jurídica, valida una transferencia ni satisface por sí sola un artículo.

| Área del RGPD | Relación técnica en RAME Code | Todavía necesario fuera de RAME |
| --- | --- | --- |
| Artículo 5 — transparencia, minimización, integridad/confidencialidad y responsabilidad proactiva | Existe ejecución local; la tarjeta de divulgación previsualiza todos los mensajes locales de cada petición a Meta dentro de un único límite, las opciones de transferencia y la procedencia acotada hacen más visible parte del tratamiento, y memoria y autoridad están separadas. Verificado solo con un proveedor simulado. | Definir finalidades, categorías de datos, conservación y supresión, destinatarios, controles de acceso y medidas organizativas demostrables. |
| Artículo 6 — licitud | RAME registra una elección técnica del usuario sobre la divulgación. | El responsable debe identificar y documentar la base jurídica aplicable. Un botón de RAME no constituye necesariamente consentimiento RGPD ni sustituye los avisos o derechos de los interesados. |
| Artículo 25 — protección de datos desde el diseño y por defecto | La arquitectura separa procesamiento local, memoria persistente, permisos, transferencia externa y evidencias, liga la divulgación al destinatario, la clase de tratamiento y la credencial, y falla de forma cerrada ante un estado de divulgación dañado. | Evaluar el tratamiento, los riesgos, la configuración por defecto y su eficacia durante todo el ciclo de vida, incluida la validación con el proveedor real. |
| Artículo 32 — seguridad del tratamiento | SecretStorage, entradas acotadas, controles de política, aprobaciones de un solo uso y hashes de integridad pueden contribuir a controles de confidencialidad e integridad. | Elegir medidas técnicas y organizativas adecuadas al riesgo, probarlas periódicamente, gestionar incidentes y proteger host, red y proveedores. Las referencias SHA-256 no son cifrado. |
| Capítulo V del RGPD — transferencias internacionales | RAME puede identificar cuándo Meta es el destinatario remoto y restringir técnicamente parte del contexto local. | Determinar si existe una transferencia restringida y establecer la decisión de adecuación, garantías o excepción legal aplicable. RAME no proporciona automáticamente ese mecanismo jurídico. |

Referencias oficiales: el [texto del RGPD en EUR-Lex](https://eur-lex.europa.eu/eli/reg/2016/679/), las [Directrices 4/2019 sobre el artículo 25](https://www.edpb.europa.eu/our-work-tools/our-documents/guidelines/guidelines-42019-article-25-data-protection-design_en) del EDPB y el resumen de la Comisión Europea sobre las [reglas de transferencias internacionales](https://commission.europa.eu/law/law-topic/data-protection/international-dimension-data-protection/rules-international-data-transfers_en).

Una implantación operativa puede requerir además avisos de privacidad, gestión de solicitudes de derechos, políticas de conservación y supresión, acuerdos con encargados, registros de actividades, evaluación de transferencias internacionales, garantías contractuales y organizativas y, cuando corresponda, una evaluación de impacto. Los mantenedores y responsables de la implantación deberían obtener asesoramiento jurídico adecuado a su caso.

## Controles de generación

RAME Code mantiene separados el contexto, el razonamiento, el presupuesto de salida y el límite de 12 pasos del Agent.

- Los controles de razonamiento de Glimmer solo aparecen cuando `/props` confirma que la plantilla los admite.
- Las opciones de Meta dependen del modelo seleccionado.
- El presupuesto automático de Meta escala entre 8.192 y 131.072 tokens según el razonamiento.
- Las respuestas cortadas se descartan: nunca se ejecuta parcialmente una herramienta ni se registra como éxito.
- La entrada no se recorta silenciosamente para hacerla caber en el contexto.

En inferencia local, la respuesta `/props` del servidor loopback en ejecución es la autoridad. La configuración probada de Muse Glimmer usa un contexto de 32.768 tokens por petición y un presupuesto automático de salida de 4.096 tokens. Los Ajustes aceptan contextos configurados mayores, pero el modelo, la compilación del servidor y la memoria disponible determinan lo que realmente puede usarse; RAME consulta `/props`, reserva espacio para la respuesta y rechaza claramente una petición completa que no quepa.

Para los identificadores conocidos de modelos Meta incluidos en el perfil de este candidato, RAME usa actualmente un contexto de 1.048.576 tokens. El [catálogo actual de modelos de Meta](https://dev.meta.ai/docs/models) documenta ese contexto para Muse Spark 1.1, 1.2 y 1.3 y para Muse Wonder. RAME actualiza desde `/models` los identificadores disponibles, pero no deduce dinámicamente el contexto de esa respuesta: el [esquema estándar de Model](https://dev.meta.ai/docs/api-reference/models/schemas) no publica ese campo. Por ello hay que volver a comprobar el perfil explícito cuando Meta cambie el catálogo. Ese contexto grande pertenece a cada petición, no es memoria persistente, y siguen aplicándose los límites de historial anteriores. A un identificador de modelo desconocido no se le asigna un contexto supuesto.

## Compilar desde el código fuente

Requisitos:

- Node.js 22 o posterior;
- VS Code 1.95 o posterior.

```bash
git clone https://github.com/caimari/rame-code.git
cd rame-code
npm ci
npm test
npm run package
```

Pulsa `F5` en VS Code para abrir un Extension Development Host.

## Procedencia del desarrollo

- La implementación pública comenzó el **31 de octubre de 2026**.
- Concurso: **Meta Global AI Developer Hackathon 2026**.
- Categoría: **Indie Developer**.
- Arquitecto humano, responsable de producto, mantenedor y decisor de las releases: **Antoni Caimari Caldés**.

La implementación pública y su historial Git comienzan de forma independiente en este repositorio. No se incluye ni se necesita código, servicios, datasets o resultados privados anteriores. Los hitos se registran en [HACKATHON_WORK.md](HACKATHON_WORK.md). Las notas privadas de trabajo se excluyen deliberadamente de Git y de los paquetes publicados.

**RAME Code fue concebido y dirigido por Antoni Caimari Caldés, su arquitecto humano y responsable de producto, con desarrollo asistido por Muse Code, Muse Glimmer, OpenAI Codex y Claude Code.**

La implementación comenzó con **Muse Code** y `muse-spark-1.3` mediante Meta Model API, bajo la dirección y revisión de Antoni. El diario del proyecto registra 150,00 USD de créditos gratuitos iniciales y 122,96 USD restantes tras las primeras ventanas intensivas de implementación: 27,04 USD consumidos (aproximadamente el 18 % del importe inicial). Son cifras acumuladas del panel, no un coste por funcionalidad, y Meta Billing/Usage sigue siendo la referencia. Cambiar la combinación de herramientas fue una decisión de asignación de presupuesto —no una conclusión de que Muse no pudiera realizar el trabajo— para reservar los créditos restantes a inferencia, validación y demostraciones de RAME con modelos Meta.

La construcción y revisión posteriores combinaron el acceso existente a **OpenAI Codex** y **Claude Code**, **Muse Glimmer** local y la arquitectura, los prompts, las autorizaciones y las pruebas continuadas de Antoni. Codex y Claude Code actuaron como asistentes de desarrollo y auditoría, no como arquitectos del proyecto. Git registra a Antoni como integrador humano; las evidencias disponibles no permiten atribuir con exactitud cada línea o un porcentaje de todos los cambios mixtos. El trabajo autónomo de Glimmer en ensayos desechables se documenta por separado del código realmente integrado en una release pública. Los modelos utilizados en la demostración final solo se identificarán después de verificar esa ejecución.

## Hoja de ruta

Las prioridades inmediatas son completar la auditoría independiente y la validación humana del candidato 0.2, demostrar una instalación limpia mediante VSIX, terminar las comprobaciones en Windows real y con Meta API expresamente autorizada, y publicar una preview reproducible. Las releases posteriores incorporarán entrada de imágenes para Glimmer, refinarán la interfaz y el logotipo provisionales, prepararán la distribución en Visual Studio Marketplace, ampliarán los adaptadores de proyectos verificables y continuarán la investigación sobre relevos entre modelos gobernados por verificadores.

## Licencia

Publicado bajo la [Apache License 2.0](LICENSE).

Copyright 2026 Antoni Caimari Caldés.
