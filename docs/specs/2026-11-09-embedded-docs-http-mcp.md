# Embedded Docs HTTP MCP access

## Status and scope

The user approved the proposed capability, required the project to remain neutral, and subsequently explicitly authorized implementation with the `implement` skill on 2026-11-09. This document defines the additional SDK contract. It supplements `2026-11-09-neutral-docs-sdk.md`; the already delivered SDK work remains its own accepted scope.

## Problem

The standalone application exposes an HTTP MCP endpoint. The Docs SDK already provides live document tools, a standard stdio MCP entry, and transport-neutral MCP server construction. However, `DocsQtEditor` does not expose a host-controlled HTTP MCP lifecycle. Its existing editor-action callback returns an internal document command bridge, which is not a standard HTTP MCP endpoint.

An embedding host needs to enable external Agent access to its current document without an editor AI-button action. Access must include unsaved edits and end when its document authority ends.

## Neutrality and ownership

- ForaOffice owns standard MCP transport, document tool execution, document binding, and connection cleanup.
- The embedding host explicitly enables and stops access, receives connection information, and decides which external client receives it.
- The external client owns conversation, models, prompts, orchestration, and its own MCP configuration format.
- Public contracts, examples, runtime behavior, and package dependencies must not require a particular host, Agent product, business object, document naming scheme, or conversation protocol.
- Existing hosted storage, permissions, read-only policy, save behavior, and file grants remain authoritative. Enabling MCP grants no additional filesystem or business-system access.

## Approach

Provide a small reusable HTTP MCP service in the SDK's Node services and expose its lifecycle through the Qt adapter. Reuse `createDocsMcpServer`, the command router, and the live document runtime. HTTP handling belongs to the owned Node backend; live editor operations retain their existing GUI-thread boundary.

Alternatives considered:

- Requiring every host to assemble an HTTP service from the existing transport-neutral server leaves the missing Qt lifecycle and binding contract unresolved and duplicates integration work.
- Exporting the action callback's bridge URL does not implement standard MCP and is unsuitable for external client configuration.

Keep reusable transport code independent of Electron application settings and tab management. Reuse suitable existing HTTP transport implementation where practical without importing standalone application policy or copying its complete cross-application service into the SDK.

## Public host contract

The Qt SDK exposes asynchronous operations to enable access, inspect its state, and stop access. Exact API names and native result types are implementation details to settle in the implementation plan; the following behavior is mandatory:

1. Enabling requires a ready editor with an active document. Failure returns an actionable error and leaves no listener, document grant, or pending binding behind.
2. The host does not need an action handler, AI-button interaction, model configuration, or conversation before enabling access.
3. Successful enable returns the actual standard MCP URL, transport identifier, and required authentication/header information in a client-independent structure. It also identifies the authorized document generation using the runtime's opaque identity, independently of a local path.
4. Connection information is sufficient to configure a compatible standard client. It is not a product-specific configuration file, internal IPC endpoint, or instruction to invoke a private handshake.
5. One active access grant per editor instance is sufficient. Repeated enable for the same generation is idempotent and returns the existing grant; repeated stop is safe. Different editor instances remain independent.
6. The host can observe running, stopped, and failed state, including automatic revocation. State inspection must not reveal a grant as active after its document authority ends.
7. Credentials are delivered only through the trusted host boundary. They must not appear in document content, tool results, ordinary logs, or error messages.

## Transport and interoperability

- Expose standard Streamable HTTP through the official MCP transport supported by the installed SDK. The external URL reaches MCP methods such as tool discovery and invocation, rather than the private `docs.request` command bridge.
- Explicitly document the implemented protocol revisions and verify the target client's compatible revision. Reuse of the existing implementation is not evidence of compliance with every later revision. A protocol upgrade or legacy SSE support is not implicitly part of this feature.
- Follow the authoritative transport and security requirements for the supported revision, including origin validation, loopback binding, authentication, content negotiation, cancellation, and transport cleanup as applicable.
- Default to loopback with an allocated available port; do not reserve a host-product-specific or standalone application port. Remote publication, network proxy configuration, and arbitrary network binding are outside this feature.
- Separate document authorization from any protocol-level session mechanism. A reconnect or new protocol session must not renew a revoked document grant.
- Keep the existing internal bridge private. Its address cannot be returned as the standard MCP URL.

## Live document behavior

