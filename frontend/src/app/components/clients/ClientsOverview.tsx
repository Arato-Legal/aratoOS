"use client";

import { useCallback, useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import { Users } from "lucide-react";
import { listClients } from "@/app/lib/mikeApi";
import { notifyError } from "@/app/lib/userFacingError";
import { useAuth } from "@/app/contexts/AuthContext";
import { useWorkspaceParam } from "@/app/contexts/WorkspaceContext";
import { useDebouncedValue } from "@/app/hooks/useDebouncedValue";
import { PageHeader } from "@/app/components/shared/PageHeader";
import { PAGE_HEADER_TITLE_CLASS } from "@/app/components/shared/pageHeaderStyles";
import { EmptyState } from "@/app/components/ui/empty-state";
import { PillButtonUI } from "@/shared/ui/PillButtonUI";
import { cn } from "@/app/lib/utils";
import { LIQUID_GLASS_HOVER_CLASS } from "@/app/components/ui/liquid-surface";
import type { Client } from "../shared/types";
import { NewClientModal } from "./NewClientModal";
import {
    DashboardPage,
    STATUS_LABELS,
    formatDate,
} from "./DashboardPrimitives";

export function ClientsOverview() {
    const router = useRouter();
    const { isAuthenticated, authLoading } = useAuth();
    const workspace = useWorkspaceParam();
    const [clients, setClients] = useState<Client[]>([]);
    const [loading, setLoading] = useState(true);
    const [search, setSearch] = useState("");
    const [modalOpen, setModalOpen] = useState(false);
    const [attempt, setAttempt] = useState(0);
    const q = useDebouncedValue(search.trim(), 250);

    const retry = useCallback(() => setAttempt((n) => n + 1), []);

    useEffect(() => {
        if (authLoading || !isAuthenticated) return;
        const controller = new AbortController();
        listClients({ workspace, q: q || undefined })
            .then((rows) => {
                if (!controller.signal.aborted) setClients(rows);
            })
            .catch((error) => {
                if (controller.signal.aborted) return;
                notifyError(error, {
                    action: "load clients",
                    dedupeKey: "clients-list",
                    onRetry: retry,
                });
            })
            .finally(() => {
                if (!controller.signal.aborted) setLoading(false);
            });
        return () => controller.abort();
    }, [authLoading, isAuthenticated, workspace, q, attempt, retry]);

    return (
        <div className="flex h-full min-h-0 flex-col">
            <PageHeader
                loading={loading}
                actions={[
                    {
                        type: "search",
                        value: search,
                        onChange: setSearch,
                        placeholder: "Search clients…",
                    },
                    {
                        label: "Hubflo sync",
                        title: "Receive clients and matters from Hubflo",
                        onClick: () => router.push("/clients/sync"),
                    },
                    {
                        type: "new",
                        onClick: () => setModalOpen(true),
                        title: "New client",
                    },
                ]}
            >
                <h1 className={PAGE_HEADER_TITLE_CLASS}>Clients</h1>
            </PageHeader>

            <DashboardPage>
                {loading ? (
                    <div className="animate-pulse space-y-2" aria-busy="true">
                        {[0, 1, 2, 3].map((i) => (
                            <div key={i} className="h-14 rounded-xl bg-gray-100" />
                        ))}
                    </div>
                ) : clients.length === 0 ? (
                    <EmptyState
                        icon={<Users />}
                        title={q ? "No matching clients" : "No clients yet"}
                        description={
                            q
                                ? "Try a different search."
                                : "Add a client to keep its contacts, matters and notes on one page."
                        }
                        action={
                            q ? undefined : (
                                <PillButtonUI
                                    tone="black"
                                    onClick={() => setModalOpen(true)}
                                >
                                    New client
                                </PillButtonUI>
                            )
                        }
                    />
                ) : (
                    <ul className="flex flex-col gap-1">
                        {clients.map((client) => (
                            <li key={client.id}>
                                <button
                                    type="button"
                                    onClick={() => router.push(`/clients/${client.id}`)}
                                    className={cn(
                                        "flex w-full flex-wrap items-baseline gap-x-4 gap-y-1 rounded-xl px-3 py-3 text-left transition-colors",
                                        LIQUID_GLASS_HOVER_CLASS,
                                        "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-blue-500/40",
                                    )}
                                >
                                    <span className="min-w-0 break-words text-sm font-medium text-gray-900">
                                        {client.name}
                                    </span>
                                    <span className="text-xs text-gray-500">
                                        {STATUS_LABELS[client.status]}
                                    </span>
                                    {client.email && (
                                        <span className="min-w-0 break-all text-xs text-gray-500">
                                            {client.email}
                                        </span>
                                    )}
                                    <span className="ml-auto text-xs text-gray-400">
                                        Updated {formatDate(client.updated_at)}
                                    </span>
                                </button>
                            </li>
                        ))}
                    </ul>
                )}
            </DashboardPage>

            <NewClientModal
                open={modalOpen}
                onClose={() => setModalOpen(false)}
                onCreated={(client) => {
                    setModalOpen(false);
                    router.push(`/clients/${client.id}`);
                }}
            />
        </div>
    );
}
