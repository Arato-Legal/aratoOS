"use client";

import { useEffect, useState } from "react";
import {
    MikeApiError,
    getClientMemory,
    saveClientMemory,
    setClientMemoryEnabled,
} from "@/app/lib/mikeApi";
import { notifyError } from "@/app/lib/userFacingError";
import { ConfirmPopup } from "@/app/components/popups/ConfirmPopup";
import { PillButtonUI } from "@/shared/ui/PillButtonUI";
import { FORM_CONTROL_GLASS_CLASS } from "@/app/components/ui/form-field";
import { cn } from "@/app/lib/utils";
import type { ClientMemory } from "../shared/types";
import { DashboardSection } from "./DashboardPrimitives";

/**
 * The client's memory.md. Every conversation of this client reads it, at the
 * client level and in each of its matters; client chats, and matter chats
 * whose matter shares with the client, teach it. Anyone who can open the client
 * reads it; its creator or an organization admin edits it.
 */
export function ClientMemorySection({ clientId }: { clientId: string }) {
    const [memory, setMemory] = useState<ClientMemory | null>(null);
    const [draft, setDraft] = useState("");
    const [saving, setSaving] = useState(false);
    const [confirmOff, setConfirmOff] = useState(false);

    const apply = (next: ClientMemory) => {
        setMemory(next);
        setDraft(next.content);
    };

    useEffect(() => {
        let cancelled = false;
        getClientMemory(clientId)
            .then((m) => {
                if (!cancelled) apply(m);
            })
            .catch((error) => {
                if (!cancelled)
                    notifyError(error, {
                        action: "load the client's memory",
                        dedupeKey: `client-memory-${clientId}`,
                    });
            });
        return () => {
            cancelled = true;
        };
    }, [clientId]);

    if (!memory) return null;
    const dirty = draft !== memory.content;

    const save = async () => {
        setSaving(true);
        try {
            apply(await saveClientMemory(clientId, draft, memory.revision));
        } catch (error) {
            if (error instanceof MikeApiError && error.code === "memory_revision_conflict") {
                // Learned from a chat since this page loaded: show what is saved now.
                try {
                    apply(await getClientMemory(clientId));
                } catch {
                    /* the notification below still tells them */
                }
            }
            notifyError(error, { action: "save the client's memory" });
        } finally {
            setSaving(false);
        }
    };

    const toggle = async (enabled: boolean) => {
        setSaving(true);
        try {
            apply(await setClientMemoryEnabled(clientId, enabled));
        } catch (error) {
            notifyError(error, { action: "change the client's memory" });
        } finally {
            setSaving(false);
            setConfirmOff(false);
        }
    };

    return (
        <DashboardSection
            title="Memory"
            action={
                memory.can_edit ? (
                    <PillButtonUI
                        tone="white"
                        size="sm"
                        loading={saving && !dirty}
                        onClick={() => (memory.enabled ? setConfirmOff(true) : void toggle(true))}
                    >
                        {memory.enabled ? "Turn off" : "Turn on"}
                    </PillButtonUI>
                ) : undefined
            }
        >
            <p className="mb-2 text-xs text-gray-500">
                {memory.enabled
                    ? "Applies to every conversation about this client, including in each of its matters. It learns from client chats and from matter chats whose matter shares with the client. Anyone who can open this client can read it."
                    : "Client memory is off. Nothing is learned or used."}
            </p>
            {memory.enabled && (
                <>
                    <label className="sr-only" htmlFor={`client-memory-${clientId}`}>
                        Client memory
                    </label>
                    <textarea
                        id={`client-memory-${clientId}`}
                        value={draft}
                        readOnly={!memory.can_edit}
                        onChange={(e) => setDraft(e.target.value)}
                        rows={8}
                        placeholder={
                            memory.can_edit
                                ? "Nothing remembered yet. It fills in as client chats finish, or write notes here."
                                : "Nothing remembered yet."
                        }
                        className={cn(
                            FORM_CONTROL_GLASS_CLASS,
                            "w-full resize-y font-mono text-xs leading-5 text-gray-900",
                        )}
                    />
                    {memory.can_edit ? (
                        <div className="mt-2 flex items-center gap-3">
                            <PillButtonUI
                                tone="black"
                                size="sm"
                                disabled={!dirty}
                                loading={saving && dirty}
                                onClick={() => void save()}
                            >
                                Save memory
                            </PillButtonUI>
                            {dirty && (
                                <PillButtonUI
                                    tone="white"
                                    size="sm"
                                    onClick={() => setDraft(memory.content)}
                                >
                                    Discard changes
                                </PillButtonUI>
                            )}
                        </div>
                    ) : (
                        <p className="mt-2 text-xs text-gray-500">
                            Only the client&apos;s creator or an organization admin can edit this.
                        </p>
                    )}
                </>
            )}
            <ConfirmPopup
                open={confirmOff}
                title="Turn off client memory?"
                message="What has been learned about this client is deleted, and nothing new is learned."
                confirmLabel="Turn off"
                confirmVariant="danger"
                confirmStatus={saving ? "loading" : "idle"}
                onConfirm={() => void toggle(false)}
                onCancel={() => setConfirmOff(false)}
            />
        </DashboardSection>
    );
}
