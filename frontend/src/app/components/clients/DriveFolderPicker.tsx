"use client";

import { useEffect, useState } from "react";
import { Folder } from "lucide-react";
import { browseDriveFolders } from "@/app/lib/mikeApi";
import { notifyError } from "@/app/lib/userFacingError";
import { Modal } from "../modals/Modal";
import type { MatterWorkspace, WorkspaceFile } from "../shared/types";

interface Props {
    open: boolean;
    workspace?: string;
    onClose: () => void;
    onPick: (folder: { id: string; name: string }) => void;
    title?: string;
}

type Crumb = { id: string; name: string };
const ROOT: Crumb = { id: "root", name: "My Drive" };

/** Browse Google Drive folders and pick the matter's folder. */
export function DriveFolderPicker({ open, workspace, onClose, onPick, title }: Props) {
    const [trail, setTrail] = useState<Crumb[]>([ROOT]);
    const [items, setItems] = useState<WorkspaceFile[]>([]);
    const [driveError, setDriveError] = useState<MatterWorkspace["drive_error"]>(null);
    const [loadedFor, setLoadedFor] = useState<string | null>(null);
    const current = trail[trail.length - 1];
    const loading = open && loadedFor !== current.id;

    useEffect(() => {
        if (!open) return;
        let cancelled = false;
        browseDriveFolders({ parent: current.id, workspace })
            .then((result) => {
                if (cancelled) return;
                setItems(result.items);
                setDriveError(result.drive_error);
                setLoadedFor(current.id);
            })
            .catch((error) => {
                if (cancelled) return;
                notifyError(error, { action: "browse Google Drive" });
                setLoadedFor(current.id);
            });
        return () => {
            cancelled = true;
        };
    }, [open, current.id, workspace]);

    const close = () => {
        setTrail([ROOT]);
        setLoadedFor(null);
        onClose();
    };

    return (
        <Modal
            open={open}
            onClose={close}
            size="md"
            breadcrumbs={[title ?? "Choose the matter folder"]}
            primaryAction={{
                label: current.id === "root" ? "Choose a folder" : `Use “${current.name}”`,
                disabled: current.id === "root",
                onClick: () => {
                    onPick({ id: current.id, name: current.name });
                    close();
                },
            }}
        >
            <div className="flex flex-col gap-3 p-4">
                <nav aria-label="Folder path" className="flex flex-wrap items-center gap-1 text-xs text-gray-600">
                    {trail.map((crumb, index) => (
                        <span key={crumb.id} className="flex items-center gap-1">
                            {index > 0 && <span aria-hidden="true">/</span>}
                            <button
                                type="button"
                                disabled={index === trail.length - 1}
                                onClick={() => {
                                    setLoadedFor(null);
                                    setTrail(trail.slice(0, index + 1));
                                }}
                                className="rounded px-1 hover:underline disabled:font-medium disabled:no-underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-blue-500/40"
                            >
                                {crumb.name}
                            </button>
                        </span>
                    ))}
                </nav>

                {driveError ? (
                    <p role="alert" className="text-sm text-gray-700">
                        {driveError.message}
                    </p>
                ) : loading ? (
                    <div className="animate-pulse space-y-2" aria-busy="true">
                        {[0, 1, 2].map((i) => (
                            <div key={i} className="h-8 rounded bg-gray-100" />
                        ))}
                    </div>
                ) : items.length === 0 ? (
                    <p className="text-sm text-gray-500">No folders here.</p>
                ) : (
                    <ul className="max-h-80 overflow-y-auto">
                        {items.map((folder) => (
                            <li key={folder.id}>
                                <button
                                    type="button"
                                    onClick={() => {
                                        setLoadedFor(null);
                                        setTrail([...trail, { id: folder.id, name: folder.name }]);
                                    }}
                                    className="flex w-full items-center gap-2 rounded-lg px-2 py-2 text-left text-sm text-gray-800 hover:bg-gray-100 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-blue-500/40"
                                >
                                    <Folder className="h-4 w-4 shrink-0 text-gray-500" aria-hidden="true" />
                                    <span className="min-w-0 break-words">{folder.name}</span>
                                </button>
                            </li>
                        ))}
                    </ul>
                )}
            </div>
        </Modal>
    );
}
