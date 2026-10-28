import { describe, expect, it, vi, beforeEach } from "vitest";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";

vi.mock("@/app/lib/userFacingError", () => ({ notifyError: vi.fn() }));
vi.mock("@/app/lib/mikeApi", () => {
    class MikeApiError extends Error {
        status = 409;
        code: string | null;
        constructor(args: { message: string; code?: string | null }) {
            super(args.message);
            this.code = args.code ?? null;
        }
    }
    return {
        MikeApiError,
        getClientMemory: vi.fn(),
        saveClientMemory: vi.fn(),
        setClientMemoryEnabled: vi.fn(),
    };
});

import {
    MikeApiError,
    getClientMemory,
    saveClientMemory,
    setClientMemoryEnabled,
} from "@/app/lib/mikeApi";
import { ClientMemorySection } from "./ClientMemorySection";

const memory = (over: object = {}) => ({
    matter_notes: [],
    content: "Net 30",
    revision: 4,
    enabled: true,
    size_bytes: 6,
    updated_at: null,
    can_edit: true,
    ...over,
});

beforeEach(() => vi.clearAllMocks());

describe("ClientMemorySection", () => {
    it("saves an edit against the revision it loaded", async () => {
        vi.mocked(getClientMemory).mockResolvedValue(memory());
        vi.mocked(saveClientMemory).mockResolvedValue(memory({ content: "Net 45", revision: 5 }));
        render(<ClientMemorySection clientId="c1" />);
        const box = await screen.findByLabelText("Client memory");
        expect(screen.getByRole("button", { name: "Save memory" })).toBeDisabled();
        fireEvent.change(box, { target: { value: "Net 45" } });
        fireEvent.click(screen.getByRole("button", { name: "Save memory" }));
        await waitFor(() => expect(saveClientMemory).toHaveBeenCalledWith("c1", "Net 45", 4));
    });

    it("lists what matters taught it, by matter", async () => {
        vi.mocked(getClientMemory).mockResolvedValue(
            memory({
                matter_notes: [
                    { project_id: "p1", name: "Series A", content: "- Pays Net 30" },
                ],
            }),
        );
        render(<ClientMemorySection clientId="c1" />);
        expect(await screen.findByText("Learned in matters")).toBeTruthy();
        expect(screen.getByText("Series A")).toBeTruthy();
        expect(screen.getByText("- Pays Net 30")).toBeTruthy();
    });

    it("shows no matter notes section when there are none", async () => {
        vi.mocked(getClientMemory).mockResolvedValue(memory());
        render(<ClientMemorySection clientId="c1" />);
        await screen.findByLabelText("Client memory");
        expect(screen.queryByText("Learned in matters")).toBeNull();
    });

    it("is read-only for someone who cannot edit", async () => {
        vi.mocked(getClientMemory).mockResolvedValue(memory({ can_edit: false }));
        render(<ClientMemorySection clientId="c1" />);
        expect(await screen.findByLabelText("Client memory")).toHaveAttribute("readonly");
        expect(screen.queryByRole("button", { name: "Save memory" })).toBeNull();
        expect(screen.queryByRole("button", { name: "Turn off" })).toBeNull();
    });

    it("reloads what is saved when it changed since loading", async () => {
        vi.mocked(getClientMemory)
            .mockResolvedValueOnce(memory())
            .mockResolvedValueOnce(memory({ content: "Learned in a chat", revision: 5 }));
        vi.mocked(saveClientMemory).mockRejectedValue(
            new MikeApiError({ message: "changed", code: "memory_revision_conflict" } as never),
        );
        render(<ClientMemorySection clientId="c1" />);
        const box = await screen.findByLabelText("Client memory");
        fireEvent.change(box, { target: { value: "mine" } });
        fireEvent.click(screen.getByRole("button", { name: "Save memory" }));
        await waitFor(() =>
            expect(screen.getByLabelText("Client memory")).toHaveValue("Learned in a chat"),
        );
    });

    it("asks before turning memory off", async () => {
        vi.mocked(getClientMemory).mockResolvedValue(memory());
        vi.mocked(setClientMemoryEnabled).mockResolvedValue(
            memory({ enabled: false, content: "", revision: 5 }),
        );
        render(<ClientMemorySection clientId="c1" />);
        fireEvent.click(await screen.findByRole("button", { name: "Turn off" }));
        expect(setClientMemoryEnabled).not.toHaveBeenCalled();
        // The confirmation's own button comes second.
        const buttons = screen.getAllByRole("button", { name: "Turn off" });
        expect(buttons).toHaveLength(2);
        fireEvent.click(buttons[1]);
        await waitFor(() => expect(setClientMemoryEnabled).toHaveBeenCalledWith("c1", false));
        expect(await screen.findByText("Client memory is off. Nothing is learned or used.")).toBeTruthy();
    });
});
