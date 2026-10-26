import { useEffect, useRef, useState, type FormEvent, type ReactNode } from "react";
import type { Session } from "@supabase/supabase-js";
import { AccountContext } from "./accountContext";
import { Icon } from "./Icons";
import {
  emptyPreferences,
  guestPreferencesKey,
  preferenceOptions,
  readGuestPreferences,
  readPreferences,
  storedPreferences,
  supabase,
  welcomeDismissed,
  welcomeKey,
  type Preferences,
} from "./accountData";
import "./Account.css";

type View = "welcome" | "login" | "signup" | "profile" | "preferences" | "password";

function profileErrorText(error: unknown) {
  const code =
    error && typeof error === "object" && "code" in error && typeof error.code === "string"
      ? error.code
      : "";
  if (code === "42P01" || code === "PGRST205")
    return "Preferences storage is not set up. Run supabase/preferences.sql in Supabase, then retry.";
  if (code === "42703" || code === "PGRST204")
    return "Home-location fields are missing. Run supabase/preferences-home-location.sql in Supabase, then retry.";
  return "Your saved preferences could not load. Check your connection or sign in again, then retry.";
}

export function Account({ children }: { children: ReactNode }) {
  const dialog = useRef<HTMLDialogElement>(null);
  const [session, setSession] = useState<Session | null>(null);
  const [authReady, setAuthReady] = useState(!supabase);
  const [view, setView] = useState<View | null>(() => (welcomeDismissed() ? null : "welcome"));
  const [guest, setGuest] = useState(readGuestPreferences);
  const [profile, setProfile] = useState<{
    owner: string;
    value: Preferences;
  } | null>(null);
  const [profileError, setProfileError] = useState("");
  const [profileAttempt, setProfileAttempt] = useState(0);
  const [message, setMessage] = useState("");
  const owner = session?.user.id || "guest";
  let preferences;
  if (session) {
    if (profile?.owner === owner) {
      preferences = profile.value;
    } else {
      preferences = emptyPreferences;
    }
  } else {
    preferences = guest;
  }
  const profileReady = !session || profile?.owner === owner;
  const metadata = session?.user.user_metadata || {};
  const metadataName = [metadata.full_name, metadata.name, metadata.display_name]
    .find((name): name is string => typeof name === "string" && !!name.trim())
    ?.trim();
  let avatarUrl;
  if (typeof metadata.avatar_url === "string") {
    avatarUrl = metadata.avatar_url;
  } else if (typeof metadata.picture === "string") {
    avatarUrl = metadata.picture;
  } else {
    avatarUrl = "";
  }
  const identity = {
    name: metadataName || session?.user.email?.split("@")[0] || "Guest",
    email: session?.user.email || (session ? "Email unavailable" : "Not signed in"),
    avatarUrl,
  };

  function close() {
    try {
      sessionStorage.setItem(welcomeKey, "true");
    } catch {}
    setView(null);
    setMessage("");
  }

  useEffect(() => {
    if (!supabase) return;
    const {
      data: { subscription },
    } = supabase.auth.onAuthStateChange((_event, next) => {
      setSession(next);
      setAuthReady(true);
    });
    return () => subscription.unsubscribe();
  }, []);

  useEffect(() => {
    if (!session) return;
    try {
      sessionStorage.setItem(welcomeKey, "true");
    } catch {}
    setView((current) => (current === "preferences" || current === "password" ? current : null));
  }, [session?.user.id]);

  useEffect(() => {
    if (!supabase || !session) {
      setProfile(null);
      return;
    }
    const client = supabase;
    const userId = session.user.id;
    let active = true;
    setProfileError("");
    async function load() {
      try {
        const { data, error } = await client
          .from("user_preferences")
          .select("home_location_type, home_address, home_zip, needs")
          .eq("user_id", userId)
          .maybeSingle();
        if (!active) return;
        if (error) throw error;
        setProfile({ owner: userId, value: readPreferences(data) });
      } catch (error) {
        if (active) setProfileError(profileErrorText(error));
      }
    }
    void load();
    return () => {
      active = false;
    };
  }, [session?.user.id, profileAttempt]);

  useEffect(() => {
    const element = dialog.current;
    if (!element) return;
    const showDialog = view && (authReady || view === "preferences");
    if (showDialog && !element.open) element.showModal();
    else if (!showDialog && element.open) element.close();
  }, [view, authReady]);

  function openPreferences() {
    setMessage("");
    setView("preferences");
  }

  function openProfile() {
    setMessage("");
    setView("profile");
  }

  async function savePreferences(next: Preferences) {
    if (session && supabase) {
      const { error } = await supabase
        .from("user_preferences")
        .upsert(
          { user_id: session.user.id, ...storedPreferences(next) },
          { onConflict: "user_id" },
        );
      if (error)
        throw new Error("Could not save to your account. Your previous preferences are unchanged.");
      setProfile({ owner, value: next });
    } else {
      try {
        localStorage.setItem(guestPreferencesKey, JSON.stringify(storedPreferences(next)));
      } catch {
        throw new Error(
          "This browser could not save your preferences. Check its storage settings.",
        );
      }
      setGuest(next);
    }
    setMessage(session ? "Saved to your account." : "Saved on this device.");
  }

  async function signOut() {
    if (!supabase) return;
    const { error } = await supabase.auth.signOut({ scope: "local" });
    if (error) {
      setMessage(
        `Could not log out. ${error.message || (error.status ? `Status ${error.status}.` : "Try again.")}`,
      );
      return;
    }
    close();
  }

  let dialogContent;
  if (view === "welcome") {
    dialogContent = (
      <>
        <h2 id="account-title">
          <span className="account-brand-icon">
            <Icon name="fire" />
          </span>
          Watchtower
        </h2>
        <p className="account-intro">Choose how to continue.</p>
        <div className="account-options">
          <button type="button" className="account-primary" onClick={close}>
            Continue without account
          </button>
          <button type="button" onClick={() => setView("login")}>
            Log in
          </button>
          <button type="button" className="account-secondary" onClick={() => setView("signup")}>
            Sign up
          </button>
        </div>
      </>
    );
  } else if (view === "login" || view === "signup") {
    dialogContent = (
      <PasswordSignIn
        key={view}
        signup={view === "signup"}
        onBack={() => setView("welcome")}
        onGuest={close}
      />
    );
  } else if (view === "profile") {
    dialogContent = (
      <>
        <div className="account-profile-summary">
          <ProfileAvatar name={identity.name} avatarUrl={identity.avatarUrl} />
          <div>
            <h2 id="account-title">{identity.name}</h2>
            <p>{identity.email}</p>
          </div>
        </div>
        <div className="account-options">
          <button className="account-primary" type="button" onClick={openPreferences}>
            Preferences
          </button>
          {session ? (
            <>
              <button type="button" onClick={() => setView("password")}>
                Change password
              </button>
              <button type="button" onClick={signOut}>
                Log out
              </button>
            </>
          ) : (
            <>
              <button type="button" onClick={() => setView("login")}>
                Log in
              </button>
              <button type="button" onClick={() => setView("signup")}>
                Sign up
              </button>
            </>
          )}
        </div>
        {message && (
          <p role="status" className="account-message">
            {message}
          </p>
        )}
      </>
    );
  } else if (view === "password") {
    dialogContent = (
      <ChangePassword
        onBack={() => setView("profile")}
        onSaved={() => {
          setMessage("Password updated.");
          setView("profile");
        }}
      />
    );
  } else if (view === "preferences") {
    let preferencesContent;
    if (profileError) {
      preferencesContent = (
        <p role="alert">
          {profileError}{" "}
          <button type="button" onClick={() => setProfileAttempt((attempt) => attempt + 1)}>
            Try again
          </button>
        </p>
      );
    } else if (!authReady || !profileReady) {
      preferencesContent = <p role="status">Loading saved preferences…</p>;
    } else {
      preferencesContent = (
        <PreferencesForm
          key={owner}
          initial={preferences}
          signedIn={!!session}
          onSave={savePreferences}
        />
      );
    }
    dialogContent = (
      <>
        <h2 id="account-title">Your preferences</h2>
        <p className="account-intro">
          {session?.user.email || (authReady ? "No account needed." : "Checking your account…")}
        </p>
        {preferencesContent}
        {message && (
          <p role="status" className="account-message">
            {message}
          </p>
        )}
        {authReady && (
          <div className="account-footer">
            {session ? (
              <button type="button" onClick={signOut}>
                Log out
              </button>
            ) : (
              <>
                <button
                  type="button"
                  onClick={() => {
                    setMessage("");
                    setView("login");
                  }}
                >
                  Log in
                </button>
                <button
                  type="button"
                  onClick={() => {
                    setMessage("");
                    setView("signup");
                  }}
                >
                  Sign up
                </button>
              </>
            )}
          </div>
        )}
      </>
    );
  } else {
    dialogContent = null;
  }
  return (
    <AccountContext.Provider value={{ preferences, owner, identity, openProfile, openPreferences }}>
      {children}
      <dialog
        ref={dialog}
        className="account-dialog"
        data-view={view}
        aria-labelledby="account-title"
        onCancel={(event) => {
          event.preventDefault();
          close();
        }}
        onClick={(event) => {
          if (event.target !== event.currentTarget) return;
          const bounds = event.currentTarget.getBoundingClientRect();
          if (
            event.clientX < bounds.left ||
            event.clientX > bounds.right ||
            event.clientY < bounds.top ||
            event.clientY > bounds.bottom
          )
            close();
        }}
      >
        <div className="account-content">
          <button
            type="button"
            className="account-close"
            aria-label="Close account dialog"
            onClick={close}
          >
            ×
          </button>
          {dialogContent}
        </div>
      </dialog>
    </AccountContext.Provider>
  );
}

