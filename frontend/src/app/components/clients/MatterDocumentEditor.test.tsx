import { describe, expect, it, vi, beforeEach } from "vitest";
import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";

vi.mock("next/navigation", () => ({ useRouter: () => ({ push: vi.fn() }) }));
vi.mock("@/app/lib/userFacingError", () => ({
    notifyError: vi.fn(),
    userFacingApiError: (e: Error, fallback: string) => e.message || fallback,
}));
vi.mock("@/app/components/shared/PageHeader", () => ({
    PageHeader: ({ breadcrumbs }: { breadcrumbs?: { label: string }[] }) => (
        <nav>{breadcrumbs?.map((b) => b.label).join(" / ")}</nav>
    ),
}));

// The editor itself is covered by DocxView's own tests; here it only reports
// that it is ready so the toolbar's gating can be exercised.
vi.mock("@/app/components/shared/views/DocxView", async () => {
    const React = await import("react");
    return {
        DocxView: (props: {
            documentId: string;
            refetchKey?: number;
            onSaveStateChange?: (id: string, s: unknown) => void;
            onCloseGuardReady?: (g: unknown) => void;
        }) => {
            React.useEffect(() => {
                props.onSaveStateChange?.(props.documentId, { ready: true, dirty: false, status: "saved", error: null });
                props.onCloseGuardReady?.({
                    hasUnsavedChanges: () => false,
                    prepareClose: async () => true,
                    discard: () => {},
                });
            // eslint-disable-next-line react-hooks/exhaustive-deps
            }, []);
            return <div data-testid="editor" data-refetch={props.refetchKey} />;
        },
    };
});

const { FakeApiError } = vi.hoisted(() => ({
    FakeApiError: class extends Error {
        code: string | null;
        constructor(message: string, code: string | null) {
            super(message);
            this.code = code;
        }
    },
}));
vi.mock("@/app/lib/mikeApi", () => ({
    MikeApiError: FakeApiError,
    getDriveSyncStatus: vi.fn(),
    getMatterDashboard: vi.fn(),
    saveDocumentToDrive: vi.fn(),
    pullDocumentFromDrive: vi.fn(),
}));

import {
    getDriveSyncStatus,
    getMatterDashboard,
    pullDocumentFromDrive,
    saveDocumentToDrive,
} from "@/app/lib/mikeApi";
import { MatterDocumentEditor } from "./MatterDocumentEditor";

const status = (over: Record<string, unknown> = {}) => ({
    document_id: "d",
    project_id: "p",
    drive_file_id: "f",
    drive_name: "Draft SPA",
    kind: "gdoc",
    web_view_link: "https://docs.google.com/x",
    state: "in_sync",
    synced_at: "2026-10-20T00:00:00Z",
    drive_error: null,
    ...over,
});

async function renderEditor() {
    await act(async () => {
        render(<MatterDocumentEditor projectId="p" documentId="d" />);
    });
}

beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(getMatterDashboard).mockResolvedValue({
        project: { name: "Acme financing", access_role: "editor" },
    } as never);
});

describe("MatterDocumentEditor", () => {
    it("shows the sync state, the Drive link and the Google Doc caveat", async () => {
        vi.mocked(getDriveSyncStatus).mockResolvedValue(status() as never);
        await renderEditor();
        await waitFor(() => expect(screen.getByText("In sync with Google Drive")).toBeTruthy());
        expect(screen.getByRole("link", { name: "Open in Drive" }).getAttribute("href")).toBe("https://docs.google.com/x");
        expect(screen.getByText(/comments and suggestions in the Doc/)).toBeTruthy();
        expect(screen.getByText("Acme financing / Draft SPA")).toBeTruthy();
    });

    it("omits the Google Doc caveat for a Word file", async () => {
        vi.mocked(getDriveSyncStatus).mockResolvedValue(status({ kind: "docx" }) as never);
        await renderEditor();
        await waitFor(() => screen.getByText("In sync with Google Drive"));
        expect(screen.queryByText(/comments and suggestions/)).toBeNull();
    });

    it("saves to Drive and refreshes the status", async () => {
        vi.mocked(getDriveSyncStatus)
            .mockResolvedValueOnce(status({ state: "local_changes" }) as never)
            .mockResolvedValue(status() as never);
        vi.mocked(saveDocumentToDrive).mockResolvedValue({ synced_at: "now" });
        await renderEditor();
        await waitFor(() => screen.getByText(/Edited in Mike/));
        fireEvent.click(screen.getByRole("button", { name: "Save to Drive" }));
        await waitFor(() => expect(screen.getByText("Saved to Google Drive.")).toBeTruthy());
        expect(saveDocumentToDrive).toHaveBeenCalledWith("d", { overwrite: false });
        await waitFor(() => expect(screen.getByText("In sync with Google Drive")).toBeTruthy());
    });

    it("asks before overwriting a newer Drive version, then saves with overwrite", async () => {
        vi.mocked(getDriveSyncStatus).mockResolvedValue(status({ state: "both_changed" }) as never);
        vi.mocked(saveDocumentToDrive)
            .mockRejectedValueOnce(new FakeApiError("changed in Drive", "google_drive_changed"))
            .mockResolvedValueOnce({ synced_at: "now" });
        await renderEditor();
        await waitFor(() => screen.getByText(/changed in both/i));
        fireEvent.click(screen.getByRole("button", { name: "Save to Drive" }));
        await waitFor(() => expect(screen.getByText("Overwrite the newer Google Drive version?")).toBeTruthy());
        fireEvent.click(screen.getByRole("button", { name: "Overwrite in Drive" }));
        await waitFor(() => expect(saveDocumentToDrive).toHaveBeenLastCalledWith("d", { overwrite: true }));
    });

    it("updates from Drive and reloads the editor", async () => {
        vi.mocked(getDriveSyncStatus).mockResolvedValue(status({ state: "drive_changes" }) as never);
        vi.mocked(pullDocumentFromDrive).mockResolvedValue({ version_id: "v2", synced_at: "now" });
        await renderEditor();
        await waitFor(() => screen.getByText(/Changed in Google Drive/));
        fireEvent.click(screen.getByRole("button", { name: "Update from Drive" }));
        await waitFor(() => expect(screen.getByText(/Your earlier version is in the version history/)).toBeTruthy());
        expect(screen.getByTestId("editor").getAttribute("data-refetch")).toBe("1");
    });

    it("lets a viewer read but not write back", async () => {
        vi.mocked(getMatterDashboard).mockResolvedValue({
            project: { name: "Acme", access_role: "viewer" },
        } as never);
        vi.mocked(getDriveSyncStatus).mockResolvedValue(status() as never);
        await renderEditor();
        await waitFor(() => screen.getByText("In sync with Google Drive"));
        expect((screen.getByRole("button", { name: "Save to Drive" }) as HTMLButtonElement).disabled).toBe(true);
        expect((screen.getByRole("button", { name: "Update from Drive" }) as HTMLButtonElement).disabled).toBe(true);
    });
});
