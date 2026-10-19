import { describe, expect, it } from "vitest";
import { toUser } from "../src/types";

describe("toUser", () => {
  it("round-trips metadata bag", () => {
    const u = toUser({
      user_id: "usr_1",
      user_name: "Ada",
      user_email: "a@b.test",
      identity_ids: ["acc_1"],
      system_role: "user",
      organization_role: "owner",
      workspace_role: "manager",
      metadata: { email_verified: true, sso_claims: { groups: ["eng"] } },
    });
    expect(u.metadata).toEqual({ email_verified: true, sso_claims: { groups: ["eng"] } });
  });

  it("leaves metadata undefined when wire payload has none", () => {
    const u = toUser({
      user_id: "usr_1",
      system_role: "user",
      organization_role: "member",
      workspace_role: "member",
    });
    expect(u?.metadata).toBeUndefined();
  });
});
