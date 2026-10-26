import { useEffect, useMemo, useRef, useState } from "react";
import { useInfiniteQuery, useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Check, Copy } from "lucide-react";
import { accessApi } from "@/api/access";
import { ApiError } from "@/api/client";
import { Button } from "@/components/ui/button";
import { useCompany } from "@/context/CompanyContext";
import { useToast } from "@/context/ToastContext";
import { Link } from "@/lib/router";
import { queryKeys } from "@/lib/queryKeys";
import { copyTextToClipboard } from "@/lib/clipboard";
import { Badge } from "@/components/ui/badge";

const inviteRoleOptions = [
  {
    value: "viewer",
    label: "Viewer",
    description: "Can view organization work and follow along.",
    gets: "View-only organization membership.",
  },
  {
    value: "operator",
    label: "Operator",
    description: "Recommended for people who need to help run work without managing access.",
    gets: "Can assign tasks.",
  },
  {
    value: "admin",
    label: "Admin",
    description: "Recommended for operators who need to invite people, create agents, and approve joins.",
    gets: "Can create agents, invite users, assign tasks, and approve join requests.",
  },
  {
    value: "owner",
    label: "Owner",
    description: "Full organization access, including membership management.",
    gets: "Everything in Admin, plus managing members.",
  },
] as const;

const INVITE_HISTORY_PAGE_SIZE = 5;

/**
 * TECH-7952: the server's reason for refusing an owner handoff, in the words the person looking at
 * the page needs. Keyed on the server's own `reason` so this copy can never disagree with the
 * decision the create call would make.
 */
const ownerHandoffUnavailableCopy: Record<string, string> = {
  not_instance_admin: "This is a private company. Only an instance admin can invite its owner.",
  cloud_managed_company:
    "This company's membership is managed by Paperclip Cloud. Owner handoff is unavailable here.",
  slot_occupied:
    "This private company already has its human owner or a pending owner invite. Revoke the pending invite or remove that member first.",
  not_private: "This company is no longer private, so owner handoff does not apply.",
};

const ownerHandoffUnavailableFallbackCopy =
  "Owner handoff is unavailable for this company right now.";

function isInviteHistoryRow(value: unknown): value is Awaited<ReturnType<typeof accessApi.listInvites>>["invites"][number] {
  if (!value || typeof value !== "object") return false;
  return "id" in value && "state" in value && "createdAt" in value;
}

