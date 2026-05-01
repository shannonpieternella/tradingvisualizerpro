import React from "react";
import { useAuth } from "../contexts/AuthContext.jsx";
import { useNavigate } from "react-router-dom";
import "./Header.css";

export default function Header({ onRefresh, refreshing }) {
  const { user, logout } = useAuth();
  const navigate = useNavigate();

  function handleLogout() {
    logout();
    navigate("/");
  }

  return (
    <header className="header">
      <div className="header-brand">
        <div className="header-logo">
          <span className="logo-bull">◈</span>
        </div>
        <div className="header-title">
          <span className="brand-name">TradingVisualizer</span>
          <span className="brand-sub">AI Market Intelligence</span>
        </div>
      </div>

      <div className="header-center">
        <div className="header-badge">
          <span className="pulse-dot" />
          LIVE FEED
        </div>
        <span className="header-instrument">5 markten · 15M · ET</span>
      </div>

      <div className="header-actions">
        {user && (
          <span className="header-user">
            {user.name}
          </span>
        )}
        <button
          className={`btn-refresh ${refreshing ? "refreshing" : ""}`}
          onClick={onRefresh}
          disabled={refreshing}
          title="Force refresh"
        >
          <span className="refresh-icon">⟳</span>
          {refreshing ? "Syncing..." : "Refresh"}
        </button>
        <button className="btn-logout" onClick={handleLogout} title="Uitloggen">
          ⏻
        </button>
      </div>
    </header>
  );
}
