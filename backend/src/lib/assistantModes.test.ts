import { describe, expect, it } from "vitest";
import { modeDirective, parseAssistantMode } from "./assistantModes";

describe("assistant modes", () => {
  it("defaults to chat and adds no directive", () => {
    expect(parseAssistantMode(undefined)).toEqual({ ok: true, value: "chat" });
    expect(modeDirective("chat")).toBe("");
    expect(modeDirective(undefined)).toBe("");
  });

  it("accepts every mode and gives non-chat modes a directive", () => {
    for (const mode of ["workflow", "playbook", "tabular", "library"] as const) {
      expect(parseAssistantMode(mode)).toEqual({ ok: true, value: mode });
      expect(modeDirective(mode)).toContain("SESSION MODE");
    }
  });

  it("rejects anything else", () => {
    expect(parseAssistantMode("admin").ok).toBe(false);
    expect(parseAssistantMode(3).ok).toBe(false);
  });
});