function ProfileAvatar({ name, avatarUrl }: { name: string; avatarUrl: string }) {
  const initials = name
    .trim()
    .split(/\s+/)
    .slice(0, 2)
    .map((part) => part[0])
    .join("")
    .toUpperCase();
  return (
    <span className="account-avatar" aria-hidden="true">
      {avatarUrl ? <img src={avatarUrl} alt="" /> : initials || "G"}
    </span>
  );
}

function PasswordSignIn({
  signup,
  onBack,
  onGuest,
}: {
  signup: boolean;
  onBack: () => void;
  onGuest: () => void;
}) {
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [confirmation, setConfirmation] = useState("");
  const [sending, setSending] = useState(false);
  const [error, setError] = useState("");

  async function submit(event: FormEvent) {
    event.preventDefault();
    if (!supabase || sending) return;
    if (signup && password !== confirmation) {
      setError("Passwords do not match.");
      return;
    }
    setSending(true);
    setError("");
    try {
      const address = email.trim();
      if (signup) {
        const settingsResponse = await fetch(
          `${import.meta.env.VITE_SUPABASE_URL}/auth/v1/settings`,
          {
            headers: { apikey: import.meta.env.VITE_SUPABASE_PUBLISHABLE_KEY },
          },
        );
        if (!settingsResponse.ok) throw new Error("Account creation is unavailable right now.");
        const settings: { mailer_autoconfirm?: boolean } = await settingsResponse.json();
        if (!settings.mailer_autoconfirm)
          throw new Error("Account creation is unavailable right now.");
        const { data, error } = await supabase.auth.signUp({
          email: address,
          password,
        });
        if (error) throw error;
        if (!data.session) throw new Error("Account created, but could not sign in.");
      } else {
        const { error } = await supabase.auth.signInWithPassword({ email: address, password });
        if (error) throw error;
      }
    } catch (error) {
      setError(error instanceof Error ? error.message : "Could not access your account.");
    } finally {
      setSending(false);
    }
  }

  let submitLabel;
  if (sending) {
    if (signup) {
      submitLabel = "Creating account…";
    } else {
      submitLabel = "Signing in…";
    }
  } else if (signup) {
    submitLabel = "Create account";
  } else {
    submitLabel = "Log in";
  }
  return (
    <>
      <h2 id="account-title">{signup ? "Sign up" : "Log in"}</h2>
      <p className="account-intro">
        {signup ? "Create an account to save your preferences." : "Access your saved preferences."}
      </p>
      {!supabase && (
        <p role="status" className="account-message">
          Accounts aren’t connected yet. You can continue without an account.
        </p>
      )}
      <form onSubmit={submit} className="account-form">
        <label htmlFor="account-email">Email address</label>
        <input
          id="account-email"
          type="email"
          autoComplete="email"
          required
          value={email}
          onChange={(event) => setEmail(event.target.value)}
        />
        <label htmlFor="account-password">Password</label>
        <input
          id="account-password"
          type="password"
          autoComplete={signup ? "new-password" : "current-password"}
          minLength={6}
          required
          value={password}
          onChange={(event) => setPassword(event.target.value)}
        />
        {signup && (
          <>
            <label htmlFor="account-confirm-password">Confirm password</label>
            <input
              id="account-confirm-password"
              type="password"
              autoComplete="new-password"
              minLength={6}
              required
              value={confirmation}
              onChange={(event) => setConfirmation(event.target.value)}
            />
          </>
        )}
        {error && <p role="alert">{error}</p>}
        <button type="submit" className="account-primary" disabled={!supabase || sending}>
          {submitLabel}
        </button>
      </form>
      <div className="account-options account-email-options">
        <button type="button" onClick={onGuest}>
          Continue without account
        </button>
        <button type="button" onClick={onBack}>
          Back
        </button>
      </div>
    </>
  );
}

