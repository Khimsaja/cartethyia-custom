import { describe, expect, test } from "bun:test";
import { createModelAbuseRoutes } from "../../../src/console/domains/model-abuse/contracts";
import {
  InMemoryModelAbuseStore,
  ModelStrikeService,
} from "../../../src/security/model-abuse";
import type { AccessDecision } from "../../../src/security/access-control";

const admin: AccessDecision = {
  id: "u1",
  tenantId: "t1",
  scopes: ["platform:admin", "dashboard:read"],
  admissionIdentity: "u1",
};

const nonAdmin: AccessDecision = { ...admin, scopes: ["dashboard:read"] };

function makeRoutes() {
  const store = new InMemoryModelAbuseStore(() => Date.now());
  const service = new ModelStrikeService(store, { threshold: 1 });
  const app = createModelAbuseRoutes({ strikes: service, accessResolver: () => admin });
  return { app, service };
}

describe("model-bans console routes", () => {
  test("lists active bans", async () => {
    const { app, service } = makeRoutes();
    await service.noteInvalid({ ip: "1.2.3.4" });
    const response = await app.handle(new Request("http://console.test/model-bans"));
    expect(response.status).toBe(200);
    const body = (await response.json()) as { bans: readonly { ip: string }[] };
    expect(body.bans.map((ban) => ban.ip)).toEqual(["1.2.3.4"]);
  });

  test("lifts a ban and 404s on an unknown one", async () => {
    const { app, service } = makeRoutes();
    await service.noteInvalid({ ip: "1.2.3.4" });
    const remove = (identity: string) =>
      app.handle(
        new Request("http://console.test/model-bans", {
          method: "DELETE",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ identity }),
        }),
      );
    const removed = await remove("1.2.3.4");
    expect(removed.status).toBe(200);
    expect(await service.check({ ip: "1.2.3.4" })).toBe(false);
    const again = await remove("1.2.3.4");
    expect(again.status).toBe(404);
  });

  test("rejects a non-admin caller", async () => {
    const store = new InMemoryModelAbuseStore(() => Date.now());
    const service = new ModelStrikeService(store, { threshold: 1 });
    const app = createModelAbuseRoutes({ strikes: service, accessResolver: () => nonAdmin });
    const response = await app.handle(new Request("http://console.test/model-bans"));
    expect(response.status).toBe(403);
  });
});
