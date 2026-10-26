import { Suspense } from "react";
import { describe, expect, it, vi } from "vitest";
import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";

vi.mock("@/app/lib/mikeApi", () => ({
    getPublicIntakeForm: vi.fn(),
    submitPublicIntakeForm: vi.fn(),
}));

import { getPublicIntakeForm, submitPublicIntakeForm } from "@/app/lib/mikeApi";
import IntakePage from "./page";

async function renderPage() {
    await act(async () => {
        render(
            <Suspense fallback={null}>
                <IntakePage params={Promise.resolve({ token: "t".repeat(64) })} />
            </Suspense>,
        );
    });
}

describe("public intake page", () => {
    it("says so when the form does not exist", async () => {
        vi.mocked(getPublicIntakeForm).mockResolvedValue(null);
        await renderPage();
        await waitFor(() =>
            expect(screen.getByText("This form is not available")).toBeTruthy(),
        );
    });

    it("submits the entered details and thanks the visitor", async () => {
        vi.mocked(getPublicIntakeForm).mockResolvedValue({
            title: "Contact us",
            description: null,
        });
        vi.mocked(submitPublicIntakeForm).mockResolvedValue({ ok: true });
        await renderPage();
        await waitFor(() => screen.getByLabelText("Name"));
        fireEvent.change(screen.getByLabelText("Name"), { target: { value: "Pat" } });
        fireEvent.change(screen.getByLabelText("Email"), {
            target: { value: "pat@x.co" },
        });
        fireEvent.click(screen.getByRole("button", { name: "Send" }));
        await waitFor(() => expect(screen.getByText("Thank you")).toBeTruthy());
        expect(submitPublicIntakeForm).toHaveBeenCalledWith(
            "t".repeat(64),
            expect.objectContaining({ name: "Pat", email: "pat@x.co", website: "" }),
        );
    });

    it("shows the server's message when the submission is refused", async () => {
        vi.mocked(getPublicIntakeForm).mockResolvedValue({
            title: "Contact us",
            description: null,
        });
        vi.mocked(submitPublicIntakeForm).mockResolvedValue({
            ok: false,
            message: "Too many submissions. Please try again later.",
        });
        await renderPage();
        await waitFor(() => screen.getByLabelText("Name"));
        fireEvent.change(screen.getByLabelText("Name"), { target: { value: "Pat" } });
        fireEvent.click(screen.getByRole("button", { name: "Send" }));
        await waitFor(() =>
            expect(screen.getByRole("alert").textContent).toMatch(/Too many submissions/),
        );
    });
});
