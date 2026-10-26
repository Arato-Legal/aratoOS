"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import {
    MikeApiError,
    getDriveSyncStatus,
    getMatterDashboard,
    pullDocumentFromDrive,
    saveDocumentToDrive,
} from "@/app/lib/mikeApi";
import { notifyError, userFacingApiError } from "@/app/lib/userFacingError";
import { PageHeader } from "@/app/components/shared/PageHeader";
import { ConfirmPopup } from "@/app/components/popups/ConfirmPopup";
import { PillButtonUI } from "@/shared/ui/PillButtonUI";
import { DocxView } from "@/app/components/shared/views/DocxView";
import type {
    DocxCloseGuard,
    DocxSaveState,
} from "@/app/components/shared/views/DocxRenderer.types";
import type { DriveSyncState, DriveSyncStatus } from "../shared/types";

const STATE_TEXT: Record<DriveSyncState, string> = {
    in_sync: "In sync with Google Drive",
    local_changes: "Edited in Mike, not yet saved to Google Drive",
    drive_changes: "Changed in Google Drive since the last sync",
    both_changed: "Changed in both Mike and Google Drive",
    unknown: "Google Drive status unavailable",
};

/**
 * One editing view for a Word file or Google Doc from a matter's Drive
 * workspace. The file is edited here as Word; "Save to Drive" writes it back
 * to the same Drive file and "Update from Drive" brings Drive's copy in as a
 * new version.
 */
