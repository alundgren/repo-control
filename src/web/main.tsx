import { createRoot } from "react-dom/client";

import "./styles.css";

function App() {
  return (
    <main className="shell">
      <header className="brand">
        <span aria-hidden="true" className="brandMark">
          ↗
        </span>
        Repo Control
      </header>
      <section aria-labelledby="connection-heading" className="connection">
        <p className="eyebrow">Connection</p>
        <h1 id="connection-heading">No GitHub account connected</h1>
        <p>
          After setup, Repo Control will show pull requests and issue queues
          from the repositories you authorize.
        </p>
        <p className="note">Setup is not available in this build.</p>
      </section>
    </main>
  );
}

const root = document.querySelector("#root");

if (!root) {
  throw new Error("The browser shell needs a root element.");
}

createRoot(root).render(<App />);
