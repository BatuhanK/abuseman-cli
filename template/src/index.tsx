import { defineExtension, f } from "@abuseman/api";
import { Badge, HStack, KeyValue, ProgressView, Section, Text, VStack, useBody, useRequest } from "@abuseman/ui";
import { z } from "zod";

/** Inspector tab: the app passes `{ requestId }` for the selected request. */
function HeadersTab({ requestId }: { requestId: string }) {
  const { capturedRequest, isLoading, error } = useRequest(requestId);
  const body = useBody(requestId, "response");
  if (isLoading) return <ProgressView label="Loading request…" />;
  if (error || !capturedRequest) return <Text color="red" value={error?.message ?? "Request not found"} />;
  const { request, response } = capturedRequest;
  return (
    <VStack spacing={8} alignment="leading">
      <HStack spacing={6}>
        <Badge text={request.method} color="blue" />
        <Text style="headline">{request.host}</Text>
        {response ? <Badge text={String(response.status)} color={response.status >= 400 ? "red" : "green"} /> : null}
      </HStack>
      <Section title="Request headers">
        <KeyValue copyable items={request.headers.map((h) => ({ key: h.name, value: h.value, monospaced: true }))} />
      </Section>
      {body.data ? <Text style="caption" color="secondary" value={`Response body: ${body.data.text.length} characters`} /> : null}
    </VStack>
  );
}

export default defineExtension({
  activate(ctx) {
    // 1) Hook: the match is compiled and evaluated in the app; only matching requests reach us.
    ctx.proxy.onRequest(f.host("*.example.com").and(f.method("GET")), (req) => {
      req.headers.set("x-abuseman", "__NAME__");
    });

    // 2) Commands: declared in manifest.json `contributes.commands`, placed by `contributes.menus`.
    ctx.commands.register("__PREFIX__.showInfo", async ({ capturedRequest }) => {
      const request = capturedRequest?.request;
      await ctx.ui.toast(request ? `${request.method} ${request.host}${request.path}` : "No request selected");
    });
    ctx.commands.register("__PREFIX__.tagReviewed", async ({ selection }) => {
      const ids = selection?.requestIds ?? [];
      if (ids.length === 0) return;
      await ctx.requests.tag(ids, { add: ["reviewed"] });
      await ctx.ui.toast(`Tagged ${ids.length} request${ids.length === 1 ? "" : "s"}`, "success");
    });

    // 3) Inspector tab: a React component rendered natively by the app.
    ctx.ui.registerInspectorTab("__PREFIX__.headers", HeadersTab);

    // 4) Tool: for MCP clients and the Assistant (as `ext.<id with underscores>.count_headers`).
    ctx.tools.register({
      name: "count_headers",
      description: "Count the request headers of a captured request",
      input: z.object({ requestId: z.string().describe("Request ID") }),
      risk: "read",
      run: async ({ requestId }) => {
        const captured = await ctx.requests.get(requestId);
        return { requestId, count: captured.request.headers.length };
      },
    });

    ctx.log.info("__NAME__ activated");
  },
});
