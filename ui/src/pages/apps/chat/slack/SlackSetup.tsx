import { useQuery } from "@tanstack/react-query";
import type { ComponentProps } from "react";
import { accessApi } from "@/api/access";
import { chatEndpointsApi } from "@/api/chatEndpoints";
import { queryKeys } from "@/lib/queryKeys";
import { OwnSlackAppSetup } from "./OwnSlackAppSetup";
import { ManagedSlackSetup } from "./ManagedSlackSetup";
export function SlackSetup(props: ComponentProps<typeof OwnSlackAppSetup> & { autoStart?: boolean; reconnect?: boolean }) {
  const choices = useQuery({ queryKey: ["slack-managed-workspaces", props.endpoint.companyId], queryFn: () => chatEndpointsApi.slackSetupOptions(props.endpoint.companyId), retry: false });
  // The server enforces the same rule; this only decides whether to offer the option.
  const boardAccess = useQuery({ queryKey: queryKeys.access.currentBoardAccess, queryFn: () => accessApi.getCurrentBoardAccess(), retry: false });
  const canShare = boardAccess.data?.source === "local_implicit" || boardAccess.data?.isInstanceAdmin === true;
  return props.endpoint.setup?.slackSetupMethod === "managed"
    ? <ManagedSlackSetup {...props} />
    : <OwnSlackAppSetup {...props} slackSetupOptions={choices.data} canShareConfigurationToken={canShare}
        refetchSlackSetupOptions={async () => { const result = await choices.refetch(); if (result.isError) throw result.error; }}
        onManaged={choices.data?.defaultMethod === "managed" && !props.endpoint.setup?.slackRegistration ? async () => props.onSaved(await chatEndpointsApi.update(props.endpoint.id, { slackSetupMethod: "managed" })) : undefined} />;
}
