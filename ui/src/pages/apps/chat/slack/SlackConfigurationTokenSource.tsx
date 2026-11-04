import { ExternalLink } from "lucide-react";
import type { SlackConfigurationCredential } from "@paperclipai/shared";
import { slackRegistrationErrorMessage } from "@paperclipai/shared";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { Input } from "@/components/ui/input";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";

export type SlackConfigurationTokenMode = "refresh" | "access";

/**
 * TECH-7981: the saved-credential / one-time-token chooser.
 *
 * Purely presentational: `OwnSlackAppSetup` owns the request-local token state
 * and the busy/error wiring, so a token never enters a query or mutation cache.
 */
export function SlackConfigurationTokenSource({
  credentials,
  selectedCredentialId,
  mode,
  refreshToken,
  configurationToken,
  disabled,
  busy,
  onSelectCredential,
  onModeChange,
  onRefreshTokenChange,
  canShare,
  shareWithCompany,
  onShareChange,
  onConfigurationTokenChange,
  onForget,
}: {
  credentials: SlackConfigurationCredential[];
  selectedCredentialId: string | null;
  mode: SlackConfigurationTokenMode;
  refreshToken: string;
  configurationToken: string;
  disabled: boolean;
  busy: boolean;
  onSelectCredential: (id: string) => void;
  onModeChange: (mode: SlackConfigurationTokenMode) => void;
  onRefreshTokenChange: (value: string) => void;
  /** An instance administrator may save one token for every company in this instance. */
  canShare: boolean;
  shareWithCompany: boolean;
  onShareChange: (value: boolean) => void;
  onConfigurationTokenChange: (value: string) => void;
  onForget: (id: string) => void;
}) {
  const locked = busy || disabled;
  // Re-authorization is per workspace: one rejected chain must never hide the
  // others, so every saved credential stays selectable.
  const selected = credentials.find(credential => credential.id === selectedCredentialId)
    ?? (credentials.length === 1 ? credentials[0] : undefined);

  if (credentials.length > 0) {
    return <div className="space-y-2">
      {credentials.length > 1 && <Select value={selected?.id ?? ""} onValueChange={onSelectCredential} disabled={locked}>
        <SelectTrigger aria-label="Saved Slack configuration workspace"><SelectValue placeholder="Choose a workspace" /></SelectTrigger>
        <SelectContent>{credentials.map(credential => <SelectItem key={credential.id} value={credential.id}>
          {credential.workspaceId}{credential.shared ? " (shared)" : ""}{credential.status === "reauthorize" ? " (needs a new token)" : ""}
        </SelectItem>)}</SelectContent>
      </Select>}
      {selected?.status === "reauthorize" && mode !== "access" && <>
        <p role="alert" className="text-sm text-destructive">{slackRegistrationErrorMessage("slack_configuration_refresh_invalid")}</p>
        {selected.shared && !canShare
          ? <p className="text-sm">This token is shared by every company. Ask an instance administrator to save a new one for workspace <code>{selected.workspaceId}</code>, or use a one-time access token.</p>
          : <>
            <p className="text-sm">Save a new refresh token for workspace <code>{selected.workspaceId}</code></p>
            <RefreshTokenField value={refreshToken} disabled={locked} onChange={onRefreshTokenChange} />
            {canShare && !selected.shared && <ShareWithCompany checked={shareWithCompany} disabled={locked} onChange={onShareChange} />}
          </>}
      </>}
      {selected?.status === "active" && (selected.shared
        ? <p className="text-sm">Using the Slack configuration token your administrator saved for every company, for workspace <code>{selected.workspaceId}</code></p>
        : <p className="text-sm">Using your saved Slack configuration token for workspace <code>{selected.workspaceId}</code></p>)}
      {selected && <div className="flex flex-wrap gap-4 text-sm">
        {mode !== "access" && <Button variant="link" className="h-auto p-0" disabled={locked} onClick={() => onModeChange("access")}>Use a one-time access token instead</Button>}
        {(!selected.shared || canShare) && <Button variant="link" className="h-auto p-0" disabled={locked} onClick={() => onForget(selected.id)}>Forget saved token</Button>}
      </div>}
      {selected && mode === "access" && <AccessTokenField value={configurationToken} disabled={locked} onChange={onConfigurationTokenChange} />}
    </div>;
  }

  if (mode === "refresh") return <div className="space-y-2">
    <Button asChild size="lg" className="mb-4 h-auto w-full whitespace-normal py-4">
      <a href="https://api.slack.com/apps" target="_blank" rel="noopener noreferrer">Get your App configuration token <ExternalLink className="size-4" /></a>
    </Button>
    <div id="slack-configuration-refresh-token-help" className="space-y-3 pb-3 text-sm">
      <ol className="list-decimal space-y-2 pl-5">
        <li>In Slack app settings, find <strong>Your App Configuration Tokens</strong> and choose <strong>Generate Token</strong>.</li>
        <li>Select the workspace where you want to install your bot.</li>
        <li>Copy the <strong>Refresh Token</strong> (starts with <code>xoxe-1-</code>) and paste it below.</li>
      </ol>
      <p className="text-muted-foreground">Save it once for all your agents. Paperclip refreshes the configuration token automatically.</p>
    </div>
    <RefreshTokenField value={refreshToken} disabled={locked} onChange={onRefreshTokenChange} helpId="slack-configuration-refresh-token-help" />
    {canShare && <ShareWithCompany checked={shareWithCompany} disabled={locked} onChange={onShareChange} />}
    <Button variant="link" className="h-auto p-0" disabled={locked} onClick={() => onModeChange("access")}>Paste a one-time access token</Button>
  </div>;

  return <div className="space-y-2">
    <AccessTokenField value={configurationToken} disabled={locked} onChange={onConfigurationTokenChange} />
    <Button variant="link" className="h-auto p-0" disabled={locked} onClick={() => onModeChange("refresh")}>Save refresh token instead</Button>
  </div>;
}

