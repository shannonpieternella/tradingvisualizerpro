import React from "react";
import { Routes, Route, Navigate } from "react-router-dom";
import { useAuth } from "./contexts/AuthContext.jsx";
import HomePage    from "./pages/HomePage.jsx";
import AuthPage    from "./pages/AuthPage.jsx";
import Dashboard   from "./Dashboard.jsx";
import AdminPage   from "./pages/AdminPage.jsx";
import BacktestPage from "./pages/BacktestPage.jsx";
import EnginePage  from "./pages/EnginePage.jsx";
import JournalPage from "./pages/JournalPage.jsx";
import TradeReplayPage from "./pages/TradeReplayPage.jsx";
import BrokerPage  from "./pages/BrokerPage.jsx";
import BillingPage from "./pages/BillingPage.jsx";
import ProfilePage from "./pages/ProfilePage.jsx";

// Protected route: redirect to /login if not authenticated
function PrivateRoute({ children }) {
  const { user, loading } = useAuth();
  if (loading) return <div className="auth-loading"><span className="auth-loading-spin" /></div>;
  return user ? children : <Navigate to="/login" replace />;
}

// Public-only route: redirect to /dashboard if already logged in
function PublicRoute({ children }) {
  const { user, loading } = useAuth();
  if (loading) return <div className="auth-loading"><span className="auth-loading-spin" /></div>;
  return user ? <Navigate to="/dashboard" replace /> : children;
}

export default function App() {
  return (
    <>
      <Routes>
        <Route path="/" element={
          <PublicRoute><HomePage /></PublicRoute>
        } />
        <Route path="/login" element={
          <PublicRoute><AuthPage /></PublicRoute>
        } />
        <Route path="/register" element={
          <PublicRoute><AuthPage /></PublicRoute>
        } />
        <Route path="/dashboard" element={
          <PrivateRoute><Dashboard /></PrivateRoute>
        } />
        <Route path="/admin" element={
          <PrivateRoute><AdminPage /></PrivateRoute>
        } />
        <Route path="/backtest" element={
          <PrivateRoute><BacktestPage /></PrivateRoute>
        } />
        <Route path="/engine" element={
          <PrivateRoute><EnginePage /></PrivateRoute>
        } />
        <Route path="/journal" element={
          <PrivateRoute><JournalPage /></PrivateRoute>
        } />
        <Route path="/journal/:id" element={
          <PrivateRoute><TradeReplayPage /></PrivateRoute>
        } />
        <Route path="/broker" element={
          <PrivateRoute><BrokerPage /></PrivateRoute>
        } />
        <Route path="/billing" element={
          <PrivateRoute><BillingPage /></PrivateRoute>
        } />
        <Route path="/profile" element={
          <PrivateRoute><ProfilePage /></PrivateRoute>
        } />
        {/* Catch-all */}
        <Route path="*" element={<Navigate to="/" replace />} />
      </Routes>
    </>
  );
}