function ChangePassword({ onBack, onSaved }: { onBack: () => void; onSaved: () => void }) {
  const [password, setPassword] = useState("");
  const [confirmation, setConfirmation] = useState("");
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");

  async function submit(event: FormEvent) {
    event.preventDefault();
    if (!supabase || saving) return;
    if (password !== confirmation) {
      setError("Passwords do not match.");
      return;
    }
    setSaving(true);
    setError("");
    try {
      const { error } = await supabase.auth.updateUser({ password });
      if (error) throw error;
      onSaved();
    } catch (error) {
      setError(error instanceof Error ? error.message : "Could not change your password.");
    } finally {
      setSaving(false);
    }
  }

  return (
    <>
      <h2 id="account-title">Change password</h2>
      <form className="account-form" onSubmit={submit}>
        <label htmlFor="account-new-password">New password</label>
        <input
          id="account-new-password"
          type="password"
          autoComplete="new-password"
          minLength={6}
          required
          value={password}
          onChange={(event) => setPassword(event.target.value)}
        />
        <label htmlFor="account-confirm-new-password">Confirm new password</label>
        <input
          id="account-confirm-new-password"
          type="password"
          autoComplete="new-password"
          minLength={6}
          required
          value={confirmation}
          onChange={(event) => setConfirmation(event.target.value)}
        />
        {error && <p role="alert">{error}</p>}
        <button type="submit" className="account-primary" disabled={!supabase || saving}>
          {saving ? "Saving…" : "Save password"}
        </button>
      </form>
      <div className="account-options account-email-options">
        <button type="button" onClick={onBack}>
          Back
        </button>
      </div>
    </>
  );
}

