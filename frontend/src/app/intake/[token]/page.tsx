"use client";

import { use, useEffect, useState } from "react";
import {
    getPublicIntakeForm,
    submitPublicIntakeForm,
    type PublicIntakeForm,
} from "@/app/lib/mikeApi";
import { FieldLabel, FormTextInput } from "@/app/components/ui/form-field";
import { FORM_CONTROL_GLASS_CLASS } from "@/app/components/ui/form-field";
import { PillButtonUI } from "@/shared/ui/PillButtonUI";
import { cn } from "@/app/lib/utils";

interface Props {
    params: Promise<{ token: string }>;
}

type Phase =
    | { kind: "loading" }
    | { kind: "unavailable" }
    | { kind: "ready"; form: PublicIntakeForm }
    | { kind: "sent" };

/** The public page a prospect opens from an intake link. No sign-in. */
export default function IntakePage({ params }: Props) {
    const { token } = use(params);
    const [phase, setPhase] = useState<Phase>({ kind: "loading" });
    const [values, setValues] = useState({
        name: "",
        email: "",
        phone: "",
        message: "",
        website: "",
    });
    const [error, setError] = useState<string | null>(null);
    const [sending, setSending] = useState(false);

    useEffect(() => {
        let cancelled = false;
        getPublicIntakeForm(token)
            .then((form) => {
                if (cancelled) return;
                setPhase(form ? { kind: "ready", form } : { kind: "unavailable" });
            })
            .catch(() => {
                if (!cancelled) setPhase({ kind: "unavailable" });
            });
        return () => {
            cancelled = true;
        };
    }, [token]);

    const set = (key: keyof typeof values) => (
        e: React.ChangeEvent<HTMLInputElement | HTMLTextAreaElement>,
    ) => setValues((v) => ({ ...v, [key]: e.target.value }));

    const submit = async () => {
        if (sending) return;
        setError(null);
        setSending(true);
        const result = await submitPublicIntakeForm(token, values);
        setSending(false);
        if (result.ok) setPhase({ kind: "sent" });
        else setError(result.message);
    };

    return (
        <main className="flex min-h-screen items-start justify-center bg-gray-50 px-4 py-10 sm:py-16">
            <div className="w-full max-w-lg">
                {phase.kind === "loading" && (
                    <div className="animate-pulse space-y-3" aria-busy="true">
                        <div className="h-8 w-2/3 rounded bg-gray-200" />
                        <div className="h-40 rounded-2xl bg-gray-100" />
                    </div>
                )}
                {phase.kind === "unavailable" && (
                    <div>
                        <h1 className="font-serif text-3xl text-gray-900">
                            This form is not available
                        </h1>
                        <p className="mt-2 text-sm text-gray-600">
                            The link may be wrong or the form may have been
                            closed. Please contact the firm directly.
                        </p>
                    </div>
                )}
                {phase.kind === "sent" && (
                    <div role="status">
                        <h1 className="font-serif text-3xl text-gray-900">
                            Thank you
                        </h1>
                        <p className="mt-2 text-sm text-gray-600">
                            We received your information and will be in touch.
                        </p>
                    </div>
                )}
                {phase.kind === "ready" && (
                    <form
                        className="flex flex-col gap-4"
                        onSubmit={(e) => {
                            e.preventDefault();
                            void submit();
                        }}
                    >
                        <div>
                            <h1 className="break-words font-serif text-3xl text-gray-900">
                                {phase.form.title}
                            </h1>
                            {phase.form.description && (
                                <p className="mt-2 whitespace-pre-line break-words text-sm text-gray-600">
                                    {phase.form.description}
                                </p>
                            )}
                        </div>
                        <div className="flex flex-col gap-1">
                            <FieldLabel htmlFor="intake-name">Name</FieldLabel>
                            <FormTextInput
                                id="intake-name"
                                required
                                maxLength={300}
                                autoComplete="name"
                                value={values.name}
                                onChange={set("name")}
                            />
                        </div>
                        <div className="flex flex-col gap-1">
                            <FieldLabel htmlFor="intake-email">Email</FieldLabel>
                            <FormTextInput
                                id="intake-email"
                                type="email"
                                maxLength={320}
                                autoComplete="email"
                                value={values.email}
                                onChange={set("email")}
                            />
                        </div>
                        <div className="flex flex-col gap-1">
                            <FieldLabel htmlFor="intake-phone">Phone</FieldLabel>
                            <FormTextInput
                                id="intake-phone"
                                type="tel"
                                maxLength={100}
                                autoComplete="tel"
                                value={values.phone}
                                onChange={set("phone")}
                            />
                            <p className="text-xs text-gray-500">
                                Please give an email address or a phone number.
                            </p>
                        </div>
                        <div className="flex flex-col gap-1">
                            <FieldLabel htmlFor="intake-message">
                                How can we help?
                            </FieldLabel>
                            <textarea
                                id="intake-message"
                                rows={5}
                                maxLength={5000}
                                value={values.message}
                                onChange={set("message")}
                                className={cn(FORM_CONTROL_GLASS_CLASS, "py-2")}
                            />
                        </div>
                        {/* Honeypot: people never see or reach it. */}
                        <div
                            aria-hidden="true"
                            className="absolute -left-[9999px] h-0 w-0 overflow-hidden"
                        >
                            <label>
                                Website
                                <input
                                    tabIndex={-1}
                                    autoComplete="off"
                                    value={values.website}
                                    onChange={set("website")}
                                />
                            </label>
                        </div>
                        {error && (
                            <p role="alert" className="text-sm text-red-700">
                                {error}
                            </p>
                        )}
                        <div>
                            <PillButtonUI
                                type="submit"
                                tone="black"
                                size="normal"
                                loading={sending}
                                disabled={!values.name.trim()}
                            >
                                Send
                            </PillButtonUI>
                        </div>
                    </form>
                )}
            </div>
        </main>
    );
}
