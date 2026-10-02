import { defineExtension, f } from "@abuseman/api";
import { Badge, HStack, KeyValue, ProgressView, Section, Text, VStack, useRequest } from "@abuseman/ui";
import { z } from "zod";

/** Inspector tab: the app passes `{ requestId }` for the selected request. */
function HeadersTab({ requestId }: { requestId: string }) {
  const { capturedRequest, isLoading, error } = useRequest(requestId);
  if (isLoading) return <ProgressView label="Loading request…" />;
  if (error || !capturedRequest) return <Text color="red" value={error?.message ?? "Request not found"} />;
  const { request } = capturedRequest;
  return (
    <VStack spacing={8} alignment="leading">
      <HStack spacing={6}>
        <Badge text={request.method} color="blue" />
        <Text style="headline">{request.host}</Text>
      </HStack>
      <Section title="Request headers">
        <KeyValue copyable items={request.headers.map((h) => ({ key: h.name, value: h.value, monospaced: true }))} />
      </Section>
    </VStack>
  );
}

export default defineExtension({
  activate(ctx) {
    // 1) Hook — the matcher is compiled and evaluated in the app; only matching requests reach us.
    ctx.proxy.onRequest(f.host("*.example.com").and(f.method("GET")), (req) => {
      req.headers.set("x-abuseman", "__NAME__");
    });

    // 2) Command — declared in manifest.json `contributes.commands` and shown in the request context menu.
    ctx.commands.register("__PREFIX__.showInfo", async ({ capturedRequest }) => {
      const request = capturedRequest?.request;
      await ctx.ui.toast(request ? `${request.method} ${request.host}${request.path}` : "No request selected");
    });

    // 3) Inspector tab — native SwiftUI rendering of a React component.
    ctx.ui.registerInspectorTab("__PREFIX__.headers", HeadersTab);

    // 4) Tool — available to the MCP server, the built-in assistant and ACP agents.
    ctx.tools.register({
      name: "count_headers",
      description: "Count the request headers of a captured request",
      input: z.object({ requestId: z.string().describe("Request id") }),
      risk: "read",
      run: async ({ requestId }) => {
        const captured = await ctx.requests.get(requestId);
        return { requestId, count: captured.request.headers.length };
      },
    });

    ctx.log.info("__NAME__ activated");
  },
});
