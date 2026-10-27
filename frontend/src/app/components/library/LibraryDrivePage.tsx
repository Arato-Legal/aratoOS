"use client";

import { useCallback, useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import { ChevronLeft, Folder } from "lucide-react";
import {
    getLibraryDriveSettings,
    listLibraryDriveFiles,
    setLibraryDriveFolder,
    type LibraryDriveKind,
    type LibraryDriveListing,
    type LibraryDriveSettings,
} from "@/app/lib/mikeApi";
import { notifyError } from "@/app/lib/userFacingError";
import { useWorkspaceParam } from "@/app/contexts/WorkspaceContext";
import { PageHeader } from "@/app/components/shared/PageHeader";
import { TableToolbar } from "@/app/components/shared/TableToolbar";
import { PillButtonUI } from "@/shared/ui/PillButtonUI";
import { TabPillButtonUI } from "@/shared/ui/TabPillButtonUI";
import { DriveFolderPicker } from "@/app/components/clients/DriveFolderPicker";
import { formatDate } from "@/app/components/clients/DashboardPrimitives";
import type { DriveFileKind } from "@/app/components/shared/types";
import { LIBRARY_TABS, LIBRARY_TAB_PATHS } from "./LibraryWorkspace";

const COPY: Record<
    LibraryDriveKind,
    { tab: "drive-matters" | "drive-precedents"; title: string; empty: string; pick: string }
> = {
    matters: {
        tab: "drive-matters",
        title: "Drive matters",
        empty: "Choose the Google Drive folder that holds your matter folders to browse them here.",
        pick: "Choose the matters folder",
    },
    precedents: {
        tab: "drive-precedents",
        title: "Drive precedents",
        empty: "Choose the Google Drive folder that holds your precedents and research to browse it here.",
        pick: "Choose the precedents folder",
    },
};

const KIND_LABEL: Record<DriveFileKind, string> = {
    docx: "Word",
    gdoc: "Google Doc",
    folder: "Folder",
    other: "File",
};

type Crumb = { id: string; name: string };

/** A Google Drive folder browsed as a Library tab. */
export function LibraryDrivePage({ kind }: { kind: LibraryDriveKind }) {
    const copy = COPY[kind];
    const router = useRouter();
    const workspace = useWorkspaceParam();
    const [settings, setSettings] = useState<LibraryDriveSettings | null>(null);
    const [listing, setListing] = useState<LibraryDriveListing | null>(null);
    const [trail, setTrail] = useState<Crumb[]>([]);
    const [picking, setPicking] = useState(false);
    const [attempt, setAttempt] = useState(0);
    const reload = useCallback(() => setAttempt((n) => n + 1), []);
    const current = trail[trail.length - 1];
    const root = settings?.[kind] ?? null;

    useEffect(() => {
        let cancelled = false;
        getLibraryDriveSettings(workspace)
            .then((next) => {
                if (!cancelled) setSettings(next);
            })
            .catch((error) => {
                if (cancelled) return;
                notifyError(error, {
                    action: "load the Drive folders",
                    dedupeKey: `library-drive-settings-${kind}`,
                    onRetry: reload,
                });
            });
        return () => {
            cancelled = true;
        };
    }, [workspace, kind, attempt, reload]);

    useEffect(() => {
        if (!root) return;
        let cancelled = false;
        listLibraryDriveFiles(kind, { folder: current?.id, workspace })
            .then((next) => {
                if (!cancelled) setListing(next);
            })
            .catch((error) => {
                if (cancelled) return;
                notifyError(error, {
                    action: "list the Drive folder",
                    dedupeKey: `library-drive-${kind}`,
                    onRetry: reload,
                });
            });
        return () => {
            cancelled = true;
        };
    }, [root, kind, current?.id, workspace, attempt, reload]);

    const choose = async (folderId: string | null) => {
        try {
            setListing(null);
            setTrail([]);
            setSettings(await setLibraryDriveFolder(kind, folderId, workspace));
        } catch (error) {
            notifyError(error, { action: "save the Drive folder" });
        }
    };

    const loading = !!root && listing === null;
    const configure = settings?.can_configure && (
        <div className="flex gap-2">
            <PillButtonUI tone="white" size="sm" onClick={() => setPicking(true)}>
                {root ? "Change folder" : copy.pick}
            </PillButtonUI>
            {root && (
                <PillButtonUI tone="white" size="sm" onClick={() => void choose(null)}>
                    Clear
                </PillButtonUI>
            )}
        </div>
    );

    return (
        <div className="flex h-full min-h-0 flex-col">
            <PageHeader
                breadcrumbs={[
                    { label: "Library", onClick: () => router.push("/library") },
                    { label: copy.title, onClick: () => setTrail([]) },
                    ...trail.map((crumb, index) => ({
                        label: crumb.name,
                        onClick: () => setTrail(trail.slice(0, index + 1)),
                    })),
                ]}
                actionGroups={configure ? [{ actions: [{ type: "custom", render: configure }] }] : []}
            />
            <div className="flex h-full min-h-0 flex-1 flex-col overflow-hidden">
                <TableToolbar
                    items={trail.length > 0 ? [] : LIBRARY_TABS}
                    active={copy.tab}
                    onChange={(next) => router.push(LIBRARY_TAB_PATHS[next])}
                    leading={
                        trail.length > 0 ? (
                            <TabPillButtonUI
                                onClick={() => setTrail(trail.slice(0, -1))}
                                className="pl-2"
                            >
                                <ChevronLeft className="h-3.5 w-3.5" />
                                Back
                            </TabPillButtonUI>
                        ) : undefined
                    }
                />
                <div className="min-h-0 flex-1 overflow-y-auto px-4 py-2">
                    {!settings ? (
                        <div className="animate-pulse space-y-2" aria-busy="true">
                            <div className="h-6 w-1/3 rounded bg-gray-100" />
                            <div className="h-6 rounded bg-gray-100" />
                        </div>
                    ) : !root ? (
                        <p className="text-sm text-gray-500">
                            {settings.can_configure
                                ? copy.empty
                                : "A workspace admin has not chosen this Drive folder yet."}
                        </p>
                    ) : listing?.drive_error ? (
                        <p role="alert" className="text-sm text-gray-700">
                            {listing.drive_error.message}
                        </p>
                    ) : loading ? (
                        <div className="animate-pulse space-y-2" aria-busy="true">
                            <div className="h-6 w-1/3 rounded bg-gray-100" />
                            <div className="h-6 rounded bg-gray-100" />
                        </div>
                    ) : listing && listing.files.length === 0 ? (
                        <p className="text-sm text-gray-500">Nothing in this folder yet.</p>
                    ) : (
                        <ul className="flex flex-col divide-y divide-gray-100">
                            {listing?.files.map((file) => (
                                <li
                                    key={file.id}
                                    className="flex flex-wrap items-baseline gap-x-4 gap-y-1 py-2"
                                >
                                    {file.kind === "folder" ? (
                                        <button
                                            type="button"
                                            onClick={() => {
                                                setListing(null);
                                                setTrail([...trail, { id: file.id, name: file.name }]);
                                            }}
                                            className="flex min-w-0 items-center gap-2 break-words rounded text-left text-sm font-medium text-gray-900 hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-blue-500/40"
                                        >
                                            <Folder className="h-4 w-4 shrink-0" aria-hidden="true" />
                                            {file.name}
                                        </button>
                                    ) : (
                                        <span className="min-w-0 break-words text-sm font-medium text-gray-900">
                                            {file.name}
                                        </span>
                                    )}
                                    <span className="text-xs text-gray-500">{KIND_LABEL[file.kind]}</span>
                                    <span className="flex-1" />
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
                                            className="rounded text-xs text-blue-700 hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-blue-500/40"
                                        >
                                            Open in Drive
                                        </a>
                                    )}
                                </li>
                            ))}
                        </ul>
                    )}
                </div>
            </div>
            <DriveFolderPicker
                open={picking}
                workspace={workspace ?? "personal"}
                title={copy.pick}
                onClose={() => setPicking(false)}
                onPick={(folder) => void choose(folder.id)}
            />
        </div>
    );
}
