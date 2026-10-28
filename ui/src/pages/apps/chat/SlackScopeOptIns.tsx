import {
  SLACK_OPT_IN_BOT_SCOPE_GROUPS,
  SLACK_OPT_IN_SCOPE_GROUPS,
  slackOptInGroupsChanged,
  type SlackOptInScopeGroup,
} from "@paperclipai/shared";
import { Checkbox } from "@/components/ui/checkbox";

/**
 * TECH-7988: per-agent Slack permission opt-ins. Off by default so the manifest
 * only asks for the workspace's Low-risk scopes, which its approval automation
 * can auto-approve. Enabling a group adds non-Low scopes and therefore sends
 * this agent's install to admin review.
 */
export function SlackScopeOptIns({ value, disabled, pending, installed, onChange }: {
  value: readonly SlackOptInScopeGroup[];
  disabled?: boolean;
  pending?: boolean;
  installed?: readonly SlackOptInScopeGroup[];
  onChange: (groups: SlackOptInScopeGroup[]) => void;
}) {
  const needsReconnect = Boolean(installed) && slackOptInGroupsChanged({
    slackOptInScopeGroups: value,
    slackInstalledOptInScopeGroups: installed,
  });
  return <fieldset className="space-y-3" disabled={disabled || pending}>
    <legend className="text-sm font-semibold">Extra Slack permissions</legend>
    <p className="text-sm text-muted-foreground">
      Off by default so the install requests only Slack’s low-risk scopes, which your workspace can
      auto-approve. Read, reply, and channel history always work; these groups add extra abilities.
    </p>
    <div className="space-y-3">
      {SLACK_OPT_IN_SCOPE_GROUPS.map((group) => {
        const definition = SLACK_OPT_IN_BOT_SCOPE_GROUPS[group];
        const checked = value.includes(group);
        return <label key={group} className="flex items-start gap-2 text-sm">
          <Checkbox
            checked={checked}
            disabled={disabled || pending}
            aria-describedby={`slack-scope-${group}-help`}
            onCheckedChange={(next) => onChange(next === true
              ? SLACK_OPT_IN_SCOPE_GROUPS.filter((item) => item === group || value.includes(item))
              : value.filter((item) => item !== group))}
          />
          <span className="space-y-0.5">
            <span className="block font-medium">{definition.label}</span>
            <span id={`slack-scope-${group}-help`} className="block text-muted-foreground">
              {definition.description}
              {" "}({definition.scopes.join(", ")})
            </span>
          </span>
        </label>;
      })}
    </div>
    {needsReconnect && <p role="status" className="text-sm text-muted-foreground">
      This change takes effect after you reconnect this connection and approve the new permissions in
      Slack. Your current permissions stay in place until then.
    </p>}
  </fieldset>;
}
