import { describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";

vi.mock("@/app/lib/userFacingError", () => ({ notifyError: vi.fn() }));
vi.mock("@/app/lib/mikeApi", () => ({
    getIntegrationSettings: vi.fn(),
    updateIntegrationSettings: vi.fn(),
}));

import { getIntegrationSettings, updateIntegrationSettings } from "@/app/lib/mikeApi";
import { IntegrationSettingsSection } from "./IntegrationSettingsSection";

const base = {
    hubflo_client_url: null,
    hubflo_matter_url: null,
    hubflo_contact_url: null,
    drive_shared: false,
    drive_shared_by_me: false,
};

describe("IntegrationSettingsSection", () => {
    it("saves link templates", async () => {
        vi.mocked(getIntegrationSettings).mockResolvedValue(base);
        vi.mocked(updateIntegrationSettings).mockResolvedValue({
            ...base,
            hubflo_client_url: "https://p.example/c/{id}",
        });
        render(<IntegrationSettingsSection workspace="org-1" />);
        const input = await screen.findByLabelText("Client link");
        fireEvent.change(input, { target: { value: "https://p.example/c/{id}" } });
        fireEvent.click(screen.getByRole("button", { name: "Save links" }));
        await waitFor(() =>
            expect(updateIntegrationSettings).toHaveBeenCalledWith(
                "org-1",
                expect.objectContaining({ hubflo_client_url: "https://p.example/c/{id}" }),
            ),
        );
    });

    it("shares and stops sharing Drive", async () => {
        vi.mocked(getIntegrationSettings).mockResolvedValue(base);
        vi.mocked(updateIntegrationSettings).mockResolvedValue({
            ...base,
            drive_shared: true,
            drive_shared_by_me: true,
        });
        render(<IntegrationSettingsSection workspace="org-1" />);
        fireEvent.click(await screen.findByRole("button", { name: "Share my Google Drive" }));
        await waitFor(() =>
            expect(updateIntegrationSettings).toHaveBeenCalledWith("org-1", { drive_shared: true }),
        );
        expect(await screen.findByRole("button", { name: "Stop sharing" })).toBeTruthy();
    });
});
