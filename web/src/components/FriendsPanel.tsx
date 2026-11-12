import type { CSSProperties } from "react";
import type { FriendRequestItem, FriendshipView } from "../hooks/useGuestFriendships";

type Labels = {
  title: string;
  subtitle: string;
  incoming: string;
  outgoing: string;
  friends: string;
  accept: string;
  decline: string;
  cancel: string;
  remove: string;
  emptyIncoming: string;
  emptyOutgoing: string;
  emptyFriends: string;
  loading: string;
  retry: string;
  loadMore: string;
};

type Props = {
  view: FriendshipView;
  labels: Labels;
  items: FriendRequestItem[];
  loading: boolean;
  loaded: boolean;
  nextCursor: string | null;
  pendingKeys: Set<string>;
  errorMessage: string | null;
  onViewChange: (view: FriendshipView) => void;
  onLoadMore: () => void;
  onRetry: () => void;
  onAccept: (requestId: string) => void;
  onDecline: (requestId: string) => void;
  onCancel: (requestId: string) => void;
  onRemove: (profileId: string) => void;
};

const VIEWS: FriendshipView[] = ["incoming", "outgoing", "friends"];

export function FriendsPanel({
  view,
  labels,
  items,
  loading,
  loaded,
  nextCursor,
  pendingKeys,
  errorMessage,
  onViewChange,
  onLoadMore,
  onRetry,
  onAccept,
  onDecline,
  onCancel,
  onRemove,
}: Props) {
  const viewLabels: Record<FriendshipView, string> = {
    incoming: labels.incoming,
    outgoing: labels.outgoing,
    friends: labels.friends,
  };

  return (
    <section className="friends-panel" aria-label={labels.title}>
      <div className="friends-panel__heading">
        <div>
          <span className="stream-heading__eyebrow">{labels.subtitle}</span>
          <h2>{labels.title}</h2>
        </div>
        <span className="message-count" aria-label={String(items.length)}>{items.length}</span>
      </div>

      <div className="stream-tabs friends-panel__tabs" role="group" aria-label={labels.title}>
        {VIEWS.map((tab) => (
          <button
            key={tab}
            className={view === tab ? "is-active" : ""}
            type="button"
            aria-pressed={view === tab}
            onClick={() => onViewChange(tab)}
          >
            {viewLabels[tab]}
          </button>
        ))}
      </div>

      {errorMessage && (
        <div className="stream-error friends-panel__error" role="alert">
          <span>{errorMessage}</span>
          <button type="button" onClick={onRetry}>{labels.retry}</button>
        </div>
      )}

      <div className="friend-list" aria-busy={loading}>
        {items.map((item) => {
          const pending = pendingKeys.has(`request:${item.id}`) || pendingKeys.has(`profile:${item.profileId}`);
          return (
            <article className="friend-card" key={item.id}>
              <span
                aria-hidden="true"
                className="friend-card__avatar"
                style={{ "--avatar-color": item.avatarColor } as CSSProperties}
              >
                {item.initials}
              </span>
              <div className="friend-card__identity">
                <strong>{item.nickname}</strong>
                <span>{item.handle}</span>
              </div>
              <div className="friend-card__actions">
                {view === "incoming" && (
                  <>
                    <button
                      className="friend-action friend-action--primary"
                      type="button"
                      aria-label={`${labels.accept} ${item.nickname}`}
                      aria-busy={pending}
                      disabled={pending}
                      onClick={() => onAccept(item.id)}
                    >
                      {labels.accept}
                    </button>
                    <button
                      className="friend-action friend-action--quiet"
                      type="button"
                      aria-label={`${labels.decline} ${item.nickname}`}
                      aria-busy={pending}
                      disabled={pending}
                      onClick={() => onDecline(item.id)}
                    >
                      {labels.decline}
                    </button>
                  </>
                )}
                {view === "outgoing" && (
                  <button
                    className="friend-action friend-action--quiet"
                    type="button"
                    aria-label={`${labels.cancel} ${item.nickname}`}
                    aria-busy={pending}
                    disabled={pending}
                    onClick={() => onCancel(item.id)}
                  >
                    {labels.cancel}
                  </button>
                )}
                {view === "friends" && (
                  <button
                    className="friend-action friend-action--quiet"
                    type="button"
                    aria-label={`${labels.remove} ${item.nickname}`}
                    aria-busy={pending}
                    disabled={pending}
                    onClick={() => onRemove(item.profileId)}
                  >
                    {labels.remove}
                  </button>
                )}
              </div>
            </article>
          );
        })}
        {loading && items.length === 0 && <p className="friends-panel__empty" role="status">{labels.loading}</p>}
        {!loading && loaded && items.length === 0 && (
          <p className="friends-panel__empty">
            {view === "incoming" ? labels.emptyIncoming : view === "outgoing" ? labels.emptyOutgoing : labels.emptyFriends}
          </p>
        )}
      </div>

      {nextCursor && (
        <button className="friends-panel__load-more" type="button" disabled={loading} onClick={onLoadMore}>
          {loading ? labels.loading : labels.loadMore}
        </button>
      )}
    </section>
  );
}
