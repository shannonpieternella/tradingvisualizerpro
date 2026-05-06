import React, { createContext, useCallback, useContext, useEffect, useState } from "react";
import { useAuth } from "./AuthContext.jsx";

const LiveDataContext = createContext(null);
const POLL_INTERVAL = 60 * 1000;

export function LiveDataProvider({ children }) {
  const { authFetch } = useAuth();
  const [markets, setMarkets]       = useState({});
  const [adminBias, setAdminBias]   = useState({ GLOBAL: "AUTO" });
  const [freeTier, setFreeTier]     = useState(null);
  const [lastRefresh, setLastRefresh] = useState(null);
  const [refreshing, setRefreshing] = useState(false);
  const [error, setError]           = useState(null);
  const [refreshKey, setRefreshKey] = useState(0);

  const load = useCallback(async () => {
    setRefreshing(true);
    try {
      const [liveRes, biasRes] = await Promise.all([
        authFetch("/api/live-data").then(r => r.json()),
        authFetch("/api/admin/bias").then(r => r.json()).catch(() => ({ ok: false })),
      ]);
      if (liveRes.ok) {
        setMarkets(liveRes.markets ?? {});
        setFreeTier(liveRes.freeTier ?? null);
        setLastRefresh(new Date());
        setError(null);
      } else if (liveRes.error) {
        setError(liveRes.error);
      }
      if (biasRes.ok) {
        setAdminBias(biasRes.bias ?? { GLOBAL: "AUTO" });
      }
    } catch (e) {
      setError(e.message);
    } finally {
      setRefreshing(false);
    }
  }, [authFetch]);

  const refresh = useCallback(() => {
    setRefreshKey(k => k + 1);
    load();
  }, [load]);

  useEffect(() => {
    load();
    const iv = setInterval(load, POLL_INTERVAL);
    return () => clearInterval(iv);
  }, [load]);

  const value = { markets, adminBias, freeTier, lastRefresh, refreshing, error, refresh, refreshKey };
  return <LiveDataContext.Provider value={value}>{children}</LiveDataContext.Provider>;
}

export function useLiveData() {
  const ctx = useContext(LiveDataContext);
  if (!ctx) throw new Error("useLiveData must be used within LiveDataProvider");
  return ctx;
}
