import React, { createContext, useContext, useState, useCallback, useEffect } from "react";
import { tStr, TRANSLATIONS } from "../i18n/translations.js";

const LanguageContext = createContext(null);

const STORAGE_KEY = "tv-language";
const DEFAULT_LANG = "en";  // English first — international audience

function readInitialLang() {
  if (typeof window === "undefined") return DEFAULT_LANG;
  const saved = window.localStorage.getItem(STORAGE_KEY);
  if (saved === "en" || saved === "nl") return saved;
  return DEFAULT_LANG;
}

export function LanguageProvider({ children }) {
  const [lang, setLangState] = useState(readInitialLang);

  const setLang = useCallback((next) => {
    if (next !== "en" && next !== "nl") return;
    setLangState(next);
    try { window.localStorage.setItem(STORAGE_KEY, next); } catch {}
    // If logged in, sync to backend so preference persists across devices
    try {
      const token = window.localStorage.getItem("tv-token") || window.localStorage.getItem("token");
      if (token) {
        fetch("/api/auth/language", {
          method: "PATCH",
          headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
          body: JSON.stringify({ language: next }),
        }).catch(() => {});
      }
    } catch {}
  }, []);

  const t = useCallback((key, vars) => tStr(key, lang, vars), [lang]);

  // Sync from server-side preference once on mount (if user logged in with different lang)
  useEffect(() => {
    try {
      const token = window.localStorage.getItem("tv-token") || window.localStorage.getItem("token");
      if (!token) return;
      fetch("/api/auth/me", { headers: { Authorization: `Bearer ${token}` } })
        .then(r => r.json())
        .then(d => {
          if (d?.user?.language && d.user.language !== lang) {
            setLangState(d.user.language);
            try { window.localStorage.setItem(STORAGE_KEY, d.user.language); } catch {}
          }
        }).catch(() => {});
    } catch {}
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  return (
    <LanguageContext.Provider value={{ lang, setLang, t }}>
      {children}
    </LanguageContext.Provider>
  );
}

export function useLanguage() {
  const ctx = useContext(LanguageContext);
  if (!ctx) throw new Error("useLanguage must be inside LanguageProvider");
  return ctx;
}

export function useT() {
  return useLanguage().t;
}

// Compact toggle for nav: shows current language pill, click cycles to other.
export function LanguageSwitch({ className = "" }) {
  const { lang, setLang } = useLanguage();
  const next = lang === "en" ? "nl" : "en";
  return (
    <button
      type="button"
      className={`lang-switch ${className}`}
      onClick={() => setLang(next)}
      title={lang === "en" ? "Switch to Nederlands" : "Wissel naar English"}
      aria-label="Switch language"
    >
      <span className={`lang-flag ${lang === "en" ? "lang-flag-active" : ""}`}>EN</span>
      <span className="lang-sep">/</span>
      <span className={`lang-flag ${lang === "nl" ? "lang-flag-active" : ""}`}>NL</span>
    </button>
  );
}
