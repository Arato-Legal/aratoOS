"use client";

import { useCallback, useEffect, useState } from "react";
import { getMatterWorkspace, setMatterDriveFolder } from "@/app/lib/mikeApi";
import { notifyError } from "@/app/lib/userFacingError";
import { PillButtonUI } from "@/shared/ui/PillButtonUI";
import type { DriveFileKind, MatterWorkspace } from "../shared/types";
import { DriveFolderPicker } from "./DriveFolderPicker";
import { DashboardSection, formatDate } from "./DashboardPrimitives";

const KIND_LABEL: Record<DriveFileKind, string> = {
    docx: "Word",
    gdoc: "Google Doc",
    folder: "Folder",
    other: "File",
};

/** The matter's "Work in progress" folder in Google Drive. */
export function MatterWorkspaceSection({
    projectId,
    orgId,
    canEdit,
}: {
    projectId: string;
    orgId: string | null;
    canEdit: boolean;
}) {
    const [data, setData] = useState<MatterWorkspace | null>(null);
    const [attempt, setAttempt] = useState(0);
    const [picking, setPicking] = useState(false);
    const reload = useCallback(() => setAttempt((n) => n + 1), []);

    useEffect(() => {
        let cancelled = false;
        getMatterWorkspace(projectId)
            .then((d) => {
                if (!cancelled) setData(d);
            })
            .catch((error) => {
                if (cancelled) return;
                notifyError(error, {
                    action: "load the matter's Drive folder",
                    dedupeKey: `matter-workspace-${projectId}`,
                    onRetry: reload,
                });
            });
        return () => {
            cancelled = true;
        };
    }, [projectId, attempt, reload]);

    const link = async (folderId: string | null) => {
        try {
            setData(await setMatterDriveFolder(projectId, folderId));
        } catch (error) {
            notifyError(error, { action: "link the Drive folder" });
        }
    };

    const action = canEdit && data && (
        <div className="flex gap-2">
            <PillButtonUI tone="white" size="sm" onClick={() => setPicking(true)}>
                {data.linked ? "Change folder" : "Link Drive folder"}
            </PillButtonUI>
            {data.linked && (
                <PillButtonUI tone="white" size="sm" onClick={() => void link(null)}>
                    Unlink
                </PillButtonUI>
            )}
        </div>
    );

    return (
        <DashboardSection title="Work in progress" action={action || undefined}>
            {!data ? (
                <div className="animate-pulse space-y-2" aria-busy="true">
                    <div className="h-6 w-1/3 rounded bg-gray-100" />
                    <div className="h-6 rounded bg-gray-100" />
                </div>
            ) : !data.linked ? (
                <p className="text-sm text-gray-500">
                    Link this matter&apos;s Google Drive folder to see its
                    &ldquo;Work in progress&rdquo; drafts and research here.
                </p>
            ) : data.drive_error ? (
                <p role="alert" className="text-sm text-gray-700">
                    {data.drive_error.message}
                </p>
            ) : !data.wip ? (
                <p className="text-sm text-gray-500">
                    No &ldquo;Work in progress&rdquo; folder was found inside{" "}
                    <span className="font-medium">{data.folder?.name}</span>.
                </p>
            ) : data.files.length === 0 ? (
                <p className="text-sm text-gray-500">Nothing in this folder yet.</p>
            ) : (
                <ul className="flex flex-col divide-y divide-gray-100">
                    {data.files.map((file) => (
                        <li key={file.id} className="flex flex-wrap items-baseline gap-x-4 gap-y-1 py-2">
                            <span className="min-w-0 break-words text-sm font-medium text-gray-900">
                                {file.name}
                            </span>
                            <span className="text-xs text-gray-500">{KIND_LABEL[file.kind]}</span>
                            {file.modified_time && (
                                <span className="text-xs text-gray-400">
                                    Edited {formatDate(file.modified_time)}
                                </span>
                            )}
                            {file.web_view_link && (
                                <a
                                    href={file.web_view_link}
                                    target="_blank"
                                    rel="noreferrer noopener"
                                    className="ml-auto rounded text-xs text-blue-700 hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-blue-500/40"
                                >
                                    Open in Drive
                                </a>
                            )}
                        </li>
                    ))}
                </ul>
            )}
            <DriveFolderPicker
                open={picking}
                workspace={orgId ?? "personal"}
                onClose={() => setPicking(false)}
                onPick={(folder) => void link(folder.id)}
            />
        </DashboardSection>
    );
}
