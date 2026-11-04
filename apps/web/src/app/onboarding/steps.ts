/**
 * The wizard's steps. The admin names the project, then connects an agent;
 * a member only connects (OCL-222). "Who runs the cards?" left with E2: the
 * Overclock app decides what runs, the board records it.
 */
export type OnboardingStepId = "project" | "agent";

/** The step that connects an agent, and the member's only one. */
export const CONNECT_STEP = 2;

export function onboardingSteps(installOnly: boolean): OnboardingStepId[] {
  return installOnly ? ["agent"] : ["project", "agent"];
}

/**
 * Where `?step=N` lands. The three-step wizard put connecting at 3, so both
 * 2 and 3 open it now; anything else starts at the project.
 */
export function onboardingStepFromParam(
  raw: string | string[] | undefined,
): number {
  const step = Number(Array.isArray(raw) ? raw[0] : raw);
  return step === 2 || step === 3 ? CONNECT_STEP : 1;
}
