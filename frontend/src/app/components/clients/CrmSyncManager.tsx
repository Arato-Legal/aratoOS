"use client";

import { useCallback, useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import {
    MikeApiError,
    createCrmSyncEndpoint,
    deleteCrmSyncEndpoint,
    listCrmSyncEndpoints,
    listCrmSyncEvents,
    rotateCrmSyncSecret,
    updateCrmSyncEndpoint,
} from "@/app/lib/mikeApi";
import { notifyError } from "@/app/lib/userFacingError";
import { useAuth } from "@/app/contexts/AuthContext";
import {
    PERSONAL_WORKSPACE,
    useWorkspaceParam,
} from "@/app/contexts/WorkspaceContext";
import { PageHeader } from "@/app/components/shared/PageHeader";
import { PAGE_HEADER_TITLE_CLASS } from "@/app/components/shared/pageHeaderStyles";
import { ConfirmPopup } from "@/app/components/popups/ConfirmPopup";
import { PillButtonUI } from "@/shared/ui/PillButtonUI";
import { FORM_CONTROL_GLASS_CLASS } from "@/app/components/ui/form-field";
import { cn } from "@/app/lib/utils";
import type { CrmSyncEndpoint, CrmSyncEvent } from "../shared/types";
import {
    DashboardPage,
    DashboardSection,
    SelectField,
    formatDate,
} from "./DashboardPrimitives";

const EXAMPLE_PUSH = `POST <webhook URL>
Authorization: Bearer <secret>
Content-Type: application/json

{
  "events": [
    {
      "type": "client.upsert",
      "data": {
        "external_id": "hubflo-company-123",
        "name": "Acme Inc.",
        "kind": "organization",
        "status": "active",
        "email": "ceo@acme.example",
        "contacts": [
          { "external_id": "hubflo-contact-9", "name": "Jo Lee", "role": "CFO", "email": "jo@acme.example" }
        ],
        "updated_at": "2026-10-26T15:04:05Z"
      }
    },
    {
      "type": "matter.upsert",
      "data": {
        "external_id": "hubflo-project-456",
        "name": "Acme financing",
        "cm_number": "2026-014",
        "practice": "Corporate",
        "client_external_id": "hubflo-company-123",
        "archived": false
      }
    }
  ]
}`;

type Revealed = { endpointId: string; secret: string };

export function CrmSyncManager() {
    const router = useRouter();
    const { isAuthenticated, authLoading } = useAuth();
    const workspaceParam = useWorkspaceParam();
    const workspace = workspaceParam ?? PERSONAL_WORKSPACE;
    const isOrg = workspace !== PERSONAL_WORKSPACE;

    const [endpoints, setEndpoints] = useState<CrmSyncEndpoint[]>([]);
    const [loading, setLoading] = useState(true);
    const [forbidden, setForbidden] = useState(false);
    const [attempt, setAttempt] = useState(0);
    const [name, setName] = useState("");
    const [visibility, setVisibility] = useState<"private" | "organization">("private");
    const [creating, setCreating] = useState(false);
    const [revealed, setRevealed] = useState<Revealed | null>(null);
    const [copied, setCopied] = useState<string | null>(null);
    const [events, setEvents] = useState<{ id: string; rows: CrmSyncEvent[] } | null>(null);
    const [toDelete, setToDelete] = useState<CrmSyncEndpoint | null>(null);
    const reload = useCallback(() => setAttempt((n) => n + 1), []);

    useEffect(() => {
        if (authLoading || !isAuthenticated) return;
        let cancelled = false;
        listCrmSyncEndpoints(workspace)
            .then((rows) => {
                if (cancelled) return;
                setEndpoints(rows);
                setForbidden(false);
            })
            .catch((error) => {
                if (cancelled) return;
                if (error instanceof MikeApiError && error.status === 403) {
                    setForbidden(true);
                    return;
                }
                notifyError(error, {
                    action: "load CRM sync",
                    dedupeKey: "crm-sync",
                    onRetry: reload,
                });
            })
            .finally(() => {
                if (!cancelled) setLoading(false);
            });
        return () => {
            cancelled = true;
        };
    }, [authLoading, isAuthenticated, workspace, attempt, reload]);

    const webhookUrl = (endpoint: CrmSyncEndpoint) =>
        `${window.location.origin}/api${endpoint.webhook_path}`;

    const copy = async (key: string, text: string) => {
        try {
            await navigator.clipboard.writeText(text);
            setCopied(key);
            window.setTimeout(() => setCopied((c) => (c === key ? null : c)), 2000);
        } catch {
            window.prompt("Copy this", text);
        }
    };

    const create = async () => {
        if (!name.trim() || creating) return;
        setCreating(true);
        try {
            const { endpoint, secret } = await createCrmSyncEndpoint(
                {
                    name: name.trim(),
                    provider: "hubflo",
                    matter_visibility: isOrg ? visibility : "private",
                },
                workspace,
            );
            setName("");
            setRevealed({ endpointId: endpoint.id, secret });
            reload();
        } catch (error) {
            notifyError(error, { action: "create the endpoint" });
        } finally {
            setCreating(false);
        }
    };

    const patch = async (
        endpoint: CrmSyncEndpoint,
        change: Parameters<typeof updateCrmSyncEndpoint>[1],
    ) => {
        try {
            await updateCrmSyncEndpoint(endpoint.id, change);
            reload();
        } catch (error) {
            notifyError(error, { action: "update the endpoint" });
        }
    };

    const rotate = async (endpoint: CrmSyncEndpoint) => {
        try {
            const { secret } = await rotateCrmSyncSecret(endpoint.id);
            setRevealed({ endpointId: endpoint.id, secret });
        } catch (error) {
            notifyError(error, { action: "replace the secret" });
        }
    };

    const showEvents = async (endpoint: CrmSyncEndpoint) => {
        if (events?.id === endpoint.id) return setEvents(null);
        try {
            setEvents({ id: endpoint.id, rows: await listCrmSyncEvents(endpoint.id) });
        } catch (error) {
            notifyError(error, { action: "load recent activity" });
        }
    };

    return (
        <div className="flex h-full min-h-0 flex-col">
            <PageHeader
                breadcrumbs={[
                    { label: "Clients", onClick: () => router.push("/clients") },
                    { label: "Hubflo sync" },
                ]}
            >
                <h1 className={PAGE_HEADER_TITLE_CLASS}>Hubflo sync</h1>
            </PageHeader>
            <DashboardPage>
                <p className="text-sm text-gray-600">
                    Hubflo (or any system that can send a webhook) pushes clients and
                    matters here. Each push creates or updates records matched by their
                    Hubflo ids, so repeats are safe. Fields Hubflo sends overwrite what
                    is in Mike; fields it leaves out are untouched.
                </p>

                {loading ? (
                    <div className="animate-pulse space-y-3" aria-busy="true">
                        <div className="h-24 rounded-2xl bg-gray-100" />
                        <div className="h-24 rounded-2xl bg-gray-100" />
                    </div>
                ) : forbidden ? (
                    <p role="alert" className="text-sm text-gray-700">
                        Only organization admins can manage CRM sync.
                    </p>
                ) : (
                    <>
                        {revealed && (
                            <section
                                role="status"
                                className="rounded-2xl border border-amber-300 bg-amber-50 p-4"
                            >
                                <h2 className="font-serif text-lg text-gray-900">
                                    Copy this secret now
                                </h2>
                                <p className="mt-1 text-sm text-gray-700">
                                    It is shown once and cannot be recovered. Put it in
                                    Hubflo as the bearer token. If it is lost, replace it.
                                </p>
                                <p className="mt-2 break-all rounded bg-white px-2 py-1 font-mono text-xs text-gray-900">
                                    {revealed.secret}
                                </p>
                                <div className="mt-2 flex gap-2">
                                    <PillButtonUI
                                        tone="black"
                                        size="sm"
                                        onClick={() => void copy("secret", revealed.secret)}
                                    >
                                        {copied === "secret" ? "Copied" : "Copy secret"}
                                    </PillButtonUI>
                                    <PillButtonUI
                                        tone="white"
                                        size="sm"
                                        onClick={() => setRevealed(null)}
                                    >
                                        I have saved it
                                    </PillButtonUI>
                                </div>
                            </section>
                        )}

                        <DashboardSection title="Endpoints">
                            {endpoints.length === 0 && (
                                <p className="mb-3 text-sm text-gray-500">
                                    No endpoints yet. Create one, then give Hubflo its URL
                                    and secret.
                                </p>
                            )}
                            <ul className="flex flex-col divide-y divide-gray-100">
                                {endpoints.map((endpoint) => (
                                    <li key={endpoint.id} className="flex flex-col gap-2 py-3">
                                        <div className="flex flex-wrap items-baseline gap-x-4 gap-y-1">
                                            <span className="min-w-0 break-words text-sm font-medium text-gray-900">
                                                {endpoint.name}
                                            </span>
                                            <span className="text-xs text-gray-500">
                                                {endpoint.enabled ? "Receiving" : "Paused"}
                                            </span>
                                            <span className="text-xs text-gray-500">
                                                {endpoint.last_received_at
                                                    ? `Last push ${formatDate(endpoint.last_received_at)}`
                                                    : "Nothing received yet"}
                                            </span>
                                        </div>
                                        <p className="break-all text-xs text-gray-600">
                                            {webhookUrl(endpoint)}
                                        </p>
                                        {endpoint.org_id && (
                                            <p className="text-xs text-gray-500">
                                                New matters are{" "}
                                                {endpoint.matter_visibility === "organization"
                                                    ? "visible to the whole organization"
                                                    : "private to the person who created this endpoint"}
                                                .
                                            </p>
                                        )}
                                        <div className="flex flex-wrap gap-2">
                                            <PillButtonUI
                                                tone="white"
                                                size="sm"
                                                onClick={() =>
                                                    void copy(endpoint.id, webhookUrl(endpoint))
                                                }
                                            >
                                                {copied === endpoint.id ? "Copied" : "Copy URL"}
                                            </PillButtonUI>
                                            <PillButtonUI
                                                tone="white"
                                                size="sm"
                                                onClick={() =>
                                                    void patch(endpoint, { enabled: !endpoint.enabled })
                                                }
                                            >
                                                {endpoint.enabled ? "Pause" : "Resume"}
                                            </PillButtonUI>
                                            {endpoint.org_id && (
                                                <PillButtonUI
                                                    tone="white"
                                                    size="sm"
                                                    onClick={() =>
                                                        void patch(endpoint, {
                                                            matter_visibility:
                                                                endpoint.matter_visibility === "private"
                                                                    ? "organization"
                                                                    : "private",
                                                        })
                                                    }
                                                >
                                                    {endpoint.matter_visibility === "private"
                                                        ? "Make new matters organization-wide"
                                                        : "Make new matters private"}
                                                </PillButtonUI>
                                            )}
                                            <PillButtonUI
                                                tone="white"
                                                size="sm"
                                                onClick={() => void rotate(endpoint)}
                                            >
                                                Replace secret
                                            </PillButtonUI>
                                            <PillButtonUI
                                                tone="white"
                                                size="sm"
                                                aria-expanded={events?.id === endpoint.id}
                                                onClick={() => void showEvents(endpoint)}
                                            >
                                                Recent activity
                                            </PillButtonUI>
                                            <PillButtonUI
                                                tone="white"
                                                size="sm"
                                                onClick={() => setToDelete(endpoint)}
                                            >
                                                Delete
                                            </PillButtonUI>
                                        </div>
                                        {events?.id === endpoint.id && (
                                            <ul className="mt-1 flex flex-col gap-1 text-xs text-gray-600">
                                                {events.rows.length === 0 && <li>No activity yet.</li>}
                                                {events.rows.map((row) => (
                                                    <li
                                                        key={row.id}
                                                        className="flex flex-wrap gap-x-3 break-all"
                                                    >
                                                        <span>{formatDate(row.received_at)}</span>
                                                        <span>{row.event_type ?? "unknown"}</span>
                                                        <span>{row.external_id ?? "-"}</span>
                                                        <span
                                                            className={
                                                                row.outcome === "rejected"
                                                                    ? "font-medium text-red-700"
                                                                    : undefined
                                                            }
                                                        >
                                                            {row.outcome}
                                                            {row.error_code ? ` (${row.error_code})` : ""}
                                                        </span>
                                                    </li>
                                                ))}
                                            </ul>
                                        )}
                                    </li>
                                ))}
                            </ul>

                            <form
                                className="mt-4 flex flex-col gap-3 border-t border-gray-100 pt-4"
                                onSubmit={(e) => {
                                    e.preventDefault();
                                    void create();
                                }}
                            >
                                <input
                                    aria-label="Endpoint name"
                                    placeholder="Name (e.g. Hubflo production)"
                                    value={name}
                                    maxLength={200}
                                    onChange={(e) => setName(e.target.value)}
                                    className={cn(FORM_CONTROL_GLASS_CLASS, "h-10")}
                                />
                                {isOrg && (
                                    <SelectField
                                        label="Who can open matters Hubflo creates"
                                        value={visibility}
                                        onChange={setVisibility}
                                        options={[
                                            { value: "private", label: "Only the person creating this endpoint" },
                                            { value: "organization", label: "Everyone in the organization" },
                                        ]}
                                    />
                                )}
                                <div>
                                    <PillButtonUI
                                        type="submit"
                                        tone="black"
                                        loading={creating}
                                        disabled={!name.trim()}
                                    >
                                        Create endpoint
                                    </PillButtonUI>
                                </div>
                            </form>
                        </DashboardSection>

                        <DashboardSection title="What to send">
                            <p className="mb-2 text-sm text-gray-600">
                                Send up to 100 events per request. Clients are applied
                                before matters, so a matter can name a client from the same
                                request. Each event reports created, updated, unchanged,
                                stale (older than what Mike already has) or rejected, with
                                a reason.
                            </p>
                            <pre className="overflow-x-auto rounded-lg bg-gray-50 p-3 text-xs text-gray-800">
                                {EXAMPLE_PUSH}
                            </pre>
                        </DashboardSection>
                    </>
                )}
            </DashboardPage>

            <ConfirmPopup
                open={toDelete !== null}
                title="Delete this endpoint?"
                message="Its URL stops working. Clients and matters it already created stay."
                confirmLabel="Delete endpoint"
                confirmVariant="danger"
                onCancel={() => setToDelete(null)}
                onConfirm={async () => {
                    const endpoint = toDelete;
                    setToDelete(null);
                    if (!endpoint) return;
                    try {
                        await deleteCrmSyncEndpoint(endpoint.id);
                        if (revealed?.endpointId === endpoint.id) setRevealed(null);
                        reload();
                    } catch (error) {
                        notifyError(error, { action: "delete the endpoint" });
                    }
                }}
            />
        </div>
    );
}
