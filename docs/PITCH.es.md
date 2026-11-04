# RAME Code — presentación del producto

## La historia en una frase

**RAME Code es un agente de programación local-first integrado directamente en Visual Studio Code, con memoria gobernada por el usuario y Missions autónomas cuyos resultados autorizados comprueba el host.**

RAME significa **Relational Adaptive Memory Engine**. El nombre refleja investigaciones anteriores sobre estado persistente y memoria relacional; RAME Code es un proyecto nuevo, independiente y de código abierto, construido durante el Meta Global AI Developer Hackathon 2026.

## La promesa

> **La IA debería recordar lo que importa, respetar lo que decides y demostrar lo que realmente ha conseguido.**

Muchos agentes de programación mezclan conversación, memoria, permisos y finalización en un único flujo controlado por el modelo. RAME los separa:

- el modelo propone;
- el usuario autoriza herramientas, divulgación y decisiones duraderas; y
- el host registra las acciones y ejecuta las comprobaciones autorizadas que deciden si una Mission verificada ha terminado.

## Por qué es útil

Los desarrolladores no deberían tener que elegir entre privacidad local y asistencia cloud útil. RAME puede ejecutar Meta Muse Glimmer localmente mediante su `llama-server` gestionado o conectarse a modelos compatibles servidos por Ollama y LM Studio, incluidos servidores de una red privada autorizados explícitamente. Cuando el usuario selecciona Meta Model API, los modelos cloud compatibles pueden atender directamente Chat y Agent.

Para trabajos más largos, Mission puede continuar durante varias ejecuciones acotadas, conservar decisiones autorizadas del proyecto y exigir evidencia observada por el host antes de finalizar. El asesoramiento opcional de Spark, limitado por presupuesto, puede ayudar a una Mission local elegible sin recibir el control de sus herramientas.

## Cuatro pilares del producto

### Local-first, no exclusivamente local

Utiliza un `llama-server` gestionado, un servidor Ollama o LM Studio existente o inferencia cloud de Meta expresamente autorizada. Los pesos y runtimes los suministra el usuario.

### Memoria gobernada por el usuario

Solo las decisiones aprobadas se convierten en memoria persistente del proyecto. Conservan versiones y procedencia; cambiar una decisión puede marcar el trabajo verificado dependiente como **STALE**, en lugar de presentar silenciosamente evidencia antigua como vigente.

### Autonomía con límites

Agent permite trabajar interactivamente. Mission aborda objetivos más largos con puntos de control, permisos explícitos, recuperación tras interrupciones y condiciones acotadas de parada.

### Evidencias en lugar de confianza en el modelo

RAME distingue entre lo que afirmó un modelo y lo que el host permitió, ejecutó y comprobó. Una Mission verificada no termina simplemente porque el modelo diga «hecho».

## Presentación oral de treinta segundos

> RAME Code es un agente de programación local-first integrado directamente en VS Code. Ejecuta Meta Muse Glimmer localmente, puede conectarse a Ollama o LM Studio y utiliza Meta Model API cuando el usuario autoriza el procesamiento cloud. Lo que diferencia a RAME es su modelo de control: solo las decisiones que apruebas se convierten en memoria persistente, las herramientas permanecen tras permisos acotados y las Missions verificadas solo terminan cuando el host ejecuta las comprobaciones autorizadas. La IA propone; tú autorizas; RAME verifica.

## Historia recomendada para el vídeo de tres minutos

1. **Identidad — 15 segundos.** Muestra el candidato `0.2.0` instalado y presenta la historia en una frase.
2. **Modelo local — 25 segundos.** Muestra una respuesta de Glimmer y abre Model evidence para acreditar una respuesta local observada, no solo un modelo seleccionado.
3. **Memoria gobernada — 35 segundos.** Aprueba una decisión duradera, muéstrala en otro hilo, cámbiala y enseña cómo la evidencia dependiente queda **STALE**.
4. **Mission verificada — 75 segundos.** Inicia una Mission pequeña en un proyecto desechable, muestra su permiso acotado y aceptación congelada y termina con la comprobación del host y su evidencia.
5. **Cloud autorizado — 20 segundos.** Muestra la revisión de divulgación a Meta y la evidencia del Chat real con Spark. Indica claramente que todavía falta validar Mission Advisory contra el proveedor real.
6. **Cierre — 10 segundos.** «La IA propone. Tú autorizas. RAME verifica». Muestra GitHub y [ramecode.com](https://ramecode.com/).

## Afirmaciones que deben permanecer acotadas

- Dos inferencias directas de Chat puro con `muse-spark-1.3` tienen validación humana registrada contra la API real. No validan resultados de herramientas de Agent cloud, Delegated ni Mission Advisory.
- Mission Advisory está implementado y probado con un grabador Meta simulado; todavía no tiene una ejecución registrada con el proveedor real.
- RAME prioriza la inferencia local y aplica presupuestos remotos; no se afirma un ahorro concreto sin mediciones comparativas.
- La compatibilidad con modelos Meta depende de sus capacidades anunciadas. RAME no afirma que todos los modelos admitan todos los modos.
- Los controles de privacidad ayudan a la transparencia y minimización, pero no establecen por sí solos cumplimiento del RGPD ni una base jurídica.
- Una comprobación del host solo demuestra los criterios de aceptación que cubre; RAME no es un sandbox del sistema operativo.

La fundamentación técnica permanece en [Para el jurado](JUDGES.es.md), el [índice de evidencias](../evidence/README.md) y la [guía de verificación](VERIFICATION.es.md).
