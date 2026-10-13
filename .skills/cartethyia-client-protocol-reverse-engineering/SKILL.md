---
name: cartethyia-client-protocol-reverse-engineering
description: "Use when investigating an external desktop client or user-designated installer to reproduce its provider request flow, especially undocumented asynchronous media task polling."
---

# Reverse-engineer an external client protocol

Use this skill to map observable HTTP behavior from an authorized external
client or a specific installer artifact, then determine what Cartethyia can
reproduce. This is distinct from
[`cartethyia-reverse-engineering`](../cartethyia-reverse-engineering/SKILL.md),
which reconstructs behavior implemented by Cartethyia itself.

## When to use

- A provider request works in its desktop client but fails in Cartethyia.
- An asynchronous request returns a task ID, but the status/result route is
  undocumented or Cartethyia's polling request fails.
- The user asks to inspect a particular installer rather than the installed
  application.

## Procedure

1. **Pin the artifact and boundary.** Record the exact user-designated file,
   product/version, platform, and whether inspection must be limited to an
   installer. Check provenance/signature when available. Do not silently
   switch to an installed copy, another version, downloaded source, or a
   different provider.
2. **Keep inspection static.** Never launch an installer or extracted
   executable to discover its behavior. Use existing local tools to list and
   extract only the relevant package layers into a temporary work directory.
   Keep extracted material out of the repository and clean up only the
   explicitly created temporary files when finished.
3. **Find first-party code selectively.** For packaged Electron applications,
   identify the ASAR or equivalent archive, enumerate its file index, and
   extract likely first-party main-process, provider/API, and renderer bundles.
   Search endpoint fragments, task identifiers, media terms, request builders,
   and dispatch names. Avoid spending time on unrelated vendor bundles.
4. **Trace a complete request.** A string match is a lead, not proof. Follow
   the caller and any URL/config getters to the transport invocation. Record
   separately for submission and status/result retrieval:
   - HTTP method and fully resolved path;
   - query parameters and required headers;
   - request body and task-ID placement;
   - response envelope, pending/terminal states, and result URL extraction.
   Check whether the client calls the provider directly or delegates work to
   a generic chat/tool/task service.
5. **Grade evidence explicitly.** Mark each fact as:
   - **static-confirmed** — a reachable request-construction and call path in
     the exact inspected artifact;
   - **runtime-confirmed** — observed request/response from the authorized
     client or an authorized direct request;
   - **corroborated** — supported by version-matched official documentation or
     independent public client code;
   - **inferred** — plausible but not traced or observed;
   - **unknown** — not established.
   A URL string alone, a neighboring endpoint, another provider's API, a
   mocked test, or an HTTP 404 from a guessed path does not confirm the real
   route.
6. **Probe narrowly, only with authorization.** Prefer an existing task ID and
   a read-only status request; do not submit a new generation merely to obtain
   a task ID unless the user explicitly authorizes it. Use a disposable or
   rotatable credential through a protected input mechanism. Never put tokens,
   account exports, cookies, or unredacted payloads in source, command history,
   logs, or documentation. Bound retries and polling time. A 404 rules out only
   that exact method/path for that request; it does not identify the correct
   route.
7. **Stop when evidence runs out.** If the exact installer has no reachable
   request path, report which bundles/terms were inspected and the remaining
   unknowns. Do not fill the gap with a "natural sibling" URL and describe it
   as observed. Ask for an authorized request capture, a running-client trace,
   or other concrete evidence instead.
8. **Implement only verified compatibility.** Update every Cartethyia surface
   that performs the operation, such as the provider adapter and reusable CLI.
   Keep provider-specific behavior at the adapter boundary. Add fake-transport
   tests for the confirmed method/path, headers, payload, envelope, and
   terminal states; clearly label those tests as local contract tests, not
   provider verification. Run the narrow tests and relevant typechecks.
9. **Leave an evidence trail.** Document the artifact version, confirmed
   behavior, failed probes and their limited meaning, outstanding unknowns,
   and next evidence needed. Do not store credentials, user-specific local
   paths, or large extracted bundles in the repository.

## Reporting template

| Operation | Method/path | Evidence | Status |
| --- | --- | --- | --- |
| Submit | … | static/runtime/corroborated/inferred | confirmed/unknown |
| Poll/result | … | static/runtime/corroborated/inferred | confirmed/unknown |

Finish with the exact artifact inspected, relevant first-party files, tests
run, and the narrowest next step. If the poll route remains unknown, say so
plainly and do not present a guessed route as a fix.
