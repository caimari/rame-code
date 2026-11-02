# RAME Code

**Un agente de programación local-first para VS Code nacido en el Meta Global AI Developer Hackathon, basado en modelos Meta Muse y diseñado con permisos explícitos y evidencias verificadas por el host.**

[English README](README.md) · [Changelog](CHANGELOG.md) · [Licencia](LICENSE)

RAME Code es un proyecto independiente de código abierto iniciado desde cero durante el [Meta Global AI Developer Hackathon 2026](https://cerebralvalley.ai/e/meta-ai-developer-hackathon/details). Funciona como extensión de VS Code y admite tanto Muse Glimmer local como modelos en la nube mediante Meta Model API.

La versión `0.1.0` es la primera preview pública. Es apropiada para evaluarla sobre proyectos desechables. Todavía no constituye una frontera de seguridad para producción.

## Sigue la construcción

Este repositorio también es un diario público para quienes quieran aprender cómo se crea un agente de programación desde cero. La primera implementación se puso en marcha dirigiendo **Muse Code CLI** mediante prompts explícitos y verificando después el código con pruebas automatizadas y evidencias generadas por el host.

Descarga la última [release](https://github.com/caimari/rame-code/releases), instala el VSIX y pruébalo sobre un proyecto desechable. A medida que avancemos publicaremos nuevas versiones verificadas, de modo que cualquiera pueda seguir y probar la evolución del agente en lugar de ver únicamente una demostración final.

El siguiente gran hito es deliberadamente recursivo: RAME Code debe utilizar su propio modo Agent y los modelos Meta Muse para inspeccionar, probar y mejorar el propio RAME Code. Cuando una release contenga una mejora verificada realizada desde RAME Code —y no únicamente desde el arranque original con Muse Code CLI— quedará indicado expresamente en el changelog y en sus evidencias.

## Qué funciona en v0.1.0

- Modos **Agent, Mission y Chat** en una única vista de VS Code.
- **Muse Glimmer local** mediante un endpoint OpenAI-compatible de `llama-server`, limitado a loopback.
- **Muse Spark y Muse Wonder mediante Meta Model API**, usando una clave proporcionada por el usuario y guardada en VS Code SecretStorage.
- Bucle acotado de herramientas para inspeccionar el workspace, operar con archivos, aplicar parches, cambiar permisos de ejecución y lanzar pruebas permitidas.
- Tres perfiles de permisos: Ask, Safe auto y Workspace full.
- Autorizaciones de un solo uso ligadas mediante digest a la acción, hilo, proveedor, workspace y precondiciones exactas.
- Protección ante rutas absolutas, traversal, escapes mediante enlaces y determinadas rutas de secretos o control.
- Registro de acciones escrito por el host y separado del texto generado por el modelo.
- Hilos locales persistentes, cancelación, contabilidad de uso y consentimiento explícito antes de escalar del modelo local a la nube.
- Razonamiento y presupuestos de salida configurables y validados por proveedor y modelo.
- Tratamiento de rutas y procesos de Linux y Windows cubierto por la batería automatizada.

## Qué falta todavía

- Decisiones persistentes y versionadas del proyecto y detección de artefactos desactualizados.
- Reanudar una misión después de reiniciar completamente la extensión.
- Escalada automática local-nube y regreso verificado al modelo local.
- Sandbox del sistema operativo o control ilimitado del terminal y del ordenador.
- Garantías de que la ejecución local, las autorizaciones o la auditoría sean resistentes a cualquier manipulación.

El contenido del repositorio, las salidas de herramientas y las respuestas del modelo se consideran datos no confiables. El modelo no puede concederse autoridad adicional. Sin embargo, los scripts de prueba permitidos se ejecutan con los permisos del proceso de VS Code y podrían acceder por sí mismos a archivos, redes o shells.

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
3. Opcionalmente configura el proyector multimodal o el modelo borrador DFlash.
4. Pulsa **Save** y después **Start Muse Glimmer**.

El servidor administrado escucha únicamente en `127.0.0.1`. RAME Code solo detiene el proceso que él mismo inició. También puedes utilizar un endpoint OpenAI-compatible existente en loopback.

## Perfiles de permisos

| Perfil | Comportamiento |
| --- | --- |
| **Ask** | Cada herramienta espera autorización. Es el valor predeterminado. |
| **Safe auto** | Las lecturas validadas se ejecutan automáticamente; escrituras y pruebas requieren autorización. |
| **Workspace full** | Las acciones permitidas pueden ejecutarse sin preguntar. Las políticas continúan activas, pero es un modo de riesgo elevado. |

El agente queda ligado a una carpeta de workspace seleccionada explícitamente. RAME Code no ofrece un shell arbitrario. Las pruebas se limitan a comandos derivados de una allowlist y se ejecutan con `shell: false`, aunque el script del proyecto podría ejecutar código arbitrario.

## Controles de generación

RAME Code mantiene separados el contexto, el razonamiento, el presupuesto de salida y el límite de 12 pasos del Agent.

- Los controles de razonamiento de Glimmer solo aparecen cuando `/props` confirma que la plantilla los admite.
- Las opciones de Meta dependen del modelo seleccionado.
- El presupuesto automático de Meta escala entre 8.192 y 131.072 tokens según el razonamiento.
- Las respuestas cortadas se descartan: nunca se ejecuta parcialmente una herramienta ni se registra como éxito.
- La entrada no se recorta silenciosamente para hacerla caber en el contexto.

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
- Autor: **Antoni Caimari Caldés**.

La implementación pública y su historial Git comienzan de forma independiente en este repositorio. No se incluye ni se necesita código, servicios, datasets o resultados privados anteriores. Los hitos se registran en [HACKATHON_WORK.md](HACKATHON_WORK.md). Las notas privadas de trabajo se excluyen deliberadamente de Git y de los paquetes publicados.

## Hoja de ruta

El siguiente hito incorpora la diferencia principal de RAME Code frente a un agente genérico: decisiones de proyecto autorizadas y versionadas, cuyas dependencias puedan aparecer como desactualizadas cuando cambie una decisión y cuyo estado se recupere después de reiniciar.

## Licencia

Publicado bajo la [Apache License 2.0](LICENSE).

Copyright 2026 Antoni Caimari Caldés.
