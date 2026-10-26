"use client";

import { useCallback, useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import {
    approveIntakeSubmission,
    createIntakeForm,
    deleteIntakeForm,
    listIntakeForms,
    listIntakeSubmissions,
    rejectIntakeSubmission,
    updateIntakeForm,
} from "@/app/lib/mikeApi";
import { notifyError } from "@/app/lib/userFacingError";
import { useAuth } from "@/app/contexts/AuthContext";
import { useWorkspaceParam } from "@/app/contexts/WorkspaceContext";
import { PageHeader } from "@/app/components/shared/PageHeader";
import { PAGE_HEADER_TITLE_CLASS } from "@/app/components/shared/pageHeaderStyles";
import { ConfirmPopup } from "@/app/components/popups/ConfirmPopup";
import { PillButtonUI } from "@/shared/ui/PillButtonUI";
import { FORM_CONTROL_GLASS_CLASS } from "@/app/components/ui/form-field";
import { cn } from "@/app/lib/utils";
import type { IntakeForm, IntakeSubmission } from "../shared/types";
import {
    DashboardPage,
    DashboardSection,
    formatDate,
} from "./DashboardPrimitives";

function formUrl(token: string) {
    return `${window.location.origin}/intake/${token}`;
}

export function IntakeManager() {
    const router = useRouter();
    const { isAuthenticated, authLoading } = useAuth();
    const workspace = useWorkspaceParam();
    const [forms, setForms] = useState<IntakeForm[]>([]);
    const [submissions, setSubmissions] = useState<IntakeSubmission[]>([]);
    const [loading, setLoading] = useState(true);
    const [attempt, setAttempt] = useState(0);
    const [draft, setDraft] = useState({ name: "", title: "", description: "" });
    const [creating, setCreating] = useState(false);
    const [copied, setCopied] = useState<string | null>(null);
    const [formToDelete, setFormToDelete] = useState<IntakeForm | null>(null);

    const reload = useCallback(() => setAttempt((n) => n + 1), []);

    useEffect(() => {
        if (authLoading || !isAuthenticated) return;
        let cancelled = false;
        Promise.all([listIntakeForms(workspace), listIntakeSubmissions(workspace)])
            .then(([f, s]) => {
                if (cancelled) return;
                setForms(f);
                setSubmissions(s);
            })
            .catch((error) => {
                if (cancelled) return;
                notifyError(error, {
                    action: "load intake forms",
                    dedupeKey: "intake-manager",
                    onRetry: reload,
                });
            })
            .finally(() => {
                if (!cancelled) setLoading(false);
            });
        return () => {
            cancelled = true;
        };
    }, [authLoading, isAuthenticated, workspace, attempt, reload]);

    const create = async () => {
        if (!draft.name.trim() || !draft.title.trim() || creating) return;
        setCreating(true);
        try {
            await createIntakeForm(
                {
                    name: draft.name.trim(),
                    title: draft.title.trim(),
                    description: draft.description.trim() || null,
                },
                workspace,
            );
            setDraft({ name: "", title: "", description: "" });
            reload();
        } catch (error) {
            notifyError(error, { action: "create the form" });
        } finally {
            setCreating(false);
        }
    };

    const copy = async (form: IntakeForm) => {
        try {
            await navigator.clipboard.writeText(formUrl(form.token));
            setCopied(form.id);
            window.setTimeout(() => setCopied((c) => (c === form.id ? null : c)), 2000);
        } catch {
            window.prompt("Copy this link", formUrl(form.token));
        }
    };

    const review = async (
        submission: IntakeSubmission,
        decision: "approve" | "reject",
    ) => {
        try {
            if (decision === "approve") {
                const { client } = await approveIntakeSubmission(submission.id);
                router.push(`/clients/${client.id}`);
            } else {
                await rejectIntakeSubmission(submission.id);
                reload();
            }
        } catch (error) {
            notifyError(error, {
                action: decision === "approve" ? "approve the submission" : "reject the submission",
            });
            reload();
        }
    };

    return (
        <div className="flex h-full min-h-0 flex-col">
            <PageHeader
                breadcrumbs={[
                    { label: "Clients", onClick: () => router.push("/clients") },
                    { label: "Intake" },
                ]}
            >
                <h1 className={PAGE_HEADER_TITLE_CLASS}>Intake</h1>
            </PageHeader>
            <DashboardPage>
                {loading ? (
                    <div className="animate-pulse space-y-3" aria-busy="true">
                        <div className="h-24 rounded-2xl bg-gray-100" />
                        <div className="h-32 rounded-2xl bg-gray-100" />
                    </div>
                ) : (
                    <>
                        <DashboardSection title="New submissions">
                            {submissions.length === 0 ? (
                                <p className="text-sm text-gray-500">
                                    Nothing waiting for review.
                                </p>
                            ) : (
                                <ul className="flex flex-col divide-y divide-gray-100">
                                    {submissions.map((s) => (
                                        <li key={s.id} className="flex flex-col gap-2 py-3">
                                            <div className="flex flex-wrap items-baseline gap-x-4 gap-y-1">
                                                <span className="min-w-0 break-words text-sm font-medium text-gray-900">
                                                    {s.name}
                                                </span>
                                                {s.email && (
                                                    <span className="break-all text-xs text-gray-600">
                                                        {s.email}
                                                    </span>
                                                )}
                                                {s.phone && (
                                                    <span className="text-xs text-gray-600">
                                                        {s.phone}
                                                    </span>
                                                )}
                                                <span className="ml-auto text-xs text-gray-400">
                                                    {s.form_name} · {formatDate(s.created_at)}
                                                </span>
                                            </div>
                                            {s.message && (
                                                <p className="whitespace-pre-line break-words text-sm text-gray-700">
                                                    {s.message}
                                                </p>
                                            )}
                                            <div className="flex gap-2">
                                                <PillButtonUI
                                                    tone="black"
                                                    size="sm"
                                                    onClick={() => void review(s, "approve")}
                                                >
                                                    Create lead
                                                </PillButtonUI>
                                                <PillButtonUI
                                                    tone="white"
                                                    size="sm"
                                                    onClick={() => void review(s, "reject")}
                                                >
                                                    Dismiss
                                                </PillButtonUI>
                                            </div>
                                        </li>
                                    ))}
                                </ul>
                            )}
                        </DashboardSection>

                        <DashboardSection title="Intake forms">
                            {forms.length === 0 && (
                                <p className="mb-3 text-sm text-gray-500">
                                    No forms yet. Create one and share its link.
                                </p>
                            )}
                            <ul className="flex flex-col divide-y divide-gray-100">
                                {forms.map((form) => (
                                    <li key={form.id} className="flex flex-col gap-2 py-3">
                                        <div className="flex flex-wrap items-baseline gap-x-4 gap-y-1">
                                            <span className="min-w-0 break-words text-sm font-medium text-gray-900">
                                                {form.name}
                                            </span>
                                            <span className="text-xs text-gray-500">
                                                {form.enabled ? "Accepting submissions" : "Closed"}
                                            </span>
                                        </div>
                                        <p className="break-all text-xs text-gray-500">
                                            {typeof window === "undefined"
                                                ? ""
                                                : formUrl(form.token)}
                                        </p>
                                        <div className="flex flex-wrap gap-2">
                                            <PillButtonUI
                                                tone="white"
                                                size="sm"
                                                onClick={() => void copy(form)}
                                            >
                                                {copied === form.id ? "Copied" : "Copy link"}
                                            </PillButtonUI>
                                            <PillButtonUI
                                                tone="white"
                                                size="sm"
                                                onClick={async () => {
                                                    try {
                                                        await updateIntakeForm(form.id, {
                                                            enabled: !form.enabled,
                                                        });
                                                        reload();
                                                    } catch (error) {
                                                        notifyError(error, {
                                                            action: "update the form",
                                                        });
                                                    }
                                                }}
                                            >
                                                {form.enabled ? "Close form" : "Reopen form"}
                                            </PillButtonUI>
                                            <PillButtonUI
                                                tone="white"
                                                size="sm"
                                                onClick={() => setFormToDelete(form)}
                                            >
                                                Delete
                                            </PillButtonUI>
                                        </div>
                                    </li>
                                ))}
                            </ul>

                            <form
                                className="mt-4 grid grid-cols-1 gap-3 border-t border-gray-100 pt-4 sm:grid-cols-2"
                                onSubmit={(e) => {
                                    e.preventDefault();
                                    void create();
                                }}
                            >
                                <input
                                    aria-label="Internal name"
                                    placeholder="Internal name (e.g. Website)"
                                    value={draft.name}
                                    maxLength={200}
                                    onChange={(e) =>
                                        setDraft((d) => ({ ...d, name: e.target.value }))
                                    }
                                    className={cn(FORM_CONTROL_GLASS_CLASS, "h-10")}
                                />
                                <input
                                    aria-label="Heading shown to the public"
                                    placeholder="Heading shown to the public"
                                    value={draft.title}
                                    maxLength={200}
                                    onChange={(e) =>
                                        setDraft((d) => ({ ...d, title: e.target.value }))
                                    }
                                    className={cn(FORM_CONTROL_GLASS_CLASS, "h-10")}
                                />
                                <textarea
                                    aria-label="Introduction (optional)"
                                    placeholder="Introduction (optional)"
                                    rows={3}
                                    value={draft.description}
                                    maxLength={2000}
                                    onChange={(e) =>
                                        setDraft((d) => ({ ...d, description: e.target.value }))
                                    }
                                    className={cn(FORM_CONTROL_GLASS_CLASS, "py-2 sm:col-span-2")}
                                />
                                <div className="sm:col-span-2">
                                    <PillButtonUI
                                        type="submit"
                                        tone="black"
                                        loading={creating}
                                        disabled={!draft.name.trim() || !draft.title.trim()}
                                    >
                                        Create form
                                    </PillButtonUI>
                                </div>
                            </form>
                        </DashboardSection>
                    </>
                )}
            </DashboardPage>

            <ConfirmPopup
                open={formToDelete !== null}
                title="Delete this form?"
                message="Its link stops working and its submissions are deleted. Leads already created stay."
                confirmLabel="Delete form"
                confirmVariant="danger"
                onCancel={() => setFormToDelete(null)}
                onConfirm={async () => {
                    const form = formToDelete;
                    setFormToDelete(null);
                    if (!form) return;
                    try {
                        await deleteIntakeForm(form.id);
                        reload();
                    } catch (error) {
                        notifyError(error, { action: "delete the form" });
                    }
                }}
            />
        </div>
    );
}
