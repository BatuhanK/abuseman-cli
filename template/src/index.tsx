import { defineExtension, f } from "@abuseman/api";
import { Badge, HStack, KeyValue, ProgressView, Section, Text, VStack, useFlow } from "@abuseman/ui";
import { z } from "zod";

/** Inspector tab: the app passes `{ flowId }` for the selected flow. */
function HeadersTab({ flowId }: { flowId: string }) {
  const { flow, isLoading, error } = useFlow(flowId);
  if (isLoading) return <ProgressView label="Loading flow…" />;
  if (error || !flow) return <Text color="red" value={error?.message ?? "Flow not found"} />;
  return (
    <VStack spacing={8} alignment="leading">
      <HStack spacing={6}>
        <Badge text={flow.request.method} color="blue" />
        <Text style="headline">{flow.request.host}</Text>
      </HStack>
      <Section title="Request headers">
        <KeyValue copyable items={flow.request.headers.map((h) => ({ key: h.name, value: h.value, monospaced: true }))} />
      </Section>
    </VStack>
  );
}

export default defineExtension({
  activate(ctx) {
    // 1) Hook — the matcher is compiled and evaluated in the app; only matching flows reach us.
    ctx.proxy.onRequest(f.host("*.example.com").and(f.method("GET")), (req) => {
      req.headers.set("x-abuseman", "__NAME__");
    });

    // 2) Command — declared in manifest.json `contributes.commands` and shown in the flow menu.
    ctx.commands.register("__PREFIX__.showInfo", async ({ flow }) => {
      await ctx.ui.toast(flow ? `${flow.request.method} ${flow.request.host}${flow.request.path}` : "No flow selected");
    });

    // 3) Inspector tab — native SwiftUI rendering of a React component.
    ctx.ui.registerInspectorTab("__PREFIX__.headers", HeadersTab);

    // 4) Tool — available to the MCP server, the built-in agent and ACP agents.
    ctx.tools.register({
      name: "count_headers",
      description: "Count the request headers of a flow",
      input: z.object({ flowId: z.string().describe("Flow id") }),
      risk: "read",
      run: async ({ flowId }) => {
        const flow = await ctx.flows.get(flowId);
        return { flowId, count: flow.request.headers.length };
      },
    });

    ctx.log.info("__NAME__ activated");
  },
});
