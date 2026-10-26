import { describe, expect, it, vi } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";

vi.mock("next/navigation", () => ({ useRouter: () => ({ push: vi.fn() }) }));
vi.mock("@/app/lib/userFacingError", () => ({ notifyError: vi.fn() }));
vi.mock("@/app/lib/mikeApi", () => ({
    getMatterWorkspace: vi.fn(),
    openDriveFileForEditing: vi.fn(),
    setMatterDriveFolder: vi.fn(),
    browseDriveFolders: vi.fn(),
}));

import { getMatterWorkspace } from "@/app/lib/mikeApi";
import { MatterWorkspaceSection } from "./MatterWorkspaceSection";

const base = { linked: true, folder: { id: "m", name: "Acme", web_view_link: null }, wip: null, files: [], drive_error: null };

describe("MatterWorkspaceSection", () => {
    it("invites an editor to link a folder when none is linked", async () => {
        vi.mocked(getMatterWorkspace).mockResolvedValue({ ...base, linked: false, folder: null });
        render(<MatterWorkspaceSection projectId="p" orgId={null} canEdit />);
        await waitFor(() => expect(screen.getByText("Link Drive folder")).toBeTruthy());
    });

    it("hides the link controls from a viewer", async () => {
        vi.mocked(getMatterWorkspace).mockResolvedValue({ ...base, linked: false, folder: null });
        render(<MatterWorkspaceSection projectId="p" orgId={null} canEdit={false} />);
        await waitFor(() => expect(screen.getByText(/Link this matter/)).toBeTruthy());
        expect(screen.queryByText("Link Drive folder")).toBeNull();
    });

    it("lists the work in progress files with their type", async () => {
        vi.mocked(getMatterWorkspace).mockResolvedValue({
            ...base,
            wip: { id: "w", name: "Work in progress", web_view_link: null },
            files: [
                { id: "1", name: "Draft SPA", kind: "gdoc", modified_time: null, web_view_link: "https://docs.google.com/x" },
                { id: "2", name: "Research.docx", kind: "docx", modified_time: null, web_view_link: null },
            ],
        });
        render(<MatterWorkspaceSection projectId="p" orgId={null} canEdit />);
        await waitFor(() => expect(screen.getByText("Draft SPA")).toBeTruthy());
        expect(screen.getByText("Google Doc")).toBeTruthy();
        expect(screen.getByText("Word")).toBeTruthy();
        expect(screen.getByRole("link", { name: "Open in Drive" }).getAttribute("href")).toBe("https://docs.google.com/x");
    });

    it("offers Edit in Mike for Word and Google Docs only, and only to editors", async () => {
        const data = {
            ...base,
            wip: { id: "w", name: "Work in progress", web_view_link: null },
            files: [
                { id: "1", name: "Draft SPA", kind: "gdoc", modified_time: null, web_view_link: null },
                { id: "2", name: "Notes.docx", kind: "docx", modified_time: null, web_view_link: null },
                { id: "3", name: "Scan.pdf", kind: "other", modified_time: null, web_view_link: null },
            ],
        };
        vi.mocked(getMatterWorkspace).mockResolvedValue(data as never);
        const { unmount } = render(<MatterWorkspaceSection projectId="p" orgId={null} canEdit />);
        await waitFor(() => expect(screen.getByText("Draft SPA")).toBeTruthy());
        expect(screen.getAllByRole("button", { name: /Edit .* in Mike/ })).toHaveLength(2);
        unmount();
        render(<MatterWorkspaceSection projectId="p" orgId={null} canEdit={false} />);
        await waitFor(() => expect(screen.getByText("Draft SPA")).toBeTruthy());
        expect(screen.queryByRole("button", { name: /in Mike/ })).toBeNull();
    });

    it("shows the Drive problem instead of an empty list", async () => {
        vi.mocked(getMatterWorkspace).mockResolvedValue({
            ...base,
            drive_error: { code: "google_drive_scope_insufficient", message: "Reconnect Google Drive and allow it." },
        });
        render(<MatterWorkspaceSection projectId="p" orgId={null} canEdit />);
        await waitFor(() => expect(screen.getByRole("alert").textContent).toMatch(/Reconnect Google Drive/));
    });

    it("says when the matter folder has no Work in progress folder", async () => {
        vi.mocked(getMatterWorkspace).mockResolvedValue(base);
        render(<MatterWorkspaceSection projectId="p" orgId={null} canEdit />);
        await waitFor(() => expect(screen.getByText(/No .Work in progress. folder was found/)).toBeTruthy());
    });
});
