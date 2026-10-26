import { createContext, useContext } from "react";
import type { Preferences } from "./accountData";

export const AccountContext = createContext<{
  preferences: Preferences;
  owner: string;
  identity: { name: string; email: string; avatarUrl: string };
  openProfile: () => void;
  openPreferences: () => void;
} | null>(null);

export function useAccount() {
  const account = useContext(AccountContext);
  if (!account) throw new Error("Account context requires the Account provider.");
  return account;
}
