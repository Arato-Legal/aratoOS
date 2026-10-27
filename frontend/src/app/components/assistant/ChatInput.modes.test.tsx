import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { ChatInput } from "./ChatInput";

vi.mock("@/app/lib/mikeApi", () => ({
    listWorkflows: vi.fn(async () => []),
    uploadProjectDocument: vi.fn(),
    uploadStandaloneDocument: vi.fn(),
}));
vi.mock("@/app/hooks/useSelectedModel", () => ({
    useSelectedModel: () => ["claude-sonnet-4-6", vi.fn()],
    useSelectedReasoning: () => ["high", vi.fn()],
}));
vi.mock("@/app/hooks/useConfiguredModels", () => ({
    useConfiguredModels: () => [],
}));
vi.mock("@/app/contexts/UserProfileContext", () => ({
    useUserProfile: () => ({ profile: null }),
}));
vi.mock("@/app/lib/modelAvailability", () => ({
    getModelProvider: vi.fn(),
    isModelAvailable: vi.fn(() => true),
}));
vi.mock("./AddDocButton", () => ({ AddDocButton: () => null }));
vi.mock("./UploadOverlay", () => ({ UploadOverlay: () => null }));
vi.mock("../shared/FileTypeIcon", () => ({ FileTypeIcon: () => null }));
vi.mock("../modals/AddDocumentsModal", () => ({ AddDocumentsModal: () => null }));
vi.mock("./AssistantWorkflowModal", () => ({ AssistantWorkflowModal: () => null }));
vi.mock("../popups/ApiKeyMissingPopup", () => ({ ApiKeyMissingPopup: () => null }));
vi.mock("./ModelToggle", () => ({ ModelToggle: () => null }));

class ResizeObserverMock {
    observe() {}
    disconnect() {}
    unobserve() {}
}

describe("ChatInput session modes", () => {
    beforeEach(() => {
        vi.clearAllMocks();
        vi.stubGlobal("ResizeObserver", ResizeObserverMock);
    });

    function renderInput(showModePicker: boolean) {
        const onSubmit = vi.fn();
        const { container } = render(
            <ChatInput
                onSubmit={onSubmit}
                onCancel={vi.fn()}
                isLoading={false}
                canSend={true}
                showModePicker={showModePicker}
            />,
        );
        return {
            onSubmit,
            textarea: () => container.querySelector("textarea") as HTMLTextAreaElement,
        };
    }

    it("sends the chosen mode with one message, then returns to chat", async () => {
        const user = userEvent.setup();
        const { onSubmit, textarea } = renderInput(true);
        await user.click(screen.getByRole("radio", { name: "Library search" }));
        expect(screen.getByRole("radio", { name: "Library search" })).toBeChecked();
        await user.type(textarea(), "find the lease");
        await user.click(screen.getByRole("button", { name: "Send message" }));
        expect(onSubmit).toHaveBeenLastCalledWith(
            expect.objectContaining({ mode: "library", content: "find the lease" }),
        );
        expect(screen.getByRole("radio", { name: "Chat" })).toBeChecked();
        await user.type(textarea(), "thanks");
        await user.click(screen.getByRole("button", { name: "Send message" }));
        expect(onSubmit.mock.calls.at(-1)?.[0]).not.toHaveProperty("mode");
    });

    it("offers all five modes, and only when asked", () => {
        renderInput(true);
        expect(
            screen.getAllByRole("radio").map((radio) => radio.textContent),
        ).toEqual(["Chat", "Workflow", "Playbook", "Tabular review", "Library search"]);
    });

    it("does not show the picker by default", () => {
        renderInput(false);
        expect(screen.queryByRole("radiogroup", { name: "Session mode" })).toBeNull();
    });
});
