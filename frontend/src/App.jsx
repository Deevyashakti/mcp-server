import { useEffect, useRef, useState } from "react";
import "./App.css";

// Same-origin by default (Vite proxy locally, Vercel /api serverless in prod).
// Set VITE_API_URL only if the API is hosted on a different domain.
const API = import.meta.env.VITE_API_URL ?? "";
const TOKEN_KEY = "divos-chat-token";
const USER_KEY = "divos-chat-user";
const CHATS_KEY = "divos-chats";
const OPEN_CHAT_KEY = "divos-open-chat";
const SETTINGS_KEY = "divos-settings";

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

function readUser() {
  try {
    const raw = JSON.parse(localStorage.getItem(USER_KEY) || "null");
    return raw && typeof raw === "object" ? raw : null;
  } catch {
    return null;
  }
}

function saveUser(user) {
  try {
    if (user) localStorage.setItem(USER_KEY, JSON.stringify(user));
    else localStorage.removeItem(USER_KEY);
  } catch {
    /* ignore */
  }
}

function openChatKey(email) {
  return `${OPEN_CHAT_KEY}:${String(email || "").trim().toLowerCase()}`;
}

function readOpenChat(email) {
  if (!email) return "";
  try {
    return localStorage.getItem(openChatKey(email)) || "";
  } catch {
    return "";
  }
}

function writeOpenChat(email, id) {
  if (!email || !id) return;
  try {
    localStorage.setItem(openChatKey(email), id);
  } catch {
    /* ignore */
  }
}