- Requests operate on the authorized editor runtime, including unsaved manual edits and Agent edits. Reading does not force a save, export, or disk reload.
- Bind the grant to the current document generation when enabling, before any client request. A delayed first connection cannot bind to a subsequently opened document.
- Preserve native tool semantics, context/revision validation, selection behavior, write serialization, undo, dirty state, drafts, content restrictions, and host permissions. The feature adds access, not alternate editing semantics.
- Documents with opaque hosted identity and no local path work through the same contract. Existing save operations continue to respect hosted storage and capabilities; HTTP access does not create a local persistence fallback.
- Give independent client conversations independent runtime caller state. Closing one client must not silently revoke other clients or retarget their document context. Host stop revokes the complete editor grant.

## Lifecycle and races

1. Explicit stop revokes the grant, refuses new operations, cancels pending operations where supported, closes its transports/listener, and releases document scopes and callers without closing the editor.
2. Successful replacement or closure of the document revokes the old grant. New/open actions that are canceled and never replace the document do not constitute a document switch. Existing close checks may revoke access before a canceled close; any such revocation remains visible and access is not silently restored.
3. Opening a new document does not silently transfer old authority. The host explicitly enables a new grant; old connection information cannot authorize the new document even if a port is later reused.
4. Ordinary edits and saves that retain the active generation keep the grant valid. Identity adoption or replacement follows the runtime's established generation boundary, rather than comparing paths or display names.
5. Editor disposal, backend failure, renderer failure, and application shutdown invalidate authority and initiate cleanup through the existing owned-backend lifecycle. Preserve asynchronous widget disposal and worker cleanup.
6. Stop, replacement, or disposal during asynchronous enable wins: a late success cannot publish a usable endpoint for the ended generation. Partial-start failure cleans up all resources it created.
7. Late tool results cannot be applied to a replacement document. Cancellation or disconnect does not claim to roll back an already committed edit or file write; preserve the existing operation outcome semantics.

## Verification and acceptance

Use public SDK/Qt boundaries and existing runtime fixtures. Add focused regressions for the new contract rather than rerunning settled prior SDK acceptance without cause.

1. Start from a ready Qt editor without an action handler or AI-button interaction. Connect a standard HTTP MCP client using only the returned information, discover the existing tools, and read unsaved content.
2. Modify content through MCP and observe the live editor update. Modify manually afterward and verify the next read reflects it. Preserve undo, dirty, and read-only enforcement.
3. Exercise a hosted document without a local path and retain its existing storage policy. Test authentication refusal and credential redaction.
4. Verify repeated enable/stop, independent editors, and independent client caller state. A client's disconnection does not revoke another client's access.
5. Enable for document A, replace it with B before the first client request, and prove the old grant cannot read or mutate B. Repeat with an already connected client and an in-flight operation. Reopening A still requires a new grant.
6. Verify explicit stop, normal close, disposal, failure, partial-start failure, and enable/stop races leave no reusable document authority or service resources. Re-enable produces a valid new grant.
7. Build the distributable SDK and Qt adapter; verify HTTP transport and native lifecycle APIs are present in the packaged SDK with generic examples and connection documentation.
8. Validate interoperability with a real intended external Agent client in addition to the standard reference client. Record the client version, protocol revision, authentication configuration, and observed live-document results. A reference-client pass alone is not end-to-end integration acceptance. External environment writes require the user's specific approval and are not authorized by this specification.

## Out of scope

- Host-product branches, business identifiers, field catalogs, prompt templates, chat UI, model/provider settings, and Agent startup or deployment.
- Automatic configuration changes in external clients, shared infrastructure, or external test environments.
- Whole-application tab control, other Office application SDKs, remote service hosting, and a new document-operation protocol.

## Standards and existing implementation references

- [MCP 2025-11-25 transport specification](https://modelcontextprotocol.io/specification/2025-11-25/basic/transports).
- [MCP 2026-07-28 Streamable HTTP specification](https://modelcontextprotocol.io/specification/2026-07-28/basic/transports/streamable-http). Transport/session behavior differs by revision; select and test the supported contract explicitly.
- `apps/docs/src/services/docs-mcp.ts`, `host-bridge.ts`, `mcp-stdio.ts`, and `node-host.ts`.
- `apps/docs/src/renderer/runtime/command-router.ts` and `docs-runtime.ts`.
- `apps/docs/src/renderer/host/qt.ts` and `apps/docs/hosts/qt/DocsQtEditor.hpp` / `.cpp`.
- `apps/shell/src/main/mcp/mcp-server.ts` for the existing standalone HTTP transport.
