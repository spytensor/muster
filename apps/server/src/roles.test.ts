import { describe, expect, it } from "vitest";
import { can, canGrant, canManage, permissionsOf, ROLES } from "./roles.js";

describe("roles", () => {
  it("lets owners manage everyone and grant every role", () => {
    for (const role of ROLES) {
      expect(canManage("owner", role)).toBe(true);
      expect(canGrant("owner", role)).toBe(true);
    }
  });

  it("keeps owners and administrators out of an administrator's reach", () => {
    expect(canManage("admin", "owner")).toBe(false);
    expect(canManage("admin", "admin")).toBe(false);
    expect(canGrant("admin", "owner")).toBe(false);
    expect(canGrant("admin", "admin")).toBe(false);
    for (const role of ["auditor", "billing", "member"] as const) {
      expect(canManage("admin", role)).toBe(true);
      expect(canGrant("admin", role)).toBe(true);
    }
  });

  it("gives nobody else any power over others", () => {
    for (const actor of ["auditor", "billing", "member"] as const) {
      for (const role of ROLES) expect(canManage(actor, role)).toBe(false);
    }
  });

  it("makes the auditor read-only", () => {
    expect(can("auditor", "members.read")).toBe(true);
    expect(can("auditor", "audit.read")).toBe(true);
    expect(can("auditor", "sessions.read")).toBe(true);
    expect(
      permissionsOf("auditor").filter((p) => p.endsWith(".manage") || p.endsWith(".revoke")),
    ).toEqual([]);
  });

  it("gives ordinary members no console access", () => {
    expect(permissionsOf("member")).toEqual([]);
    expect(permissionsOf("billing")).toEqual(["console.access"]);
  });
});
