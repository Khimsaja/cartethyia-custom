// Shared template-method lifecycle for HTTP-backed provider adapters:
// header/payload preparation, upstream transport, deadline lifecycle, and
// stream transformation. Concrete adapters override the four hooks.

import type { CanonicalEvent, CanonicalRequest } from "../../protocol/canonical-model";
import { GatewayError } from "../../protocol/gateway-error";
import {
  abortGatewayError,
  createUpstreamDeadlineLifecycle,
} from "../operations/upstream-deadline";
import type {
  ProviderAdapter,
  ProviderDispatchContext,
  ProviderDispatchTarget,
  ProviderId,
} from "../provider-contracts";

/** Shared template-method lifecycle for HTTP-backed provider adapters. */
export abstract class BaseProviderAdapter implements ProviderAdapter {
  abstract readonly provider_id: ProviderId;

  async *dispatch(
    request: CanonicalRequest,
    target: ProviderDispatchTarget,
    context: ProviderDispatchContext,
  ): AsyncIterable<CanonicalEvent> {
    if (request.model.includes("?")) {
      throw new GatewayError("invalid_request", 400, "model must not contain query string (request {requestId}). Check the shape of what you sent — then resend 🪞");
    }
    const headers = await this.prepareHeaders(context, request, target);
    let payload = await this.preparePayload(request, target, context);
    const lifecycle = createUpstreamDeadlineLifecycle(context);
    const transportContext: ProviderDispatchContext = { ...context, abort_signal: lifecycle.signal };
    // Release the translated payload and the request's large content once the
    // upstream has the bytes. The stream decoder only reads model/tools; the
    // prompt itself is never read again after the transport. This generator's
    // frame otherwise pins the full prompt for the life of the process when
    // it is retained past the request (heap leak, measured: prompt retained
    // ~1:1 per successful request, ~600 MB/min under prod traffic). Property
    // replacement, never array mutation: the next failover attempt builds a
    // fresh projected spread from the canonical request, so clearing this
    // attempt's copy cannot starve a retry.
    const releaseLargeInputs = (): void => {
      payload = undefined;
      request.messages = [];
      delete request.system;
      delete request.instructions;
    };
    // The upstream Response retains its Request body in Bun (measured: a
    // held Response pins the ~9.4 MB request body; releasing it + GC frees
    // it). Null the reference once the stream is consumed so a retained
    // generator frame cannot pin the body through the Response.
    let response: Response | undefined;
    try {
      response = await this.executeTransport(headers, payload, transportContext, request, target);
      // The HTTP headers establish the upstream stream. The original
      // pre-stream deadline must not kill a healthy long response body; the
      // outer request watchdog now owns inter-event stall detection.
      lifecycle.release();
      releaseLargeInputs();
      // Body reads must watch the *request* abort signal. transportContext
      // still carries the released lifecycle signal, which is no longer
      // bridged to state.abortController — stall/deadline aborts would
      // otherwise never cancel the upstream reader.
      yield* this.transformStream(response, request, target, {
        ...transportContext,
        abort_signal: context.abort_signal,
      });
    } catch (error) {
      const abortError = abortGatewayError(lifecycle, error, context.abort_signal);
      if (abortError) throw abortError;
      throw error;
    } finally {
      response = undefined;
      releaseLargeInputs();
      lifecycle.release();
    }
  }

  protected abstract prepareHeaders(
    context: ProviderDispatchContext,
    request: CanonicalRequest,
    target: ProviderDispatchTarget,
  ): Promise<Record<string, string>>;
  protected abstract preparePayload(
    request: CanonicalRequest,
    target: ProviderDispatchTarget,
    context: ProviderDispatchContext,
  ): Promise<unknown>;
  protected abstract executeTransport(
    headers: Record<string, string>,
    payload: unknown,
    context: ProviderDispatchContext,
    request?: CanonicalRequest,
    target?: ProviderDispatchTarget,
  ): Promise<Response>;
  protected abstract transformStream(
    response: Response,
    request: CanonicalRequest,
    target: ProviderDispatchTarget,
    context: ProviderDispatchContext,
  ): AsyncIterable<CanonicalEvent>;
}
