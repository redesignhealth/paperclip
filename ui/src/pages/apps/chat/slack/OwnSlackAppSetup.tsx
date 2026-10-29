import { useEffect, useRef, useState } from "react";
import { ExternalLink, Loader2 } from "lucide-react";
import type { SlackConfigurationCredential } from "@paperclipai/shared";
import { isSlackManifestUpdatePending, slackRegistrationErrorMessage } from "@paperclipai/shared";
import { chatEndpointsApi, type ChatEndpoint } from "@/api/chatEndpoints";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { SetupWizardFooter } from "@/components/SetupWizard";
import { sanitizedSetupErrorMessage } from "../chat-setup-error";
import { SlackSetupAdvanced } from "../SlackAppDetails";
import { SlackConfigurationTokenSource, type SlackConfigurationTokenMode } from "./SlackConfigurationTokenSource";

/** Uses ordinary request-local state: configuration tokens never enter a query/mutation cache. */
export function OwnSlackAppSetup({ endpoint, stage, disabled, saveDetails, onSaved, onBusy,
  onManual, onManaged, onContinue, onSaveExit, slackSetupOptions, refetchSlackSetupOptions }: {
  endpoint: ChatEndpoint;
  stage: "app" | "credentials";
  disabled: boolean;
  saveDetails: () => Promise<void>;
  onSaved: (endpoint: ChatEndpoint) => void;
  onBusy: (busy: boolean) => void;
  onManual: (existing: boolean) => Promise<void>;
  onManaged?: () => Promise<void>;
  onContinue: () => void;
  onSaveExit: () => void;
  /** Passed down from SlackSetup so there is only one setup-options fetch. */
  slackSetupOptions?: { configurationCredentials?: SlackConfigurationCredential[] };
  refetchSlackSetupOptions?: () => Promise<unknown>;
}) {
  const [configurationToken, setConfigurationToken] = useState("");
  const [refreshToken, setRefreshToken] = useState("");
  const [selectedCredentialId, setSelectedCredentialId] = useState<string | null>(null);
  // The panel switches immediately after a save, before the parent refetch
  // lands. This optimistic entry is valid only against the options snapshot it
  // was made from: any newer authoritative snapshot (refetch, focus refresh)
  // replaces it, including one where the credential needs reauthorization or
  // has disappeared.
  const [justSaved, setJustSaved] = useState<{ credential: SlackConfigurationCredential; basis: typeof slackSetupOptions } | null>(null);
  // Preserve the directly visible one-time paste flow until a credential exists.
  const [modeChoice, setModeChoice] = useState<SlackConfigurationTokenMode | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [checkedNoApp, setCheckedNoApp] = useState(false);
  const requestId = useRef(crypto.randomUUID());
  const inFlight = useRef(false);
  const pendingWindow = useRef<Window | null>(null);
  const mounted = useRef(true);
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
      pendingWindow.current?.close();
      pendingWindow.current = null;
    };
  }, []);
  const registration = endpoint.setup?.slackRegistration;
  const uncertain = registration?.status === "uncertain";
  const creating = registration?.status === "creating";
  const created = Boolean(registration?.appId);
  // A new app's first manifest update and a later permission change both
  // need the same configuration-token retry to push the saved manifest.
  const configurationPending = isSlackManifestUpdatePending(registration?.errorCode);
  const optimistic = justSaved && justSaved.basis === slackSetupOptions ? justSaved.credential : null;
  const credentials = optimistic
    ? [...(slackSetupOptions?.configurationCredentials ?? []).filter(credential => credential.id !== optimistic.id), optimistic]
    : slackSetupOptions?.configurationCredentials ?? [];
  const mode: SlackConfigurationTokenMode = modeChoice ?? (credentials.length > 0 ? "refresh" : "access");
  // Set whenever this attempt touched a saved credential, so any failure can
  // refresh setup-options and let the panel switch to its re-paste state.
  const savedCredentialUsed = useRef(false);
  const selectedCredential = credentials.find(credential => credential.id === selectedCredentialId)
    ?? (credentials.length === 1 ? credentials[0] : undefined);
  // Only an active selection is usable as-is; a reauthorize selection needs a paste.
  const savedCredentialId = selectedCredential?.status === "active" ? selectedCredential.id : null;
  /** Ask the parent for authoritative options and drop the optimistic entry once they land. */
  async function reconcile() {
    if (!refetchSlackSetupOptions) return;
    try { await refetchSlackSetupOptions(); setJustSaved(null); }
    catch { /* keep the optimistic entry until a newer snapshot arrives */ }
  }
  const canStart = Boolean(savedCredentialId || configurationToken.trim() || refreshToken.trim());

  async function run(action: () => Promise<void>) {
    if (inFlight.current) return;
    inFlight.current = true;
    setBusy(true);
    onBusy(true);
    setError(null);
    try { await action(); }
    catch (failure) {
      setError(sanitizedSetupErrorMessage(failure, { configurationToken, refreshToken }));
      if (savedCredentialUsed.current) await reconcile();
    }
    finally {
      setConfigurationToken("");
      setRefreshToken("");
      setBusy(false);
      onBusy(false);
      inFlight.current = false;
    }
  }

  async function create() {
    // Reserve the window during the click so async app creation cannot trigger a popup blocker.
    const installWindow = window.open("about:blank", "_blank");
    if (installWindow) {
      installWindow.opener = null;
      installWindow.document.title = "Preparing Slack installation";
      installWindow.document.body.textContent = "Preparing your Slack installation…";
      pendingWindow.current = installWindow;
    }
    let token = configurationToken.trim();
    let pastedRefresh = refreshToken.trim();
    savedCredentialUsed.current = false;
    setConfigurationToken("");
    try {
      let next: ChatEndpoint;
      try {
        if (!created) await saveDetails();
        if (registration?.status === "failed" || checkedNoApp) requestId.current = crypto.randomUUID();
        setCheckedNoApp(false);
        // An explicitly typed token in access mode wins over a saved credential.
        const useTypedToken = mode === "access" && Boolean(token);
        let credentialId = useTypedToken ? null : savedCredentialId;
        // A pasted refresh token is never ignored: it is always saved, and the
        // app is created only with the credential that paste produced.
        if (!useTypedToken && pastedRefresh) {
          const replacing = selectedCredential;
          // Save (and thereby rotate) the pasted token first; only the summary id travels on.
          savedCredentialUsed.current = true;
          const saved = await chatEndpointsApi.saveSlackConfigurationCredential(endpoint.companyId, pastedRefresh);
          pastedRefresh = "";
          setRefreshToken("");
          setJustSaved({ credential: saved, basis: slackSetupOptions });
          setSelectedCredentialId(saved.id);
          // Replacing a specific workspace's token with one from another
          // workspace must not create the app somewhere unexpected.
          if (replacing?.status === "reauthorize" && saved.workspaceId !== replacing.workspaceId) {
            await reconcile();
            throw new Error(slackRegistrationErrorMessage("slack_configuration_credential_mismatch"));
          }
          credentialId = saved.id;
          await reconcile();
        } else if (!credentialId && !useTypedToken) {
          throw new Error(slackRegistrationErrorMessage("slack_configuration_refresh_required"));
        }
        if (credentialId) savedCredentialUsed.current = true;
        next = await chatEndpointsApi.createSlackApp(endpoint.id, {
          requestId: requestId.current,
          credentials: credentialId ? { configurationCredentialId: credentialId } : { configurationToken: token },
          ...(checkedNoApp ? { confirmedNoAppCreated: true } : {}),
        });
      } catch (failure) {
        // A response can be lost after Slack creates the app. Only saved state can advance.
        const current = await chatEndpointsApi.get(endpoint.id).catch(() => null);
        if (current && mounted.current) onSaved(current);
        if (!current?.setup?.slackRegistration?.appId) {
          throw new Error(sanitizedSetupErrorMessage(failure, { configurationToken: token, refreshToken: pastedRefresh }));
        }
        next = current;
      }
      token = "";
      pastedRefresh = "";
      if (!mounted.current) return;
      onSaved(next);
      const saved = next.setup?.slackRegistration;
      if (!saved?.appId) return;
      onContinue();
      // Pending/uncertain configuration and existing installations must not start OAuth.
      if (saved.status !== "install" || saved.errorCode) return;
      if (!installWindow || installWindow.closed) {
        setError("Select Install in Slack to open the installation page.");
        return;
      }
      const result = await chatEndpointsApi.installSlackApp(endpoint.id);
      if (!mounted.current) return;
      if (installWindow.closed) {
        setError("Select Install in Slack to reopen the installation page.");
        return;
      }
      installWindow.location.replace(result.authorizationUrl);
      pendingWindow.current = null;
    } finally {
      token = "";
      pastedRefresh = "";
      pendingWindow.current?.close();
      pendingWindow.current = null;
    }
  }

  async function authorize() {
    const result = await chatEndpointsApi.installSlackApp(endpoint.id);
    // Current-tab navigation avoids popup blockers. The callback resumes this saved draft.
    window.location.assign(result.authorizationUrl);
  }

  return <div className="space-y-5">
    {error || registration?.errorCode ? <p role="alert" className="text-sm text-destructive">
      {error ?? slackRegistrationErrorMessage(registration!.errorCode!)}
    </p> : null}
    {(stage === "app" && !created && !creating || configurationPending) && <>
      {uncertain && <div className="space-y-3 text-sm">
        <a href={registration?.managementUrl ?? "https://api.slack.com/apps"} target="_blank" rel="noopener noreferrer" className="underline underline-offset-4">Open Slack app settings <ExternalLink className="inline size-3" /></a>
        <label className="flex items-center gap-2">
          <Checkbox checked={checkedNoApp} disabled={busy} onCheckedChange={value => setCheckedNoApp(value === true)} />
          I checked Slack and no app was created. Create a new app.
        </label>
      </div>}
      {(!uncertain || checkedNoApp) && <SlackConfigurationTokenSource
        credentials={credentials}
        selectedCredentialId={selectedCredential?.id ?? null}
        mode={mode}
        refreshToken={refreshToken}
        configurationToken={configurationToken}
        disabled={disabled}
        busy={busy}
        onSelectCredential={setSelectedCredentialId}
        onModeChange={setModeChoice}
        onRefreshTokenChange={setRefreshToken}
        onConfigurationTokenChange={setConfigurationToken}
        onForget={id => void run(async () => {
          await chatEndpointsApi.forgetSlackConfigurationCredential(endpoint.companyId, id);
          setJustSaved(current => current?.credential.id === id ? null : current);
          setSelectedCredentialId(null);
          await reconcile();
        })}
      />}
    </>}
    {creating && <p role="status" className="flex items-center gap-2 text-sm text-muted-foreground"><Loader2 className="size-4 animate-spin" /> Creating your Slack app. You can return to this saved setup.</p>}
    {created && <p className="text-sm">
      <strong>{endpoint.setup?.slackApp?.appName ?? "Your Slack app"}</strong> is created.
      {stage === "credentials" && " Approve installation with your Slack account. Paperclip will link it to your signed-in Paperclip account and send you a welcome DM."}
    </p>}
    {stage === "credentials" && registration?.status === "credentials_saved" && <div className="space-y-2">
      <p className="text-sm text-muted-foreground">Your installation credentials are saved. Retry connecting to finish setup. If Slack access has changed, authorize the same app again.</p>
      <Button variant="link" className="h-auto p-0" disabled={busy || disabled} onClick={() => void run(authorize)}>Authorize in Slack again</Button>
    </div>}
    {stage === "app" && <SlackSetupAdvanced><div className="flex flex-wrap gap-4 text-sm">
      {onManaged && !registration && <Button variant="link" className="h-auto p-0" disabled={busy} onClick={() => void run(onManaged)}>Use managed setup</Button>}
      <Button variant="link" className="h-auto p-0" disabled={busy || creating} onClick={() => void run(() => onManual(false))}>Create manually</Button>
      <Button variant="link" className="h-auto p-0" disabled={busy || creating} onClick={() => void run(() => onManual(true))}>Use an existing app</Button>
    </div></SlackSetupAdvanced>}
    <SetupWizardFooter onSaveExit={onSaveExit} disabled={busy}>
      {configurationPending ? <Button disabled={busy || disabled || !canStart} onClick={() => void run(create)}>
        {busy && <Loader2 className="size-4 animate-spin" />}Retry app configuration
      </Button> : stage === "app" ? <Button disabled={busy || disabled || creating || (!created && (!canStart || uncertain && !checkedNoApp))}
        onClick={() => created ? onContinue() : void run(create)}>
        {busy && <Loader2 className="size-4 animate-spin" />}{created ? "Continue to installation" : "Create Slack app"}
      </Button> : registration?.status === "credentials_saved" ? <Button disabled={busy} onClick={() => void run(async () => onSaved(await chatEndpointsApi.resumeSlackInstallation(endpoint.id)))}>
        {busy && <Loader2 className="size-4 animate-spin" />}Retry connecting
      </Button> : <Button disabled={busy || !created || disabled} onClick={() => void run(authorize)}>
        {busy ? <Loader2 className="size-4 animate-spin" /> : <ExternalLink className="size-4" />}Install in Slack
      </Button>}
    </SetupWizardFooter>
  </div>;
}
