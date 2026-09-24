import { useEffect, useRef, useState } from "react";
import "./App.css";

// Same-origin by default (Vite proxy locally, Vercel /api serverless in prod).
// Set VITE_API_URL only if the API is hosted on a different domain.
const API = import.meta.env.VITE_API_URL ?? "";
const TOKEN_KEY = "divos-chat-token";

const WELCOME = {
  role: "assistant",
  text: "Ask me anything about DivOS data — e.g. \"how many trucks are pending?\" or \"kitne orders aaj aaye?\"",
};

function readToken() {
  try {
    return localStorage.getItem(TOKEN_KEY) || "";
  } catch {
    return "";
  }
}

function saveToken(token) {
  try {
    if (token) localStorage.setItem(TOKEN_KEY, token);
    else localStorage.removeItem(TOKEN_KEY);
  } catch {
    /* storage unavailable — stay logged in for this tab only */
  }
}

function newSessionId() {
  return crypto.randomUUID();
}

function Login({ onLogin }) {
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(false);

  async function submit(e) {
    e.preventDefault();
    setError("");
    setLoading(true);
    try {
      const res = await fetch(`${API}/api/login`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ email, password }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || "Login failed");
      onLogin(data.token, data.user);
    } catch (err) {
      setError(
        err.message === "Failed to fetch"
          ? "Backend not reachable — is the API running?"
          : err.message
      );
    } finally {
      setLoading(false);
    }
  }

  return (
    <div className="chat-app login-screen">
      <form className="login-card" onSubmit={submit}>
        <h1>DivOS chat</h1>
        <p>Log in with your DivOS email and password.</p>
        <input
          type="email"
          placeholder="Email"
          value={email}
          onChange={(e) => setEmail(e.target.value)}
          autoComplete="username"
          required
        />
        <input
          type="password"
          placeholder="Password"
          value={password}
          onChange={(e) => setPassword(e.target.value)}
          autoComplete="current-password"
          required
        />
        {error && <div className="login-error">{error}</div>}
        <button type="submit" disabled={loading}>
          {loading ? "Logging in…" : "Log in"}
        </button>
      </form>
    </div>
  );
}

function App() {
  const [token, setToken] = useState(readToken);
  const [user, setUser] = useState(null);
  const [messages, setMessages] = useState([WELCOME]);
  const [sessionId, setSessionId] = useState(newSessionId);
  const [input, setInput] = useState("");
  const [loading, setLoading] = useState(false);
  const bottomRef = useRef(null);

  function logout() {
    saveToken("");
    setToken("");
    setUser(null);
    setMessages([WELCOME]);
    setSessionId(newSessionId());
  }

  useEffect(() => {
    if (!token || user) return;
    fetch(`${API}/api/me`, { headers: { Authorization: `Bearer ${token}` } })
      .then((res) => (res.ok ? res.json() : Promise.reject()))
      .then((data) => setUser(data.user))
      .catch(logout);
  }, [token, user]);

  useEffect(() => {
    bottomRef.current?.scrollIntoView({ behavior: "smooth" });
  }, [messages, loading]);

  function handleLogin(newToken, newUser) {
    saveToken(newToken);
    setToken(newToken);
    setUser(newUser);
  }

  function newChat() {
    setMessages([WELCOME]);
    setSessionId(newSessionId());
  }

  async function send(e) {
    e.preventDefault();
    const text = input.trim();
    if (!text || loading) return;

    setInput("");
    setMessages((prev) => [...prev, { role: "user", text }]);
    setLoading(true);

    try {
      const res = await fetch(`${API}/api/chat`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${token}`,
        },
        body: JSON.stringify({ message: text, sessionId }),
      });
      if (res.status === 401) {
        logout();
        return;
      }
      const data = await res.json();
      setMessages((prev) => [
        ...prev,
        { role: "assistant", text: data.reply || data.error || "No reply" },
      ]);
    } catch (err) {
      setMessages((prev) => [
        ...prev,
        {
          role: "assistant",
          text: `Could not reach the backend: ${err.message}`,
        },
      ]);
    } finally {
      setLoading(false);
    }
  }

  if (!token) return <Login onLogin={handleLogin} />;

  return (
    <div className="chat-app">
      <header className="chat-header">
        <div>
          <h1>DivOS chat</h1>
          <p>{user ? `${user.name} · ${user.role ?? "user"}` : "Loading…"}</p>
        </div>
        <div className="header-actions">
          <button type="button" onClick={newChat} disabled={loading}>
            New chat
          </button>
          <button type="button" onClick={logout}>
            Log out
          </button>
        </div>
      </header>

      <main className="chat-thread">
        {messages.map((msg, i) => (
          <div key={i} className={`bubble ${msg.role}`}>
            <span className="who">{msg.role === "user" ? "You" : "DivOS"}</span>
            <p>{msg.text}</p>
          </div>
        ))}
        {loading && (
          <div className="bubble assistant">
            <span className="who">DivOS</span>
            <p>Thinking…</p>
          </div>
        )}
        <div ref={bottomRef} />
      </main>

      <form className="chat-composer" onSubmit={send}>
        <input
          value={input}
          onChange={(e) => setInput(e.target.value)}
          placeholder="Ask a question…"
          autoComplete="off"
          disabled={loading}
        />
        <button type="submit" disabled={loading || !input.trim()}>
          Send
        </button>
      </form>
    </div>
  );
}

export default App
