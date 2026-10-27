"use client";

import { useState } from "react";
import { setClientDriveFolder } from "@/app/lib/mikeApi";
import { notifyError } from "@/app/lib/userFacingError";
import { PillButtonUI } from "@/shared/ui/PillButtonUI";
import { DriveFolderPicker } from "./DriveFolderPicker";
import { DashboardSection } from "./DashboardPrimitives";

/** The Google Drive folder that holds this client's matter folders. */
export function ClientDriveFolder({
    clientId,
    orgId,
    folderName,
    onChange,
}: {
    clientId: string;
    orgId: string | null;
    folderName: string | null;
    onChange: () => void;
}) {
    const [picking, setPicking] = useState(false);

    const link = async (folderId: string | null) => {
        try {
            await setClientDriveFolder(clientId, folderId);
            onChange();
        } catch (error) {
            notifyError(error, { action: "link the client's Drive folder" });
        }
    };

    return (
        <DashboardSection
            title="Drive folder"
            action={
                <div className="flex gap-2">
                    <PillButtonUI tone="white" size="sm" onClick={() => setPicking(true)}>
                        {folderName ? "Change folder" : "Link Drive folder"}
                    </PillButtonUI>
                    {folderName && (
                        <PillButtonUI tone="white" size="sm" onClick={() => void link(null)}>
                            Unlink
                        </PillButtonUI>
                    )}
                </div>
            }
        >
            <p className="break-words text-sm text-gray-700">
                {folderName ? (
                    <>
                        Matter folders are created inside{" "}
                        <span className="font-medium">{folderName}</span>.
                    </>
                ) : (
                    "Link a Drive folder for this client, or leave it: the first matter you create a Drive folder for will create one."
                )}
            </p>
            <DriveFolderPicker
                open={picking}
                workspace={orgId ?? "personal"}
                onClose={() => setPicking(false)}
                onPick={(folder) => void link(folder.id)}
            />
        </DashboardSection>
    );
}
