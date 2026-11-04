/**
 * The instruction every Mission plan request starts with (local Glimmer or
 * Meta). Free of the `vscode` API.
 *
 * The host runs the project's tests to verify every step and writes the final
 * report itself, so a step whose only purpose is to run the tests or to write
 * a report adds an internal run and verifies nothing new (human validation:
 * "Run tests after authorization and report results" repeated the previous
 * step's tests).
 */
export const MISSION_SYSTEM_PROMPT =
  'Create a bounded software mission plan. Do not claim to have inspected files or run tools. ' +
  'The host runs the project tests to verify every step and writes the final report itself: never add a step whose only purpose is to run tests, verify, or report; ' +
  'each step must make a concrete change, with its success criterion. Return only the requested structured output.';
