import { test } from "node:test";
import assert from "node:assert/strict";
import config from "../../next.config.ts";

test("security headers: the microphone is allowed for this site (voice booking) while camera, location and payment stay off", async () => {
  const rules = await config.headers!();
  const headers = rules.flatMap((r) => r.headers);
  const policy = headers.find((h) => h.key === "Permissions-Policy")?.value ?? "";
  assert.match(policy, /microphone=\(self\)/);
  assert.match(policy, /camera=\(\)/);
  assert.match(policy, /geolocation=\(\)/);
  assert.match(policy, /payment=\(\)/);
  assert.ok(headers.some((h) => h.key === "X-Frame-Options" && h.value === "DENY"));
});
