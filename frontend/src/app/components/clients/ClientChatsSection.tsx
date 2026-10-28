"use client";

import { useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import { listClientChats } from "@/app/lib/mikeApi";
import { notifyError } from "@/app/lib/userFacingError";
import { PillButtonUI } from "@/shared/ui/PillButtonUI";
import { DashboardSection, formatDate } from "./DashboardPrimitives";

type ClientChat = { id: string; title: string | null; updated_at: string };

/** Assistant sessions run at the client's level, and a way to start one. */
export function ClientChatsSection({ clientId }: { clientId: string }) {
    const router = useRouter();
    const [chats, setChats] = useState<ClientChat[] | null>(null);

    useEffect(() => {
        let cancelled = false;
        listClientChats(clientId)
            .then((rows) => {
                if (!cancelled) setChats(rows);
            })
            .catch((error) => {
                if (cancelled) return;
                setChats([]);
                notifyError(error, {
                    action: "load the client's assistant chats",
                    dedupeKey: `client-chats-${clientId}`,
                });
            });
        return () => {
            cancelled = true;
        };
    }, [clientId]);

    return (
        <DashboardSection
            title="Assistant"
            action={
                <PillButtonUI
                    tone="black"
                    size="sm"
                    onClick={() => router.push(`/clients/${clientId}/assistant`)}
                >
                    New client chat
                </PillButtonUI>
            }
        >
            <p className="mb-2 text-xs text-gray-500">
                A client chat reads the documents and notes of this client&apos;s
                matters that share with the client and that you can open. Pick
                Workflow, Playbook, Tabular review or Library search in the
                composer to start a session for it.
            </p>
            {chats === null ? (
                <div className="animate-pulse space-y-2" aria-busy="true">
                    <div className="h-6 w-1/3 rounded bg-gray-100" />
                </div>
            ) : chats.length === 0 ? (
                <p className="text-sm text-gray-500">No client chats yet.</p>
            ) : (
                <ul className="flex flex-col divide-y divide-gray-100">
                    {chats.map((chat) => (
                        <li key={chat.id}>
                            <button
                                type="button"
                                onClick={() =>
                                    router.push(
                                        `/clients/${clientId}/assistant/chat/${chat.id}`,
                                    )
                                }
                                className="flex w-full flex-wrap items-baseline gap-x-4 gap-y-1 rounded py-2 text-left focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-blue-500/40"
                            >
                                <span className="min-w-0 break-words text-sm font-medium text-gray-900">
                                    {chat.title || "Untitled chat"}
                                </span>
                                <span className="ml-auto text-xs text-gray-400">
                                    {formatDate(chat.updated_at)}
                                </span>
                            </button>
                        </li>
                    ))}
                </ul>
            )}
        </DashboardSection>
    );
}
