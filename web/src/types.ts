export type PublicMessage = {
  id: string;
  authorProfileId?: string;
  authorName: string;
  authorHandle: string;
  body: string;
  latitude: number;
  longitude: number;
  city: string;
  country: string;
  createdAt: string;
  expiresAt: string;
  avatarColor: string;
  initials: string;
};

export type NewPublicMessage = {
  body: string;
  latitude: number;
  longitude: number;
};

export type GuestIdentity = {
  id: string;
  nickname: string;
  handle: string;
  avatarColor: string;
  initials: string;
  authProvider?: "google";
};
