import { beforeEach, describe, expect, it, vi } from "vitest";
import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";

vi.mock("next/navigation", () => ({ useRouter: () => ({ push: vi.fn() }) }));
vi.mock("@/app/lib/userFacingError", () => ({ notifyError: vi.fn() }));
vi.mock("@/app/contexts/AuthContext", () => ({
    useAuth: () => ({ isAuthenticated: true, authLoading: false }),
}));
vi.mock("@/app/contexts/WorkspaceContext", () => ({
    PERSONAL_WORKSPACE: "personal",
    useWorkspaceParam: () => "org-1",
}));
vi.mock("@/app/components/shared/PageHeader", () => ({
    PageHeader: ({ children }: { children?: React.ReactNode }) => <div>{children}</div>,
}));

const { FakeApiError } = vi.hoisted(() => ({
    FakeApiError: class extends Error {
        status: number;
        constructor(message: string, status: number) {
            super(message);
            this.status = status;
        }
    },
}));
vi.mock("@/app/lib/mikeApi", () => ({
    MikeApiError: FakeApiError,
    listCrmSyncEndpoints: vi.fn(),
    createCrmSyncEndpoint: vi.fn(),
    updateCrmSyncEndpoint: vi.fn(),
    rotateCrmSyncSecret: vi.fn(),
    deleteCrmSyncEndpoint: vi.fn(),
    listCrmSyncEvents: vi.fn(),
}));

import {
    createCrmSyncEndpoint,
    deleteCrmSyncEndpoint,
    listCrmSyncEndpoints,
    listCrmSyncEvents,
    rotateCrmSyncSecret,
} from "@/app/lib/mikeApi";
import { CrmSyncManager } from "./CrmSyncManager";

const endpoint = {
    id: "e1",
    org_id: "org-1",
    name: "Hubflo production",
    provider: "hubflo",
    enabled: true,
    matter_visibility: "private",
    last_received_at: null,
    created_at: "2026-10-26T00:00:00Z",
    webhook_path: "/webhooks/crm/" + "ab".repeat(32),
};

const renderManager = async () => {
    await act(async () => {
        render(<CrmSyncManager />);
    });
};

beforeEach(() => vi.clearAllMocks());

describe("CrmSyncManager", () => {
    it("shows the endpoint's full URL and what its new matters can see", async () => {
        vi.mocked(listCrmSyncEndpoints).mockResolvedValue([endpoint] as never);
        await renderManager();
        await waitFor(() => expect(screen.getByText("Hubflo production")).toBeTruthy());
        expect(screen.getByText(new RegExp(`/api/webhooks/crm/${"ab".repeat(32)}`))).toBeTruthy();
        expect(screen.getByText(/private to the person who created this endpoint/)).toBeTruthy();
        expect(screen.getByText("Nothing received yet")).toBeTruthy();
    });

    it("tells a non-admin they cannot manage sync", async () => {
        vi.mocked(listCrmSyncEndpoints).mockRejectedValue(new FakeApiError("no", 403));
        await renderManager();
        await waitFor(() =>
            expect(screen.getByRole("alert").textContent).toMatch(/Only organization admins/),
        );
        expect(screen.queryByText("Create endpoint")).toBeNull();
    });

    it("reveals the secret once after creating an endpoint, and can dismiss it", async () => {
        vi.mocked(listCrmSyncEndpoints).mockResolvedValue([]);
        vi.mocked(createCrmSyncEndpoint).mockResolvedValue({
            endpoint: endpoint as never,
            secret: "mike_whsec_shown_once",
        });
        await renderManager();
        await waitFor(() => screen.getByLabelText("Endpoint name"));
        fireEvent.change(screen.getByLabelText("Endpoint name"), { target: { value: "Hubflo" } });
        fireEvent.click(screen.getByRole("button", { name: "Create endpoint" }));
        await waitFor(() => expect(screen.getByText("mike_whsec_shown_once")).toBeTruthy());
        expect(createCrmSyncEndpoint).toHaveBeenCalledWith(
            { name: "Hubflo", provider: "hubflo", matter_visibility: "private" },
            "org-1",
        );
        fireEvent.click(screen.getByRole("button", { name: "I have saved it" }));
        expect(screen.queryByText("mike_whsec_shown_once")).toBeNull();
    });

    it("shows a replacement secret and recent activity with rejected outcomes marked", async () => {
        vi.mocked(listCrmSyncEndpoints).mockResolvedValue([endpoint] as never);
        vi.mocked(rotateCrmSyncSecret).mockResolvedValue({ endpoint: endpoint as never, secret: "mike_whsec_new" });
        vi.mocked(listCrmSyncEvents).mockResolvedValue([
            { id: "1", received_at: "2026-10-26T10:00:00Z", event_type: "client.upsert", external_id: "C1", outcome: "rejected", error_code: "invalid_payload" },
        ] as never);
        await renderManager();
        await waitFor(() => screen.getByText("Hubflo production"));
        fireEvent.click(screen.getByRole("button", { name: "Replace secret" }));
        await waitFor(() => expect(screen.getByText("mike_whsec_new")).toBeTruthy());
        fireEvent.click(screen.getByRole("button", { name: "Recent activity" }));
        await waitFor(() => expect(screen.getByText("rejected (invalid_payload)")).toBeTruthy());
    });

    it("asks before deleting an endpoint", async () => {
        vi.mocked(listCrmSyncEndpoints).mockResolvedValue([endpoint] as never);
        vi.mocked(deleteCrmSyncEndpoint).mockResolvedValue(undefined);
        await renderManager();
        await waitFor(() => screen.getByText("Hubflo production"));
        fireEvent.click(screen.getByRole("button", { name: "Delete" }));
        expect(deleteCrmSyncEndpoint).not.toHaveBeenCalled();
        fireEvent.click(screen.getByRole("button", { name: "Delete endpoint" }));
        await waitFor(() => expect(deleteCrmSyncEndpoint).toHaveBeenCalledWith("e1"));
    });
});
