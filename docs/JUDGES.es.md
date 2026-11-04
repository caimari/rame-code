# RAME Code — para el jurado

RAME Code es un agente de programación local para VS Code, creado para el Meta Global AI Developer Hackathon 2026. Su afirmación central es deliberadamente estrecha: **los modelos pueden proponer trabajo, pero la memoria duradera, la autoridad de las herramientas y la finalización de una Mission siguen siendo decisiones separadas y controladas por el host.**

[Web oficial](https://ramecode.com/) · [Código](https://github.com/caimari/rame-code) · [Guía de usuario](USER_GUIDE.es.md) · [Guía de verificación](VERIFICATION.es.md) · [Índice de evidencias](../evidence/README.md) · [English](JUDGES.md)

## Afirmaciones y evidencias

| Afirmación | Evidencia concreta | Cómo reproducirla o inspeccionarla | Lo que no demuestra |
| --- | --- | --- | --- |
| RAME puede ejecutar Muse Glimmer local mediante un proceso `llama-server` gestionado por la extensión | El [registro de la Mission supervisada REAL](../evidence/real-mission-supervised/README.md) conserva el servidor loopback lanzado por RAME, la confirmación de `/props` y 37 inferencias locales registradas con respuesta | Lee las notas y verifica la extracción publicada con `cd evidence/real-mission-supervised && sha256sum -c SHA256SUMS` | Los pesos GGUF no se identificaron criptográficamente; es una ejecución histórica, no un benchmark ni una ejecución nueva |
| Una Mission local real modificó un proyecto desechable y el host solo la completó después de superar su aceptación congelada | [Hechos RECORDED saneados](../evidence/real-mission-supervised/run.RECORDED.json), el [proyecto resultante](../evidence/real-mission-supervised/project-after/) y sus sumas | Inspecciona el JSON RECORDED y el proyecto; verifica `SHA256SUMS`. La ejecución REAL histórica no puede repetirse a partir de este paquete saneado | Éxito general, autonomía sin aprobaciones, sandbox o prueba del commit actual |
| El candidato 0.2.0 tiene memoria gobernada: solo el usuario autoriza decisiones duraderas, conserva versiones y puede marcar obsoletos los archivos verificados vinculados | Código y pruebas automatizadas de memoria, procedencia e invalidación | Ejecuta `npm ci && npm run check` con Node.js 20 o 24 | Un almacén a prueba de manipulación, sincronización entre equipos, recuperación perfecta o exclusividad frente a otros proyectos |
| La aceptación de Mission la ejecuta el host y puede congelar dependencias, sellar carpetas y calcular la huella del proyecto | Código, pruebas y [batería de sabotaje SIMULATED](../evidence/sabotage/mission-sabotage.SIMULATED.json) | Ejecuta `npm run demo:sabotage` y compara el resultado SIMULATED y su resumen | Que una comprobación débil demuestre software correcto o que el código esté aislado del sistema operativo |
| Las aprobaciones de un solo uso quedan ligadas a la acción exacta y a sus precondiciones | Código y pruebas automatizadas de políticas | Ejecuta `npm run check` | Protección frente a un host de VS Code o sistema operativo ya comprometido |
| La divulgación local→Meta se revisa y liga a las condiciones del destinatario antes de enviarse | Código y pruebas con una API de Meta simulada | Ejecuta `npm run check` e inspecciona las pruebas de divulgación y proveedores | Validación contra la API real de Meta; todavía no deben usarse datos sensibles en esa vía |
| Un verificador fallido abre un bloqueo identificado y el control local normal solo vuelve cuando el host repite con éxito ese verificador | Código y pruebas automatizadas de verificación causal | Ejecuta `npm run check` e inspecciona los casos de verificación causal | Una ejecución real completa Glimmer→Spark→Glimmer; la nube está simulada en este candidato |

## Reproducir sin modelo ni clave

Requisitos: Node.js 20 o 24 y npm.

```bash
npm ci
npm run check
npm run demo:sabotage
```

`npm run check` compila la extensión y ejecuta las pruebas. `npm run demo:sabotage` regenera el resultado SIMULATED saneado. No necesitan GPU, pesos ni clave de Meta. GitHub Actions ejecuta las mismas comprobaciones principales con Node 20 y 24.

## Etiquetas

- **REAL** — un modelo real respondió durante la ejecución registrada.
- **SIMULATED** — respuestas guionizadas o una API de Meta simulada ejercitaron la lógica real del host.
- **RECORDED** — extracción saneada o reproducción de evidencia guardada; no es otra ejecución del modelo.

El paquete público es una **extracción RECORDED de una ejecución REAL**. Se verificaron las sumas del archivo fuente antes de extraerlo, pero se ejecutó con el build histórico `eb89d04-dirty.src.568a25d1d810`. Solo respalda los hechos indicados y no certifica el commit actual.

## Límites actuales

- No hay sandbox del sistema operativo; los scripts permitidos usan los permisos del usuario de VS Code.
- La Mission real es `n=1` y usa un proyecto desechable deliberadamente pequeño.
- Fue supervisada y no utilizó Meta Model API.
- El resumen del host dice 36 inferencias locales respondidas y la vista final contiene 37; se conservan ambas cifras.
- En Windows se compara el estado inicial y final; no se afirma detectar cambios temporales deshechos.
- Una comprobación puede ser débil. El ejecutor reforzado reduce algunos ataques, pero no vuelve secretos los valores esperados.
- La privacidad hacia Meta y las vías Advisory/Delegated se prueban con API simulada, no con el servicio real.
- Es un candidato preview 0.2.0, no una frontera de seguridad para producción.

El vídeo no se enlazará hasta que existan su grabación definitiva y sus notas de evidencia.
