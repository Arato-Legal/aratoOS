import { describe, expect, it, vi } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";

vi.mock("next/navigation", () => ({ useRouter: () => ({ push: vi.fn() }) }));
vi.mock("@/app/lib/userFacingError", () => ({ notifyError: vi.fn() }));
vi.mock("@/app/lib/mikeApi", () => ({
    getMatterDashboard: vi.fn(),
    getMatterWorkspace: vi.fn(() => new Promise(() => {})),
    openDriveFileForEditing: vi.fn(),
    setMatterDriveFolder: vi.fn(),
    browseDriveFolders: vi.fn(),
    getClientFiles: vi.fn(() => new Promise(() => {})),
    setMatterSharing: vi.fn(),
    createMatterDriveFolder: vi.fn(),
}));
vi.mock("@/app/components/shared/PageHeader", () => ({
    PageHeader: ({ breadcrumbs }: { breadcrumbs?: { label: string }[] }) => (
        <nav>{breadcrumbs?.map((b) => b.label).join(" / ")}</nav>
    ),
}));

import { getMatterDashboard } from "@/app/lib/mikeApi";
import { MatterDashboard } from "./MatterDashboard";

const base = {
    id: "p1",
    name: "Acme financing",
    cm_number: "2026-014",
    practice: "Corporate",
    share_with_client: true,
    updated_at: "2026-10-20T00:00:00Z",
    client_id: "c1",
    org_id: null,
    access_role: "owner",
};

describe("MatterDashboard", () => {
    it("shows the matter, its client and the client's contacts", async () => {
        vi.mocked(getMatterDashboard).mockResolvedValue({
            project: base,
            client: {
                id: "c1",
                name: "Acme Inc.",
                status: "active",
                email: "ceo@acme.test",
                phone: null,
                contacts: [
                    { id: "k1", client_id: "c1", name: "Jo", role: "CFO", email: null, phone: null, notes: null },
                ],
            },
        } as never);
        render(<MatterDashboard projectId="p1" />);
        await waitFor(() =>
            expect(screen.getByRole("heading", { name: "Acme financing" })).toBeTruthy(),
        );
        expect(screen.getByText("2026-014")).toBeTruthy();
        expect(screen.getByText("ceo@acme.test")).toBeTruthy();
        expect(screen.getByText(/Jo · CFO/)).toBeTruthy();
    });

    it("marks an unassigned matter without client details", async () => {
        vi.mocked(getMatterDashboard).mockResolvedValue({
            project: { ...base, client_id: null },
            client: null,
        } as never);
        render(<MatterDashboard projectId="p1" />);
        await waitFor(() => expect(screen.getByText("Not assigned")).toBeTruthy());
        expect(screen.queryByText("Open client page")).toBeNull();
    });
});
