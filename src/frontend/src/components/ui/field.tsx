import { Info } from "lucide-react";
import { forwardRef, type InputHTMLAttributes, type ReactNode, type SelectHTMLAttributes } from "react";
import { cn } from "@/lib/utils";

export function Field({ htmlFor, label, help, description, error, wide, children }: {
  htmlFor: string;
  label: string;
  help?: string;
  description?: string;
  error?: string;
  wide?: boolean;
  children: ReactNode;
}) {
  const descriptionId = description ? `${htmlFor}-description` : undefined;
  const errorId = error ? `${htmlFor}-error` : undefined;
  return (
    <div className={cn("field", wide && "settings-wide")}>
      <div className="field-label">
        <label htmlFor={htmlFor}>{label}</label>
        {help ? <span className="info-tip" tabIndex={0} title={help} aria-label={`More information: ${help}`}><Info aria-hidden="true" /></span> : null}
      </div>
      {children}
      {description ? <p className="field-help" id={descriptionId}>{description}</p> : null}
      {error ? <p className="field-error" id={errorId} role="alert">{error}</p> : null}
    </div>
  );
}

export const Input = forwardRef<HTMLInputElement, InputHTMLAttributes<HTMLInputElement>>(function Input({ className, ...props }, ref) {
  return <input className={cn("input", className)} ref={ref} {...props} />;
});

export const Select = forwardRef<HTMLSelectElement, SelectHTMLAttributes<HTMLSelectElement>>(function Select({ className, ...props }, ref) {
  return <select className={cn("select", className)} ref={ref} {...props} />;
});

export function CheckboxField({ checked, onChange, children, disabled }: {
  checked: boolean;
  onChange: (checked: boolean) => void;
  children: ReactNode;
  disabled?: boolean;
}) {
  return (
    <label className="toggle-field">
      <input type="checkbox" checked={checked} disabled={disabled} onChange={(event) => onChange(event.target.checked)} />
      <span>{children}</span>
    </label>
  );
}
