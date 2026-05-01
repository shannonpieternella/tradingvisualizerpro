import React from "react";
import ReactDOM from "react-dom/client";
import { BrowserRouter } from "react-router-dom";
import { AuthProvider } from "./contexts/AuthContext.jsx";
import { LiveDataProvider } from "./contexts/LiveDataContext.jsx";
import App from "./App.jsx";
import "./index.css";

ReactDOM.createRoot(document.getElementById("root")).render(
  <React.StrictMode>
    <BrowserRouter>
      <AuthProvider>
        <LiveDataProvider>
          <App />
        </LiveDataProvider>
      </AuthProvider>
    </BrowserRouter>
  </React.StrictMode>
);
