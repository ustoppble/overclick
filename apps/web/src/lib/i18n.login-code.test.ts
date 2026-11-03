import { describe, expect, it } from "vitest";
import { dict } from "./i18n";

describe("the words of sign-in by email code", () => {
  it("says in pt-BR that the code WILL be sent: the intro is on screen before anything is sent", () => {
    expect(dict("pt-BR").auth.codeIntro).toBe(
      "Vamos enviar um código de 6 dígitos para o seu e-mail.",
    );
  });

  it("says it in the future in en too", () => {
    expect(dict("en").auth.codeIntro).toBe("We will email you a 6-digit code.");
  });
});
