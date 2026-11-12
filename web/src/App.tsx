import {
  lazy,
  Suspense,
  type CSSProperties,
  type FormEvent,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import { Icon } from "./components/Icon";
import { FriendsPanel } from "./components/FriendsPanel";
import { GoogleAuthControl } from "./components/GoogleAuthControl";
import { MessageDisplaySettings } from "./components/MessageDisplaySettings";
import { ApiError } from "./apiError";
import { useGuestFriendships, type FriendshipState, type FriendshipView, type GuestFriendshipError } from "./hooks/useGuestFriendships";
import { useGuestFollows, type GuestFollowError } from "./hooks/useGuestFollows";
import { clearStoredGuestNickname, useGuestIdentity } from "./hooks/useGuestIdentity";
import { useMessageDisplayPreference } from "./hooks/useMessageDisplayPreference";
import { usePublicStream } from "./hooks/usePublicStream";
import type { PublicMessage } from "./types";

const INITIAL_CELLS = ["sz", "u4", "u8", "sp", "g0", "v1"];
const GlobeCanvas = lazy(() => import("./components/GlobeCanvas").then((module) => ({ default: module.GlobeCanvas })));
const onlineCountFormatters = {
  ru: new Intl.NumberFormat("ru-RU"),
  en: new Intl.NumberFormat("en-US"),
};

const copy = {
  ru: {
    navigation: "Навигация",
    map: "Карта",
    feed: "Лента сообщений",
    friends: "Друзья",
    social: "Ваш круг",
    incomingRequests: "Входящие",
    outgoingRequests: "Отправленные",
    friendList: "Друзья",
    unreadFriendRequests: (count: number) => `Непрочитанных запросов: ${count}`,
    addFriend: "Добавить",
    acceptFriend: "Принять",
    requestSent: "Запрос отправлен",
    friendsStatus: "В друзьях",
    declineRequest: "Отклонить",
    cancelRequest: "Отменить",
    removeFriend: "Удалить",
    emptyIncomingRequests: "Входящих запросов пока нет.",
    emptyOutgoingRequests: "Вы ещё не отправляли запросы.",
    emptyFriends: "Здесь появятся люди, чьи запросы вы приняли.",
    loadingFriends: "Загружаем…",
    retry: "Повторить",
    loadMore: "Показать ещё",
    friendReadFailed: "Не удалось загрузить список. Проверьте соединение и попробуйте ещё раз.",
    friendRequestFailed: "Не удалось обновить дружбу. Проверьте соединение и попробуйте ещё раз.",
    friendRequestReceived: "У вас уже есть входящий запрос. Откройте раздел «Друзья».",
    friendRequestAlreadyExists: "Вы уже друзья.",
    friendTargetUnavailable: "Пользователь сейчас недоступен.",
    friendRequestNoLongerPending: "Этот запрос уже обработан.",
    friendRequestRateLimited: (seconds?: number) => seconds === undefined
      ? "Слишком много запросов в друзья. Попробуйте позже."
      : `Слишком много запросов в друзья. Повторите через ${seconds} сек.`,
    preferences: "Настройки",
    messageDisplayDuration: "Показ сообщений",
    messageDisplayDescription: "Сообщения исчезают с карты через выбранное время.",
    preferenceSavedOnDevice: "Сохранено на этом устройстве",
    preferenceSyncedToAccount: "Синхронизировано с профилем",
    preferenceLoading: "Загружаем настройки…",
    preferenceSaving: "Сохраняем…",
    preferenceError: "Не удалось сохранить. Попробуйте ещё раз.",
    closeSettings: "Закрыть настройки",
    location: "Тбилиси, Грузия",
    onlineSessions: (count: number | null) => count === null
      ? "— онлайн"
      : `${onlineCountFormatters.ru.format(count)} онлайн`,
    connected: "Подключено",
    connecting: "Подключение…",
    noConnection: "Нет соединения",
    switchToLight: "Включить светлую тему",
    switchToDark: "Включить тёмную тему",
    language: "Язык интерфейса",
    collapseSidebar: "Свернуть меню",
    expandSidebar: "Развернуть меню",
    openMenu: "Открыть меню",
    closeMenu: "Закрыть меню",
    mapRegion: "Глобус сообщений",
    globeMarkers: "Сообщения на глобусе",
    globeError: "Не удалось загрузить карту",
    globeLoading: "Загружается карта…",
    mapHeading: "Карта",
    zoomIn: "Приблизить",
    zoomOut: "Отдалить",
    resetView: "Вернуться к планете",
    composerLabel: "Ваше сообщение",
    composerPlaceholder: "Напишите короткое сообщение…",
    nicknameLabel: "Ваш никнейм",
    nicknamePlaceholder: "Например, alex",
    nicknameHint: "Он будет виден рядом с сообщением",
    nicknameInvalid: "Никнейм должен содержать от 2 до 24 символов",
    nicknameTaken: "Этот никнейм уже занят",
    guestSessionRateLimited: "Слишком много попыток. Подождите перед созданием новой сессии",
    nicknameLoading: "Проверяем вашу сессию…",
    rateLimited: (seconds?: number) => seconds === undefined
      ? "Подождите немного перед следующим сообщением"
      : `Подождите ${seconds} сек. перед следующим сообщением`,
    sendFailed: "Не удалось отправить сообщение. Проверьте соединение и попробуйте ещё раз",
    identityFailed: "Не удалось сохранить никнейм. Попробуйте ещё раз",
    chooseLocation: "Выбрать место на карте",
    clickMap: "Нажмите на карту, чтобы выбрать место",
    sendFrom: "Отправить из",
    sendMessage: "Отправить сообщение",
    messages: "Сообщения",
    all: "Все",
    nearby: "Рядом",
    filterMessages: "Фильтр сообщений",
    publicMessages: "Публичные сообщения",
    emptyStream: "Пока нет сообщений поблизости.",
    reply: "Ответить",
    follow: "Подписаться",
    followAuthor: "Подписаться на",
    following: "Вы подписаны",
    unfollowAuthor: "Отписаться от",
    followFailed: "Не удалось изменить подписку. Проверьте соединение и попробуйте ещё раз",
    themeDark: "Тёмная тема",
    themeLight: "Светлая тема",
  },
  en: {
    navigation: "Navigation",
    map: "Map",
    feed: "Message feed",
    friends: "Friends",
    social: "Your circle",
    incomingRequests: "Incoming",
    outgoingRequests: "Sent",
    friendList: "Friends",
    unreadFriendRequests: (count: number) => `Unread requests: ${count}`,
    addFriend: "Add friend",
    acceptFriend: "Accept",
    requestSent: "Request sent",
    friendsStatus: "Friends",
    declineRequest: "Decline",
    cancelRequest: "Cancel",
    removeFriend: "Remove",
    emptyIncomingRequests: "No incoming requests yet.",
    emptyOutgoingRequests: "You have not sent any requests.",
    emptyFriends: "People you accept will appear here.",
    loadingFriends: "Loading…",
    retry: "Retry",
    loadMore: "Load more",
    friendReadFailed: "Could not load this list. Check your connection and try again.",
    friendRequestFailed: "Could not update this friendship. Check your connection and try again.",
    friendRequestReceived: "You already have an incoming request. Open Friends to review it.",
    friendRequestAlreadyExists: "You are already friends.",
    friendTargetUnavailable: "This person is not available right now.",
    friendRequestNoLongerPending: "This request has already been handled.",
    friendRequestRateLimited: (seconds?: number) => seconds === undefined
      ? "Too many friend requests. Please try again later."
      : `Too many friend requests. Try again in ${seconds}s.`,
    preferences: "Preferences",
    messageDisplayDuration: "Message display",
    messageDisplayDescription: "Messages fade from the map after this time.",
    preferenceSavedOnDevice: "Saved on this device",
    preferenceSyncedToAccount: "Synced to your account",
    preferenceLoading: "Loading settings…",
    preferenceSaving: "Saving…",
    preferenceError: "Could not save. Please try again.",
    closeSettings: "Close settings",
    location: "Tbilisi, Georgia",
    onlineSessions: (count: number | null) => count === null
      ? "— online"
      : `${onlineCountFormatters.en.format(count)} online`,
    connected: "Connected",
    connecting: "Connecting…",
    noConnection: "Offline",
    switchToLight: "Switch to light theme",
    switchToDark: "Switch to dark theme",
    language: "Interface language",
    collapseSidebar: "Collapse sidebar",
    expandSidebar: "Expand sidebar",
    openMenu: "Open menu",
    closeMenu: "Close menu",
    mapRegion: "Message globe",
    globeMarkers: "Messages on the globe",
    globeError: "The map could not be loaded",
    globeLoading: "Loading map…",
    mapHeading: "Map",
    zoomIn: "Zoom in",
    zoomOut: "Zoom out",
    resetView: "Reset globe view",
    composerLabel: "Your message",
    composerPlaceholder: "Write a short message…",
    nicknameLabel: "Your nickname",
    nicknamePlaceholder: "For example, alex",
    nicknameHint: "It appears beside your message",
    nicknameInvalid: "Use a nickname between 2 and 24 characters",
    nicknameTaken: "That nickname is already taken",
    guestSessionRateLimited: "Too many attempts. Wait before creating another session",
    nicknameLoading: "Checking your session…",
    rateLimited: (seconds?: number) => seconds === undefined
      ? "Please wait before sending another message"
      : `Please wait ${seconds}s before sending another message`,
    sendFailed: "Message could not be sent. Check your connection and try again",
    identityFailed: "Nickname could not be saved. Please try again",
    chooseLocation: "Choose a place on the map",
    clickMap: "Click the map to choose a place",
    sendFrom: "Posting from",
    sendMessage: "Send message",
    messages: "Messages",
    all: "All",
    nearby: "Nearby",
    filterMessages: "Filter messages",
    publicMessages: "Public messages",
    emptyStream: "No messages nearby yet.",
    reply: "Reply",
    follow: "Follow",
    followAuthor: "Follow",
    following: "Following",
    unfollowAuthor: "Unfollow",
    followFailed: "Could not update the follow. Check your connection and try again",
    themeDark: "Dark theme",
    themeLight: "Light theme",
  },
} as const;

type Locale = keyof typeof copy;
type Theme = "dark" | "light";
type Copy = (typeof copy)[Locale];
function timeAgo(date: string, locale: Locale): string {
  const minutes = Math.floor(Math.max(0, Date.now() - new Date(date).getTime()) / 60_000);
  if (minutes === 0) return locale === "ru" ? "сейчас" : "now";
  return new Intl.RelativeTimeFormat(locale, { numeric: "auto", style: "short" }).format(-minutes, "minute");
}

function isNearby(message: PublicMessage, latitude: number, longitude: number): boolean {
  const latitudeKm = (message.latitude - latitude) * 111;
  const longitudeKm = (message.longitude - longitude) * 111 * Math.cos((latitude * Math.PI) / 180);
  return Math.hypot(latitudeKm, longitudeKm) <= 1_200;
}

function Avatar({ message, small = false }: { message: PublicMessage; small?: boolean }) {
  return (
    <span aria-hidden="true" className={`avatar${small ? " avatar--small" : ""}`} style={{ "--avatar-color": message.avatarColor } as CSSProperties}>
      {message.initials}
    </span>
  );
}

function localizedIdentityError(code: string | null, labels: Copy) {
  if (code === "nickname_taken") return labels.nicknameTaken;
  if (code === "nickname_invalid") return labels.nicknameInvalid;
  if (code === "guest_session_rate_limited") return labels.guestSessionRateLimited;
  if (code === "guest_session_unavailable" || code === "guest_session_required") return labels.identityFailed;
  return null;
}

function MessageCard({
  message,
  onReply,
  onFollowToggle,
  locale,
  labels,
  expiring,
  isFollowing,
  followPending,
  showSocialActions,
  friendshipState,
  friendPending,
  onFriendAction,
}: {
  message: PublicMessage;
  onReply: () => void;
  onFollowToggle: () => void;
  locale: Locale;
  labels: Copy;
  expiring: boolean;
  isFollowing: boolean;
  followPending: boolean;
  showSocialActions: boolean;
  friendshipState: FriendshipState;
  friendPending: boolean;
  onFriendAction: () => void;
}) {
  return (
    <article className={`message-card${expiring ? " message-card--expiring" : ""}`}>
      <div className="message-card__top">
        <Avatar message={message} small />
        <div className="message-card__person">
          <strong>{message.authorName}</strong>
          <span>{message.authorHandle}</span>
        </div>
        <time>{timeAgo(message.createdAt, locale)}</time>
      </div>
      <p>{message.body}</p>
      <div className="message-card__bottom">
        <span className="message-location"><span className="location-dot" />{message.city}, {message.country}</span>
        <div className="message-card__actions">
          {showSocialActions && (
            <button
              className={`follow-button${isFollowing ? " follow-button--active" : ""}`}
              type="button"
              aria-label={`${isFollowing ? labels.unfollowAuthor : labels.followAuthor} ${message.authorName}`}
              aria-pressed={isFollowing}
              aria-busy={followPending}
              disabled={followPending || expiring}
              onClick={onFollowToggle}
            >
              {isFollowing ? labels.following : labels.follow}
            </button>
          )}
          {showSocialActions && friendshipState !== "friends" && friendshipState !== "sent" && (
            <button
              className={`friend-button${friendshipState === "received" ? " friend-button--accept" : ""}`}
              type="button"
              aria-label={`${friendshipState === "received" ? labels.acceptFriend : labels.addFriend} ${message.authorName}`}
              aria-busy={friendPending}
              disabled={friendPending || expiring}
              onClick={onFriendAction}
            >
              {friendshipState === "received" ? labels.acceptFriend : labels.addFriend}
            </button>
          )}
          {showSocialActions && friendshipState === "sent" && (
            <span className="friendship-status">{labels.requestSent}</span>
          )}
          {showSocialActions && friendshipState === "friends" && (
            <span className="friendship-status friendship-status--active">{labels.friendsStatus}</span>
          )}
          <button className="reply-button" type="button" onClick={onReply} aria-label={`${labels.reply} ${message.authorName}`}>
            {labels.reply}
          </button>
        </div>
      </div>
    </article>
  );
}

export default function App() {
  const [cells, setCells] = useState<string[]>(INITIAL_CELLS);
  const [draft, setDraft] = useState("");
  const [activeTab, setActiveTab] = useState<"all" | "nearby">("all");
  const [activeSection, setActiveSection] = useState<"map" | "feed" | "friends">("map");
  const [activeFriendView, setActiveFriendView] = useState<FriendshipView>("incoming");
  const [isPickingLocation, setIsPickingLocation] = useState(false);
  const [sendError, setSendError] = useState<{ code: string; retryAfterSeconds?: number } | null>(null);
  const [isSending, setIsSending] = useState(false);
  const [sidebarCollapsed, setSidebarCollapsed] = useState(() => localStorage.getItem("meridian-sidebar-collapsed") === "true");
  const [mobileMenuOpen, setMobileMenuOpen] = useState(false);
  const [isNarrowViewport, setIsNarrowViewport] = useState(() => window.matchMedia("(max-width: 760px)").matches);
  const [theme, setTheme] = useState<Theme>(() => localStorage.getItem("meridian-theme") === "light" ? "light" : "dark");
  const [locale, setLocale] = useState<Locale>(() => localStorage.getItem("meridian-language") === "en" ? "en" : "ru");
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [location, setLocation] = useState({ latitude: 41.7151, longitude: 44.8271 });
  const guest = useGuestIdentity();
  const messageDisplayPreference = useMessageDisplayPreference(guest.identity?.authProvider);
  const { messages, expiringIds, sendMessage, status, friendshipRevision, onlineCount } = usePublicStream(
    cells,
    guest.identity?.id ?? null,
    messageDisplayPreference.seconds,
  );
  const t = copy[locale];
  const locationLabel = Math.abs(location.latitude - 41.7151) < 0.01 && Math.abs(location.longitude - 44.8271) < 0.01
    ? t.location
    : `${location.latitude.toFixed(2)}°, ${location.longitude.toFixed(2)}°`;
  const sortedMessages = useMemo(
    () => [...messages].sort((a, b) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime()),
    [messages],
  );
  const visibleMessages = useMemo(
    () => activeTab === "nearby" ? sortedMessages.filter((message) => isNearby(message, location.latitude, location.longitude)) : sortedMessages,
    [activeTab, location.latitude, location.longitude, sortedMessages],
  );
  const displayedMessages = useMemo(() => visibleMessages.slice(0, 8), [visibleMessages]);
  const follows = useGuestFollows(
    displayedMessages.flatMap((message) => message.authorProfileId ? [message.authorProfileId] : []),
    guest.identity,
    guest.ensureGuestIdentity,
  );
  const friendshipProfileIDs = useMemo(
    () => displayedMessages.flatMap((message) => (
      message.authorProfileId && message.authorProfileId !== guest.identity?.id ? [message.authorProfileId] : []
    )),
    [displayedMessages, guest.identity?.id],
  );
  const friendships = useGuestFriendships(friendshipProfileIDs, guest.identity, guest.ensureGuestIdentity);
  const refreshSocialState = friendships.refreshSocialState;
  const activeSectionRef = useRef(activeSection);
  const activeFriendViewRef = useRef(activeFriendView);

  useEffect(() => {
    activeSectionRef.current = activeSection;
    activeFriendViewRef.current = activeFriendView;
  }, [activeFriendView, activeSection]);

  useEffect(() => {
    if (friendshipRevision === 0) return;
    const visibleView = activeSectionRef.current === "friends" ? activeFriendViewRef.current : null;
    void refreshSocialState(visibleView);
  }, [friendshipRevision, refreshSocialState]);

  useEffect(() => {
    document.documentElement.dataset.theme = theme;
    localStorage.setItem("meridian-theme", theme);
    document.querySelector('meta[name="theme-color"]')?.setAttribute("content", theme === "dark" ? "#071018" : "#f3f6f8");
  }, [theme]);

  useEffect(() => {
    localStorage.setItem("meridian-language", locale);
    document.documentElement.lang = locale;
    document.title = locale === "ru" ? "Meridian — Карта сообщений" : "Meridian — Public map";
  }, [locale]);

  useEffect(() => {
    const media = window.matchMedia("(max-width: 760px)");
    const handleChange = (event: MediaQueryListEvent) => setIsNarrowViewport(event.matches);
    media.addEventListener("change", handleChange);
    return () => media.removeEventListener("change", handleChange);
  }, []);

  async function handleSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const body = draft.trim();
    if (!body || isSending || guest.isLoading) return;
    setSendError(null);
    setIsSending(true);
    try {
      const identity = await guest.ensureGuestIdentity();
      await sendMessage({ body, ...location }, identity);
      setDraft("");
    } catch (cause) {
      setSendError(cause instanceof ApiError
        ? { code: cause.code, retryAfterSeconds: cause.retryAfterSeconds }
        : { code: "message_send_failed" });
    } finally {
      setIsSending(false);
    }
  }

  function localizedSendError(code: string | null, retryAfterSeconds?: number) {
    if (!code) return null;
    const identityError = localizedIdentityError(code, t);
    if (identityError) return identityError;
    if (code === "public_message_rate_limited") return t.rateLimited(retryAfterSeconds);
    return t.sendFailed;
  }

  function localizedFollowError(error: GuestFollowError | null) {
    if (!error) return null;
    if (error.source === "read") return t.followFailed;
    return localizedIdentityError(error.code, t) ?? t.followFailed;
  }

  function localizedFriendshipError(error: GuestFriendshipError | null) {
    if (!error) return null;
    if (error.source === "read") return t.friendReadFailed;
    const identityError = localizedIdentityError(error.code, t);
    if (identityError) return identityError;
    if (error.code === "friend_request_rate_limited") return t.friendRequestRateLimited(error.retryAfterSeconds);
    if (error.code === "friend_request_received") return t.friendRequestReceived;
    if (error.code === "already_friends") return t.friendRequestAlreadyExists;
    if (error.code === "friend_target_unavailable") return t.friendTargetUnavailable;
    if (error.code === "friend_request_no_longer_pending") return t.friendRequestNoLongerPending;
    return t.friendRequestFailed;
  }

  function replyTo(message: PublicMessage) {
    const handle = message.authorHandle.replace(/^@/, "");
    setDraft((current) => `${current}${current && !current.endsWith(" ") ? " " : ""}@${handle} `);
  }

  function toggleSidebar() {
    if (isNarrowViewport) {
      setMobileMenuOpen((open) => !open);
      return;
    }
    setSidebarCollapsed((collapsed) => {
      const next = !collapsed;
      localStorage.setItem("meridian-sidebar-collapsed", String(next));
      return next;
    });
  }

  function navigateTo(section: "map" | "feed" | "friends") {
    setActiveSection(section);
    setMobileMenuOpen(false);
    document.getElementById(section === "map" ? "map" : "feed")?.scrollIntoView({ behavior: "smooth", block: "nearest" });
    if (section === "friends") void friendships.loadView(activeFriendView, undefined, activeFriendView === "incoming");
  }

  const statusLabel = status === "live" ? t.connected : status === "connecting" ? t.connecting : t.noConnection;
  const followErrorMessage = localizedFollowError(follows.error);
  const friendshipErrorMessage = localizedFriendshipError(friendships.error);

  return (
    <div className={`app-shell theme-${theme}`}>
      <header className="topbar">
        <button
          className="icon-button sidebar-toggle"
          type="button"
          aria-label={isNarrowViewport ? (mobileMenuOpen ? t.closeMenu : t.openMenu) : (sidebarCollapsed ? t.expandSidebar : t.collapseSidebar)}
          aria-expanded={isNarrowViewport ? mobileMenuOpen : !sidebarCollapsed}
          aria-controls="primary-navigation"
          onClick={toggleSidebar}
        >
          <Icon name={isNarrowViewport && mobileMenuOpen ? "close" : "menu"} />
        </button>
        <a className="brand" href="#map" aria-label={`Meridian — ${t.map}`} onClick={() => navigateTo("map")}>
          <span className="brand-mark"><Icon name="globe" /></span>
          <span>MERIDIAN</span>
        </a>
        <div className="topbar-location"><Icon name="pin" /><span>{locationLabel}</span></div>
        <div className="topbar-actions">
          <label className="language-select">
            <span className="visually-hidden">{t.language}</span>
            <select aria-label={t.language} value={locale} onChange={(event) => setLocale(event.target.value as Locale)}>
              <option value="ru">RU</option>
              <option value="en">EN</option>
            </select>
          </label>
          <button
            className="icon-button theme-toggle"
            type="button"
            aria-label={theme === "dark" ? t.switchToLight : t.switchToDark}
            title={theme === "dark" ? t.switchToLight : t.switchToDark}
            onClick={() => setTheme((current) => current === "dark" ? "light" : "dark")}
          >
            <Icon name={theme === "dark" ? "sun" : "moon"} />
          </button>
          <GoogleAuthControl
            locale={locale}
            authProvider={guest.identity?.authProvider}
            onSignedOut={clearStoredGuestNickname}
          />
          <span className={`connection-pill connection-pill--${status}`} role="status" aria-label={statusLabel}>
            <span className="connection-pill__dot" />
            <span className="connection-pill__label">{statusLabel}</span>
          </span>
        </div>
      </header>

      <div className={`workspace${sidebarCollapsed ? " workspace--collapsed" : ""}${mobileMenuOpen ? " workspace--mobile-open" : ""}`}>
        {mobileMenuOpen && <button className="sidebar-backdrop" type="button" aria-label={t.closeMenu} onClick={() => setMobileMenuOpen(false)} />}
        <aside className="sidebar" id="primary-navigation" aria-label={t.navigation}>
          <p className="sidebar__eyebrow">{t.navigation}</p>
          <nav className="sidebar-nav">
            <button className={`side-nav-link${activeSection === "map" ? " is-active" : ""}`} type="button" title={t.map} aria-label={t.map} onClick={() => navigateTo("map")}>
              <Icon name="map" /><span>{t.map}</span>
            </button>
            <button className={`side-nav-link${activeSection === "feed" ? " is-active" : ""}`} type="button" title={t.feed} aria-label={t.feed} onClick={() => navigateTo("feed")}>
              <Icon name="chat" /><span>{t.feed}</span>
              <span className="side-nav-count">{messages.length}</span>
            </button>
            <button className={`side-nav-link${activeSection === "friends" ? " is-active" : ""}`} type="button" title={t.friends} aria-label={t.friends} onClick={() => navigateTo("friends")}>
              <Icon name="users" /><span>{t.friends}</span>
              {friendships.unreadCount > 0 && (
                <span className="side-nav-count" aria-label={t.unreadFriendRequests(friendships.unreadCount)}>
                  {friendships.unreadCount}
                </span>
              )}
            </button>
          </nav>
          <div className="sidebar__spacer" />
          <button
            className="side-nav-link sidebar-settings"
            type="button"
            title={t.preferences}
            aria-label={t.preferences}
            onClick={() => {
              setSettingsOpen(true);
              setMobileMenuOpen(false);
            }}
          >
            <Icon name="settings" /><span>{t.preferences}</span>
          </button>
        </aside>

        <main className="content-grid">
          <section className="globe-stage" id="map" aria-label={t.mapRegion}>
            <Suspense fallback={<div className="globe-loading" role="status"><span className="loading-orbit" /><span>{t.globeLoading}</span></div>}>
              <GlobeCanvas
                messages={messages}
                expiringIds={expiringIds}
                theme={theme}
                errorText={t.globeError}
                markersLabel={t.globeMarkers}
                controlsLabel={t.mapRegion}
                zoomInLabel={t.zoomIn}
                zoomOutLabel={t.zoomOut}
                resetViewLabel={t.resetView}
                pickingLocation={isPickingLocation}
                onVisibleCellsChange={setCells}
                onLocationPick={(latitude, longitude) => {
                  setLocation({ latitude, longitude });
                  setIsPickingLocation(false);
                }}
                onMessageSelect={replyTo}
              />
            </Suspense>

            <div className="stage-header">
              <h1>{t.mapHeading}</h1>
              <span
                className={`stage-header__online stage-header__online--${status}`}
                data-testid="online-session-count"
                data-online-count={onlineCount ?? ""}
              >
                <span className="stage-header__online-dot" aria-hidden="true" />
                <span>{t.onlineSessions(onlineCount)}</span>
              </span>
            </div>

            <form className="composer" onSubmit={handleSubmit}>
              <div className="composer-identity">
                <label htmlFor="guest-nickname">{t.nicknameLabel}</label>
                <input
                  id="guest-nickname"
                  aria-label={t.nicknameLabel}
                  autoComplete="nickname"
                  maxLength={24}
                  placeholder={t.nicknamePlaceholder}
                  value={guest.nickname}
                  onChange={(event) => {
                    guest.setNickname(event.target.value);
                    setSendError(null);
                  }}
                />
                <span className="composer-identity__hint">{guest.isLoading ? t.nicknameLoading : t.nicknameHint}</span>
              </div>
              {(guest.error || sendError) && (
                <p className="composer-error" role="alert">
                  {localizedSendError(guest.error ?? sendError?.code ?? null, guest.error ? undefined : sendError?.retryAfterSeconds)}
                </p>
              )}
              <label className="composer-input-label" htmlFor="message-draft">
                <textarea
                  id="message-draft"
                  aria-label={t.composerLabel}
                  maxLength={240}
                  rows={1}
                  placeholder={t.composerPlaceholder}
                  value={draft}
                  onChange={(event) => setDraft(event.target.value)}
                />
              </label>
              <div className="composer-footer">
                <button
                  className={`location-picker${isPickingLocation ? " location-picker--active" : ""}`}
                  type="button"
                  aria-label={isPickingLocation ? t.clickMap : t.chooseLocation}
                  onClick={() => setIsPickingLocation(!isPickingLocation)}
                >
                  <Icon name="pin" /><span>{isPickingLocation ? t.clickMap : `${t.sendFrom}: ${locationLabel}`}</span>
                </button>
                <div className="composer-submit">
                  <span className="character-count">{draft.length}/240</span>
                  <button
                    className="send-button"
                    aria-label={t.sendMessage}
                    type="submit"
                    disabled={!draft.trim() || Array.from(guest.nickname.trim()).length < 2 || Array.from(guest.nickname.trim()).length > 24 || guest.isLoading || guest.isSaving || isSending}
                  >
                    <Icon name="send" />
                  </button>
                </div>
              </div>
            </form>
          </section>

          <aside className="stream-panel" id="feed" aria-label={activeSection === "friends" ? t.friends : t.publicMessages}>
            {activeSection === "friends" ? (
              <FriendsPanel
                view={activeFriendView}
                labels={{
                  title: t.friends,
                  subtitle: t.social,
                  incoming: t.incomingRequests,
                  outgoing: t.outgoingRequests,
                  friends: t.friendList,
                  accept: t.acceptFriend,
                  decline: t.declineRequest,
                  cancel: t.cancelRequest,
                  remove: t.removeFriend,
                  emptyIncoming: t.emptyIncomingRequests,
                  emptyOutgoing: t.emptyOutgoingRequests,
                  emptyFriends: t.emptyFriends,
                  loading: t.loadingFriends,
                  retry: t.retry,
                  loadMore: t.loadMore,
                }}
                items={friendships.pages[activeFriendView].items}
                loading={friendships.pages[activeFriendView].loading}
                loaded={friendships.pages[activeFriendView].loaded}
                nextCursor={friendships.pages[activeFriendView].nextCursor}
                pendingKeys={friendships.pendingKeys}
                errorMessage={friendshipErrorMessage}
                onViewChange={(view) => {
                  setActiveFriendView(view);
                  void friendships.loadView(view, undefined, view === "incoming");
                }}
                onLoadMore={() => friendships.loadNextPage(activeFriendView)}
                onRetry={() => void friendships.loadView(activeFriendView, undefined, activeFriendView === "incoming")}
                onAccept={(requestId) => void friendships.acceptRequest(requestId)}
                onDecline={(requestId) => void friendships.declineRequest(requestId)}
                onCancel={(requestId) => void friendships.cancelRequest(requestId)}
                onRemove={(profileId) => void friendships.removeFriend(profileId)}
              />
            ) : (
              <>
            <div className="stream-heading">
              <div>
                <h2>{t.messages}</h2>
              </div>
              <span className="message-count" aria-label={`${messages.length} ${t.messages}`}>{messages.length}</span>
            </div>

            <div className="stream-tabs" role="tablist" aria-label={t.filterMessages}>
              <button className={activeTab === "all" ? "is-active" : ""} type="button" role="tab" aria-selected={activeTab === "all"} onClick={() => setActiveTab("all")}>{t.all}</button>
              <button className={activeTab === "nearby" ? "is-active" : ""} type="button" role="tab" aria-selected={activeTab === "nearby"} onClick={() => setActiveTab("nearby")}>{t.nearby}</button>
            </div>

            {followErrorMessage && <p className="stream-error" role="alert">{followErrorMessage}</p>}
            {friendshipErrorMessage && <p className="stream-error" role="alert">{friendshipErrorMessage}</p>}
            <div className="message-list" key={activeTab}>
              {displayedMessages.map((message) => (
                <MessageCard
                  key={message.id}
                  message={message}
                  locale={locale}
                  labels={t}
                  expiring={expiringIds.has(message.id)}
                  onReply={() => replyTo(message)}
                  onFollowToggle={() => {
                    if (message.authorProfileId) void follows.toggleFollow(message.authorProfileId);
                  }}
                  isFollowing={message.authorProfileId ? follows.followingProfileIds.has(message.authorProfileId) : false}
                  followPending={message.authorProfileId ? follows.pendingProfileIds.has(message.authorProfileId) : false}
                  showSocialActions={Boolean(message.authorProfileId && message.authorProfileId !== guest.identity?.id)}
                  friendshipState={message.authorProfileId ? friendships.relationships[message.authorProfileId]?.state ?? "none" : "none"}
                  friendPending={message.authorProfileId
                    ? friendships.pendingKeys.has(`profile:${message.authorProfileId}`)
                      || Boolean(friendships.relationships[message.authorProfileId]?.requestId
                        && friendships.pendingKeys.has(`request:${friendships.relationships[message.authorProfileId]!.requestId}`))
                    : false}
                  onFriendAction={() => {
                    const profileId = message.authorProfileId;
                    if (!profileId) return;
                    const relationship = friendships.relationships[profileId];
                    if (relationship?.state === "received" && relationship.requestId) {
                      void friendships.acceptRequest(relationship.requestId);
                    } else {
                      void friendships.requestFriend(profileId);
                    }
                  }}
                />
              ))}
              {visibleMessages.length === 0 && <p className="empty-stream">{t.emptyStream}</p>}
            </div>
              </>
            )}
          </aside>
        </main>
      </div>
      <MessageDisplaySettings
        open={settingsOpen}
        locale={locale}
        seconds={messageDisplayPreference.seconds}
        status={messageDisplayPreference.status}
        labels={{
          title: t.preferences,
          displayDuration: t.messageDisplayDuration,
          description: t.messageDisplayDescription,
          savedOnDevice: t.preferenceSavedOnDevice,
          syncedToAccount: t.preferenceSyncedToAccount,
          loading: t.preferenceLoading,
          saving: t.preferenceSaving,
          error: t.preferenceError,
          close: t.closeSettings,
        }}
        onClose={() => setSettingsOpen(false)}
        onChange={(seconds) => { void messageDisplayPreference.updateSeconds(seconds); }}
      />
    </div>
  );
}
