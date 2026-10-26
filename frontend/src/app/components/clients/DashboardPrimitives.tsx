"use client";

import { useId, useState, type ReactNode } from "react";
import { cn } from "@/app/lib/utils";
import { FORM_CONTROL_GLASS_CLASS } from "@/app/components/ui/form-field";
import { LIQUID_GLASS_SUBTLE_CLASS } from "@/shared/ui/LiquidGlassUI";
import type { ClientStatus } from "@/app/components/shared/types";

export const STATUS_LABELS: Record<ClientStatus, string> = {
    lead: "Lead",
    active: "Active",
    closed: "Closed",
};

export function formatDate(iso: string) {
    return new Date(iso).toLocaleDateString(undefined, {
        day: "numeric",
        month: "short",
        year: "numeric",
    });
}

/** A Notion-style page body: a centred column of titled sections. */
export function DashboardPage({ children }: { children: ReactNode }) {
    return (
        <div className="min-h-0 flex-1 overflow-y-auto">
            <div className="mx-auto flex w-full max-w-4xl flex-col gap-6 px-3 pb-12 pt-2 md:px-6.5">
                {children}
            </div>
        </div>
    );
}

export function DashboardSection({
    title,
    action,
    children,
}: {
    title: string;
    action?: ReactNode;
    children: ReactNode;
}) {
    const headingId = useId();
    return (
        <section aria-labelledby={headingId} className="flex flex-col gap-2">
            <div className="flex items-center justify-between gap-3">
                <h2
                    id={headingId}
                    className="font-serif text-xl text-gray-800"
                >
                    {title}
                </h2>
                {action}
            </div>
            <div
                className={cn(
                    "rounded-2xl p-4",
                    LIQUID_GLASS_SUBTLE_CLASS,
                )}
            >
                {children}
            </div>
        </section>
    );
}

export function DashboardSkeleton() {
    return (
        <DashboardPage>
            <div className="animate-pulse space-y-3" aria-busy="true">
                <div className="h-8 w-1/2 rounded bg-gray-200" />
                <div className="h-32 rounded-2xl bg-gray-100" />
                <div className="h-24 rounded-2xl bg-gray-100" />
                <div className="h-24 rounded-2xl bg-gray-100" />
            </div>
        </DashboardPage>
    );
}

/** A labelled value that saves on blur (or Enter) when it changed. */
export function EditableField({
    label,
    value,
    onSave,
    multiline = false,
    type = "text",
    placeholder = "Add…",
    readOnly = false,
}: {
    label: string;
    value: string | null;
    onSave: (next: string) => Promise<void> | void;
    multiline?: boolean;
    type?: string;
    placeholder?: string;
    readOnly?: boolean;
}) {
    const id = useId();
    const [draft, setDraft] = useState(value ?? "");
    // Follow the saved value when it changes from outside (a reload, a save).
    const [seen, setSeen] = useState(value);
    if (seen !== value) {
        setSeen(value);
        setDraft(value ?? "");
    }

    const commit = () => {
        if (draft.trim() !== (value ?? "").trim()) void onSave(draft.trim());
    };
    const common = {
        id,
        value: draft,
        placeholder,
        disabled: readOnly,
        onChange: (
            e: React.ChangeEvent<HTMLInputElement | HTMLTextAreaElement>,
        ) => setDraft(e.target.value),
        onBlur: commit,
    };
    return (
        <div className="flex min-w-0 flex-col gap-1">
            <label htmlFor={id} className="text-xs font-medium text-gray-500">
                {label}
            </label>
            {multiline ? (
                <textarea
                    {...common}
                    rows={5}
                    className={cn(FORM_CONTROL_GLASS_CLASS, "py-2")}
                />
            ) : (
                <input
                    {...common}
                    type={type}
                    onKeyDown={(e) => {
                        if (e.key === "Enter") e.currentTarget.blur();
                    }}
                    className={cn(FORM_CONTROL_GLASS_CLASS, "h-10")}
                />
            )}
        </div>
    );
}

export function SelectField<T extends string>({
    label,
    value,
    options,
    onChange,
    disabled,
}: {
    label: string;
    value: T;
    options: { value: T; label: string }[];
    onChange: (next: T) => void;
    disabled?: boolean;
}) {
    const id = useId();
    return (
        <div className="flex min-w-0 flex-col gap-1">
            <label htmlFor={id} className="text-xs font-medium text-gray-500">
                {label}
            </label>
            <select
                id={id}
                value={value}
                disabled={disabled}
                onChange={(e) => onChange(e.target.value as T)}
                className={cn(FORM_CONTROL_GLASS_CLASS, "h-10")}
            >
                {options.map((o) => (
                    <option key={o.value} value={o.value}>
                        {o.label}
                    </option>
                ))}
            </select>
        </div>
    );
}
