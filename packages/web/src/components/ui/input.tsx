"use client";

import type { InputHTMLAttributes, TextareaHTMLAttributes } from "react";
import { forwardRef, useId } from "react";

const baseStyles =
  "w-full bg-white border border-slate-200 rounded-lg px-4 py-2.5 text-sm text-slate-900 placeholder-slate-400 focus:outline-none focus-visible:border-accent focus-visible:ring-1 focus-visible:ring-accent/25 transition-colors";

const errorStyles = "border-red-500 focus-visible:border-red-500 focus-visible:ring-red-500/30";

/** Prefer an explicit id, then a label-derived slug, then a stable useId(). */
function useControlId(id: string | undefined, label: string | undefined): string {
  const fallback = useId();
  if (id) return id;
  if (label) return label.toLowerCase().replace(/\s+/g, "-");
  return fallback;
}

interface InputProps extends InputHTMLAttributes<HTMLInputElement> {
  label?: string;
  error?: string;
}

export const Input = forwardRef<HTMLInputElement, InputProps>(
  ({ label, error, className = "", id, ...props }, ref) => {
    const inputId = useControlId(id, label);
    return (
      <div>
        {label && (
          <label htmlFor={inputId} className="block text-xs font-medium text-slate-500 mb-1.5">
            {label}
          </label>
        )}
        <input
          ref={ref}
          id={inputId}
          className={`${baseStyles} ${error ? errorStyles : ""} ${className}`}
          aria-invalid={error ? "true" : undefined}
          aria-describedby={error ? `${inputId}-error` : undefined}
          {...props}
        />
        {error && (
          <p id={`${inputId}-error`} className="text-xs text-red-600 mt-1" role="alert">
            {error}
          </p>
        )}
      </div>
    );
  },
);
Input.displayName = "Input";

interface TextareaProps extends TextareaHTMLAttributes<HTMLTextAreaElement> {
  label?: string;
  error?: string;
}

export const Textarea = forwardRef<HTMLTextAreaElement, TextareaProps>(
  ({ label, error, className = "", id, ...props }, ref) => {
    const inputId = useControlId(id, label);
    return (
      <div>
        {label && (
          <label htmlFor={inputId} className="block text-xs font-medium text-slate-500 mb-1.5">
            {label}
          </label>
        )}
        <textarea
          ref={ref}
          id={inputId}
          className={`${baseStyles} resize-none ${error ? errorStyles : ""} ${className}`}
          aria-invalid={error ? "true" : undefined}
          aria-describedby={error ? `${inputId}-error` : undefined}
          {...props}
        />
        {error && (
          <p id={`${inputId}-error`} className="text-xs text-red-600 mt-1" role="alert">
            {error}
          </p>
        )}
      </div>
    );
  },
);
Textarea.displayName = "Textarea";

interface SelectProps extends InputHTMLAttributes<HTMLSelectElement> {
  label?: string;
  error?: string;
  children: React.ReactNode;
}

export function Select({ label, error, children, className = "", id, ...props }: SelectProps) {
  const inputId = useControlId(id, label);
  return (
    <div>
      {label && (
        <label htmlFor={inputId} className="block text-xs font-medium text-slate-500 mb-1.5">
          {label}
        </label>
      )}
      <select
        id={inputId}
        className={`${baseStyles} ${error ? errorStyles : ""} ${className}`}
        aria-invalid={error ? "true" : undefined}
        aria-describedby={error ? `${inputId}-error` : undefined}
        {...(props as React.SelectHTMLAttributes<HTMLSelectElement>)}
      >
        {children}
      </select>
      {error && (
        <p id={`${inputId}-error`} className="text-xs text-red-600 mt-1" role="alert">
          {error}
        </p>
      )}
    </div>
  );
}
