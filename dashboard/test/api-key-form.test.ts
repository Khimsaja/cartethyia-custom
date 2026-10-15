import { describe, expect, test } from "bun:test";
import {
  initialApiKeyScopes,
  resolveLinkedTemplateId,
  templateMirrorsModels,
  type ModelTemplateItem,
} from "../src/components/ApiKeyForm";
import { TENANT_KEY_SCOPES } from "../src/data/contracts";

describe("initialApiKeyScopes", () => {
  test("the default gateway key starts with every tenant scope, including routing and remote mappings", () => {
    expect(initialApiKeyScopes({ isDefault: true, scopes: ["routing:invoke"] })).toEqual([
      ...TENANT_KEY_SCOPES,
    ]);
  });

  test("ordinary keys preserve explicit scopes and new keys keep the limited routing defaults", () => {
    expect(initialApiKeyScopes({ scopes: ["dashboard:read"] })).toEqual(["dashboard:read"]);
    expect(initialApiKeyScopes(null)).toEqual(["routing:invoke", "search:invoke"]);
  });
});

const tpl = (id: string, models: string[]): ModelTemplateItem => ({ id, name: id, models });

describe("model template linking (Khimsaja)", () => {
  test("mirror requires whitelist and set-equal models", () => {
    expect(templateMirrorsModels(tpl("a", ["x", "y"]), "whitelist", ["y", "x"])).toBe(true);
    expect(templateMirrorsModels(tpl("a", ["x"]), "blacklist", ["x"])).toBe(false);
    expect(templateMirrorsModels(tpl("a", ["x"]), "whitelist", [])).toBe(false);
  });

  test("applied template wins, else first mirror, else detach (null)", () => {
    const templates = [tpl("first", ["m"]), tpl("applied", ["m"])];
    expect(resolveLinkedTemplateId(templates, "applied", "whitelist", ["m"])).toBe("applied");
    expect(resolveLinkedTemplateId(templates, "gone", "whitelist", ["m"])).toBe("first");
    expect(resolveLinkedTemplateId(templates, null, "whitelist", ["other"])).toBeNull();
    expect(resolveLinkedTemplateId(templates, null, "blacklist", ["m"])).toBeNull();
  });
});