/** The Invites tab of the Members page (extracted from the former standalone Invites page). */
export function InvitesSection() {
  const { selectedCompanyId, selectedCompany } = useCompany();
  const { pushToast } = useToast();
  const queryClient = useQueryClient();
  const [humanRole, setHumanRole] = useState<"owner" | "admin" | "operator" | "viewer">("operator");
  const [ownerEmail, setOwnerEmail] = useState("");
  const [latestInviteUrl, setLatestInviteUrl] = useState<string | null>(null);
  const [latestInviteCopied, setLatestInviteCopied] = useState(false);
  const latestInviteInputRef = useRef<HTMLInputElement | null>(null);

  useEffect(() => {
    if (!latestInviteCopied) return;
    const timeout = window.setTimeout(() => {
      setLatestInviteCopied(false);
    }, 1600);
    return () => window.clearTimeout(timeout);
  }, [latestInviteCopied]);

  function selectLatestInviteUrl() {
    latestInviteInputRef.current?.focus();
    latestInviteInputRef.current?.select();
  }

  async function copyText(text: string, unavailableBody: string, afterFallback?: () => void) {
    try {
      await copyTextToClipboard(text);
      return true;
    } catch {
      afterFallback?.();
    }
    pushToast({
      title: "Clipboard unavailable",
      body: unavailableBody,
      tone: "warn",
    });
    return false;
  }

  async function copyInviteUrl(url: string) {
    return copyText(url, "The invite URL is selected. Copy it manually from the field.", selectLatestInviteUrl);
  }

  const inviteHistoryQueryKey = queryKeys.access.invites(selectedCompanyId ?? "", "all", INVITE_HISTORY_PAGE_SIZE);
  const invitesQuery = useInfiniteQuery({
    queryKey: inviteHistoryQueryKey,
    queryFn: ({ pageParam }) =>
      accessApi.listInvites(selectedCompanyId!, {
        limit: INVITE_HISTORY_PAGE_SIZE,
        offset: pageParam,
      }),
    enabled: !!selectedCompanyId,
    initialPageParam: 0,
    getNextPageParam: (lastPage) => lastPage.nextOffset ?? undefined,
  });
  const inviteHistory = useMemo(
    () =>
      invitesQuery.data?.pages.flatMap((page) =>
        Array.isArray(page?.invites) ? page.invites.filter(isInviteHistoryRow) : [],
      ) ?? [],
    [invitesQuery.data?.pages],
  );

  // TECH-7952: a private company's only human invitation is an owner handoff, and only the
  // server can say whether this caller may issue one right now. One server-derived answer
  // (`available` + `reason`) drives both the form and its copy, so the button the UI shows and
  // the decision create makes cannot drift -- no client-side instance-admin flag is consulted.
  const isPrivateCompany = selectedCompany?.visibility === "private";
  const ownerHandoffAvailabilityQuery = useQuery({
    queryKey: queryKeys.access.ownerHandoffAvailability(selectedCompanyId ?? ""),
    queryFn: () => accessApi.getOwnerHandoffAvailability(selectedCompanyId!),
    enabled: !!selectedCompanyId && isPrivateCompany,
    retry: false,
  });
  const ownerHandoffAvailability = ownerHandoffAvailabilityQuery.data ?? null;
  const canCreatePrivateOwnerInvite = !isPrivateCompany || ownerHandoffAvailability?.available === true;
  const unavailableReason = ownerHandoffAvailability?.reason ?? null;
  const resolvedUnavailableCopy = ownerHandoffAvailabilityQuery.isError
    ? ownerHandoffUnavailableFallbackCopy
    : (unavailableReason ? ownerHandoffUnavailableCopy[unavailableReason] : null)
      ?? ownerHandoffUnavailableFallbackCopy;
  const ownerEmailIsValid = /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(ownerEmail.trim());

  const createInviteMutation = useMutation({
    mutationFn: () =>
      isPrivateCompany
        ? accessApi.createCompanyInvite(selectedCompanyId!, {
            allowedJoinTypes: "human",
            humanRole: "owner",
            email: ownerEmail.trim().toLowerCase(),
            agentMessage: null,
          })
        : accessApi.createCompanyInvite(selectedCompanyId!, {
            allowedJoinTypes: "human",
            humanRole,
            agentMessage: null,
          }),
    onSuccess: async (invite) => {
      if (isPrivateCompany) setOwnerEmail("");
      setLatestInviteUrl(invite.inviteUrl);
      setLatestInviteCopied(false);
      const copied = await copyText(invite.inviteUrl, "Copy the invite URL manually from the field below.");

      await queryClient.invalidateQueries({ queryKey: inviteHistoryQueryKey });
      // A new handoff invite claims the private slot, and revoking frees it again -- refresh the
      // server's answer so the form reflects reality without a reload.
      if (isPrivateCompany && selectedCompanyId) {
        await queryClient.invalidateQueries({
          queryKey: queryKeys.access.ownerHandoffAvailability(selectedCompanyId),
        });
      }
      pushToast({
        title: "Invite created",
        body: copied ? "Invite ready below and copied to clipboard." : "Invite ready below.",
        tone: "success",
      });
    },
    onError: (error) => {
      pushToast({
        title: "Failed to create invite",
        body: error instanceof Error ? error.message : "Unknown error",
        tone: "error",
      });
    },
  });

  const revokeMutation = useMutation({
    mutationFn: (inviteId: string) => accessApi.revokeInvite(inviteId),
    onSuccess: async () => {
      await queryClient.invalidateQueries({ queryKey: inviteHistoryQueryKey });
      if (isPrivateCompany && selectedCompanyId) {
        await queryClient.invalidateQueries({
          queryKey: queryKeys.access.ownerHandoffAvailability(selectedCompanyId),
        });
      }
      pushToast({ title: "Invite revoked", tone: "success" });
    },
    onError: (error) => {
      pushToast({
        title: "Failed to revoke invite",
        body: error instanceof Error ? error.message : "Unknown error",
        tone: "error",
      });
    },
  });

  if (!selectedCompanyId) {
    return <div className="text-sm text-muted-foreground">Select an organization to manage invites.</div>;
  }

  if (invitesQuery.isLoading) {
    return <div className="text-sm text-muted-foreground">Loading invites…</div>;
  }

  if (invitesQuery.error) {
    const message =
      invitesQuery.error instanceof ApiError && invitesQuery.error.status === 403
        ? "You do not have permission to manage organization invites."
        : invitesQuery.error instanceof Error
          ? invitesQuery.error.message
          : "Failed to load invites.";
    return <div className="text-sm text-destructive">{message}</div>;
  }

  return (
    <div className="max-w-6xl space-y-8">
      <p className="max-w-3xl text-sm text-muted-foreground">
        Invite people to request access to this organization. New invite links are copied to your clipboard when they are
        generated.
      </p>

      {isPrivateCompany && ownerHandoffAvailabilityQuery.isLoading ? (
        <section className="space-y-2 rounded-xl border border-border p-5">
          <h2 className="text-sm font-semibold">Invite a person</h2>
          <p className="text-sm text-muted-foreground">Checking your access…</p>
        </section>
      ) : !canCreatePrivateOwnerInvite ? (
        <section className="space-y-2 rounded-xl border border-border p-5">
          <h2 className="text-sm font-semibold">Invite a person</h2>
          <p className="text-sm text-muted-foreground">{resolvedUnavailableCopy}</p>
        </section>
      ) : (
        <section className="space-y-4 rounded-xl border border-border p-5">
          <div className="space-y-1">
            <h2 className="text-sm font-semibold">{isPrivateCompany ? "Invite the owner" : "Invite a person"}</h2>
            <p className="text-sm text-muted-foreground">
              {isPrivateCompany
                ? "Hand this company off to one human owner by email."
                : "Generate a human invite link and choose the default access it should request."}
            </p>
          </div>

          {isPrivateCompany ? (
            <div className="space-y-3">
              <label className="block space-y-1">
                <span className="text-sm font-medium">Owner email</span>
                <input
                  type="email"
                  required
                  value={ownerEmail}
                  onChange={(event) => setOwnerEmail(event.target.value)}
                  placeholder="owner@example.com"
                  className="w-full rounded-md border border-border bg-background px-3 py-2 text-sm text-foreground outline-none focus:border-ring"
                />
              </label>
              <div className="rounded-lg border border-border px-4 py-3 text-sm text-muted-foreground">
                Role: <span className="font-medium text-foreground">Owner</span> (fixed for a private company)
              </div>
              <div className="rounded-lg border border-border px-4 py-3 text-sm text-muted-foreground">
                Private companies allow one human owner. The invite is single-use, expires in 72 hours, and can only
                be accepted by this email after signing in with your organization&apos;s SSO. When the owner accepts,
                your membership in this company ends.
              </div>
            </div>
          ) : (
            <>
              <fieldset className="space-y-3">
                <legend className="text-sm font-medium">Choose a role</legend>
                <div className="rounded-xl border border-border">
                  {inviteRoleOptions.map((option, index) => {
                    const checked = humanRole === option.value;
                    return (
                      <label
                        key={option.value}
                        className={`flex cursor-pointer gap-3 px-4 py-4 ${index > 0 ? "border-t border-border" : ""}`}
                      >
                        <input
                          type="radio"
                          name="invite-role"
                          value={option.value}
                          checked={checked}
                          onChange={() => setHumanRole(option.value)}
                          className="mt-1 h-4 w-4 border-border text-foreground"
                        />
                        <span className="min-w-0 space-y-1">
                          <span className="flex flex-wrap items-center gap-2">
                            <span className="text-sm font-medium">{option.label}</span>
                            {option.value === "operator" ? (
                              <Badge variant="outline" className="border-border text-muted-foreground">
                                Default
                              </Badge>
                            ) : null}
                          </span>
                          <span className="block max-w-2xl text-sm text-muted-foreground">{option.description}</span>
                          <span className="block text-sm text-foreground">{option.gets}</span>
                        </span>
                      </label>
                    );
                  })}
                </div>
              </fieldset>

              <div className="rounded-lg border border-border px-4 py-3 text-sm text-muted-foreground">
                Each invite link is single-use. Human invitees get the selected role immediately after sign-in; agent invites still create a join request for approval.
              </div>
            </>
          )}

          <div className="flex flex-wrap items-center gap-3">
            <Button
              onClick={() => createInviteMutation.mutate()}
              disabled={createInviteMutation.isPending || (isPrivateCompany && !ownerEmailIsValid)}
            >
              {createInviteMutation.isPending
                ? "Creating…"
                : isPrivateCompany
                  ? "Create owner invite"
                  : "Create invite"}
            </Button>
            <span className="text-sm text-muted-foreground">Invite history below keeps the audit trail.</span>
          </div>
        </section>
      )}

      {latestInviteUrl ? (
        <section className="space-y-3 rounded-xl border border-border p-5">
          <div className="space-y-3 rounded-lg border border-border px-4 py-4">
            <div className="space-y-1">
              <div className="flex items-center justify-between gap-3">
                <div className="text-sm font-medium">Latest invite link</div>
                {latestInviteCopied ? (
                  <div className="inline-flex items-center gap-1 text-xs font-medium text-foreground">
                    <Check className="h-3.5 w-3.5" />
                    Copied
                  </div>
                ) : null}
              </div>
              <div className="text-sm text-muted-foreground">
                This URL includes the current Paperclip domain returned by the server.
              </div>
            </div>
            <label className="block space-y-1">
              <span className="sr-only">Latest invite URL</span>
              <input
                ref={latestInviteInputRef}
                readOnly
                value={latestInviteUrl}
                onFocus={(event) => event.currentTarget.select()}
                onClick={(event) => event.currentTarget.select()}
                className="w-full rounded-md border border-border bg-muted/60 px-3 py-2 text-sm text-foreground outline-none transition-colors selection:bg-primary selection:text-primary-foreground focus:border-ring"
                aria-label="Latest invite URL"
              />
            </label>
            <div className="flex flex-wrap gap-2">
              <Button
                type="button"
                size="sm"
                variant="outline"
                onClick={async () => {
                  const copied = await copyInviteUrl(latestInviteUrl);
                  setLatestInviteCopied(copied);
                }}
              >
                <Copy className="h-4 w-4" />
                Copy link
              </Button>
            </div>
          </div>
        </section>
      ) : null}

      <section className="rounded-xl border border-border">
        <div className="flex flex-wrap items-center justify-between gap-4 px-5 py-4">
          <div className="space-y-1">
            <h2 className="text-sm font-semibold">Invite history</h2>
            <p className="text-sm text-muted-foreground">
              Review invite status, audience, inviter, and any linked join request.
            </p>
          </div>
          <Link to="/inbox/requests" className="text-sm underline underline-offset-4">
            Open join request queue
          </Link>
        </div>

        {inviteHistory.length === 0 ? (
          <div className="border-t border-border px-5 py-8 text-sm text-muted-foreground">
            No invites have been created for this organization yet.
          </div>
        ) : (
          <div className="border-t border-border">
            <div className="overflow-x-auto">
              <table className="min-w-full text-left text-sm">
                <thead>
                  <tr className="border-b border-border">
                    <th className="px-5 py-3 font-medium text-muted-foreground">State</th>
                    <th className="px-5 py-3 font-medium text-muted-foreground">For</th>
                    <th className="px-5 py-3 font-medium text-muted-foreground">Invited by</th>
                    <th className="px-5 py-3 font-medium text-muted-foreground">Created</th>
                    <th className="px-5 py-3 font-medium text-muted-foreground">Join request</th>
                    <th className="px-5 py-3 text-right font-medium text-muted-foreground">Action</th>
                  </tr>
                </thead>
                <tbody>
                  {inviteHistory.map((invite) => (
                    <tr key={invite.id} className="border-b border-border last:border-b-0">
                      <td className="px-5 py-3 align-top">
                        <Badge variant="outline" className="border-border text-muted-foreground">
                          {formatInviteState(invite.state)}
                        </Badge>
                      </td>
                      <td className="px-5 py-3 align-top">
                        <div className="flex flex-wrap items-center gap-2">
                          <span>{formatInviteAudience(invite)}</span>
                          {invite.ownerHandoff ? (
                            <Badge variant="outline" className="border-border text-muted-foreground">
                              Owner handoff
                            </Badge>
                          ) : null}
                        </div>
                        {invite.ownerHandoff && invite.boundEmail ? (
                          <div className="text-xs text-muted-foreground">{invite.boundEmail}</div>
                        ) : null}
                      </td>
                      <td className="px-5 py-3 align-top">
                        <div>{invite.invitedByUser?.name || invite.invitedByUser?.email || "Unknown inviter"}</div>
                        {invite.invitedByUser?.email && invite.invitedByUser.name ? (
                          <div className="text-xs text-muted-foreground">{invite.invitedByUser.email}</div>
                        ) : null}
                      </td>
                      <td className="px-5 py-3 align-top text-muted-foreground">
                        {new Date(invite.createdAt).toLocaleString()}
                      </td>
                      <td className="px-5 py-3 align-top">
                        {invite.relatedJoinRequestId ? (
                          <Link to="/inbox/requests" className="underline underline-offset-4">
                            Review request
                          </Link>
                        ) : (
                          <span className="text-muted-foreground">—</span>
                        )}
                      </td>
                      <td className="px-5 py-3 text-right align-top">
                        {invite.state === "active" ? (
                          <Button
                            size="sm"
                            variant="outline"
                            onClick={() => revokeMutation.mutate(invite.id)}
                            disabled={revokeMutation.isPending}
                          >
                            Revoke
                          </Button>
                        ) : (
                          <span className="text-xs text-muted-foreground">Inactive</span>
                        )}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
            {invitesQuery.hasNextPage ? (
              <div className="flex justify-center border-t border-border px-5 py-4">
                <Button
                  type="button"
                  variant="outline"
                  onClick={() => invitesQuery.fetchNextPage()}
                  disabled={invitesQuery.isFetchingNextPage}
                >
                  {invitesQuery.isFetchingNextPage ? "Loading more…" : "View more"}
                </Button>
              </div>
            ) : null}
          </div>
        )}
      </section>
    </div>
  );
}

function formatInviteState(state: "active" | "accepted" | "expired" | "revoked") {
  return state.charAt(0).toUpperCase() + state.slice(1);
}

function formatInviteAudience(invite: Awaited<ReturnType<typeof accessApi.listInvites>>["invites"][number]) {
  if (invite.allowedJoinTypes === "agent") return "Agent";
  if (invite.allowedJoinTypes === "both") return invite.humanRole ? `Human or agent · ${invite.humanRole}` : "Human or agent";
  return invite.humanRole ?? "Human";
}
