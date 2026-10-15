/**
 * Factory `x-api-provider` selector.
 *
 * The header's purpose is documented (research rank #8: a provider selector so
 * traffic does not all take Factory's default routing) but the accepted value
 * vocabulary is NOT. So this pins the plumbing — read from provider_options,
 * pass through verbatim — and the safety property that a caller cannot inject
 * a header through it.
 */
import { describe, expect, test } from "bun:test";
import { factoryApiProviderHeader } from "../../src/providers/integrations/factory/factory";

describe("factoryApiProviderHeader", () => {
  test("emits x-api-provider when the caller names one", () => {
    expect(factoryApiProviderHeader({ factory_api_provider: "bedrock" })).toEqual({
      "x-api-provider": "bedrock",
    });
  });

  test("emits nothing when the caller names none", () => {
    expect(factoryApiProviderHeader({})).toEqual({});
    expect(factoryApiProviderHeader(undefined)).toEqual({});
  });

  test("emits nothing for a non-string value", () => {
    expect(factoryApiProviderHeader({ factory_api_provider: 42 })).toEqual({});
    expect(factoryApiProviderHeader({ factory_api_provider: null })).toEqual({});
  });

  test("emits nothing for an empty string", () => {
    expect(factoryApiProviderHeader({ factory_api_provider: "" })).toEqual({});
  });

  test("refuses a value that would inject a header", () => {
    // The one thing a downstream filter cannot undo: a caller-supplied CRLF
    // turning one header into two.
    expect(
      factoryApiProviderHeader({ factory_api_provider: "x\r\nx-evil: 1" }),
    ).toEqual({});
    expect(
      factoryApiProviderHeader({ factory_api_provider: "x\nx-evil: 1" }),
    ).toEqual({});
    expect(factoryApiProviderHeader({ factory_api_provider: "x\0y" })).toEqual({});
  });

  test("passes the value through verbatim (no pinning of the vocabulary)", () => {
    // Deliberate: the accepted values are unconfirmed, so this layer must not
    // claim to know them. Any token travels; validation is upstream's.
    expect(
      factoryApiProviderHeader({ factory_api_provider: "some-unknown-value" }),
    ).toEqual({ "x-api-provider": "some-unknown-value" });
  });
});