export function MatterDocumentEditor({
    projectId,
    documentId,
}: {
    projectId: string;
    documentId: string;
}) {
    const router = useRouter();
    const [status, setStatus] = useState<DriveSyncStatus | null>(null);
    const [projectName, setProjectName] = useState<string | null>(null);
    const [canEdit, setCanEdit] = useState(false);
    const [saveState, setSaveState] = useState<DocxSaveState | null>(null);
    const [busy, setBusy] = useState<"save" | "pull" | null>(null);
    const [message, setMessage] = useState<string | null>(null);
    const [confirmOverwrite, setConfirmOverwrite] = useState(false);
    const [refetchKey, setRefetchKey] = useState(0);
    const guard = useRef<DocxCloseGuard | null>(null);

    const refreshStatus = useCallback(async () => {
        try {
            setStatus(await getDriveSyncStatus(documentId));
        } catch (error) {
            notifyError(error, {
                action: "check Google Drive",
                dedupeKey: `drive-sync-${documentId}`,
            });
        }
    }, [documentId]);

    useEffect(() => {
        let cancelled = false;
        getDriveSyncStatus(documentId)
            .then((s) => {
                if (!cancelled) setStatus(s);
            })
            .catch((error) => {
                if (!cancelled)
                    notifyError(error, {
                        action: "open the document",
                        dedupeKey: `drive-sync-${documentId}`,
                    });
            });
        getMatterDashboard(projectId)
            .then((d) => {
                if (cancelled) return;
                setProjectName(d.project.name);
                setCanEdit(d.project.access_role !== "viewer");
            })
            .catch(() => {});
        return () => {
            cancelled = true;
        };
    }, [documentId, projectId]);

    const onSaveStateChange = useCallback(
        (_id: string, state: DocxSaveState | null) => setSaveState(state),
        [],
    );
    const onCloseGuardReady = useCallback((g: DocxCloseGuard | null) => {
        guard.current = g;
    }, []);

    const save = async (overwrite = false) => {
        setBusy("save");
        setMessage(null);
        try {
            // Drive gets what is stored, so flush any pending autosave first.
            if (guard.current && !(await guard.current.prepareClose())) {
                setMessage("Your latest edits could not be saved in Mike yet. Try again.");
                return;
            }
            await saveDocumentToDrive(documentId, { overwrite });
            setMessage("Saved to Google Drive.");
            setConfirmOverwrite(false);
            await refreshStatus();
        } catch (error) {
            if (error instanceof MikeApiError && error.code === "google_drive_changed") {
                setConfirmOverwrite(true);
            } else {
                setMessage(
                    userFacingApiError(error, "Could not save to Google Drive. Please try again."),
                );
            }
        } finally {
            setBusy(null);
        }
    };

    const pull = async () => {
        setBusy("pull");
        setMessage(null);
        try {
            if (guard.current && !(await guard.current.prepareClose())) {
                setMessage("Your latest edits could not be saved in Mike yet. Try again.");
                return;
            }
            await pullDocumentFromDrive(documentId);
            setRefetchKey((n) => n + 1);
            setMessage("Updated from Google Drive. Your earlier version is in the version history.");
            await refreshStatus();
        } catch (error) {
            setMessage(
                userFacingApiError(error, "Could not update from Google Drive. Please try again."),
            );
        } finally {
            setBusy(null);
        }
    };

    const editorBusy = !saveState?.ready || saveState.status === "saving";
    const label = status?.kind === "gdoc" ? "Google Doc" : "Word file";

    return (
        <div className="flex h-full min-h-0 flex-col">
            <PageHeader
                breadcrumbs={[
                    { label: projectName ?? "Matter", onClick: () => router.push(`/matters/${projectId}`) },
                    { label: status?.drive_name ?? "Document", loading: !status },
                ]}
            />

            <div className="mx-3 flex flex-wrap items-center gap-x-4 gap-y-2 pb-2 md:mx-6.5">
                <p className="text-xs text-gray-600" role="status">
                    {status ? STATE_TEXT[status.state] : "Checking Google Drive…"}
                    {saveState?.status === "saving" && " · Saving in Mike…"}
                </p>
                <div className="ml-auto flex flex-wrap items-center gap-2">
                    {status?.web_view_link && (
                        <a
                            href={status.web_view_link}
                            target="_blank"
                            rel="noreferrer noopener"
                            className="rounded text-xs text-blue-700 hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-blue-500/40"
                        >
                            Open in Drive
                        </a>
                    )}
                    <PillButtonUI
                        tone="white"
                        size="sm"
                        loading={busy === "pull"}
                        disabled={busy !== null || editorBusy || !canEdit}
                        onClick={() => void pull()}
                    >
                        Update from Drive
                    </PillButtonUI>
                    <PillButtonUI
                        tone="black"
                        size="sm"
                        loading={busy === "save"}
                        disabled={busy !== null || editorBusy || !canEdit}
                        onClick={() => void save()}
                    >
                        Save to Drive
                    </PillButtonUI>
                </div>
                {status?.kind === "gdoc" && (
                    <p className="basis-full text-xs text-gray-500">
                        This {label} is edited here as Word. Saving rewrites it in Google
                        Drive from this version, so comments and suggestions in the Doc
                        may not carry over. Drive keeps its version history.
                    </p>
                )}
                {message && (
                    <p role="status" className="basis-full text-xs text-gray-700">
                        {message}
                    </p>
                )}
            </div>

            <div className="mx-3 mb-3 min-h-0 flex-1 md:mx-6.5">
                <DocxView
                    documentId={documentId}
                    canEdit={canEdit}
                    defaultMode="edit"
                    toolbarVisible
                    refetchKey={refetchKey}
                    cacheBytes={false}
                    onSaveStateChange={onSaveStateChange}
                    onCloseGuardReady={onCloseGuardReady}
                />
            </div>

            <ConfirmPopup
                open={confirmOverwrite}
                title="Overwrite the newer Google Drive version?"
                message="This file changed in Google Drive after Mike last synced it. Saving now replaces those changes. You can restore them from the file's version history in Drive, or choose Update from Drive instead."
                confirmLabel="Overwrite in Drive"
                confirmVariant="danger"
                onCancel={() => setConfirmOverwrite(false)}
                onConfirm={() => void save(true)}
            />
        </div>
    );
}
