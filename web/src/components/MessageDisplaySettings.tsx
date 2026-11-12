import { useEffect, useRef } from "react";
import {
  PUBLIC_MESSAGE_DISPLAY_OPTIONS_SECONDS,
  type PublicMessageDisplaySeconds,
} from "../publicMessageSettings";
import type { MessageDisplayPreferenceStatus } from "../hooks/useMessageDisplayPreference";
import { Icon } from "./Icon";

type MessageDisplaySettingsLabels = {
  title: string;
  displayDuration: string;
  description: string;
  savedOnDevice: string;
  syncedToAccount: string;
  loading: string;
  saving: string;
  error: string;
  close: string;
};

type MessageDisplaySettingsProps = {
  open: boolean;
  locale: "ru" | "en";
  seconds: PublicMessageDisplaySeconds;
  status: MessageDisplayPreferenceStatus;
  labels: MessageDisplaySettingsLabels;
  onClose: () => void;
  onChange: (seconds: PublicMessageDisplaySeconds) => void;
};

export function MessageDisplaySettings({
  open,
  locale,
  seconds,
  status,
  labels,
  onClose,
  onChange,
}: MessageDisplaySettingsProps) {
  const dialogRef = useRef<HTMLDialogElement>(null);

  useEffect(() => {
    const dialog = dialogRef.current;
    if (!dialog) return;
    if (open && !dialog.open) dialog.showModal();
    else if (!open && dialog.open) dialog.close();
  }, [open]);

  const isBusy = status === "loading" || status === "saving";
  const statusText = status === "loading"
    ? labels.loading
    : status === "saving"
      ? labels.saving
      : status === "error"
        ? labels.error
        : status === "account"
          ? labels.syncedToAccount
          : labels.savedOnDevice;

  return (
    <dialog
      ref={dialogRef}
      className="preferences-dialog"
      aria-labelledby="preferences-title"
      onCancel={(event) => {
        event.preventDefault();
        onClose();
      }}
      onClick={(event) => {
        if (event.target === dialogRef.current) onClose();
      }}
    >
      <div className="preferences-dialog__content">
        <header className="preferences-dialog__heading">
          <h2 id="preferences-title">{labels.title}</h2>
          <button className="icon-button" type="button" aria-label={labels.close} onClick={onClose}>
            <Icon name="close" />
          </button>
        </header>

        <fieldset className="message-duration-setting" disabled={isBusy} aria-describedby="message-duration-description message-duration-status">
          <legend>{labels.displayDuration}</legend>
          <p id="message-duration-description">{labels.description}</p>
          <div className="message-duration-setting__options">
            {PUBLIC_MESSAGE_DISPLAY_OPTIONS_SECONDS.map((option) => (
              <label className="message-duration-option" key={option}>
                <input
                  type="radio"
                  name="message-display-duration"
                  value={option}
                  checked={seconds === option}
                  onChange={() => onChange(option)}
                />
                <span>{option} {locale === "ru" ? "сек" : "sec"}</span>
              </label>
            ))}
          </div>
        </fieldset>

        <p
          id="message-duration-status"
          className={`message-duration-status${status === "error" ? " message-duration-status--error" : ""}`}
          role={status === "error" ? "alert" : "status"}
          aria-live="polite"
        >
          {statusText}
        </p>
      </div>
    </dialog>
  );
}
