"use client";

import { useEffect, useState } from "react";
import { getClientFiles, setMatterSharing } from "@/app/lib/mikeApi";
import { notifyError } from "@/app/lib/userFacingError";
import { formatDate, DashboardSection } from "./DashboardPrimitives";
import type { ClientFiles } from "../shared/types";

const TASK_LABELS: Record<string, string> = {
    open: "Open",
    in_progress: "In progress",
    done: "Done",
    cancelled: "Cancelled",
};

/** Whether this matter's data is readable by the client's other matters. */
export function MatterSharingToggle({
    projectId,
    shared,
    canManage,
    onChange,
}: {
    projectId: string;
    shared: boolean;
    canManage: boolean;
    onChange: (shared: boolean) => void;
}) {
    const [busy, setBusy] = useState(false);

    const toggle = async (next: boolean) => {
        setBusy(true);
        try {
            const result = await setMatterSharing(projectId, next);
            onChange(result.share_with_client);
        } catch (error) {
            notifyError(error, { action: "change client sharing" });
        } finally {
            setBusy(false);
        }
    };

    return (
        <DashboardSection title="Share with client's other matters">
            <label className="flex items-start gap-3 text-sm text-gray-800">
                <input
                    type="checkbox"
                    role="switch"
                    className="mt-1 h-4 w-4 rounded focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-blue-500/40"
                    checked={shared}
                    disabled={!canManage || busy}
                    onChange={(e) => void toggle(e.target.checked)}
                />
                <span className="min-w-0">
                    <span className="font-medium">
                        {shared ? "Shared" : "Not shared"}
                    </span>
                    <span className="block text-xs text-gray-500">
                        When on, this client&apos;s other matters can read this
                        matter&apos;s documents, chats, tasks and tabular reviews
                        (read-only), and Mike can use its documents when answering. Its chats
                        also teach the client's memory. Turning this off stops that and
                        deletes what this matter taught it.
                        {!canManage && " Only a matter owner can change this."}
                    </span>
                </span>
            </label>
        </DashboardSection>
    );
}

/** Read-only data that the client's other matters share with this one. */
export function ClientFilesSection({
    projectId,
    refreshKey,
}: {
    projectId: string;
    refreshKey?: unknown;
}) {
    const [data, setData] = useState<ClientFiles | null>(null);

    useEffect(() => {
        let cancelled = false;
        getClientFiles(projectId)
            .then((d) => {
                if (!cancelled) setData(d);
            })
            .catch((error) => {
                if (cancelled) return;
                notifyError(error, {
                    action: "load the client's shared files",
                    dedupeKey: `client-files-${projectId}`,
                });
            });
        return () => {
            cancelled = true;
        };
    }, [projectId, refreshKey]);

    return (
        <DashboardSection title="Client files">
            {!data ? (
                <div className="animate-pulse space-y-2" aria-busy="true">
                    <div className="h-6 w-1/3 rounded bg-gray-100" />
                    <div className="h-6 rounded bg-gray-100" />
                </div>
            ) : data.matters.length === 0 ? (
                <p className="text-sm text-gray-500">
                    No other matter of this client is sharing its data.
                </p>
            ) : (
                <div className="flex flex-col gap-4">
                    <p className="text-xs text-gray-500">
                        Shared by the client&apos;s other matters. Read-only here.
                    </p>
                    {data.matters.map((matter) => (
                        <div key={matter.id} className="flex flex-col gap-1">
                            <h3 className="break-words text-sm font-medium text-gray-900">
                                {matter.name}
                            </h3>
                            {matter.documents.length +
                                matter.chats.length +
                                matter.tasks.length +
                                matter.reviews.length ===
                            0 ? (
                                <p className="text-xs text-gray-500">Nothing yet.</p>
                            ) : (
                                <ul className="flex flex-col divide-y divide-gray-100">
                                    {matter.documents.map((d) => (
                                        <Row
                                            key={`d-${d.id}`}
                                            kind="Document"
                                            label={d.filename}
                                            meta={`Edited ${formatDate(d.updated_at)}`}
                                        />
                                    ))}
                                    {matter.chats.map((c) => (
                                        <Row
                                            key={`c-${c.id}`}
                                            kind="Chat"
                                            label={c.title || "Untitled chat"}
                                            meta={formatDate(c.updated_at)}
                                        />
                                    ))}
                                    {matter.reviews.map((r) => (
                                        <Row
                                            key={`r-${r.id}`}
                                            kind="Tabular review"
                                            label={r.title || "Untitled review"}
                                            meta={formatDate(r.updated_at)}
                                        />
                                    ))}
                                    {matter.tasks.map((t) => (
                                        <Row
                                            key={`t-${t.id}`}
                                            kind="Task"
                                            label={t.title}
                                            meta={TASK_LABELS[t.status] ?? t.status}
                                        />
                                    ))}
                                </ul>
                            )}
                        </div>
                    ))}
                </div>
            )}
        </DashboardSection>
    );
}

function Row({ kind, label, meta }: { kind: string; label: string; meta: string }) {
    return (
        <li className="flex flex-wrap items-baseline gap-x-4 gap-y-1 py-1.5">
            <span className="min-w-0 break-words text-sm text-gray-900">{label}</span>
            <span className="text-xs text-gray-500">{kind}</span>
            <span className="flex-1" />
            <span className="text-xs text-gray-400">{meta}</span>
        </li>
    );
}
