"use client";

import { useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import { getMatterDashboard } from "@/app/lib/mikeApi";
import { notifyError } from "@/app/lib/userFacingError";
import { PageHeader } from "@/app/components/shared/PageHeader";
import { PillButtonUI } from "@/shared/ui/PillButtonUI";
import type { MatterDashboard as MatterDashboardData } from "../shared/types";
import {
    DashboardPage,
    DashboardSection,
    DashboardSkeleton,
    STATUS_LABELS,
    formatDate,
} from "./DashboardPrimitives";

function Fact({ label, value }: { label: string; value: string | null }) {
    if (!value) return null;
    return (
        <div className="min-w-0">
            <dt className="text-xs font-medium text-gray-500">{label}</dt>
            <dd className="break-words text-sm text-gray-900">{value}</dd>
        </div>
    );
}

export function MatterDashboard({ projectId }: { projectId: string }) {
    const router = useRouter();
    const [data, setData] = useState<MatterDashboardData | null>(null);
    const [loading, setLoading] = useState(true);
    const [attempt, setAttempt] = useState(0);

    useEffect(() => {
        let cancelled = false;
        getMatterDashboard(projectId)
            .then((d) => {
                if (!cancelled) setData(d);
            })
            .catch((error) => {
                if (cancelled) return;
                notifyError(error, {
                    action: "load the matter",
                    dedupeKey: `matter-${projectId}`,
                    onRetry: () => setAttempt((n) => n + 1),
                });
            })
            .finally(() => {
                if (!cancelled) setLoading(false);
            });
        return () => {
            cancelled = true;
        };
    }, [projectId, attempt]);

    if (loading && !data) return <DashboardSkeleton />;
    if (!data) {
        return (
            <div className="flex h-full min-h-0 flex-col">
                <PageHeader
                    breadcrumbs={[
                        { label: "Projects", onClick: () => router.push("/projects") },
                        { label: "Not found" },
                    ]}
                />
            </div>
        );
    }

    const { project, client } = data;
    return (
        <div className="flex h-full min-h-0 flex-col">
            <PageHeader
                breadcrumbs={[
                    ...(client
                        ? [
                              { label: "Clients", onClick: () => router.push("/clients") },
                              {
                                  label: client.name,
                                  onClick: () => router.push(`/clients/${client.id}`),
                              },
                          ]
                        : [{ label: "Projects", onClick: () => router.push("/projects") }]),
                    { label: project.name },
                ]}
            />
            <DashboardPage>
                <div>
                    <h1 className="break-words font-serif text-3xl text-gray-900">
                        {project.name}
                    </h1>
                    <p className="mt-1 text-xs text-gray-500">
                        Updated {formatDate(project.updated_at)}
                    </p>
                </div>

                <DashboardSection title="Overview">
                    <dl className="grid grid-cols-1 gap-4 sm:grid-cols-3">
                        <Fact label="Matter number" value={project.cm_number} />
                        <Fact label="Practice" value={project.practice} />
                        <Fact
                            label="Client"
                            value={client ? client.name : "Not assigned"}
                        />
                    </dl>
                </DashboardSection>

                <DashboardSection title="Work in Mike">
                    <div className="flex flex-wrap gap-2">
                        <PillButtonUI
                            tone="white"
                            onClick={() => router.push(`/projects/${project.id}`)}
                        >
                            Documents
                        </PillButtonUI>
                        <PillButtonUI
                            tone="white"
                            onClick={() =>
                                router.push(`/projects/${project.id}/assistant`)
                            }
                        >
                            Assistant chats
                        </PillButtonUI>
                        <PillButtonUI
                            tone="white"
                            onClick={() =>
                                router.push(`/projects/${project.id}/tabular-reviews`)
                            }
                        >
                            Tabular reviews
                        </PillButtonUI>
                    </div>
                </DashboardSection>

                {client && (
                    <DashboardSection title="Client">
                        <div className="flex flex-col gap-3">
                            <dl className="grid grid-cols-1 gap-4 sm:grid-cols-3">
                                <Fact label="Status" value={STATUS_LABELS[client.status]} />
                                <Fact label="Email" value={client.email} />
                                <Fact label="Phone" value={client.phone} />
                            </dl>
                            {client.contacts.length > 0 && (
                                <ul className="flex flex-col divide-y divide-gray-100">
                                    {client.contacts.map((c) => (
                                        <li
                                            key={c.id}
                                            className="flex flex-wrap gap-x-6 gap-y-1 py-2 text-sm"
                                        >
                                            <span className="min-w-0 break-words font-medium text-gray-900">
                                                {c.name}
                                                {c.role ? ` · ${c.role}` : ""}
                                            </span>
                                            {c.email && (
                                                <span className="break-all text-xs text-gray-600">
                                                    {c.email}
                                                </span>
                                            )}
                                            {c.phone && (
                                                <span className="text-xs text-gray-600">
                                                    {c.phone}
                                                </span>
                                            )}
                                        </li>
                                    ))}
                                </ul>
                            )}
                            <div>
                                <PillButtonUI
                                    tone="white"
                                    size="sm"
                                    onClick={() => router.push(`/clients/${client.id}`)}
                                >
                                    Open client page
                                </PillButtonUI>
                            </div>
                        </div>
                    </DashboardSection>
                )}
            </DashboardPage>
        </div>
    );
}
