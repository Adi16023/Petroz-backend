import assert from "node:assert/strict";
import { test } from "node:test";
import jwt from "jsonwebtoken";
import { signToken, requireAuth } from "./auth.mjs";

test("all login roles expire after exactly 12 hours, including legacy seven-day tokens", async () => {
  const previous = process.env.JWT_SECRET;
  process.env.JWT_SECRET = "test-only-session-signing-secret";
  try {
    for (const role of ["super_admin", "owner", "manager", "staff", "credit_customer", "auditor", "accounts_auditor", "attendance"]) {
      const token = signToken({ id: "user", settings_id: "dealer", role });
      const payload = jwt.decode(token);
      assert.equal(payload.exp - payload.iat, 43200);
      const now = Math.floor(Date.now() / 1000);
      for (const age of [43100, 43200, 43201]) {
        const legacy = jwt.sign({ sub: "user", iat: now - age }, process.env.JWT_SECRET, { expiresIn: "7d" });
        let allowed = false;
        const response = { statusCode: 200, status(code) { this.statusCode = code; return this; }, json(value) { this.body = value; } };
        await requireAuth({ query: async () => ({ rows: [{ id: "user", role }] }) })(
          { headers: { authorization: `Bearer ${legacy}` } }, response, () => { allowed = true; },
        );
        assert.equal(allowed, age < 43200);
        if (!allowed) assert.equal(response.statusCode, 401);
      }
    }
  } finally {
    if (previous === undefined) delete process.env.JWT_SECRET;
    else process.env.JWT_SECRET = previous;
  }
});
