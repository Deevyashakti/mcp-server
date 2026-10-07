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

let googleScript;

function loadGoogleScript() {
  googleScript ||= new Promise((resolve, reject) => {
    const s = document.createElement("script");
    s.src = "https://accounts.google.com/gsi/client";
    s.async = true;
    s.onload = resolve;
    s.onerror = () => {
      googleScript = null;
      reject(new Error("Could not load Google sign-in"));
    };
    document.head.appendChild(s);
  });
  return googleScript;
}

function Login({ onLogin }) {
  const [step, setStep] = useState("email");
  const [email, setEmail] = useState("");
  const [code, setCode] = useState("");
  const [challenge, setChallenge] = useState("");
  const [notice, setNotice] = useState("");
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(false);
  const [googleClientId, setGoogleClientId] = useState(null);
  const googleButtonRef = useRef(null);
  const requestLoginRef = useRef(null);

  async function post(path, body) {
    setError("");
    setLoading(true);
    try {
      const res = await fetch(`${API}${path}`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || "Login failed");
      return data;
    } catch (err) {
      setError(
        err.message === "Failed to fetch"
          ? "Backend not reachable — is the API running?"
          : err.message
      );
      return null;
    } finally {
      setLoading(false);
    }
  }

  async function requestLogin(path, body) {
    const data = await post(path, body);
    if (data) onLogin(data.token, data.user);
  }

  async function sendCode() {
    const data = await post("/api/login/otp/request", { email });
    if (!data) return;
    setChallenge(data.challenge);
    setNotice(data.message);
    setCode("");
    setStep("code");
  }

  function changeEmail() {
    setStep("email");
    setChallenge("");
    setCode("");
    setNotice("");
    setError("");
  }

  useEffect(() => {
    requestLoginRef.current = requestLogin;
  });

  useEffect(() => {
    fetch(`${API}/api/auth/config`)
      .then((res) => (res.ok ? res.json() : null))
      .then((cfg) => setGoogleClientId(cfg?.googleClientId || null))
      .catch(() => setGoogleClientId(null));
  }, []);

  useEffect(() => {
    if (!googleClientId || step !== "email") return;
    let cancelled = false;
    loadGoogleScript()
      .then(() => {
        if (cancelled || !googleButtonRef.current) return;
        window.google.accounts.id.initialize({
          client_id: googleClientId,
          callback: (resp) =>
            requestLoginRef.current("/api/login/google", { credential: resp.credential }),
        });
        window.google.accounts.id.renderButton(googleButtonRef.current, {
          theme: "filled_black",
          size: "large",
          text: "signin_with",
          shape: "pill",
          width: 312,
        });
      })
      .catch((err) => !cancelled && setError(err.message));
    return () => {
      cancelled = true;
    };
  }, [googleClientId, step]);

  function submit(e) {
    e.preventDefault();
    if (step === "email") sendCode();
    else requestLogin("/api/login/otp/verify", { challenge, code });
  }

  return (
    <div className="chat-app login-screen">
      <form className="login-card" onSubmit={submit}>
        <h1>DivOS chat</h1>
        {step === "email" ? (
          <>
            <p>
              Enter your DivOS email and we'll send you a login code
              {googleClientId ? ", or sign in with Google" : ""}.
            </p>
            <input
              type="email"
              placeholder="Email"
              value={email}
              onChange={(e) => setEmail(e.target.value)}
              autoComplete="username"
              autoFocus
              required
            />
            {error && <div className="login-error">{error}</div>}
            <button type="submit" disabled={loading}>
              {loading ? "Sending code…" : "Send code"}
            </button>
            {googleClientId && (
              <>
                <div className="login-divider">
                  <span>or</span>
                </div>
                <div className="google-button" ref={googleButtonRef} />
              </>
            )}
          </>
        ) : (
          <>
            <p>{notice}</p>
            <input
              className="otp-input"
              inputMode="numeric"
              placeholder="6-digit code"
              value={code}
              onChange={(e) => setCode(e.target.value.replace(/\D/g, "").slice(0, 6))}
              autoComplete="one-time-code"
              autoFocus
              required
            />
            {error && <div className="login-error">{error}</div>}
            <button type="submit" disabled={loading || code.length !== 6}>
              {loading ? "Verifying…" : "Log in"}
            </button>
            <div className="login-links">
              <button type="button" className="link-button" onClick={sendCode} disabled={loading}>
                Resend code
              </button>
              <button type="button" className="link-button" onClick={changeEmail} disabled={loading}>
                Use a different email
              </button>
            </div>
          </>
        )}
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
