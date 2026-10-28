"use client";

import { useEffect, useState } from "react";
import { getIntegrationSettings, updateIntegrationSettings } from "@/app/lib/mikeApi";
import { notifyError } from "@/app/lib/userFacingError";
import { PillButtonUI } from "@/shared/ui/PillButtonUI";
import { FORM_CONTROL_GLASS_CLASS } from "@/app/components/ui/form-field";
import { cn } from "@/app/lib/utils";
import type { IntegrationSettings } from "../shared/types";
import { DashboardSection } from "./DashboardPrimitives";

const FIELDS = [
    ["hubflo_client_url", "Client link"],
    ["hubflo_matter_url", "Matter link"],
    ["hubflo_contact_url", "Contact link"],
] as const;

type UrlKey = (typeof FIELDS)[number][0];

/** Admin settings: Hubflo link templates and the workspace-wide Google Drive. */
export function IntegrationSettingsSection({ workspace }: { workspace: string }) {
    const [settings, setSettings] = useState<IntegrationSettings | null>(null);
    const [draft, setDraft] = useState<Record<UrlKey, string>>({
        hubflo_client_url: "",
        hubflo_matter_url: "",
        hubflo_contact_url: "",
    });
    const [saving, setSaving] = useState(false);

    const apply = (next: IntegrationSettings) => {
        setSettings(next);
        setDraft({
            hubflo_client_url: next.hubflo_client_url ?? "",
            hubflo_matter_url: next.hubflo_matter_url ?? "",
            hubflo_contact_url: next.hubflo_contact_url ?? "",
        });
    };

    useEffect(() => {
        let cancelled = false;
        getIntegrationSettings(workspace)
            .then((s) => {
                if (!cancelled) apply(s);
            })
            .catch((error) => {
                if (!cancelled)
                    notifyError(error, {
                        action: "load integration settings",
                        dedupeKey: "integration-settings",
                    });
            });
        return () => {
            cancelled = true;
        };
    }, [workspace]);

    const run = async (patch: Parameters<typeof updateIntegrationSettings>[1], action: string) => {
        setSaving(true);
        try {
            apply(await updateIntegrationSettings(workspace, patch));
        } catch (error) {
            notifyError(error, { action });
        } finally {
            setSaving(false);
        }
    };

    if (!settings) return null;
    return (
        <>
            <DashboardSection title="Links back to Hubflo">
                <p className="mb-3 text-xs text-gray-500">
                    Each URL must start with https:// and contain {"{id}"}, which is
                    replaced with the record&apos;s Hubflo id. Links appear only on
                    records that came from Hubflo.
                </p>
                <div className="flex flex-col gap-3">
                    {FIELDS.map(([key, label]) => (
                        <label key={key} className="flex flex-col gap-1 text-xs font-medium text-gray-500">
                            {label}
                            <input
                                type="url"
                                value={draft[key]}
                                placeholder="https://your-portal.example/clients/{id}"
                                onChange={(e) => setDraft({ ...draft, [key]: e.target.value })}
                                className={cn(FORM_CONTROL_GLASS_CLASS, "text-sm font-normal text-gray-900")}
                            />
                        </label>
                    ))}
                    <div>
                        <PillButtonUI
                            tone="black"
                            size="sm"
                            loading={saving}
                            onClick={() => void run(draft, "save the Hubflo links")}
                        >
                            Save links
                        </PillButtonUI>
                    </div>
                </div>
            </DashboardSection>

            <DashboardSection title="Google Drive for everyone">
                <p className="mb-3 text-sm text-gray-700">
                    {settings.drive_shared
                        ? settings.drive_shared_by_me
                            ? "Your Google Drive connection is used by every member of this workspace. Members do not need to connect Google themselves."
                            : "Another admin's Google Drive connection is used by every member of this workspace."
                        : "Each member connects their own Google Drive. Share yours to let everyone browse, create and edit matter folders without connecting."}
                </p>
                <p className="mb-3 text-xs text-gray-500">
                    Everyone then reaches Drive as the shared account, so use an account
                    that can see the firm&apos;s matter folders. Connect Google Drive in
                    this workspace&apos;s settings first.
                </p>
                <PillButtonUI
                    tone={settings.drive_shared ? "white" : "black"}
                    size="sm"
                    loading={saving}
                    onClick={() =>
                        void run(
                            { drive_shared: !settings.drive_shared },
                            "change the shared Drive connection",
                        )
                    }
                >
                    {settings.drive_shared ? "Stop sharing" : "Share my Google Drive"}
                </PillButtonUI>
            </DashboardSection>
        </>
    );
}