function PreferencesForm({
  initial,
  signedIn,
  onSave,
}: {
  initial: Preferences;
  signedIn: boolean;
  onSave: (prefs: Preferences) => Promise<void>;
}) {
  const [prefs, setPrefs] = useState(initial);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");
  useEffect(() => {
    setPrefs(initial);
  }, [initial]);
  async function submit(event: FormEvent) {
    event.preventDefault();
    if (saving) return;
    setSaving(true);
    setError("");
    try {
      await onSave(prefs);
    } catch (error) {
      setError(error instanceof Error ? error.message : "Could not save preferences. Try again.");
    } finally {
      setSaving(false);
    }
  }
  let saveLabel;
  if (saving) {
    saveLabel = "Saving…";
  } else if (signedIn) {
    saveLabel = "Save to my account";
  } else {
    saveLabel = "Save on this device";
  }
  return (
    <form className="account-form" onSubmit={submit}>
      <fieldset>
        <legend>Home location</legend>
        <p className="account-muted">Optional / choose one; click again to remove.</p>
        {(
          [
            ["address", "Home address"],
            ["zip", "ZIP code"],
          ] as const
        ).map(([type, label]) => (
          <label key={type} className="account-check">
            <input
              type="checkbox"
              name="home-location-type"
              checked={prefs.homeLocationType === type}
              onChange={(event) =>
                setPrefs({
                  ...prefs,
                  homeLocationType: event.target.checked ? type : "none",
                  homeAddress: type === "address" && event.target.checked ? prefs.homeAddress : "",
                  homeZip: type === "zip" && event.target.checked ? prefs.homeZip : "",
                })
              }
            />
            <span>{label}</span>
          </label>
        ))}
      </fieldset>
      {prefs.homeLocationType === "address" && (
        <>
          <label htmlFor="profile-address">Home address</label>
          <input
            id="profile-address"
            type="text"
            autoComplete="street-address"
            maxLength={300}
            required
            value={prefs.homeAddress}
            onChange={(event) => setPrefs({ ...prefs, homeAddress: event.target.value })}
          />
        </>
      )}
      {prefs.homeLocationType === "zip" && (
        <>
          <label htmlFor="profile-zip">Home ZIP code</label>
          <input
            id="profile-zip"
            type="text"
            inputMode="numeric"
            autoComplete="postal-code"
            pattern="[0-9]{5}"
            maxLength={5}
            required
            value={prefs.homeZip}
            onChange={(event) => setPrefs({ ...prefs, homeZip: event.target.value })}
          />
        </>
      )}
      <fieldset>
        <legend>
          What should we keep in mind? <span className="account-muted">(optional)</span>
        </legend>
        {preferenceOptions.map((option) => (
          <label key={option.id} className="account-check">
            <input
              type="checkbox"
              checked={prefs.needs.includes(option.id)}
              onChange={(event) =>
                setPrefs({
                  ...prefs,
                  needs: event.target.checked
                    ? [...prefs.needs, option.id]
                    : prefs.needs.filter((need) => need !== option.id),
                })
              }
            />
            <span>{option.label}</span>
          </label>
        ))}
      </fieldset>
      {error && <p role="alert">{error}</p>}
      <button type="submit" className="account-primary" disabled={saving}>
        {saveLabel}
      </button>
    </form>
  );
}
