import { useEffect, useState } from "react";

type Locale = "ru" | "en";
type AuthNotice = "google-connected" | "google-cancelled" | "google-failed" | "google-conflict" | "google-signed-out";

const messages: Record<Locale, Record<AuthNotice, string> & { signIn: string; signOut: string; dismiss: string }> = {
  ru: {
    signIn: "Войти через Google",
    signOut: "Выйти",
    dismiss: "Закрыть сообщение",
    "google-connected": "Профиль связан с Google.",
    "google-cancelled": "Вход через Google отменён.",
    "google-failed": "Не удалось выполнить вход через Google. Попробуйте ещё раз.",
    "google-conflict": "Этот Google-аккаунт связан с другим профилем. Данные текущего профиля сохранены.",
    "google-signed-out": "Вы вышли из профиля. Он сохранён; задайте новый ник, чтобы продолжить как гость.",
  },
  en: {
    signIn: "Continue with Google",
    signOut: "Sign out",
    dismiss: "Dismiss message",
    "google-connected": "Your profile is linked to Google.",
    "google-cancelled": "Google sign-in was canceled.",
    "google-failed": "Google sign-in could not be completed. Try again.",
    "google-conflict": "This Google account is linked to another profile. Your current profile is unchanged.",
    "google-signed-out": "You signed out. Your profile is saved; choose a new nickname to continue as a guest.",
  },
};

type GoogleAuthControlProps = {
  locale: Locale;
  authProvider?: "google";
  onSignedOut: () => void;
};

function isAuthNotice(value: string | null): value is AuthNotice {
  return value === "google-connected"
    || value === "google-cancelled"
    || value === "google-failed"
    || value === "google-conflict"
    || value === "google-signed-out";
}

export function GoogleAuthControl({ locale, authProvider, onSignedOut }: GoogleAuthControlProps) {
  const [enabled, setEnabled] = useState(false);
  const [notice, setNotice] = useState<AuthNotice | null>(null);
  const [isSigningOut, setIsSigningOut] = useState(false);
  const copy = messages[locale];

  useEffect(() => {
    const controller = new AbortController();
    fetch("/api/auth/google/config", { cache: "no-store", signal: controller.signal })
      .then(async (response) => {
        if (!response.ok) return false;
        const payload = (await response.json()) as { googleEnabled?: boolean };
        return payload.googleEnabled === true;
      })
      .then((available) => {
        if (!controller.signal.aborted) setEnabled(available);
      })
      .catch(() => {
        if (!controller.signal.aborted) setEnabled(false);
      });

    const query = new URLSearchParams(window.location.search);
    const result = query.get("auth");
    if (isAuthNotice(result)) {
      setNotice(result);
      query.delete("auth");
      const search = query.toString();
      window.history.replaceState({}, "", `${window.location.pathname}${search ? `?${search}` : ""}${window.location.hash}`);
    }

    return () => controller.abort();
  }, []);

  async function signOut() {
    if (isSigningOut) return;
    setIsSigningOut(true);
    try {
      const response = await fetch("/api/auth/logout", { method: "POST", credentials: "same-origin" });
      if (!response.ok) throw new Error("logout failed");
      onSignedOut();
      window.location.assign("/?auth=google-signed-out");
    } catch {
      setNotice("google-failed");
      setIsSigningOut(false);
    }
  }

  if (!enabled) return notice ? <AuthNoticeBanner message={copy[notice]} onDismiss={() => setNotice(null)} dismissLabel={copy.dismiss} /> : null;

  return (
    <>
      {authProvider === "google" ? (
        <button
          className="google-auth-button"
          type="button"
          aria-label={copy.signOut}
          title={copy.signOut}
          disabled={isSigningOut}
          onClick={() => void signOut()}
        >
          <GoogleMark />
          <span className="google-auth-button__label">{copy.signOut}</span>
        </button>
      ) : (
        <a className="google-auth-button" href="/api/auth/google/start" aria-label={copy.signIn} title={copy.signIn}>
          <GoogleMark />
          <span className="google-auth-button__label">{copy.signIn}</span>
        </a>
      )}
      {notice && <AuthNoticeBanner message={copy[notice]} onDismiss={() => setNotice(null)} dismissLabel={copy.dismiss} />}
    </>
  );
}

function GoogleMark() {
  return <span className="google-auth-button__mark" aria-hidden="true">G</span>;
}

function AuthNoticeBanner({
  message,
  onDismiss,
  dismissLabel,
}: {
  message: string;
  onDismiss: () => void;
  dismissLabel: string;
}) {
  return (
    <div className="auth-notice" role="status">
      <span>{message}</span>
      <button type="button" aria-label={dismissLabel} onClick={onDismiss}>×</button>
    </div>
  );
}
