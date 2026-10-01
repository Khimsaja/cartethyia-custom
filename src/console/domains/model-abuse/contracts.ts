// Console surface for model-abuse bans: list active bans and lift one.
//
// The strike layer (security/model-abuse.ts) bans an IP or API key after
// repeated invalid-model requests, and a ban is permanent until an operator
// removes it. This is the only escape hatch — a false positive (a shared NAT, a
// client that genuinely mistyped three times) must be fixable without SQL. It is
// a platform-admin surface: a ban is a security decision and the identity values
// are cross-tenant.
import { Elysia, t } from "elysia";
import type { AccessDecision } from "../../../security/access-control";
import type { ModelAbuseBan, ModelAbuseScope, ModelStrikeService } from "../../../security/model-abuse";
import { ConsoleDomainError, errorResponse, requireGlobalAdmin } from "../../shared/errors";

export interface ModelAbuseRoutesConfig {
  readonly strikes: Pick<ModelStrikeService, "listBans" | "unban">;
  readonly accessResolver: (request: Request) => AccessDecision | undefined;
}

const unbanBody = t.Object({
  scope: t.Union([t.Literal("ip"), t.Literal("api_key")]),
  identity: t.String({ minLength: 1 }),
});

/** Only the two known scopes are accepted; anything else is a caller error. */
function parseScope(value: string): ModelAbuseScope {
  if (value === "ip" || value === "api_key") return value;
  throw new ConsoleDomainError("invalid_request", 422, `unknown ban scope: ${value}`);
}

export function createModelAbuseRoutes(config: ModelAbuseRoutesConfig): Elysia {
  return new Elysia()
    .get("/model-bans", async ({ request, set }) => {
      try {
        requireGlobalAdmin(config.accessResolver(request));
        const bans: readonly ModelAbuseBan[] = await config.strikes.listBans();
        return { bans };
      } catch (e) {
        return errorResponse(e, set, "Model ban read failed");
      }
    })
    .delete("/model-bans", { body: unbanBody }, async ({ request, body, set }) => {
      try {
        requireGlobalAdmin(config.accessResolver(request));
        const scope = parseScope(body.scope);
        const removed = await config.strikes.unban(scope, body.identity);
        if (!removed)
          throw new ConsoleDomainError("ban_not_found", 404, "No such ban");
        return { success: true };
      } catch (e) {
        return errorResponse(e, set, "Model unban failed");
      }
    }) as unknown as Elysia;
}
