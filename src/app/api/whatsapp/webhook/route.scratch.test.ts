import { describe, it, expect } from "vitest";
import * as route from "./route";

describe("route import smoke test", () => {
  it("imports without crashing", () => {
    expect(typeof route.POST).toBe("function");
  });
});