function restoreWorkspace() {
  const token = readToken();
  const user = token ? readUser() : null;
  const saved = user?.email ? readChats(user.email) : [];
  const openId = user?.email ? readOpenChat(user.email) : "";
  const chat = saved.find((item) => item.id === openId);
  return {
    token,
    user,
    chats: saved,
    messages: chat?.messages || [],
    sessionId: chat?.id || newSessionId(),
  };
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
          theme: "outline",
          size: "large",
          text: "signin_with",
          shape: "rectangular",
          width: 324,
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
    <div className="login-screen">
      <aside className="login-brand">
        <img className="logo login-logo" src="/Deevyashakti_Logo.png" alt="Deevyashakti" />
        <p>Ask about trucks, orders, and operations. Answers come from your live company data.</p>
      </aside>
      <div className="login-panel">
        <form className="login-card" onSubmit={submit}>
          <span className="login-kicker">Sign in</span>
          {step === "email" ? (
            <>
              <h1>Welcome back</h1>
              <p className="login-lead">
                Use your DivOS work email. We’ll send a one-time code
                {googleClientId ? ", or continue with Google" : ""}.
              </p>
              <label className="field">
                <span>Work email</span>
                <input
                  type="email"
                  placeholder="name@company.com"
                  value={email}
                  onChange={(e) => setEmail(e.target.value)}
                  autoComplete="username"
                  autoFocus
                  required
                />
              </label>
              {error && <div className="login-error">{error}</div>}
              <button className="primary" type="submit" disabled={loading}>
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
              <h1>Check your email</h1>
              <p className="notice">{notice}</p>
              <label className="field">
                <span>Login code</span>
                <input
                  className="otp-input"
                  inputMode="numeric"
                  placeholder="••••••"
                  value={code}
                  onChange={(e) => setCode(e.target.value.replace(/\D/g, "").slice(0, 6))}
                  autoComplete="one-time-code"
                  autoFocus
                  required
                />
              </label>
              {error && <div className="login-error">{error}</div>}
              <button className="primary" type="submit" disabled={loading || code.length !== 6}>
                {loading ? "Verifying…" : "Continue"}
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
    </div>
  );
}

const PROMPTS = [
  "How many trucks are pending?",
  "Kitne orders aaj aaye?",
  "Show the latest truck plan",
];

function chatsKey(email) {
  return `${CHATS_KEY}:${String(email || "").trim().toLowerCase()}`;
}

function readChats(email) {
  if (!email) return [];
  try {
    const key = chatsKey(email);
    let raw = localStorage.getItem(key);
    // Older builds stored every chat under one key and deleted it on logout.
    if (raw == null) {
      const legacy = localStorage.getItem(CHATS_KEY);
      if (legacy) {
        localStorage.setItem(key, legacy);
        localStorage.removeItem(CHATS_KEY);
        raw = legacy;
      }
    }
    const parsed = JSON.parse(raw || "[]");
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

function writeChats(chats, email) {
  if (!email) return;
  try {
    localStorage.setItem(chatsKey(email), JSON.stringify(chats));
  } catch {
    /* storage unavailable — recents stay in this tab only */
  }
}

function readSettings() {
  try {
    const raw = JSON.parse(localStorage.getItem(SETTINGS_KEY) || "{}");
    return { speak: Boolean(raw.speak), lang: typeof raw.lang === "string" ? raw.lang : "" };
  } catch {
    return { speak: false, lang: "" };
  }
}

function writeSettings(settings) {
  try {
    localStorage.setItem(SETTINGS_KEY, JSON.stringify(settings));
  } catch {
    /* ignore */
  }
}

function speakText(text, lang) {
  if (!window.speechSynthesis || !text) return;
  window.speechSynthesis.cancel();
  const utterance = new SpeechSynthesisUtterance(text.slice(0, 1500));
  if (lang) utterance.lang = lang;
  window.speechSynthesis.speak(utterance);
}

function initials(name) {
  const parts = String(name || "")
    .trim()
    .split(/\s+/)
    .filter(Boolean);
  if (!parts.length) return "U";
  return parts
    .slice(0, 2)
    .map((part) => part[0].toUpperCase())
    .join("");
}

function App() {
  const [boot] = useState(restoreWorkspace);
  const [token, setToken] = useState(boot.token);
  const [user, setUser] = useState(boot.user);
  const [chats, setChats] = useState(boot.chats);
  const [messages, setMessages] = useState(boot.messages);
  const [sessionId, setSessionId] = useState(boot.sessionId);
  const [input, setInput] = useState("");
  const [query, setQuery] = useState("");
  const [sidebarOpen, setSidebarOpen] = useState(false);
  const [menu, setMenu] = useState(null);
  const [settings, setSettings] = useState(readSettings);
  const [attachment, setAttachment] = useState(null);
  const [listening, setListening] = useState(false);
  const [toast, setToast] = useState("");
  const [loading, setLoading] = useState(false);
  const bottomRef = useRef(null);
  const inputRef = useRef(null);
  const fileRef = useRef(null);
  const accountRef = useRef(null);
  const recognitionRef = useRef(null);
  const voiceText = useRef("");

  function flash(text) {
    setToast(text);
    window.setTimeout(() => setToast(""), 2600);
  }

  function stopVoice() {
    recognitionRef.current?.stop();
    recognitionRef.current = null;
    window.speechSynthesis?.cancel();
    setListening(false);
  }

  function logout() {
    stopVoice();
    saveToken("");
    saveUser(null);
    setToken("");
    setUser(null);
    setChats([]);
    setMessages([]);
    setAttachment(null);
    setMenu(null);
    setSessionId(newSessionId());
  }

  function remember(id, nextMessages) {
    const stored = nextMessages.map((message) => {
      const copy = { ...message };
      delete copy.imagePreview;
      return copy;
    });
    if (!stored.some((message) => message.role === "user")) return;
    const title = stored
      .find((message) => message.role === "user")
      .text.replace(/\s+/g, " ")
      .slice(0, 42);
    setChats((prev) => {
      const next = [
        { id, title, messages: stored, updatedAt: Date.now() },
        ...prev.filter((chat) => chat.id !== id),
      ].slice(0, 40);
      writeChats(next, user?.email);
      return next;
    });
  }

  useEffect(() => {
    if (!user?.email) return;
    const saved = readChats(user.email);
    setChats(saved);
    const chat = saved.find((item) => item.id === readOpenChat(user.email));
    if (!chat) return;
    setSessionId(chat.id);
    setMessages(chat.messages);
  }, [user?.email]);

  useEffect(() => {
    if (user?.email && sessionId) writeOpenChat(user.email, sessionId);
  }, [user?.email, sessionId]);

  useEffect(() => {
    if (!token) return;
    let cancelled = false;
    fetch(`${API}/api/me`, { headers: { Authorization: `Bearer ${token}` } })
      .then(async (res) => {
        if (res.status === 401) {
          logout();
          return;
        }
        if (!res.ok) return;
        const data = await res.json();
        if (cancelled || !data.user) return;
        saveUser(data.user);
        setUser(data.user);
      })
      .catch(() => {
        /* Keep the saved session if the API is briefly unreachable. */
      });
    return () => {
      cancelled = true;
    };
  }, [token]);

  useEffect(() => {
    bottomRef.current?.scrollIntoView({ behavior: "smooth" });
  }, [messages, loading]);

  function handleLogin(newToken, newUser) {
    saveToken(newToken);
    saveUser(newUser);
    setToken(newToken);
    setUser(newUser);
  }

  function newChat() {
    if (loading) return;
    stopVoice();
    setMessages([]);
    setSessionId(newSessionId());
    setInput("");
    setAttachment(null);
    setSidebarOpen(false);
    inputRef.current?.focus();
  }

  function openChat(id) {
    if (loading || id === sessionId) return;
    const chat = chats.find((item) => item.id === id);
    if (!chat) return;
    stopVoice();
    setSessionId(id);
    setMessages(chat.messages);
    setInput("");
    setAttachment(null);
    setSidebarOpen(false);
  }

  function updateSettings(patch) {
    setSettings((prev) => {
      const next = { ...prev, ...patch };
      writeSettings(next);
      return next;
    });
  }

  function chooseImage(event) {
    const file = event.target.files?.[0];
    event.target.value = "";
    if (!file) return;
    if (!/^image\/(jpeg|png|webp|gif)$/.test(file.type)) {
      flash("Use a JPG, PNG, WEBP, or GIF image.");
      return;
    }
    if (file.size > 3.5 * 1024 * 1024) {
      flash("Keep the image under 3.5 MB.");
      return;
    }
    const reader = new FileReader();
    reader.onload = () => {
      const url = String(reader.result || "");
      const match = url.match(/^data:(image\/(?:jpeg|png|webp|gif));base64,(.+)$/);
      if (!match) {
        flash("Couldn't read that image.");
        return;
      }
      setAttachment({ name: file.name, mediaType: match[1], data: match[2], preview: url });
    };
    reader.readAsDataURL(file);
  }

  async function sendTurn({ text, image, chatId }) {
    const trimmed = String(text || "").trim();
    if ((!trimmed && !image) || loading) return;
    stopVoice();
    setInput("");
    setAttachment(null);
    const userMessage = {
      role: "user",
      text: trimmed || "Read this image.",
      hadImage: Boolean(image),
      imagePreview: image?.preview,
    };
    let snapshot = [];
    setMessages((prev) => {
      snapshot = [...prev, userMessage];
      return snapshot;
    });
    remember(chatId, snapshot);
    setLoading(true);

    try {
      const res = await fetch(`${API}/api/chat`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${token}`,
        },
        body: JSON.stringify({
          message: trimmed,
          sessionId: chatId,
          image: image ? { mediaType: image.mediaType, data: image.data } : undefined,
        }),
      });
      if (res.status === 401) {
        logout();
        return;
      }
      const data = await res.json();
      const reply = data.reply || data.error || "No reply";
      setMessages((prev) => {
        snapshot = [...prev, { role: "assistant", text: reply }];
        return snapshot;
      });
      remember(chatId, snapshot);
      if (settings.speak) speakText(reply, settings.lang);
    } catch (err) {
      setMessages((prev) => {
        snapshot = [
          ...prev,
          { role: "assistant", text: `Could not reach the backend: ${err.message}` },
        ];
        return snapshot;
      });
      remember(chatId, snapshot);
    } finally {
      setLoading(false);
    }
  }

  function submit(event) {
    event.preventDefault();
    sendTurn({ text: input, image: attachment, chatId: sessionId });
  }

  function toggleMic() {
    if (listening) {
      recognitionRef.current?.stop();
      return;
    }
    const Recognition = window.SpeechRecognition || window.webkitSpeechRecognition;
    if (!Recognition) {
      flash("Voice input needs Chrome or Edge.");
      return;
    }
    window.speechSynthesis?.cancel();
    const recognition = new Recognition();
    if (settings.lang) recognition.lang = settings.lang;
    recognition.interimResults = true;
    voiceText.current = "";
    recognition.onresult = (event) => {
      let finalText = "";
      let interim = "";
      for (const result of event.results) {
        const said = result[0]?.transcript || "";
        if (result.isFinal) finalText += said;
        else interim += said;
      }
      const spoken = (finalText || interim).trim();
      setInput(spoken);
      if (finalText.trim()) voiceText.current = finalText.trim();
    };
    recognition.onerror = () => flash("Microphone wasn't available. Allow it and try again.");
    recognition.onend = () => {
      setListening(false);
      recognitionRef.current = null;
      const spoken = voiceText.current;
      voiceText.current = "";
      if (spoken) sendTurn({ text: spoken, image: attachment, chatId: sessionId });
    };
    recognitionRef.current = recognition;
    setListening(true);
    recognition.start();
  }

  async function shareChat() {
    const lines = messages
      .filter((message) => message.text)
      .map((message) => `${message.role === "user" ? "You" : "DivOS"}: ${message.text}`);
    if (!lines.length) return;
    const text = lines.join("\n\n");
    const title = current?.title || "DivOS chat";
    if (navigator.share) {
      try {
        await navigator.share({ title, text });
        return;
      } catch (err) {
        if (err?.name === "AbortError") return;
      }
    }
    try {
      await navigator.clipboard.writeText(text);
      flash("Conversation copied.");
    } catch {
      flash("Couldn't share this conversation.");
    }
  }

  function applyPrompt(text) {
    setInput(text);
    inputRef.current?.focus();
  }

  useEffect(() => {
    if (menu !== "account") return;
    function close(event) {
      if (!accountRef.current?.contains(event.target)) setMenu(null);
    }
    document.addEventListener("mousedown", close);
    return () => document.removeEventListener("mousedown", close);
  }, [menu]);

  if (!token) return <Login onLogin={handleLogin} />;

  const recents = chats.filter((chat) =>
    chat.title.toLowerCase().includes(query.trim().toLowerCase())
  );
  const current = chats.find((chat) => chat.id === sessionId);
  const showHome = messages.length === 0 && !loading;

  return (
    <div className="shell">
      {sidebarOpen && (
        <button
          type="button"
          className="backdrop"
          aria-label="Close menu"
          onClick={() => setSidebarOpen(false)}
        />
      )}
      <aside className={`sidebar${sidebarOpen ? " open" : ""}`}>
        <div className="side-top">
          <img className="logo" src="/Deevyashakti_Logo.png" alt="Deevyashakti" />
          <button type="button" className="icon-btn" aria-label="Close menu" onClick={() => setSidebarOpen(false)}>
            <MenuIcon />
          </button>
        </div>
        <label className="side-search">
          <SearchIcon />
          <input
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="Search chats"
            aria-label="Search chats"
          />
        </label>
        <button type="button" className="side-action" onClick={newChat} disabled={loading}>
          <ComposeIcon />
          New chat
        </button>
        <div className="side-label">Recents</div>
        <nav className="recents">
          {recents.length === 0 && <p className="side-empty">No chats yet</p>}
          {recents.map((chat) => (
            <button
              key={chat.id}
              type="button"
              className={`recent${chat.id === sessionId ? " active" : ""}`}
              onClick={() => openChat(chat.id)}
              disabled={loading}
            >
              <span>{chat.title}</span>
            </button>
          ))}
        </nav>
        <div className="account" ref={accountRef}>
          {menu === "account" && (
            <div className="account-menu">
              <button type="button" onClick={() => setMenu("profile")}>Profile</button>
              <button type="button" onClick={() => setMenu("settings")}>Settings</button>
              <button type="button" onClick={logout}>Log out</button>
            </div>
          )}
          <button type="button" className="side-user" onClick={() => setMenu(menu === "account" ? null : "account")}>
            <span className="avatar" aria-hidden="true">{initials(user?.name)}</span>
            <span>
              <strong>{user?.name || "Signing in"}</strong>
              <em>{user?.role || "Loading…"}</em>
            </span>
          </button>
        </div>
      </aside>

      <section className="stage">
        <header className="stage-bar">
          <button
            type="button"
            className="icon-btn"
            aria-label="Open menu"
            onClick={() => setSidebarOpen(true)}
          >
            <MenuIcon />
          </button>
          <span className="stage-title">{current?.title || "New chat"}</span>
          <button
            type="button"
            className="bar-btn"
            onClick={shareChat}
            disabled={!messages.some((message) => message.role === "user")}
          >
            Share
          </button>
        </header>

        <main className="thread">
          <div className="thread-inner">
            {showHome ? (
              <div className="home">
                <h1>What should we look up?</h1>
                <div className="suggestions">
                  {PROMPTS.map((prompt) => (
                    <button key={prompt} type="button" onClick={() => applyPrompt(prompt)}>
                      {prompt}
                    </button>
                  ))}
                </div>
              </div>
            ) : (
              messages.map((msg, i) => (
                <div key={i} className={`message ${msg.role}`}>
                  {msg.imagePreview && <img className="shot" src={msg.imagePreview} alt="" />}
                  {msg.hadImage && !msg.imagePreview && <span className="image-note">Image</span>}
                  <MessageText text={msg.text} />
                </div>
              ))
            )}
            {loading && (
              <div className="typing" aria-label="Thinking">
                <span />
                <span />
                <span />
              </div>
            )}
            <div ref={bottomRef} />
          </div>
        </main>

        <form className="dock" onSubmit={submit}>
          <p className="disclaimer">Answers use your DivOS data and can be wrong. Check important numbers.</p>
          {attachment && (
            <div className="attachment">
              <img src={attachment.preview} alt="" />
              <span>{attachment.name}</span>
              <button type="button" onClick={() => setAttachment(null)} aria-label="Remove image">
                ×
              </button>
            </div>
          )}
          <div className="composer">
            <button
              type="button"
              className="round-btn"
              aria-label="Add an image"
              disabled={loading}
              onClick={() => fileRef.current?.click()}
            >
              <ImageIcon />
            </button>
            <input
              ref={fileRef}
              type="file"
              accept="image/jpeg,image/png,image/webp,image/gif"
              hidden
              onChange={chooseImage}
            />
            <input
              ref={inputRef}
              value={input}
              onChange={(e) => setInput(e.target.value)}
              placeholder={listening ? "Listening…" : "Ask DivOS"}
              autoComplete="off"
              disabled={loading}
            />
            <button
              type="button"
              className={`round-btn${listening ? " live" : ""}`}
              aria-label={listening ? "Stop listening" : "Voice input"}
              disabled={loading}
              onClick={toggleMic}
            >
              <MicIcon />
            </button>
            <button
              className="send"
              type="submit"
              disabled={loading || (!input.trim() && !attachment)}
              aria-label="Send"
            >
              ↑
            </button>
          </div>
        </form>
      </section>
      {toast && <div className="toast">{toast}</div>}
      {menu === "profile" && (
        <Panel title="Profile" onClose={() => setMenu(null)}>
          <dl className="profile">
            <div>
              <dt>Name</dt>
              <dd>{user?.name || "—"}</dd>
            </div>
            <div>
              <dt>Email</dt>
              <dd>{user?.email || "—"}</dd>
            </div>
            <div>
              <dt>Role</dt>
              <dd>{user?.role || "—"}</dd>
            </div>
          </dl>
          <p className="panel-note">This account comes from DivOS. It can’t be edited here.</p>
        </Panel>
      )}
      {menu === "settings" && (
        <Panel title="Settings" onClose={() => setMenu(null)}>
          <label className="setting">
            <input
              type="checkbox"
              checked={settings.speak}
              onChange={(e) => updateSettings({ speak: e.target.checked })}
            />
            <span>Read answers aloud</span>
          </label>
          <label className="setting stack">
            <span>Voice language</span>
            <select value={settings.lang} onChange={(e) => updateSettings({ lang: e.target.value })}>
              <option value="">Browser default</option>
              <option value="en-IN">English (India)</option>
              <option value="hi-IN">Hindi</option>
            </select>
          </label>
          <button
            type="button"
            className="danger"
            onClick={() => {
              writeChats([], user?.email);
              setChats([]);
              newChat();
              setMenu(null);
              flash("Chats on this device were cleared.");
            }}
          >
            Clear chats on this device
          </button>
        </Panel>
      )}
    </div>
  );
}

function tableCells(line) {
  let text = line.trim();
  if (text.startsWith("|")) text = text.slice(1);
  if (text.endsWith("|")) text = text.slice(0, -1);
  return text.split("|").map((cell) => cell.trim());
}

function isTableRule(line) {
  const cells = tableCells(line);
  return cells.length > 1 && cells.every((cell) => /^:?-{3,}:?$/.test(cell));
}

function isTableRow(line) {
  return line.trim().includes("|") && !isTableRule(line);
}

function looksNumeric(value) {
  return /^-?[\d,]+(\.\d+)?%?$/.test(String(value).trim());
}

function messageBlocks(text) {
  const lines = String(text || "").replace(/\r\n/g, "\n").split("\n");
  const blocks = [];
  const buffer = [];
  const flush = () => {
    const body = buffer.join("\n").trim();
    buffer.length = 0;
    if (body) blocks.push({ type: "text", text: body });
  };
  let index = 0;
  while (index < lines.length) {
    const header = lines[index];
    const next = lines[index + 1] || "";
    const rowCount = (start) => {
      let count = 0;
      while (start + count < lines.length && lines[start + count].trim() && isTableRow(lines[start + count])) {
        count += 1;
      }
      return count;
    };
    if (header && isTableRow(header) && (isTableRule(next) || rowCount(index) >= 2)) {
      flush();
      const headers = tableCells(header);
      index += isTableRule(next) ? 2 : 1;
      const rows = [];
      while (index < lines.length && lines[index].trim() && isTableRow(lines[index])) {
        const cells = tableCells(lines[index]);
        rows.push(headers.map((_, cell) => cells[cell] || ""));
        index += 1;
      }
      if (rows.length) blocks.push({ type: "table", headers, rows });
      else buffer.push(header);
      continue;
    }
    buffer.push(lines[index]);
    index += 1;
  }
  flush();
  return blocks;
}

function MessageText({ text }) {
  const blocks = messageBlocks(text);
  if (!blocks.length) return null;
  return blocks.map((block, index) => {
    if (block.type === "text") {
      return (
        <p key={index} className="message-copy">
          {block.text}
        </p>
      );
    }
    return (
      <div key={index} className="table-wrap">
        <table>
          <thead>
            <tr>
              {block.headers.map((header, headerIndex) => (
                <th key={headerIndex} className={looksNumeric(header) ? "num" : undefined}>
                  {header}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {block.rows.map((row, rowIndex) => (
              <tr key={rowIndex}>
                {row.map((cell, cellIndex) => (
                  <td key={cellIndex} className={looksNumeric(cell) ? "num" : undefined}>
                    {cell}
                  </td>
                ))}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    );
  });
}

function Panel({ title, onClose, children }) {
  return (
    <div className="modal-backdrop" onClick={onClose}>
      <div
        className="modal"
        role="dialog"
        aria-label={title}
        onClick={(event) => event.stopPropagation()}
      >
        <header>
          <h2>{title}</h2>
          <button type="button" onClick={onClose} aria-label="Close">
            ×
          </button>
        </header>
        {children}
      </div>
    </div>
  );
}

function MenuIcon() {
  return (
    <svg width="18" height="18" viewBox="0 0 18 18" fill="none" aria-hidden="true">
      <path d="M3 4.5h12M3 9h12M3 13.5h12" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" />
    </svg>
  );
}

function SearchIcon() {
  return (
    <svg width="16" height="16" viewBox="0 0 16 16" fill="none" aria-hidden="true">
      <circle cx="7" cy="7" r="4.25" stroke="currentColor" strokeWidth="1.5" />
      <path d="M10.5 10.5 13.5 13.5" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" />
    </svg>
  );
}

function ImageIcon() {
  return (
    <svg width="18" height="18" viewBox="0 0 18 18" fill="none" aria-hidden="true">
      <rect x="2.2" y="3.2" width="13.6" height="11.6" rx="2" stroke="currentColor" strokeWidth="1.5" />
      <circle cx="6.2" cy="7" r="1.2" fill="currentColor" />
      <path d="M3.5 12.5 7 9.2l2.2 2.1 2-1.6 3.3 3" stroke="currentColor" strokeWidth="1.5" strokeLinejoin="round" />
    </svg>
  );
}

function MicIcon() {
  return (
    <svg width="18" height="18" viewBox="0 0 18 18" fill="none" aria-hidden="true">
      <rect x="6.5" y="2" width="5" height="8.5" rx="2.5" stroke="currentColor" strokeWidth="1.5" />
      <path d="M4 8.5a5 5 0 0 0 10 0M9 13.5V16" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" />
    </svg>
  );
}

function ComposeIcon() {
  return (
    <svg width="16" height="16" viewBox="0 0 16 16" fill="none" aria-hidden="true">
      <path d="M9.2 3.2 12.8 6.8 5.5 14.1H2V10.6L9.2 3.2Z" stroke="currentColor" strokeWidth="1.4" strokeLinejoin="round" />
      <path d="M8 4.4 11.6 8" stroke="currentColor" strokeWidth="1.4" />
    </svg>
  );
}

export default App