function ShareWithCompany({ checked, disabled, onChange }: { checked: boolean; disabled: boolean; onChange: (value: boolean) => void }) {
  return <label className="flex items-start gap-2 text-sm">
    <Checkbox className="mt-0.5" checked={checked} disabled={disabled} onCheckedChange={value => onChange(value === true)} />
    <span>Save for every company in this instance<span className="block text-muted-foreground">Everyone who manages connections can set up Slack apps without a Slack token of their own. Only an instance administrator can change or remove it.</span></span>
  </label>;
}

function RefreshTokenField({ value, disabled, onChange, helpId }: { value: string; disabled: boolean; onChange: (value: string) => void; helpId?: string }) {
  return <>
    <label htmlFor="slack-configuration-refresh-token" className="text-sm font-medium">Configuration refresh token</label>
    <Input id="slack-configuration-refresh-token" type="password" autoComplete="off" spellCheck={false}
      value={value} disabled={disabled} onChange={event => onChange(event.target.value)}
      {...(helpId ? { "aria-describedby": helpId } : {})} />
  </>;
}

function AccessTokenField({ value, disabled, onChange }: { value: string; disabled: boolean; onChange: (value: string) => void }) {
  return <>
    <Button asChild size="lg" className="mb-4 h-auto w-full whitespace-normal py-4">
      <a href="https://api.slack.com/apps" target="_blank" rel="noopener noreferrer">Get your App configuration access token <ExternalLink className="size-4" /></a>
    </Button>
    <div id="slack-configuration-token-help" className="space-y-3 pb-3 text-sm">
      <ol className="list-decimal space-y-2 pl-5">
        <li>In Slack app settings, find <strong>Your App Configuration Tokens</strong> and choose <strong>Generate Token</strong>.</li>
        <li>Select the workspace where you want to install your bot.</li>
        <li>Copy the <strong>Access Token</strong> and paste it below.</li>
      </ol>
      <p className="text-muted-foreground">Paperclip uses this token to create your app</p>
    </div>
    <label htmlFor="slack-configuration-token" className="text-sm font-medium">App configuration access token</label>
    <Input id="slack-configuration-token" type="password" autoComplete="off" spellCheck={false}
      value={value} disabled={disabled} onChange={event => onChange(event.target.value)}
      aria-describedby="slack-configuration-token-help" />
  </>;
}
