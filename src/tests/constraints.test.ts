import { describe, expect, it } from "vitest";
import {
  bumpKind,
  ConstraintSyntaxError,
  compareVersions,
  EXACT_VERSION_RE,
  isExactPin,
  parseVersion,
  satisfies,
} from "../constraints.js";

describe("Terraform provider version constraints", () => {
  it.each([
    ["~> 1.2", "1.2.0", true],
    ["~> 1.2", "1.9.9", true],
    ["~> 1.2", "2.0.0", false],
    ["~> 1.2", "1.1.9", false],
    ["~> 1.2.3", "1.2.3", true],
    ["~> 1.2.3", "1.2.10", true],
    ["~> 1.2.3", "1.3.0", false],
    ["~> 1", "1.0.0", true],
    ["~> 1", "1.99.0", true],
    ["~> 1", "2.0.0", false],
    [">= 3.0, < 4.0", "3.4.0", true],
    [">= 3.0, < 4.0", "4.0.6", false],
    [">= 3.0", "4.0.6", true],
    ["!= 4.0.1", "4.0.1", false],
    ["!= 4.0.1", "4.0.2", true],
    ["4.0.6", "4.0.6", true],
    ["4.0.6", "4.0.7", false],
    ["= 4.0.6", "4.0.6", true],
    ["> 1.0", "1.0.0", false],
    ["> 1.0", "1.0.1", true],
    ["<= 2.3.1", "2.3.1", true],
    ["<= 2.3.1", "2.3.2", false],
    ["v1.2.0", "1.2.0", true],
    // A prerelease only matches an exact clause naming it.
    [">= 1.0", "2.0.0-beta1", false],
    ["~> 2.0", "2.0.0-beta1", false],
    ["2.0.0-beta1", "2.0.0-beta1", true],
    ["= 2.0.0-beta1", "2.0.0-beta2", false],
  ])("%s with %s -> %s", (c, v, want) => {
    expect(satisfies(v, c)).toBe(want);
  });

  it("rejects bad syntax", () => {
    expect(() => satisfies("1.0.0", ">= banana")).toThrow(ConstraintSyntaxError);
    expect(() => satisfies("1.0.0", ">= 1.0,")).toThrow(/empty clause/);
    expect(() => satisfies("nope", ">= 1.0")).toThrow(/invalid version/);
  });

  it("orders versions including prereleases", () => {
    const v = (s: string) => parseVersion(s)!;
    expect(compareVersions(v("1.2.3"), v("1.2.3"))).toBe(0);
    expect(compareVersions(v("1.2.3-alpha"), v("1.2.3"))).toBe(-1);
    expect(compareVersions(v("1.2.3-alpha.2"), v("1.2.3-alpha.10"))).toBe(-1);
    expect(compareVersions(v("1.2.3-alpha.1"), v("1.2.3-alpha.beta"))).toBe(-1);
    expect(compareVersions(v("1.2.3-beta"), v("1.2.3-alpha"))).toBe(1);
    expect(compareVersions(v("1.2.3-a"), v("1.2.3-a.1"))).toBe(-1);
    expect(compareVersions(v("10.0.0"), v("9.9.9"))).toBe(1);
    expect(parseVersion("1.2")).toEqual({ major: 1, minor: 2, patch: 0, pre: "" });
    expect(parseVersion("x")).toBeNull();
  });

  it("knows exact pins and exact versions", () => {
    expect(isExactPin("3.4.0")).toBe(true);
    expect(isExactPin("= 3.4.0")).toBe(true);
    expect(isExactPin("~> 3.4.0")).toBe(false);
    expect(isExactPin("3.4")).toBe(false);
    expect(isExactPin(">= 1, < 2")).toBe(false);
    expect(isExactPin("garbage!")).toBe(false);
    expect(EXACT_VERSION_RE.test("4.0.6")).toBe(true);
    expect(EXACT_VERSION_RE.test("4.0.6-rc1")).toBe(true);
    expect(EXACT_VERSION_RE.test("~> 4.0")).toBe(false);
    expect(EXACT_VERSION_RE.test("4.0")).toBe(false);
  });

  it("classifies the bump", () => {
    const v = (s: string) => parseVersion(s)!;
    expect(bumpKind(v("3.4.0"), v("4.0.6"))).toBe("major");
    expect(bumpKind(v("3.4.0"), v("3.5.0"))).toBe("minor");
    expect(bumpKind(v("3.4.0"), v("3.4.1"))).toBe("patch");
    expect(bumpKind(v("3.4.0-rc1"), v("3.4.0"))).toBe("prerelease");
  });
});
