/**
 * Monotonic version of the persisted solver inputs (settings.json + data.json).
 * The stores bump it whenever a save actually changes content; computed plans
 * are stamped with the version they were built from so /calculate/last can
 * tell when a cached plan has been superseded by newer inputs.
 *
 * Lives in its own module to keep the stores free of a planner-service import
 * (planner-service imports the stores).
 */
let version = 0;

export function getSolverInputsVersion(): number {
  return version;
}

export function bumpSolverInputsVersion(): void {
  version += 1;
}
