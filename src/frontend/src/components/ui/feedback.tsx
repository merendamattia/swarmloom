export function ActionMessage({ pending, error, success, pendingText, successText, variant }: {
  pending: boolean;
  error: unknown;
  success: boolean;
  pendingText: string;
  successText?: string;
  variant?: "inline" | "toast";
}) {
  const text = pending
    ? pendingText
    : error instanceof Error
      ? error.message
      : success
        ? successText ?? "The API confirmed the action."
        : "";
  if (!text) return null;
  return <p className={`action-message action-message-${variant ?? "inline"}`} data-error={Boolean(error)} data-pending={pending} role={error ? "alert" : "status"} aria-live="polite">{text}</p>;
}
