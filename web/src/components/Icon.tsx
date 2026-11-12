import type { ReactNode } from "react";

export type IconName = "globe" | "pin" | "send" | "compass" | "menu" | "map" | "chat" | "users" | "sun" | "moon" | "settings" | "close";

export function Icon({ name }: { name: IconName }) {
  const paths: Record<IconName, ReactNode> = {
    globe: <><circle cx="12" cy="12" r="9" /><path d="M3.5 9h17M3.5 15h17M12 3a14 14 0 0 1 0 18M12 3a14 14 0 0 0 0 18" /></>,
    pin: <><path d="M20 10c0 5-8 11-8 11S4 15 4 10a8 8 0 1 1 16 0Z" /><circle cx="12" cy="10" r="2.5" /></>,
    send: <><path d="m22 2-7 20-4-9-9-4Z" /><path d="M22 2 11 13" /></>,
    compass: <><circle cx="12" cy="12" r="9" /><path d="m15.5 8.5-2 5-5 2 2-5Z" /></>,
    menu: <><path d="M4 6h16M4 12h16M4 18h16" /></>,
    map: <><path d="m3 6 6-3 6 3 6-3v15l-6 3-6-3-6 3Z" /><path d="M9 3v15M15 6v15" /></>,
    chat: <><path d="M20 11.5a7.5 7.5 0 0 1-7.5 7.5H6l-3 2v-6.5a7.5 7.5 0 1 1 17.5-3Z" /><path d="M8 11h8M8 14h5" /></>,
    users: <><circle cx="9" cy="8" r="3.2" /><path d="M3.5 20v-1.4a5.5 5.5 0 0 1 11 0V20ZM16 5.2a3.2 3.2 0 0 1 0 6.2M17 14a5 5 0 0 1 3.5 4.6V20" /></>,
    sun: <><circle cx="12" cy="12" r="4" /><path d="M12 2v2M12 20v2M4.93 4.93l1.42 1.42m11.3 11.3 1.42 1.42M2 12h2m16 0h2M4.93 19.07l1.42-1.42m11.3-11.3 1.42-1.42" /></>,
    moon: <path d="M20.8 13.1A8.5 8.5 0 0 1 10.9 3.2 8.5 8.5 0 1 0 20.8 13Z" />,
    settings: <><circle cx="12" cy="12" r="3" /><path d="m19.4 15 .1.1 1.5 1.2-1.5 2.6-1.9-.7a7.9 7.9 0 0 1-1.7 1l-.3 2h-3l-.3-2a7.9 7.9 0 0 1-1.7-1l-1.9.7-1.5-2.6 1.5-1.2a7.1 7.1 0 0 1 0-2l-1.5-1.2 1.5-2.6 1.9.7a7.9 7.9 0 0 1 1.7-1l.3-2h3l.3 2a7.9 7.9 0 0 1 1.7 1l1.9-.7 1.5 2.6-1.5 1.2a7.1 7.1 0 0 1-.1 1.9Z" /></>,
    close: <><path d="m6 6 12 12M18 6 6 18" /></>,
  };

  return <svg aria-hidden="true" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">{paths[name]}</svg>;
}
