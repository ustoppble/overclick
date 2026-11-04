import { describe, expect, it } from "vitest";
import { CONNECT_STEP, onboardingSteps, onboardingStepFromParam } from "./steps";

/**
 * The wizard lost its "Who runs the cards?" step (E2): the Overclock app
 * decides what runs. The admin keeps two steps and a member keeps one, and a
 * `?step=N` link written for the three-step wizard still lands somewhere real.
 */
describe("the onboarding steps", () => {
  it("gives the admin two steps, project then connect, and the member one", () => {
    expect(onboardingSteps(false)).toEqual(["project", "agent"]);
    expect(onboardingSteps(true)).toEqual(["agent"]);
    expect(CONNECT_STEP).toBe(2);
  });

  it("remaps the old ?step=2 and ?step=3 onto connect", () => {
    expect(onboardingStepFromParam("2")).toBe(CONNECT_STEP);
    expect(onboardingStepFromParam("3")).toBe(CONNECT_STEP);
    expect(onboardingStepFromParam(["3", "1"])).toBe(CONNECT_STEP);
  });

  it("starts at the project for no step, step 1 or anything it cannot read", () => {
    expect(onboardingStepFromParam(undefined)).toBe(1);
    expect(onboardingStepFromParam("1")).toBe(1);
    expect(onboardingStepFromParam("0")).toBe(1);
    expect(onboardingStepFromParam("9")).toBe(1);
    expect(onboardingStepFromParam("abc")).toBe(1);
  });
});
